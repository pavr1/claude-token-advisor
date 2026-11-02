/**
 * New-day behaviour of the optimizer: summarizing the previous day's history, handing the
 * summaries to a cleared chat, and never summarizing the same history twice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BaselineMemory, DEFAULT_OPTIMIZER_CONFIG, isEarlierLocalDay, isUserChatOpening, optimizePayload, OptimizerConfig, SummaryStore } from '../proxy/optimizer';
import { PendingHistoryStore } from '../proxy/pendingHistory';
import { MessagesPayload } from '../proxy/tokenCounter';

// Threshold far above any test history: only a day change can trigger compaction.
const CFG: OptimizerConfig = { ...DEFAULT_OPTIMIZER_CONFIG, slidingThresholdTokens: 1_000_000 };
const HOUR = 3_600_000;
const EVENING = new Date(2026, 9, 29, 22, 0).getTime();
const MORNING = new Date(2026, 9, 30, 9, 0).getTime();
const FRIDAY_EVENING = new Date(2026, 9, 30, 18, 0).getTime();
const MONDAY_MORNING = new Date(2026, 10, 2, 9, 0).getTime();

/** `turns` alternating messages (starting with a user one), with a cache breakpoint so the memory records it. */
function chat(turns: number): MessagesPayload {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `turn ${i} `.repeat(250) }] });
  }
  return { model: 'claude-sonnet-5', max_tokens: 4096, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages };
}

/** The opening message of a chat as Claude Code sends it: injected context first, then what the user typed (47K-token shape seen in the ledger). */
function fresh(text: string, model = 'claude-sonnet-5'): MessagesPayload {
  return {
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }, { type: 'text', text }] }],
  };
}

/** One-message automatic calls of Claude Code, with the shapes found in the ledger. */
function automatic(kind: 'quota' | 'title' | 'webfetch' | 'haiku'): MessagesPayload {
  const text = { quota: 'quota', title: '<session> analiza el dashboard', webfetch: 'Web page content: hello', haiku: '<session> Reply with only the word ok' }[kind];
  const model = kind === 'haiku' ? 'claude-haiku-5' : 'claude-sonnet-5';
  return { model, max_tokens: 32, messages: [{ role: 'user', content: kind === 'quota' ? text : [{ type: 'text', text }] }] };
}

function counting(text = 'manifest') {
  const state = { calls: 0 };
  return { state, summarize: async () => ((state.calls += 1), { text, usage: undefined }) };
}

test('the first turn of a new day summarizes the whole earlier history and keeps only the new message', async () => {
  const deps = { ...counting(), summaryStore: new SummaryStore(), baselineMemory: new BaselineMemory() };
  const evening = await optimizePayload(chat(21), CFG, { ...deps, now: () => EVENING });
  assert.equal(evening.telemetry.dayChange, false);
  assert.equal(deps.state.calls, 0);

  const morning = await optimizePayload(chat(25), CFG, { ...deps, now: () => MORNING });
  assert.equal(morning.telemetry.dayChange, true);
  assert.equal(morning.telemetry.compactionTriggered, true);
  assert.equal(deps.state.calls, 1);
  assert.equal(morning.payload.messages?.length, 3); // manifest pair + the new user message
});

test('a chat with no earlier request is not a day change', async () => {
  const deps = { ...counting(), summaryStore: new SummaryStore(), baselineMemory: new BaselineMemory() };
  const out = await optimizePayload(chat(21), CFG, { ...deps, now: () => MORNING });
  assert.equal(out.telemetry.dayChange, false);
  assert.equal(deps.state.calls, 0);
});

test('a later turn on the same day does not summarize again, even with a cold cache', async () => {
  const deps = { ...counting(), summaryStore: new SummaryStore(), baselineMemory: new BaselineMemory() };
  await optimizePayload(chat(21), CFG, { ...deps, now: () => EVENING });
  await optimizePayload(chat(25), CFG, { ...deps, now: () => MORNING });
  const later = await optimizePayload(chat(29), CFG, { ...deps, now: () => MORNING + HOUR });
  assert.equal(later.telemetry.dayChange, false);
  assert.equal(deps.state.calls, 1);
});

test('a day change across midnight with a warm cache waits instead of rewriting the cache', async () => {
  const deps = { ...counting(), summaryStore: new SummaryStore(), baselineMemory: new BaselineMemory() };
  const beforeMidnight = new Date(2026, 9, 29, 23, 58).getTime();
  await optimizePayload(chat(21), CFG, { ...deps, now: () => beforeMidnight });
  const out = await optimizePayload(chat(23), CFG, { ...deps, now: () => beforeMidnight + 3 * 60_000 });
  assert.equal(out.telemetry.dayChange, true);
  assert.equal(deps.state.calls, 0);
  assert.equal(out.telemetry.compactionSkippedReason, 'cache is warm; compaction waits for a cold cache');
});

test('Friday evening to Monday morning counts as a new day', async () => {
  const deps = { ...counting('friday work'), summaryStore: new SummaryStore(), baselineMemory: new BaselineMemory() };
  await optimizePayload(chat(21), CFG, { ...deps, now: () => FRIDAY_EVENING });
  const monday = await optimizePayload(chat(25), CFG, { ...deps, now: () => MONDAY_MORNING });
  assert.equal(monday.telemetry.dayChange, true);
  assert.equal(monday.telemetry.compactionTriggered, true);
});

test('BaselineMemory keeps an old entry regardless of its age', () => {
  const memory = new BaselineMemory();
  memory.cachedTokens('chat', 1000, FRIDAY_EVENING);
  assert.equal(memory.lastRequestAt('chat'), FRIDAY_EVENING);
  assert.equal(memory.lastRequestAt('other'), undefined);
});

/** A chat that has lived through `days` days; each day opens with its own user message and carries its number in the text. */
function multiDay(days: number[]): MessagesPayload {
  const messages: Array<Record<string, unknown>> = [];
  for (const day of days) {
    for (let i = 0; i < 10; i += 1) {
      const text = i === 0 ? `DAY${day} first message` : `DAY${day} msg-${i} `.repeat(300);
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text }] });
    }
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: `DAY${days[days.length - 1] + 1} first message` }] });
  return { ...chat(1), messages };
}

test('three days in one chat: day 3 summarizes only day 2, never the day-1 summary', async () => {
  const store = new SummaryStore();
  const memory = new BaselineMemory();
  const seen: string[] = [];
  const summarize = async (messages: Array<Record<string, unknown>>) => {
    seen.push(JSON.stringify(messages));
    return { text: `SUMMARY_${seen.length}`, usage: undefined };
  };
  const at = (n: number) => new Date(2026, 9, 28 + n, 9, 0).getTime();
  const run = (days: number[], n: number) =>
    optimizePayload(multiDay(days), CFG, { summarize, summaryStore: store, baselineMemory: memory, now: () => at(n) });

  await run([1], 0); // day 1: nothing earlier to summarize
  assert.equal((await run([1], 1)).telemetry.compactionTriggered, true); // day 2 opens: day 1 summarized
  const third = await run([1, 2], 2); // day 3 opens: day 2 summarized
  assert.equal(third.telemetry.compactionTriggered, true);

  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes('DAY1 msg-1'));
  assert.ok(seen[1].includes('DAY2 msg-1'));
  assert.ok(!seen[1].includes('DAY1 msg-1'), 'day 1 is not summarized twice');
  assert.ok(!seen[1].includes('SUMMARY_1'), 'the day-1 summary is not fed back');
  const sent = JSON.stringify(third.payload.messages);
  assert.ok(sent.includes('SUMMARY_1') && sent.includes('SUMMARY_2'));
  assert.ok(!sent.includes('DAY1 msg-1') && !sent.includes('DAY2 msg-1'));
});

test('a new day saves the summaries as pending and asks for a clear; the cleared chat receives them once', async () => {
  const pending = new PendingHistoryStore();
  const deps = { ...counting('yesterday state'), summaryStore: new SummaryStore(), baselineMemory: new BaselineMemory(), pendingStore: pending, project: 'proj' };

  await optimizePayload(chat(21), CFG, { ...deps, now: () => EVENING });
  const morning = await optimizePayload(chat(25), CFG, { ...deps, now: () => MORNING });
  assert.equal(morning.telemetry.clearSuggested, true);
  assert.equal(pending.has('proj', MORNING), true);

  const first = await optimizePayload(fresh('hello again'), CFG, { ...deps, now: () => MORNING + 60_000 });
  assert.equal(first.telemetry.pendingInjected, true);
  assert.equal(first.telemetry.clearSuggested, false);
  assert.equal(first.payload.messages?.length, 3);
  assert.match(JSON.stringify(first.payload.messages?.[0]), /yesterday state/);
  assert.equal(pending.has('proj', MORNING), false);

  // The cleared chat's next request still carries the summary, now from the SummaryStore.
  const next: MessagesPayload = {
    ...fresh('hello again'),
    messages: [
      ...(fresh('hello again').messages ?? []),
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ],
  };
  const second = await optimizePayload(next, CFG, { ...deps, now: () => MORNING + 120_000 });
  assert.equal(second.telemetry.pendingInjected, undefined);
  assert.match(JSON.stringify(second.payload.messages?.[0]), /yesterday state/);
  assert.equal(second.payload.messages?.length, 5);
});

test('pending summaries wait for the right chat: other projects, utility models and long chats leave them alone', async () => {
  const pending = new PendingHistoryStore();
  pending.set('proj', ['state'], MORNING);
  const run = (payload: MessagesPayload, project: string) =>
    optimizePayload(payload, DEFAULT_OPTIMIZER_CONFIG, { pendingStore: pending, summaryStore: new SummaryStore(), project, now: () => MORNING + 1000 });

  assert.equal((await run(fresh('hi'), 'other')).telemetry.pendingInjected, undefined);
  assert.equal((await run(fresh('hi', 'claude-haiku-5'), 'proj')).telemetry.pendingInjected, undefined);
  for (const kind of ['quota', 'title', 'webfetch', 'haiku'] as const) {
    assert.equal((await run(automatic(kind), 'proj')).telemetry.pendingInjected, undefined, kind);
  }
  assert.equal((await run(chat(4), 'proj')).telemetry.pendingInjected, undefined);
  assert.equal(pending.has('proj', MORNING + 1000), true);
  assert.equal((await run(fresh('hi'), 'proj')).telemetry.pendingInjected, true);
});

test('expired pending summaries are not handed over', async () => {
  const pending = new PendingHistoryStore();
  pending.set('proj', ['state'], MORNING);
  const out = await optimizePayload(fresh('hi'), DEFAULT_OPTIMIZER_CONFIG, {
    pendingStore: pending,
    summaryStore: new SummaryStore(),
    project: 'proj',
    now: () => MORNING + 80 * HOUR,
  });
  assert.equal(out.telemetry.pendingInjected, undefined);
  assert.equal(out.payload.messages?.length, 1);
});

test('isEarlierLocalDay compares calendar days in local time', () => {
  assert.equal(isEarlierLocalDay(EVENING, MORNING), true);
  assert.equal(isEarlierLocalDay(new Date(2026, 9, 30, 0, 1).getTime(), new Date(2026, 9, 30, 23, 59).getTime()), false);
  assert.equal(isEarlierLocalDay(MORNING, EVENING), false);
});

test('the quota check and the session title that precede the first message do not take the summaries', async () => {
  const pending = new PendingHistoryStore();
  pending.set('proj', ['state'], MORNING);
  const run = (payload: MessagesPayload, at: number) =>
    optimizePayload(payload, DEFAULT_OPTIMIZER_CONFIG, { pendingStore: pending, summaryStore: new SummaryStore(), project: 'proj', now: () => at });

  assert.equal((await run(automatic('quota'), MORNING + 1000)).telemetry.pendingInjected, undefined);
  assert.equal((await run(automatic('title'), MORNING + 2000)).telemetry.pendingInjected, undefined);
  assert.equal(pending.has('proj', MORNING + 3000), true);
  assert.equal((await run(fresh('analiza el dashboard'), MORNING + 4000)).telemetry.pendingInjected, true);
});

test('isUserChatOpening accepts only a user message that opens with injected context', () => {
  const user = (content: unknown) => ({ role: 'user', content }) as Record<string, unknown>;
  assert.equal(isUserChatOpening(user([{ type: 'text', text: '<system-reminder>x</system-reminder>' }]), 'claude-sonnet-5'), true);
  assert.equal(isUserChatOpening(user([{ type: 'text', text: '<system-reminder>x' }]), 'claude-haiku-5'), false);
  assert.equal(isUserChatOpening(user('<system-reminder>x'), 'claude-sonnet-5'), false);
  assert.equal(isUserChatOpening(user([{ type: 'text', text: 'hello' }]), 'claude-sonnet-5'), false);
  assert.equal(isUserChatOpening({ role: 'assistant', content: [] }, 'claude-sonnet-5'), false);
  assert.equal(isUserChatOpening(undefined, 'claude-sonnet-5'), false);
});
