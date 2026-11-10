import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureErrorLog, MAX_ERROR_ENTRIES, readErrors, recordError, recordUnlessMissing } from '../errorLog';

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'errlog-')), 'errors.json');
afterEach(() => configureErrorLog(undefined));

test('an error is written to errors.json with its source, message, count and context', () => {
  const file = tmp();
  let tick = 0;
  configureErrorLog(file, () => new Date(Date.UTC(2026, 10, 2, 12, 0, tick++)));
  recordError('proxy.upstream_http', 'HTTP 429', { status: 429, project: 'p' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; entries: Array<Record<string, unknown>> };
  assert.equal(saved.version, 1);
  assert.equal(saved.entries.length, 1);
  assert.deepEqual(
    { source: saved.entries[0].source, message: saved.entries[0].message, count: saved.entries[0].count, context: saved.entries[0].context },
    { source: 'proxy.upstream_http', message: 'HTTP 429', count: 1, context: { status: 429, project: 'p' } }
  );
});

test('the same error again is one entry with a count and a later time; a different one is another entry', () => {
  const file = tmp();
  let tick = 0;
  configureErrorLog(file, () => new Date(Date.UTC(2026, 10, 2, 12, 0, tick++)));
  recordError('a', 'boom');
  recordError('a', new Error('other'));
  recordError('a', 'boom');
  recordError('b', 'boom');
  const entries = readErrors();
  assert.equal(entries.length, 3);
  const boom = entries.find((e) => e.source === 'a' && e.message === 'boom')!;
  assert.equal(boom.count, 2);
  assert.ok(boom.lastAt > boom.firstAt);
  assert.equal(entries[entries.length - 1], entries.find((e) => e.source === 'b'), 'the list is ordered by last occurrence');
  assert.ok(entries.find((e) => e.message === 'other')!.stack, 'an Error keeps its stack');
});

test('the file keeps only the newest entries', () => {
  configureErrorLog(tmp());
  for (let i = 0; i < MAX_ERROR_ENTRIES + 25; i += 1) {
    recordError('s', `error ${i}`);
  }
  const entries = readErrors();
  assert.equal(entries.length, MAX_ERROR_ENTRIES);
  assert.equal(entries[0].message, 'error 25');
});

test('what was recorded survives a restart, and a damaged file is replaced instead of failing', () => {
  const file = tmp();
  configureErrorLog(file);
  recordError('s', 'first');
  configureErrorLog(file);
  assert.equal(readErrors().length, 1);
  recordError('s', 'second');
  assert.equal(readErrors().length, 2);
  fs.writeFileSync(file, '{ not json');
  configureErrorLog(file);
  assert.doesNotThrow(() => recordError('s', 'third'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 1);
});

test('recording never throws: odd values, a circular object, and a file that cannot be written', () => {
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  configureErrorLog(path.join(tmp(), 'nested', 'x.json'));
  assert.doesNotThrow(() => recordError('s', circular));
  assert.doesNotThrow(() => recordError('s', undefined));
  assert.doesNotThrow(() => recordError('s', null));
  const blocker = tmp();
  fs.writeFileSync(blocker, 'a file where a folder is needed');
  configureErrorLog(path.join(blocker, 'errors.json'));
  assert.doesNotThrow(() => recordError('s', 'kept in memory'));
  assert.equal(readErrors().length, 1);
});

test('a file that is not there yet is normal and is not recorded; any other failure is', () => {
  configureErrorLog(tmp());
  recordUnlessMissing('s', Object.assign(new Error('nope'), { code: 'ENOENT' }));
  assert.equal(readErrors().length, 0);
  recordUnlessMissing('s', Object.assign(new Error('denied'), { code: 'EACCES' }));
  assert.equal(readErrors().length, 1);
});

test('very long messages are cut, so one error cannot make the file huge', () => {
  configureErrorLog(tmp());
  recordError('s', 'x'.repeat(100_000));
  assert.ok(readErrors()[0].message.length <= 600);
});
