/** The warning for a `claude` that talks to Anthropic directly: scanning, the status item and the fix flow. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';

import type { PythonRuntime } from '../budget/pythonRuntime';
import { BypassMonitor } from '../proxy/bypassMonitor';
import { fake, FakeTerminal, FakeThemeColor } from './helpers/fakeVscode';

const PROXY = 'http://127.0.0.1:4000';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-'));
let counter = 0;
const monitors: BypassMonitor[] = [];

/**
 * A "python" that is really node running a script: it records the pids it was asked about
 * and prints `output` (or exits non-zero when told to fail). `scan` runs it through the real execFile.
 */
function scanRuntime(output: string): { runtime: PythonRuntime; out: string; pids: () => number[]; failNext: () => void } {
  const out = path.join(tmp, `scan-${(counter += 1)}.txt`);
  fs.writeFileSync(out, output);
  const script = path.join(tmp, 'fake-python.js');
  fs.writeFileSync(
    script,
    [
      "const fs = require('fs');",
      'const out = process.argv[2];',
      "fs.writeFileSync(out + '.args', JSON.stringify(process.argv.slice(5)));",
      "if (fs.existsSync(out + '.fail')) { process.exit(3); }",
      "process.stdout.write(fs.readFileSync(out, 'utf8'));",
    ].join('\n')
  );
  return {
    runtime: { command: process.execPath, args: [script, out], version: '3.12' },
    out,
    pids: () => JSON.parse(fs.readFileSync(out + '.args', 'utf8')).map(Number),
    failNext: () => fs.writeFileSync(out + '.fail', ''),
  };
}

function monitor(getPython: () => Promise<PythonRuntime>): { m: BypassMonitor; logs: string[] } {
  const logs: string[] = [];
  const m = new BypassMonitor((line) => logs.push(line), getPython);
  monitors.push(m);
  return { m, logs };
}

const item = () => fake.statusBarItems[fake.statusBarItems.length - 1];

/** A terminal the way VS Code reports it: a shell pid, a creation cwd, and a dispose that removes it. */
function addTerminal(name: string, pid: number | undefined, cwd?: unknown): FakeTerminal {
  const terminal: FakeTerminal = {
    name,
    options: {},
    creationOptions: { cwd },
    processId: Promise.resolve(pid),
    sent: [],
    shown: false,
    sendText: (text) => terminal.sent.push(text),
    show: () => {
      terminal.shown = true;
    },
    dispose: () => {
      fake.terminals.splice(fake.terminals.indexOf(terminal), 1);
    },
  };
  fake.terminals.push(terminal);
  return terminal;
}

beforeEach(() => fake.reset());
afterEach(() => {
  mock.timers.reset();
  while (monitors.length) {
    monitors.pop()?.dispose();
  }
});

test('the status item is a left-side error-coloured warning that opens the explanation', () => {
  monitor(async () => scanRuntime('').runtime);
  const bar = item();
  assert.equal(bar.command, BypassMonitor.COMMAND);
  assert.equal((bar.color as FakeThemeColor).id, 'statusBarItem.errorForeground');
  assert.equal((bar.backgroundColor as FakeThemeColor).id, 'statusBarItem.errorBackground');
  assert.equal(bar.visible, false);
});

test('without an address (proxy stopped) nothing is scanned and the warning is hidden', async () => {
  let asked = 0;
  const { m } = monitor(async () => {
    asked += 1;
    return scanRuntime('').runtime;
  });
  item().visible = true;
  m.setAddress(undefined);
  assert.equal(item().visible, false);
  await m.check();
  assert.equal(asked, 0);
});

test('off Windows the monitor stays off even with an address', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let asked = 0;
    const { m } = monitor(async () => {
      asked += 1;
      return scanRuntime('').runtime;
    });
    m.setAddress(PROXY);
    mock.timers.tick(60_000);
    assert.equal(asked, 0);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('on Windows an address starts a first check after 3s and then one every 20s, without doubling up', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let asked = 0;
  const { m } = monitor(async () => {
    asked += 1;
    throw new Error('no python');
  });
  m.setAddress(PROXY);
  m.setAddress(PROXY); // a second call must not start a second timer
  mock.timers.tick(2_999);
  await flush();
  assert.equal(asked, 0);
  mock.timers.tick(1);
  await flush();
  assert.equal(asked, 1, 'the first check fires at 3s');
  mock.timers.tick(17_000);
  await flush();
  assert.equal(asked, 2, 'one interval check at 20s, not two');
  m.setAddress(undefined);
  mock.timers.tick(100_000);
  await flush();
  assert.equal(asked, 2, 'stopping clears the interval');
});

test('a scan lists the claude processes that skip the proxy, asks about every shell plus the host, and warns once', async () => {
  addTerminal('zsh', 4242);
  addTerminal('no-pid', undefined);
  const scan = scanRuntime(`111|${PROXY}|4242\n222||4242\n333|https://api.anthropic.com|4242\nnoise\n`);
  const { m, logs } = monitor(async () => scan.runtime);
  m.setAddress(PROXY);
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await m.check();

  assert.deepEqual(scan.pids(), [4242, process.pid]);
  assert.equal(item().text, '$(warning) Claude not using proxy (2)');
  assert.match(String(item().tooltip), /bypasses the Token Improver proxy/);
  assert.equal(item().visible, true);
  assert.deepEqual(logs, ['UNROUTED claude in this window: pid 222, 333 (talks to Anthropic directly)']);

  await m.check(); // same offenders: no new log line
  assert.equal(logs.length, 1);

  fs.writeFileSync(scan.out, `111|${PROXY}/v1|4242\n`);
  await m.check(); // a base URL that starts with the proxy address is routed
  assert.equal(item().visible, false);
  assert.equal(logs.length, 1);
});

test('two checks at once scan once', async () => {
  let asked = 0;
  const scan = scanRuntime('');
  const { m } = monitor(async () => {
    asked += 1;
    return scan.runtime;
  });
  m.setAddress(PROXY);
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await Promise.all([m.check(), m.check()]);
  assert.equal(asked, 1);
  await m.check();
  assert.equal(asked, 2, 'the guard is released once a scan ends');
});

test('a failing scan is logged once, whatever it throws, and does not raise', async () => {
  const scan = scanRuntime('');
  scan.failNext();
  const { m, logs } = monitor(async () => scan.runtime);
  m.setAddress(PROXY);
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await m.check();
  await m.check();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^unrouted-claude check failed: /);

  const { m: m2, logs: logs2 } = monitor(async () => {
    throw 'plain string';
  });
  m2.setAddress(PROXY);
  await m2.check();
  assert.deepEqual(logs2, ['unrouted-claude check failed: plain string']);
});

async function withOffenders(): Promise<{ m: BypassMonitor; logs: string[] }> {
  const scan = scanRuntime(`501||7001\n502||7002\n503||7003\n`);
  const made = monitor(async () => scan.runtime);
  made.m.setAddress(PROXY);
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await made.m.check();
  return made;
}

test('explain with nothing unrouted says so', async () => {
  const { m } = monitor(async () => scanRuntime('').runtime);
  await m.explain();
  assert.deepEqual(fake.infoMessages, ['Every claude running in this window goes through the proxy.']);
  assert.equal(fake.warningMessages.length, 0);
});

test('explain lists the count and pids, and does nothing when the dialog is dismissed', async () => {
  addTerminal('a', 7001);
  const { m } = await withOffenders();
  await m.explain();
  assert.equal(fake.warningMessages.length, 1);
  assert.match(fake.warningMessages[0], /^3 claude process\(es\) in this window talk to Anthropic directly \(pid 501, 502, 503\)/);
  assert.equal(fake.commands.length, 0);
  assert.equal(fake.terminals.length, 1);
});

test('"Show terminals" focuses the terminal panel', async () => {
  const { m } = await withOffenders();
  fake.nextChoice = 'Show terminals';
  await m.explain();
  assert.deepEqual(fake.commands, [{ id: 'workbench.action.terminal.focus', args: [] }]);
});

test('"Close and resume" reopens each hosting terminal, resuming once per directory', async () => {
  const a = addTerminal('api', 7001, '/work/repo');
  const b = addTerminal('api-2', 7002, '/work/repo'); // same directory as a
  const c = addTerminal('docs', 7003, { fsPath: '/work/docs' }); // a Uri
  const other = addTerminal('unrelated', 9999, '/work/other');
  const noShell = addTerminal('no-shell', undefined);
  const { m, logs } = await withOffenders();
  fake.nextChoice = 'Close and resume';
  await m.explain();

  const left = fake.terminals.filter((t) => [a, b, c].includes(t));
  assert.equal(left.length, 0, 'the three hosting terminals were disposed');
  assert.ok(fake.terminals.includes(other) && fake.terminals.includes(noShell));

  const created = fake.terminals.filter((t) => ![other, noShell].includes(t));
  assert.deepEqual(
    created.map((t) => [t.name, (t.options as { cwd?: unknown }).cwd]),
    [
      ['api', '/work/repo'],
      ['api-2', '/work/repo'],
      ['docs', { fsPath: '/work/docs' }],
    ]
  );
  assert.ok(created.every((t) => t.shown));
  // The second terminal in /work/repo is reopened but not resumed, so two sessions never grab the same conversation.
  assert.deepEqual(created.map((t) => t.sent), [['claude --continue'], [], ['claude --continue']]);
  assert.deepEqual(logs.slice(-1), ['closed 3 terminal(s) hosting an unrouted claude and reopened them with --continue']);
  assert.equal(item().visible, false);
  assert.equal(fake.infoMessages.length, 0);
});

test('terminals without a cwd share one resume slot', async () => {
  addTerminal('x', 7001);
  addTerminal('y', 7002);
  const { m } = await withOffenders();
  fake.nextChoice = 'Close and resume';
  await m.explain();
  const created = fake.terminals;
  assert.deepEqual(created.map((t) => t.sent.length), [1, 0]);
});

test('"Close those terminals" closes without reopening and tells the user how to resume', async () => {
  addTerminal('x', 7001, '/work/repo');
  const { m, logs } = await withOffenders();
  fake.nextChoice = 'Close those terminals';
  await m.explain();
  assert.equal(fake.terminals.length, 0);
  assert.deepEqual(logs.slice(-1), ['closed 1 terminal(s) hosting an unrouted claude']);
  assert.deepEqual(fake.infoMessages, ['Closed 1 terminal(s). Open a new one and run "claude --continue" to resume.']);
});

test('closing when no terminal hosts the offender stays quiet', async () => {
  const { m, logs } = await withOffenders();
  fake.nextChoice = 'Close those terminals';
  await m.explain();
  assert.deepEqual(logs.slice(-1), ['closed 0 terminal(s) hosting an unrouted claude']);
  assert.equal(fake.infoMessages.length, 0);
});

test('after closing, a fresh check runs 3s later', async () => {
  let asked = 0;
  const scan = scanRuntime('501||7001\n');
  const { m } = monitor(async () => {
    asked += 1;
    return scan.runtime;
  });
  m.setAddress(PROXY);
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await m.check();
  const before = asked;
  fake.nextChoice = 'Close those terminals';
  await m.explain();
  mock.timers.tick(3_000);
  await flush();
  assert.equal(asked, before + 1);
});

test('dispose disposes the status item and stops the timer', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let asked = 0;
  const { m } = monitor(async () => {
    asked += 1;
    throw new Error('x');
  });
  m.setAddress(PROXY);
  m.dispose();
  assert.equal(item().disposed, true);
  mock.timers.tick(25_000);
  await flush();
  assert.equal(asked, 1, 'only the 3s one-off already queued can still run');
});
