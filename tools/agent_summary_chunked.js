/* Clean + chunk + summarize with the agent bench. Usage: node tools/agent_summary_chunked.js <history.txt> <out.txt> [model] [--chunk-chars N]
 * 1) strips injected context (<system-reminder> blocks, "Contents of ...CLAUDE.md" blocks, "# claudeMd" sections)
 * 2) splits at turn boundaries into chunks (default 300K chars, about 80K tokens, under the 100K limit)
 * 3) summarizes sequentially: chunk i is sent with the summary so far, the last summary is the result. */
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const ci = args.indexOf('--chunk-chars');
const LIMIT = ci >= 0 ? +args[ci + 1] : 300000;
const pos = args.filter((a, i) => !a.startsWith('--') && !(ci >= 0 && i === ci + 1));
const [hist, out, model = 'haiku'] = pos;
function clean(t) {
  return t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/(^|\n)#\s*claudeMd[\s\S]*?(?=\n(?:USER|ASSISTANT):|$)/g, '$1')
    .replace(/Contents of [^\n]*CLAUDE\.md[^\n]*\n[\s\S]*?(?=\n(?:USER|ASSISTANT):|$)/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
const text = clean(fs.readFileSync(hist, 'utf8'));
const turns = text.split(/\n(?=(?:USER|ASSISTANT): )/);
const chunks = []; let cur = '';
for (const t of turns) {
  if (cur && cur.length + t.length > LIMIT) { chunks.push(cur); cur = ''; }
  cur += (cur ? '\n' : '') + t;
}
if (cur) chunks.push(cur);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-'));
let prev = '', total = 0;
chunks.forEach((c, i) => {
  const inp = path.join(tmp, `c${i}.txt`), o = path.join(tmp, `s${i}.txt`);
  fs.writeFileSync(inp, (prev ? `[SUMMARY OF THE EARLIER PART OF THE SAME SESSION; merge it with the new part and keep it consistent]\n${prev}\n\n[NEW PART OF THE TRANSCRIPT]\n` : '') + c);
  const r = spawnSync('node', [path.join(__dirname, 'agent_summary_bench.js'), inp, o, model], { encoding: 'utf8', maxBuffer: 64e6 });
  console.log(`chunk ${i + 1}/${chunks.length} chars=${c.length}`, (r.stdout || r.stderr || '').trim().slice(0, 400));
  if (r.status !== 0) process.exit(1);
  try { total += JSON.parse(r.stdout).unitsTotal || 0; } catch {}
  prev = fs.readFileSync(o, 'utf8');
});
fs.writeFileSync(out, prev);
console.log(JSON.stringify({ file: path.basename(hist), chunks: chunks.length, cleanedChars: text.length, unitsTotal: total }));
