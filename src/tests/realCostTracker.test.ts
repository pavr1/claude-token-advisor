/**
 * Unit tests for `RealCostTracker`: persistence, running-total tracking per series
 * (advancing on a normal cumulative reading, banking on a meter reset, summing a
 * delta series), and range totals.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { accountIdFromSeriesKey, REAL_COST_FILENAME, RealCostTracker, realCostSeriesKey } from '../analytics/realCostTracker';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'improver-real-cost-'));
}

test('realCostSeriesKey is stable regardless of attribute order', () => {
  const a = realCostSeriesKey({ 'user.account_uuid': 'u1', 'session.id': 's1' });
  const b = realCostSeriesKey({ 'session.id': 's1', 'user.account_uuid': 'u1' });
  assert.equal(a, b);
});

test('records round-trip through disk', async () => {
  const dir = tempDir();
  const writer = new RealCostTracker(dir);
  writer.record({ seriesKey: 'a', timestampMs: 1_000, valueUsd: 0.5, temporality: 'cumulative' });
  await writer.drain();

  assert.ok(fs.existsSync(path.join(dir, REAL_COST_FILENAME)));

  const reader = new RealCostTracker(dir);
  assert.equal(reader.totalUsdInRange(0, 2_000), 0.5);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a newer reading for the same series replaces the older one instead of summing', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 2_000, valueUsd: 0.35, temporality: 'cumulative' });

  assert.equal(tracker.totalUsdInRange(0, 3_000), 0.35);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an out-of-order (older) reading for the same series is ignored', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({ seriesKey: 'session-1', timestampMs: 2_000, valueUsd: 0.35, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });

  assert.equal(tracker.totalUsdInRange(0, 3_000), 0.35);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('totalUsdInRange sums the latest reading of every series that falls in range', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-2', timestampMs: 1_500, valueUsd: 0.3, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-3', timestampMs: 9_000, valueUsd: 100, temporality: 'cumulative' }); // out of range

  assert.ok(Math.abs((tracker.totalUsdInRange(0, 2_000) ?? 0) - 0.5) < 1e-9);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('totalUsdInRange returns undefined when nothing falls in range', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });

  assert.equal(tracker.totalUsdInRange(5_000, 6_000), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt store file starts empty instead of throwing', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, REAL_COST_FILENAME), '{ not json', 'utf8');

  const tracker = new RealCostTracker(dir);
  assert.equal(tracker.totalUsdInRange(0, Number.MAX_SAFE_INTEGER), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('accountIdFromSeriesKey prefers account_id, then account_uuid, then email', () => {
  assert.equal(
    accountIdFromSeriesKey(realCostSeriesKey({ 'user.account_id': 'acc-1', 'user.account_uuid': 'uuid-1' })),
    'acc-1'
  );
  assert.equal(accountIdFromSeriesKey(realCostSeriesKey({ 'user.account_uuid': 'uuid-1' })), 'uuid-1');
  assert.equal(accountIdFromSeriesKey(realCostSeriesKey({ 'user.email': 'a@b.com' })), 'a@b.com');
  assert.equal(accountIdFromSeriesKey(realCostSeriesKey({ 'session.id': 's1' })), undefined);
});

test('currentAccountId is the account behind the single most recent reading', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'enterprise', 'session.id': 's1' }),
    timestampMs: 1_000,
    valueUsd: 50, temporality: 'cumulative',
  });
  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'personal-pro', 'session.id': 's2' }),
    timestampMs: 2_000,
    valueUsd: 0.3, temporality: 'cumulative',
  });

  assert.equal(tracker.currentAccountId(), 'personal-pro');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentAccountTotalUsdInRange excludes readings from a different, previously-active account', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  // A prior Enterprise seat, exhausted mid-month...
  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'enterprise', 'session.id': 's1' }),
    timestampMs: 1_000,
    valueUsd: 300, temporality: 'cumulative',
  });
  // ...then a switch to a personal Pro account for the rest of the month.
  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'personal-pro', 'session.id': 's2' }),
    timestampMs: 2_000,
    valueUsd: 0.3, temporality: 'cumulative',
  });

  // The old Enterprise seat's $300 must not leak into the currently-active account's total.
  assert.equal(tracker.currentAccountTotalUsdInRange(0, 3_000), 0.3);
  // But it's still reachable when asked for explicitly.
  assert.equal(tracker.totalUsdInRangeForAccount(0, 3_000, 'enterprise'), 300);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentAccountTotalUsdInRange falls back to summing everything when nothing is account-tagged', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-2', timestampMs: 1_500, valueUsd: 0.3, temporality: 'cumulative' });

  assert.ok(Math.abs((tracker.currentAccountTotalUsdInRange(0, 2_000) ?? 0) - 0.5) < 1e-9);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentAccountEmail is the email of the currently active account, for display', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'enterprise', 'user.email': 'me@work.com', 'session.id': 's1' }),
    timestampMs: 1_000,
    valueUsd: 50, temporality: 'cumulative',
  });
  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'personal-pro', 'user.email': 'me@personal.com', 'session.id': 's2' }),
    timestampMs: 2_000,
    valueUsd: 0.3, temporality: 'cumulative',
  });

  assert.equal(tracker.currentAccountEmail(), 'me@personal.com');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentAccountEmail is undefined when no reading is account-tagged', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });

  assert.equal(tracker.currentAccountEmail(), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('distinctAccountIds lists every account seen, most-recently-active first', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'enterprise', 'session.id': 's1' }),
    timestampMs: 1_000,
    valueUsd: 300, temporality: 'cumulative',
  });
  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'personal-pro', 'session.id': 's2' }),
    timestampMs: 2_000,
    valueUsd: 0.3, temporality: 'cumulative',
  });

  assert.deepEqual(tracker.distinctAccountIds(), ['personal-pro', 'enterprise']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('active identity pins totals to the signed-in account even when another account reported last', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_uuid': 'uuid-pro', 'user.email': 'me@pro.com', 'session.id': 's1' }),
    timestampMs: 1_000,
    valueUsd: 2, temporality: 'cumulative',
  });
  tracker.ingest({
    seriesKey: realCostSeriesKey({ 'user.account_id': 'enterprise', 'session.id': 's2' }),
    timestampMs: 2_000,
    valueUsd: 50, temporality: 'cumulative',
  });
  tracker.ingest({ seriesKey: realCostSeriesKey({ 'session.id': 'untagged' }), timestampMs: 2_500, valueUsd: 9, temporality: 'cumulative' });

  // Without an identity the latest reading (enterprise) wins — the old inference.
  assert.equal(tracker.currentAccountTotalUsdInRange(0, 3_000), 50);

  tracker.setActiveIdentity({ identifiers: ['uuid-pro', 'me@pro.com'], email: 'me@pro.com' });
  assert.equal(tracker.currentAccountTotalUsdInRange(0, 3_000), 2);
  assert.equal(tracker.currentAccountEmail(), 'me@pro.com');
  assert.equal(tracker.earliestTimestampMs(), 1_000);

  // Switching accounts re-scopes immediately; untagged readings never count.
  tracker.setActiveIdentity({ identifiers: ['enterprise'] });
  assert.equal(tracker.currentAccountTotalUsdInRange(0, 3_000), 50);

  // An account with no readings yet reports nothing rather than another account's spend.
  tracker.setActiveIdentity({ identifiers: ['brand-new'] });
  assert.equal(tracker.currentAccountTotalUsdInRange(0, 3_000), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cumulative series whose raw value drops (meter reset) banks the prior total instead of losing it', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  // Matches a real observation: the exporter's raw reading went 0.2 -> 0.35 (one
  // cycle), then dropped to 0.1 (a new cycle, same session/model/effort attributes).
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.2, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 2_000, valueUsd: 0.35, temporality: 'cumulative' });
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 3_000, valueUsd: 0.1, temporality: 'cumulative' });

  // Banked: 0.35 (first cycle) + 0.1 (second cycle so far) = 0.45, not 0.1.
  assert.ok(Math.abs((tracker.totalUsdInRange(0, 4_000) ?? 0) - 0.45) < 1e-9);

  // The new cycle keeps advancing normally from its own baseline.
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 4_000, valueUsd: 0.3, temporality: 'cumulative' });
  assert.ok(Math.abs((tracker.totalUsdInRange(0, 5_000) ?? 0) - 0.65) < 1e-9);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a delta series sums every reading instead of replacing', () => {
  const dir = tempDir();
  const tracker = new RealCostTracker(dir);

  tracker.ingest({ seriesKey: 'session-1', timestampMs: 1_000, valueUsd: 0.05, temporality: 'delta' });
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 2_000, valueUsd: 0.03, temporality: 'delta' });
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 3_000, valueUsd: 0.07, temporality: 'delta' });

  assert.ok(Math.abs((tracker.totalUsdInRange(0, 4_000) ?? 0) - 0.15) < 1e-9);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a v1-shaped stored file (cumulativeUsd only) migrates without losing its total, then keeps tracking correctly', () => {
  const dir = tempDir();
  const filePath = path.join(dir, REAL_COST_FILENAME);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      series: { 'session-1': { timestampMs: 1_000, cumulativeUsd: 0.35 } },
    }),
    'utf8'
  );

  const tracker = new RealCostTracker(dir);
  assert.equal(tracker.totalUsdInRange(0, 2_000), 0.35);

  // A subsequent cumulative reading above the migrated value advances normally.
  tracker.ingest({ seriesKey: 'session-1', timestampMs: 2_000, valueUsd: 0.5, temporality: 'cumulative' });
  assert.ok(Math.abs((tracker.totalUsdInRange(0, 3_000) ?? 0) - 0.5) < 1e-9);

  fs.rmSync(dir, { recursive: true, force: true });
});
