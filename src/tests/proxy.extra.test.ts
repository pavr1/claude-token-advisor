/**
 * More end-to-end proxy cases: compaction through the Haiku summarizer, exact token counting, upstream
 * failures, interrupted streams and the endpoints other windows use. Helpers are local on purpose, the
 * same convention as `proxy.test.ts`.
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import test, { afterEach } from 'node:test';

import { DEFAULT_OPTIMIZER_CONFIG, OptimizerConfig } from '../proxy/optimizer';
import { DEFAULT_PROXY_CONFIG, ProxyConfig, TokenImproverProxy, TurnRecord } from '../proxy/server';

interface Seen {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function upstream(
  handler: (seen: Seen, res: http.ServerResponse, req: http.IncomingMessage) => void
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const entry = { path: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      handler(entry, res, req);
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startProxy(
  upstreamBaseUrl: string,
  options: { optimizer?: Partial<OptimizerConfig>; proxy?: Partial<ProxyConfig> } = {}
): Promise<{ proxy: TokenImproverProxy; turns: TurnRecord[]; logs: string[]; url: string; port: number }> {
  const turns: TurnRecord[] = [];
  const logs: string[] = [];
  const port = await freePort();
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl, optimizer: { ...DEFAULT_OPTIMIZER_CONFIG, ...options.optimizer }, ...options.proxy },
    { onTurnComplete: (record) => void turns.push(record) },
    (line) => void logs.push(line)
  );
  await proxy.start();
  open.push(() => proxy.stop());
  return { proxy, turns, logs, url: `http://127.0.0.1:${port}`, port };
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify(body),
  });

const simple = { model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'review the release plan and list the risks' }] };

const jsonReply = (res: http.ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A conversation long enough for compaction to find a worthwhile older segment. */
function longHistory(): Array<Record<string, unknown>> {
  const filler = 'The deployment pipeline stages artifacts, runs integration suites and gates the release on review. '.repeat(30);
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: 'user', content: `step ${i}: ${filler}` });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `done ${i}: ${filler}` }] });
  }
  messages.push({ role: 'user', content: 'now continue with the last step of the plan' });
  return messages;
}

const COMPACTING: Partial<OptimizerConfig> = { slidingThresholdTokens: 3_000, compactionFraction: 0.5, expectedRequestsAfterCompaction: 20 };

const isSummarizerCall = (seen: Seen): boolean => (JSON.parse(seen.body) as { model?: string }).model?.includes('haiku') === true;

test('compaction summarizes old history with Haiku, forwards the manifest and records the summary cost', async () => {
  const fake = await upstream((seen, res) => {
    if (isSummarizerCall(seen)) {
      jsonReply(res, { content: [{ type: 'text', text: 'MANIFEST: pipeline discussed' }], usage: { input_tokens: 4000, output_tokens: 300 } });
    } else {
      jsonReply(res, { usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 800 } });
    }
  });
  const { turns, logs, url } = await startProxy(fake.url, { optimizer: COMPACTING });

  const res = await post(url, { model: 'claude-sonnet-5', max_tokens: 64, messages: longHistory() });
  assert.equal(res.status, 200);

  const calls = fake.seen.map((s) => (JSON.parse(s.body) as { model: string }).model);
  assert.equal(calls.filter((m) => m.includes('haiku')).length >= 1, true, 'the summarizer was called');
  const forwarded = fake.seen.find((s) => !isSummarizerCall(s));
  assert.ok(forwarded?.body.includes('MANIFEST: pipeline discussed'), 'the manifest replaced the old history');
  assert.ok(!forwarded?.body.includes('step 0:'), 'the old turns were dropped');

  assert.equal(turns[0].telemetry.compactionTriggered, true);
  assert.ok((turns[0].telemetry.summarizerUsage?.inputTokens ?? 0) > 0);
  assert.ok(logs.some((l) => l.includes('compaction: summarized')));
});

test('a summarizer that says the prompt is too long is retried with smaller chunks', async () => {
  let summarizerCalls = 0;
  const fake = await upstream((seen, res) => {
    if (isSummarizerCall(seen)) {
      summarizerCalls += 1;
      if (summarizerCalls === 1) {
        jsonReply(res, { type: 'error', error: { message: 'prompt is too long: 250000 tokens' } }, 400);
        return;
      }
      jsonReply(res, { content: [{ type: 'text', text: 'SMALLER MANIFEST' }], usage: { input_tokens: 10, output_tokens: 5 } });
      return;
    }
    jsonReply(res, { usage: { input_tokens: 5, output_tokens: 1 } });
  });
  const { logs, url } = await startProxy(fake.url, { optimizer: COMPACTING });

  assert.equal((await post(url, { model: 'claude-sonnet-5', max_tokens: 64, messages: longHistory() })).status, 200);
  assert.ok(logs.some((l) => /summarizer input too long, retrying with \d+-char chunks/.test(l)), logs.join('\n'));
  assert.ok(summarizerCalls >= 2);
});

test('a summarizer failure keeps the original history and still serves the turn', async () => {
  const fake = await upstream((seen, res) => {
    if (isSummarizerCall(seen)) {
      jsonReply(res, { type: 'error', error: { message: 'overloaded' } }, 529);
      return;
    }
    jsonReply(res, { usage: { input_tokens: 5, output_tokens: 1 } });
  });
  const { turns, url } = await startProxy(fake.url, { optimizer: COMPACTING });

  const res = await post(url, { model: 'claude-sonnet-5', max_tokens: 64, messages: longHistory() });
  assert.equal(res.status, 200);
  const forwarded = fake.seen.find((s) => !isSummarizerCall(s));
  assert.ok(forwarded?.body.includes('step 0:'), 'history untouched');
  assert.equal(turns[0].telemetry.compactionTriggered, false);
  assert.match(turns[0].telemetry.compactionError ?? '', /summarizer returned HTTP 529/);
});

test('exact token counting asks count_tokens for the raw size and falls back to the estimate when it fails', async () => {
  let countStatus = 200;
  const fake = await upstream((seen, res) => {
    if (seen.path === '/v1/messages/count_tokens') {
      if (countStatus === 200) {
        jsonReply(res, { input_tokens: 777 });
      } else {
        jsonReply(res, {}, countStatus);
      }
      return;
    }
    jsonReply(res, { usage: { input_tokens: 5, output_tokens: 1 } });
  });
  const { turns, logs, url } = await startProxy(fake.url, { proxy: { exactTokenCounting: true } });

  await post(url, simple);
  assert.equal(turns[0].telemetry.rawTokens, 777);
  assert.equal(turns[0].telemetry.rawTokensExact, true);

  countStatus = 500;
  await post(url, simple);
  assert.notEqual(turns[1].telemetry.rawTokens, 777);
  assert.ok(turns[1].telemetry.rawTokens > 0);
  assert.ok(logs.some((l) => l.includes('HTTP 500')), logs.join('\n'));
});

test('a 1 hour cache write is flagged, and the proxy then forces 5 minutes', async () => {
  const fake = await upstream((_seen, res) =>
    jsonReply(res, { usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } } })
  );
  const { logs, url } = await startProxy(fake.url, { optimizer: { forceFiveMinuteCache: false } });

  await post(url, simple);
  assert.ok(logs.some((l) => l.includes('900 tokens were written to the 1 hour cache') && l.includes('Forcing 5 minutes from now on')), logs.join('\n'));

  // Now forced: the next request goes out with every ttl removed, and a repeat is reported as unfixable.
  await post(url, {
    ...simple,
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  });
  const second = JSON.parse(fake.seen[1].body) as { system: Array<{ cache_control: Record<string, unknown> }> };
  assert.equal('ttl' in second.system[0].cache_control, false);
  assert.ok(logs.some((l) => l.includes('Still seen after forcing 5 minutes')), logs.join('\n'));
});

test('an upstream error status is logged with its body and its usage-less answer still settles the turn', async () => {
  const fake = await upstream((_seen, res) => jsonReply(res, { type: 'error', error: { message: 'rate limited' } }, 429));
  const { turns, logs, url } = await startProxy(fake.url);

  const res = await post(url, simple);
  assert.equal(res.status, 429);
  assert.equal(turns[0].status, 429);
  assert.equal(turns[0].usage, undefined);
  assert.ok(logs.some((l) => l.includes('upstream HTTP 429') && l.includes('rate limited')));

  const html = await upstream((_seen, r) => r.end('<html>gateway</html>'));
  const second = await startProxy(html.url);
  assert.equal((await post(second.url, simple)).status, 200);
  assert.equal(second.turns[0].usage, undefined, 'a non-JSON body has no usage to read');
});

test('a stream cut mid-way is logged, the turn still settles, and malformed SSE events are ignored', async () => {
  const fake = await upstream((_seen, res, req) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: not json\n\n');
    res.write('data: [DONE]\n\n');
    res.write('event: ping\n\n');
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n');
    setTimeout(() => req.socket.destroy(), 30);
  });
  const { turns, logs, url } = await startProxy(fake.url);

  const res = await post(url, { ...simple, stream: true });
  await res.text().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(turns.length, 1);
  assert.ok(logs.some((l) => l.includes('stream relay interrupted')), logs.join('\n'));
});

test('a message request retries once on a broken connection and a passthrough reports a 502 with the cause', async () => {
  let hits = 0;
  const flaky = await upstream((_seen, res, req) => {
    hits += 1;
    if (hits === 1) {
      req.socket.destroy();
      return;
    }
    jsonReply(res, { usage: { input_tokens: 3, output_tokens: 1 } });
  });
  const a = await startProxy(flaky.url);
  assert.equal((await post(a.url, simple)).status, 200);
  assert.equal(hits, 2);
  assert.ok(a.logs.some((l) => l.includes('retrying once')), a.logs.join(' | '));
  assert.equal(a.turns[0].status, 200);

  const b = await startProxy('http://127.0.0.1:1');
  const down = await fetch(`${b.url}/v1/models`);
  assert.equal(down.status, 502);
  const body = (await down.json()) as { error: { message: string } };
  assert.match(body.error.message, /could not reach the upstream API/);
  assert.ok(b.logs.some((l) => l.includes('passthrough to GET /v1/models failed')));
});

test('/announce accepts a version string and rejects anything else', async () => {
  const fake = await upstream((_s, res) => jsonReply(res, {}));
  const { url } = await startProxy(fake.url);
  const announce = (body: unknown): Promise<Response> =>
    fetch(`${url}/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await announce({ version: '1.2.3' })).status, 200);
  assert.equal((await announce({ version: '1.2.3-beta.1' })).status, 200);
  for (const bad of [{ version: 5 }, { version: 'v1' }, { version: '1..2' }, {}, { version: '1.2; rm' }]) {
    const res = await announce(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: 'invalid version' });
  }
});

test('a project prefix with broken percent-encoding is kept literally instead of failing the request', async () => {
  const fake = await upstream((_s, res) => jsonReply(res, { usage: { input_tokens: 1, output_tokens: 1 } }));
  const { turns, url } = await startProxy(fake.url);

  const res = await fetch(`${url}/w/100%25%ZZ/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(simple),
  });
  assert.equal(res.status, 200);
  assert.equal(turns[0].project, '100%25%ZZ');
  assert.equal(fake.seen[0].path, '/v1/messages');
});

test('start() on a running proxy resolves, and the proxy reports its address and state', async () => {
  const fake = await upstream((_s, res) => jsonReply(res, {}));
  const { proxy, port } = await startProxy(fake.url);
  assert.equal(proxy.running, true);
  assert.equal(proxy.address, `http://127.0.0.1:${port}`);
  await proxy.start();
  await proxy.stop();
  assert.equal(proxy.running, false);
  await proxy.stop();
});
