/** Optimizer edges: stores' eviction and persistence, routing guards, request-shape tolerance, economics per model. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  BaselineMemory,
  CACHE_TTL_1H_MS,
  classifyRouting,
  DEFAULT_OPTIMIZER_CONFIG,
  describePrefixChange,
  describeTail,
  estimateCompactionEconomics,
  hasToolResults,
  HAIKU_MODEL_ID,
  latestUserText,
  optimizePayload,
  SummaryStore,
  SUMMARY_TTL_MS,
} from '../proxy/optimizer';
import { getPricingTable, resetPricing } from '../proxy/pricing';
import { MessagesPayload } from '../proxy/tokenCounter';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-extra-'));
const state = (n: number) => ({ coveredCount: n, prefixHash: `h${n}`, summaries: [`s${n}`] });

test('SummaryStore evicts the least recently used conversation beyond its capacity', () => {
  const store = new SummaryStore(2);
  store.set('a', state(1));
  store.set('b', state(2));
  store.get('a'); // a is now the most recent
  store.set('c', state(3));
  assert.equal(store.size, 2);
  assert.equal(store.get('b'), undefined);
  assert.ok(store.get('a'));
  assert.ok(store.get('c'));
});

test('SummaryStore.delete and clear remove states and persist the result', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'summaries.json');
  const store = new SummaryStore(10, file);
  store.set('a', state(1));
  store.set('b', state(2));
  store.delete('missing'); // nothing to remove, nothing to write
  store.delete('a');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).states), ['b']);
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).states, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SummaryStore reloads valid states, drops expired and malformed ones, and survives a corrupt or unwritable file', () => {
  const dir = tmp();
  const file = path.join(dir, 'summaries.json');
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      states: {
        fresh: { ...state(1), lastUsed: now },
        old: { ...state(2), lastUsed: now - SUMMARY_TTL_MS - 1 },
        undated: state(3),
        bad1: { coveredCount: 'x', prefixHash: 'h', summaries: [] },
        bad2: null,
        bad3: { coveredCount: 1, prefixHash: 'h', summaries: 'no' },
      },
    })
  );
  const store = new SummaryStore(10, file, () => now);
  assert.equal(store.size, 2);
  assert.ok(store.get('fresh'));
  assert.ok(store.get('undated'));
  assert.equal(store.get('old'), undefined);

  fs.writeFileSync(file, '{ corrupt');
  assert.equal(new SummaryStore(10, file).size, 0);

  // A path under a regular file cannot be written; set() must not throw.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => new SummaryStore(10, path.join(blocker, 'x.json')).set('k', state(1)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SummaryStore.get refreshes lastUsed only after the touch interval', () => {
  let now = 1_000_000;
  const dir = tmp();
  const file = path.join(dir, 's.json');
  const store = new SummaryStore(10, file, () => now);
  store.set('a', state(1));
  const written = fs.statSync(file).mtimeMs;
  now += 10; // too soon to rewrite
  store.get('a');
  assert.equal(fs.statSync(file).mtimeMs, written);
  now += 24 * 3_600_000; // a day later: persisted
  assert.equal(store.get('a')?.lastUsed, now);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BaselineMemory judges the cache by the TTL the previous request was written with', () => {
  const memory = new BaselineMemory(5 * 60_000);
  assert.equal(memory.cachedTokens('c', 1_000, 0), 0, 'nothing before it');
  assert.equal(memory.cachedTokens('c', 1_500, 4 * 60_000), 1_000, 'still warm at 4 minutes');
  assert.equal(memory.cachedTokens('c', 2_000, 11 * 60_000), 0, 'cold at 7 minutes after');

  // A 1 hour write keeps the cache alive past five minutes.
  memory.cachedTokens('h', 1_000, 0, CACHE_TTL_1H_MS);
  assert.equal(memory.cachedTokens('h', 900, 30 * 60_000), 900, 'capped by the new request size');
  // The best-case floor ignores the client's TTL but not the one-hour ceiling.
  assert.equal(memory.warmCachedTokens('h', 5_000, 30 * 60_000 + 59 * 60_000), 900);
  assert.equal(memory.warmCachedTokens('h', 5_000, 30 * 60_000 + 61 * 60_000), 0);
  assert.equal(memory.warmCachedTokens('unseen', 5_000, 0), 0);
});

test('BaselineMemory forgets the oldest conversation past its capacity and persists across instances', () => {
  const dir = tmp();
  const file = path.join(dir, 'baseline.json');
  const memory = new BaselineMemory(5 * 60_000, 2, file);
  memory.cachedTokens('a', 100, 0);
  memory.cachedTokens('b', 200, 1);
  memory.cachedTokens('c', 300, 2);
  const reloaded = new BaselineMemory(5 * 60_000, 2, file);
  assert.equal(reloaded.cachedTokens('a', 100, 3), 0, 'a was evicted');
  assert.equal(reloaded.cachedTokens('c', 300, 4), 300);

  fs.writeFileSync(file, JSON.stringify({ last: { ok: { rawTokens: 5, at: 1, ttlMs: 'x' }, bad: { rawTokens: 'x' } } }));
  const sanitized = new BaselineMemory(5 * 60_000, 10, file);
  assert.equal(sanitized.cachedTokens('ok', 9, 2), 5);
  assert.equal(sanitized.cachedTokens('bad', 9, 2), 0);

  fs.writeFileSync(file, 'nope');
  assert.doesNotThrow(() => new BaselineMemory(5 * 60_000, 10, file));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => new BaselineMemory(5 * 60_000, 10, path.join(blocker, 'x.json')).cachedTokens('k', 1, 0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classifyRouting explains every reason it keeps the requested model', () => {
  const ask = (messages: unknown[], model = 'claude-sonnet-5', tokens = 100) => classifyRouting({ model, messages } as MessagesPayload, tokens);

  assert.deepEqual(ask([{ role: 'user', content: 'hola' }], HAIKU_MODEL_ID), { downgrade: false, reason: 'already on Haiku' });
  assert.equal(ask([{ role: 'user', content: 'hola' }], 'claude-sonnet-5', 10_000_000).reason, 'input exceeds the Haiku context window');
  assert.equal(
    ask([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] }]).reason,
    'turn carries tool results'
  );
  assert.equal(ask([{ role: 'user', content: '   ' }]).reason, 'no user text to classify');
  assert.equal(ask([]).reason, 'no user text to classify');
  assert.equal(ask([{ role: 'user', content: 'x'.repeat(5_000) }]).reason, 'latest turn is too long to be trivial');
  assert.equal(ask([{ role: 'user', content: 'tell me something nice about the weather' }]).reason, 'no simple-task signal matched');
  assert.equal(ask([{ role: 'user', content: 'hola' }]).downgrade, true);
});

test('latestUserText skips assistant turns, ignores injected blocks and tolerates odd content', () => {
  const text = (messages: unknown[]): string => latestUserText({ messages } as MessagesPayload);
  assert.equal(text([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }]), 'first');
  assert.equal(text([{ role: 'user', content: [{ type: 'text', text: 'typed' }, null, 7, { type: 'image' }, { type: 'text', text: '<system-reminder>x</system-reminder>' }] }]), 'typed');
  assert.equal(text([{ role: 'user', content: 42 }]), '');
  assert.equal(text([]), '');
});

test('describeTail summarizes the last three messages and tolerates malformed ones', () => {
  const payload = {
    messages: [
      { role: 'user', content: 'dropped (older than three)' },
      { role: 'user', content: 'a long message with   many spaces' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }, null] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: 'note' }] },
    ],
  } as MessagesPayload;
  assert.equal(
    describeTail(payload),
    'user[text"a long message w"] > assistant[tool_use,undefined] > user[tool_result,text"note"]'
  );
  assert.equal(describeTail({} as MessagesPayload), '');
  assert.equal(describeTail({ messages: [{ role: 'user', content: 5 }] } as MessagesPayload), 'user[]');
});

test('hasToolResults follows the loop through injected reminders but not through typed text', () => {
  const has = (messages: unknown[]): boolean => hasToolResults({ messages } as MessagesPayload);
  assert.equal(has([]), false);
  assert.equal(has([{ role: 'assistant', content: 'x' }]), false);
  assert.equal(has([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] }]), true);
  assert.equal(
    has([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] },
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>nudge</system-reminder>' }] },
    ]),
    true
  );
  assert.equal(has([{ role: 'user', content: 'a new prompt' }]), false);
  assert.equal(has([{ role: 'user', content: 42 }]), false);
});

test('compaction economics read the cache multipliers of the model that serves the turn', () => {
  resetPricing();
  try {
    const base = { olderTokens: 20_000, keptTokens: 5_000, cacheWarm: false, expectedRequests: 5 };
    const normal = estimateCompactionEconomics(base);
    assert.ok(normal.savings > 0);

    // Repricing the writes at 2x input doubles the cold-cache saving without touching the code.
    getPricingTable().rates['claude-sonnet-5'] = { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 6e-6 };
    const repriced = estimateCompactionEconomics({ ...base, model: 'claude-sonnet-5' });
    assert.ok(repriced.savings > normal.savings);
    assert.equal(repriced.haikuCost, normal.haikuCost);
  } finally {
    resetPricing();
  }
});

test('the cache anchor tolerates an empty history, odd content shapes and manifests it cannot extend', async () => {
  const run = async (payload: Record<string, unknown>) =>
    (await optimizePayload(payload as MessagesPayload, { ...DEFAULT_OPTIMIZER_CONFIG }, {})).payload;

  // No messages: nothing to anchor, nothing thrown.
  assert.deepEqual((await run({ model: 'claude-sonnet-5', messages: [] }))['messages'], []);
  // A string-only last message and an empty block list both pass through unharmed.
  const text = await run({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'plain question here' }] });
  assert.equal((text['messages'] as unknown[]).length, 1);
  const empty = await run({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: [] }] });
  assert.equal((empty['messages'] as unknown[]).length, 1);
  // A last block that is not an object cannot carry a breakpoint.
  const odd = await run({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: [null] }] });
  assert.equal((odd['messages'] as Array<{ content: unknown[] }>)[0].content[0], null);
});

test('describePrefixChange names the first part of the cacheable prefix that moved', () => {
  const base = { model: 'm', tools: 't', system: 's', messages: ['a', 'b'] };
  assert.equal(describePrefixChange(undefined, base), 'first');
  assert.equal(describePrefixChange(base, { ...base, messages: ['a', 'b', 'c'] }), 'none');
  assert.equal(describePrefixChange(base, { ...base, messages: ['a'] }), 'shrunk');
  assert.equal(describePrefixChange(base, { ...base, messages: ['a', 'x'] }), 'msg[1]');
  assert.equal(describePrefixChange(base, { ...base, system: 'z', messages: ['q'] }), 'system');
  assert.equal(describePrefixChange(base, { ...base, tools: 'z' }), 'tools');
  assert.equal(describePrefixChange(base, { ...base, model: 'n' }), 'model');
});

test('optimizePayload reports prefix changes per conversation and ignores cache_control moves', async () => {
  const turn = (extra: unknown[], control: boolean) =>
    ({
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'prefix-test-unique-start', ...(control ? { cache_control: { type: 'ephemeral' } } : {}) }] }, ...extra],
    }) as unknown as MessagesPayload;
  const run = (p: MessagesPayload) => optimizePayload(p, { ...DEFAULT_OPTIMIZER_CONFIG }, {});
  const first = await run(turn([], true));
  assert.equal(first.telemetry.clientPrefixChange, 'first');
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
  const second = await run(turn([reply], false));
  assert.equal(second.telemetry.clientPrefixChange, 'none');
  assert.equal(second.telemetry.sentPrefixChange, 'none');
});
