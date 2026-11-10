/**
 * Unit tests for the install watcher: how a host notices that its own code was
 * replaced or removed from disk while it kept running.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkInstall, readFingerprint, readInstallTime } from '../proxy/installWatch';

function tempFile(content: string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-watch-'));
  const file = path.join(dir, 'extension.js');
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('an untouched file is current', () => {
  const { file, cleanup } = tempFile('one');
  try {
    assert.equal(checkInstall(file, readFingerprint(file)), 'current');
  } finally {
    cleanup();
  }
});

test('a file rewritten with different content is reported as replaced', () => {
  const { file, cleanup } = tempFile('one');
  try {
    const baseline = readFingerprint(file);
    fs.writeFileSync(file, 'a longer second version');
    assert.equal(checkInstall(file, baseline), 'replaced');
  } finally {
    cleanup();
  }
});

test('a file with the same size but a new modification time is reported as replaced', () => {
  const { file, cleanup } = tempFile('same');
  try {
    const baseline = readFingerprint(file);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    assert.equal(checkInstall(file, baseline), 'replaced');
  } finally {
    cleanup();
  }
});

test('a deleted file is reported as removed', () => {
  const { file, cleanup } = tempFile('one');
  try {
    const baseline = readFingerprint(file);
    fs.rmSync(file);
    assert.equal(checkInstall(file, baseline), 'removed');
  } finally {
    cleanup();
  }
});

test('with no baseline nothing is reported, so a proxy is never released on a guess', () => {
  assert.equal(checkInstall(path.join(os.tmpdir(), 'does-not-exist-xyz.js'), undefined), 'current');
});

test('readInstallTime returns the folder creation time, or undefined when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-time-'));
  const born = readInstallTime(dir);
  assert.ok(born !== undefined && Math.abs(born - Date.now()) < 60_000);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(readInstallTime(dir), undefined);
});
