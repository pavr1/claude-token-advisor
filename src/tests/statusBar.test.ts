/** The single status bar item: text, colour thresholds and the tooltip for every plan view. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { aggregate, AggregateStats, billedUnits, LedgerEntry } from '../analytics/tracker';
import type { UnifiedRateLimitSnapshot } from '../proxy/server';
import { paceForecast, paceForecastIcon } from '../ui/planView';
import { compact, formatUsd, progressBarText } from '../ui/shared';
import { statusLabel, paceLabel } from '../ui/budgetDashboard';
import { StatusBar } from '../ui/statusBar';
import { fake, FakeMarkdownString, FakeStatusBarItem, FakeThemeColor } from './helpers/fakeVscode';

const MENU = 'claudeTokenImprover.menu';
const IDLE = { running: true, address: 'http://127.0.0.1:4000', cavemanAvailable: false } as const;

beforeEach(() => fake.reset());

function make(): { bar: StatusBar; item: FakeStatusBarItem; gauge: FakeStatusBarItem; text: () => string; tip: () => string; color: () => string | undefined; bg: () => string | undefined } {
  const bar = new StatusBar({ ...IDLE }, MENU);
  const item = fake.statusBarItems[fake.statusBarItems.length - 1];
  const gauge = fake.statusBarItems[fake.statusBarItems.length - 2];
  const id = (c: unknown): string | undefined => (c ? (c as FakeThemeColor).id : undefined);
  return {
    bar,
    item,
    // The gauge is its own item to the left of the text; read both as one string.
    text: () => (gauge.visible ? `${gauge.text} ${item.text}` : item.text),
    gauge,
    tip: () => (item.tooltip as FakeMarkdownString).value,
    color: () => id(item.color),
    bg: () => id(item.backgroundColor),
  };
}

type Summary = Record<string, unknown>;
const tokensSummary = (over: Summary = {}): Summary => ({
  total_tokens_used: 1_500_000,
  budget_tokens: 5_000_000,
  today_tokens: 120_000,
  recommended_daily_tokens: 200_000,
  percent_used: 42.5,
  status: 'on_track',
  pace_status: 'under_pace',
  ...over,
});
const proPlan = { organization_type: 'claude_pro', budget_api: 'unavailable', billing_type: 'stripe', seat_tier: null };
const enterprisePlan = { organization_type: 'claude_enterprise', budget_api: 'spend_limits' };

function stats(over: Partial<LedgerEntry> = {}): AggregateStats {
  return aggregate([
    {
      rawTokens: 200_000,
      optimizedTokens: 100_000,
      prunedByNormalization: 0,
      prunedByCompaction: 0,
      uncachedInputTokens: 1_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 4_000,
      outputTokens: 500,
      baselineUnitCost: 1,
      actualUnitCost: 1,
      cacheNoCacheUnitCost: 0,
      cacheActualUnitCost: 0,
      servedModel: 'claude-sonnet-5',
      modelSwapped: false,
      compactionTriggered: false,
      ...over,
    } as unknown as LedgerEntry,
  ]);
}

test('the item starts as a loading spinner on the right, opening the menu command', () => {
  const { item, text, tip } = make();
  assert.equal(item.command, MENU);
  assert.equal(item.visible, true);
  assert.equal(text(), '$(sync~spin) Claude: loading');
  assert.equal(item.tooltip, 'Claude Budget Advisor is loading usage data.');
});

test('with no budget yet a render keeps the spinner and the tooltip says it is loading', () => {
  const { bar, text, tip } = make();
  bar.setProxyContext({ address: 'http://127.0.0.1:5000' });
  assert.equal(text(), '$(sync~spin) Claude: loading');
  assert.match(tip(), /### Claude Budget Advisor/);
  assert.match(tip(), /Loading usage data\./);
  assert.match(tip(), /Click for dashboards/);
});

test('token budgets show percent and the summary status icon, and tint only past the thresholds', () => {
  const { bar, text, color, bg, item } = make();
  bar.setBudget(tokensSummary());
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled)');
  assert.equal(color(), undefined);
  assert.equal(bg(), undefined);

  bar.setBudget(tokensSummary({ percent_used: 50.99 }));
  assert.equal(color(), undefined);
  bar.setBudget(tokensSummary({ percent_used: 51, status: 'warning' }));
  assert.equal(text(), '$(claude-budget-gauge) 51.00% $(alert)');
  assert.equal(color(), 'statusBarItem.warningForeground');
  assert.equal(bg(), 'statusBarItem.warningBackground');
  bar.setBudget(tokensSummary({ percent_used: 80 }));
  assert.equal(color(), 'statusBarItem.warningForeground');
  bar.setBudget(tokensSummary({ percent_used: 80.01, status: 'over_budget' }));
  assert.equal(text(), '$(claude-budget-gauge) 80.01% $(flame)');
  assert.equal(color(), 'statusBarItem.errorForeground');
  assert.equal(bg(), 'statusBarItem.errorBackground');
  assert.equal(item.visible, false, "the text item hides while the gauge icon shows alone");
});

test('a summary with no status defaults to on track', () => {
  const { bar, text } = make();
  bar.setBudget({ total_tokens_used: 1, percent_used: 10 });
  assert.equal(text(), '$(claude-budget-gauge) 10.00% $(pass-filled)');
});

test('a summary whose usage is not a number shows Budget Unavailable', () => {
  const { bar, text } = make();
  bar.setBudget(tokensSummary({ total_tokens_used: 'n/a' }));
  assert.equal(text(), '$(claude-budget-gauge) Budget Unavailable');
});

test('the token tooltip lists consumption, total and the daily pace', () => {
  const { bar, tip } = make();
  bar.setBudget(tokensSummary());
  const t = tip();
  assert.ok(t.includes(`| Consumed | 42.50% — **${statusLabel('on_track')}** |`));
  assert.ok(t.includes(progressBarText(42.5)));
  assert.ok(t.includes(`| Total | ${compact(1_500_000)} of ${compact(5_000_000)} tokens |`));
  assert.ok(t.includes(`| Today's pace | ${compact(120_000)} of ${compact(200_000)} tokens — ${paceLabel('under_pace')} |`));
});

test('a turn in flight spins the leading icon, overlapping turns keep it up, and the last one lands it', () => {
  const { bar, text } = make();
  bar.setBudget(tokensSummary());
  assert.equal(bar.isBusy, false);
  bar.beginRequest();
  bar.beginRequest();
  assert.equal(bar.isBusy, true);
  assert.equal(text(), '$(claude-budget-gauge-6) 42.50% $(pass-filled)');
  bar.reportTurn(stats(), stats(), stats(), 'claude-sonnet-5');
  assert.equal(bar.isBusy, true, 'one request still running');
  bar.reportTurn(stats(), stats(), stats(), 'claude-sonnet-5');
  assert.equal(bar.isBusy, false);
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled)');
  bar.reportTurn(stats(), stats(), stats(), 'claude-sonnet-5'); // an extra report cannot go negative
  assert.equal(bar.isBusy, false);
  bar.beginRequest();
  assert.equal(bar.isBusy, true);
});

test('the gauge needle oscillates between its frames while busy without snapping back, and rests when the last turn lands', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bar, text } = make();
  bar.setBudget(tokensSummary());
  bar.beginRequest();
  bar.beginRequest(); // overlapping request must not start a second timer
  const seen: string[] = [text()];
  const dwell = [260, 150, 90, 70, 120, 300, 130];
  for (const ms of dwell) {
    t.mock.timers.tick(ms - 1);
    assert.equal(text(), seen[seen.length - 1], 'holds its frame until the dwell elapses');
    t.mock.timers.tick(1);
    seen.push(text());
  }
  assert.deepEqual(
    seen.map((s) => s.split(' ')[0]),
    [6, 5, 4, 3, 2, 1, 2, 3].map((n) => `$(claude-budget-gauge-${n})`)
  );
  bar.reportTurn(stats(), stats(), stats(), 'claude-sonnet-5');
  t.mock.timers.tick(80);
  assert.ok(text().startsWith('$(claude-budget-gauge-'), 'still animating with one request left');
  bar.reportTurn(stats(), stats(), stats(), 'claude-sonnet-5');
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled)');
  t.mock.timers.tick(1000);
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled)', 'timer stopped');
});

test('when the leading slot cannot carry the spinner the improver segment does', () => {
  const { bar, text } = make();
  bar.setBudgetError('boom');
  bar.beginRequest();
  assert.equal(text(), '$(warning) Unavailable · $(sync~spin)');
  bar.setBudgetDisabled();
  assert.equal(text(), 'Budget: Not set · $(sync~spin)');
  bar.setPythonMissing();
  assert.equal(text(), '$(warning) Python required · $(sync~spin)');
});

test('while loading, a request adds no second spinner', () => {
  const { bar, text } = make();
  bar.beginRequest();
  assert.equal(text(), '$(sync~spin) Claude: loading');
});

test('a proxy error adds a warning while idle, hides while busy, and clears on the next report or restart', () => {
  const { bar, text } = make();
  bar.setBudget(tokensSummary());
  bar.reportProxyError('upstream down');
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled) · $(warning)');
  bar.beginRequest();
  assert.equal(text(), '$(claude-budget-gauge-6) 42.50% $(pass-filled)');
  bar.reportTurn(stats(), stats(), stats(), 'm');
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled)');

  bar.reportProxyError('again');
  bar.setProxyContext({ running: false });
  assert.match(text(), /\$\(warning\)$/, 'a stopped proxy keeps the error');
  bar.setProxyContext({ running: true });
  assert.doesNotMatch(text(), /\$\(warning\)$/);
});

test('stream progress is kept across overlapping requests and cleared when the last turn ends', () => {
  const { bar } = make();
  const progress = (): unknown => (bar as unknown as { streamProgressTokens: number | undefined }).streamProgressTokens;
  bar.beginRequest();
  bar.updateStreamProgress(321);
  assert.equal(progress(), 321);
  bar.beginRequest(); // overlapping: must not blank the first one's progress
  assert.equal(progress(), 321);
  bar.reportTurn(stats(), stats(), stats(), 'm');
  assert.equal(progress(), 321, 'one request is still streaming');
  bar.reportTurn(stats(), stats(), stats(), 'm');
  assert.equal(progress(), undefined);
  bar.updateStreamProgress(5);
  bar.beginRequest(); // idle -> busy drops a stale count
  assert.equal(progress(), undefined);
});

test('errors, a disabled budget and missing Python each replace the figure and reset the others', () => {
  const { bar, text, tip, color, bg } = make();
  bar.setBudget(tokensSummary());

  bar.setBudgetError('cannot read ledger');
  assert.equal(text(), '$(warning) Unavailable');
  assert.equal(color(), 'statusBarItem.errorForeground');
  assert.equal(bg(), undefined);
  assert.match(tip(), /\$\(warning\) cannot read ledger/);

  bar.setPythonMissing();
  assert.equal(text(), '$(warning) Python required');
  assert.equal(color(), 'statusBarItem.warningForeground');
  assert.equal(bg(), 'statusBarItem.warningBackground');
  assert.match(tip(), /Python 3\.8 or newer is required/);
  assert.match(tip(), /python\.org\/downloads/);

  bar.setBudgetDisabled();
  assert.equal(text(), 'Budget: Not set');
  assert.equal(color(), undefined);
  assert.match(tip(), /\*\*Not set\.\*\*/);
  assert.match(tip(), /claudeBudgetAdvisor\.enabled/);

  bar.setBudget(tokensSummary());
  assert.equal(text(), '$(claude-budget-gauge) 42.50% $(pass-filled)');
  assert.doesNotMatch(tip(), /Not set|Python 3\.8/);
});

test('the tooltip names the account with its plan, and the model that served the last turn', () => {
  const { bar, tip } = make();
  bar.setBudget(tokensSummary({ plan: proPlan }));
  assert.doesNotMatch(tip(), /Account:|Agent:/);
  bar.setRealCost(1.5, 20, 'dev@example.com');
  assert.match(tip(), /Account: dev@example\.com \(Pro\)/);
  bar.reportTurn(stats(), stats(), stats(), 'claude-haiku-4');
  assert.match(tip(), /Agent: claude-haiku-4/);
  bar.setRealCost(undefined, undefined);
  assert.doesNotMatch(tip(), /Account:/);
});

test('an account with no plan data gets no plan suffix', () => {
  const { bar, tip } = make();
  bar.setRealCost(0, 0, 'dev@example.com');
  assert.match(tip(), /Account: dev@example\.com\n/);
});

test('restoring history seeds the windows without touching the in-flight count or the proxy error', () => {
  const { bar, text, tip } = make();
  bar.setBudget(tokensSummary());
  bar.beginRequest();
  bar.restoreHistory(stats(), stats(), stats(), 'claude-sonnet-5');
  assert.equal(bar.isBusy, true);
  assert.match(tip(), /Agent: claude-sonnet-5/);
  bar.reportTurn(stats(), stats(), stats(), 'x');
  bar.reportProxyError('e');
  bar.restoreHistory(undefined, undefined, undefined, undefined);
  assert.match(text(), /\$\(warning\)$/);
  assert.doesNotMatch(tip(), /Agent:/);
});

function rateLimits(over: Partial<UnifiedRateLimitSnapshot> = {}): UnifiedRateLimitSnapshot {
  const now = Date.now() / 1000;
  return {
    fiveHour: { utilization: 0.5, resetEpochSeconds: now + 3600 },
    sevenDay: { utilization: 0.99, resetEpochSeconds: now + 86_400 },
    ...over,
  };
}

test('Pro shows Session and Weekly from the rate-limit headers, with pace forecasts', () => {
  const { bar, text, tip, color } = make();
  bar.setBudget(tokensSummary({ plan: proPlan, percent_used: 3 }));
  // No headers yet: no invented figure, and the tooltip says why.
  assert.equal(text(), '$(claude-budget-gauge) 0.00% $(pass-filled)');
  assert.match(tip(), /\| Session \| No data yet \|/);
  assert.match(tip(), /\| Weekly \| No data yet \|/);
  assert.match(tip(), /Waiting for a request to go through the Token Improver proxy/);

  const limits = rateLimits({ fiveHour: { utilization: 0.62, resetEpochSeconds: Date.now() / 1000 + 3600 } });
  bar.setRateLimitInfo(limits);
  assert.equal(text(), '$(claude-budget-gauge) 62.00% $(alert)');
  assert.equal(color(), 'statusBarItem.warningForeground');
  const t = tip();
  assert.match(t, /\| Session \| 62% — resets /);
  assert.ok(t.includes(progressBarText(62)));
  assert.match(t, /\| Weekly \| 99% — resets /);
  assert.ok(t.includes(progressBarText(99)));
  const week = paceForecast(limits.sevenDay, 'sevenDay');
  const session = paceForecast(limits.fiveHour, 'fiveHour');
  assert.ok(week && session);
  assert.ok(t.includes(`${paceForecastIcon(week.status)} **Weekly:** ${week.message}`));
  assert.ok(t.includes(`${paceForecastIcon(session.status)} **Session:** ${session.message}`));
  assert.doesNotMatch(t, /Waiting for a request/);
});

test('Pro over 80% of its session turns the bar red, and falls back to Weekly when Session is unknown', () => {
  const { bar, text, color, bg } = make();
  bar.setBudget(tokensSummary({ plan: proPlan }));
  bar.setRateLimitInfo({ fiveHour: { utilization: 0.9, resetEpochSeconds: undefined }, sevenDay: undefined });
  assert.equal(text(), '$(claude-budget-gauge) 90.00% $(flame)');
  assert.equal(color(), 'statusBarItem.errorForeground');
  assert.equal(bg(), 'statusBarItem.errorBackground');

  bar.setRateLimitInfo({ fiveHour: undefined, sevenDay: { utilization: 0.3, resetEpochSeconds: undefined } });
  assert.equal(text(), '$(claude-budget-gauge) 30.00% $(pass-filled)');
  assert.equal(color(), undefined);

  bar.setRateLimitInfo(undefined);
  assert.equal(text(), '$(claude-budget-gauge) 0.00% $(pass-filled)');
});

test('a window with no reset time shows just the percent and no forecast', () => {
  const { bar, tip } = make();
  bar.setBudget(tokensSummary({ plan: proPlan }));
  bar.setRateLimitInfo({ fiveHour: { utilization: 0.1, resetEpochSeconds: undefined }, sevenDay: undefined });
  assert.match(tip(), /\| Session \| 10% \|/);
  assert.match(tip(), /\| Weekly \| No data yet \|/);
  assert.doesNotMatch(tip(), /\*\*Session:\*\*|\*\*Weekly:\*\*/);
  assert.doesNotMatch(tip(), /Waiting for a request/, 'one window is enough');
});

const authoritative = (over: Summary = {}): Summary =>
  tokensSummary({
    plan: enterprisePlan,
    budget_basis: 'authoritative',
    spend_limit: { limit_minor: 10_000, used_minor: 2_500, exponent: 2 },
    percent_used: 25,
    today_weighted_cost: 4.2,
    daily_target_usd: 10,
    ...over,
  });

test('an Enterprise plan with a real spend limit shows dollars against the limit', () => {
  const { bar, text, tip, color } = make();
  bar.setBudget(authoritative());
  assert.equal(text(), '$(claude-budget-gauge) 25.00% $(pass-filled)');
  assert.equal(color(), undefined);
  const t = tip();
  assert.ok(t.includes(`| Consumed | ${formatUsd(25)} of ${formatUsd(100)} — 25.00% — **${statusLabel('on_track')}** |`));
  assert.ok(t.includes(progressBarText(25)));
  assert.ok(t.includes(`| Today's pace | ${formatUsd(4.2)} of ${formatUsd(10)} — ${paceLabel('under_pace')} |`));
  assert.doesNotMatch(t, /No account spend limit/);

  bar.setBudget(authoritative({ percent_used: 95, status: 'over_budget' }));
  assert.equal(color(), 'statusBarItem.errorForeground');
});

test('Enterprise without a spend limit shows this month raw vs billed and never tints the bar', () => {
  const { bar, text, tip, color, bg } = make();
  bar.setBudget(tokensSummary({ plan: enterprisePlan, percent_used: 99 }));
  assert.equal(text(), '$(claude-budget-gauge) No data');
  assert.match(tip(), /\| Usage \| No data yet \|/);
  assert.equal(color(), undefined);
  assert.equal(bg(), undefined);

  const month = stats();
  const billed = billedUnits(month);
  bar.restoreHistory(undefined, undefined, month, 'claude-sonnet-5');
  assert.equal(text(), `$(claude-budget-gauge) ${compact(month.rawTokens)}/${compact(billed)}`);
  assert.equal(color(), undefined, 'there is no real limit to warn about');
  const t = tip();
  assert.ok(t.includes(`| Raw request | ${compact(month.rawTokens)} tokens |`));
  assert.ok(t.includes(`| Billed input | ${compact(billed)} units |`));
  const reduction = ((month.rawTokens - billed) / month.rawTokens) * 100;
  assert.ok(t.includes(`| Reduction | ${reduction.toFixed(1)}% |`));
  assert.match(t, /No account spend limit on file, so there is no % used/);
  // The note must not quote fixed cache multipliers.
  assert.doesNotMatch(t, /0\.10x|1\.25x/);
});

test('with zero raw tokens the reduction is 0.0% rather than a division by zero', () => {
  const { bar, tip } = make();
  bar.setBudget(tokensSummary({ plan: enterprisePlan }));
  bar.restoreHistory(undefined, undefined, stats({ rawTokens: 0 }), 'm');
  assert.ok(tip().includes('| Reduction | 0.0% |'));
});

test('dispose releases the item', () => {
  const { bar, item } = make();
  bar.dispose();
  assert.equal(item.disposed, true);
});
