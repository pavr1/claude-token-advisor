/** The terminal a request came from: it reaches the turn record and the log, and never holds a request back or breaks it. */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import test, { afterEach } from 'node:test';

import type { ClientProcess } from '../proxy/clientProcess';
import { DEFAULT_OPTIMIZER_CONFIG } from '../proxy/optimizer';
import { DEFAULT_PROXY_CONFIG, ProxyConfig, TokenImproverProxy, TurnRecord } from '../proxy/server';

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function upstream(): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 50, output_tokens: 10 }, stop_reason: 'end_turn' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function run(extra: Partial<ProxyConfig>): Promise<{ turns: TurnRecord[]; logs: string[] }> {
  const turns: TurnRecord[] = [];
  const logs: string[] = [];
  const port = await freePort();
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: await upstream(), optimizer: { ...DEFAULT_OPTIMIZER_CONFIG }, lookupLatestModels: false, ...extra },
    { onTurnComplete: (record) => void turns.push(record) },
    (line) => void logs.push(line)
  );
  await proxy.start();
  open.push(() => proxy.stop());
  const res = await fetch(`http://127.0.0.1:${port}/w/skills-app/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hello there' }] }),
  });
  assert.equal(res.status, 200);
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { turns, logs };
}

const client = (over: Partial<ClientProcess> = {}): ClientProcess => ({ srcPort: 1, pid: 4, claudePid: 4, shellPid: 3, terminalKey: '3@5000', chain: ['claude.exe(4)'], ...over });

test("the turn record carries the terminal the request came from, and the log says whether it is one of this window's", async () => {
  const { turns, logs } = await run({ identifyClient: async () => client(), terminalPids: async () => [3] });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].terminalKey, '3@5000');
  assert.ok(logs.some((l) => /client \[skills-app\].*terminal=3@5000 terminal\.processId match=yes/.test(l)), logs.join('\n'));
});

test('a terminal that is not open in this window is logged as no match', async () => {
  const { logs } = await run({ identifyClient: async () => client(), terminalPids: async () => [99] });
  assert.ok(logs.some((l) => /match=no/.test(l)), logs.join('\n'));
});

test('a slow answer holds the turn record back until it is known, instead of recording it without a terminal', async () => {
  const { turns } = await run({
    identifyClient: () => new Promise((resolve) => setTimeout(() => resolve(client({ terminalKey: '8@1' })), 30)),
  });
  assert.equal(turns[0].terminalKey, '8@1');
});

test('a client that cannot be identified still gets its answer, and the turn has no terminal', async () => {
  const unknown = await run({ identifyClient: async () => undefined });
  assert.equal(unknown.turns[0].terminalKey, undefined);
  assert.ok(unknown.logs.some((l) => /not resolved/.test(l)));

  const broken = await run({ identifyClient: async () => Promise.reject(new Error('boom')) });
  assert.equal(broken.turns.length, 1);
  assert.equal(broken.turns[0].terminalKey, undefined);
});

test('without a resolver no terminal is looked for at all', async () => {
  const { turns, logs } = await run({});
  assert.equal(turns[0].terminalKey, undefined);
  assert.equal(logs.some((l) => /client \[/.test(l)), false);
});
