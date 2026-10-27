/** Failed hits: what the turn icon says, and that unbilled hits add nothing to the flow columns. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregate, AnalyticsTracker, isFailedHit, LedgerEntry } from '../analytics/tracker';
import { ALL, buildAnalyticsSectionHtml } from '../ui/analyticsPanel';

function hit(minutesAgo: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    project: 'core-banking',
    requestedModel: 'claude-sonnet-5',
    servedModel: 'claude-sonnet-5',
    modelSwapped: false,
    rawTokens: 50_000,
    optimizedTokens: 40_000,
    prunedByNormalization: 7_000,
    prunedByCompaction: 3_000,
    compactionTriggered: false,
    cacheAnchorPlaced: true,
    newUserTurn: false,
    uncachedInputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 39_000,
    outputTokens: 100,
    baselineUnitCost: 9_000,
    actualUnitCost: 4_000,
    savingsPercent: 55,
    status: 200,
    ...over,
  } as LedgerEntry;
}

/** A hit Anthropic never answered: priced at zero, as `computeTurnCost` does without usage. */
const failure = (minutesAgo: number, status = 0): LedgerEntry =>
  hit(minutesAgo, {
    status,
    failure: status === 0 ? 'ECONNRESET' : undefined,
    baselineUnitCost: 0,
    actualUnitCost: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  });

const render = (entries: LedgerEntry[]): string =>
  buildAnalyticsSectionHtml({ getEntries: () => entries } as unknown as AnalyticsTracker, { project: ALL, range: 'today' });

/** The turn row is the first `data-toggle` row; its status cell is the third cell. */
function turnStatus(html: string): string {
  const row = html.slice(html.indexOf('<tr data-row="core-banking#'));
  const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
  return cells[2];
}

test('isFailedHit: no response and non-2xx fail, 2xx and rows without a status do not', () => {
  assert.equal(isFailedHit({ status: 0 }), true);
  assert.equal(isFailedHit({ status: 529 }), true);
  assert.equal(isFailedHit({ status: 199 }), true);
  assert.equal(isFailedHit({ status: 200 }), false);
  assert.equal(isFailedHit({ status: 299 }), false);
  assert.equal(isFailedHit({ status: 300 }), true);
  assert.equal(isFailedHit({}), false);
});

test('a turn whose only hit failed shows the failure icon with the cause', () => {
  const cell = turnStatus(render([failure(1)]));
  assert.match(cell, /✖/);
  assert.match(cell, /failed \(no response\) · ECONNRESET/);
});

test('a turn that ended on an HTTP error shows the status', () => {
  assert.match(turnStatus(render([hit(3), failure(1, 529)])), /failed \(HTTP 529\)/);
});

test('a failed hit that was retried successfully shows a warning, and says how many were retried', () => {
  const cell = turnStatus(render([failure(2), hit(1)]));
  assert.match(cell, /⚠/);
  assert.doesNotMatch(cell, /✖|✔/);
  assert.match(cell, /Done · 1 of 2 hits failed and were retried/);
});

test('a turn with no failures is plainly done', () => {
  assert.match(turnStatus(render([hit(2), hit(1)])), /title="Done"/);
});

test('a failed hit adds nothing to the flow columns: it was not billed, the retry carries the request', () => {
  const stats = aggregate([failure(2), hit(1)]);
  assert.equal(stats.rawTokens, 50_000);
  assert.equal(stats.optimizedTokens, 40_000);
  assert.equal(stats.prunedByNormalization, 7_000);
  assert.equal(stats.prunedByCompaction, 3_000);
  // It is still a hit, and the cost side was already zero.
  assert.equal(stats.turns, 2);
  assert.equal(stats.actualUnitCost, 4_000);

  const onlyFailure = aggregate([failure(1)]);
  assert.equal(onlyFailure.rawTokens, 0);
  assert.equal(onlyFailure.optimizedTokens, 0);
});

test('a failed hit that still paid for a Haiku summary keeps that cost', () => {
  const paid = failure(1);
  paid.summarizerUnitCost = 123;
  paid.actualUnitCost = 123;
  const stats = aggregate([paid]);
  assert.equal(stats.summarizerUnitCost, 123);
  assert.equal(stats.actualUnitCost, 123);
  assert.equal(stats.rawTokens, 0);
});

test('the Billed tooltip is one short line that closes on the invoice total', () => {
  const html = render([hit(1, { cacheWriteTokens: 2_000, cacheReadUnits: 3_900, cacheWriteUnits: 2_500, regularInputUnits: 10, outputUnits: 1_500, actualUnitCost: 7_910 })]);
  const tooltip = /<td class="num" title="(CR [^"]+)">/.exec(html)?.[1] ?? '';
  assert.match(tooltip, /^CR [\d.\s  K]+ \+ CW [\d.\s  K]+ \+ RI [\d.\s  K]+ \+ output [\d.\s  K]+ = [\d.\s  K]+ u$/);
  assert.ok(tooltip.length < 80, `tooltip should stay short, was ${tooltip.length} chars`);
  assert.doesNotMatch(tooltip, /tok ×/);
});

test('the Billed tooltip adds the Haiku summary only when the turn paid for one', () => {
  const withSummary = render([hit(1, { summarizerUnitCost: 800, actualUnitCost: 4_800 })]);
  assert.match(withSummary, /title="CR [^"]+ \+ Haiku summary [^"]+ = [^"]+ u"/);
  const without = render([hit(1)]);
  assert.doesNotMatch(without, /\+ Haiku summary/);
});

test('a turn where every hit failed is the only one that shows the cross', () => {
  assert.match(turnStatus(render([failure(2), failure(1)])), /✖/);
  const mixedLast = turnStatus(render([hit(2), failure(1)]));
  assert.match(mixedLast, /⚠/);
  assert.doesNotMatch(mixedLast, /✖/);
});
