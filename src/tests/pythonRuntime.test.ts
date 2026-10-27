import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPython, isSupported, parsePythonVersion, pythonCandidates, Runner } from '../budget/pythonRuntime';

test('parsePythonVersion reads the version from stdout or stderr output', () => {
  assert.deepEqual(parsePythonVersion('Python 3.12.1\n'), { major: 3, minor: 12, version: '3.12.1' });
  assert.deepEqual(parsePythonVersion('\nPython 2.7.18'), { major: 2, minor: 7, version: '2.7.18' });
  assert.equal(parsePythonVersion('Python was not found; run without arguments to install'), undefined);
});

test('isSupported requires Python 3.8 or newer', () => {
  assert.equal(isSupported({ major: 3, minor: 8 }), true);
  assert.equal(isSupported({ major: 3, minor: 12 }), true);
  assert.equal(isSupported({ major: 3, minor: 7 }), false);
  assert.equal(isSupported({ major: 2, minor: 7 }), false);
});

test('candidates start with the launcher on Windows and python3 elsewhere', () => {
  assert.deepEqual(pythonCandidates('win32')[0], { command: 'py', args: ['-3'] });
  assert.equal(pythonCandidates('darwin')[0].command, 'python3');
  assert.equal(pythonCandidates('linux')[0].command, 'python3');
});

test('detectPython returns the first working interpreter', async () => {
  const calls: string[] = [];
  const run: Runner = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    return command === 'python3' ? 'Python 3.11.4' : Promise.reject(new Error('ENOENT'));
  };
  const found = await detectPython(run, pythonCandidates('win32'));
  assert.deepEqual(found, { command: 'python3', args: [], version: '3.11.4' });
  assert.deepEqual(calls, ['py -3 --version', 'python --version', 'python3 --version']);
});

test('detectPython skips Python 2, old versions and stubs', async () => {
  const outputs: Record<string, string> = {
    python3: 'Python 3.6.9',
    python: 'Python 2.7.18',
  };
  const run: Runner = async (command) => outputs[command] ?? 'no python here';
  assert.equal(await detectPython(run, pythonCandidates('linux')), undefined);
});

test('detectPython returns undefined when nothing runs', async () => {
  const run: Runner = async () => {
    throw new Error('spawn ENOENT');
  };
  assert.equal(await detectPython(run, pythonCandidates('darwin')), undefined);
});

test('the default runner executes a real command and reads its version from stdout or stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-runtime-'));
  const out = path.join(dir, 'out.js');
  const err = path.join(dir, 'err.js');
  fs.writeFileSync(out, "console.log('Python 3.12.1');");
  fs.writeFileSync(err, "console.error('Python 3.9.0');");
  try {
    // detectPython appends --version, which the script simply ignores.
    assert.deepEqual(await detectPython(undefined, [{ command: process.execPath, args: [out] }]), {
      command: process.execPath,
      args: [out],
      version: '3.12.1',
    });
    assert.equal((await detectPython(undefined, [{ command: process.execPath, args: [err] }]))?.version, '3.9.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default runner treats a missing command or a non-zero exit as "not Python"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-runtime-'));
  const fail = path.join(dir, 'fail.js');
  fs.writeFileSync(fail, 'process.exit(9);');
  try {
    assert.equal(await detectPython(undefined, [{ command: 'definitely-not-a-real-command-xyz', args: [] }]), undefined);
    assert.equal(await detectPython(undefined, [{ command: process.execPath, args: [fail] }]), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parsePythonVersion accepts a version without a patch number', () => {
  assert.deepEqual(parsePythonVersion('Python 3.11'), { major: 3, minor: 11, version: '3.11' });
  assert.equal(parsePythonVersion('not python'), undefined);
});
