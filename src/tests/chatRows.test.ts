/** The turns table: one row per Enter in Claude Code (its turn, holding its hits), and a row of its own for each keep-alive ping. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { inFlightRequests } from '../analytics/inflight';
import { AnalyticsTracker, groupTurns, LedgerEntry } from '../analytics/tracker';
import { ALL, buildAnalyticsSectionHtml } from '../ui/analyticsPanel';

function hit(minutesAgo: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    project: 'repo',
    requestedModel: 'claude-sonnet-5',
    servedModel: 'claude-sonnet-5',
    modelSwapped: false,
    rawTokens: 50_000,
    optimizedTokens: 40_000,
    prunedByNormalization: 1_000,
    prunedByCompaction: 0,
    compactionTriggered: false,
    cacheAnchorPlaced: true,
    newUserTurn: true,
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

const cellsOf = (html: string): string[] => html.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];

const render = (entries: LedgerEntry[]): string =>
  buildAnalyticsSectionHtml({ getEntries: () => entries } as unknown as AnalyticsTracker, { project: ALL, range: 'today' });

test('turns of different chats in one repo are separate, and a chat keeps its hits in the turn they belong to', () => {
  const turns = groupTurns([
    hit(30, { sessionId: 'aaaa' }),
    hit(29, { sessionId: 'bbbb' }),
    hit(28, { sessionId: 'aaaa', newUserTurn: false }),
    hit(20, { sessionId: 'aaaa' }),
  ]);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => [t.sessionId, t.entries.length]), [['aaaa', 2], ['bbbb', 1], ['aaaa', 1]]);
});

test('every Enter is its own row of the table, and no row gathers the turns of earlier Enters', () => {
  const html = render([
    hit(10, { sessionId: 'aaaa1111' }),
    hit(9, { sessionId: 'aaaa1111', newUserTurn: false }),
    hit(5, { sessionId: 'aaaa1111' }),
    hit(4, { sessionId: 'bbbb2222' }),
  ]);
  assert.doesNotMatch(html, /chat-row/);
  assert.match(html, /chat aaaa/);
  const turnRows = [...html.matchAll(/<tr data-row="(repo#\d+)" data-toggle="repo#\d+">/g)];
  assert.equal(turnRows.length, 3);
  // Each hit hangs from its own turn row; there is no chat level above them.
  const hitRows = html.match(/class="hit-row" data-row="[^"]+" data-parent="repo#[0-9]+"/g) ?? [];
  assert.equal(hitRows.length, 4);
  assert.doesNotMatch(html, /data-ancestors/);
  // The first Enter has 2 hits, and its row says 1 turn and 2 hits.
  const first = html.slice(html.indexOf('data-row="repo#1"'));
  const cells = cellsOf(first);
  assert.match(cells[3], />1</);
  assert.match(cells[4], />2</);
});

test('a keep-alive ping is a row of its own, one turn and one hit, and never joins or splits the turn of a prompt', () => {
  const ping = (minutesAgo: number): LedgerEntry =>
    hit(minutesAgo, { sessionId: 'aaaa1111', newUserTurn: false, routingReason: 'cache keep-alive ping', outputTokens: 1, rawTokens: 40_000, optimizedTokens: 40_000, prunedByNormalization: 0 });
  const entries = [hit(20, { sessionId: 'aaaa1111' }), ping(15), hit(10, { sessionId: 'aaaa1111', newUserTurn: false })];
  const turns = groupTurns(entries);
  // The prompt keeps both of its real hits, with the ping standing between them as its own turn.
  assert.deepEqual(turns.map((t) => [t.ping === true, t.entries.length]), [[false, 2], [true, 1]]);
  const html = render(entries);
  assert.equal((html.match(/class="ping-row"/g) ?? []).length, 1);
  assert.match(html, /class="ping-icon"/);
  assert.match(html, /Ping<\/div>/);
  const row = html.slice(html.indexOf('class="ping-row"'));
  const cells = cellsOf(row);
  assert.match(cells[3], />1</);
  assert.match(cells[4], />1</);
  // A ping has nothing to expand, and the prompt's row counts only its own two hits.
  assert.doesNotMatch(row.slice(0, row.indexOf('</tr>')), /data-toggle/);
  // A ping carries no colour: its figures are never tinted, while the prompt's own row still is.
  const pingHtml = row.slice(0, row.indexOf('</tr>'));
  assert.doesNotMatch(pingHtml, /background:rgba/);
  assert.doesNotMatch(pingHtml, /style="color:/);
  const prompt = html.slice(html.indexOf('data-row="repo#1"'));
  assert.match(cellsOf(prompt)[4], />2</);
});

test('a request that arrives after a ping starts its own live row above the ping, not inside the older turn', () => {
  const entries = [
    hit(20, { sessionId: 'aaaa1111' }),
    hit(5, { sessionId: 'aaaa1111', newUserTurn: false, routingReason: 'cache keep-alive ping', outputTokens: 1 }),
  ];
  inFlightRequests.start('repo', false, Date.now(), 'p1', 'aaaa1111');
  const html = render(entries);
  inFlightRequests.finish('repo');
  // The older turn (#1) stays finished; the live row is a third row (#3), after the turn and the ping.
  assert.match(html, /<tr class="turn-live" data-row="repo#3"/);
  const older = html.slice(html.indexOf('data-row="repo#1" data-toggle'), html.indexOf('data-row="repo#1" data-toggle') + 200);
  assert.doesNotMatch(older, /turn-live/);
  assert.ok(html.indexOf('data-row="repo#3"') < html.indexOf('class="ping-row"'), 'the live row sits above the ping');
});

test('a request after a finished turn is one more hit of it, and the turn stays done', () => {
  const entries = [hit(20, { sessionId: 'aaaa1111', stopReason: 'end_turn' })];
  inFlightRequests.start('repo', false, Date.now(), 'p2', 'aaaa1111');
  const html = render(entries);
  inFlightRequests.finish('repo');
  const row = html.slice(html.indexOf('data-row="repo#1" data-toggle'));
  assert.doesNotMatch(row.slice(0, row.indexOf('</tr>')), /turn-live/);
  assert.match(html, /data-row="repo#1\/L0"/, 'the request is not lost: it hangs from its turn as a live hit');
  assert.doesNotMatch(html, /data-row="repo#2"/, 'and it does not open a row of its own');
});

test('a turn still waiting on tools goes back to in progress, and moves to the top with its new time', () => {
  const entries = [
    hit(20, { sessionId: 'aaaa1111', stopReason: 'tool_use' }),
    hit(10, { sessionId: 'bbbb2222', stopReason: 'end_turn' }),
  ];
  inFlightRequests.start('repo', false, Date.now(), 'p3', 'aaaa1111');
  const html = render(entries);
  inFlightRequests.finish('repo');
  assert.match(html, /<tr class="turn-live" data-row="repo#1"/);
  assert.ok(html.indexOf('data-row="repo#1" data-toggle') < html.indexOf('data-row="repo#2" data-toggle'), 'the older turn with a newer time sorts first');
});

test('the arrow flies on a turn row for every hit in flight once its estimate is known, not only the first', () => {
  const entries = [hit(2, { sessionId: 'aaaa1111' })];
  inFlightRequests.start('repo', false, Date.now(), 'r1');
  const before = render(entries);
  assert.doesNotMatch(before, /arrow-fly/);
  inFlightRequests.optimized('repo', { rawTokens: 50_000, optimizedTokens: 40_000, prunedByNormalization: 0, prunedByCompaction: 0 }, 'r1');
  const during = render(entries);
  // The turn row (a second hit in an existing turn) and the live hit row both show it.
  assert.ok((during.match(/arrow-fly/g) ?? []).length >= 2, `arrows: ${(during.match(/arrow-fly/g) ?? []).length}`);
  inFlightRequests.finish('repo');
});

test('a turn is tinted by its hits: red when all are red, green when all are green, amber when it has both', () => {
  const AMBER = 'rgba(242,184,75,0.32)';
  const RED = 'rgba(229,83,75,0.16)';
  const GREEN = 'rgba(63,185,80,0.16)';
  const turn = (hits: Array<Partial<LedgerEntry>>, session: string): LedgerEntry[] =>
    hits.map((over, i) => hit(10 - i, { sessionId: session, newUserTurn: i === 0, ...over }));
  // The tokens line of the first cache cell (CR) of the turn row.
  const tokensTint = (entries: LedgerEntry[]): string => {
    const html = render(entries);
    const start = html.indexOf('data-row="repo#1" data-toggle');
    const row = html.slice(start, html.indexOf('</tr>', start));
    const cell = row.slice(row.indexOf('<td class="cache-col">'));
    return /rgba\(\d+,\d+,\d+,[\d.]+\)/.exec(cell.slice(0, cell.indexOf('</div>')))?.[0] ?? 'none';
  };
  const green = { cacheReadTokens: 100_000, cacheWriteTokens: 0 };
  const red = { cacheReadTokens: 1_000, cacheWriteTokens: 20_000 };

  assert.equal(tokensTint(turn([green, { ...green }], 'aaaa1111')), GREEN, 'all hits green');
  assert.equal(tokensTint(turn([red, { ...red }], 'bbbb2222')), RED, 'all hits red');
  assert.equal(tokensTint(turn([green, red], 'cccc3333')), AMBER, 'a green hit and a red hit, total green');
  // Total red (writes outweigh reads over the turn) but one hit is green: still amber, not red.
  assert.equal(tokensTint(turn([{ cacheReadTokens: 10_000, cacheWriteTokens: 0 }, { cacheReadTokens: 1_000, cacheWriteTokens: 30_000 }], 'dddd4444')), AMBER, 'a green hit and a red hit, total red');

  // The explanation is in the tooltip, and the hits keep their own colours.
  const mixed = render(turn([green, red], 'eeee5555'));
  assert.match(mixed, /Amber: this turn has hits that wrote more than they read/);
  assert.ok(mixed.slice(mixed.indexOf('class="hit-row"')).includes(RED));
  assert.ok(mixed.slice(mixed.indexOf('class="hit-row"')).includes(GREEN));
});
