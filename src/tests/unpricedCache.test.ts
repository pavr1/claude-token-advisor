/** A cache rate the pricing table does not have is never guessed: the tokens count, the units do not, and the panel says so. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { aggregate, LedgerEntry, unpricedKinds } from '../analytics/tracker';
import { estimateCompactionEconomics } from '../proxy/optimizer';
import { cacheMultipliers, getPricingTable, resetPricing } from '../proxy/pricing';
import { ALL, buildAnalyticsSectionHtml } from '../ui/analyticsPanel';
import { historyChartsHtml } from '../ui/historyChart';
import { AnalyticsTracker } from '../analytics/tracker';

const MODEL = 'claude-test-model-9';

/** A table that knows this model's input and output price but not its cache rates. */
function priceModelWithoutCacheRates(): void {
  resetPricing();
  getPricingTable().rates[MODEL] = { input: 2e-6, output: 1e-5, cacheRead: 0, cacheWrite: 0 };
}

afterEach(() => resetPricing());

function hit(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    project: 'repo',
    requestedModel: MODEL,
    servedModel: MODEL,
    modelSwapped: false,
    rawTokens: 1000,
    optimizedTokens: 1000,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    compactionTriggered: false,
    cacheAnchorPlaced: true,
    newUserTurn: true,
    uncachedInputTokens: 2,
    cacheWriteTokens: 500,
    cacheReadTokens: 100_000,
    outputTokens: 9,
    baselineUnitCost: 1,
    actualUnitCost: 1,
    cacheNoCacheUnitCost: 0,
    cacheActualUnitCost: 0,
    savingsPercent: 0,
    status: 200,
    ...over,
  } as LedgerEntry;
}

test('a rate the table lacks is reported as unpriced, not replaced by a constant', () => {
  priceModelWithoutCacheRates();
  const rates = cacheMultipliers(MODEL);
  assert.deepEqual(rates.unpriced, ['read', 'write', 'write1h']);
  assert.equal(rates.read, 0);
  assert.equal(rates.write, 0);
});

test('a model with every rate has no unpriced list', () => {
  resetPricing();
  assert.equal(cacheMultipliers('claude-sonnet-5').unpriced, undefined);
});

test('only the kinds the hit used count as unpriced', () => {
  priceModelWithoutCacheRates();
  assert.deepEqual(unpricedKinds(hit({ cacheWriteTokens: 0 })), ['read']);
  assert.deepEqual(unpricedKinds(hit({ cacheReadTokens: 0, cacheWriteTokens: 5 })), ['write']);
  assert.deepEqual(unpricedKinds(hit({ cacheReadTokens: 0, cacheWriteTokens: 0 })), []);
});

test('unpriced tokens stay in t, add no u, and the aggregate names the model', () => {
  priceModelWithoutCacheRates();
  const stats = aggregate([hit()]);
  assert.equal(stats.cacheReadTokens, 100_000);
  assert.equal(stats.cacheReadUnits, 0);
  assert.deepEqual(stats.unpriced.read, [MODEL]);
  assert.deepEqual(stats.unpriced.write, [MODEL]);
});

test('a row that stored its rates keeps them even if the table later loses them', () => {
  resetPricing();
  const stored = { ...hit(), servedModel: 'claude-sonnet-5', cacheMultipliers: { read: 0.1, write: 1.25, write1h: 2 } };
  const stats = aggregate([stored]);
  assert.equal(stats.unpriced.read.length, 0);
  assert.ok(stats.cacheReadUnits > 0);
});

test('the panel tooltip and the history chart say the rate was not found', () => {
  priceModelWithoutCacheRates();
  const entries = [hit()];
  const html = buildAnalyticsSectionHtml({ getEntries: () => entries } as unknown as AnalyticsTracker, { project: ALL, range: 'today' });
  assert.match(html, new RegExp(`No rate for ${MODEL}: counted in t, adds no u`));
  assert.match(html, /⚠ rate not found/);

  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const charts = historyChartsHtml(entries, { start, end: start + 86_400_000 }, at);
  assert.match(charts, new RegExp(`CR: no rate for ${MODEL}, adds no u`));
});

test('compaction is not estimated, so not started, while the cache rates are unknown', () => {
  priceModelWithoutCacheRates();
  const economics = estimateCompactionEconomics({ olderTokens: 50_000, keptTokens: 10_000, cacheWarm: false, expectedRequests: 5, model: MODEL });
  assert.equal(economics.savings, 0);
  assert.ok(economics.net <= 0);
});
