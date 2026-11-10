/** The newest Sonnet and Haiku, asked of Anthropic instead of written in the code. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { FALLBACK_MODELS, ModelCatalog, ModelCatalogOptions, pickLatest } from '../proxy/modelCatalog';

const entry = (id: string, created: string) => ({ id, created_at: created, type: 'model' });
const LIST = [
  entry('claude-sonnet-5', '2026-02-01T00:00:00Z'),
  entry('claude-sonnet-5-5', '2026-06-01T00:00:00Z'),
  entry('claude-haiku-4-5-20251001', '2025-10-01T00:00:00Z'),
  entry('claude-haiku-5-5', '2026-06-15T00:00:00Z'),
  entry('claude-opus-5-5', '2026-07-01T00:00:00Z'),
];
const creds = { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function catalog(answer: () => { ok: boolean; status: number; body?: unknown }, extra: Partial<ModelCatalogOptions> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const made = new ModelCatalog({
    baseUrl: () => 'https://api.example.test',
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      const a = answer();
      return { ok: a.ok, status: a.status, json: async () => a.body };
    },
    log: (m) => logs.push(m),
    now: () => clock,
    ...extra,
  });
  return { made, calls, logs, advance: (ms: number) => void (clock += ms) };
}

test('the newest model of each family wins, by creation date, and other families and foreign ids are ignored', () => {
  assert.equal(pickLatest(LIST, 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(pickLatest(LIST, 'haiku'), 'claude-haiku-5-5');
  assert.equal(pickLatest([entry('gpt-sonnet-9', '2030-01-01T00:00:00Z'), entry('claude-opus-5-5', '2026-07-01T00:00:00Z')], 'sonnet'), undefined);
  // No dates at all: the larger id, which is the newer version in the naming, wins.
  assert.equal(pickLatest([{ id: 'claude-sonnet-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-4-5' }], 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(pickLatest([], 'haiku'), undefined);
});

test('until it has asked, the built-in models are used', () => {
  const { made } = catalog(() => ({ ok: true, status: 200, body: { data: LIST } }));
  assert.deepEqual(made.current, FALLBACK_MODELS);
});

test('it asks with the credentials of the client, uses the answer, and does not ask again until it is old', async () => {
  const newer = [...LIST, entry('claude-sonnet-9', '2027-01-01T00:00:00Z'), entry('claude-haiku-9', '2027-01-02T00:00:00Z')];
  const { made, calls, logs, advance } = catalog(() => ({ ok: true, status: 200, body: { data: newer } }));
  await made.refreshIfStale(creds);
  assert.deepEqual(made.current, { sonnet: 'claude-sonnet-9', haiku: 'claude-haiku-9' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/models?limit=1000');
  assert.equal(calls[0].headers['x-api-key'], 'sk-test');
  assert.match(logs.join('\n'), /newest are Sonnet claude-sonnet-9 and Haiku claude-haiku-9/);

  advance(11 * 3_600_000);
  await made.refreshIfStale(creds);
  assert.equal(calls.length, 1, 'still fresh after 11 hours');
  advance(2 * 3_600_000);
  await made.refreshIfStale(creds);
  assert.equal(calls.length, 2, 'asks again after 12 hours');
});

test('without credentials there is nothing to ask with', async () => {
  const { made, calls } = catalog(() => ({ ok: true, status: 200, body: { data: LIST } }));
  await made.refreshIfStale({ 'anthropic-version': '2023-06-01' });
  assert.equal(calls.length, 0);
  assert.deepEqual(made.current, FALLBACK_MODELS);
});

test('a failed lookup keeps what it had, says so, and waits 15 minutes before trying again', async () => {
  let ok = false;
  const better = [...LIST, entry('claude-sonnet-9', '2027-01-01T00:00:00Z')];
  const { made, calls, logs, advance } = catalog(() => (ok ? { ok: true, status: 200, body: { data: better } } : { ok: false, status: 401 }));
  await made.refreshIfStale(creds);
  assert.deepEqual(made.current, FALLBACK_MODELS);
  assert.match(logs.join('\n'), /could not ask for the newest \(HTTP 401\)/);
  advance(10 * 60_000);
  await made.refreshIfStale(creds);
  assert.equal(calls.length, 1, 'too soon');
  advance(6 * 60_000);
  ok = true;
  await made.refreshIfStale(creds);
  assert.equal(calls.length, 2);
  assert.equal(made.current.sonnet, 'claude-sonnet-9');
});

test('an answer with no Sonnet or no Haiku is not trusted', async () => {
  const { made, logs } = catalog(() => ({ ok: true, status: 200, body: { data: [entry('claude-opus-5-5', '2026-07-01T00:00:00Z')] } }));
  await made.refreshIfStale(creds);
  assert.deepEqual(made.current, FALLBACK_MODELS);
  assert.match(logs.join('\n'), /no Sonnet in the list of 1 models/);
  const garbage = catalog(() => ({ ok: true, status: 200, body: 'not an answer we understand' }));
  await garbage.made.refreshIfStale(creds);
  assert.deepEqual(garbage.made.current, FALLBACK_MODELS);
});

test('the first lookup of a run is waited for, so the very first request already sees the newest', async () => {
  const withHaiku9 = [...LIST, { id: 'claude-haiku-9', created_at: '2027-01-02T00:00:00Z' }];
  const slow = catalog(() => ({ ok: true, status: 200, body: { data: withHaiku9 } }), {
    fetch: async () => {
      await sleep(40);
      return { ok: true, status: 200, json: async () => ({ data: withHaiku9 }) };
    },
  });
  await slow.made.refreshIfStale(creds);
  assert.equal(slow.made.current.haiku, 'claude-haiku-9');
});

test('the last answer is kept on disk, used at once by the next run, and not asked again while fresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  const file = path.join(dir, 'latest_models.json');
  try {
    const better = [...LIST, entry('claude-sonnet-9', '2027-01-01T00:00:00Z')];
    const first = catalog(() => ({ ok: true, status: 200, body: { data: better } }), { storagePath: file, now: () => Date.now() });
    await first.made.refreshIfStale(creds);
    assert.ok(fs.existsSync(file));

    // The next run starts from the file: the newest model is used before any lookup, and a fresh file is not asked about again.
    const refuse = async (): Promise<never> => {
      throw new Error('must not ask');
    };
    const next = new ModelCatalog({ baseUrl: () => 'x', fetch: refuse, storagePath: file, now: () => Date.now() });
    assert.equal(next.current.sonnet, 'claude-sonnet-9');
    await next.refreshIfStale(creds);
    assert.equal(next.current.sonnet, 'claude-sonnet-9');

    // A file that is not ours is ignored.
    fs.writeFileSync(file, '{"nonsense": true}');
    assert.deepEqual(new ModelCatalog({ baseUrl: () => 'x', fetch: refuse, storagePath: file }).current, FALLBACK_MODELS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
