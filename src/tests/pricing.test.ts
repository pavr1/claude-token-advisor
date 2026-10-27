/**
 * Unit tests for the LiteLLM-backed pricing table (3.4): fetching, filtering,
 * caching, staleness, and the dynamic NCU denominator. No real network call —
 * a real ephemeral local server stands in for the feed, same style as
 * `startFakeUpstream` in `proxy.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

import { cacheMultipliers, getPricingTable, loadPricing, modelOutputWeight, modelWeight, resetPricing, usdPerNormalizedUnit } from '../proxy/pricing';

const FAKE_FEED = {
  // Exact id this codebase's own NCU denominator looks up — see sonnetInputUsdPerToken().
  'claude-sonnet-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 0.5e-6,
    cache_creation_input_token_cost: 6.25e-6,
  },
  'claude-haiku-test': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
  },
  // A non-Anthropic entry must be filtered out, same as _extract_anthropic_pricing() does.
  'gpt-test': {
    litellm_provider: 'openai',
    input_cost_per_token: 999,
    output_cost_per_token: 999,
  },
};

async function startFakeFeed(payload: unknown = FAKE_FEED): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'improver-pricing-'));
}

test.beforeEach(() => resetPricing());

test('loadPricing fetches from the feed, filters to Anthropic, and resolves real weights', async () => {
  const feed = await startFakeFeed();
  const dir = tempDir();

  const result = await loadPricing(dir, feed.url);

  assert.equal(result.ok, true);
  assert.equal(getPricingTable().source, 'remote');
  // The exact 'claude-sonnet-5' entry becomes the NCU denominator.
  assert.equal(usdPerNormalizedUnit(), 5e-6);
  assert.ok(Math.abs(modelWeight('claude-haiku-test') - 1e-6 / 5e-6) < 1e-9);
  assert.ok(Math.abs(modelOutputWeight('claude-sonnet-5') - 25e-6 / 5e-6) < 1e-9);
  // The non-Anthropic entry never made it into the table, so it resolves via the
  // 'unknown' tier fallback (3e-6) instead of the feed's (bogus, for this test) 999.
  assert.ok(Math.abs(modelWeight('gpt-test') - 3e-6 / 5e-6) < 1e-9);

  await feed.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh cache is reused without a second network call', async () => {
  const feed = await startFakeFeed();
  const dir = tempDir();
  await loadPricing(dir, feed.url);
  await feed.close(); // torn down — a second fetch attempt would fail

  resetPricing();
  const result = await loadPricing(dir, 'http://127.0.0.1:1'); // reserved, refuses connections
  assert.equal(result.ok, true);
  assert.equal(getPricingTable().source, 'cache');
  assert.ok(Math.abs(modelWeight('claude-haiku-test') - 1e-6 / 5e-6) < 1e-9);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale cache is skipped when the feed is reachable', async () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'model_pricing_cache.json'),
    JSON.stringify({ savedAt: Date.now() - 8 * 24 * 3600 * 1000, rates: { stale: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }),
    'utf8'
  );

  const feed = await startFakeFeed();
  const result = await loadPricing(dir, feed.url);

  assert.equal(result.ok, true);
  assert.equal(getPricingTable().source, 'remote');
  assert.equal(usdPerNormalizedUnit(), 5e-6);

  await feed.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale cache is used anyway when the feed is unreachable', async () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'model_pricing_cache.json'),
    JSON.stringify({
      savedAt: Date.now() - 8 * 24 * 3600 * 1000,
      rates: { 'claude-sonnet-5': { input: 7e-6, output: 35e-6, cacheRead: 0, cacheWrite: 0 } },
    }),
    'utf8'
  );

  const result = await loadPricing(dir, 'http://127.0.0.1:1');

  assert.equal(result.ok, false);
  assert.equal(getPricingTable().source, 'stale_cache');
  assert.equal(usdPerNormalizedUnit(), 7e-6);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('total failure (no cache, no network) falls back to the published tier rates', async () => {
  const dir = tempDir();

  const result = await loadPricing(dir, 'http://127.0.0.1:1');

  assert.equal(result.ok, false);
  assert.equal(getPricingTable().source, 'fallback');
  assert.equal(modelWeight('claude-sonnet-5'), 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('model ids resolve exactly, then by the longest shared prefix, then by tier', async () => {
  const feed = await startFakeFeed({
    'claude-sonnet-5': { litellm_provider: 'anthropic', input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 },
    'claude-haiku-5': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    'claude-haiku-5-20260101': { litellm_provider: 'anthropic', input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
  });
  const dir = tempDir();
  await loadPricing(dir, feed.url);

  // Exact match, case-insensitive.
  assert.ok(Math.abs(modelWeight('CLAUDE-HAIKU-5') - 1 / 3) < 1e-9);
  // A dated id the feed lacks resolves to the longest key it shares a prefix with.
  assert.ok(Math.abs(modelWeight('claude-haiku-5-20260101-extra') - 2 / 3) < 1e-9);
  // A generic family query resolves against the specific keys, longest first.
  assert.ok(Math.abs(modelWeight('claude-haiku') - 2 / 3) < 1e-9);
  // No match in the table: the published tier for the family; no id at all: the unknown tier.
  assert.ok(Math.abs(modelWeight('claude-opus-9') - 15 / 3) < 1e-9);
  assert.equal(modelWeight(undefined), 1);
  assert.equal(modelWeight('something-else'), 1);

  await feed.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('feed entries without usable input or output prices are dropped, and a feed with none is a failure', async () => {
  const feed = await startFakeFeed({
    'claude-sonnet-5': { litellm_provider: 'anthropic', input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 },
    'claude-free': { litellm_provider: 'anthropic', input_cost_per_token: 0, output_cost_per_token: 1e-6 },
    'claude-text': { litellm_provider: 'anthropic', input_cost_per_token: '3e-6', output_cost_per_token: 1e-6 },
    'claude-null': null,
    'claude-str': 'x',
  });
  const dir = tempDir();
  await loadPricing(dir, feed.url);
  assert.deepEqual(Object.keys(getPricingTable().rates), ['claude-sonnet-5']);
  await feed.close();

  for (const payload of [[], 'text', null, { only: { litellm_provider: 'openai' } }]) {
    resetPricing();
    const bad = await startFakeFeed(payload);
    const result = await loadPricing(tempDir(), bad.url);
    assert.equal(result.ok, false);
    assert.equal(getPricingTable().source, 'fallback');
    await bad.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a feed that answers with an error status or invalid JSON is treated as unreachable', async () => {
  for (const respond of [
    (res: http.ServerResponse) => {
      res.statusCode = 500;
      res.end('{}');
    },
    (res: http.ServerResponse) => res.end('<html>not json'),
  ]) {
    const server = http.createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    resetPricing();
    const result = await loadPricing(tempDir(), `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(result.ok, false);
    assert.match(result.detail, /no cache exists/);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a feed that never answers times out instead of hanging activation', async () => {
  const server = http.createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  const result = await loadPricing(tempDir(), `http://127.0.0.1:${(server.address() as AddressInfo).port}`, 100);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 3_000);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('the 1 hour write rate is read from the feed, and the cache file round-trips it', async () => {
  const feed = await startFakeFeed({
    'claude-sonnet-5': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost_above_1hr: 6e-6,
    },
  });
  const dir = tempDir();
  await loadPricing(dir, feed.url);
  assert.equal(getPricingTable().rates['claude-sonnet-5'].cacheWrite1h, 6e-6);
  await feed.close();

  resetPricing();
  const again = await loadPricing(dir, 'http://127.0.0.1:1');
  assert.match(again.detail, /cached pricing/);
  assert.equal(getPricingTable().rates['claude-sonnet-5'].cacheWrite1h, 6e-6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable cache file counts as no cache, and an unwritable cache dir does not fail pricing', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'model_pricing_cache.json'), '{ broken');
  const feed = await startFakeFeed();
  const result = await loadPricing(dir, feed.url);
  assert.equal(result.ok, true);
  assert.equal(getPricingTable().source, 'remote');

  // The storage "directory" is a file, so creating the cache fails; the fetched table stays active.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  resetPricing();
  const second = await loadPricing(path.join(blocker, 'sub'), feed.url);
  assert.equal(second.ok, true);
  assert.equal(getPricingTable().source, 'remote');

  await feed.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cacheMultipliers come from the table per model, and a kind the table lacks is unpriced, never guessed', async () => {
  const feed = await startFakeFeed({
    'claude-sonnet-5': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 4e-6,
      output_cost_per_token: 20e-6,
      cache_read_input_token_cost: 0.8e-6,
      cache_creation_input_token_cost: 5e-6,
    },
  });
  const dir = tempDir();
  // The server and the temp dir are closed even when an assertion fails; an open server keeps the test process alive.
  try {
    await loadPricing(dir, feed.url);
    const m = cacheMultipliers('claude-sonnet-5');
    assert.ok(Math.abs(m.read - 0.2) < 1e-9 && Math.abs(m.write - 1.25) < 1e-9);
    assert.equal(m.write1h, 0, 'no 1h rate published: nothing is invented');
    assert.deepEqual(m.unpriced, ['write1h']);

    resetPricing();
    const unknown = cacheMultipliers(undefined);
    assert.ok(Math.abs(unknown.read - 0.1) < 1e-9 && Math.abs(unknown.write - 1.25) < 1e-9 && unknown.write1h === 2);
  } finally {
    await feed.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
