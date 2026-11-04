/**
 * Unit tests for the "Last turns" table's data: per-project turn grouping and the
 * in-flight request tracker.
 */

import { resolveRange } from '../ui/dateRange';
import assert from 'node:assert/strict';
import test from 'node:test';

import { InFlightProject, InFlightTracker, IN_FLIGHT_EXPIRY_MS } from '../analytics/inflight';
import { groupTurns, LedgerEntry } from '../analytics/tracker';
import { compact } from '../ui/shared';
import { dailySeries, historyChartsHtml, hourlySeries } from '../ui/historyChart';
import { summaryColumnCell, liveRow, pendingTotals } from '../ui/liveTurnRow';

function hit(project: string, newUserTurn?: boolean): LedgerEntry {
  return { project, newUserTurn } as unknown as LedgerEntry;
}

test('groupTurns keeps interleaved projects in separate turns', () => {
  const groups = groupTurns([hit('a', true), hit('b', true), hit('a', false), hit('b', false), hit('a', false)]);

  assert.deepEqual(
    groups.map((group) => [group.project, group.entries.length]),
    [
      ['a', 3],
      ['b', 2],
    ]
  );
});

test('groupTurns opens a new group on each newUserTurn and on legacy rows without the flag', () => {
  const groups = groupTurns([hit('a', true), hit('a', false), hit('a', true), hit('a'), hit('a')]);

  assert.deepEqual(
    groups.map((group) => group.entries.length),
    [2, 1, 1, 1]
  );
});

test('groupTurns starts a group for a continuation hit with no open turn', () => {
  assert.equal(groupTurns([hit('a', false)]).length, 1);
  assert.deepEqual(groupTurns([]), []);
});

test('InFlightTracker reports per project counts and whether a new turn is pending', () => {
  const tracker = new InFlightTracker();
  tracker.start('a', false, 1000);
  tracker.start('a', true, 1001);
  tracker.start('b', false, 1002);
  assert.deepEqual([...tracker.snapshot(2000)], [
    ['a', { count: 2, preflight: [], newTurn: true, since: 1000, sessionId: undefined }],
    ['b', { count: 1, preflight: [], newTurn: false, since: 1002, sessionId: undefined }],
  ]);

  tracker.finish('a');
  tracker.finish('a');
  tracker.finish('b');
  tracker.finish('unknown');
  assert.equal(tracker.snapshot(2000).size, 0);
});

test('InFlightTracker attaches pre-flight numbers to the oldest unmeasured request, before it finishes', () => {
  const tracker = new InFlightTracker();
  const first = { rawTokens: 100, prunedByNormalization: 10, prunedByCompaction: 0, optimizedTokens: 90 };
  const second = { rawTokens: 200, prunedByNormalization: 20, prunedByCompaction: 50, optimizedTokens: 130 };
  tracker.start('a', true, 1000);
  tracker.start('a', false, 1001);

  tracker.optimized('a', first);
  assert.equal(tracker.snapshot(2000).get('a')?.count, 2);
  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [first]);

  tracker.optimized('a', second);
  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [first, second]);

  tracker.finish('a');
  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [second]);
  tracker.optimized('unknown', first); // no pending request: ignored
});

test('InFlightTracker merges stage figures into one request as they arrive', () => {
  const tracker = new InFlightTracker();
  tracker.start('a', true, 1000);

  tracker.optimized('a', { rawTokens: 100 });
  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [{ rawTokens: 100 }]);

  tracker.optimized('a', { prunedByNormalization: 10 });
  tracker.optimized('a', { prunedByCompaction: 5 });
  tracker.optimized('a', { optimizedTokens: 85 });
  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [
    { rawTokens: 100, prunedByNormalization: 10, prunedByCompaction: 5, optimizedTokens: 85 },
  ]);

  // Complete now: a further figure without an id goes to the next unfinished request, not this one.
  tracker.optimized('a', { rawTokens: 999 });
  assert.equal(tracker.snapshot(2000).get('a')?.preflight[0].rawTokens, 100);
});

test('InFlightTracker routes stages by request id when requests of one project overlap', () => {
  const tracker = new InFlightTracker();
  tracker.start('a', true, 1000, '1');
  tracker.start('a', false, 1001, '2');

  // The second request reports before the first has finished: it must not land on the first.
  tracker.optimized('a', { rawTokens: 200 }, '2');
  tracker.optimized('a', { rawTokens: 100 }, '1');
  tracker.optimized('a', { prunedByNormalization: 7 }, '2');

  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [
    { rawTokens: 100 },
    { rawTokens: 200, prunedByNormalization: 7 },
  ]);

  tracker.optimized('a', { rawTokens: 1 }, 'gone'); // unknown id: ignored
  assert.deepEqual(tracker.snapshot(2000).get('a')?.preflight, [
    { rawTokens: 100 },
    { rawTokens: 200, prunedByNormalization: 7 },
  ]);
});

test('InFlightTracker drops a request that never completed once it expires', () => {
  const tracker = new InFlightTracker();
  tracker.start('a', true, 0);

  assert.equal(tracker.snapshot(IN_FLIGHT_EXPIRY_MS - 1).size, 1);
  assert.equal(tracker.snapshot(IN_FLIGHT_EXPIRY_MS).size, 0);
});

test('pendingTotals sums the stages in flight and flags which ones were reported', () => {
  const live = { count: 2, newTurn: true, since: 1, preflight: [{ rawTokens: 100 }, { rawTokens: 50, prunedByNormalization: 5 }] };
  const totals = pendingTotals(live);

  assert.equal(totals.raw, 150);
  assert.equal(totals.pruned, 5);
  assert.deepEqual(totals.known, { raw: true, pruned: true, compacted: false, sent: false });
  assert.deepEqual(pendingTotals(undefined).known, { raw: false, pruned: false, compacted: false, sent: false });
});

/** The cells of a live row after Time, Repo, Status, Turns, Hits and Model: raw, cleanup, summarized, sent. */
function liveFigureCells(preflight: InFlightProject['preflight']): string[] {
  const html = liveRow('repo', { count: 1, newTurn: true, since: 0, preflight }, 0).split('</tr>')[0];
  const cells = html.match(/<td[\s\S]*?<\/td>/g) ?? [];
  // Raw, Cleanup, Summarized, Sent.
  return cells.slice(6, 10);
}

test('liveRow has one cell per header column and keeps the arrow column constant', () => {
  const html = liveRow('repo', { count: 1, newTurn: true, since: 0, preflight: [{ rawTokens: 1000, optimizedTokens: 700 }] }, 0).split('</tr>')[0];
  const cells = html.match(/<td[\s\S]*?<\/td>/g) ?? [];

  // Time, Repo, Status, Turns, Hits, Model, Raw, Cleanup, Summarized, Sent, arrow, Total received, CR, CW, RI, Out, Billed.
  assert.equal(cells.length, 17);
  // Optimized and on its way: the arrow flies until the answer replaces the row.
  assert.match(cells[10], /class="turn-arrow"><span class="arrow-fly"[^>]*>→<\/span>/);
  // Before the request leaves, the column stays empty.
  const before = liveRow('repo', { count: 1, newTurn: true, since: 0, preflight: [{ rawTokens: 1000 }] }, 0).split('</tr>')[0];
  assert.equal((before.match(/<td[\s\S]*?<\/td>/g) ?? [])[10], '<td class="turn-arrow"></td>');
});

test('liveRow fills Raw request, Cleanup, Summarized and Sent one column at a time', () => {
  const dash = '<td class="num">—</td>';

  assert.deepEqual(liveFigureCells([]), [dash, dash, dash, dash]);

  const afterRaw = liveFigureCells([{ rawTokens: 1000 }]);
  assert.equal(afterRaw[0], `<td class="num">${compact(1000)}</td>`);
  assert.deepEqual(afterRaw.slice(1), [dash, dash, dash]);

  const afterCleanup = liveFigureCells([{ rawTokens: 1000, prunedByNormalization: 100 }]);
  assert.notEqual(afterCleanup[1], dash);
  assert.deepEqual(afterCleanup.slice(2), [dash, dash]);

  // Without a created summary the 200 pruned tokens are a reused one.
  const afterCompaction = liveFigureCells([{ rawTokens: 1000, prunedByNormalization: 100, prunedByCompaction: 200 }]);
  assert.match(afterCompaction[2], /↻ reused/);
  assert.doesNotMatch(afterCompaction[2], /✓ new/);
  assert.equal(afterCompaction[3], dash);

  const created = liveFigureCells([{ rawTokens: 1000, prunedByNormalization: 100, prunedByCompaction: 200, summaryCreated: true }]);
  assert.match(created[2], /✓ new/);
  assert.doesNotMatch(created[2], /↻ reused/);

  // Compaction reported nothing to prune: the cell says no summary instead of staying blank.
  const none = liveFigureCells([{ rawTokens: 1000, prunedByNormalization: 100, prunedByCompaction: 0 }]);
  assert.match(none[2], /No summary/);

  const done = liveFigureCells([{ rawTokens: 1000, prunedByNormalization: 100, prunedByCompaction: 200, optimizedTokens: 700 }]);
  assert.ok(done.every((cell) => cell !== dash));
});

test('summaryColumnCell shows new and reused separately, counts hits, and keeps the numbers in the tooltip', () => {
  const none = { hits: 0, before: 0, pruned: 0, costUnits: 0 };

  assert.match(summaryColumnCell(none, none), /No summary/);

  const created = { hits: 1, before: 10_000, pruned: 6_000, costUnits: 900 };
  const reused = { hits: 3, before: 30_000, pruned: 18_000, costUnits: 0 };

  const onlyNew = summaryColumnCell(created, none);
  assert.match(onlyNew, /✓ new/);
  assert.doesNotMatch(onlyNew, /↻/);
  // The cell carries no token figures; they sit in the tooltip.
  // A row up to 1 Nov 2026 carries what the model charged; a summary the proxy built carries nothing to pay.
  assert.match(onlyNew, /title="[^"]*A model wrote 1 summary\(ies\)[^"]*Cost 900 u/i);
  const local = summaryColumnCell({ hits: 1, before: 10_000, pruned: 6_000, costUnits: 0 }, none);
  assert.match(local, /title="The proxy built 1 summary\(ies\) itself: [^"]*No model, no cost\./);
  assert.doesNotMatch(local, /Haiku/);

  const both = summaryColumnCell(created, reused);
  assert.match(both, /✓ new/);
  assert.match(both, /↻ 3 reused/);
  assert.match(both, /Nothing new to build/);
});

test('liveRow keeps the Summarized cell empty while an earlier stage is still missing', () => {
  const dash = '<td class="num">—</td>';
  // Compaction is known but Raw is not (stages of another request): the summary cell stays empty.
  const cells = liveFigureCells([{ prunedByCompaction: 200 }]);
  assert.equal(cells[2], dash);
});

test('liveRow adds one hit sub-row per request in flight, keyed under its turn', () => {
  const html = liveRow('repo', { count: 2, newTurn: true, since: 0, preflight: [{ rawTokens: 1000, optimizedTokens: 700 }] }, 3);

  assert.equal((html.match(/class="hit-row/g) ?? []).length, 2);
  assert.match(html, /data-toggle="repo#3"/);
  assert.match(html, /data-row="repo#3\/L0" data-parent="repo#3"/);
  assert.match(html, /data-row="repo#3\/L1" data-parent="repo#3"/);
});

test('resolveRange covers local days: today, yesterday, last 7 days and an inclusive custom range', () => {
  const now = new Date(2026, 9, 21, 15, 30); // 2026-10-21 15:30 local
  const day = (d: number) => new Date(2026, 9, d).getTime();

  const today = resolveRange({ range: 'today' }, now);
  assert.deepEqual([today.start, today.end, today.includesNow], [day(21), day(22), true]);
  const yesterday = resolveRange({ range: 'yesterday' }, now);
  assert.deepEqual([yesterday.start, yesterday.end, yesterday.includesNow], [day(20), day(21), false]);
  const week = resolveRange({ range: '7d' }, now);
  assert.deepEqual([week.start, week.end, week.includesNow], [day(15), day(22), true]);
  const custom = resolveRange({ range: 'custom', from: '2026-10-10', to: '2026-10-12' }, now);
  assert.deepEqual([custom.start, custom.end, custom.includesNow], [day(10), day(13), false]);
});

function ledgerAt(at: Date, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: at.toISOString(), project: 'a', baselineUnitCost: 1000, actualUnitCost: 600,
    cacheReadTokens: 10_000, cacheWriteTokens: 1_000, uncachedInputTokens: 0, ...over,
  } as unknown as LedgerEntry;
}

test('dailySeries gives one point per local day, empty days included, with cache units on the billed basis', () => {
  const start = new Date(2026, 9, 20).getTime();
  const end = new Date(2026, 9, 23).getTime();
  const points = dailySeries([ledgerAt(new Date(2026, 9, 20, 10)), ledgerAt(new Date(2026, 9, 22, 23, 30))], start, end);

  assert.deepEqual(points.map((p) => [p.day, p.turns]), [['2026-10-20', 1], ['2026-10-21', 0], ['2026-10-22', 1]]);
  assert.equal(points[0].billed, 600);
  assert.equal(points[0].received, 11_000);
  // 10K read tokens at 0.10x and 1K written at 1.25x, in billed units.
  assert.ok(Math.abs(points[0].readUnits - 1_000) < 1e-6);
  assert.ok(Math.abs(points[0].writeUnits - 1_250) < 1e-6);
});

test('historyChartsHtml draws one bar per hour for a single day and one per day for a longer range', () => {
  const now = new Date(2026, 9, 21, 15, 30);
  const day = (d: number) => new Date(2026, 9, d).getTime();
  const entries = [ledgerAt(new Date(2026, 9, 5, 9)), ledgerAt(new Date(2026, 9, 21, 9))];

  const today = historyChartsHtml(entries, { start: day(21), end: day(22) }, now);
  assert.equal((today.match(/<svg /g) ?? []).length, 3);
  // From the first hour with requests (09) through the current one (15), in each of the three charts.
  assert.equal((today.match(/<g><rect /g) ?? []).length, 3 * 7);
  assert.match(today, /2026-10-21 09:00/);

  const month = historyChartsHtml(entries, { start: day(1), end: day(22) }, now);
  assert.equal((month.match(/<g><rect /g) ?? []).length, 3 * 21);

  const empty = historyChartsHtml([], { start: day(1), end: day(22) }, now);
  assert.match(empty, /No requests in this period/);
});

test('hourlySeries buckets by local hour and stops at the end it is given', () => {
  const start = new Date(2026, 9, 21).getTime();
  const points = hourlySeries([ledgerAt(new Date(2026, 9, 21, 9, 59)), ledgerAt(new Date(2026, 9, 21, 10, 1))], start, new Date(2026, 9, 21, 11, 5).getTime());
  assert.deepEqual(points.map((p) => p.label), ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00']);
  assert.equal(points[9].turns, 1);
  assert.equal(points[10].turns, 1);
});

test('processing icons move on their own: same row keeps its needle, different rows differ', async () => {
  const { processingIcon } = await import('../ui/shared');
  assert.equal(processingIcon('a#1'), processingIcon('a#1'));
  const styles = new Set(['a#1', 'a#2', 'b#1', 'c#9', 'd#4'].map((k) => processingIcon(k)));
  assert.ok(styles.size > 1);
  assert.match(processingIcon('a#1'), /gauge-icon/);
});

test('a hit that ends in tool_use keeps the project live while local tools run, until the next hit or an end_turn', () => {
  const t = new InFlightTracker();
  t.start('p', true, 1000, 'a', 's1');
  t.finish('p', 'tool_use', 's1', 2000);
  assert.equal(t.snapshot(3000).get('p')?.count, 0);
  assert.ok(t.snapshot(3000).has('p'));
  t.start('p', false, 4000, 'b', 's1');
  t.finish('p', 'end_turn', 's1', 5000);
  assert.equal(t.snapshot(6000).has('p'), false);
  // another chat's side request does not end it; an expired wait drops out
  t.finish('p', 'tool_use', 's1', 7000);
  t.finish('p', 'end_turn', 's2', 7100);
  assert.ok(t.snapshot(8000).has('p'));
  assert.equal(t.snapshot(7000 + 11 * 60_000).has('p'), false);
});

test('live rows have one cell per header column, with Model (empty) right after Hits', () => {
  const countCells = (html: string): number[] =>
    html.split('<tr ').slice(1).map((row) => (row.match(/<td[ >]/g) ?? []).length);
  for (const preflight of [[], [{ rawTokens: 1000, prunedByNormalization: 10, prunedByCompaction: 0, optimizedTokens: 900 }]]) {
    const html = liveRow('p', { count: 2, newTurn: true, since: Date.now(), preflight } as never, 1);
    assert.deepEqual(countCells(html), [17, 17, 17]);
    // Cells 1-5 are Time, Repo, Status, Turns, Hits; cell 6 is Model and must be empty so Raw lands under Raw.
    const first = html.split('<tr ')[1];
    const cells = first.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
    assert.equal(cells[5], '<td></td>');
  }
});
