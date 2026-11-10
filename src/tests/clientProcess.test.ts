import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChain, parseNetstatOwner, ProcessInfo } from '../proxy/clientProcess';

const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       49340',
  '  TCP    127.0.0.1:59701        127.0.0.1:4000         ESTABLISHED     37744',
  '  TCP    127.0.0.1:4000         127.0.0.1:59701        ESTABLISHED     49340',
  '  TCP    127.0.0.1:62482        127.0.0.1:5000         ESTABLISHED     111',
].join('\r\n');

test('parseNetstatOwner finds the client end of the connection, not the proxy end', () => {
  assert.equal(parseNetstatOwner(NETSTAT, 59701, 4000), 37744);
});

test('parseNetstatOwner ignores other ports, headers and missing connections', () => {
  assert.equal(parseNetstatOwner(NETSTAT, 62482, 4000), undefined); // that one goes to 5000
  assert.equal(parseNetstatOwner(NETSTAT, 1, 4000), undefined);
  assert.equal(parseNetstatOwner('', 59701, 4000), undefined);
});

const table = new Map<number, ProcessInfo>([
  [1, { name: 'explorer.exe', parent: 0 }],
  [2, { name: 'Code.exe', parent: 1 }],
  [3, { name: 'powershell.exe', parent: 2 }], // the terminal's shell
  [4, { name: 'claude.exe', parent: 3 }],
  [5, { name: 'cmd.exe', parent: 4 }],
  [6, { name: 'powershell.exe', parent: 5 }],
]);

test('describeChain takes the parent of the claude process as the terminal shell', () => {
  const result = describeChain(6, table, 59701);
  assert.equal(result.claudePid, 4);
  assert.equal(result.shellPid, 3);
  assert.equal(result.chain[0], 'powershell.exe(6)');
  assert.equal(result.chain.at(-1), 'explorer.exe(1)');
});

test('describeChain works when the socket owner is claude itself', () => {
  const result = describeChain(4, table, 1);
  assert.equal(result.claudePid, 4);
  assert.equal(result.shellPid, 3);
});

test('describeChain leaves claude and shell undefined when no claude process is on the way up, and survives a loop', () => {
  assert.equal(describeChain(2, table, 1).claudePid, undefined);
  const loop = new Map<number, ProcessInfo>([
    [10, { name: 'a.exe', parent: 11 }],
    [11, { name: 'b.exe', parent: 10 }],
  ]);
  assert.equal(describeChain(10, loop, 1).chain.length, 2);
});
