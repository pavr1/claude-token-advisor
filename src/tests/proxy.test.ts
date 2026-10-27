/**
 * End-to-end tests for the proxy router, run against a fake upstream that stands
 * in for api.anthropic.com. These cover the parts unit tests cannot reach:
 * streaming relay, usage capture, header forwarding, and passthrough routing.
 */

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { DEFAULT_OPTIMIZER_CONFIG } from '../proxy/optimizer';
import { announceVersion, probeProxy, subscribeToEvents } from '../proxy/coordinator';
import {
  DEFAULT_PROXY_CONFIG,
  isNewerVersion,
  parseUnifiedRateLimitHeaders,
  PROXY_SERVICE_ID,
  ProxyEvent,
  ProxyPortInUseError,
  TokenImproverProxy,
  TurnRecord,
  UnifiedRateLimitSnapshot,
  splitForSummarizer,
  describeFetchError,
  isRetryableConnectionError,
} from '../proxy/server';
import { RealCostEvent } from '../analytics/realCostTracker';

interface UpstreamCapture {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Servers opened by the helpers below. A failed assert skips the `proxy.stop()` at the end of a
 * test, and an open listener keeps `node --test` alive forever, so the suite hung instead of
 * failing. Closing here lets a failure surface as a failure; the explicit stops in each test stay
 * valid because both `stop()` and `close()` tolerate a second call.
 */
const openResources: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = openResources.splice(0);
  await Promise.all(pending.map((close) => close()));
});

/** A stand-in Anthropic API that records what it was sent. */
async function startFakeUpstream(
  handler: (capture: UpstreamCapture, res: http.ServerResponse) => void
): Promise<{ url: string; captures: UpstreamCapture[]; close: () => Promise<void> }> {
  const captures: UpstreamCapture[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const capture: UpstreamCapture = {
        path: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      captures.push(capture);
      handler(capture, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  openResources.push(close);

  return { url: `http://127.0.0.1:${port}`, captures, close };
}

/** Start the proxy on an ephemeral port, collecting the turns it reports. */
async function startProxy(upstreamBaseUrl: string, optimizer = DEFAULT_OPTIMIZER_CONFIG) {
  const turns: TurnRecord[] = [];
  const realCosts: RealCostEvent[] = [];

  // Probe for a free port by binding and releasing one.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const starts = { count: 0, projects: [] as (string | undefined)[] };
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl, optimizer },
    {
      onRequestStart: (project) => {
        starts.count += 1;
        starts.projects.push(project);
      },
      onTurnComplete: (record) => {
        turns.push(record);
      },
      onRealCost: (sample) => {
        realCosts.push(sample);
      },
    },
    () => undefined
  );
  await proxy.start();
  openResources.push(() => proxy.stop());

  return { proxy, turns, starts, realCosts, url: `http://127.0.0.1:${port}` };
}

// --- Minimal protobuf encoders for a one-metric ExportMetricsServiceRequest fixture ---
// (Mirrors the fuller set in `otlpDecoder.test.ts`; kept local per this file's own
// convention of not sharing test helpers across files, e.g. `startFakeUpstream`.)

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

function encodeTag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType);
}

function encodeLengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeTag(field, 2), encodeVarint(payload.length), payload]);
}

function encodeString(field: number, value: string): Buffer {
  return encodeLengthDelimited(field, Buffer.from(value, 'utf8'));
}

function encodeFixed64Double(field: number, value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([encodeTag(field, 1), buf]);
}

function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(value)]);
}

/** Builds a one-data-point `claude_code.cost.usage` ExportMetricsServiceRequest. `temporality` defaults to omitted (cumulative). */
function buildCostUsageMetricsBuffer(
  valueUsd: number,
  attributes: Record<string, string>,
  temporality?: 'delta' | 'cumulative'
): Buffer {
  const attributeFields = Object.entries(attributes).map(([key, value]) =>
    encodeLengthDelimited(
      7, // NumberDataPoint.attributes
      Buffer.concat([encodeString(1, key), encodeLengthDelimited(2, encodeString(1, value))]) // KeyValue{key, value: AnyValue.string_value}
    )
  );
  const dataPoint = Buffer.concat([...attributeFields, encodeFixed64Double(4, valueUsd)]); // as_double
  const temporalityField = temporality ? encodeVarintField(2, temporality === 'delta' ? 1 : 2) : Buffer.alloc(0);
  const sum = Buffer.concat([encodeLengthDelimited(1, dataPoint), temporalityField]); // Sum.data_points, .aggregation_temporality
  const metric = Buffer.concat([encodeString(1, 'claude_code.cost.usage'), encodeLengthDelimited(7, sum)]); // Metric.name, .sum
  const scopeMetrics = encodeLengthDelimited(2, metric); // ScopeMetrics.metrics
  const resourceMetrics = encodeLengthDelimited(2, scopeMetrics); // ResourceMetrics.scope_metrics
  return encodeLengthDelimited(1, resourceMetrics); // ExportMetricsServiceRequest.resource_metrics
}

test('a non-streaming turn is optimized, forwarded, and its usage recorded', async () => {
  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        content: [{ type: 'text', text: 'done' }],
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 30,
        },
      })
    );
  });

  const { proxy, turns, url } = await startProxy(upstream.url);

  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hey Claude, here is some context.\r\n' },
        { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
        { role: 'user', content: 'Continue with the plan for the release.' },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const parsed = (await response.json()) as { id: string };
  assert.equal(parsed.id, 'msg_1');

  // Credentials must reach the upstream untouched.
  assert.equal(upstream.captures[0].headers['x-api-key'], 'sk-test');
  assert.equal(upstream.captures[0].path, '/v1/messages');

  // The forwarded body must be the optimized one.
  const forwarded = JSON.parse(upstream.captures[0].body) as Record<string, unknown>;
  const messages = forwarded['messages'] as Array<Record<string, unknown>>;
  assert.equal(messages[0]['content'], 'here is some context.');

  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 200);
  assert.equal(turns[0].usage?.cache_read_input_tokens, 900);
  assert.equal(turns[0].usage?.output_tokens, 40);

  await proxy.stop();
  await upstream.close();
});

test('5.1: anthropic-ratelimit-unified-* response headers are logged when present, silent when absent', async () => {
  const withHeader = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-remaining': '42',
    });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }));
  });

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const logs: string[] = [];
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: withHeader.url },
    { onTurnComplete: () => undefined },
    (message) => logs.push(message)
  );
  await proxy.start();

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  const rateLimitLog = logs.find((line) => line.includes('rate-limit headers'));
  assert.ok(rateLimitLog, 'expected a rate-limit headers log line');
  assert.ok(rateLimitLog!.includes('anthropic-ratelimit-unified-status: allowed'));
  assert.ok(rateLimitLog!.includes('anthropic-ratelimit-unified-5h-remaining: 42'));

  await proxy.stop();
  await withHeader.close();
});

test('5.1: no rate-limit headers means no log line at all', async () => {
  const withoutHeader = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }));
  });

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const logs: string[] = [];
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: withoutHeader.url },
    { onTurnComplete: () => undefined },
    (message) => logs.push(message)
  );
  await proxy.start();

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.ok(!logs.some((line) => line.includes('rate-limit headers')));

  await proxy.stop();
  await withoutHeader.close();
});

test('5.3: parseUnifiedRateLimitHeaders reads both windows, matching the live Pro-account shape from 5.1', () => {
  const upstream = new Response(null, {
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.76',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': '1790366400',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-reset': '1790917200',
    },
  });

  const info = parseUnifiedRateLimitHeaders(upstream);

  assert.deepEqual(info, {
    fiveHour: { utilization: 0.76, resetEpochSeconds: 1790366400 },
    sevenDay: { utilization: 0.1, resetEpochSeconds: 1790917200 },
  });
});

test('5.3: parseUnifiedRateLimitHeaders returns undefined when neither window is present', () => {
  const upstream = new Response(null, { headers: { 'content-type': 'application/json' } });
  assert.equal(parseUnifiedRateLimitHeaders(upstream), undefined);
});

test('5.3: parseUnifiedRateLimitHeaders tolerates a window with no reset header', () => {
  const upstream = new Response(null, {
    headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.5' },
  });

  const info = parseUnifiedRateLimitHeaders(upstream);

  assert.deepEqual(info, { fiveHour: { utilization: 0.5, resetEpochSeconds: undefined }, sevenDay: undefined });
});

test('5.3: a rate-limit reading on a Messages response reaches onRateLimitUpdate', async () => {
  const withHeaders = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.38',
      'anthropic-ratelimit-unified-5h-reset': '1790366400',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-reset': '1790917200',
    });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }));
  });

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const readings: UnifiedRateLimitSnapshot[] = [];
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: withHeaders.url },
    { onTurnComplete: () => undefined, onRateLimitUpdate: (info) => readings.push(info) },
    () => undefined
  );
  await proxy.start();

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(readings.length, 1);
  assert.deepEqual(readings[0], {
    fiveHour: { utilization: 0.38, resetEpochSeconds: 1790366400 },
    sevenDay: { utilization: 0.1, resetEpochSeconds: 1790917200 },
  });

  await proxy.stop();
  await withHeaders.close();
});

test('a window joining after a rate-limit reading already landed gets it replayed immediately', async () => {
  const withHeaders = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.38',
      'anthropic-ratelimit-unified-5h-reset': '1790366400',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-reset': '1790917200',
    });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }));
  });

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: withHeaders.url },
    { onTurnComplete: () => undefined },
    () => undefined
  );
  await proxy.start();

  // The reading lands before anyone is listening on /events.
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  // A window joining afterwards must see it right away, with no new turn.
  const received: ProxyEvent[] = [];
  subscribeToEvents(port, (event) => received.push(event), () => undefined);
  for (let attempt = 0; received.length === 0 && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.deepEqual(received[0], {
    type: 'rateLimit',
    info: {
      fiveHour: { utilization: 0.38, resetEpochSeconds: 1790366400 },
      sevenDay: { utilization: 0.1, resetEpochSeconds: 1790917200 },
    },
  });

  await proxy.stop();
  await withHeaders.close();
});

test('a streaming turn is relayed byte-for-byte and usage is read off the stream', async () => {
  const events = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":55,"cache_read_input_tokens":4000,"cache_creation_input_tokens":10}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":77}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Split mid-JSON so the parser has to survive a chunk boundary.
    const split = Math.floor(events.length / 2);
    res.write(events.slice(0, split));
    setTimeout(() => {
      res.write(events.slice(split));
      res.end();
    }, 10);
  });

  const { proxy, turns, url } = await startProxy(upstream.url);

  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');

  const received = await response.text();
  assert.equal(received, events, 'the SSE body must reach the client unmodified');

  assert.equal(turns.length, 1);
  assert.equal(turns[0].usage?.input_tokens, 55);
  assert.equal(turns[0].usage?.cache_read_input_tokens, 4000);
  assert.equal(turns[0].usage?.output_tokens, 77);

  await proxy.stop();
  await upstream.close();
});

test('3b.3: onStreamProgress fires with the running output count on each message_delta', async () => {
  const events = [
    'data: {"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":10}}}',
    '',
    'data: {"type":"message_delta","usage":{"output_tokens":20}}',
    '',
    'data: {"type":"message_delta","usage":{"output_tokens":77}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events);
  });

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const progress: Array<{ outputTokens: number; project: string | undefined }> = [];
  const proxy = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl: upstream.url },
    {
      onTurnComplete: () => undefined,
      onStreamProgress: (outputTokens, project) => progress.push({ outputTokens, project }),
    },
    () => undefined
  );
  await proxy.start();

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.deepEqual(
    progress.map((p) => p.outputTokens),
    [20, 77]
  );
  assert.equal(progress[0].project, undefined);

  await proxy.stop();
  await upstream.close();
});

test('non-messages endpoints are passed through untouched', async () => {
  const upstream = await startFakeUpstream((capture, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seen: capture.path, method: capture.method }));
  });

  const { proxy, turns, url } = await startProxy(upstream.url);

  const response = await fetch(`${url}/v1/models`, { headers: { 'x-api-key': 'sk-test' } });
  const parsed = (await response.json()) as { seen: string; method: string };

  assert.equal(parsed.seen, '/v1/models');
  assert.equal(parsed.method, 'GET');
  // A passthrough is not an optimized turn and must not land in the ledger.
  assert.equal(turns.length, 0);

  await proxy.stop();
  await upstream.close();
});

test('POST /v1/metrics decodes a cost.usage sample and reports it to the observer', async () => {
  const { proxy, realCosts, url } = await startProxy('https://api.anthropic.com');

  const body = buildCostUsageMetricsBuffer(0.42, { 'user.account_uuid': 'acct-1', 'session.id': 'sess-1' });
  const response = await fetch(`${url}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array(body),
  });

  assert.equal(response.status, 200);
  assert.equal(realCosts.length, 1);
  assert.ok(Math.abs(realCosts[0].valueUsd - 0.42) < 1e-9);
  assert.equal(realCosts[0].temporality, 'cumulative');
  assert.equal(typeof realCosts[0].seriesKey, 'string');
  assert.ok(realCosts[0].seriesKey.includes('acct-1'));

  await proxy.stop();
});

test('POST /v1/metrics reports an explicit DELTA temporality', async () => {
  const { proxy, realCosts, url } = await startProxy('https://api.anthropic.com');

  const body = buildCostUsageMetricsBuffer(0.05, { 'session.id': 'sess-1' }, 'delta');
  const response = await fetch(`${url}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array(body),
  });

  assert.equal(response.status, 200);
  assert.equal(realCosts.length, 1);
  assert.equal(realCosts[0].temporality, 'delta');

  await proxy.stop();
});

test('POST /v1/metrics with a garbage body still returns 200 and never crashes the process', async () => {
  const { proxy, realCosts, url } = await startProxy('https://api.anthropic.com');

  const response = await fetch(`${url}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array(Buffer.from([0xff, 0x00, 0xff])),
  });

  assert.equal(response.status, 200);
  assert.equal(realCosts.length, 0);

  await proxy.stop();
});

test('an unreachable upstream returns 502 and still records the turn', async () => {
  // Port 1 is reserved and refuses connections.
  const { proxy, turns, url } = await startProxy('http://127.0.0.1:1');

  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(response.status, 502);
  const parsed = (await response.json()) as { error: { type: string } };
  assert.equal(parsed.error.type, 'api_error');

  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 0);

  await proxy.stop();
});

test('a malformed body is rejected before anything is forwarded', async () => {
  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200).end('{}');
  });
  const { proxy, url } = await startProxy(upstream.url);

  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5' }),
  });

  assert.equal(response.status, 400);
  assert.equal(upstream.captures.length, 0, 'nothing should reach the upstream');

  await proxy.stop();
  await upstream.close();
});

// --- Activity signalling ----------------------------------------------------
// The status bar spins on an in-flight counter driven by these two callbacks, so
// an unbalanced pair would leave the spinner running forever.

test('a successful turn emits exactly one start and one completion', async () => {
  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5 } }));
  });

  const { proxy, turns, starts, url } = await startProxy(upstream.url);

  await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(starts.count, 1);
  assert.equal(turns.length, 1);

  await proxy.stop();
  await upstream.close();
});

test('a streaming turn balances even though it completes in a finally block', async () => {
  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
    res.end();
  });

  const { proxy, turns, starts, url } = await startProxy(upstream.url);

  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await response.text();

  assert.equal(starts.count, 1);
  assert.equal(turns.length, 1);

  await proxy.stop();
  await upstream.close();
});

test('a failed turn still balances, so the indicator cannot hang', async () => {
  const { proxy, turns, starts, url } = await startProxy('http://127.0.0.1:1');

  await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(starts.count, 1);
  assert.equal(turns.length, 1);

  await proxy.stop();
});

test('a rejected body emits neither a start nor a completion', async () => {
  const upstream = await startFakeUpstream((_capture, res) => {
    res.writeHead(200).end('{}');
  });
  const { proxy, turns, starts, url } = await startProxy(upstream.url);

  await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5' }),
  });

  assert.equal(starts.count, 0);
  assert.equal(turns.length, 0);

  await proxy.stop();
  await upstream.close();
});

test('concurrent turns each balance independently', async () => {
  const upstream = await startFakeUpstream((_capture, res) => {
    // Hold each response briefly so the requests genuinely overlap.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', usage: { input_tokens: 10 } }));
    }, 25);
  });

  const { proxy, turns, starts, url } = await startProxy(upstream.url);

  const send = () =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    }).then((response) => response.text());

  await Promise.all([send(), send(), send()]);

  assert.equal(starts.count, 3);
  assert.equal(turns.length, 3);

  await proxy.stop();
  await upstream.close();
});

test('the health endpoint reports the active upstream', async () => {
  const { proxy, url } = await startProxy('https://api.anthropic.com');

  const response = await fetch(`${url}/health`);
  const parsed = (await response.json()) as { status: string; upstream: string };

  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.upstream, 'https://api.anthropic.com');

  await proxy.stop();
});

// ---------------------------------------------------------------------------
// Multi-window singleton: project tagging, identity, events, coordination
// ---------------------------------------------------------------------------

/** A fake upstream that answers every request with a small non-streaming message. */
function okUpstream() {
  return startFakeUpstream((capture, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        seen: capture.path,
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );
  });
}

const TURN_BODY = JSON.stringify({
  model: 'claude-sonnet-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Continue with the plan.' }],
});

test('a /w/<project> prefix tags the turn and is stripped before forwarding', async () => {
  const upstream = await okUpstream();
  const { proxy, turns, starts, url } = await startProxy(upstream.url);

  const response = await fetch(`${url}/w/${encodeURIComponent('my app')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
    body: TURN_BODY,
  });
  assert.equal(response.status, 200);

  assert.equal(upstream.captures[0].path, '/v1/messages');
  assert.deepEqual(starts.projects, ['my app']);
  assert.equal(turns[0].project, 'my app');

  await proxy.stop();
  await upstream.close();
});

test('an untagged turn reports no project', async () => {
  const upstream = await okUpstream();
  const { proxy, turns, starts, url } = await startProxy(upstream.url);

  await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: TURN_BODY,
  });

  assert.deepEqual(starts.projects, [undefined]);
  assert.equal(turns[0].project, undefined);

  await proxy.stop();
  await upstream.close();
});

test('Stage 0: only the first request since proxy start is defaulted off Opus, and only if it is on Opus', async () => {
  const upstream = await okUpstream();
  const { proxy, turns, url } = await startProxy(upstream.url);

  const opusBody = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 64,
    // Not a greeting or simple task: Stage 3 would otherwise route it to Haiku and mask Stage 0.
    messages: [{ role: 'user', content: 'review the release plan and summarize the open risks' }],
  });

  await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: opusBody });
  await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: opusBody });

  assert.equal(JSON.parse(upstream.captures[0].body).model, 'claude-sonnet-5');
  assert.equal(turns[0].telemetry.startupModelDefaulted, true);

  // A later request explicitly on Opus (e.g. the user ran `/model opus`) must reach
  // upstream as Opus, not get fought back to Sonnet.
  assert.equal(JSON.parse(upstream.captures[1].body).model, 'claude-opus-5');
  assert.equal(turns[1].telemetry.startupModelDefaulted, false);

  await proxy.stop();
  await upstream.close();
});

test('a tagged passthrough reaches upstream without the prefix', async () => {
  const upstream = await okUpstream();
  const { proxy, url } = await startProxy(upstream.url);

  await fetch(`${url}/w/app/v1/models`, { headers: { 'x-api-key': 'sk-test' } });
  assert.equal(upstream.captures[0].path, '/v1/models');

  await proxy.stop();
  await upstream.close();
});

test('the health endpoint identifies the proxy so other windows can join it', async () => {
  const { proxy, url } = await startProxy('https://api.anthropic.com');

  const parsed = (await (await fetch(`${url}/health`)).json()) as { service: string; pid: number };
  assert.equal(parsed.service, PROXY_SERVICE_ID);
  assert.equal(parsed.pid, process.pid);

  const port = Number(new URL(url).port);
  assert.deepEqual(await probeProxy(port), { kind: 'ours', pid: process.pid });

  await proxy.stop();
});

test('probeProxy tells a foreign server and a free port apart', async () => {
  const foreign = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not us</html>');
  });
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const port = (foreign.address() as AddressInfo).port;

  assert.deepEqual(await probeProxy(port), { kind: 'foreign' });

  await new Promise<void>((resolve) => {
    foreign.close(() => resolve());
    foreign.closeAllConnections();
  });
  assert.deepEqual(await probeProxy(port), { kind: 'none' });
});

test('a second proxy on the same port fails with ProxyPortInUseError', async () => {
  const { proxy, url } = await startProxy('https://api.anthropic.com');
  const port = Number(new URL(url).port);

  const second = new TokenImproverProxy(
    { ...DEFAULT_PROXY_CONFIG, port },
    { onTurnComplete: () => undefined },
    () => undefined
  );
  await assert.rejects(second.start(), ProxyPortInUseError);

  await proxy.stop();
});

test('broadcast events reach subscribers, and stopping the owner ends the stream', async () => {
  const { proxy, url } = await startProxy('https://api.anthropic.com');
  const port = Number(new URL(url).port);

  const received: ProxyEvent[] = [];
  let ended = 0;
  subscribeToEvents(
    port,
    (event) => received.push(event),
    () => {
      ended += 1;
    }
  );
  // The server registers the client once the stream opens; broadcast until one lands.
  for (let attempt = 0; received.length === 0 && attempt < 100; attempt++) {
    proxy.broadcast({ type: 'start', project: 'app' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.deepEqual(received[0], { type: 'start', project: 'app' });

  await proxy.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ended, 1);
});

test('a closed subscription never reports an end', async () => {
  const { proxy, url } = await startProxy('https://api.anthropic.com');
  let ended = 0;
  const subscription = subscribeToEvents(Number(new URL(url).port), () => undefined, () => {
    ended += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  subscription.close();
  await proxy.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ended, 0);
});

test('splitForSummarizer keeps one chunk when it fits', () => {
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
  const asst = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
  assert.equal(splitForSummarizer([user('a'), asst('b'), user('c'), asst('d')], 10_000).length, 1);
});

test('splitForSummarizer cuts only on fresh user turns and preserves order', () => {
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
  const asst = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(300) }] };
  const msgs = [user('a'.repeat(300)), asst('b'), toolResult, asst('c'), user('d'.repeat(300)), asst('e')];
  const chunks = splitForSummarizer(msgs, 400);
  assert.deepEqual(chunks.flat(), msgs);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(1)) {
    assert.ok(!JSON.stringify(chunk[0]).includes('tool_result'));
  }
});

test('isNewerVersion compares dotted numeric versions', () => {
  assert.equal(isNewerVersion('0.2.10', '0.2.9'), true);
  assert.equal(isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(isNewerVersion('0.1.9', '0.2.0'), false);
  assert.equal(isNewerVersion('1.0', '0.9.9'), true);
});

test('an announced version reaches subscribers, and only a newer one is re-announced', async () => {
  const { proxy, url } = await startProxy('https://api.anthropic.com');
  const port = Number(new URL(url).port);
  const seen: string[] = [];
  proxy.announceVersion('0.2.0');

  const received: ProxyEvent[] = [];
  subscribeToEvents(port, (event) => received.push(event), () => undefined);
  // The newest version is replayed to a window that joins afterwards.
  for (let attempt = 0; received.length === 0 && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(received[0], { type: 'extensionVersion', version: '0.2.0' });

  await announceVersion(port, '0.2.0');
  await announceVersion(port, '0.1.0');
  await announceVersion(port, '0.3.0');
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const event of received) {
    if (event.type === 'extensionVersion') {
      seen.push(event.version);
    }
  }
  assert.deepEqual(seen, ['0.2.0', '0.3.0']);

  await proxy.stop();
});

test('a fetch failure reports its cause, and only broken connections are retried', () => {
  const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } });
  assert.equal(describeFetchError(reset), 'fetch failed (ECONNRESET read ECONNRESET)');
  assert.equal(describeFetchError(new Error('boom')), 'boom');
  assert.equal(isRetryableConnectionError(reset), true);
  assert.equal(isRetryableConnectionError(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })), false);
  assert.equal(isRetryableConnectionError(new Error('boom')), false);
});
