/**
 * Unit tests for the optimization engine. These exercise the pure pipeline only —
 * no network, no VS Code host — by injecting a fake summarizer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyRouting,
  hasToolResults,
  DEFAULT_OPTIMIZER_CONFIG,
  HAIKU_MODEL_ID,
  SUMMARIZER_CHUNK_CHARS,
  manifestSystemPrompt,
  clientCacheTtlMs,
  forceFiveMinuteCache,
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  manifestTargetTokens,
  MANIFEST_MAX_TOKENS,
  MANIFEST_MIN_TOKENS,
  latestUserText,
  normalizeText,
  optimizePayload,
  OptimizerConfig,
  stripFluff,
  SummaryStore,
  SUMMARY_TTL_MS,
  BaselineMemory,
  hasClientCacheControl,
  estimateCompactionEconomics,
} from '../proxy/optimizer';
import { estimatePayloadTokens, MessagesPayload } from '../proxy/tokenCounter';

function config(overrides: Partial<OptimizerConfig> = {}): OptimizerConfig {
  // Small test histories sit far below the production 150K cold-cache floor.
  return { ...DEFAULT_OPTIMIZER_CONFIG, ...overrides };
}

/** Build a payload with `turns` alternating user/assistant messages of `size` chars. */
function historyPayload(turns: number, size: number, model = 'claude-sonnet-5'): MessagesPayload {
  const messages: Array<Record<string, unknown>> = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `turn ${index} `.repeat(Math.ceil(size / 8)) }],
    });
  }
  return { model, max_tokens: 4096, messages };
}

// --- Stage 1 -----------------------------------------------------------------

test('normalizeText converts CRLF, strips trailing spaces, and trims', () => {
  assert.equal(normalizeText('a\r\nb\r\n'), 'a\nb');
  assert.equal(normalizeText('  hello  \n  world   \n'), 'hello\n  world');
  assert.equal(normalizeText('line\r\rnext'), 'line\n\nnext');
});

test('normalization rewrites text blocks but leaves other fields byte-identical', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first\r\nsecond  ' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA\r\nBB' } },
        ],
      },
    ],
  };

  const { payload: out } = await optimizePayload(payload, config({ enableCompaction: false, enableModelRouting: false }));
  const blocks = out.messages![0]['content'] as Array<Record<string, unknown>>;

  assert.equal(blocks[0]['text'], 'first\nsecond');
  // base64 image data must survive untouched — rewriting it would corrupt the image.
  assert.equal((blocks[1]['source'] as Record<string, unknown>)['data'], 'AA\r\nBB');
});

// --- Stage 2 -----------------------------------------------------------------

test('stripFluff removes stacked greeting filler but keeps the instruction', () => {
  assert.equal(stripFluff('Hey Claude, could you please rename this variable?'), 'rename this variable?');
  assert.equal(stripFluff('Please help me with the regex'), 'the regex');
  assert.equal(stripFluff('Refactor the parser'), 'Refactor the parser');
});

test('stripFluff never returns empty when the whole message was filler', () => {
  assert.equal(stripFluff('Hey Claude'), 'Hey Claude');
});

test('fluff stripping applies to user turns only', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'Hey Claude, sort these' },
      { role: 'assistant', content: 'Hey Claude, sort these' },
    ],
  };

  const { payload: out } = await optimizePayload(payload, config({ enableModelRouting: false, enableCacheAnchor: false }));
  assert.equal(out.messages![0]['content'], 'sort these');
  assert.equal(out.messages![1]['content'], 'Hey Claude, sort these');
});

test('compaction does not run below the sliding threshold', async () => {
  let called = false;
  const payload = historyPayload(6, 40);

  const { telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 100_000 }), {
    summarize: async () => {
      called = true;
      return { text: 'manifest', usage: { inputTokens: 500, outputTokens: 80 } };
    },
  });

  assert.equal(called, false);
  assert.equal(telemetry.compactionTriggered, false);
});

test('compaction skips a trigger whose compactable "older" segment is too thin to be worth a Haiku call', async () => {
  // The last two messages are always kept verbatim regardless of size, so a single
  // huge second-to-last message forces the entire kept "recent" tail past budget in
  // one step, leaving only the four tiny leading turns as "older" — a real shape
  // (one big tool result right before the newest turn), not a contrived edge case.
  let called = false;
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: `HEAVY ${'x'.repeat(8000)}` },
    { role: 'assistant', content: 'final answer' },
  ];
  const payload: MessagesPayload = { messages };

  const { payload: out, telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 1000 }), {
    summarize: async () => {
      called = true;
      return { text: 'manifest', usage: { inputTokens: 500, outputTokens: 80 } };
    },
  });

  assert.equal(called, false, 'summarizer must not be called when the older segment is too thin to profit from compaction');
  assert.equal(telemetry.compactionTriggered, false);
  assert.equal(out.messages!.length, payload.messages!.length);
});

test('compaction replaces old history and reports the tokens it removed', async () => {
  const payload = historyPayload(20, 2000);

  const { payload: out, telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 1000 }), {
    summarize: async () => ({
      text: '- **Active Stack**: node\n- **Resolved Bugs**: none',
      usage: { inputTokens: 500, outputTokens: 80 },
    }),
  });

  assert.equal(telemetry.compactionTriggered, true);
  assert.ok(telemetry.prunedByCompaction > 0, 'expected compaction to remove tokens');
  assert.ok(out.messages!.length < payload.messages!.length, 'expected fewer messages after compaction');
  // The rebuilt history must still be a valid conversation.
  assert.equal(out.messages![0]['role'], 'user');
  assert.equal(out.messages![1]['role'], 'assistant');
  // 3.2: the summarizer's own usage reaches telemetry instead of vanishing.
  assert.deepEqual(telemetry.summarizerUsage, { inputTokens: 500, outputTokens: 80 });
});

test('compaction sizes the kept tail by token budget, not message count, so heavy recent turns are folded into the summary too', async () => {
  const messages: Array<Record<string, unknown>> = [];
  // 14 cheap, old turns.
  for (let index = 0; index < 14; index += 1) {
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `small turn ${index}` });
  }
  // 4 heavy recent turns: by message count alone these land in the kept 25% tail,
  // but together they dwarf the sliding threshold on their own.
  for (let index = 0; index < 4; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `HEAVY_BLOCK_${index} ${'x'.repeat(4000)}`,
    });
  }
  // Newest turn, always protected regardless of budget.
  messages.push({ role: 'user', content: 'final question' });
  messages.push({ role: 'assistant', content: 'final answer' });

  const payload: MessagesPayload = { messages };

  const { payload: out, telemetry } = await optimizePayload(
    payload,
    config({ slidingThresholdTokens: 1000, compactionFraction: 0.75 }),
    {
      summarize: async () => ({
        text: '- **Active Stack**: node\n- **Resolved Bugs**: none',
        usage: { inputTokens: 500, outputTokens: 80 },
      }),
    }
  );

  assert.equal(telemetry.compactionTriggered, true);

  const survivingHeavy = (out.messages ?? []).filter((message) =>
    JSON.stringify(message['content']).includes('HEAVY_BLOCK')
  );
  assert.equal(survivingHeavy.length, 0, 'expected the heavy recent turns to be folded into the summary, not kept verbatim');

  const afterTokens = estimatePayloadTokens({ messages: out.messages ?? [] });
  assert.ok(afterTokens < 1000, `expected the rebuilt history to actually drop below threshold, got ${afterTokens}`);
});

test('compaction never splits a tool_use from its tool_result across the cut', async () => {
  const payload = historyPayload(20, 2000);
  const messages = payload.messages as Array<Record<string, unknown>>;

  // Naive cutoff for this shape lands on this assistant/user pair (see below); give it
  // a tool_use/tool_result so a naive split would orphan the result.
  messages[15] = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }],
  };
  messages[16] = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
  };

  const { payload: out, telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 1000 }), {
    summarize: async () => ({
      text: '- **Active Stack**: node\n- **Resolved Bugs**: none',
      usage: { inputTokens: 500, outputTokens: 80 },
    }),
  });

  assert.equal(telemetry.compactionTriggered, true);

  const outMessages = out.messages as Array<Record<string, unknown>>;
  for (let index = 0; index < outMessages.length; index += 1) {
    const content = outMessages[index]['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    const hasToolResult = content.some(
      (block) => !!block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result'
    );
    if (!hasToolResult) {
      continue;
    }
    const previous = outMessages[index - 1]?.['content'];
    const previousHasToolUse =
      Array.isArray(previous) &&
      previous.some(
        (block) => !!block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_use'
      );
    assert.ok(previousHasToolUse, `tool_result at index ${index} has no matching tool_use in the previous message`);
  }
});

test('compaction is skipped on a tool_result continuation even above threshold, to avoid re-summarizing the same history on every round-trip of one agentic turn', async () => {
  const payload = historyPayload(20, 2000);
  const messages = payload.messages as Array<Record<string, unknown>>;
  // Make the final message a tool_result continuation, not a fresh user turn.
  messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
  });

  let called = false;
  const { payload: out, telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 1000 }), {
    summarize: async () => {
      called = true;
      return { text: 'manifest', usage: { inputTokens: 500, outputTokens: 80 } };
    },
  });

  assert.equal(called, false, 'summarizer must not be called on a tool_result continuation');
  assert.equal(telemetry.compactionTriggered, false);
  assert.equal(out.messages!.length, payload.messages!.length);
});

test('a failing summarizer leaves history intact and records the reason', async () => {
  const payload = historyPayload(20, 2000);

  const { payload: out, telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 1000 }), {
    summarize: async () => {
      throw new Error('upstream 529');
    },
  });

  assert.equal(telemetry.compactionTriggered, false);
  assert.equal(telemetry.compactionError, 'upstream 529');
  assert.equal(out.messages!.length, payload.messages!.length);
  assert.equal(telemetry.summarizerUsage, undefined);
});

// --- Stage 3 -----------------------------------------------------------------

test('latestUserText reads the last user turn, not the last message', () => {
  const payload: MessagesPayload = {
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  };
  assert.equal(latestUserText(payload), 'second');
});

test('routing downgrades a short mechanical turn', () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'write a regex for an ISO date' }],
  };
  assert.equal(classifyRouting(payload, 50).downgrade, true);
});

test('routing refuses complex, long, tool-result, and oversized turns', () => {
  const complex: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'debug the race condition in the scheduler' }],
  };
  assert.equal(classifyRouting(complex, 50).downgrade, false);

  const long: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: `format this ${'x'.repeat(500)}` }],
  };
  assert.equal(classifyRouting(long, 50).downgrade, false);

  const toolResult: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sort these' }] }],
  };
  assert.equal(classifyRouting(toolResult, 50).downgrade, false);

  const huge: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'sort these' }],
  };
  assert.equal(classifyRouting(huge, 500_000).downgrade, false);
});

test('routing downgrades greetings and short questions in English and Spanish', () => {
  const route = (content: unknown): boolean =>
    classifyRouting({ model: 'claude-sonnet-5', messages: [{ role: 'user', content }] } as MessagesPayload, 50).downgrade;

  assert.equal(route('hola claude, cómo estás?'), true);
  assert.equal(route('hello, how are you?'), true);
  assert.equal(route('gracias'), true);
  assert.equal(route('formatea esto por favor'), true);
  assert.equal(route('traduce esto al inglés'), true);
  // Injected reminders must not inflate the length or hide the greeting.
  assert.equal(
    route([
      { type: 'text', text: `<system-reminder>${'x'.repeat(2000)}</system-reminder>` },
      { type: 'text', text: 'hola' },
    ]),
    true,
  );
});

test('routing keeps complex Spanish turns and code on the main model', () => {
  const route = (content: string): boolean =>
    classifyRouting({ model: 'claude-sonnet-5', messages: [{ role: 'user', content }] } as MessagesPayload, 50).downgrade;

  assert.equal(route('hola, refactoriza el módulo de pagos'), false);
  assert.equal(route('por qué falla esto?'), false);
  assert.equal(route('depura la condición de carrera'), false);
  assert.equal(route('qué hace `foo()`?'), false);
});

test('downgrading to Haiku translates parameters Haiku rejects', async () => {
  const payload: MessagesPayload = {
    model: 'claude-opus-5',
    max_tokens: 120_000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: 'sort these lines' }],
  };

  const { payload: out, telemetry } = await optimizePayload(payload, config({ enableCompaction: false }));

  assert.equal(telemetry.modelDowngraded, true);
  assert.equal(out.model, HAIKU_MODEL_ID);
  // effort is unsupported on Haiku 4.5 and would 400.
  assert.equal(out['output_config'], undefined);
  // adaptive thinking is unsupported on Haiku 4.5; it must become an explicit budget.
  assert.deepEqual(out['thinking'], { type: 'enabled', budget_tokens: 8192 });
  // max_tokens must be clamped to Haiku's output ceiling.
  assert.equal(out['max_tokens'], 64_000);
});

// --- Stage 0 -----------------------------------------------------------------

test('startup default routes a first-hit Opus request to Sonnet', async () => {
  const payload: MessagesPayload = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
  };

  const { payload: out, telemetry } = await optimizePayload(
    payload,
    config({ enableCompaction: false, enableModelRouting: false }),
    { isStartupRequest: true }
  );

  assert.equal(out.model, 'claude-sonnet-5');
  assert.equal(telemetry.startupModelDefaulted, true);
  assert.equal(telemetry.effectiveModel, 'claude-sonnet-5');
});

test('startup default leaves non-Opus models and non-startup requests alone', async () => {
  const opusPayload: MessagesPayload = { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] };
  const notStartup = await optimizePayload(opusPayload, config({ enableCompaction: false, enableModelRouting: false }));
  assert.equal(notStartup.payload.model, 'claude-opus-5');
  assert.equal(notStartup.telemetry.startupModelDefaulted, false);

  const sonnetPayload: MessagesPayload = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] };
  const alreadySonnet = await optimizePayload(
    sonnetPayload,
    config({ enableCompaction: false, enableModelRouting: false }),
    { isStartupRequest: true }
  );
  assert.equal(alreadySonnet.payload.model, 'claude-sonnet-5');
  assert.equal(alreadySonnet.telemetry.startupModelDefaulted, false);
});

test('startup default is a no-op when disabled by config', async () => {
  const payload: MessagesPayload = { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] };
  const { payload: out, telemetry } = await optimizePayload(
    payload,
    config({ enableCompaction: false, enableModelRouting: false, enableStartupSonnetDefault: false }),
    { isStartupRequest: true }
  );
  assert.equal(out.model, 'claude-opus-5');
  assert.equal(telemetry.startupModelDefaulted, false);
});

// --- Stage 4 -----------------------------------------------------------------

test('cache anchor replaces history breakpoints with exactly one on the last message', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'one', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ],
  };

  const { payload: out, telemetry } = await optimizePayload(
    payload,
    config({ enableCompaction: false, enableModelRouting: false })
  );

  assert.equal(telemetry.strippedCacheControlBlocks, 2);
  assert.equal(telemetry.cacheAnchorPlaced, true);

  const anchors = (out.messages ?? []).flatMap((message) =>
    (message['content'] as Array<Record<string, unknown>>).filter((block) => 'cache_control' in block)
  );
  assert.equal(anchors.length, 1, 'exactly one anchor must survive inside messages');
  assert.equal(anchors[0]['text'], 'three', 'the anchor belongs on the tail, where Claude Code puts it');

  // The system breakpoint is deliberately preserved — it is the largest stable prefix.
  const systemBlocks = out.system as Array<Record<string, unknown>>;
  assert.ok('cache_control' in systemBlocks[0]);
});

test('cache anchor also covers a first message with no assistant turn yet', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first message of a new chat' }] }],
  };

  const { telemetry } = await optimizePayload(payload, config({ enableCompaction: false, enableModelRouting: false }));
  assert.equal(telemetry.cacheAnchorPlaced, true);
});

test('cache anchor never lands on a thinking block', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'x' }] },
    ],
  };
  const { telemetry } = await optimizePayload(payload, config({ enableCompaction: false, enableModelRouting: false }));
  assert.equal(telemetry.cacheAnchorPlaced, false);
});

test('an exact raw count is not diluted by the estimator bias: untouched payload prunes nothing', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'already clean text' }] }],
  };
  const { telemetry } = await optimizePayload(payload, config({ enableCompaction: false, enableModelRouting: false }), {
    exactRawTokens: 10_000,
  });
  assert.equal(telemetry.prunedByNormalization, 0);
  assert.ok(Math.abs(telemetry.optimizedTokens - 10_000) < 50, `sent ${telemetry.optimizedTokens} should track raw 10000`);
});

test('a short anchored prefix is flagged as below the minimum cacheable length', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'more' }] },
    ],
  };

  const { telemetry } = await optimizePayload(payload, config({ enableCompaction: false, enableModelRouting: false }));
  assert.equal(telemetry.cacheAnchorPlaced, true);
  assert.equal(telemetry.cacheAnchorBelowMinimum, true);
});

// --- Pipeline ----------------------------------------------------------------

test('telemetry reports the raw baseline and a smaller optimized payload', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'Hey Claude, could you please look at this?\r\n\r\nSome context.   ' },
      { role: 'assistant', content: 'Sure.' },
      { role: 'user', content: 'Please help me with reformatting it' },
    ],
  };

  const { telemetry } = await optimizePayload(payload, config());

  assert.ok(telemetry.rawTokens > 0);
  assert.ok(telemetry.optimizedTokens <= telemetry.rawTokens);
  assert.ok(telemetry.prunedByNormalization > 0, 'normalization and fluff stripping should remove tokens');
  assert.equal(telemetry.originalModel, 'claude-sonnet-5');
});

test('an explicit exact baseline overrides the local estimate', async () => {
  const payload: MessagesPayload = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'sort these' }] };
  const { telemetry } = await optimizePayload(payload, config(), { exactRawTokens: 12_345 });
  assert.equal(telemetry.rawTokens, 12_345);
});

test('disabling every stage leaves the payload untouched', async () => {
  const payload: MessagesPayload = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'Hey Claude, reformat\r\nthis' }],
  };

  const { payload: out } = await optimizePayload(
    payload,
    config({
      enableNormalization: false,
      enableCompaction: false,
      enableModelRouting: false,
      enableCacheAnchor: false,
    })
  );

  assert.deepEqual(out, payload);
});

// --- Stage 2: block summaries kept in the proxy ------------------------------

/** A fake summarizer that records what it was asked to summarize. */
function recordingSummarizer() {
  const calls: Array<Array<Record<string, unknown>>> = [];
  return {
    calls,
    summarize: async (messages: Array<Record<string, unknown>>) => {
      calls.push(messages);
      return { text: `summary ${calls.length}`, usage: { inputTokens: 500, outputTokens: 80 } };
    },
  };
}

function manifestBlocks(out: MessagesPayload): Array<Record<string, unknown>> {
  return out.messages![0]['content'] as Array<Record<string, unknown>>;
}

const BLOCK_CONFIG = { slidingThresholdTokens: 1000, enableModelRouting: false, enableCacheAnchor: false };

test('a stored summary is reused on the next turn without another summarizer call', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();

  const first = await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), {
    summarize: fake.summarize,
    summaryStore: store,
  });
  assert.equal(first.telemetry.compactionTriggered, true);
  assert.equal(fake.calls.length, 1);

  // Same conversation, one more exchange: the old history is unchanged.
  const second = await optimizePayload(historyPayload(22, 2000), config(BLOCK_CONFIG), {
    summarize: fake.summarize,
    summaryStore: store,
  });

  assert.equal(fake.calls.length, 1, 'summarizer must not run again for history it already summarized');
  assert.equal(second.telemetry.compactionTriggered, false);
  assert.equal(second.telemetry.summaryReused, true);
  assert.ok(second.telemetry.prunedByCompaction > 0, 'reused summaries still keep old tokens out of the request');
  assert.ok(second.payload.messages!.length < 22, 'history must still be compacted on the reuse turn');
  assert.deepEqual(manifestBlocks(second.payload), manifestBlocks(first.payload), 'summary text must be byte-identical');
});

test('a stored summary is reused on a tool_result continuation too', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  const continued = historyPayload(22, 2000);
  (continued.messages as Array<Record<string, unknown>>).push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
  });
  const out = await optimizePayload(continued, config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  assert.equal(fake.calls.length, 1, 'a continuation never creates a new summary');
  assert.equal(out.telemetry.summaryReused, true);
  assert.ok(out.payload.messages!.length < continued.messages!.length);
});

test('when history grows past the threshold again, only the new turns are summarized and appended', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  const first = await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), {
    summarize: fake.summarize,
    summaryStore: store,
  });
  const firstBlock = manifestBlocks(first.payload)[0];
  // The flag blocks a second cold-cache compaction; clear it to exercise the append path itself.
  for (const state of (store as unknown as { states: Map<string, { resumed?: boolean }> }).states.values()) {
    state.resumed = false;
  }

  const grown = await optimizePayload(historyPayload(60, 2000), config(BLOCK_CONFIG), {
    summarize: fake.summarize,
    summaryStore: store,
  });

  assert.equal(fake.calls.length, 2);
  assert.equal(grown.telemetry.compactionTriggered, true);
  // The second call saw only turns the first summary did not cover.
  const secondInput = JSON.stringify(fake.calls[1]);
  assert.ok(!secondInput.includes('turn 0 turn 0'), 'the first block must not be summarized again');
  assert.ok(fake.calls[1].length < 60);
  // Two blocks now, the first one untouched.
  const blocks = manifestBlocks(grown.payload);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], firstBlock, 'the earlier summary must stay byte-identical');
  assert.match(String(blocks[1]['text']), /summary 2/);
  assert.equal(grown.payload.messages![0]['role'], 'user');
  assert.equal(grown.payload.messages![1]['role'], 'assistant');
});

test('a stored summary is discarded when the history it covered was edited', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  const edited = historyPayload(22, 2000);
  const second = (edited.messages as Array<Record<string, unknown>>)[2];
  second['content'] = [{ type: 'text', text: 'something else entirely '.repeat(200) }];

  const out = await optimizePayload(edited, config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  assert.equal(out.telemetry.summaryMismatch, true);
  assert.equal(fake.calls.length, 2, 'a mismatch falls back to summarizing from scratch');
  assert.equal(out.telemetry.compactionTriggered, true);
});

test('moving cache_control breakpoints between turns does not invalidate a stored summary', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  const next = historyPayload(22, 2000);
  const target = (next.messages as Array<Record<string, unknown>>)[3];
  (target['content'] as Array<Record<string, unknown>>)[0]['cache_control'] = { type: 'ephemeral' };

  const out = await optimizePayload(next, config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  assert.equal(fake.calls.length, 1);
  assert.equal(out.telemetry.summaryReused, true);
  assert.equal(out.telemetry.summaryMismatch, undefined);
});

test('different conversations never share a stored summary', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  const other = historyPayload(20, 2000);
  (other.messages as Array<Record<string, unknown>>)[0]['content'] = [{ type: 'text', text: 'a different opening question' }];
  const out = await optimizePayload(other, config(BLOCK_CONFIG), { summarize: fake.summarize, summaryStore: store });

  assert.equal(fake.calls.length, 2, 'another conversation needs its own summary');
  assert.equal(out.telemetry.compactionTriggered, true);
});

test('the store keeps only the most recently used conversations', () => {
  const store = new SummaryStore(2);
  const state = { coveredCount: 2, prefixHash: 'h', summaries: ['s'] };
  store.set('a', state);
  store.set('b', state);
  store.get('a');
  store.set('c', state);

  assert.equal(store.size, 2);
  assert.ok(store.get('a'));
  assert.equal(store.get('b'), undefined);
});

test('without a store, compaction is stateless and summarizes on every trigger as before', async () => {
  const fake = recordingSummarizer();
  await optimizePayload(historyPayload(20, 2000), config(BLOCK_CONFIG), { summarize: fake.summarize });
  await optimizePayload(historyPayload(22, 2000), config(BLOCK_CONFIG), { summarize: fake.summarize });

  assert.equal(fake.calls.length, 2);
});

// --- Baseline that models the client's own caching ---------------------------

test('hasClientCacheControl finds breakpoints in system, tools or messages', () => {
  assert.equal(hasClientCacheControl({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(
    hasClientCacheControl({ system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages: [] }),
    true
  );
  assert.equal(hasClientCacheControl({ tools: [{ name: 't', cache_control: { type: 'ephemeral' } }], messages: [] }), true);
  assert.equal(
    hasClientCacheControl({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
    }),
    true
  );
});

test('BaselineMemory: the first request has nothing cached, later ones read the previous prefix', () => {
  const memory = new BaselineMemory();
  assert.equal(memory.cachedTokens('c', 1000, 0), 0);
  assert.equal(memory.cachedTokens('c', 1500, 60_000), 1000);
  // History shrank (e.g. the client compacted): never more cached than this request holds.
  assert.equal(memory.cachedTokens('c', 400, 120_000), 400);
});

test('BaselineMemory: a gap longer than the cache lifetime leaves nothing cached', () => {
  const memory = new BaselineMemory(5 * 60 * 1000);
  memory.cachedTokens('c', 1000, 0);
  assert.equal(memory.cachedTokens('c', 1200, 6 * 60 * 1000), 0);
});

test('BaselineMemory keeps conversations apart and forgets the least recently used', () => {
  const memory = new BaselineMemory(5 * 60 * 1000, 2);
  memory.cachedTokens('a', 100, 0);
  memory.cachedTokens('b', 100, 0);
  memory.cachedTokens('c', 100, 0);
  assert.equal(memory.cachedTokens('a', 200, 1000), 0, 'a was evicted');
  assert.equal(memory.cachedTokens('c', 200, 1000), 100);
});

test('baselineCachedTokens is only reported when the client caches and a memory is supplied', async () => {
  const cached = (): MessagesPayload => ({
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hello there' }],
  });
  const memory = new BaselineMemory();
  const off = config({ enableCompaction: false, enableModelRouting: false, enableCacheAnchor: false });

  const first = await optimizePayload(cached(), off, { baselineMemory: memory });
  const second = await optimizePayload(cached(), off, { baselineMemory: memory });
  assert.equal(first.telemetry.baselineCachedTokens, 0);
  assert.equal(second.telemetry.baselineCachedTokens, first.telemetry.rawTokens);

  const noMemory = await optimizePayload(cached(), off);
  assert.equal(noMemory.telemetry.baselineCachedTokens, undefined);

  const plain = await optimizePayload({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }, off, {
    baselineMemory: memory,
  });
  assert.equal(plain.telemetry.baselineCachedTokens, undefined, 'a client that does not cache keeps the plain baseline');
});

// --- Stage 4: manifest anchor ------------------------------------------------

const ANCHOR_CONFIG = { slidingThresholdTokens: 1000, enableModelRouting: false, enableCacheAnchor: true };

function countMarks(out: MessagesPayload): number {
  return JSON.stringify(out.messages).split('"cache_control"').length - 1;
}

test('the compaction manifest gets its own breakpoint, stable across turns', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  const big = async (messages: Array<Record<string, unknown>>) => {
    const r = await fake.summarize(messages);
    return { ...r, text: `${r.text} ${'detail '.repeat(1200)}` };
  };

  const first = await optimizePayload(historyPayload(20, 2000), config(ANCHOR_CONFIG), { summarize: big, summaryStore: store });
  const second = await optimizePayload(historyPayload(22, 2000), config(ANCHOR_CONFIG), { summarize: big, summaryStore: store });

  const mark = (out: MessagesPayload) => manifestBlocks(out)[manifestBlocks(out).length - 1]['cache_control'];
  assert.deepEqual(mark(first.payload), { type: 'ephemeral' });
  assert.deepEqual(mark(second.payload), { type: 'ephemeral' });
  assert.deepEqual(manifestBlocks(second.payload), manifestBlocks(first.payload), 'cached prefix must be byte-identical');
  assert.equal(countMarks(second.payload), 2, 'manifest anchor + sliding anchor');
});

test('no manifest breakpoint when system/tools already use the breakpoint budget', async () => {
  const store = new SummaryStore();
  const fake = recordingSummarizer();
  const payload = historyPayload(20, 2000);
  payload.system = [1, 2, 3].map((n) => ({ type: 'text', text: `s${n}`, cache_control: { type: 'ephemeral' } }));
  const out = await optimizePayload(payload, config(ANCHOR_CONFIG), { summarize: fake.summarize, summaryStore: store });
  assert.equal(countMarks(out.payload), 1, 'only the sliding anchor');
});

test('no manifest breakpoint when compaction did not run', async () => {
  const out = await optimizePayload(historyPayload(4, 20), config(ANCHOR_CONFIG));
  assert.equal(countMarks(out.payload), 1);
});

// --- Compaction economics ----------------------------------------------------

test('economics: a warm cache never pays back a small segment, a cold cache does', () => {
  const warm = estimateCompactionEconomics({ olderTokens: 13_000, keptTokens: 5_000, cacheWarm: true, expectedRequests: 10 });
  const cold = estimateCompactionEconomics({ olderTokens: 13_000, keptTokens: 5_000, cacheWarm: false, expectedRequests: 10 });

  assert.ok(warm.net < 0, `warm cache, 13K segment should lose, got ${warm.net}`);
  assert.ok(cold.net > 0, `cold cache, 13K segment should win, got ${cold.net}`);
  assert.equal(cold.rewriteCost, 0);
});

test('economics: a warm cache breaks even only on a large segment', () => {
  const big = estimateCompactionEconomics({ olderTokens: 120_000, keptTokens: 20_000, cacheWarm: true, expectedRequests: 10 });
  assert.ok(big.net > 0, `warm cache, 120K segment should win, got ${big.net}`);
});

test('economics: more expected requests only ever improve the net', () => {
  const nets = [1, 5, 20, 50].map(
    (expectedRequests) =>
      estimateCompactionEconomics({ olderTokens: 40_000, keptTokens: 10_000, cacheWarm: true, expectedRequests }).net
  );
  for (let index = 1; index < nets.length; index += 1) {
    assert.ok(nets[index] > nets[index - 1]);
  }
});

test('the same history on a cold cache is still compacted', async () => {
  const { telemetry } = await optimizePayload(historyPayload(20, 2000), config({ slidingThresholdTokens: 1000 }), {
    summarize: async () => ({ text: '- **Active Stack**: node', usage: { inputTokens: 500, outputTokens: 80 } }),
  });
  assert.equal(telemetry.compactionTriggered, true);
  assert.equal(telemetry.compactionSkippedReason, undefined);
  assert.equal(telemetry.compactionEconomics?.cacheWarm, false);
  assert.ok((telemetry.compactionEconomics?.net ?? 0) > 0);
});

test('the gate prices one manifest per summarizer chunk, not one per segment', () => {
  const base = { olderTokens: 100_000, keptTokens: 20_000, cacheWarm: false, expectedRequests: 10 };
  const one = estimateCompactionEconomics({ ...base, serializedChars: SUMMARIZER_CHUNK_CHARS });
  const three = estimateCompactionEconomics({ ...base, serializedChars: SUMMARIZER_CHUNK_CHARS * 2 + 1 });
  const extraManifest = (three.haikuCost - one.haikuCost) / 2;
  assert.ok(extraManifest > 0);
  assert.equal(estimateCompactionEconomics(base).haikuCost, one.haikuCost);
});

test('a warm cache is never compacted by default, however large the history', async () => {
  let called = false;
  const payload = historyPayload(20, 2000);
  const first = payload.messages![0]['content'] as Array<Record<string, unknown>>;
  first[0]['cache_control'] = { type: 'ephemeral' };
  const baselineMemory = new BaselineMemory();
  await optimizePayload(payload, config({ enableCompaction: false }), { baselineMemory });
  const { telemetry } = await optimizePayload(payload, config({ slidingThresholdTokens: 1000 }), {
    baselineMemory,
    summarize: async () => {
      called = true;
      return { text: 'manifest', usage: { inputTokens: 500, outputTokens: 80 } };
    },
  });

  assert.ok((telemetry.baselineCachedTokens ?? 0) > 0, 'precondition: the cache must be warm');
  assert.equal(called, false);
  assert.equal(telemetry.compactionTriggered, false);
});

test('a cold cache below the sliding threshold is not compacted', async () => {
  let called = false;
  const { telemetry } = await optimizePayload(
    historyPayload(20, 2000),
    config({ slidingThresholdTokens: 150_000 }),
    {
      summarize: async () => {
        called = true;
        return { text: 'manifest', usage: { inputTokens: 500, outputTokens: 80 } };
      },
    }
  );

  assert.equal(called, false);
  assert.equal(telemetry.compactionTriggered, false);
});

test('SummaryStore persists states to disk and a new instance reads them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-store-'));
  const file = path.join(dir, 'summaries.json');
  const state = { coveredCount: 6, prefixHash: 'abc', summaries: ['one', 'two'] };

  new SummaryStore(50, file, () => 5_000).set('conv-1', state);
  assert.deepEqual(new SummaryStore(50, file, () => 5_000).get('conv-1'), { ...state, lastUsed: 5_000 });

  const reopened = new SummaryStore(50, file);
  reopened.delete('conv-1');
  assert.equal(new SummaryStore(50, file).get('conv-1'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SummaryStore starts empty on a corrupt file and ignores malformed states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-store-'));
  const file = path.join(dir, 'summaries.json');

  fs.writeFileSync(file, '{not json');
  assert.equal(new SummaryStore(50, file).size, 0);

  fs.writeFileSync(
    file,
    JSON.stringify({ states: { ok: { coveredCount: 2, prefixHash: 'h', summaries: ['s'] }, bad: { coveredCount: 'x' } } })
  );
  const store = new SummaryStore(50, file);
  assert.equal(store.size, 1);
  assert.ok(store.get('ok'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cold cache compacts once, marks the conversation resumed, and the next cold cache reuses the summary', async () => {
  const store = new SummaryStore();
  let calls = 0;
  const summarize = async () => {
    calls += 1;
    return { text: 'manifest', usage: undefined };
  };

  const first = await optimizePayload(historyPayload(20, 2000), config({ slidingThresholdTokens: 1000 }), { summarize, summaryStore: store });
  assert.equal(first.telemetry.compactionTriggered, true);
  assert.equal(calls, 1);

  // A longer history of the same conversation, cold again: the flag blocks a second Haiku call.
  const second = await optimizePayload(historyPayload(30, 2000), config({ slidingThresholdTokens: 1000 }), { summarize, summaryStore: store });
  assert.equal(calls, 1);
  assert.equal(second.telemetry.compactionTriggered, false);
  assert.equal(second.telemetry.summaryReused, true);
  assert.equal(second.telemetry.compactionSkippedReason, 'cache is cold again; this conversation was already resumed on an earlier pause');
});

test('resumed clears once 50K tokens of new history pile up after the summary', async () => {
  const store = new SummaryStore();
  let calls = 0;
  const summarize = async () => {
    calls += 1;
    return { text: 'manifest', usage: undefined };
  };

  await optimizePayload(historyPayload(20, 2000), config({ slidingThresholdTokens: 1000 }), { summarize, summaryStore: store });
  assert.equal(calls, 1);

  const grown = await optimizePayload(historyPayload(400, 2000), config({ slidingThresholdTokens: 1000 }), { summarize, summaryStore: store });
  assert.equal(grown.telemetry.compactionTriggered, true);
  assert.equal(calls, 2);
});

test('BaselineMemory keeps the last request time across a restart, so a warm cache stays warm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-memory-'));
  const file = path.join(dir, 'last.json');

  new BaselineMemory(5 * 60_000, 200, file).cachedTokens('conv', 100_000, 1_000);
  const reopened = new BaselineMemory(5 * 60_000, 200, file);

  assert.equal(reopened.cachedTokens('conv', 120_000, 1_000 + 60_000), 100_000, 'within the TTL the old prefix is still cached');
  assert.equal(new BaselineMemory(5 * 60_000, 200, file).cachedTokens('conv', 120_000, 1_000 + 60_000 + 6 * 60_000), 0, 'past the TTL it is cold');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the manifest grows with what is summarized, within its floor and cap', () => {
  assert.equal(manifestTargetTokens(1_000), MANIFEST_MIN_TOKENS);
  assert.equal(manifestTargetTokens(100_000), 2_000);
  assert.equal(manifestTargetTokens(10_000_000), MANIFEST_MAX_TOKENS);
  assert.match(manifestSystemPrompt(2_000), /at most 2000 tokens/);
});

test('the economics gate prices a bigger manifest on a bigger segment', () => {
  const small = estimateCompactionEconomics({ olderTokens: 10_000, keptTokens: 4_000, cacheWarm: false, expectedRequests: 1, serializedChars: 25_000 });
  const large = estimateCompactionEconomics({ olderTokens: 100_000, keptTokens: 4_000, cacheWarm: false, expectedRequests: 1, serializedChars: 250_000 });
  assert.ok(large.net > small.net);
  assert.ok(large.haikuCost > small.haikuCost * 9, 'output grows with the segment, not only the input');
});

test('clientCacheTtlMs reads a 1h breakpoint and defaults to 5 minutes', () => {
  const plain = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] };
  const longLived = { model: 'm', system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [] };
  assert.equal(clientCacheTtlMs(plain), CACHE_TTL_5M_MS);
  assert.equal(clientCacheTtlMs(longLived), CACHE_TTL_1H_MS);
});

test('BaselineMemory judges the cache by the TTL the previous request was written with', () => {
  const memory = new BaselineMemory();
  const t0 = 1_000_000;
  memory.cachedTokens('c', 50_000, t0, CACHE_TTL_1H_MS);
  assert.equal(memory.cachedTokens('c', 60_000, t0 + 30 * 60_000, CACHE_TTL_5M_MS), 50_000, '30 min later is still warm under 1h');
  assert.equal(memory.cachedTokens('c', 70_000, t0 + 30 * 60_000 + 10 * 60_000, CACHE_TTL_5M_MS), 0, '10 min after a 5m write is cold');
});

test('forceFiveMinuteCache drops ttl from every breakpoint and leaves the rest intact', () => {
  const payload = {
    model: 'm',
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ name: 't', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
  };
  const out = forceFiveMinuteCache(payload as never) as typeof payload;
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral' });
  assert.equal(out.messages[0].content[0].text, 'x');
  assert.equal(clientCacheTtlMs(out as never), CACHE_TTL_5M_MS);
  assert.equal((payload.system[0].cache_control as { ttl?: string }).ttl, '1h', 'input is not mutated');
});

test('telemetry flags whether rawTokens is the exact count_tokens figure or the local estimate', async () => {
  const exact = await optimizePayload(historyPayload(4, 200), config(), { exactRawTokens: 12_345 });
  assert.equal(exact.telemetry.rawTokens, 12_345);
  assert.equal(exact.telemetry.rawTokensExact, true);

  const estimated = await optimizePayload(historyPayload(4, 200), config(), {});
  assert.equal(estimated.telemetry.rawTokensExact, false);
});

test('BaselineMemory.warmCachedTokens ignores the 5 minute lifetime but stops at one hour', () => {
  const memory = new BaselineMemory(5 * 60 * 1000);
  assert.equal(memory.warmCachedTokens('conv', 100_000, 0), 0);
  memory.cachedTokens('conv', 100_000, 0);
  assert.equal(memory.warmCachedTokens('conv', 120_000, 30 * 60 * 1000), 100_000, 'expired for the 5 min model, still warm for the floor');
  assert.equal(memory.warmCachedTokens('conv', 120_000, 60 * 60 * 1000 + 1), 0, 'no cache outlives one hour');
});

test('SummaryStore drops entries unused for a month on load and keeps reused ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-store-'));
  const file = path.join(dir, 'summaries.json');
  const state = { coveredCount: 4, prefixHash: 'h', summaries: ['s'] };
  let clock = 1_000_000_000_000;
  const store = new SummaryStore(50, file, () => clock);
  store.set('old', state);
  store.set('busy', state);

  clock += SUMMARY_TTL_MS - 1000;
  store.get('busy'); // reused near the end of the month: the touch is persisted
  clock += 2000;

  const reloaded = new SummaryStore(50, file, () => clock);
  assert.equal(reloaded.get('old'), undefined, 'untouched for more than a month');
  assert.equal(reloaded.get('busy')?.prefixHash, 'h');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hasToolResults sees through trailing system-reminder messages, so one prompt stays one turn', () => {
  const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] };
  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] };
  const reminder = { role: 'user', content: [{ type: 'text', text: '<system-reminder>file changed</system-reminder>' }] };
  const typed = { role: 'user', content: [{ type: 'text', text: 'now refactor it' }] };
  const asPayload = (messages: unknown[]): MessagesPayload => ({ messages }) as unknown as MessagesPayload;

  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult])), true);
  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult, reminder])), true, 'reminder after the result');
  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult, reminder, { ...reminder, content: '<system-reminder>x</system-reminder>' }])), true);
  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult, typed])), false, 'a real prompt opens a turn');
  assert.equal(
    hasToolResults(asPayload([toolUse, toolResult, { role: 'user', content: [reminder.content[0], { type: 'text', text: 'new ask' }] }])),
    false,
    'a reminder plus real text is a new prompt'
  );
  assert.equal(hasToolResults(asPayload([reminder])), false);
  const snapshot = { role: 'user', content: [{ type: 'text', text: '<environment>cwd: C:/x</environment>' }] };
  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult, snapshot])), true, 'any tagged injection after the result');
  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult, snapshot, reminder])), true);
  assert.equal(hasToolResults(asPayload([typed, toolUse, toolResult, { role: 'assistant', content: 'done' }, snapshot])), false, 'a new prompt after the loop ended');
  assert.equal(hasToolResults(asPayload([])), false);
});
