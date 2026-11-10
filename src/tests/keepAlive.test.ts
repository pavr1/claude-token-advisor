import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPingBody, chatKey, KeepAlive, KeepAliveSnapshot } from '../proxy/keepAlive';

const body = JSON.stringify({ model: 'm', stream: true, max_tokens: 32000, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] });
const snapshot = (b = body): KeepAliveSnapshot => ({ body: b, headers: {}, project: 'p' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('buildPingBody keeps the prefix and shrinks only the output', () => {
  const ping = JSON.parse(buildPingBody(body)!);
  assert.equal(ping.max_tokens, 1);
  assert.equal('stream' in ping, false);
  assert.deepEqual(ping.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(ping.thinking, { type: 'adaptive' });
});

test('buildPingBody refuses explicit thinking budgets and bad JSON', () => {
  assert.equal(buildPingBody(JSON.stringify({ thinking: { type: 'enabled', budget_tokens: 2000 } })), undefined);
  assert.equal(buildPingBody('not json'), undefined);
});

test('pings repeat until the cap, then stop', async () => {
  let sent = 0;
  const ka = new KeepAlive({ maxMinutes: 0.0008, intervalMs: 10, send: async () => (sent++, { status: 200 }) }); // 48 ms cap
  ka.remember('p', snapshot());
  await sleep(150);
  assert.ok(sent >= 2 && sent <= 5, `sent ${sent}`);
  const after = sent;
  await sleep(60);
  assert.equal(sent, after);
});

test('a real request cancels the pending ping, and remember restarts it', async () => {
  let sent = 0;
  const ka = new KeepAlive({ maxMinutes: 1, intervalMs: 30, send: async () => (sent++, { status: 200 }) });
  ka.remember('p', snapshot());
  ka.cancel('p');
  await sleep(80);
  assert.equal(sent, 0);
  ka.remember('p', snapshot());
  await sleep(50);
  assert.equal(sent, 1);
  ka.stop();
});

test('no ping while any request of the chat is in flight: a concurrent request finishing does not re-arm it', async () => {
  let sent = 0;
  const ka = new KeepAlive({ maxMinutes: 1, intervalMs: 20, send: async () => (sent++, { status: 200 }) });
  ka.begin('p'); // request A
  ka.begin('p'); // request B, same chat
  ka.remember('p', snapshot()); // A finishes first
  ka.end('p');
  await sleep(80);
  assert.equal(sent, 0); // B is still being processed
  ka.end('p'); // B finishes: the countdown resumes (timed from the last cache use, so it may be due at once)
  await sleep(50);
  assert.ok(sent >= 1);
  ka.stop();
});

test('a request arriving while a ping is in flight stops the ping chain until it ends', async () => {
  let sent = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const ka = new KeepAlive({ maxMinutes: 1, intervalMs: 10, send: async () => (sent++, await gate, { status: 200 }) });
  ka.remember('p', snapshot());
  await sleep(30); // first ping is now in flight
  assert.equal(sent, 1);
  ka.begin('p'); // real request starts; cancel finds no timer
  release();
  await sleep(60);
  assert.equal(sent, 1); // the finished ping did not re-arm during the turn
  ka.end('p');
  await sleep(40);
  assert.ok(sent >= 2);
  ka.stop();
});

test('disabled keep-alive and non-200 answers send nothing further', async () => {
  let sent = 0;
  const off = new KeepAlive({ maxMinutes: 0, intervalMs: 5, send: async () => (sent++, { status: 200 }) });
  off.remember('k', snapshot());
  await sleep(30);
  assert.equal(sent, 0);
  const on = new KeepAlive({ maxMinutes: 1, intervalMs: 10, send: async () => (sent++, { status: 429 }) });
  on.remember('k', snapshot());
  await sleep(60);
  assert.equal(sent, 1);
});

test('each chat keeps its own timer, whatever the model', async () => {
  const seen: Array<string | undefined> = [];
  const ka = new KeepAlive({ maxMinutes: 1, intervalMs: 20, send: async (s) => (seen.push(s.project), { status: 200 }) });
  ka.remember('a', { ...snapshot(), project: 'a' });
  ka.remember('b', { ...snapshot(JSON.stringify({ model: 'other', messages: [] })), project: 'b' });
  ka.cancel('a');
  await sleep(50);
  assert.ok(seen.length >= 1 && seen.every((p) => p === 'b'));
  ka.stop();
});

test('chatKey uses the session id, then the project', () => {
  const sid = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(chatKey({ metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: sid }) } }, 'p'), sid);
  assert.equal(chatKey({ metadata: { user_id: `user_x_account_y_session_${sid}` } }, 'p'), sid);
  assert.equal(chatKey({}, 'p'), 'project:p');
});

test('a timer the machine froze fires late: the cache is gone, so no ping is sent and the chat stops', async () => {
  let sent = 0;
  const logs: string[] = [];
  let clock = 0;
  const ka = new KeepAlive({ maxMinutes: 60, intervalMs: 20, now: () => clock, log: (m) => logs.push(m), send: async () => (sent++, { status: 200 }) });
  ka.remember('p', snapshot());
  clock = 14 * 60_000; // the PC slept for 14 minutes; the timer fires as soon as it wakes
  await sleep(60);
  assert.equal(sent, 0);
  assert.match(logs.join(' | '), /not pinging/);
  clock += 1000;
  await sleep(60);
  assert.equal(sent, 0, 'the chat is not pinged again until a real request restarts it');
  ka.remember('p', snapshot());
  await sleep(60);
  assert.ok(sent >= 1, 'a new real request starts the countdown again');
  ka.stop();
});

test('with the 1 hour cache a late timer still pings: the cache is alive', async () => {
  let sent = 0;
  let clock = 0;
  const ka = new KeepAlive({ maxMinutes: 120, intervalMs: 20, lifetimeMs: () => 3_600_000, now: () => clock, send: async () => (sent++, { status: 200 }) });
  ka.remember('p', snapshot());
  clock = 14 * 60_000;
  await sleep(60);
  assert.ok(sent >= 1, 'the 1 hour cache is still alive, so the ping goes out');
  ka.stop();
});

test('the first ping is timed from when the request went upstream, not from when its answer finished', async () => {
  const sentAt: number[] = [];
  const ka = new KeepAlive({ maxMinutes: 1, intervalMs: 200, send: async () => (sentAt.push(Date.now()), { status: 200, usage: { cache_read_input_tokens: 500 } }) });
  const start = Date.now();
  // The answer took 150 ms: the request went upstream 150 ms before it was remembered.
  ka.remember('p', { ...snapshot(), usedAt: start - 150 });
  await sleep(330);
  ka.stop();
  assert.ok(sentAt.length >= 1, 'a ping went out');
  assert.ok(sentAt[0] - start < 130, `first ping after ${sentAt[0] - start} ms; timed from the finish it would wait the whole 200 ms`);
});

test('each later ping is timed from when the previous one was sent, so a slow ping does not push the next', async () => {
  const sentAt: number[] = [];
  const ka = new KeepAlive({
    maxMinutes: 1,
    intervalMs: 150,
    send: async () => {
      sentAt.push(Date.now());
      await sleep(100); // a ping that takes long to answer
      return { status: 200, usage: { cache_read_input_tokens: 500 } };
    },
  });
  ka.remember('p', snapshot());
  await sleep(560);
  ka.stop();
  assert.ok(sentAt.length >= 2, `pings ${sentAt.length}`);
  assert.ok(sentAt[1] - sentAt[0] < 200, `gap ${sentAt[1] - sentAt[0]} ms: timed from the end of the first it would be 250`);
});

test('a ping that had to write the cache found it already gone: it is the last one of the chat', async () => {
  let sent = 0;
  const logs: string[] = [];
  const ka = new KeepAlive({
    maxMinutes: 1,
    intervalMs: 20,
    log: (m) => logs.push(m),
    send: async () => (sent++, { status: 200, usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 589_000 } }),
  });
  ka.remember('p', snapshot());
  await sleep(150);
  assert.equal(sent, 1, 'no second ping after one that only wrote');
  assert.match(logs.join(' | '), /had to write the cache.*already gone/);
  // A ping that read the cache keeps the chain going.
  let warm = 0;
  const alive = new KeepAlive({ maxMinutes: 1, intervalMs: 20, send: async () => (warm++, { status: 200, usage: { cache_read_input_tokens: 589_000, cache_creation_input_tokens: 0 } }) });
  alive.remember('q', snapshot());
  await sleep(150);
  alive.stop();
  assert.ok(warm >= 3, `warm pings ${warm}`);
});

test('lastTouchedAt says when the cache of a chat was last used: its real request, then each ping, and nothing once it is not kept warm', async () => {
  const ka = new KeepAlive({ maxMinutes: 1, intervalMs: 20, send: async () => ({ status: 200 }) });
  assert.equal(ka.lastTouchedAt('p'), undefined, 'a chat the keep-alive does not know');
  const before = Date.now();
  ka.remember('p', snapshot());
  const first = ka.lastTouchedAt('p');
  assert.ok(first !== undefined && first >= before && first <= Date.now(), 'the real request');
  await sleep(70);
  const afterPings = ka.lastTouchedAt('p');
  assert.ok(afterPings !== undefined && afterPings > first!, 'a ping renewed the cache and moved it on');
  assert.equal(ka.lastTouchedAt('other'), undefined, 'each chat has its own');
  ka.stop();
  assert.equal(ka.lastTouchedAt('p'), undefined, 'stopped: nothing is being kept warm');
  const off = new KeepAlive({ maxMinutes: 0, intervalMs: 20, send: async () => ({ status: 200 }) });
  off.remember('p', snapshot());
  assert.equal(off.lastTouchedAt('p'), undefined, 'keep-alive off');
});

test('a chat whose terminal is closed is not pinged, and the others still are', async () => {
  const sent: Array<string | undefined> = [];
  const logs: string[] = [];
  const ka = new KeepAlive({
    maxMinutes: 1,
    intervalMs: 15,
    log: (m) => logs.push(m),
    shouldPing: (s) => s.terminalKey !== '1@1',
    send: async (s) => (sent.push(s.terminalKey), { status: 200 }),
  });
  ka.remember('closed', { ...snapshot(), terminalKey: '1@1' });
  ka.remember('open', { ...snapshot(), terminalKey: '2@2' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  ka.stop();
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((key) => key === '2@2'));
  assert.ok(logs.some((m) => /terminal of \[p\] is closed/.test(m)));
});
