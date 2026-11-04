#!/usr/bin/env node
/**
 * Quality bench for the local summary (src/proxy/localSummary.ts). Not shipped with the extension.
 *
 * Takes real Claude Code sessions (~/.claude/projects/<project>/<session>.jsonl), summarizes everything but the last turns, and checks what
 * the summary kept. The control facts are taken from the history itself, so no one writes them by hand:
 *   requests   what the person typed (first words of each human message)
 *   files      files the tools edited, wrote or read (by file name)
 *   commands   state commands that were run: builds, tests, packages, git (first words)
 *   errors     tool calls that failed (the first words of what they said)
 *   identifiers `names()` / `camelCase` / snake_case words the assistant put between backticks
 *   last       the last request of the older part, which the work was in the middle of
 * Coverage is the share of each kind found in the summary text. Compression is tokens before / after at 3.5 chars per token.
 *
 * --window N  summarize only the first N tokens of each session, as the compaction does with one slice (default: all but the last turns)
 * Usage: node tools/summary_bench.js [--window 60000] [--min 40] [--max 25] [--keep 12] [--dir <projects dir>] [--write <out dir>] [--json]
 *   --write saves, per session, `<id>.history.txt` (what the summary stood for) and `<id>.summary.txt`, for a judge to read.
 * Needs `npm run compile` first (uses out/proxy/localSummary.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildLocalSummary } = require('../out/proxy/localSummary');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const MIN_MESSAGES = Number(opt('min', 40));
const MAX_SESSIONS = Number(opt('max', 25));
const KEEP = Number(opt('keep', 12));
const ROOT = opt('dir', path.join(os.homedir(), '.claude', 'projects'));
const WRITE = opt('write', '');
const WINDOW = Number(opt('window', 0));
const AS_JSON = args.includes('--json');

const norm = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
const TOKENS = (chars) => Math.round(chars / 3.5);

function loadSession(file) {
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain || !row.message || row.isMeta) continue;
    const { role, content } = row.message;
    if (role !== 'user' && role !== 'assistant') continue;
    messages.push({ role, content });
  }
  return messages;
}

const blocks = (m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]);
const isHumanTurn = (m) =>
  m.role === 'user' &&
  blocks(m).some((b) => b && b.type === 'text' && b.text && !/^\s*</.test(b.text));
const humanText = (m) =>
  blocks(m)
    .filter((b) => b && b.type === 'text' && b.text && !/^\s*</.test(b.text))
    .map((b) => b.text)
    .join(' ');

/** Index where the kept tail starts: a human turn, KEEP messages from the end at most. */
function cutIndex(messages) {
  for (let i = Math.max(1, messages.length - KEEP); i < messages.length; i += 1) {
    if (isHumanTurn(messages[i])) return i;
  }
  return -1;
}

function facts(older) {
  const out = { requests: [], files: new Set(), commands: [], errors: [], identifiers: new Set(), last: undefined };
  const toolNames = new Map();
  for (const m of older) {
    for (const b of blocks(m)) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        const input = b.input || {};
        if (['Edit', 'Write', 'MultiEdit', 'Read', 'NotebookEdit'].includes(b.name) && typeof input.file_path === 'string') {
          if (!/(^|[\\/])(temp|tmp|scratchpad)([\\/]|$)/i.test(input.file_path)) out.files.add(path.basename(input.file_path.replace(/\\/g, '/')));
        }
        if (b.name === 'Bash' && typeof input.command === 'string') {
          const cmd = input.command.replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '').trim();
          if (/^(npm|npx|yarn|pnpm|node|tsc|py|python3?|pytest|git|gh|make|cargo|go|dotnet|mvn|gradle)\b/.test(cmd) && !/^\S+(\s+-\w+)*\s+(-c|-e|-)(\s|$)|<</.test(cmd.split('\n')[0])) out.commands.push(cmd.slice(0, 40));
        }
      } else if (b.type === 'tool_result' && b.is_error) {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(' ');
        if (text.trim()) out.errors.push(text.trim().slice(0, 50));
      } else if (b.type === 'text' && m.role === 'assistant') {
        for (const match of b.text.matchAll(/`([A-Za-z_][\w.]*(?:\(\))?)`/g)) {
          const id = match[1];
          if (id.length >= 6 && (/[a-z][A-Z]/.test(id) || id.includes('_') || id.endsWith('()') || id.includes('.'))) out.identifiers.add(id);
        }
      }
    }
    if (isHumanTurn(m)) {
      const t = humanText(m).trim();
      if (t.length >= 12) {
        out.requests.push(t.slice(0, 30));
        out.last = t.slice(0, 30);
      }
    }
  }
  return out;
}

function coverage(list, summaryNorm) {
  const items = [...new Set(list)];
  const missed = items.filter((x) => !summaryNorm.includes(norm(x)));
  return { total: items.length, found: items.length - missed.length, missed };
}

function render(messages) {
  return messages
    .map((m) => {
      const parts = blocks(m).map((b) => {
        if (!b) return '';
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 300)}]`;
        if (b.type === 'tool_result') return `[tool_result ${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 600)}]`;
        return '';
      });
      return `${m.role.toUpperCase()}: ${parts.filter(Boolean).join('\n')}`;
    })
    .join('\n\n');
}

const files = [];
for (const dir of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const f of fs.readdirSync(full)) if (f.endsWith('.jsonl')) files.push(path.join(full, f));
}

const results = [];
const kinds = ['requests', 'files', 'commands', 'errors', 'identifiers', 'last'];
for (const file of files) {
  if (results.length >= MAX_SESSIONS) break;
  const messages = loadSession(file);
  if (messages.length < MIN_MESSAGES) continue;
  let cut = cutIndex(messages);
  if (WINDOW > 0) {
    let chars = 0;
    cut = 0;
    for (let i = 0; i < messages.length; i += 1) {
      chars += JSON.stringify(messages[i]).length;
      if (chars > WINDOW * 3.5) break;
      if (i > 0 && isHumanTurn(messages[i])) cut = i;
    }
    if (chars <= WINDOW * 3.5) continue; // the session is shorter than the window: not comparable
  }
  if (cut < 4) continue;
  const older = messages.slice(0, cut);
  const summary = buildLocalSummary(older);
  const summaryNorm = norm(summary);
  const f = facts(older);
  const cov = {
    requests: coverage(f.requests, summaryNorm),
    files: coverage([...f.files], summaryNorm),
    commands: coverage(f.commands, summaryNorm),
    errors: coverage(f.errors, summaryNorm),
    identifiers: coverage([...f.identifiers], summaryNorm),
    last: coverage(f.last ? [f.last] : [], summaryNorm),
  };
  const beforeChars = JSON.stringify(older).length;
  const id = path.basename(file, '.jsonl').slice(0, 8);
  results.push({ id, project: path.basename(path.dirname(file)).slice(-28), messages: older.length, beforeTokens: TOKENS(beforeChars), afterTokens: TOKENS(summary.length), cov });
  if (WRITE) {
    fs.mkdirSync(WRITE, { recursive: true });
    fs.writeFileSync(path.join(WRITE, `${id}.history.txt`), render(older));
    fs.writeFileSync(path.join(WRITE, `${id}.summary.txt`), summary);
  }
}

const pct = (c) => (c.total ? `${Math.round((100 * c.found) / c.total)}%` : '  -');
const agg = Object.fromEntries(kinds.map((k) => [k, { found: 0, total: 0, missed: [] }]));
for (const r of results) for (const k of kinds) {
  agg[k].found += r.cov[k].found;
  agg[k].total += r.cov[k].total;
  agg[k].missed.push(...r.cov[k].missed);
}

if (AS_JSON) {
  console.log(JSON.stringify({ results, agg: Object.fromEntries(kinds.map((k) => [k, { found: agg[k].found, total: agg[k].total }])) }, null, 1));
} else {
  console.log(`${results.length} sessions with at least ${MIN_MESSAGES} messages; summary of all but the last ~${KEEP}\n`);
  console.log('id        msgs  before  after  ratio |  requests  files  commands  errors  idents  last');
  for (const r of results) {
    const c = r.cov;
    console.log(
      `${r.id}  ${String(r.messages).padStart(4)}  ${String(r.beforeTokens).padStart(6)}  ${String(r.afterTokens).padStart(5)}  ${(r.beforeTokens / Math.max(1, r.afterTokens)).toFixed(0).padStart(4)}x |  ${pct(c.requests).padStart(7)}  ${pct(c.files).padStart(5)}  ${pct(c.commands).padStart(8)}  ${pct(c.errors).padStart(6)}  ${pct(c.identifiers).padStart(6)}  ${pct(c.last).padStart(4)}`
    );
  }
  const before = results.reduce((s, r) => s + r.beforeTokens, 0);
  const after = results.reduce((s, r) => s + r.afterTokens, 0);
  console.log(`\nTOTAL  tokens ${before} -> ${after} (${(before / Math.max(1, after)).toFixed(0)}x smaller)`);
  for (const k of kinds) console.log(`  ${k.padEnd(12)} ${agg[k].found}/${agg[k].total} = ${agg[k].total ? Math.round((100 * agg[k].found) / agg[k].total) : '-'}%`);
  for (const k of ['errors', 'identifiers', 'files', 'commands']) {
    console.log(`\nmost typical misses (${k}):`);
    for (const m of agg[k].missed.slice(0, 5)) console.log(`   - ${m.replace(/\s+/g, ' ')}`);
  }
}
