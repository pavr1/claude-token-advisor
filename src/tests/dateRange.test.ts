/** Date filter bounds of the Turns table. All bounds are local-day boundaries, end exclusive. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RANGE_LABELS, resolveRange } from '../ui/dateRange';

const NOW = new Date(2026, 9, 21, 15, 30); // 21 Oct 2026, local
const day = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();
const bounds = (r: { start: number; end: number }): [number, number] => [r.start, r.end];

test('every range id has a label', () => {
  assert.deepEqual(Object.keys(RANGE_LABELS).sort(), ['7d', 'custom', 'lastMonth', 'month', 'today', 'yesterday']);
});

test('today, yesterday and the last 7 days are whole local days', () => {
  assert.deepEqual(bounds(resolveRange({ range: 'today' }, NOW)), [day(2026, 9, 21), day(2026, 9, 22)]);
  assert.deepEqual(bounds(resolveRange({ range: 'yesterday' }, NOW)), [day(2026, 9, 20), day(2026, 9, 21)]);
  // Seven days including today.
  assert.deepEqual(bounds(resolveRange({ range: '7d' }, NOW)), [day(2026, 9, 15), day(2026, 9, 22)]);
});

test('this month and last month follow the calendar, across a year boundary', () => {
  assert.deepEqual(bounds(resolveRange({ range: 'month' }, NOW)), [day(2026, 9, 1), day(2026, 10, 1)]);
  assert.deepEqual(bounds(resolveRange({ range: 'lastMonth' }, NOW)), [day(2026, 8, 1), day(2026, 9, 1)]);
  const january = new Date(2026, 0, 10);
  assert.deepEqual(bounds(resolveRange({ range: 'lastMonth' }, january)), [day(2025, 11, 1), day(2026, 0, 1)]);
  assert.deepEqual(bounds(resolveRange({ range: 'month' }, new Date(2026, 11, 31))), [day(2026, 11, 1), day(2027, 0, 1)]);
});

test('includesNow is true only when the current moment falls inside the range', () => {
  assert.equal(resolveRange({ range: 'today' }, NOW).includesNow, true);
  assert.equal(resolveRange({ range: '7d' }, NOW).includesNow, true);
  assert.equal(resolveRange({ range: 'month' }, NOW).includesNow, true);
  assert.equal(resolveRange({ range: 'yesterday' }, NOW).includesNow, false);
  assert.equal(resolveRange({ range: 'lastMonth' }, NOW).includesNow, false);
});

test('a custom range includes its last day, whichever order the dates come in', () => {
  assert.deepEqual(bounds(resolveRange({ range: 'custom', from: '2026-10-10', to: '2026-10-12' }, NOW)), [day(2026, 9, 10), day(2026, 9, 13)]);
  // Without an end date the range is the single start day.
  assert.deepEqual(bounds(resolveRange({ range: 'custom', from: '2026-10-10' }, NOW)), [day(2026, 9, 10), day(2026, 9, 11)]);
  // An end before the start collapses to the start day rather than producing a negative range.
  assert.deepEqual(bounds(resolveRange({ range: 'custom', from: '2026-10-10', to: '2026-10-01' }, NOW)), [day(2026, 9, 10), day(2026, 9, 11)]);
  assert.equal(resolveRange({ range: 'custom', from: '2026-10-21', to: '2026-10-21' }, NOW).includesNow, true);
  assert.equal(resolveRange({ range: 'custom', from: '2026-10-01', to: '2026-10-02' }, NOW).includesNow, false);
});

test('a custom range with missing or malformed dates falls back to today', () => {
  const today: [number, number] = [day(2026, 9, 21), day(2026, 9, 22)];
  assert.deepEqual(bounds(resolveRange({ range: 'custom' }, NOW)), today);
  assert.deepEqual(bounds(resolveRange({ range: 'custom', from: 'garbage', to: '2026/10/22' }, NOW)), today);
  assert.deepEqual(bounds(resolveRange({ range: 'custom', from: '', to: '' }, NOW)), today);
  // A valid end with an invalid start still ends where it says.
  assert.deepEqual(bounds(resolveRange({ range: 'custom', from: 'x', to: '2026-10-23' }, NOW)), [day(2026, 9, 21), day(2026, 9, 24)]);
});

test('resolveRange defaults to the real clock', () => {
  const r = resolveRange({ range: 'today' });
  assert.ok(r.includesNow);
  assert.equal(r.end - r.start >= 23 * 3_600_000, true);
});
