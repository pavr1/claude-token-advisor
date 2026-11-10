/** Window-to-window coordination: probing the port, announcing a version, following the event stream. */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';

import { announceVersion, probeProxy, subscribeToEvents } from '../proxy/coordinator';
import { PROXY_PROTOCOL, PROXY_SERVICE_ID } from '../proxy/server';

async function serve(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const json = (body: unknown): http.RequestListener => (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

async function probe(body: unknown): Promise<unknown> {
  const server = await serve(json(body));
  try {
    return await probeProxy(server.port);
  } finally {
    await server.close();
  }
}

test('probeProxy joins a proxy of this protocol and flags an older or pid-less one as outdated', async () => {
  assert.deepEqual(await probe({ service: PROXY_SERVICE_ID, protocol: PROXY_PROTOCOL, pid: 7 }), { kind: 'ours', pid: 7 });
  assert.deepEqual(await probe({ service: PROXY_SERVICE_ID, protocol: PROXY_PROTOCOL + 3, pid: 7 }), { kind: 'ours', pid: 7 });
  assert.deepEqual(await probe({ service: PROXY_SERVICE_ID, protocol: PROXY_PROTOCOL - 1, pid: 7 }), { kind: 'outdated', pid: 7 });
  assert.deepEqual(await probe({ service: PROXY_SERVICE_ID, pid: 7 }), { kind: 'outdated', pid: 7 });
  assert.deepEqual(await probe({ service: PROXY_SERVICE_ID, protocol: PROXY_PROTOCOL }), { kind: 'outdated', pid: undefined });
  assert.deepEqual(await probe({ service: PROXY_SERVICE_ID, protocol: 'x', pid: 'y' }), { kind: 'outdated', pid: undefined });
});

test('probeProxy recognises a pre-singleton build by its health shape, and never claims a stranger', async () => {
  assert.deepEqual(await probe({ status: 'ok', upstream: 'u', optimizer: {} }), { kind: 'outdated', pid: undefined });
  assert.deepEqual(await probe({ status: 'ok' }), { kind: 'foreign' });
  assert.deepEqual(await probe({ service: 'someone-else' }), { kind: 'foreign' });

  const html = await serve((_req, res) => res.end('<html>not json</html>'));
  try {
    assert.deepEqual(await probeProxy(html.port), { kind: 'foreign' });
  } finally {
    await html.close();
  }
});

test('probeProxy reports a free port as none', async () => {
  const server = await serve(json({}));
  const { port } = server;
  await server.close();
  assert.deepEqual(await probeProxy(port), { kind: 'none' });
});

test('announceVersion posts the version as JSON and resolves even when the holder fails', async () => {
  const seen: Array<{ method?: string; url?: string; type?: string; body: string }> = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      res.statusCode = 404; // a proxy from before the endpoint existed
      res.end();
    });
  });
  try {
    await announceVersion(server.port, '1.2.3');
  } finally {
    await server.close();
  }
  assert.deepEqual(seen, [{ method: 'POST', url: '/announce', type: 'application/json', body: '{"version":"1.2.3"}' }]);

  // Nothing listening: resolves instead of throwing.
  await announceVersion(server.port, '1.2.3');
});

test('announceVersion gives up on a holder that never answers', async () => {
  const server = await serve(() => undefined);
  const started = Date.now();
  try {
    await announceVersion(server.port, '1.0.0');
  } finally {
    await server.close();
  }
  assert.ok(Date.now() - started < 5_000);
});

test('subscribeToEvents parses frames split across chunks, drops malformed ones and ends once when the stream ends', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"a"}\n\ndata: {"type"');
    setTimeout(() => {
      res.write(':"b"}\n\nevent: ping\n\ndata: not-json\n\n');
      res.end('data: {"type":"c"}\n\n');
    }, 30);
  });
  try {
    const events: unknown[] = [];
    let ends = 0;
    await new Promise<void>((resolve) => {
      subscribeToEvents(server.port, (e) => events.push(e), () => {
        ends += 1;
        setTimeout(resolve, 50);
      });
    });
    assert.deepEqual(events, [{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    assert.equal(ends, 1);
  } finally {
    await server.close();
  }
});

test('subscribeToEvents ends on a non-200 answer or a refused connection, and not after close()', async () => {
  const refusing = await serve((_req, res) => {
    res.statusCode = 503;
    res.end();
  });
  try {
    await new Promise<void>((resolve) => subscribeToEvents(refusing.port, () => undefined, resolve));
  } finally {
    await refusing.close();
  }

  const closedPort = refusing.port;
  await new Promise<void>((resolve) => subscribeToEvents(closedPort, () => undefined, resolve));

  const open = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"x"}\n\n');
  });
  try {
    let ended = false;
    let subscription: { close(): void } | undefined;
    await new Promise<void>((resolve) => {
      subscription = subscribeToEvents(open.port, () => resolve(), () => (ended = true));
    });
    subscription?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ended, false, 'close() is a deliberate stop, not a takeover signal');
  } finally {
    await open.close();
  }
});
