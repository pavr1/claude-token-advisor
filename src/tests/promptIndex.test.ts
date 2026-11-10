import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { anchorEntries, PromptAnchor, PromptIndex, promptTextOf, transcriptFolderSuffix } from '../analytics/promptIndex';
import { groupTurns, LedgerEntry } from '../analytics/tracker';

const user = (extra: Record<string, unknown>, content: unknown) => ({ type: 'user', timestamp: '2026-10-28T10:00:00.000Z', sessionId: 's1', message: { role: 'user', content }, ...extra });
const row = (timestamp: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ timestamp, project: 'repo', newUserTurn: true, ...extra }) as LedgerEntry;
const anchor = (iso: string, sessionId = 's1'): PromptAnchor => ({ at: Date.parse(iso), sessionId });

test('only what the user typed counts as a prompt', () => {
  assert.equal(promptTextOf(user({}, 'hola')), 'hola');
  assert.equal(promptTextOf(user({}, [{ type: 'text', text: 'hola' }])), 'hola');
  assert.equal(promptTextOf(user({}, [{ type: 'tool_result', content: 'x' }])), undefined);
  assert.equal(promptTextOf(user({ isSidechain: true }, 'subagent task')), undefined);
  assert.equal(promptTextOf(user({ isMeta: true }, 'reminder')), undefined);
  assert.equal(promptTextOf(user({}, '[Request interrupted by user]')), undefined);
  assert.equal(promptTextOf({ type: 'assistant', message: { content: 'hola' } }), undefined);
});

test('the transcript folder of a repo is its name with every symbol turned into a dash', () => {
  assert.equal(transcriptFolderSuffix('Reseñas v2'), 'Rese-as-v2');
});

test('requests between two prompts belong to the first one, whatever they look like', () => {
  const anchors = [anchor('2026-10-28T10:00:00Z'), anchor('2026-10-28T10:10:00Z')];
  const entries = [
    row('2026-10-28T10:00:20Z', { newUserTurn: true }),
    row('2026-10-28T10:01:00Z', { newUserTurn: true }), // a quota probe that looked like a prompt
    row('2026-10-28T10:02:00Z', { newUserTurn: false }),
    row('2026-10-28T10:10:30Z', { newUserTurn: false }), // the next prompt's first request
    row('2026-10-28T10:11:00Z', { newUserTurn: true }),
  ];
  const result = anchorEntries(entries, () => anchors);
  assert.deepEqual(result.map((e) => e.newUserTurn), [true, false, false, true, false]);
  assert.equal(groupTurns(result).length, 2);
});

test('a new chat in the same repo opens its own turn even minutes after the last one', () => {
  const anchors = [anchor('2026-10-28T10:00:00Z', 'old'), anchor('2026-10-28T10:03:00Z', 'new')];
  const entries = [row('2026-10-28T10:00:30Z'), row('2026-10-28T10:03:20Z', { newUserTurn: false })];
  const turns = groupTurns(anchorEntries(entries, () => anchors));
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.sessionId), ['old', 'new']);
});

test('rows before the first known prompt, or with no transcript, stay as recorded', () => {
  const entries = [row('2026-10-28T09:00:00Z', { newUserTurn: false })];
  assert.equal(anchorEntries(entries, () => [anchor('2026-10-28T10:00:00Z')]), entries);
  assert.equal(anchorEntries(entries, () => []), entries);
});

test('the index reads prompts incrementally from the repo transcript folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  const dir = path.join(root, 'C--Users-me-Rese-as-repo');
  fs.mkdirSync(dir);
  const file = path.join(dir, 's1.jsonl');
  const line = (o: object) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line(user({ timestamp: '2026-10-28T10:00:00.000Z' }, 'one')) + line(user({}, [{ type: 'tool_result' }])));
  const index = new PromptIndex(root);
  assert.equal(await index.refresh(Date.parse('2026-10-28T12:00:00Z')), true);
  assert.equal(index.anchorsFor('repo').length, 1);
  assert.equal(index.anchorsFor('other').length, 0);
  assert.equal(await index.refresh(Date.parse('2026-10-28T12:00:00Z')), false);
  fs.appendFileSync(file, line(user({ timestamp: '2026-10-28T10:05:00.000Z' }, 'two')));
  assert.equal(await index.refresh(Date.parse('2026-10-28T12:00:00Z')), true);
  assert.deepEqual(index.anchorsFor('repo').map((a) => a.sessionId), ['s1', 's1']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('only the first request after a typed prompt opens a live turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  const dir = path.join(root, 'C--Users-me-repo');
  fs.mkdirSync(dir);
  const file = path.join(dir, 's1.jsonl');
  const line = (o: object) => JSON.stringify(o) + '\n';
  const now = Date.parse('2026-10-28T10:00:30Z');
  fs.writeFileSync(file, line(user({ timestamp: '2026-10-28T09:00:00.000Z' }, 'old')));
  const index = new PromptIndex(root);
  await index.refresh(now);
  index.claimAll();
  assert.equal(index.claimOpener('repo', 's1', now), 'continue');
  fs.appendFileSync(file, line(user({ timestamp: '2026-10-28T10:00:20.000Z' }, 'new prompt')));
  await index.refresh(now);
  assert.equal(index.claimOpener('repo', 's1', now), 'new');
  assert.equal(index.claimOpener('repo', 's1', now + 1000), 'continue'); // the quota probe right after
  assert.equal(index.claimOpener('nothing', undefined, now), 'unknown');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a request that started before a prompt never opens that prompt, even if it finished after it', () => {
  const anchors = [anchor('2026-10-28T10:00:00Z'), anchor('2026-10-28T10:00:30Z')];
  const entries = [
    row('2026-10-28T10:00:05Z', { newUserTurn: true, startedAt: Date.parse('2026-10-28T10:00:04Z') }),
    // sent at :25, answered at :40: the prompt typed at :30 is not in it
    row('2026-10-28T10:00:40Z', { newUserTurn: false, startedAt: Date.parse('2026-10-28T10:00:25Z') }),
    row('2026-10-28T10:00:50Z', { newUserTurn: false, startedAt: Date.parse('2026-10-28T10:00:41Z') }),
  ];
  const result = anchorEntries(entries, () => anchors);
  assert.deepEqual(result.map((e) => e.newUserTurn), [true, false, true]);
});

test('a request is tied to its prompt by Anthropic request-id, even when the clock says otherwise', () => {
  const first = { ...anchor('2026-10-28T10:00:00Z'), promptId: 'p1' };
  const second = { ...anchor('2026-10-28T10:00:30Z'), promptId: 'p2' };
  const byRequest = new Map([['req_a', first], ['req_b', first], ['req_c', second]]);
  const entries = [
    row('2026-10-28T10:00:05Z', { anthropicRequestId: 'req_a', startedAt: Date.parse('2026-10-28T10:00:04Z') }),
    // sent after the second prompt was typed, but it is the first prompt's call: its request-id says so
    row('2026-10-28T10:00:45Z', { anthropicRequestId: 'req_b', newUserTurn: false, startedAt: Date.parse('2026-10-28T10:00:35Z') }),
    row('2026-10-28T10:00:50Z', { anthropicRequestId: 'req_c', newUserTurn: false, startedAt: Date.parse('2026-10-28T10:00:36Z') }),
  ];
  const result = anchorEntries(entries, () => [first, second], (id) => byRequest.get(id));
  assert.deepEqual(result.map((e) => e.newUserTurn), [true, false, true]);
  assert.equal(groupTurns(result).length, 2);
  assert.deepEqual(groupTurns(result).map((g) => g.entries.length), [2, 1]);
});

test('the index maps each requestId of the transcript to the prompt that caused it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  const dir = path.join(root, 'C--Users-me-Rese-as-repo');
  fs.mkdirSync(dir);
  const line = (o: object) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    path.join(dir, 's1.jsonl'),
    line(user({ promptId: 'p1', timestamp: '2026-10-28T10:00:00.000Z' }, 'one')) +
      line({ type: 'assistant', requestId: 'req_1', sessionId: 's1' }) +
      line(user({ promptId: 'p1' }, [{ type: 'tool_result' }])) +
      line({ type: 'assistant', requestId: 'req_2', sessionId: 's1' }) +
      line(user({ promptId: 'p2', timestamp: '2026-10-28T10:05:00.000Z' }, 'two')) +
      line({ type: 'assistant', requestId: 'req_3', sessionId: 's1' }) +
      line({ type: 'assistant', requestId: 'req_side', sessionId: 's1', isSidechain: true })
  );
  const index = new PromptIndex(root);
  await index.refresh(Date.parse('2026-10-28T12:00:00Z'));
  assert.equal(index.promptOf('req_1')?.promptId, 'p1');
  assert.equal(index.promptOf('req_2')?.promptId, 'p1');
  assert.equal(index.promptOf('req_3')?.promptId, 'p2');
  assert.equal(index.promptOf('req_side'), undefined);
  assert.equal(index.promptOf('req_unknown'), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});
