/**
 * Where the user's own prompts are, read from Claude Code's transcripts.
 *
 * The proxy only sees API requests, and many of them are not something the user typed: quota
 * probes, session titles, web-page summaries, permission classifiers, subagents. A request whose
 * last message is plain text looks like a new prompt, so judging by the request alone opens
 * turns that nobody wrote. The transcript (`~/.claude/projects/<repo>/<session>.jsonl`) records
 * exactly what was typed and when, so each of those prompts anchors one turn and every request
 * until the next prompt belongs to it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LedgerEntry } from './tracker';

export interface PromptAnchor {
  /** When the user pressed Enter (epoch ms). */
  at: number;
  /** The Claude Code chat the prompt was typed in. */
  sessionId: string;
  /** Claude Code's `promptId` for this prompt; every request it caused is tied to it by `requestId`. */
  promptId?: string;
}

/** Transcripts untouched for longer than this are not read (the Turns ranges reach back about a month). */
const MAX_AGE_MS = 40 * 24 * 3_600_000;

/** A prompt older than this no longer opens a turn: its request would have gone out long ago. */
const PROMPT_FRESH_MS = 10 * 60_000;

/** What Claude Code writes for things that are not a prompt: interrupts and the output of local commands. */
const NOT_A_PROMPT = ['[Request interrupted', '<local-command-stdout>', '<local-command-caveat>'];

/** The text the user typed in a transcript `user` line, or undefined when the line is not a prompt. */
export function promptTextOf(line: Record<string, unknown>): string | undefined {
  if (line['type'] !== 'user' || line['isSidechain'] === true || line['isMeta'] === true || line['isCompactSummary'] === true) {
    return undefined;
  }
  const content = (line['message'] as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>;
    if (blocks.some((block) => block?.['type'] === 'tool_result')) {
      return undefined;
    }
    text = blocks.map((block) => (block?.['type'] === 'text' ? String(block['text'] ?? '') : '')).join('');
  }
  text = text.trim();
  if (!text || NOT_A_PROMPT.some((prefix) => text.startsWith(prefix))) {
    return undefined;
  }
  return text;
}

/** Claude Code names a repo's transcript folder after its path, every non-alphanumeric character turned into `-`. */
export function transcriptFolderSuffix(project: string): string {
  return project.replace(/[^A-Za-z0-9]/g, '-');
}

interface TranscriptState {
  dir: string;
  /** Bytes already parsed. */
  offset: number;
  /** A last line the writer had not finished. */
  partial: string;
  anchors: PromptAnchor[];
  /** The `promptId` of the latest prompt read, which the assistant lines that follow belong to. */
  currentPrompt?: PromptAnchor;
  /** Anthropic `requestId` -> the prompt that caused it. */
  requests: Map<string, PromptAnchor>;
}

export class PromptIndex {
  private readonly files = new Map<string, TranscriptState>();
  private readonly byProject = new Map<string, PromptAnchor[]>();
  private refreshing: Promise<boolean> | undefined;
  /** Grows whenever a refresh found new prompts, so a cache built from this index knows it is stale. */
  version = 0;

  constructor(private readonly root: string = path.join(os.homedir(), '.claude', 'projects')) {}

  /** Read what the transcripts gained since the last call; true when a new prompt turned up. */
  refresh(now: number = Date.now()): Promise<boolean> {
    this.refreshing ??= this.scan(now).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Prompts already given to a request as its opener, as `sessionId|at`. */
  private readonly claimed = new Set<string>();

  /** Everything typed so far counts as handled: only prompts that arrive from now on open a turn. */
  claimAll(): void {
    for (const state of this.files.values()) {
      for (const anchor of state.anchors) {
        this.claimed.add(`${anchor.sessionId}|${anchor.at}`);
      }
    }
  }

  /**
   * Is the request arriving now the first one after a prompt? 'new' hands the latest unclaimed
   * prompt (typed within `PROMPT_FRESH_MS`) to this request; 'continue' means every prompt of the
   * chat already has its opener; 'unknown' means no transcript tells (the caller keeps its guess).
   */
  claimOpener(project: string, sessionId: string | undefined, now: number = Date.now()): 'new' | 'continue' | 'unknown' {
    const all = this.anchorsFor(project);
    const own = sessionId ? all.filter((anchor) => anchor.sessionId === sessionId) : [];
    const pool = own.length > 0 ? own : all;
    let latest: PromptAnchor | undefined;
    for (const anchor of pool) {
      if (anchor.at <= now && (!latest || anchor.at > latest.at)) {
        latest = anchor;
      }
    }
    if (!latest) {
      return 'unknown';
    }
    const key = `${latest.sessionId}|${latest.at}`;
    if (this.claimed.has(key) || now - latest.at > PROMPT_FRESH_MS) {
      return 'continue';
    }
    this.claimed.add(key);
    return 'new';
  }

  /** The prompt that caused the request Anthropic knows as `requestId`, when a transcript recorded it. */
  promptOf(requestId: string): PromptAnchor | undefined {
    for (const state of this.files.values()) {
      const anchor = state.requests.get(requestId);
      if (anchor) {
        return anchor;
      }
    }
    return undefined;
  }

  /** The prompts typed in `project`'s repo, oldest first, across all its chats. */
  anchorsFor(project: string): readonly PromptAnchor[] {
    const cached = this.byProject.get(project);
    if (cached) {
      return cached;
    }
    const suffix = transcriptFolderSuffix(project).toLowerCase();
    const anchors: PromptAnchor[] = [];
    for (const state of this.files.values()) {
      const dir = path.basename(state.dir).toLowerCase();
      if (dir === suffix || dir.endsWith(`-${suffix}`)) {
        anchors.push(...state.anchors);
      }
    }
    anchors.sort((a, b) => a.at - b.at);
    this.byProject.set(project, anchors);
    return anchors;
  }

  private async scan(now: number): Promise<boolean> {
    let changed = false;
    let dirs: string[];
    try {
      dirs = await fs.promises.readdir(this.root);
    } catch {
      return false;
    }
    for (const dir of dirs) {
      const dirPath = path.join(this.root, dir);
      let names: string[];
      try {
        names = (await fs.promises.readdir(dirPath)).filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dirPath, name);
        try {
          const stat = await fs.promises.stat(file);
          const known = this.files.get(file);
          if (!known && now - stat.mtimeMs > MAX_AGE_MS) {
            continue;
          }
          if (known && stat.size === known.offset) {
            continue;
          }
          const state: TranscriptState =
            known && stat.size > known.offset ? known : { dir: dirPath, offset: 0, partial: '', anchors: [], requests: new Map() };
          if (await this.readNew(file, state, stat.size)) {
            changed = true;
          }
          this.files.set(file, state);
        } catch {
          // a transcript that vanished or is locked mid-write is picked up on the next pass
        }
      }
    }
    if (changed) {
      this.byProject.clear();
      this.version += 1;
    }
    return changed;
  }

  private async readNew(file: string, state: TranscriptState, size: number): Promise<boolean> {
    const handle = await fs.promises.open(file, 'r');
    try {
      const length = size - state.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      state.offset = size;
      const lines = (state.partial + buffer.toString('utf8')).split('\n');
      state.partial = lines.pop() ?? '';
      let found = false;
      for (const raw of lines) {
        const isUser = raw.includes('"type":"user"');
        // Only prompts and the assistant lines that carry a requestId matter; skip the rest unparsed.
        if (!isUser && !(state.currentPrompt && raw.includes('"requestId"'))) {
          continue;
        }
        try {
          const line = JSON.parse(raw) as Record<string, unknown>;
          if (isUser) {
            const at = Date.parse(String(line['timestamp'] ?? ''));
            const sessionId = line['sessionId'];
            if (Number.isFinite(at) && typeof sessionId === 'string' && promptTextOf(line) !== undefined) {
              const promptId = typeof line['promptId'] === 'string' ? line['promptId'] : undefined;
              const anchor: PromptAnchor = { at, sessionId, promptId };
              state.anchors.push(anchor);
              state.currentPrompt = anchor;
              found = true;
            }
          } else if (line['type'] === 'assistant' && line['isSidechain'] !== true && typeof line['requestId'] === 'string' && state.currentPrompt) {
            state.requests.set(line['requestId'], state.currentPrompt);
            found = true;
          }
        } catch {
          // a damaged line is not a prompt
        }
      }
      return found;
    } finally {
      await handle.close();
    }
  }
}

/** When the request went out: a prompt typed while it was running is not in it, so the finish time would misplace it. */
function sentAt(entry: LedgerEntry): number {
  return entry.startedAt ?? Date.parse(entry.timestamp);
}

/**
 * Re-label ledger rows by the prompts the user typed: the first request after a prompt opens its
 * turn (`newUserTurn`), every later one up to the next prompt continues it, and each takes its
 * chat's id. Rows older than the first known prompt, or from a repo with no transcript, are kept as
 * they were. Returns the same array when nothing changed.
 */
export function anchorEntries(
  entries: readonly LedgerEntry[],
  anchorsFor: (project: string) => readonly PromptAnchor[],
  promptOf: (requestId: string) => PromptAnchor | undefined = () => undefined
): readonly LedgerEntry[] {
  const perProject = new Map<string, readonly PromptAnchor[]>();
  const perSession = new Map<string, readonly PromptAnchor[]>();
  const pool = (entry: LedgerEntry): readonly PromptAnchor[] => {
    let all = perProject.get(entry.project);
    if (!all) {
      all = anchorsFor(entry.project);
      perProject.set(entry.project, all);
    }
    if (!entry.sessionId) {
      return all;
    }
    const key = `${entry.project}|${entry.sessionId}`;
    let own = perSession.get(key);
    if (!own) {
      const mine = all.filter((anchor) => anchor.sessionId === entry.sessionId);
      // A session id the transcripts do not know falls back to the whole repo.
      own = mine.length > 0 ? mine : all;
      perSession.set(key, own);
    }
    return own;
  };

  const owner: Array<PromptAnchor | undefined> = entries.map((entry) => {
    // A keep-alive ping is nobody's request: it opens no turn and takes no prompt.
    if (entry.routingReason === 'cache keep-alive ping') {
      return undefined;
    }
    // The exact answer: Anthropic's request-id is in the transcript under the prompt that caused it.
    const exact = entry.anthropicRequestId ? promptOf(entry.anthropicRequestId) : undefined;
    if (exact) {
      return exact;
    }
    const anchors = pool(entry);
    const at = sentAt(entry);
    let lo = 0;
    let hi = anchors.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].at <= at) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? anchors[best] : undefined;
  });

  // The earliest row of each prompt opens its turn.
  const opener = new Map<PromptAnchor, number>();
  owner.forEach((anchor, index) => {
    if (!anchor) {
      return;
    }
    const current = opener.get(anchor);
    if (current === undefined || sentAt(entries[index]) < sentAt(entries[current])) {
      opener.set(anchor, index);
    }
  });

  let changed = false;
  const result = entries.map((entry, index) => {
    const anchor = owner[index];
    if (!anchor) {
      return entry;
    }
    const newUserTurn = opener.get(anchor) === index;
    if (entry.newUserTurn === newUserTurn && entry.sessionId === anchor.sessionId) {
      return entry;
    }
    changed = true;
    return { ...entry, newUserTurn, sessionId: anchor.sessionId };
  });
  return changed ? result : entries;
}
