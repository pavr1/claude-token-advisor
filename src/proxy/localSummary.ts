/**
 * A summary of old history built without a model.
 *
 * The compaction used to ask Haiku for it. Anthropic answers a call that does not present itself as Claude Code, made with the
 * credentials of a Claude account, with a generic HTTP 429 (F-59), and presenting it as Claude Code would be passing a control, so
 * the summary is made here instead, from what the conversation itself says: what was asked, the closing text of each answer, the
 * files touched and the commands run. Nothing leaves the machine, it costs no tokens, and the same history always gives the same text.
 *
 * What it cannot do is reason or rephrase: requests and answers are cut excerpts, and a detail that only appeared inside a tool's
 * output is not in it. The text says so in its first line, so the model that reads it and the person who opens it both know.
 */

type Message = Record<string, unknown>;

/** The whole summary never goes past this, whatever the history. About 4K tokens. */
export const LOCAL_SUMMARY_MAX_CHARS = 22_000;
/** The cap grows with the part replaced: 2% of it (at 3.5 characters a token), never below the base or above this. */
export const LOCAL_SUMMARY_GROWN_MAX_CHARS = 56_000;
const MAX_FAILURES = 8;
const MAX_IDENTIFIERS = 15;
/** The first request is usually the goal and the rules of the work, so it is kept nearly whole. */
const FIRST_REQUEST_CHARS = 1_200;
const DECISION_CHARS = 420;
const DECISION_CONTEXT_CHARS = 200;
const DECISIONS_BUDGET = 4_000;
const MAX_DECISIONS = 20;
/** A reply that settles something: a short answer, or a message that gives a direction, a preference or a correction. */
const DIRECTIVE = /\b(no|nunca|siempre|quiero|prefiero|debe|debemos|necesito|mejor|en lugar|en vez|hazlo|hazla|ok|okey|sí|si|listo|me gusta|dale|adelante|procede|perfecto|don't|never|always|instead|prefer|must|should|go ahead|yes|please|elimina|quita|agrega|cambia)\b/i;
const INTERRUPTED = /^\[Request interrupted/;
const FAILURE_COMMAND_CHARS = 70;
const FAILURE_ERROR_CHARS = 110;

const REQUEST_CHARS = 240;
const ANSWER_CHARS = 420;
const LAST_REQUEST_CHARS = 600;
const LAST_ANSWER_CHARS = 2_000;
const EXCHANGES_BUDGET = 7_500;
const FILES_BUDGET = 2_500;
const COMMANDS_BUDGET = 1_500;
const MAX_FILES = 30;
const MAX_COMMANDS = 25;
const COMMAND_CHARS = 110;
const MAX_TOOLS_LISTED = 6;
const PATH_CHARS = 90;

/** Commands that say something about the state of the work: builds, tests, packages and version control. The rest (ls, cat, grep...) is exploration. */
const STATE_COMMANDS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'bun', 'node', 'deno', 'tsc', 'py', 'python', 'python3', 'pip', 'pytest', 'git', 'gh', 'make', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'docker', 'kubectl', 'vsce']);
/** Files under a temporary folder are helpers, not part of the project. */
const TEMPORARY_PATH = /(^|\/)(temp|tmp|scratchpad)(\/|$)/i;

export const LOCAL_SUMMARY_NOTE =
  'Built locally from the transcript, without a model. Requests and answers are cut excerpts, and what appeared only inside tool output is not included.';

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The start of `text`, cut to `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
  const t = collapse(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Both ends of `text`: the opening says what was done and the close is often where the result is. */
function clipEnds(text: string, max: number): string {
  const t = collapse(text);
  if (t.length <= max) {
    return t;
  }
  const head = Math.ceil(max * 0.35);
  const tail = max - head - 3;
  return `${t.slice(0, head).trimEnd()} … ${t.slice(-tail).trimStart()}`;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined);

function blocksOf(message: Message): unknown[] {
  const content = message['content'];
  return typeof content === 'string' ? [content] : Array.isArray(content) ? content : [];
}

const isToolResult = (block: unknown): boolean => asRecord(block)?.['type'] === 'tool_result';

/** The text of a block, when it is one; a plain string counts. */
function textOf(block: unknown): string | undefined {
  if (typeof block === 'string') {
    return block;
  }
  const record = asRecord(block);
  return record?.['type'] === 'text' && typeof record['text'] === 'string' ? (record['text'] as string) : undefined;
}

/** What the user typed in a message: its text blocks, minus what the client injected (`<system-reminder>`, environment snapshots, ...). */
function typedText(message: Message): string {
  return blocksOf(message)
    .map(textOf)
    .filter((text): text is string => text !== undefined && !text.trimStart().startsWith('<'))
    .join('\n');
}

/** `cd "some path" && npm test` -> `npm test`: the folder change says nothing about what ran. */
function withoutCd(command: string): string {
  let cleaned = command.trimStart();
  for (;;) {
    const next = cleaned.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
    if (next === cleaned) {
      return cleaned;
    }
    cleaned = next;
  }
}

/**
 * Whether the command is a build, test, package or version-control step. Only the first step counts: `ls src; py -c "..."` is
 * exploration, and so is a script written inline (`py -c`, `node -e`, a heredoc), which analyses something and changes nothing.
 */
function isStateCommand(command: string): boolean {
  const step = (command.split(/&&|;|\|\|/)[0] ?? '').trim().replace(/^(\w+=\S*\s+)+/, '');
  const [word, ...rest] = step.split(/\s+/);
  if (!STATE_COMMANDS.has(word)) {
    return false;
  }
  return !(/^(py|python|python3|node)$/.test(word) && /(^|\s)(-c|-e|-)(\s|$)|<</.test(rest.join(' ')));
}

/** The paths without what they all share, keeping the last shared folder: `C:/a/b/src/x.ts` and `C:/a/b/src/y.ts` -> `src/x.ts`, `src/y.ts`. */
function shortenPaths(paths: string[]): Map<string, string> {
  const split = paths.map((p) => p.split('/'));
  let shared = 0;
  if (split.length > 1) {
    const first = split[0];
    while (shared < first.length - 1 && split.every((parts) => parts.length - 1 > shared && parts[shared] === first[shared])) {
      shared += 1;
    }
  } else {
    shared = Math.max(0, split[0].length - 2);
  }
  const keep = Math.max(0, shared - 1);
  const out = new Map<string, string>();
  paths.forEach((p, i) => {
    const rest = split[i].slice(keep).join('/');
    const shown = keep > 0 ? `…/${rest}` : rest;
    out.set(p, shown.length <= PATH_CHARS ? shown : `…${shown.slice(-(PATH_CHARS - 1))}`);
  });
  return out;
}

interface FileUse {
  read: number;
  edited: number;
  written: number;
  last: number;
}

interface Exchange {
  request: string;
  answer: string;
}

/** Lines `lines` in order, as many as fit in `budget` characters, newest-first when `newestFirst`. */
function fit(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) {
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/** The exchanges that fit: the first one, then the newest ones, with a marker wherever some are left out. */
function renderExchanges(exchanges: Exchange[], budget: number): string[] {
  const rendered = exchanges.map((e, i) => `${i + 1}. Asked: ${clip(e.request, i === 0 ? FIRST_REQUEST_CHARS : REQUEST_CHARS)}${e.answer ? `\n   Answer: ${clipEnds(e.answer, ANSWER_CHARS)}` : ''}`);
  const picked = new Set<number>([0]);
  let used = rendered[0].length + 1;
  for (let i = rendered.length - 1; i >= 1; i -= 1) {
    if (used + rendered[i].length + 1 > budget) {
      break;
    }
    picked.add(i);
    used += rendered[i].length + 1;
  }
  const out: string[] = [];
  let skipped = 0;
  const flush = (): void => {
    if (skipped > 0) {
      out.push(`   … ${skipped} exchange${skipped === 1 ? '' : 's'} left out …`);
      skipped = 0;
    }
  };
  rendered.forEach((text, i) => {
    if (picked.has(i)) {
      flush();
      out.push(text);
    } else {
      skipped += 1;
    }
  });
  flush();
  return out;
}

export function buildLocalSummary(messages: readonly Message[]): string {
  const exchanges: Exchange[] = [];
  const files = new Map<string, FileUse>();
  const commands: string[] = [];
  let otherCommands = 0;
  let temporaryFiles = 0;
  const tools = new Map<string, number>();
  let toolErrors = 0;
  const commandOf = new Map<string, string>();
  const toolNameOf = new Map<string, string>();
  const failures = new Map<string, string>();
  const decisions: string[] = [];
  let previousAnswer = '';
  const identifiers = new Map<string, number>();
  let order = 0;
  let current: Exchange | undefined;

  for (const message of messages) {
    const role = message['role'];
    if (role === 'user') {
      const blocks = blocksOf(message);
      for (const block of blocks) {
        const record = isToolResult(block) ? asRecord(block) : undefined;
        if (!record) {
          continue;
        }
        const raw = record['content'];
        const said = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c) => String(asRecord(c)?.['text'] ?? '')).join(' ') : '';
        const id = String(record['tool_use_id'] ?? '');
        const command = commandOf.get(id);
        if (record['is_error'] !== true) {
          if (command) {
            failures.delete(command.slice(0, 40)); // the same command worked later: the failure is history
          }
          if (toolNameOf.get(id) === 'AskUserQuestion' && collapse(said)) {
            decisions.push(`- The user answered a question: ${clip(said, DECISION_CHARS)}`);
          }
          continue;
        }
        toolErrors += 1;
        const line = clip(said, FAILURE_ERROR_CHARS);
        if (line) {
          const key = command ? command.slice(0, 40) : `text:${line.slice(0, 40)}`;
          failures.delete(key);
          failures.set(key, `${command ? `\`${clip(command, FAILURE_COMMAND_CHARS)}\` → ` : ''}${line}`);
        }
      }
      if (blocks.some(isToolResult)) {
        continue; // a tool's answer is not something the user asked
      }
      const text = typedText(message);
      if (INTERRUPTED.test(text.trim())) {
        continue; // the person stopped the assistant: that is not a request
      }
      if (text.trim()) {
        previousAnswer = current?.answer ?? '';
        const typed = collapse(text);
        if (exchanges.length > 0 && typed.length <= 600 && (typed.length <= 80 || DIRECTIVE.test(typed))) {
          const context = previousAnswer && (typed.length <= 80 || previousAnswer.trimEnd().endsWith('?')) ? `After "…${collapse(previousAnswer).slice(-DECISION_CONTEXT_CHARS)}" ` : '';
          decisions.push(`- ${context}the user said: ${clip(typed, DECISION_CHARS)}`);
        }
        current = { request: text, answer: '' };
        exchanges.push(current);
      }
    } else if (role === 'assistant') {
      for (const block of blocksOf(message)) {
        const record = asRecord(block);
        if (record?.['type'] === 'tool_use') {
          const name = String(record['name'] ?? '');
          toolNameOf.set(String(record['id'] ?? ''), name);
          tools.set(name, (tools.get(name) ?? 0) + 1);
          const input = asRecord(record['input']) ?? {};
          const found = [input['file_path'], input['path'], input['notebook_path']].find((v): v is string => typeof v === 'string' && v.length > 0);
          const target = found?.replace(/\\/g, '/');
          if (target && /^(Read|Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
            if (TEMPORARY_PATH.test(target)) {
              temporaryFiles += 1;
            } else {
              const use = files.get(target) ?? { read: 0, edited: 0, written: 0, last: 0 };
              if (name === 'Read') {
                use.read += 1;
              } else if (name === 'Write') {
                use.written += 1;
              } else {
                use.edited += 1;
              }
              use.last = (order += 1);
              files.set(target, use);
            }
          } else if (name === 'Bash' && typeof input['command'] === 'string') {
            const command = withoutCd(String(input['command']));
            const first = collapse(command.split('\n')[0]);
            commandOf.set(String(record['id'] ?? ''), first);
            if (/\bsed\s+-i|open\(|write_text|writeFileSync|\.write\(/.test(command)) {
              // A script that writes files: the paths it names are changed files that no Edit or Write call shows.
              for (const match of command.matchAll(/['"]([\w.\/\\-]*[\w-]+\.[A-Za-z]{1,5})['"]/g)) {
                const path = match[1].replace(/\\/g, '/');
                if (path.includes('/') && !TEMPORARY_PATH.test(path)) {
                  const use = files.get(path) ?? { read: 0, edited: 0, written: 0, last: 0 };
                  use.edited += 1;
                  use.last = (order += 1);
                  files.set(path, use);
                }
              }
            }
            if (first && isStateCommand(first)) {
              commands.push(clip(first, COMMAND_CHARS));
            } else if (first) {
              otherCommands += 1;
            }
          }
        } else {
          const text = textOf(block);
          if (text) {
            for (const match of text.matchAll(/`([A-Za-z_][\w.]*(?:\(\))?)`/g)) {
              const id = match[1];
              if (id.length >= 6 && (/[a-z][A-Z]/.test(id) || id.includes('_') || id.endsWith('()') || id.includes('.'))) {
                identifiers.set(id, (identifiers.get(id) ?? 0) + 1);
              }
            }
          }
          if (text && collapse(text) && current) {
            current.answer = text; // the latest text before the next request is the one that closes it
          }
        }
      }
    }
  }

  if (exchanges.length === 0 && files.size === 0 && commands.length === 0 && otherCommands === 0) {
    return `${LOCAL_SUMMARY_NOTE}\n\nNo request, file or command was found in the part of the conversation that was replaced.`;
  }

  const sections: string[] = [LOCAL_SUMMARY_NOTE];
  const replacedChars = JSON.stringify(messages).length;
  const cap = Math.min(LOCAL_SUMMARY_GROWN_MAX_CHARS, Math.max(LOCAL_SUMMARY_MAX_CHARS, Math.round(replacedChars * 0.07)));
  const scale = cap / LOCAL_SUMMARY_MAX_CHARS;

  if (exchanges.length > 0) {
    sections.push(`## Requests and what came back (${exchanges.length} in all, oldest first)\n${renderExchanges(exchanges, Math.round(EXCHANGES_BUDGET * scale)).join('\n')}`);
  }

  if (files.size > 0) {
    // What was changed first, then what was only read; within each, the most recent.
    const ranked = [...files.entries()].sort(([, a], [, b]) => (b.edited + b.written > 0 ? 1 : 0) - (a.edited + a.written > 0 ? 1 : 0) || b.last - a.last).slice(0, Math.round(MAX_FILES * scale));
    const shown = shortenPaths(ranked.map(([file]) => file));
    const lines = ranked.map(([file, use]) => `- ${shown.get(file)} — ${[use.edited ? `edited ×${use.edited}` : '', use.written ? `written ×${use.written}` : '', use.read ? `read ×${use.read}` : ''].filter(Boolean).join(', ')}`);
    const note = [files.size > ranked.length ? `${ranked.length} of ${files.size}` : '', temporaryFiles > 0 ? `${temporaryFiles} touches of temporary files not listed` : ''].filter(Boolean).join('; ');
    sections.push(`## Files touched${note ? ` (${note})` : ''}\n${fit(lines, Math.round(FILES_BUDGET * scale)).join('\n')}`);
  }

  if (commands.length > 0 || otherCommands > 0) {
    // The latest distinct ones, shown oldest first.
    const latest: string[] = [];
    for (let i = commands.length - 1; i >= 0 && latest.length < Math.round(MAX_COMMANDS * scale); i -= 1) {
      // Two commands that start the same (`npm test | head`, `npm test | tail`) are the same step: one line is enough.
      if (!latest.some((c) => c.slice(0, 40) === commands[i].slice(0, 40))) {
        latest.push(commands[i]);
      }
    }
    const listed = fit(latest.reverse().map((c) => `- \`${c}\``), Math.round(COMMANDS_BUDGET * scale));
    const title = commands.length > 0 ? `## Build, test and version-control commands (the latest ${latest.length} distinct of ${commands.length})` : '## Commands';
    sections.push(`${title}${listed.length > 0 ? `\n${listed.join('\n')}` : ''}${otherCommands > 0 ? `\n(${otherCommands} other shell commands, such as listing and reading files, are not listed)` : ''}`);
  }

  if (tools.size > 0) {
    const used = [...tools.entries()].sort(([, a], [, b]) => b - a).slice(0, MAX_TOOLS_LISTED).map(([name, count]) => `${name} ×${count}`);
    sections.push(`Tools used: ${used.join(', ')}.${toolErrors > 0 ? ` Tool calls that failed: ${toolErrors}.` : ''}`);
  }

  if (decisions.length > 0) {
    // The newest decisions matter most: keep the tail that fits.
    const tail: string[] = [];
    let used = 0;
    for (let i = decisions.length - 1; i >= 0 && tail.length < Math.round(MAX_DECISIONS * scale); i -= 1) {
      if (used + decisions[i].length + 1 > Math.round(DECISIONS_BUDGET * scale)) {
        break;
      }
      tail.unshift(decisions[i]);
      used += decisions[i].length + 1;
    }
    sections.push(`## Decisions, corrections and answers from the user (${tail.length} of ${decisions.length}, oldest first)\n${tail.join('\n')}`);
  }

  if (failures.size > 0) {
    const shown = [...failures.values()].slice(-MAX_FAILURES);
    sections.push(`## Tool calls that failed and were not followed by a success of the same command (${shown.length} of ${toolErrors} failures)\n${shown.map((f) => `- ${f}`).join('\n')}`);
  }

  if (identifiers.size > 0) {
    const top = [...identifiers.entries()].sort(([, a], [, b]) => b - a).slice(0, MAX_IDENTIFIERS).map(([id]) => id);
    sections.push(`## Names the assistant mentioned most\n${top.join(', ')}`);
  }

  const last = exchanges[exchanges.length - 1];
  if (last) {
    sections.push(`## Where it stood\nLast request: ${clip(last.request, LAST_REQUEST_CHARS)}${last.answer ? `\nLast answer: ${clipEnds(last.answer, LAST_ANSWER_CHARS)}` : ''}`);
  }

  const text = sections.join('\n\n');
  return text.length <= cap ? text : `${text.slice(0, cap - 1).trimEnd()}…`;
}
