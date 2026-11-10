/** The summary built without a model: what it keeps, what it leaves out, and that it is bounded and repeatable. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalSummary, LOCAL_SUMMARY_GROWN_MAX_CHARS, LOCAL_SUMMARY_MAX_CHARS, LOCAL_SUMMARY_NOTE } from '../proxy/localSummary';

type Message = Record<string, unknown>;

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
const tool = (name: string, input: Record<string, unknown>): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id: `t_${name}`, name, input }] });
const result = (content = 'ok', isError = false): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content, ...(isError ? { is_error: true } : {}) }] });

test('it says in its first line that no model made it, and what that costs', () => {
  const text = buildLocalSummary([user('add a button'), assistant('done')]);
  assert.ok(text.startsWith(LOCAL_SUMMARY_NOTE));
  assert.match(text, /without a model/);
  assert.match(text, /cut excerpts/);
  assert.match(text, /not included/);
});

test('it keeps what was asked and the answer that closed each request, oldest first', () => {
  const text = buildLocalSummary([
    user('fix the rounding in pricing'),
    assistant('Looking at it.'),
    tool('Read', { file_path: 'src/pricing.ts' }),
    result('contents'),
    assistant('Fixed: the tier now rounds up. Tests pass.'),
    user('now add the long-prompt tier'),
    assistant('Added, 5x above 100,000 tokens.'),
  ]);
  assert.match(text, /## Requests and what came back \(2 in all, oldest first\)/);
  assert.match(text, /1\. Asked: fix the rounding in pricing\n {3}Answer: Fixed: the tier now rounds up\. Tests pass\./);
  assert.match(text, /2\. Asked: now add the long-prompt tier\n {3}Answer: Added, 5x above 100,000 tokens\./);
  assert.ok(text.indexOf('1. Asked') < text.indexOf('2. Asked'));
  assert.doesNotMatch(text, /Looking at it/, 'only the closing text of an answer is kept');
});

test('what the client injected is not a request, and neither is a tool result', () => {
  const text = buildLocalSummary([
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }, { type: 'text', text: 'the real request' }] },
    { role: 'system', content: [{ type: 'text', text: '# Environment Update' }] },
    assistant('ok'),
    result('a long tool output that must not be taken for a request'),
  ]);
  assert.match(text, /\(1 in all/);
  assert.match(text, /Asked: the real request/);
  assert.doesNotMatch(text, /system-reminder|Environment Update|tool output that must not/);
});

test('files are listed with what was done to them, changed ones first, and commands are the latest distinct ones', () => {
  const text = buildLocalSummary([
    user('refactor'),
    tool('Read', { file_path: 'src/a.ts' }),
    tool('Read', { file_path: 'src/a.ts' }),
    tool('Edit', { file_path: 'src/b.ts', old_string: 'x'.repeat(5000), new_string: 'y' }),
    tool('Edit', { file_path: 'src/b.ts', old_string: 'x', new_string: 'z' }),
    tool('Write', { file_path: 'src/new.ts', content: 'z'.repeat(9000) }),
    tool('Read', { file_path: 'src/c.ts' }),
    tool('Bash', { command: 'npm test\nsecond line' }),
    tool('Bash', { command: 'git status' }),
    tool('Bash', { command: 'npm test' }),
    tool('Grep', { pattern: 'foo', path: 'src' }),
  ]);
  const files = text.slice(text.indexOf('## Files touched'), text.indexOf('## Build, test'));
  assert.match(files, /- src\/b\.ts — edited ×2/);
  assert.match(files, /- src\/new\.ts — written ×1/);
  assert.match(files, /- src\/a\.ts — read ×2/);
  assert.ok(files.indexOf('src/b.ts') < files.indexOf('src/a.ts'), 'edited before read');
  assert.ok(files.indexOf('src/new.ts') < files.indexOf('src/a.ts'));
  assert.doesNotMatch(text, /x{50}|z{50}/, 'file contents and edit bodies are never copied');
  assert.doesNotMatch(files, /Grep/);
  assert.match(text, /## Build, test and version-control commands \(the latest 2 distinct of 3\)\n- `git status`\n- `npm test`/);
  assert.match(text, /Tools used: .*Bash ×3/);
});

test('failed tool calls are counted, and a result is never read as a request', () => {
  const text = buildLocalSummary([user('go'), tool('Bash', { command: 'false' }), result('boom', true), tool('Bash', { command: 'true' }), result()]);
  assert.match(text, /Tool calls that failed: 1\./);
});

test('long requests and answers are cut, an answer keeps both ends, and the last exchange is shown in more detail', () => {
  const longAnswer = `START ${'middle '.repeat(200)} END-RESULT`;
  const text = buildLocalSummary([user(`REQ ${'word '.repeat(400)}`), assistant(longAnswer)]);
  const exchange = text.slice(text.indexOf('1. Asked'), text.indexOf('## Where it stood'));
  assert.ok(exchange.length < 1800, `exchange is ${exchange.length} chars`);
  assert.match(exchange, /Answer: START .* … .*END-RESULT/);
  assert.match(exchange, /Asked: REQ .*…/);
  const stood = text.slice(text.indexOf('## Where it stood'));
  assert.match(stood, /Last request: REQ/);
  assert.match(stood, /END-RESULT/);
  assert.ok(stood.length > exchange.length / 2, 'the last exchange gets a longer excerpt');
});

test('a very long history is bounded: the first exchange and the newest ones stay, and the gap says how many were left out', () => {
  const messages: Message[] = [];
  for (let i = 1; i <= 300; i += 1) {
    messages.push(user(`request number ${i} ${'detail '.repeat(30)}`), assistant(`answer number ${i} ${'result '.repeat(30)}`));
    messages.push(tool('Edit', { file_path: `src/file${i}.ts` }), tool('Bash', { command: `command ${i}` }));
  }
  const text = buildLocalSummary(messages);
  assert.ok(text.length <= LOCAL_SUMMARY_GROWN_MAX_CHARS, `${text.length} chars`);
  assert.match(text, /\(300 in all/);
  assert.match(text, /1\. Asked: request number 1 /, 'the first request is the original task');
  assert.match(text, /300\. Asked: request number 300 /, 'the newest is there');
  assert.match(text, /… \d+ exchanges left out …/);
  assert.match(text, /## Files touched \(\d+ of 300\)/);
  assert.match(text, /src\/file300\.ts/, 'the most recent files win');
  assert.doesNotMatch(text, /src\/file1\.ts/);
});

test('the same history always gives the same text', () => {
  const history = [user('a'), assistant('b'), tool('Edit', { file_path: 'x.ts' }), user('c'), assistant('d')];
  assert.equal(buildLocalSummary(history), buildLocalSummary(history));
});

test('a part with nothing to report says so instead of coming out empty', () => {
  const text = buildLocalSummary([{ role: 'system', content: [{ type: 'text', text: 'x' }] }, result('only a tool result')]);
  assert.match(text, /No request, file or command was found/);
  assert.ok(text.startsWith(LOCAL_SUMMARY_NOTE));
});

test('messages whose content is a plain string are read too', () => {
  const text = buildLocalSummary([{ role: 'user', content: 'a plain string request' }, { role: 'assistant', content: 'a plain string answer' }]);
  assert.match(text, /Asked: a plain string request\n {3}Answer: a plain string answer/);
});

test('the folder change that starts a command is dropped, and only builds, tests and version control are listed', () => {
  const text = buildLocalSummary([
    user('run things'),
    tool('Bash', { command: 'cd "C:/Users/me/My Project" && npm run compile 2>&1 | tail -4' }),
    tool('Bash', { command: "cd '/home/me/p'; git status" }),
    tool('Bash', { command: 'ls -la src' }),
    tool('Bash', { command: 'cat package.json | head' }),
    tool('Bash', { command: 'grep -rn foo src' }),
    tool('Bash', { command: 'CI=1 py -m pytest tests/' }),
  ]);
  const section = text.slice(text.indexOf('## Build, test'), text.indexOf('Tools used'));
  assert.match(section, /- `npm run compile 2>&1 \| tail -4`/);
  assert.match(section, /- `git status`/);
  assert.match(section, /- `CI=1 py -m pytest tests\/`/);
  assert.doesNotMatch(section, /cd |ls -la|cat package|grep -rn/);
  assert.match(section, /\(3 other shell commands, such as listing and reading files, are not listed\)/);
});

test('paths are shown without what they all share, files in a temporary folder are not listed, and backslashes are read as slashes', () => {
  const text = buildLocalSummary([
    user('work'),
    tool('Edit', { file_path: 'C:\\Users\\me\\Documents\\project\\src\\proxy\\optimizer.ts' }),
    tool('Edit', { file_path: 'C:\\Users\\me\\Documents\\project\\src\\ui\\tips.ts' }),
    tool('Read', { file_path: 'C:\\Users\\me\\Documents\\project\\package.json' }),
    tool('Write', { file_path: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratchpad\\helper.py' }),
    tool('Write', { file_path: '/tmp/other.sh' }),
  ]);
  const files = text.slice(text.indexOf('## Files touched'), text.indexOf('Tools used'));
  assert.match(files, /## Files touched \(2 touches of temporary files not listed\)/);
  assert.match(files, /- …\/project\/src\/proxy\/optimizer\.ts — edited ×1/);
  assert.match(files, /- …\/project\/src\/ui\/tips\.ts — edited ×1/);
  assert.match(files, /- …\/project\/package\.json — read ×1/);
  assert.doesNotMatch(files, /Documents|Users|helper\.py|other\.sh|\\/);
});

test('a lone file is shown by its last folders, and a very long path is cut from the front', () => {
  const lone = buildLocalSummary([user('x'), tool('Edit', { file_path: '/a/b/c/d/e/file.ts' })]);
  assert.match(lone, /- …\/d\/e\/file\.ts — edited ×1/);
  const deep = `/root/${'folder/'.repeat(30)}file.ts`;
  const long = buildLocalSummary([user('x'), tool('Edit', { file_path: deep }), tool('Edit', { file_path: `${deep}.bak` })]);
  const line = long.split('\n').find((l) => l.startsWith('- …')) ?? '';
  assert.ok(line.length < 120, `${line.length} chars`);
  assert.match(line, /file\.ts/);
});

test('only the first step of a command says what kind it is, and an inline script is analysis, not state', () => {
  const text = buildLocalSummary([
    user('look around'),
    tool('Bash', { command: 'ls src; py -c "print(1)"' }),
    tool('Bash', { command: "py -I - <<'PYEOF'\nprint(1)\nPYEOF" }),
    tool('Bash', { command: 'node -e "console.log(1)"' }),
    tool('Bash', { command: 'echo start && npm test' }),
    tool('Bash', { command: 'cd /p && npm run compile && node --test out/tests/a.test.js' }),
    tool('Bash', { command: 'py claude_budget_advisor.py --offline' }),
  ]);
  const section = text.slice(text.indexOf('## Build, test'), text.indexOf('Tools used'));
  assert.match(section, /- `npm run compile && node --test out\/tests\/a\.test\.js`/);
  assert.match(section, /- `py claude_budget_advisor\.py --offline`/);
  assert.match(section, /\(4 other shell commands/, 'the three exploratory ones and the one that started with echo');
  assert.doesNotMatch(section, /print\(1\)|console\.log|ls src|echo start/);
});

test('a small part keeps the base cap and a large one gets more room, up to the grown cap', () => {
  const build = (n: number): string => {
    const messages: Message[] = [];
    for (let i = 1; i <= n; i += 1) {
      messages.push(user(`request ${i} ${'detail '.repeat(40)}`), assistant(`answer ${i} ${'result '.repeat(40)}`));
    }
    return buildLocalSummary(messages);
  };
  const small = build(100).length;
  assert.ok(small <= LOCAL_SUMMARY_MAX_CHARS);
  const big = build(1500).length;
  assert.ok(big > small && big <= LOCAL_SUMMARY_GROWN_MAX_CHARS, `${small} -> ${big} chars`);
});

test('a failed tool call is listed with its command and what it said', () => {
  const failing: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'npm test' } }] };
  const failed: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: true, content: 'Exit code 1\n3 tests failing' }] };
  const text = buildLocalSummary([user('run the tests'), failing, failed, assistant('they fail')]);
  assert.match(text, /## Tool calls that failed/);
  assert.match(text, /`npm test` → Exit code 1 3 tests failing/);
});

test('the identifiers the assistant named between backticks are listed, the most repeated first', () => {
  const text = buildLocalSummary([user('why'), assistant('see `buildLocalSummary` and `other_name`'), user('and'), assistant('again `buildLocalSummary`, not `plain`')]);
  assert.match(text, /## Names the assistant mentioned most\nbuildLocalSummary, other_name/);
  assert.doesNotMatch(text.split('## Names the assistant mentioned most')[1].split('##')[0], /plain/);
});

test('what the user decided is kept: short replies with the question they answer, and the answers to AskUserQuestion', () => {
  const ask: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] };
  const answered: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'User has answered: "Which DB?"="One per branch"' }] };
  const text = buildLocalSummary([
    user('plan the migration'),
    assistant('I can do A or B. Which one do you prefer?'),
    user('sí, la B'),
    ask,
    answered,
    assistant('done'),
    user('nunca uses mocks en las pruebas de la base de datos'),
    assistant('ok'),
  ]);
  assert.match(text, /## Decisions, corrections and answers from the user/);
  assert.match(text, /After "…I can do A or B\. Which one do you prefer\?" the user said: sí, la B/);
  assert.match(text, /The user answered a question: User has answered: "Which DB\?"="One per branch"/);
  assert.match(text, /the user said: nunca uses mocks/);
});

test('a failure that a later run of the same command cleared is not listed, and an interruption is not a request', () => {
  const run = (id: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] });
  const res = (id: string, isError: boolean): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Exit code 1\nboom' : 'ok', ...(isError ? { is_error: true } : {}) }] });
  const text = buildLocalSummary([user('fix it'), run('a'), res('a', true), run('b'), res('b', false), assistant('fixed'), user('[Request interrupted by user]')]);
  assert.doesNotMatch(text, /## Tool calls that failed/);
  assert.match(text, /Last request: fix it/);
});

test('the first request is kept nearly whole and a Write is shown as written, scripts that write files add their paths', () => {
  const text = buildLocalSummary([
    user(`GOAL ${'rule '.repeat(150)}END-OF-BRIEF`),
    assistant('ok'),
    tool('Write', { file_path: 'src/made.ts', content: 'x' }),
    tool('Bash', { command: `python - <<'EOF'\np='src/proxy/changed.ts'\nopen(p,'w').write('x')\nEOF` }),
  ]);
  assert.match(text, /1\. Asked: GOAL .*END-OF-BRIEF/);
  assert.match(text, /src\/made\.ts — written ×1/);
  assert.match(text, /src\/proxy\/changed\.ts — edited ×1/);
});
