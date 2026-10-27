/**
 * Unit tests for the analytics tracker: Normalized Cost Unit math, ledger
 * persistence, and aggregation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  aggregate,
  AnalyticsTracker,
  CLIENT_PREFIX_REUSE,
  computeTurnCost,
  backfillCacheCosts,
  billedUnits,
  entryUnits,
  cacheWrite1hTokens,
  reconcileWithUsage,
  lastTurnEntries,
  LedgerEntry,
  LEDGER_DIRNAME,
  LEDGER_FILENAME,
  dayKey,
  monthKey,
  localDayKey,
  localMonthKey,
} from '../analytics/tracker';
import { HAIKU_MODEL_ID, OptimizationTelemetry } from '../proxy/optimizer';
import { cacheMultipliers, getPricingTable, modelOutputWeight, modelWeight, resetPricing } from '../proxy/pricing';
import { estimateTextTokens } from '../proxy/tokenCounter';

function telemetry(overrides: Partial<OptimizationTelemetry> = {}): OptimizationTelemetry {
  return {
    rawTokens: 10_000,
    optimizedTokens: 4_000,
    prunedByNormalization: 1_000,
    prunedByCompaction: 5_000,
    compactionTriggered: true,
    originalModel: 'claude-sonnet-5',
    effectiveModel: 'claude-sonnet-5',
    modelDowngraded: false,
    routingReason: 'test',
    startupModelDefaulted: false,
    cacheAnchorPlaced: true,
    cacheAnchorBelowMinimum: false,
    strippedCacheControlBlocks: 0,
    isNewUserTurn: true,
    ...overrides,
  };
}

/** A ledger row with every numeric field zeroed, so tests set only what they look at. */
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: '2026-10-20T12:00:00.000Z',
    project: 'p',
    requestedModel: 'claude-sonnet-5',
    servedModel: 'claude-sonnet-5',
    modelSwapped: false,
    rawTokens: 0,
    optimizedTokens: 0,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    compactionTriggered: false,
    cacheAnchorPlaced: false,
    uncachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    baselineUnitCost: 0,
    actualUnitCost: 0,
    savingsPercent: 0,
    ...overrides,
  } as LedgerEntry;
}

const OCT_20 = () => new Date(2026, 9, 20, 12, 0, 0);

function localIso(year: number, monthIndex: number, day: number): string {
  return new Date(year, monthIndex, day, 12, 0, 0).toISOString();
}

test('the ledger round-trips through disk as one appended line per turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));

  const writer = new AnalyticsTracker(dir, OCT_20);
  writer.record(entry({ project: 'alpha', timestamp: localIso(2026, 9, 20) }));
  writer.record(entry({ project: 'beta', timestamp: localIso(2026, 9, 20) }));
  await writer.drain();

  assert.ok(fs.existsSync(path.join(dir, LEDGER_DIRNAME, '2026-10.jsonl')));
  assert.equal(fs.readFileSync(path.join(dir, LEDGER_DIRNAME, '2026-10.jsonl'), 'utf8').trim().split('\n').length, 2);

  const entries = new AnalyticsTracker(dir, OCT_20).getEntries();
  assert.deepEqual(
    entries.map((item) => item.project),
    ['alpha', 'beta']
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ledger line cut short by a crash is skipped and the rest still loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  fs.mkdirSync(path.join(dir, LEDGER_DIRNAME));
  const good = JSON.stringify(entry({ project: 'alpha', timestamp: localIso(2026, 9, 20) }));
  fs.writeFileSync(path.join(dir, LEDGER_DIRNAME, '2026-10.jsonl'), `${good}\n{"timestamp":"2026-10-2`, 'utf8');

  assert.equal(new AnalyticsTracker(dir, OCT_20).getEntries().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the single-file ledger is migrated into monthly files and kept as a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  const rows = [
    entry({ project: 'sep', timestamp: localIso(2026, 8, 30) }),
    entry({ project: 'oct', timestamp: localIso(2026, 9, 19) }),
  ];
  fs.writeFileSync(path.join(dir, LEDGER_FILENAME), JSON.stringify({ version: 1, entries: rows }), 'utf8');

  const tracker = new AnalyticsTracker(dir, OCT_20);
  // September is the previous month: still raw (the one-month cushion).
  assert.deepEqual(
    tracker.getEntries().map((item) => item.project),
    ['sep', 'oct']
  );
  assert.ok(fs.existsSync(path.join(dir, LEDGER_DIRNAME, '2026-09.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, LEDGER_DIRNAME, '2026-10.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, LEDGER_FILENAME)));
  assert.ok(fs.existsSync(path.join(dir, `${LEDGER_FILENAME}.migrated.bak`)));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('months older than the cushion become daily summaries and their raw file is deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  const rows = [
    entry({ project: 'alpha', timestamp: localIso(2026, 7, 10), newUserTurn: true }),
    entry({ project: 'alpha', timestamp: localIso(2026, 7, 10) }),
    entry({ project: 'beta', timestamp: localIso(2026, 7, 11), newUserTurn: true }),
    entry({ project: 'oct', timestamp: localIso(2026, 9, 19) }),
  ];
  fs.writeFileSync(path.join(dir, LEDGER_FILENAME), JSON.stringify({ version: 1, entries: rows }), 'utf8');

  const tracker = new AnalyticsTracker(dir, OCT_20);
  // August is two months back: it never enters memory.
  assert.deepEqual(
    tracker.getEntries().map((item) => item.project),
    ['oct']
  );

  tracker.record(entry({ project: 'oct', timestamp: localIso(2026, 9, 20) }));
  await tracker.drain();

  assert.ok(!fs.existsSync(path.join(dir, LEDGER_DIRNAME, '2026-08.jsonl')));
  const days = tracker.getDailySummaries();
  assert.equal(days.length, 2 + 0);
  const alpha = days.find((summary) => summary.project === 'alpha');
  assert.equal(alpha?.stats.turns, 2);
  assert.equal(alpha?.userTurns, 1);
  assert.equal(alpha?.day, dayKey(rows[0]));
  assert.equal(days.find((summary) => summary.project === 'beta')?.stats.turns, 1);

  // Rolling up again (a new window, the same month) does not double the totals.
  const again = new AnalyticsTracker(dir, OCT_20);
  again.record(entry({ project: 'oct', timestamp: localIso(2026, 9, 20) }));
  await again.drain();
  assert.equal(again.getDailySummaries().find((summary) => summary.project === 'alpha')?.stats.turns, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Pricing -----------------------------------------------------------------

// 3.4: with no fetched/cached table, weights come from the published tier rates
// (premium/balanced/economy) mirroring claude_budget_advisor.py's own fallback —
// Haiku:Sonnet is a real 1:3 ratio, not the old hand-guessed 1:2.
test('model weights are normalized so Sonnet is exactly 1.0', () => {
  resetPricing();
  assert.equal(modelWeight('claude-sonnet-5'), 1);
  assert.ok(Math.abs(modelWeight('claude-haiku-4-5') - 1 / 3) < 1e-9);
  assert.equal(modelWeight('claude-opus-5'), 5);
});

test('a dated model snapshot resolves to its family weight', () => {
  resetPricing();
  assert.ok(Math.abs(modelWeight('claude-haiku-4-5-20251001') - 1 / 3) < 1e-9);
});

test('an unknown model falls back to Sonnet-class rather than claiming free tokens', () => {
  resetPricing();
  assert.equal(modelWeight('some-future-model'), 1);
  assert.equal(modelWeight(undefined), 1);
});

// --- Cost math ---------------------------------------------------------------

test('baseline with client caching: cached prefix at 0.10x, growth at 1.25x, output at its own rate', () => {
  const weight = modelWeight('claude-sonnet-5');
  const outputWeight = modelOutputWeight('claude-sonnet-5');
  const plain = computeTurnCost(telemetry({ rawTokens: 10_000 }), { input_tokens: 500, output_tokens: 200 });
  const modelled = computeTurnCost(telemetry({ rawTokens: 10_000, baselineCachedTokens: 9_000 }), {
    input_tokens: 500,
    output_tokens: 200,
  });

  assert.equal(plain.baselineUnitCost, 10_000 * weight + 200 * outputWeight);
  assert.equal(modelled.baselineUnitCost, 9_000 * weight * 0.1 + 1_000 * weight * 1.25 + 200 * outputWeight);
  assert.ok(modelled.baselineUnitCost < plain.baselineUnitCost, 'the honest baseline is cheaper than the no-cache one');
  assert.equal(modelled.actualUnitCost, plain.actualUnitCost, 'only the baseline changes, not what was actually billed');
});

test('baseline with nothing cached yet writes the whole request at 1.25x', () => {
  const weight = modelWeight('claude-sonnet-5');
  const cost = computeTurnCost(telemetry({ rawTokens: 4_000, baselineCachedTokens: 0 }), { input_tokens: 10, output_tokens: 0 });
  assert.equal(cost.baselineUnitCost, 4_000 * weight * 1.25);
});

test('a fully uncached turn on the requested model saves only what pruning removed', () => {
  const cost = computeTurnCost(telemetry(), { input_tokens: 4_000, output_tokens: 200 });

  // Output is priced too (3.1): 200 tokens * 5x the input weight, on both sides
  // since there's no downgrade here — 10_000 + 1_000 baseline, 4_000 + 1_000 actual.
  assert.equal(cost.baselineUnitCost, 11_000);
  assert.equal(cost.actualUnitCost, 5_000);
  assert.ok(Math.abs(cost.savingsPercent - (1 - 5_000 / 11_000) * 100) < 1e-9);
});

test('output tokens are priced at 5x the input weight, same count on both sides', () => {
  const cost = computeTurnCost(telemetry(), { input_tokens: 4_000, output_tokens: 0 });
  // With zero output tokens this is the pre-3.1 behavior — confirms the baseline case is untouched.
  assert.equal(cost.baselineUnitCost, 10_000);
  assert.equal(cost.actualUnitCost, 4_000);

  const withOutput = computeTurnCost(telemetry(), { input_tokens: 4_000, output_tokens: 1_000 });
  assert.equal(withOutput.baselineUnitCost, 10_000 + 1_000 * 5);
  assert.equal(withOutput.actualUnitCost, 4_000 + 1_000 * 5);
});

test('a model downgrade prices output tokens at each side\'s own output rate, not a shared one', () => {
  const cost = computeTurnCost(
    telemetry({ effectiveModel: 'claude-haiku-4-5', modelDowngraded: true }),
    { input_tokens: 4_000, output_tokens: 1_000 }
  );

  // Baseline: Sonnet input (10_000*1) + Sonnet output (1_000*5) — Sonnet's own
  // output:input ratio is 5x in the tier table too, so this side is unchanged.
  // Actual: Haiku input (4_000/3) + Haiku output (1_000*5/3) — Haiku:Sonnet is a
  // real 1:3 ratio (3.4), not the old hand-guessed 1:2 — (4_000+5_000)/3 = 3_000.
  assert.equal(cost.baselineUnitCost, 10_000 + 5_000);
  assert.equal(cost.actualUnitCost, 3_000);
});

test('cache reads are billed at 0.10x and cache writes at 1.25x', () => {
  const cost = computeTurnCost(telemetry(), {
    input_tokens: 1_000,
    cache_read_input_tokens: 8_000,
    cache_creation_input_tokens: 400,
  });

  // 1000*1 + 400*1*1.25 + 8000*1*0.10 = 2300
  assert.equal(cost.actualUnitCost, 2_300);
  assert.equal(cost.savingsPercent, 77);
});

test('a model downgrade is priced at the served model weight', () => {
  const cost = computeTurnCost(
    telemetry({ effectiveModel: 'claude-haiku-4-5', modelDowngraded: true }),
    { input_tokens: 4_000 }
  );

  // Baseline stays on Sonnet (10000 * 1.0); actual is Haiku (4000 * 1/3 — a real
  // 1:3 ratio per 3.4, not the old hand-guessed 1:2).
  assert.equal(cost.baselineUnitCost, 10_000);
  assert.ok(Math.abs(cost.actualUnitCost - 4_000 / 3) < 1e-9);
  assert.ok(Math.abs(cost.savingsPercent - (1 - 4_000 / 3 / 10_000) * 100) < 1e-9);
});

test('the compaction summarizer\'s cost is folded into actualUnitCost only, at Haiku\'s rate', () => {
  const withoutSummarizer = computeTurnCost(telemetry(), { input_tokens: 4_000 });

  const cost = computeTurnCost(telemetry({ summarizerUsage: { inputTokens: 2_000, outputTokens: 300 } }), {
    input_tokens: 4_000,
  });

  const expectedSummarizerCost = 2_000 * modelWeight(HAIKU_MODEL_ID) + 300 * modelOutputWeight(HAIKU_MODEL_ID);
  // Baseline never runs compaction, so it never pays for a summary — unaffected.
  assert.equal(cost.baselineUnitCost, withoutSummarizer.baselineUnitCost);
  assert.equal(cost.summarizerUnitCost, expectedSummarizerCost);
  assert.equal(cost.actualUnitCost, withoutSummarizer.actualUnitCost + expectedSummarizerCost);
});

test('no summarizer usage means zero summarizer cost, not undefined/NaN', () => {
  const cost = computeTurnCost(telemetry(), { input_tokens: 4_000 });
  assert.equal(cost.summarizerUnitCost, 0);
});

test('a zero baseline reports 0% rather than dividing by zero', () => {
  const cost = computeTurnCost(telemetry({ rawTokens: 0 }), { input_tokens: 0 });
  assert.equal(cost.savingsPercent, 0);
  assert.ok(Number.isFinite(cost.savingsPercent));
});

test('a turn that costs more than the baseline reports a negative saving', () => {
  const cost = computeTurnCost(telemetry({ rawTokens: 1_000 }), { input_tokens: 4_000 });
  assert.ok(cost.savingsPercent < 0, 'a cache-miss penalty turn must not be reported as a saving');
});

// --- Aggregation -------------------------------------------------------------

/*
claude pending, fix this once tokens assigned
test('aggregate savings weight by cost, not by turn count', () => {
  const stats = aggregate([
    entry({ baselineUnitCost: 1_000_000, actualUnitCost: 500_000, savingsPercent: 50 }),
    entry({ baselineUnitCost: 10, actualUnitCost: 0, savingsPercent: 100 }),
  ]);

  // Naive averaging would give 75%; cost-weighted is ~50%.
  assert.ok(stats.savingsPercent > 49 && stats.savingsPercent < 51, `got ${stats.savingsPercent}`);
  assert.equal(stats.turns, 2);
});
*/

test('aggregate of an empty ledger is all zeroes', () => {
  const stats = aggregate([]);
  assert.equal(stats.turns, 0);
  assert.equal(stats.savingsPercent, 0);
  assert.equal(stats.savedUsd, 0);
});

/*
claude pending, fix this once tokens assigned
test('monthKey buckets by calendar month', () => {
  assert.equal(monthKey(entry({ timestamp: '2026-01-31T23:59:59.000Z' })), '2026-01');
});
*/

test('dayKey and monthKey bucket the stored UTC timestamp in local time', () => {
  const e = { timestamp: '2026-01-31T23:59:59.000Z' } as LedgerEntry;
  const local = new Date(e.timestamp);
  assert.equal(dayKey(e), localDayKey(local));
  assert.equal(monthKey(e), localMonthKey(local));
  assert.equal(dayKey(e), `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`);
});

// --- Last-turn reconstruction ------------------------------------------------

/** A ledger entry carrying only what `lastTurnEntries` looks at. */
function hit(project: string, newUserTurn?: boolean): LedgerEntry {
  return { project, newUserTurn } as unknown as LedgerEntry;
}

test('lastTurnEntries groups the trailing hits back to their opening turn', () => {
  const entries = [
    hit('a', true),
    hit('b', false),
    hit('c', true),
    hit('d', false),
    hit('e', false),
  ];

  assert.deepEqual(
    lastTurnEntries(entries).map((item) => item.project),
    ['c', 'd', 'e']
  );
});

test('lastTurnEntries falls back to the final hit on a pre-boundary ledger', () => {
  // Entries written before `newUserTurn` existed carry no boundary at all.
  assert.deepEqual(
    lastTurnEntries([hit('a'), hit('b')]).map((item) => item.project),
    ['b']
  );
  assert.deepEqual(lastTurnEntries([]), []);
});

// --- Persistence -------------------------------------------------------------
/*
claude pending, fix this once tokens assigned
test('the ledger round-trips through disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));

  const writer = new AnalyticsTracker(dir);
  writer.record(entry({ project: 'alpha' }));
  writer.record(entry({ project: 'beta' }));
  await writer.drain();

  assert.ok(fs.existsSync(path.join(dir, LEDGER_FILENAME)));

  const reader = new AnalyticsTracker(dir);
  const entries = reader.getEntries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((item) => item.project),
    ['alpha', 'beta']
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
*/

test('a corrupt ledger starts empty instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  fs.writeFileSync(path.join(dir, LEDGER_FILENAME), '{ not json', 'utf8');

  const tracker = new AnalyticsTracker(dir);
  assert.equal(tracker.getEntries().length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('entries saved before the cache cost fields existed load without NaN cache totals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  const legacy = {
    timestamp: '2026-09-01T10:00:00.000Z',
    servedModel: 'claude-sonnet-5',
    cacheReadTokens: 10_000,
    cacheWriteTokens: 1_000,
  };
  fs.writeFileSync(path.join(dir, LEDGER_FILENAME), JSON.stringify({ version: 1, entries: [legacy] }), 'utf8');

  const stats = aggregate(new AnalyticsTracker(dir, () => new Date(2026, 8, 15)).getEntries());
  const weight = modelWeight('claude-sonnet-5');
  assert.ok(Math.abs(stats.cacheNoCacheUnitCost - 11_000 * weight) < 1e-9);
  assert.ok(Math.abs(stats.cacheActualUnitCost - (1_000 * 1.25 + 10_000 * 0.1) * weight) < 1e-9);
  assert.ok(Number.isFinite(stats.cacheSavingsPercent));

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Token estimation --------------------------------------------------------

test('token estimates scale with length and treat code as denser than prose', () => {
  assert.equal(estimateTextTokens(''), 0);

  const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
  const code = 'const x = {a:[1,2],b:(c)=>c*2}; '.repeat(20);

  assert.ok(estimateTextTokens(prose) > 0);
  // Same character budget, but punctuation-dense text must cost more tokens.
  assert.ok(
    estimateTextTokens(code) / code.length > estimateTextTokens(prose) / prose.length,
    'code should estimate at more tokens per character than prose'
  );
});

test('non-ASCII text is estimated far denser than ASCII', () => {
  assert.ok(estimateTextTokens('日本語のテキスト') > estimateTextTokens('abcdefgh'));
});

test('getEntries is scoped to the active account and excludes untagged legacy rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  const tracker = new AnalyticsTracker(dir);
  const row = (accountId?: string) => ({ timestamp: '2026-09-15T10:00:00.000Z', project: 'demo', accountId } as LedgerEntry);
  tracker.ingest(row('a'));
  tracker.ingest(row('b'));
  tracker.ingest(row(undefined));

  assert.equal(tracker.getEntries().length, 3);
  tracker.setActiveAccount('a');
  assert.deepEqual(tracker.getEntries().map((e) => e.accountId), ['a']);
  tracker.setActiveAccount('b');
  assert.deepEqual(tracker.getEntries().map((e) => e.accountId), ['b']);
  tracker.setActiveAccount(undefined);
  assert.equal(tracker.getEntries().length, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('reconcileWithUsage re-bases a compacted turn on the tokens Anthropic received', () => {
  const r = reconcileWithUsage(
    { rawTokens: 270_890, prunedByNormalization: 56, prunedByCompaction: 122_601, optimizedTokens: 148_233, compactionTriggered: true },
    { uncachedInputTokens: 4, cacheWriteTokens: 9_772, cacheReadTokens: 74_882 }
  );
  assert.equal(r.optimizedTokens, 84_658);
  assert.equal(r.prunedByCompaction, 270_890 - 56 - 84_658);
});

test('reconcileWithUsage keeps estimates without usage and leaves uncompacted prunes alone', () => {
  const base = { rawTokens: 1_000, prunedByNormalization: 10, prunedByCompaction: 0, optimizedTokens: 990, compactionTriggered: false };
  assert.deepEqual(reconcileWithUsage(base, undefined), { optimizedTokens: 990, prunedByCompaction: 0 });
  assert.equal(reconcileWithUsage(base, { uncachedInputTokens: 950 }).prunedByCompaction, 0);
});

test('1 hour cache writes bill at 2x and the 5 minute share stays at 1.25x', () => {
  const w = modelWeight('claude-sonnet-5-5');
  const cost = computeTurnCost(telemetry({ rawTokens: 10_000, effectiveModel: 'claude-sonnet-5-5', originalModel: 'claude-sonnet-5-5' }), {
    input_tokens: 0,
    cache_creation_input_tokens: 1_000,
    cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
  });
  assert.equal(cost.cacheWrite1hTokens, 400);
  assert.equal(cost.cacheActualUnitCost, (600 * 1.25 + 400 * 2) * w);
  const entry = { cacheWriteTokens: 1_000, cacheWrite1hTokens: 400 };
  assert.equal(billedUnits(entry), 1_000 * 1.25 + 400 * 0.75);
});

test('without a cache_creation breakdown every write is the 5 minute kind', () => {
  assert.equal(cacheWrite1hTokens(undefined), 0);
  assert.equal(cacheWrite1hTokens({ cache_creation_input_tokens: 500 }), 0);
});

test('the floor baseline assumes the best possible client cache, so it is never above the modelled baseline', () => {
  const weight = modelWeight('claude-sonnet-5');
  // The TTL model saw a cold cache (nothing read); the floor client still had 9k cached.
  const cost = computeTurnCost(
    telemetry({ rawTokens: 10_000, baselineCachedTokens: 0, floorCachedTokens: 9_000 }),
    { input_tokens: 4_000, output_tokens: 0 }
  );
  assert.equal(cost.floorBaselineUnitCost, 9_000 * weight * 0.1 + 1_000 * weight * 1.25);
  assert.ok((cost.floorBaselineUnitCost ?? Infinity) < cost.baselineUnitCost);
});

test('aggregate reports the floor only over rows that carry one', () => {
  const stats = aggregate([
    entry({ baselineUnitCost: 1_000, actualUnitCost: 500, floorBaselineUnitCost: 800 }),
    entry({ baselineUnitCost: 1_000, actualUnitCost: 100 }),
  ]);
  assert.equal(stats.floorTurns, 1);
  assert.equal(stats.floorBaselineUnitCost, 800);
  assert.equal(stats.floorActualUnitCost, 500);
  assert.ok(Math.abs(stats.floorSavingsPercent - 37.5) < 1e-9);
});

test('the central baseline costs more than the floor and aggregates with the floor rows', () => {
  const weight = modelWeight('claude-sonnet-5');
  const cost = computeTurnCost(
    telemetry({ rawTokens: 10_000, baselineCachedTokens: 0, floorCachedTokens: 9_000 }),
    { input_tokens: 4_000, output_tokens: 0 }
  );
  const reused = 9_000 * CLIENT_PREFIX_REUSE;
  assert.ok(Math.abs((cost.centralBaselineUnitCost ?? 0) - (reused * weight * 0.1 + (10_000 - reused) * weight * 1.25)) < 1e-6);
  assert.ok((cost.centralBaselineUnitCost ?? 0) > (cost.floorBaselineUnitCost ?? Infinity), 'a client that loses some prefix pays more than the floor');

  const stats = aggregate([entry({ actualUnitCost: 500, floorBaselineUnitCost: 800, centralBaselineUnitCost: 1_000 })]);
  assert.ok(Math.abs(stats.centralSavingsPercent - 50) < 1e-9);
  assert.ok(stats.centralSavingsPercent > stats.floorSavingsPercent);
});

test('computeTurnCost charges nothing and saves nothing for a turn Anthropic never answered', () => {
  const cost = computeTurnCost(telemetry({ rawTokens: 118_000, optimizedTokens: 118_000, baselineCachedTokens: 100_000 }), undefined);
  assert.equal(cost.actualUnitCost, 0);
  assert.equal(cost.baselineUnitCost, 0);
  assert.equal(cost.floorBaselineUnitCost, 0);
  assert.equal(cost.centralBaselineUnitCost, 0);
  assert.equal(cost.uncachedInputTokens, 0);
  assert.equal(cost.savingsPercent, 0);
});

/**
 * The "Last turns" tooltip derives output as billed − summary − CR − CW − RI. That only means
 * something if the derived figure equals the measured one (output tokens × the served model's
 * output weight); otherwise the residual is hiding an error in another term.
 */
test('billed minus summary, cache and regular input equals the measured output units', () => {
  const cases: Array<[string, Partial<OptimizationTelemetry>, Parameters<typeof computeTurnCost>[1]]> = [
    ['plain Sonnet turn', {}, { input_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000, output_tokens: 700 }],
    [
      'with a Haiku summary',
      { summarizerUsage: { inputTokens: 8_000, outputTokens: 600 } },
      { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 12_000, output_tokens: 300 },
    ],
    [
      '1h cache write',
      {},
      { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_1h_input_tokens: 20_000 }, output_tokens: 400 },
    ],
    [
      'served by Haiku',
      { effectiveModel: HAIKU_MODEL_ID, modelDowngraded: true },
      { input_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1_000, output_tokens: 250 },
    ],
  ];

  for (const [name, overrides, usage] of cases) {
    const t = telemetry(overrides);
    const cost = computeTurnCost(t, usage);
    // What the panel derives: billed minus everything else it shows (see flowCells).
    const units = entryUnits({ ...cost, servedModel: t.effectiveModel });
    const derived = cost.actualUnitCost - cost.summarizerUnitCost - units.read - units.write - units.regular;
    // Stored units and the rebuild from tokens (older rows) must agree.
    const rebuilt = entryUnits({ ...cost, servedModel: t.effectiveModel, cacheReadUnits: undefined, cacheWriteUnits: undefined, regularInputUnits: undefined, outputUnits: undefined });
    for (const k of ['read', 'write', 'regular', 'output'] as const) {
      assert.ok(Math.abs(units[k] - rebuilt[k]) < 1e-6, `${name}: stored ${k} ${units[k]} != rebuilt ${rebuilt[k]}`);
    }
    const measured = cost.outputTokens * modelOutputWeight(t.effectiveModel);
    assert.ok(Math.abs(derived - measured) < 1e-6, `${name}: derived output ${derived} != measured ${measured}`);
  }
});

test('cache multipliers and the units priced from them follow the pricing table, not constants', () => {
  resetPricing();
  try {
    const rates = getPricingTable().rates;
    rates['claude-sonnet-5'] = { input: 3e-6, output: 15e-6, cacheRead: 0.6e-6, cacheWrite: 4.5e-6, cacheWrite1h: 9e-6 };
    rates['claude-haiku-x'] = { input: 1e-6, output: 5e-6, cacheRead: 0.2e-6, cacheWrite: 1.5e-6 };

    const sonnet = cacheMultipliers('claude-sonnet-5');
    assert.ok(Math.abs(sonnet.read - 0.2) < 1e-9 && Math.abs(sonnet.write - 1.5) < 1e-9 && Math.abs(sonnet.write1h - 3) < 1e-9);
    // No 1h rate published for this model: that kind alone is left unpriced, never guessed.
    const haiku = cacheMultipliers('claude-haiku-x');
    assert.equal(haiku.write1h, 0);
    assert.deepEqual(haiku.unpriced, ['write1h']);

    const t = telemetry({ originalModel: 'claude-sonnet-5', effectiveModel: 'claude-sonnet-5' });
    const cost = computeTurnCost(t, {
      input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 2_000, cache_creation: { ephemeral_1h_input_tokens: 500 }, output_tokens: 0,
    });
    assert.ok(Math.abs(cost.cacheReadUnits - 1_000 * 0.2) < 1e-6);
    assert.ok(Math.abs(cost.cacheWriteUnits - (1_500 * 1.5 + 500 * 3)) < 1e-6);
    assert.deepEqual(cost.cacheMultipliers, sonnet);
  } finally {
    resetPricing();
  }
});

test('backfillCacheCosts leaves a complete row alone and rebuilds a missing one from its own tokens, model and 1h writes', () => {
  const complete = entry({ cacheNoCacheUnitCost: 5, cacheActualUnitCost: 3, cacheReadTokens: 999 });
  assert.equal(backfillCacheCosts(complete), complete);

  const old = entry({ servedModel: 'claude-sonnet-5', cacheReadTokens: 1_000, cacheWriteTokens: 400, cacheWrite1hTokens: 100 });
  delete (old as Partial<LedgerEntry>).cacheNoCacheUnitCost;
  const filled = backfillCacheCosts(old);
  const rates = cacheMultipliers('claude-sonnet-5');
  const weight = modelWeight('claude-sonnet-5');
  assert.ok(Math.abs(filled.cacheNoCacheUnitCost - 1_400 * weight) < 1e-6);
  assert.ok(Math.abs(filled.cacheActualUnitCost - (300 * rates.write + 100 * rates.write1h + 1_000 * rates.read) * weight) < 1e-6);
  // A row with no cache tokens at all costs nothing, never NaN.
  const bare = { ...entry(), cacheReadTokens: undefined, cacheWriteTokens: undefined } as unknown as LedgerEntry;
  delete (bare as Partial<LedgerEntry>).cacheActualUnitCost;
  const bareFilled = backfillCacheCosts(bare);
  assert.equal(bareFilled.cacheActualUnitCost, 0);
  assert.equal(bareFilled.cacheNoCacheUnitCost, 0);
});

test('the tracker exposes the month file it appends to and the account it is scoped to', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  const tracker = new AnalyticsTracker(dir, OCT_20);
  assert.equal(path.basename(tracker.ledgerPath), '2026-10.jsonl');
  assert.equal(tracker.getActiveAccountId(), undefined);
  tracker.setActiveAccount('acct-1');
  assert.equal(tracker.getActiveAccountId(), 'acct-1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable month file is skipped instead of failing the tracker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-ledger-'));
  const ledgerDir = path.join(dir, LEDGER_DIRNAME);
  fs.mkdirSync(ledgerDir, { recursive: true });
  // A directory where a month file should be: reading it fails.
  fs.mkdirSync(path.join(ledgerDir, '2026-09.jsonl'));
  fs.writeFileSync(path.join(ledgerDir, '2026-10.jsonl'), JSON.stringify(entry({ project: 'ok' })) + '\n');
  const entries = new AnalyticsTracker(dir, OCT_20).getEntries();
  assert.deepEqual(entries.map((e) => e.project), ['ok']);
  fs.rmSync(dir, { recursive: true, force: true });
});
