/** The Token Improver tab: filters, totals, the Cached tooltips and their arithmetic. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyticsTracker, computeTurnCost, LedgerEntry } from '../analytics/tracker';
import { HAIKU_MODEL_ID, OptimizationTelemetry } from '../proxy/optimizer';
import { ALL, AnalyticsFilters, buildAnalyticsSectionHtml } from '../ui/analyticsPanel';
import { fake } from './helpers/fakeVscode';

function telemetry(overrides: Partial<OptimizationTelemetry> = {}): OptimizationTelemetry {
  return {
    rawTokens: 100_000,
    optimizedTokens: 60_000,
    prunedByNormalization: 10_000,
    prunedByCompaction: 30_000,
    compactionTriggered: false,
    originalModel: 'claude-sonnet-5',
    effectiveModel: 'claude-sonnet-5',
    modelDowngraded: false,
    routingReason: 'test',
    startupModelDefaulted: false,
    cacheAnchorPlaced: true,
    cacheAnchorBelowMinimum: false,
    strippedCacheControlBlocks: 0,
    isNewUserTurn: true,
    baselineCachedTokens: 80_000,
    floorCachedTokens: 90_000,
    ...overrides,
  };
}

interface Usage {
  input?: number;
  read?: number;
  write?: number;
  output?: number;
  write1h?: number;
}

/** A ledger row priced the way the extension prices it, stamped `minutesAgo` before now. */
function row(
  usage: Usage,
  over: { project?: string; minutesAgo?: number; tel?: Partial<OptimizationTelemetry>; status?: number } = {}
): LedgerEntry {
  const t = telemetry(over.tel);
  const cost = computeTurnCost(t, {
    input_tokens: usage.input ?? 0,
    cache_read_input_tokens: usage.read ?? 0,
    cache_creation_input_tokens: usage.write ?? 0,
    cache_creation: usage.write1h ? { ephemeral_1h_input_tokens: usage.write1h } : undefined,
    output_tokens: usage.output ?? 0,
  });
  return {
    timestamp: new Date(Date.now() - (over.minutesAgo ?? 1) * 60_000).toISOString(),
    project: over.project ?? 'repo-a',
    requestedModel: t.originalModel,
    servedModel: t.effectiveModel,
    modelSwapped: t.modelDowngraded,
    rawTokens: t.rawTokens,
    optimizedTokens: t.optimizedTokens,
    prunedByNormalization: t.prunedByNormalization,
    prunedByCompaction: t.prunedByCompaction,
    compactionTriggered: t.compactionTriggered,
    cacheAnchorPlaced: true,
    newUserTurn: true,
    status: over.status ?? 200,
    ...cost,
  } as unknown as LedgerEntry;
}

const tracker = (entries: LedgerEntry[]): AnalyticsTracker => ({ getEntries: () => entries }) as unknown as AnalyticsTracker;
const TODAY: AnalyticsFilters = { project: ALL, range: 'today' };
const render = (entries: LedgerEntry[], filters: AnalyticsFilters = TODAY): string =>
  buildAnalyticsSectionHtml(tracker(entries), filters);

test('with no recorded requests the panel explains how to start the proxy', () => {
  const html = render([]);
  assert.match(html, /No optimized requests recorded yet/);
  assert.match(html, /ANTHROPIC_BASE_URL/);
});

test('a recorded turn renders the table, the history charts and the saving headline', () => {
  const html = render([row({ read: 80_000, write: 5_000, input: 100, output: 400 })]);
  assert.match(html, /Claude Token Improver/);
  assert.match(html, /1 optimized requests/);
  assert.match(html, /History/);
  assert.match(html, /<svg /);
  // The rows carry a floor baseline, so the headline is the guaranteed one.
  assert.match(html, /Saving, at least/);
});

test('rows without a floor baseline fall back to the estimated saving and say so', () => {
  const old = row({ read: 1_000, write: 100, output: 10 });
  delete (old as Partial<LedgerEntry>).floorBaselineUnitCost;
  const html = render([old]);
  assert.match(html, /Estimated saving/);
  assert.doesNotMatch(html, /Saving, at least/);
});

test('the cache cells say their share of Received in t, and the Billed tooltip adds up the units', () => {
  const html = render([row({ read: 80_000, write: 5_000, input: 100, output: 400 })]);
  assert.match(html, /title="CR: 80\.00K t"/);
  assert.doesNotMatch(html, /of Received/);
  assert.match(html, /title="CR [\d.]+K? \+ CW [\d.]+K? \+ RI [\d.]+K? \+ output [\d.]+K? = [\d.]+K? u"/);
});

test('tooltip multipliers are the effective rate of the hit, not constants', () => {
  const sonnet = render([row({ read: 10_000, write: 2_000 })]);
  assert.match(sonnet, /CR: 10\.00K t × 0\.1 = 1\D000 u/);
  assert.match(sonnet, /CW: 2\.00K t × 1\.25 = 2\.50K u/);

  // Haiku weighs a third of Sonnet, so the same tokens bill at a third of the rate.
  const haiku = render([
    row({ read: 10_000, write: 2_000 }, { tel: { effectiveModel: HAIKU_MODEL_ID, modelDowngraded: true } }),
  ]);
  assert.doesNotMatch(haiku, /CR: 10\.00K t × 0\.1 =/);
  assert.match(haiku, /CR: 10\.00K t × 0\.0\d+ =/);

  // A 1h write bills above 1.25x, and the tooltip shows the blended rate.
  const oneHour = render([row({ read: 0, write: 2_000, write1h: 2_000 })]);
  assert.match(oneHour, /CW: 2\.00K t × 2 = 4\.00K u/);
});

test('the Cached cell is tinted green when reads outweigh writes and red when writes do', () => {
  const healthy = render([row({ read: 90_000, write: 1_000 })]);
  assert.match(healthy, /rgba\(63,185,80,0\.16\)/);
  assert.doesNotMatch(healthy, /(Reads|Writes) (>|&gt;) (writes|reads)/);

  const cold = render([row({ read: 1_000, write: 90_000 })]);
  assert.match(cold, /rgba\(229,83,75,0\.16\)/);
  assert.doesNotMatch(cold, /(Reads|Writes) (>|&gt;) (writes|reads)/);
});

test('tokens can be healthy while units are red, because a written token costs 12.5x a read one', () => {
  const html = render([row({ read: 30_000, write: 20_000 })]);
  assert.doesNotMatch(html, /(Reads|Writes) (>|&gt;) (writes|reads)/);
  assert.doesNotMatch(html, /(Reads|Writes) (>|&gt;) (writes|reads)/);
});

test('the project filter narrows the table, and an unknown project falls back to all repos', () => {
  const entries = [row({ read: 1_000 }, { project: 'repo-a' }), row({ read: 1_000 }, { project: 'repo-b' })];
  assert.match(render(entries, { project: 'repo-a', range: 'today' }), /1 optimized requests/);
  assert.match(render(entries, { project: ALL, range: 'today' }), /2 optimized requests/);
  assert.match(render(entries, { project: 'ghost', range: 'today' }), /2 optimized requests/);
});

test('the date filter drops entries outside the range', () => {
  const entries = [row({ read: 1_000 }, { minutesAgo: 1 }), row({ read: 1_000 }, { minutesAgo: 3 * 24 * 60 })];
  assert.match(render(entries, TODAY), /1 optimized requests/);
  assert.match(render(entries, { project: ALL, range: '7d' }), /2 optimized requests/);
  const d = new Date(Date.now() - 3 * 24 * 3_600_000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.match(render(entries, { project: ALL, range: 'custom', from: day, to: day }), /1 optimized requests/);
});

test('a range with no requests still renders, with an empty donut', () => {
  const html = render([row({ read: 1_000 }, { minutesAgo: 5 * 24 * 60 })], { project: ALL, range: 'yesterday' });
  assert.match(html, /0 optimized requests/);
  assert.match(html, /no requests/);
});

test('a Haiku summary is listed in the Billed tooltip when the turn paid for one', () => {
  const html = render([
    row({ read: 0, write: 20_000 }, { tel: { compactionTriggered: true, summarizerUsage: { inputTokens: 10_000, outputTokens: 800 } } }),
  ]);
  assert.match(html, /Haiku summary [\d.]+K?\./);
});

test('settings are read through the vscode configuration', () => {
  fake.reset();
  fake.settings['slidingThresholdTokens'] = 50_000;
  assert.doesNotThrow(() => render([row({ read: 1_000 })]));
});

test('the header shows both the filtered saving and the monthly saving beside the title', () => {
  const entries = [row({ read: 80_000, write: 5_000 }, { minutesAgo: 1 }), row({ read: 1_000, write: 40_000 }, { minutesAgo: 2 * 24 * 60 })];
  const html = render(entries, TODAY);
  const head = html.slice(html.indexOf('<div class="head">'), html.indexOf('<h2>Turns'));
  assert.match(head, /Claude Token Improver/);
  assert.match(head, /Today · all repos/);
  assert.match(head, /This month · all repos/);
  assert.equal((head.match(/<svg /g) ?? []).length, 2);
  assert.match(head, /donut-mini/);
  assert.equal((html.match(/This month · all repos/g) ?? []).length, 1);
  // The two donuts are different numbers: today's turn is healthy, the month includes a cold one.
  const percents = [...head.matchAll(/class="donut-figure"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.equal(percents.length, 2);
  assert.notEqual(percents[0], percents[1]);
});

test('the table help texts do not quote fixed cache multipliers', () => {
  const html = render([row({ read: 1_000 })]);
  assert.doesNotMatch(html, /0\.10x|1\.25x|× 0\.10|× 1\.25 *\)/);
});

test('a range that cost more than its baseline gets a warning, and a saving range does not', () => {
  const losing = row({ read: 0, write: 90_000, input: 100, output: 400 });
  losing.floorBaselineUnitCost = 1_000;
  losing.actualUnitCost = 5_000;
  assert.match(render([losing]), /The proxy cost [\d.]+K? <abbr[^>]*>u<\/abbr> more than the baseline/);
  const saving = row({ read: 0, write: 900, input: 100, output: 400 });
  saving.floorBaselineUnitCost = 5_000;
  saving.actualUnitCost = 1_000;
  assert.doesNotMatch(render([saving]), /more than the baseline/);
});

test('the stats grid has four cards: saving, cache, pruning and downgrades', () => {
  const html = render([row({ read: 80_000, write: 5_000, input: 100, output: 400 })]);
  for (const label of ['Saving, at least', 'Cache', 'Pruning &amp; compaction', 'Model downgrades']) {
    assert.ok(html.includes(`<div class="stat-label">${label}</div>`), label);
  }
  assert.doesNotMatch(html, /Typical saving|Baseline vs actual|Tokens pruned/);
});
