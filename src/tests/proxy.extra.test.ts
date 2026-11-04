/**
 * More end-to-end proxy cases: compaction with the locally built summary, exact token counting, upstream
 * failures, interrupted streams and the endpoints other windows use. Helpers are local on purpose, the
 * same convention as `proxy.test.ts`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
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
    { ...DEFAULT_PROXY_CONFIG, port, upstreamBaseUrl, optimizer: { ...DEFAULT_OPTIMIZER_CONFIG, ...options.optimizer }, lookupLatestModels: false, ...options.proxy },
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

const COMPACTING: Partial<OptimizerConfig> = { slidingThresholdTokens: 3_000, compactionFraction: 0.5, expectedRequestsAfterCompaction: 20, agentSummary: false };

const isHaikuCall = (seen: Seen): boolean => (JSON.parse(seen.body) as { model?: string }).model?.includes('haiku') === true;

test('compaction summarizes old history locally: no call to any model, the summary is forwarded, and no model cost is recorded', async () => {
  const fake = await upstream((_seen, res) => {
    jsonReply(res, { usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 800 } });
  });
  const { turns, logs, url } = await startProxy(fake.url, { optimizer: COMPACTING });

  const history = longHistory();
  const res = await post(url, { model: 'claude-sonnet-5', max_tokens: 64, messages: history });
  assert.equal(res.status, 200);

  assert.equal(fake.seen.length, 1, "one request upstream: the user's own, and no summarizer call");
  assert.equal(fake.seen.some(isHaikuCall), false, 'no model was called');
  const forwarded = (JSON.parse(fake.seen[0].body) as { messages: Array<Record<string, unknown>> }).messages[0];
  const first = JSON.stringify(forwarded);
  assert.match(first, /Compacted session state \(earlier history replaced\)/);
  assert.match(first, /Built locally from the transcript, without a model/);
  assert.match(first, /Asked: step 0:/, 'an excerpt of the first request is in the summary');
  assert.ok(fake.seen[0].body.length < JSON.stringify(history).length / 2, 'the old history is not sent in full');

  const t = turns[0].telemetry;
  assert.equal(t.compactionTriggered, true);
  assert.equal(t.summaryKind, 'local');
  assert.ok(logs.some((l) => /compaction: summarized \d+ messages \(~\d+ tokens\) locally into \d+ characters/.test(l)), logs.join('\n'));
});

test('a history that was summarized once keeps the same summary on the next request, with no call anywhere', async () => {
  const fake = await upstream((_seen, res) => {
    jsonReply(res, { usage: { input_tokens: 5, output_tokens: 1 } });
  });
  const { turns, url } = await startProxy(fake.url, { optimizer: COMPACTING });
  const history = longHistory();
  await post(url, { model: 'claude-sonnet-5', max_tokens: 64, messages: history });
  await post(url, { model: 'claude-sonnet-5', max_tokens: 64, messages: [...history, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'and then?' }] });

  assert.equal(turns[1].telemetry.summaryReused, true);
  assert.equal(fake.seen.length, 2, 'only the two requests of the user: nothing was asked of a model for a summary');
  // The text is the same on both requests (the cache anchor is the proxy's and moves from one request to the next).
  const summaryText = (i: number): string =>
    ((JSON.parse(fake.seen[i].body) as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content[0]).text;
  assert.match(summaryText(0), /^Compacted session state/);
  assert.equal(summaryText(0), summaryText(1), 'byte for byte, so the cache keeps matching it');
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

test('a 1 hour cache write is flagged only when cacheTtl is 5m', async () => {
  const reply = (_seen: unknown, res: Parameters<Parameters<typeof upstream>[0]>[1]) =>
    jsonReply(res, { usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } } });
  const five = await startProxy((await upstream(reply)).url);
  await post(five.url, simple);
  assert.ok(five.logs.some((l) => l.includes('900 tokens were written to the 1 hour cache') && l.includes('cacheTtl is 5m')), five.logs.join('\n'));

  const hour = await startProxy((await upstream(reply)).url, { optimizer: { cacheTtl: '1h' } });
  await post(hour.url, simple);
  assert.equal(hour.logs.some((l) => l.includes('1 hour cache')), false, 'expected when the setting asks for 1h');
});

test('cacheTtl decides the ttl every request leaves the proxy with', async () => {
  const withTtl = { ...simple, system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] };
  for (const [ttl, expected] of [['5m', false], ['1h', true]] as const) {
    const fake = await upstream((_seen, res) => jsonReply(res, { usage: { input_tokens: 1, output_tokens: 1 } }));
    const { url } = await startProxy(fake.url, { optimizer: { cacheTtl: ttl } });
    await post(url, withTtl);
    const sent = JSON.parse(fake.seen[0].body) as { system: Array<{ cache_control: Record<string, unknown> }> };
    assert.equal('ttl' in sent.system[0].cache_control, expected, ttl);
  }
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

// --- A new day, end to end: the real proxy, a fake Anthropic and a clock that jumps to the next morning ---

/** `turns` alternating messages (user first) plus the `role: "system"` note Claude Code puts after the messages, with a cache breakpoint so the proxy remembers the chat. */
function dayChat(turns: number): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `turn ${i} `.repeat(250) }] });
  }
  messages.push({ role: 'system', content: [{ type: 'text', text: '# Environment Update\ncwd: C:/repo' }] });
  return { model: 'claude-sonnet-5', max_tokens: 4096, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages };
}

/** The opening of a cleared chat as the ledger shows it: the user's message, injected context first, then the system note. */
function clearedOpening(text: string): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }, { type: 'text', text }] },
      { role: 'system', content: [{ type: 'text', text: 'SessionStart:clear hook output' }] },
    ],
  };
}

test('a new day, through the real proxy: the earlier history is summarized and saved, and the cleared chat receives it once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-day-'));
  const pendingFile = path.join(dir, 'lastdayhistory.json');
  const evening = new Date(2026, 10, 2, 22, 0, 0).getTime();
  const morning = new Date(2026, 10, 3, 9, 0, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: evening });
  try {
    const fake = await upstream((_seen, res) => {
      jsonReply(res, { usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 800 } });
    });
    const { turns, url } = await startProxy(fake.url, { optimizer: { slidingThresholdTokens: 1_000_000, agentSummary: false }, proxy: { pendingHistoryPath: pendingFile } });
    const forwarded = () => fake.seen.filter((s) => !isHaikuCall(s));

    // The evening: an ordinary request of the old chat.
    assert.equal((await post(url, dayChat(21))).status, 200);
    assert.equal(turns[0].telemetry.dayChange, false);
    assert.equal(turns[0].telemetry.clearSuggested, false);

    // The next morning, the same chat sends its first request of the day.
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date'], now: morning });
    assert.equal((await post(url, dayChat(25))).status, 200);
    const day = turns[1].telemetry;
    assert.equal(day.dayChange, true);
    assert.equal(day.compactionTriggered, true);
    assert.equal(day.clearSuggested, true, 'the status bar asks for the /clear');
    assert.equal(fake.seen.some(isHaikuCall), false, 'no model was asked for the summary');
    assert.equal((JSON.parse(forwarded().at(-1)!.body) as { messages: unknown[] }).messages.length, 4, 'summary, acknowledgement, the new message and the system note: the old history is not sent again');
    const saved = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as Record<string, unknown>;
    assert.match(JSON.stringify(saved), /Built locally from the transcript, without a model/, 'the summary waits in the file');
    assert.match(JSON.stringify(saved), /Asked: turn 0 /, 'and it says what was asked');

    // The user clears the chat and sends the first message of the new one.
    assert.equal((await post(url, clearedOpening('hello again'))).status, 200);
    const delivered = turns[2].telemetry;
    assert.equal(delivered.pendingInjected, true);
    assert.equal(delivered.clearSuggested, false, 'the hint goes away once the new chat has the summary');
    const sent = JSON.parse(forwarded().at(-1)!.body) as { messages: Array<Record<string, unknown>> };
    assert.match(JSON.stringify(sent.messages[0]), /Built locally from the transcript/, 'the summary goes first, to Anthropic, in the same request');
    assert.equal(sent.messages.length, 4, 'summary, acknowledgement, the opening and the system note');
    assert.equal(sent.messages[3]['role'], 'system');
    assert.doesNotMatch(fs.readFileSync(pendingFile, 'utf8'), /Built locally/, 'one-shot: it was taken out of the file');

    // The cleared chat's next request still carries it, now remembered by the proxy.
    const next = clearedOpening('hello again') as { messages: Array<Record<string, unknown>> } & Record<string, unknown>;
    next.messages = [next.messages[0], { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, { role: 'user', content: [{ type: 'text', text: 'and then?' }] }];
    assert.equal((await post(url, next)).status, 200);
    assert.equal(turns[3].telemetry.pendingInjected, undefined);
    assert.match(forwarded().at(-1)!.body, /Built locally from the transcript/);
  } finally {
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
