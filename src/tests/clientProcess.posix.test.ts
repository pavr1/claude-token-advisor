import test from 'node:test';
import assert from 'node:assert/strict';
import { configureErrorLog, readErrors } from '../errorLog';
import { createClientResolver, isShellRunning, parseLsofOwner, parseLstart, parsePsTable, parseSsOwner, posixProcessName, readWindowsTable } from '../proxy/clientProcess';

const LSOF = ['p300', 'f18', 'n127.0.0.1:50000->127.0.0.1:4000', 'p400', 'f9', 'n127.0.0.1:4000->127.0.0.1:50000', ''].join('\n');
const SS = [
  'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'ESTAB 0 0 127.0.0.1:50000 127.0.0.1:4000 users:(("claude",pid=300,fd=18))',
  'ESTAB 0 0 [::1]:50001 [::1]:4000 users:(("node",pid=301,fd=20))',
].join('\n');

test('lsof -F output: owner of the client end, not the proxy end', () => {
  assert.equal(parseLsofOwner(LSOF, 50000, 4000), 300);
  assert.equal(parseLsofOwner(LSOF, 50999, 4000), undefined);
  assert.equal(parseLsofOwner('n127.0.0.1:50000->127.0.0.1:4000 (ESTABLISHED)\n', 50000, 4000), undefined); // no p line before it
});

test('ss output: pid of the client end, IPv4 and IPv6', () => {
  assert.equal(parseSsOwner(SS, 50000, 4000), 300);
  assert.equal(parseSsOwner(SS, 50001, 4000), 301);
  assert.equal(parseSsOwner(SS, 50002, 4000), undefined);
  assert.equal(parseSsOwner('ESTAB 0 0 127.0.0.1:50000 127.0.0.1:4000', 50000, 4000), undefined); // not visible: no users field
});

test('ps lstart parses in the C locale and rejects anything else', () => {
  assert.equal(parseLstart('Thu Nov  5 10:00:00 2026'), new Date(2026, 10, 5, 10, 0, 0).getTime());
  assert.equal(parseLstart('jeu. nov.  5 10:00:00 2026'), 0);
  assert.equal(parseLstart('Thu Xyz  5 10:00:00 2026'), 0);
});

test('claude is recognised as a binary, a native-install version file, or node running its cli', () => {
  assert.equal(posixProcessName('/usr/local/bin/claude --resume'), 'claude');
  assert.equal(posixProcessName('/Users/x/.local/share/claude/versions/2.1.5 --flag'), 'claude');
  assert.equal(posixProcessName('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude');
  assert.equal(posixProcessName('node /srv/app/server.js'), 'node');
  assert.equal(posixProcessName('-zsh'), '-zsh');
  assert.equal(posixProcessName(''), '');
});

test('ps table: pid, parent, start and name; unparseable lines are skipped', () => {
  const table = parsePsTable(
    ['  100     1 Thu Nov  5 09:00:00 2026 /bin/zsh -l', '  200   100 Thu Nov  5 09:05:00 2026 /usr/local/bin/claude', 'garbage'].join('\n')
  );
  assert.equal(table.size, 2);
  assert.deepEqual(table.get(200), { name: 'claude', parent: 100, start: new Date(2026, 10, 5, 9, 5, 0).getTime() });
  assert.equal(table.get(100)?.name, 'zsh');
});

test('the resolver runs on darwin and linux with an injected owner and table, and not elsewhere', async () => {
  const table = parsePsTable(['  100     1 Thu Nov  5 09:00:00 2026 /bin/zsh', '  200   100 Thu Nov  5 09:05:00 2026 /usr/local/bin/claude'].join('\n'));
  for (const platform of ['darwin', 'linux']) {
    const resolve = createClientResolver({ platform, owner: async () => 200, table: async () => table });
    const client = await resolve(50000, 4000);
    assert.equal(client?.shellPid, 100);
    assert.match(client?.terminalKey ?? '', /^100@\d+$/);
  }
  const other = createClientResolver({ platform: 'freebsd', owner: async () => 200, table: async () => table });
  assert.equal(await other(50000, 4000), undefined);
});

test('when macOS or Linux cannot resolve the terminal, the request is untouched and errors.json says why', async () => {
  configureErrorLog(undefined);
  const table = parsePsTable('  100     1 Thu Nov  5 09:00:00 2026 /bin/zsh\n  200   100 Thu Nov  5 09:05:00 2026 /usr/bin/vim');
  const failing = createClientResolver({
    platform: 'linux',
    owner: async () => {
      throw new Error('spawn ss ENOENT');
    },
  });
  assert.equal(await failing(50000, 4000), undefined);
  const notFound = createClientResolver({ platform: 'darwin', owner: async () => undefined });
  assert.equal(await notFound(50000, 4000), undefined);
  const noClaude = createClientResolver({ platform: 'darwin', owner: async () => 200, table: async () => table });
  assert.equal((await noClaude(50000, 4000))?.terminalKey, undefined);
  await noClaude(50001, 4000);

  const entries = readErrors().filter((e) => e.source === 'proxy.client_process');
  const byMessage = new Map(entries.map((e) => [e.message, e]));
  assert.equal(byMessage.get('spawn ss ENOENT')?.context?.['platform'], 'linux');
  assert.equal(byMessage.get('spawn ss ENOENT')?.context?.['step'], 'owner');
  assert.equal(byMessage.get('no process found for the client socket')?.context?.['platform'], 'darwin');
  const none = byMessage.get('no claude process in the client process chain');
  assert.equal(none?.count, 2); // the same message is one entry with a count
  assert.match(String(none?.context?.['chain']), /vim\(200\) <- zsh\(100\)/);
});

test('the Windows table falls back to the next way of running PowerShell, and remembers the one that worked', async () => {
  const rows = JSON.stringify([{ ProcessId: 7, ParentProcessId: 1, Name: 'claude.exe', Start: 5 }]);
  const calls: string[] = [];
  const eperm = async (file: string, args: string[]) => {
    calls.push(`${file} ${args[2]}`);
    if (args[2] === '-EncodedCommand') {
      throw new Error('spawn EPERM');
    }
    return { stdout: rows };
  };
  const table = await readWindowsTable(eperm);
  assert.deepEqual(table.get(7), { name: 'claude.exe', parent: 1, start: 5 });
  assert.deepEqual(calls, ['powershell.exe -EncodedCommand', 'powershell.exe -Command']);

  calls.length = 0;
  await readWindowsTable(eperm); // starts from the variant that worked
  assert.deepEqual(calls, ['powershell.exe -Command']);
});

test('when every way fails, the error names each one', async () => {
  await assert.rejects(
    readWindowsTable(async (file) => {
      throw new Error(`spawn ${file} EPERM`);
    }),
    (error: Error) =>
      error.message.startsWith('process table unavailable (') &&
      ['powershell -EncodedCommand', 'powershell -Command', 'pwsh -Command'].every((label) => error.message.includes(`${label}: spawn`))
  );
});

test('isShellRunning: a missing shell is closed, a running or protected one is open, an unknown terminal is not judged', () => {
  const dead = () => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };
  const protectedPid = () => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  };
  assert.equal(isShellRunning('10@5', () => true), true);
  assert.equal(isShellRunning('10@5', dead), false);
  assert.equal(isShellRunning('10@5', protectedPid), true);
  assert.equal(isShellRunning(undefined, dead), true);
});

test('a shell missing from the cached table is looked up again; if it still has no start time the terminal is left out', async () => {
  const stale = parsePsTable('  200     1 Thu Nov  5 09:05:00 2026 /usr/local/bin/claude');
  const fresh = parsePsTable('  100     1 Thu Nov  5 09:00:00 2026 /bin/zsh\n  200   100 Thu Nov  5 09:05:00 2026 /usr/local/bin/claude');
  const withRetry: boolean[] = [];
  const resolve = createClientResolver({
    platform: 'linux',
    owner: async () => 200,
    table: async (isFresh) => (withRetry.push(Boolean(isFresh)), isFresh ? fresh : new Map([...stale, [200, { name: 'claude', parent: 100, start: 1 }]])),
  });
  const client = await resolve(50000, 4000);
  assert.deepEqual(withRetry, [false, true]);
  assert.match(client?.terminalKey ?? '', /^100@\d{6,}$/);

  const never = createClientResolver({
    platform: 'linux',
    owner: async () => 200,
    table: async () => new Map([[200, { name: 'claude', parent: 100, start: 1 }]]),
  });
  const unknown = await never(50001, 4000);
  assert.equal(unknown?.terminalKey, undefined);
  assert.equal(unknown?.shellPid, 100);
});
