/** The "·" under Haiku summary says why nothing was summarized; the table keeps its column proportions. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyticsTracker, LedgerEntry } from '../analytics/tracker';
import { ALL, buildAnalyticsSectionHtml } from '../ui/analyticsPanel';
import { haikuSummaryCell } from '../ui/liveTurnRow';

const none = { hits: 0, before: 0, pruned: 0, haikuUnits: 0 };

function hit(minutesAgo: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    project: 'repo',
    requestedModel: 'claude-sonnet-5',
    servedModel: 'claude-sonnet-5',
    modelSwapped: false,
    rawTokens: 94_000,
    optimizedTokens: 93_900,
    prunedByNormalization: 100,
    prunedByCompaction: 0,
    compactionTriggered: false,
    cacheAnchorPlaced: true,
    newUserTurn: true,
    uncachedInputTokens: 2,
    cacheWriteTokens: 93_900,
    cacheReadTokens: 0,
    outputTokens: 9,
    baselineUnitCost: 1,
    actualUnitCost: 1,
    savingsPercent: 0,
    status: 200,
    ...over,
  } as LedgerEntry;
}

const render = (entries: LedgerEntry[]): string =>
  buildAnalyticsSectionHtml({ getEntries: () => entries } as unknown as AnalyticsTracker, { project: ALL, range: 'today' });

test('the dot names the reason when the proxy recorded one, and stays plain when it did not', () => {
  assert.match(haikuSummaryCell(none, none, 'fewer than 4 unsummarized messages'), /title="No Haiku summary on this request: fewer than 4 unsummarized messages"/);
  assert.match(haikuSummaryCell(none, none), /title="No Haiku summary on this request"/);
});

test('the reason is escaped, since it is recorded text', () => {
  const cell = haikuSummaryCell(none, none, 'a "quoted" <reason>');
  assert.doesNotMatch(cell, /<reason>/);
  assert.match(cell, /&lt;reason&gt;/);
});

test('a summary that happened wins over any skip reason', () => {
  const cell = haikuSummaryCell({ hits: 1, before: 100, pruned: 40, haikuUnits: 5 }, none, 'ignored');
  assert.doesNotMatch(cell, /ignored/);
  assert.match(cell, /new/);
});

test('the table shows the recorded reason on the turn and on its hit', () => {
  const html = render([hit(1, { compactionSkippedReason: 'fewer than 4 unsummarized messages' })]);
  const matches = html.match(/No Haiku summary on this request: fewer than 4 unsummarized messages/g) ?? [];
  // Totals row, turn row and the hit row.
  assert.equal(matches.length, 3);
});

test('a reason repeated across hits carries its count, and different reasons are all listed', () => {
  const html = render([
    hit(3, { compactionSkippedReason: 'cache is warm; compaction waits for a cold cache' }),
    hit(2, { compactionSkippedReason: 'cache is warm; compaction waits for a cold cache', newUserTurn: false }),
    hit(1, { compactionSkippedReason: 'fewer than 4 unsummarized messages', newUserTurn: false }),
  ]);
  assert.match(html, /cache is warm; compaction waits for a cold cache \(×2\); fewer than 4 unsummarized messages/);
});

test('a hit with no recorded reason keeps the plain tooltip', () => {
  assert.match(render([hit(1)]), /title="No Haiku summary on this request"/);
});

test('the arrow column is wider and centered, and Cached gave up the space', () => {
  const html = render([hit(1)]);
  const widths = [...(/<colgroup>([\s\S]*?)<\/colgroup>/.exec(html)?.[1] ?? '').matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 15);
  // Order: Date, Repo, Status, Turns, Hits, Raw, Cleanup, Summarized, Estimate, arrow, Received, CR, CW, RI, Billed.
  assert.ok(widths[9] > 3, 'arrow column should be wider than before');
  assert.ok(widths[11] + widths[12] + widths[13] < 23, 'CR, CW and RI together should have given space up');
  assert.ok(widths[0] >= 12, 'Date must fit the time');
  assert.match(html, /class="turn-arrow">→</);
});

test('the flow chart nests raw, received and billed in one bar, with cleanup and summary as lines; cache is split in tokens and units', async () => {
  const { historyChartsHtml } = await import('../ui/historyChart');
  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const html = historyChartsHtml([hit(1)], { start, end: start + 86_400_000 }, at);
  assert.equal((html.match(/<polyline /g) ?? []).length, 3);
  assert.match(html, /CR vs CW, t/);
  assert.match(html, /CR vs CW, billed u/);
  // The flow chart is the wide one.
  assert.match(html, /viewBox="0 0 1040 /);
});

test('the donut tooltips are one short sentence, not an essay', () => {
  const html = render([hit(1)]);
  const head = html.slice(html.indexOf('<div class="head">'), html.indexOf('<h2>Turns'));
  const titles = [...head.matchAll(/class="donut-block" title="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(titles.length, 2);
  for (const title of titles) {
    assert.ok(title.length <= 140, `tooltip too long: ${title.length}`);
  }
});

test('the Date and Repo filters are white so they stand out', async () => {
  const { BASE_STYLES } = await import('../ui/shared');
  assert.match(BASE_STYLES, /\.filter-th select, \.filter-th input \{ background: #fff;/);
});

test('the charts write their values on the bars and lines, and hourly labels read as times', async () => {
  const { historyChartsHtml } = await import('../ui/historyChart');
  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const html = historyChartsHtml([hit(1)], { start, end: start + 86_400_000 }, at);
  assert.match(html, /class="value"/);
  assert.match(html, /class="axis"[^>]*>\d\d:00</);
  // 94K raw shows as text, not only in the tooltip.
  assert.match(html, /class="value"[^>]*>94(\.0+)?K</);
});

test('chart labels never overlap: every figure drawn on a chart has its own space', async () => {
  const { historyChartsHtml } = await import('../ui/historyChart');
  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const entries = Array.from({ length: 6 }, (_, i) => hit(i * 7, { cacheReadTokens: 40_000_000 / (i + 1), rawTokens: 90_000 * (i + 1) }));
  const html = historyChartsHtml(entries, { start, end: start + 86_400_000 }, at);
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*class="value"[^>]*style="font-size:([\d.]+)px"[^>]*>([^<]*)</g)].map((m) => {
      const size = Number(m[3]);
      const w = m[4].length * size * 0.6;
      return { x: Number(m[1]) - w / 2, y: Number(m[2]) - size, w, h: size };
    });
    for (let i = 0; i < texts.length; i += 1) {
      for (let j = i + 1; j < texts.length; j += 1) {
        const a = texts[i];
        const b = texts[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!overlap, `labels ${i} and ${j} overlap`);
      }
    }
  }
});

test('the units chart tooltip shows the average rate that turned CR and CW tokens into units', async () => {
  const { historyChartsHtml } = await import('../ui/historyChart');
  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const html = historyChartsHtml([hit(1, { cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })], { start, end: start + 86_400_000 }, at);
  assert.match(html, /CR: [\d.]+K? u \(avg × [\d.]+\)/);
});

test('the CR, CW and RI headers each carry their own help icon', () => {
  const html = render([hit(1)]);
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  for (const abbr of ['CR', 'CW', 'RI']) {
    assert.match(head, new RegExp(`<th class="cache-col">${abbr}<[^>]*help`));
  }
  assert.match(head, /Cache read:/);
  assert.match(head, /Cache write:/);
  assert.match(head, /Regular input:/);
});

test('every chart tooltip names one value: hovering a part never lists the others', async () => {
  const { historyChartsHtml } = await import('../ui/historyChart');
  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const html = historyChartsHtml([hit(1, { cacheReadTokens: 1_000_000 })], { start, end: start + 86_400_000 }, at);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.ok(titles.length > 0);
  for (const title of titles) {
    // A period line, and at most one "name: value" line under it.
    const valueLines = title.split(/\n|&#10;/).filter((line) => /: [\d.]+[KMB]? [tu]/.test(line));
    assert.ok(valueLines.length <= 1, `tooltip lists several values: ${title}`);
  }
  // The parts are hoverable: bars and line points each carry a tooltip with their own name.
  assert.ok(titles.some((t) => /CR: /.test(t)));
  assert.ok(titles.some((t) => /Raw: /.test(t)));
  assert.ok(titles.some((t) => /Cleanup removed: /.test(t)));
  assert.ok(titles.some((t) => /Summarized removed: /.test(t)));
});

test('no tooltip or help text of the panel or its charts is longer than 100 characters', async () => {
  const { historyChartsHtml } = await import('../ui/historyChart');
  const entries = [
    hit(3, { compactionTriggered: true, prunedByCompaction: 40_000, summarizerUnitCost: 5_000, cacheReadTokens: 500_000 }),
    hit(2, { summaryReused: true, prunedByCompaction: 40_000, newUserTurn: false }),
    hit(1, { compactionSkippedReason: 'fewer than 4 unsummarized messages', newUserTurn: false, status: 0, failure: 'socket hang up' }),
  ];
  const at = new Date();
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const html = render(entries) + historyChartsHtml(entries, { start, end: start + 86_400_000 }, at);
  const decode = (text: string): string => text.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  const texts = [...html.matchAll(/(?:title|data-tooltip)="([^"]*)"|<title>([^<]*)<\/title>/g)].map((m) => decode(m[1] ?? m[2] ?? ''));
  assert.ok(texts.length > 20);
  for (const text of texts) {
    // A chart tooltip is a period line plus one value line; each line is held to the limit.
    for (const line of text.split('\n')) {
      assert.ok(line.length <= 100, `tooltip line of ${line.length} chars: ${line}`);
    }
  }
});
