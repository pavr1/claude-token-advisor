/**
 * Windows that do not own the proxy read the same ledger files the owner appends to. They must
 * pick up the owner's writes from disk, not only from its event stream, so their numbers match.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { AnalyticsTracker, LedgerEntry } from '../analytics/tracker';
import { RealCostTracker } from '../analytics/realCostTracker';

function turn(minutesAgo: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    project: 'core-banking',
    requestedModel: 'claude-sonnet-5',
    servedModel: 'claude-sonnet-5',
    modelSwapped: false,
    rawTokens: 1_000,
    optimizedTokens: 800,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    compactionTriggered: false,
    cacheAnchorPlaced: false,
    uncachedInputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5,
    baselineUnitCost: 100,
    actualUnitCost: 50,
    savingsPercent: 50,
    ...over,
  } as LedgerEntry;
}

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'improver-sync-'));

test('a follower window sees what the owner appended, without any event from it', async () => {
  const dir = tempDir();
  const owner = new AnalyticsTracker(dir);
  const follower = new AnalyticsTracker(dir);
  follower.load();
  assert.equal(follower.getEntries().length, 0);
  assert.equal(follower.refreshIfChanged(), false, 'nothing changed yet');

  owner.record(turn(2));
  owner.record(turn(1));
  await owner.drain();

  assert.equal(follower.refreshIfChanged(), true);
  assert.equal(follower.getEntries().length, 2);
  // Idempotent: the same disk state is not reloaded again.
  assert.equal(follower.refreshIfChanged(), false);

  owner.record(turn(0));
  await owner.drain();
  assert.equal(follower.refreshIfChanged(), true);
  assert.equal(follower.getEntries().length, 3);
});

test('refreshIfChanged does nothing before the first load', () => {
  const tracker = new AnalyticsTracker(tempDir());
  assert.equal(tracker.refreshIfChanged(), false);
});

test('a follower that missed events catches up on every row at once', async () => {
  const dir = tempDir();
  const owner = new AnalyticsTracker(dir);
  const follower = new AnalyticsTracker(dir);
  follower.load();
  for (let i = 0; i < 25; i++) {
    owner.record(turn(30 - i));
  }
  await owner.drain();
  assert.equal(follower.refreshIfChanged(), true);
  assert.equal(follower.getEntries().length, 25);
});

test('the real-cost store follows another window the same way', async () => {
  const dir = tempDir();
  const owner = new RealCostTracker(dir);
  const follower = new RealCostTracker(dir);
  follower.load();
  assert.equal(follower.refreshIfChanged(), false);

  owner.record({ seriesKey: 'a', timestampMs: Date.now() - 1_000, valueUsd: 0.5, temporality: 'cumulative' });
  await owner.drain();

  assert.equal(follower.refreshIfChanged(), true);
  assert.equal(follower.totalUsdInRange(0, Date.now() + 1_000), 0.5);
  assert.equal(follower.refreshIfChanged(), false);
});

test('the real-cost store does not reload before it was loaded', () => {
  assert.equal(new RealCostTracker(tempDir()).refreshIfChanged(), false);
});
