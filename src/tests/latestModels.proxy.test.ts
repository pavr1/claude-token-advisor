/** The proxy asks Anthropic for the newest Sonnet and Haiku and uses them, end to end against a fake upstream. */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import test, { afterEach } from 'node:test';

import { DEFAULT_OPTIMIZER_CONFIG } from '../proxy/optimizer';
import { DEFAULT_PROXY_CONFIG, TokenImproverProxy } from '../proxy/server';

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

interface Capture {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      })
  );
  return (server.address() as AddressInfo).port;
}

const MODELS = {
  data: [
    { id: 'claude-sonnet-5-5', created_at: '2026-06-01T00:00:00Z' },
    { id: 'claude-sonnet-9', created_at: '2027-01-01T00:00:00Z' },
    { id: 'claude-haiku-5-5', created_at: '2026-06-15T00:00:00Z' },
    { id: 'claude-haiku-9', created_at: '2027-01-02T00:00:00Z' },
    { id: 'claude-opus-9', created_at: '2027-01-03T00:00:00Z' },
  ],
};

test('the default that replaces Opus and the routing to Haiku use the newest models Anthropic lists', async () => {
  const captures: Capture[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      captures.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        (req.url ?? '').startsWith('/v1/models')
          ? JSON.stringify(MODELS)
          : JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 5, output_tokens: 1 } })
      );
    });
  });
  const upstreamPort = await listen(upstream);

  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, optimizer: DEFAULT_OPTIMIZER_CONFIG, lookupLatestModels: true },
    { onTurnComplete: () => undefined },
    () => undefined
  );
  await proxy.start();
  open.push(() => proxy.stop());

  const headers = { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' };
  const send = (body: object) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
  const messages = () => captures.filter((c) => c.path === '/v1/messages');

  // First request of the run, on Opus: it leaves as the newest Sonnet, which was found before the request went out.
  await send({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'review the release plan and summarize the open risks' }] });
  assert.equal(JSON.parse(messages()[0].body).model, 'claude-sonnet-9');

  // A greeting is routed to the newest Haiku.
  await send({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(JSON.parse(messages()[1].body).model, 'claude-haiku-9');

  // It asked once, with the client's own key, and not again for the second request.
  const asked = captures.filter((c) => c.path.startsWith('/v1/models'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].method, 'GET');
  assert.equal(asked[0].headers['x-api-key'], 'sk-test');
});

test('when the list cannot be read the proxy keeps working with the built-in models', async () => {
  const captures: Capture[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      captures.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if ((req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const logs: string[] = [];
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, optimizer: DEFAULT_OPTIMIZER_CONFIG, lookupLatestModels: true },
    { onTurnComplete: () => undefined },
    (line) => void logs.push(line)
  );
  await proxy.start();
  open.push(() => proxy.stop());

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'review the release plan and summarize the open risks' }] }),
  });
  assert.equal(response.status, 200, 'the request is served anyway');
  assert.ok(captures.some((c) => c.path === '/v1/messages'));
  assert.match(logs.join('\n'), /models: could not ask for the newest \(HTTP 401\)/);
});
