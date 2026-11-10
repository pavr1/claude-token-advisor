/** Terminals: the key a ledger row carries, the `Terminal #N` numbers, and how the turns table groups and labels by them. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createClientResolver, describeChain, ProcessInfo, shellPidOfKey, terminalKeyOf } from '../proxy/clientProcess';
import { computeTurnCost, groupTurns, LedgerEntry } from '../analytics/tracker';
import type { OptimizationTelemetry } from '../proxy/optimizer';
import { ALL, buildAnalyticsSectionHtml, sourceSub } from '../ui/analyticsPanel';
import { AnalyticsTracker } from '../analytics/tracker';
import { describeTerminals, liveTerminalPids, setLiveTerminalPids, terminalLabel } from '../ui/terminals';

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// ── the key ────────────────────────────────────────────────────────────────

test('terminalKeyOf joins the shell pid and its start time; an unknown start is 0', () => {
  assert.equal(terminalKeyOf(45636, 1_762_300_000_123), '45636@1762300000123');
  assert.equal(terminalKeyOf(45636, undefined), '45636@0');
  assert.equal(terminalKeyOf(45636, 0), '45636@0');
});

test('shellPidOfKey reads the pid back and refuses what is not a key', () => {
  assert.equal(shellPidOfKey('45636@1762300000123'), 45636);
  assert.equal(shellPidOfKey(undefined), undefined);
  assert.equal(shellPidOfKey('abc@1'), undefined);
  assert.equal(shellPidOfKey('0@1'), undefined);
});

test('describeChain keys the terminal by the shell above claude, start time included', () => {
  const table = new Map<number, ProcessInfo>([
    [1, { name: 'Code.exe', parent: 0, start: 10 }],
    [3, { name: 'powershell.exe', parent: 1, start: 5_000 }],
    [4, { name: 'claude.exe', parent: 3, start: 6_000 }],
  ]);
  assert.equal(describeChain(4, table, 1).terminalKey, '3@5000');
});

test('two terminals that reuse a pid get different keys because their start times differ', () => {
  const first = new Map<number, ProcessInfo>([
    [3, { name: 'powershell.exe', parent: 1, start: 5_000 }],
    [4, { name: 'claude.exe', parent: 3, start: 6_000 }],
  ]);
  const later = new Map<number, ProcessInfo>([
    [3, { name: 'powershell.exe', parent: 1, start: 9_000 }],
    [4, { name: 'claude.exe', parent: 3, start: 9_500 }],
  ]);
  assert.notEqual(describeChain(4, first, 1).terminalKey, describeChain(4, later, 1).terminalKey);
});

test('with no claude process above the socket owner there is no terminal key', () => {
  const table = new Map<number, ProcessInfo>([[3, { name: 'powershell.exe', parent: 1, start: 5_000 }]]);
  assert.equal(describeChain(3, table, 1).terminalKey, undefined);
});

// ── numbering ───────────────────────────────────────────────────────────────

const entries = [
  { terminalKey: '10@1', timestamp: at(60) },
  { terminalKey: '20@2', timestamp: at(40) },
  { terminalKey: '30@3', timestamp: at(20) },
  { terminalKey: '30@3', timestamp: at(5) },
  { timestamp: at(1) }, // a row from before terminals were recorded
];

test('open terminals are numbered from 1, oldest first', () => {
  const info = describeTerminals(entries, new Set([10, 20, 30]));
  assert.deepEqual([...info.values()].map((t) => [t.key, t.number]), [['10@1', 1], ['20@2', 2], ['30@3', 3]]);
});

test('closing a terminal renumbers the rest and the closed one has no number', () => {
  const info = describeTerminals(entries, new Set([10, 30]));
  assert.equal(info.get('10@1')?.number, 1);
  assert.equal(info.get('20@2')?.number, undefined);
  assert.equal(info.get('30@3')?.number, 2);
  assert.equal(terminalLabel(info.get('20@2')), 'Terminal (closed)');
  assert.equal(terminalLabel(info.get('30@3')), 'Terminal #2');
});

test('rows without a terminal are not terminals', () => {
  assert.equal(describeTerminals([{ timestamp: at(1) }], new Set([1])).size, 0);
});

test('a reused pid numbers only its newest terminal; the older one died before the pid came back', () => {
  const info = describeTerminals(
    [
      { terminalKey: '10@1', timestamp: at(90) },
      { terminalKey: '10@9', timestamp: at(10) },
    ],
    new Set([10])
  );
  assert.equal(info.get('10@1')?.number, undefined);
  assert.equal(info.get('10@9')?.number, 1);
});

// ── grouping ────────────────────────────────────────────────────────────────

function hit(over: Partial<LedgerEntry>): LedgerEntry {
  return { timestamp: at(1), project: 'skills-app', newUserTurn: true, ...over } as unknown as LedgerEntry;
}

test('groupTurns carries the terminal on every turn and ping, whatever the chat', () => {
  const groups = groupTurns([
    hit({ sessionId: 'aaaa1111', terminalKey: '45636@7' }),
    hit({ sessionId: 'bbbb2222', terminalKey: '45636@7' }), // /clear: new chat, same terminal
    hit({ sessionId: 'bbbb2222', terminalKey: '45636@7', routingReason: 'cache keep-alive ping', rawTokens: 1 }),
  ]);
  assert.ok(groups.every((g) => g.terminalKey === '45636@7'));
});

test('a row from before terminals were recorded keeps no terminal', () => {
  assert.equal(groupTurns([hit({ sessionId: 'aaaa1111' })])[0].terminalKey, undefined);
});

// ── labels ──────────────────────────────────────────────────────────────────

test('a turn in an open terminal reads "Terminal #N" and the hover names the chat', () => {
  const terminals = describeTerminals([{ terminalKey: '45636@7', timestamp: at(1) }], new Set([45636]));
  const html = sourceSub({ sessionId: '2710abcd-0000-0000-0000-000000000000', terminalKey: '45636@7' }, terminals);
  assert.match(html, />Terminal #1</);
  assert.match(html, /title="chat 2710 · Claude Code chat 2710abcd-0000-0000-0000-000000000000"/);
});

test('a closed terminal says so, in the label and the hover', () => {
  const terminals = describeTerminals([{ terminalKey: '45636@7', timestamp: at(1) }], new Set());
  const html = sourceSub({ sessionId: '2710abcd-0000', terminalKey: '45636@7' }, terminals);
  assert.match(html, />Terminal \(closed\)</);
  assert.match(html, /no longer open/);
});

test('a row from before terminals were recorded still shows its chat', () => {
  const html = sourceSub({ sessionId: '2710abcd-0000' }, undefined);
  assert.match(html, />chat 2710</);
  assert.doesNotMatch(html, /Terminal/);
});

test('a ping names its terminal after its own label', () => {
  const terminals = describeTerminals([{ terminalKey: '45636@7', timestamp: at(1) }], new Set([45636]));
  assert.match(sourceSub({ sessionId: 'x', terminalKey: '45636@7' }, terminals, 'Ping'), />Ping · Terminal #1</);
  assert.match(sourceSub({}, undefined, 'Ping'), />Ping</);
});

// ── the table and its filter ───────────────────────────────────────────────

const tracker = (list: LedgerEntry[]): AnalyticsTracker => ({ getEntries: () => list }) as unknown as AnalyticsTracker;
const TEL: OptimizationTelemetry = {
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
};

/** A complete ledger row, priced the way the extension prices it. */
const full = (over: Partial<LedgerEntry>): LedgerEntry =>
  ({
    timestamp: at(1),
    project: 'skills-app',
    requestedModel: TEL.originalModel,
    servedModel: TEL.effectiveModel,
    modelSwapped: false,
    rawTokens: TEL.rawTokens,
    optimizedTokens: TEL.optimizedTokens,
    prunedByNormalization: TEL.prunedByNormalization,
    prunedByCompaction: TEL.prunedByCompaction,
    compactionTriggered: false,
    cacheAnchorPlaced: true,
    newUserTurn: true,
    status: 200,
    ...computeTurnCost(TEL, { input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 500, output_tokens: 50 }),
    ...over,
  }) as unknown as LedgerEntry;

test('the table offers a Terminal filter and the filter keeps only that terminal, pings included', () => {
  const list = [
    full({ project: 'skills-app', sessionId: 'aaaa1111', terminalKey: '111@1', timestamp: at(30) }),
    full({ project: 'skills-app', sessionId: 'aaaa1111', terminalKey: '111@1', routingReason: 'cache keep-alive ping', timestamp: at(20) }),
    full({ project: 'skills-app', sessionId: 'bbbb2222', terminalKey: '222@2', timestamp: at(10) }),
  ];
  const all = buildAnalyticsSectionHtml(tracker(list), { project: ALL, range: 'today' });
  assert.doesNotMatch(all, /<select id="terminal"/);
  assert.match(all, /aaaa|chat aaaa|Terminal/);
  const only = buildAnalyticsSectionHtml(tracker(list), { project: ALL, range: 'today', terminal: '111@1' });
  assert.doesNotMatch(only, /chat bbbb/);
  assert.match(only, /Ping/);
});

// ── the live set and the resolver ──────────────────────────────────────────

test('the open terminals are whatever the extension last reported', () => {
  setLiveTerminalPids([7, 8]);
  assert.deepEqual([...liveTerminalPids()].sort(), [7, 8]);
  setLiveTerminalPids([]);
  assert.equal(liveTerminalPids().size, 0);
});

const NETSTAT = '  TCP    127.0.0.1:59701        127.0.0.1:4000         ESTABLISHED     4\r\n';
const TABLE = new Map<number, ProcessInfo>([
  [3, { name: 'powershell.exe', parent: 1, start: 5_000 }],
  [4, { name: 'claude.exe', parent: 3, start: 6_000 }],
]);

test('the resolver finds the terminal of a source port and answers the same port from its cache', async () => {
  let reads = 0;
  const resolve = createClientResolver({ platform: 'win32', netstat: async () => (reads++, NETSTAT), table: async () => TABLE });
  assert.equal((await resolve(59701, 4000))?.terminalKey, '3@5000');
  assert.equal((await resolve(59701, 4000))?.terminalKey, '3@5000');
  assert.equal(reads, 1, 'the second request did not read the machine again');
});

test('a cached answer is dropped after a while, because the OS reuses source ports', async () => {
  let clock = 0;
  let reads = 0;
  const resolve = createClientResolver({ platform: 'win32', now: () => clock, netstat: async () => (reads++, NETSTAT), table: async () => TABLE });
  await resolve(59701, 4000);
  clock = 200_000;
  await resolve(59701, 4000);
  assert.equal(reads, 2);
});

test('a port that is not listed, or whose process has no terminal above it, is looked up again next time', async () => {
  let reads = 0;
  const unlisted = createClientResolver({ platform: 'win32', netstat: async () => (reads++, ''), table: async () => TABLE });
  assert.equal(await unlisted(59701, 4000), undefined);
  assert.equal(await unlisted(59701, 4000), undefined);
  assert.equal(reads, 2);

  let tableReads = 0;
  const noClaude = createClientResolver({
    platform: 'win32',
    netstat: async () => NETSTAT,
    table: async () => (tableReads++, new Map<number, ProcessInfo>([[4, { name: 'node.exe', parent: 1 }]])),
  });
  assert.equal((await noClaude(59701, 4000))?.terminalKey, undefined);
  await noClaude(59701, 4000);
  assert.equal(tableReads, 2);
});

test('the resolver gives nothing off Windows, and nothing when the machine cannot be read', async () => {
  assert.equal(await createClientResolver({ platform: 'linux' })(1, 2), undefined);
  const broken = createClientResolver({ platform: 'win32', netstat: async () => Promise.reject(new Error('no netstat')) });
  assert.equal(await broken(59701, 4000), undefined);
});

test('the resolver forgets its oldest ports past its limit and keeps working', async () => {
  const resolve = createClientResolver({ platform: 'win32', netstat: async () => NETSTAT, table: async () => TABLE });
  for (let port = 1; port <= 205; port += 1) {
    await resolve(port, 4000);
  }
  assert.equal((await resolve(59701, 4000))?.terminalKey, '3@5000');
});


test('a terminal of another VS Code window is open while its shell runs, and numbered with the others', () => {
  const entries = [
    { terminalKey: '10@1', timestamp: at(3) },
    { terminalKey: '20@2', timestamp: at(2) },
    { terminalKey: '30@3', timestamp: at(1) },
  ];
  // 10 is in this window, 20 runs in another one, 30 is gone.
  const info = describeTerminals(entries, new Set([10]), (key) => key === '20@2');
  assert.equal(terminalLabel(info.get('10@1')), 'Terminal #1');
  assert.equal(terminalLabel(info.get('20@2')), 'Terminal #2');
  assert.equal(terminalLabel(info.get('30@3')), 'Terminal (closed)');
});
