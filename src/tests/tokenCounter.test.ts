/** Local token estimation and the exact count_tokens round trip. */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';

import { countTokensRemote, estimatePayloadTokens, estimateTextTokens } from '../proxy/tokenCounter';

test('estimateTextTokens: empty is free, prose is ~3.8 chars per token, code is denser', () => {
  assert.equal(estimateTextTokens(''), 0);
  const prose = 'the quick brown fox jumps over the lazy dog '.repeat(10);
  assert.equal(estimateTextTokens(prose), Math.ceil(prose.length / 3.8));

  const code = '{"a":[1,2,3],"b":(x=>y)};'.repeat(10);
  assert.ok(estimateTextTokens(code) > code.length / 3.8, 'punctuation-heavy text costs more per character');
  assert.ok(estimateTextTokens(code) <= Math.ceil(code.length / 3.1));
});

test('estimateTextTokens prices non-ASCII text at 1.6 chars per token', () => {
  const cjk = '漢字漢字漢字漢字';
  assert.equal(estimateTextTokens(cjk), Math.ceil(cjk.length / 1.6));
  // An emoji is one code point, counted once, not as two surrogate halves.
  assert.equal(estimateTextTokens('😀'), Math.ceil(1 / 1.6));
});

test('estimatePayloadTokens adds tools, system and a framing overhead per message', () => {
  assert.equal(estimatePayloadTokens({}), 0);

  const withMessage = estimatePayloadTokens({ messages: [{ role: 'user', content: 'hello there' }] });
  assert.equal(withMessage, 4 + estimateTextTokens('hello there'));

  const system = estimatePayloadTokens({ system: 'be brief' });
  assert.equal(system, estimateTextTokens('be brief'));

  const tools = estimatePayloadTokens({ tools: [{ name: 'run', description: 'runs it', input_schema: { type: 'object' } }] });
  assert.equal(tools, estimateTextTokens('run') + estimateTextTokens('runs it') + estimateTextTokens('{"type":"object"}'));
  // A tool with nothing in it still serializes its empty schema.
  assert.equal(estimatePayloadTokens({ tools: [{}] }), estimateTextTokens('{}'));
});

test('estimatePayloadTokens understands every content block type', () => {
  const blocks = (content: unknown[]): number => estimatePayloadTokens({ messages: [{ role: 'user', content }] }) - 4;

  assert.equal(blocks([{ type: 'text', text: 'abc' }]), estimateTextTokens('abc'));
  assert.equal(blocks([{ type: 'text' }]), 0);
  assert.equal(blocks([{ type: 'thinking', thinking: 'hmm' }]), estimateTextTokens('hmm'));
  assert.equal(blocks([{ type: 'image' }]), 1600);
  assert.equal(blocks([{ type: 'document' }]), 1600);
  assert.equal(
    blocks([{ type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }]),
    estimateTextTokens('{"cmd":"ls"}') + estimateTextTokens('bash')
  );
  assert.equal(blocks([{ type: 'tool_use' }]), estimateTextTokens('{}'));
  // tool_result content may be a string, a list of blocks, or a single block.
  assert.equal(blocks([{ type: 'tool_result', content: 'output text' }]), estimateTextTokens('output text'));
  assert.equal(blocks([{ type: 'tool_result', content: [{ type: 'text', text: 'one' }, 'two'] }]), estimateTextTokens('one') + estimateTextTokens('two'));
  assert.equal(blocks([{ type: 'tool_result', content: { type: 'text', text: 'solo' } }]), estimateTextTokens('solo'));
  // An unknown block is priced as its JSON instead of being ignored; null and numbers are free.
  const unknown = { type: 'mystery', payload: 'x' };
  assert.equal(blocks([unknown]), estimateTextTokens(JSON.stringify(unknown)));
  assert.equal(blocks([null, 5]), 0);
  // A bare string content is valid too.
  assert.equal(estimatePayloadTokens({ messages: [{ role: 'user', content: 'plain' }] }), 4 + estimateTextTokens('plain'));
});

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function withServer<T>(
  respond: (res: http.ServerResponse) => void,
  run: (baseUrl: string, seen: Seen[]) => Promise<T>
): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('countTokensRemote posts only the fields that shape input and returns input_tokens', async () => {
  await withServer(
    (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 4321 }));
    },
    async (baseUrl, seen) => {
      const result = await countTokensRemote(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }], system: 'sys', tools: [{ name: 't' }], max_tokens: 99, stream: true },
        baseUrl,
        { 'x-api-key': 'k' }
      );
      assert.equal(result, 4321);
      assert.equal(seen[0].method, 'POST');
      assert.equal(seen[0].url, '/v1/messages/count_tokens');
      assert.equal(seen[0].headers['x-api-key'], 'k');
      assert.equal(seen[0].headers['content-type'], 'application/json');
      assert.deepEqual(Object.keys(seen[0].body).sort(), ['messages', 'model', 'system', 'tools']);
    }
  );
});

test('countTokensRemote omits system and tools when the payload has none, and sends [] for missing messages', async () => {
  await withServer(
    (res) => res.end(JSON.stringify({ input_tokens: 1 })),
    async (baseUrl, seen) => {
      await countTokensRemote({ model: 'm' }, baseUrl, {});
      assert.deepEqual(seen[0].body, { messages: [], model: 'm' });
    }
  );
});

test('countTokensRemote reports each failure and returns null so the caller can fall back', async () => {
  const reasons: string[] = [];

  await withServer(
    (res) => {
      res.statusCode = 429;
      res.end('{}');
    },
    async (baseUrl) => assert.equal(await countTokensRemote({ model: 'm' }, baseUrl, {}, 5_000, (r) => reasons.push(r)), null)
  );
  await withServer(
    (res) => res.end(JSON.stringify({ input_tokens: 'many' })),
    async (baseUrl) => assert.equal(await countTokensRemote({ model: 'm' }, baseUrl, {}, 5_000, (r) => reasons.push(r)), null)
  );
  await withServer(
    () => undefined,
    async (baseUrl) => assert.equal(await countTokensRemote({ model: 'm' }, baseUrl, {}, 50, (r) => reasons.push(r)), null)
  );
  // Nothing listening: a connection error, not a timeout.
  assert.equal(await countTokensRemote({ model: 'm' }, 'http://127.0.0.1:1', {}, 5_000, (r) => reasons.push(r)), null);

  assert.equal(reasons[0], 'HTTP 429');
  assert.equal(reasons[1], 'response had no input_tokens');
  assert.equal(reasons[2], 'timeout after 50 ms');
  assert.equal(reasons.length, 4);
  assert.ok(!reasons[3].startsWith('timeout'), reasons[3]);
});

test('countTokensRemote works without a failure callback', async () => {
  assert.equal(await countTokensRemote({ model: 'm' }, 'http://127.0.0.1:1', {}, 5_000), null);
});
