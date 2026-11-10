/** The "Tips to save tokens" section: what it says about the data, and what it always says. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyticsTracker, LedgerEntry } from '../analytics/tracker';
import { ALL, buildAnalyticsSectionHtml } from '../ui/analyticsPanel';
import { getPricingTable, resetPricing } from '../proxy/pricing';
import { dataTips, generalTips, tipsSectionHtml } from '../ui/tips';

function hit(minutesAgo: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  const read = (over.cacheReadTokens as number | undefined) ?? 100_000;
  const write = (over.cacheWriteTokens as number | undefined) ?? 0;
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    project: 'repo',
    sessionId: 's1',
    requestedModel: 'claude-sonnet-5',
    servedModel: 'claude-sonnet-5',
    modelSwapped: false,
    rawTokens: 50_000,
    optimizedTokens: 40_000,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    compactionTriggered: false,
    cacheAnchorPlaced: true,
    newUserTurn: true,
    uncachedInputTokens: 10,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheNoCacheUnitCost: read + write,
    outputTokens: 100,
    baselineUnitCost: 9_000,
    actualUnitCost: 4_000,
    savingsPercent: 55,
    status: 200,
    ...over,
  } as LedgerEntry;
}

const healthy = (n: number): LedgerEntry[] => Array.from({ length: n }, (_, i) => hit(60 - i, { sessionId: `s${i}` }));
const costly = { cacheReadTokens: 1_000, cacheWriteTokens: 20_000 };

test('a turn with a hit that wrote more cache than it saved is flagged; the keep-alive is suggested when it is off and explained when it is on', () => {
  const entries = [...healthy(4), hit(5, { sessionId: 'x', ...costly })];
  const off = dataTips(entries, 0).find((t) => t.tone === 'warn');
  assert.ok(off, 'a warning');
  assert.match(off.lead, /^1 of 5 turns had a hit that wrote more cache than it saved/);
  assert.match(off.text, /turn the keep-alive on \(setting claudeTokenImprover\.keepAliveMaxMinutes\)/);
  const on = dataTips(entries, 30).find((t) => t.tone === 'warn');
  assert.ok(on, 'a warning');
  assert.match(on.text, /The keep-alive renews it every ~4\.5 minutes for up to 30 minutes after your last request/);
  assert.match(on.text, /computer going to sleep/);
  assert.doesNotMatch(on.text, /turn the keep-alive on|work in one stretch/, 'it is already on: nothing to suggest');
  assert.match(dataTips(entries, 45).find((t) => t.tone === 'warn')!.text, /up to 45 minutes/);
});

test('an amber turn counts too: one costly hit among good ones', () => {
  const entries = [hit(9, { newUserTurn: true }), hit(8, { newUserTurn: false, ...costly }), ...healthy(4)];
  assert.match(dataTips(entries, 30)[0].lead, /^1 of 5 turns/);
});

test('a healthy cache is said to be working, once there are enough requests to tell', () => {
  const good = dataTips(healthy(6), 30).find((t) => t.tone === 'good');
  assert.ok(good);
  assert.match(good.lead, /The cache is working: 100.00% of cached tokens were reads/);
  assert.equal(dataTips(healthy(3), 30).some((t) => t.tone === 'good'), false, 'three requests say nothing');
});

test('the read price in the "cache is working" tip is the one these hits were billed at, per model, never a fixed tenth', () => {
  const at = (read: number) => ({ cacheMultipliers: { read, write: 1.25, write1h: 2 } });
  const text = (entries: LedgerEntry[]) => dataTips(entries, 30).find((t) => t.tone === 'good')!.text;

  const cheap = Array.from({ length: 6 }, (_, i) => hit(60 - i, { sessionId: `s${i}`, ...at(0.05) }));
  assert.match(text(cheap), /^A read costs 0\.05× a regular input token/);
  assert.doesNotMatch(text(cheap), /tenth/);

  const usual = Array.from({ length: 6 }, (_, i) => hit(60 - i, { sessionId: `u${i}`, ...at(0.1) }));
  assert.match(text(usual), /^A read costs 0\.1× a regular input token/);

  const mixed = [...cheap.slice(0, 3), ...usual.slice(0, 3)];
  assert.match(text(mixed), /^A read costs 0\.05× to 0\.1× \(depending on the model\) a regular input token/);

  const newest = Array.from({ length: 6 }, (_, i) => hit(60 - i, { sessionId: `n${i}`, ...at(0.025) }));
  assert.match(text(newest), /^A read costs 0\.025× /);

  // A row recorded before the multipliers were stored is priced from the pricing table by its served model.
  resetPricing();
  try {
    getPricingTable().rates['claude-sonnet-5'] = { input: 2e-6, output: 1e-5, cacheRead: 0.1e-6, cacheWrite: 2.5e-6 };
    assert.match(text(healthy(6)), /^A read costs 0\.05× /);
  } finally {
    resetPricing();
  }
});

test('very long histories and Opus requests are flagged', () => {
  const long = dataTips([hit(3, { rawTokens: 300_000 }), hit(2, { rawTokens: 400_000, newUserTurn: false })], 30);
  assert.ok(long.some((t) => /Requests average 350\.00K tokens/.test(t.lead)));
  const opus = dataTips([hit(3, { servedModel: 'claude-opus-5-5' }), hit(2, { newUserTurn: false })], 30);
  assert.ok(opus.some((t) => /^1 of 2 requests ran on Opus/.test(t.lead)));
});

test('pings and failed hits are nobody\'s request: only they, and the tips have nothing to say', () => {
  const ping = hit(5, { routingReason: 'cache keep-alive ping', ...costly, newUserTurn: false });
  const failed = hit(4, { status: 0, ...costly });
  assert.deepEqual(dataTips([ping, failed], 0), []);
  // A costly ping does not make the real turns look costly either.
  assert.equal(dataTips([...healthy(5), ping], 30).some((t) => t.tone === 'warn'), false);
});

test('the section always lists the general tips, and says so when the data has nothing to flag', () => {
  const html = tipsSectionHtml([], 30);
  assert.match(html, /<h2>Tips to save tokens<\/h2>/);
  assert.match(html, /Nothing to flag in this selection/);
  for (const tip of generalTips(30)) {
    assert.ok(html.includes(tip.lead), tip.lead);
  }
  // Every tip is plain text in the page: nothing a hit could inject.
  const injected = tipsSectionHtml([hit(3, { servedModel: '<b>opus</b>' })], 30);
  assert.doesNotMatch(injected, /<b>opus/);
});

test('the Token Improver tab carries the tips in a popup that starts closed, and not as a block of the page', () => {
  const entries = [...healthy(4), hit(5, { sessionId: 'x', ...costly })];
  const html = buildAnalyticsSectionHtml({ getEntries: () => entries } as unknown as AnalyticsTracker, { project: ALL, range: 'today' });
  assert.match(html, /<div class="tips-modal" data-tips-modal>/);
  assert.doesNotMatch(html, /tips-open/, 'closed until the page script opens it');
  assert.match(html, /class="tip tip-warn"/);
  assert.match(html, /data-close-tips/);
  // Still there with nothing recorded yet: the general tips need no data.
  const empty = buildAnalyticsSectionHtml({ getEntries: () => [] } as unknown as AnalyticsTracker, { project: ALL, range: 'today' });
  assert.match(empty, /data-tips-modal/);
  assert.match(empty, /The cache lasts 5 minutes/);
});

test('the cache tip says how to change to 1 hour in the settings, and what each model pays for a read', () => {
  resetPricing();
  try {
    getPricingTable().rates['claude-sonnet-5'] = { input: 2e-6, output: 1e-5, cacheRead: 0.2e-6, cacheWrite: 2.5e-6 };
    getPricingTable().rates['claude-sonnet-5-5'] = { input: 2e-6, output: 1e-5, cacheRead: 0.1e-6, cacheWrite: 2.5e-6 };
    getPricingTable().rates['claude-haiku-5-5'] = { input: 0.1e-6, output: 0.5e-6, cacheRead: 0.01e-6, cacheWrite: 0.125e-6 };
    const tip = generalTips(30).find((t) => t.lead === 'The cache lasts 5 minutes.');
    assert.ok(tip);
    assert.match(tip.text, /set claudeTokenImprover\.cacheTtl to 1h/);
    assert.match(tip.text, /search "cacheTtl"/);
    assert.match(tip.text, /"claudeTokenImprover\.cacheTtl": "1h"/);
    assert.match(tip.text, /restarts by itself/);
    assert.match(tip.text, /2× an input token instead of 1\.25×/);
    assert.match(tip.text, /0\.05× on claude-sonnet-5-5, 0\.1× on claude-haiku-5-5/);
    assert.doesNotMatch(tip.text, /a tenth/);
  } finally {
    resetPricing();
  }
});

test('the keep-alive is explained as it works, and the claim that a pause always costs the cache is gone', () => {
  const on = generalTips(30);
  const tip = on.find((t) => /keep-alive/i.test(t.lead));
  assert.ok(tip);
  assert.equal(tip.lead, 'The keep-alive keeps the cache warm while you pause.');
  assert.match(tip.text, /Every ~4\.5 minutes the proxy replays your last request with a one-token answer/);
  assert.match(tip.text, /renews the cache for the price of one read/);
  assert.match(tip.text, /up to 30 minutes after your last request \(setting claudeTokenImprover\.keepAliveMaxMinutes, 0 turns it off\)/);
  assert.match(tip.text, /computer that goes to sleep/);
  assert.match(tip.text, /subscription plan each ping counts against your usage limit/);
  assert.equal(on.some((t) => /Do not stop in the middle/.test(t.lead)), false);

  const off = generalTips(0).find((t) => /keep-alive/i.test(t.lead));
  assert.ok(off);
  assert.equal(off.lead, 'The keep-alive is off.');
  assert.match(off.text, /Set claudeTokenImprover\.keepAliveMaxMinutes above 0/);
});

test('the general tips carry the practices from the costs page, each once and in plain text', () => {
  const tips = generalTips(30);
  const leads = tips.map((t) => t.lead);
  assert.equal(new Set(leads).size, leads.length, 'no tip twice');
  for (const wanted of [
    /One chat per task/,
    /By default the first request starts on Sonnet, not Opus/,
    /Pick the model for the job/,
    /Lower the effort/,
    /Keep CLAUDE\.md short/,
    /Compact on your terms/,
    /Send noisy work to subagents/,
    /Filter before Claude reads/,
    /Prefer CLI tools to MCP/,
    /Ask for something specific/,
    /Plan first, correct early/,
    /Idle sessions can still cost/,
  ]) {
    assert.ok(leads.some((lead) => wanted.test(lead)), String(wanted));
  }
  const html = tipsSectionHtml([], 30);
  assert.match(html, /\/effort/);
  assert.match(html, /under 200 lines/);
});

test('the Opus to Sonnet default is explained with the price ratio of the pricing table, and says the model can be changed with /model', () => {
  const tipOf = () => generalTips(30).find((t) => /^By default the first request starts on Sonnet/.test(t.lead))!;
  resetPricing();
  try {
    // Prices of 2026-11-02: Opus 5.5 $4 and Sonnet 5.5 $2 per million input tokens.
    getPricingTable().rates['claude-sonnet-5'] = { input: 2e-6, output: 1e-5, cacheRead: 0.2e-6, cacheWrite: 2.5e-6 };
    getPricingTable().rates['claude-sonnet-5-5'] = { input: 2e-6, output: 1e-5, cacheRead: 0.1e-6, cacheWrite: 2.5e-6 };
    getPricingTable().rates['claude-opus-5-5'] = { input: 4e-6, output: 2e-5, cacheRead: 0.2e-6, cacheWrite: 5e-6 };
    const tip = tipOf();
    assert.ok(tip);
    assert.match(tip.text, /first request after the proxy starts is Opus, it is sent to Sonnet/);
    assert.match(tip.text, /claudeTokenImprover\.startupSonnetDefault, on by default/);
    assert.match(tip.text, /Input costs 2× on claude-opus-5-5 against 1× on claude-sonnet-5-5/);
    assert.doesNotMatch(tip.text, /5×/, 'the ratio is the table\'s, not a fixed 5x');
    assert.match(tip.text, /The default is Sonnet, but you can switch to another model whenever you want with \/model/);
    assert.match(tip.text, /only that first request changes, and the model you pick is left as it is/);
    assert.match(tip.text, /To keep Opus from the very first request, turn the setting off/);
    assert.doesNotMatch(tip.text, /\/models/, 'the command is /model');

    // A repricing shows without a code change.
    getPricingTable().rates['claude-opus-5-5'] = { input: 5e-6, output: 2.5e-5, cacheRead: 0.5e-6, cacheWrite: 6.25e-6 };
    assert.match(tipOf().text, /Input costs 2\.5× on claude-opus-5-5/);
  } finally {
    resetPricing();
  }
});
