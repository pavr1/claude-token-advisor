import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PendingHistoryStore, PENDING_HISTORY_TTL_MS } from '../proxy/pendingHistory';

test('take returns the summaries once and deletes them', () => {
  const store = new PendingHistoryStore();
  store.set('p', ['a', 'b'], 1000);
  assert.equal(store.has('p', 1000), true);
  assert.deepEqual(store.take('p', 2000), ['a', 'b']);
  assert.equal(store.take('p', 2000), undefined);
  assert.equal(store.has('p', 2000), false);
});

test('summaries are kept per project and a newer set replaces the older one', () => {
  const store = new PendingHistoryStore();
  store.set('p', ['old'], 1000);
  store.set('q', ['other'], 1000);
  store.set('p', ['new'], 2000);
  assert.deepEqual(store.take('p', 3000), ['new']);
  assert.deepEqual(store.take('q', 3000), ['other']);
});

test('expired summaries are neither reported nor returned', () => {
  const store = new PendingHistoryStore();
  store.set('p', ['a'], 0);
  assert.equal(store.has('p', PENDING_HISTORY_TTL_MS), true);
  assert.equal(store.has('p', PENDING_HISTORY_TTL_MS + 1), false);
  assert.equal(store.take('p', PENDING_HISTORY_TTL_MS + 1), undefined);
  assert.equal(store.size, 0);
});

test('the file survives a restart, and taking deletes it from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  const file = path.join(dir, 'lastdayhistory.json');
  new PendingHistoryStore(file).set('p', ['a'], 1000);
  const reopened = new PendingHistoryStore(file);
  assert.deepEqual(reopened.take('p', 2000), ['a']);
  assert.equal(new PendingHistoryStore(file).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt file starts empty and malformed entries are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  const file = path.join(dir, 'lastdayhistory.json');
  fs.writeFileSync(file, '{nope');
  assert.equal(new PendingHistoryStore(file).size, 0);
  fs.writeFileSync(file, JSON.stringify({ pending: { ok: { summaries: ['s'], savedAt: 1 }, bad: { summaries: [1], savedAt: 'x' } } }));
  assert.equal(new PendingHistoryStore(file).size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
