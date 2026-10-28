/** The Budget tab and account header, and the status helpers the status bar shares with them. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAccountHeaderHtml,
  buildBudgetSectionHtml,
  buildTooltip,
  paceColor,
  paceLabel,
  renderEmbeddedProgressBar,
  statusColor,
  statusFromPercent,
  statusLabel,
  statusToIcon,
  Summary,
} from '../ui/budgetDashboard';
import { compact, COLORS } from '../ui/shared';
import { UnifiedRateLimitSnapshot } from '../proxy/server';

const DOLLAR_PLAN = { organization_type: 'api', budget_api: 'usage_cost', email: 'dev@example.com' };
const PRO_PLAN = { organization_type: 'claude_pro', budget_api: 'usage_cost', email: 'pro@example.com' };

function summary(over: Summary = {}): Summary {
  return {
    month: '2026-10',
    total_tokens_used: 400_000,
    budget_tokens: 1_000_000,
    percent_used: 40,
    percent_remaining: 60,
    projected_month_end: 900_000,
    projected_percent: 90,
    recommended_daily_tokens: 33_000,
    remaining_daily_allowance: 30_000,
    remaining_tokens: 600_000,
    today_tokens: 20_000,
    today_percent_of_pace: 60,
    today_status: 'on_track',
    pace_status: 'on_track',
    pace_delta: 0,
    average_daily_tokens: 25_000,
    average_daily: 28_000,
    days_remaining: 12,
    day_of_month: 19,
    status: 'on_track',
    plan: DOLLAR_PLAN,
    ...over,
  };
}

const window = (utilization: number, resetEpochSeconds?: number) => ({ utilization, resetEpochSeconds }) as never;

test('status helpers map every status to its icon, label and colour, with On Track as the default', () => {
  assert.deepEqual(
    ['over_budget', 'warning', 'watch', 'on_track', 'anything'].map(statusToIcon),
    ['$(flame)', '$(alert)', '$(info)', '$(pass-filled)', '$(pass-filled)']
  );
  assert.deepEqual(
    ['over_budget', 'warning', 'watch', 'on_track', 'anything'].map(statusLabel),
    ['Over Budget', 'Warning', 'Watch', 'On Track', 'On Track']
  );
  assert.deepEqual(
    ['over_budget', 'warning', 'watch', 'on_track'].map(statusColor),
    [COLORS.bad, COLORS.warn, '#d7ba7d', COLORS.good]
  );
  assert.deepEqual(['over_pace', 'under_pace', 'on_track'].map(paceLabel), ['Above Pace', 'Below Pace', 'On track']);
  assert.deepEqual(['over_pace', 'under_pace', 'on_track'].map(paceColor), [COLORS.bad, COLORS.info, COLORS.good]);
});

test('statusFromPercent uses the status bar thresholds: above 80 over budget, 51 and up warning', () => {
  assert.equal(statusFromPercent(80.01), 'over_budget');
  assert.equal(statusFromPercent(80), 'warning');
  assert.equal(statusFromPercent(51), 'warning');
  assert.equal(statusFromPercent(50.99), 'on_track');
  assert.equal(statusFromPercent(0), 'on_track');
});

test('renderEmbeddedProgressBar prints the percent with two decimals and the status text', () => {
  assert.equal(renderEmbeddedProgressBar(42.5, '$(alert)'), '42.50% $(alert)');
});

test('buildTooltip reports consumption, budget, today against pace, and the click hint', () => {
  const md = buildTooltip(summary({ status: 'warning', pace_status: 'over_pace', percent_used: 61.234 }));
  assert.match(md.value, /Consumed: 61\.23% — \*\*Warning\*\*/);
  assert.ok(md.value.includes(`Budget: ${compact(400_000)} of ${compact(1_000_000)} tokens`));
  assert.ok(md.value.includes(`Today: ${compact(20_000)} of ${compact(33_000)} daily pace — Above Pace`));
  assert.match(md.value, /Click to open the dashboard\.$/);
});

test('buildTooltip falls back to zeros and On Track when the summary is empty', () => {
  const md = buildTooltip({});
  assert.match(md.value, /Consumed: 0\.00% — \*\*On Track\*\*/);
  assert.match(md.value, /daily pace — On track/);
});

test('the account header shows the email and plan, or Unknown without a summary', () => {
  assert.match(buildAccountHeaderHtml(summary()), /Account: dev@example\.com \(API\)/);
  assert.match(buildAccountHeaderHtml(undefined), /Account: Unknown \(Unknown\)/);
  assert.doesNotMatch(buildAccountHeaderHtml(summary()), /Session \(5h\)/);
});

test('the account header escapes an email, and ignores a plan without one', () => {
  const html = buildAccountHeaderHtml(summary({ plan: { ...DOLLAR_PLAN, email: '<b>x</b>@e.com' } }));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;@e.com'));
  assert.match(buildAccountHeaderHtml(summary({ plan: { organization_type: 'claude_max', budget_api: 'x' } })), /Account: Unknown \(Max\)/);
  assert.match(buildAccountHeaderHtml(summary({ plan: 'free' })), /Account: Unknown \(Unknown\)/);
});

test('rate-limit windows are shown for any plan once Anthropic reports one, and "No data yet" for the missing one', () => {
  const only5h: UnifiedRateLimitSnapshot = { fiveHour: window(0.38), sevenDay: undefined };
  const html = buildAccountHeaderHtml(summary(), only5h);
  assert.match(html, /Session \(5h\)/);
  assert.match(html, />38%</);
  assert.match(html, /Weekly \(7d\)[\s\S]*No data yet/);

  const only7d: UnifiedRateLimitSnapshot = { fiveHour: undefined, sevenDay: window(0.5) };
  const html7 = buildAccountHeaderHtml(summary(), only7d);
  assert.match(html7, /Session \(5h\)[\s\S]*No data yet[\s\S]*Weekly \(7d\)[\s\S]*>50%</);
});

test('a percent-mode plan shows the limits block even before any reading, saying there is no data', () => {
  const html = buildAccountHeaderHtml(summary({ plan: PRO_PLAN }));
  assert.match(html, /Session \(5h\)[\s\S]*No data yet/);
  assert.match(html, /Anthropic's own rate-limit reading/);
});

test('the Budget tab headlines the month, the status pills and the key figures in dollar mode', () => {
  const html = buildBudgetSectionHtml(
    summary({
      status: 'warning',
      pace_status: 'over_pace',
      model_breakdown: [{ model: 'claude-sonnet-5', tokens: 300_000, percent: 75, tier: 'balanced' }],
      project_breakdown: [{ project: 'repo-a', tokens: 400_000, percent: 100 }],
      project_count: 1,
    })
  );
  assert.match(html, /Claude Budget Advisor/);
  assert.match(html, /<span class="pill" style="background:#e2a336">Warning<\/span>/);
  assert.match(html, /<span class="pill" style="background:#f14c4c">Above Pace<\/span>/);
  assert.match(html, /Model: claude-sonnet-5/);
  assert.match(html, /2026-10 · day 19 · 12 days left · estimated from local usage · configured budget · 1 projects/);
  assert.ok(html.includes(`${compact(400_000)} / ${compact(1_000_000)}`));
  assert.match(html, /60\.00% remaining/);
  assert.match(html, /of budget used/);
  assert.match(html, /Daily usage vs target/);
  assert.match(html, /Month over month/);
});

test('the budget note names where the budget came from, and flags an estimate', () => {
  const note = (source: string): string => buildBudgetSectionHtml(summary({ budget_source: source }));
  assert.match(note('user'), /configured budget/);
  assert.match(note('auto_history'), /auto budget from your usage history/);
  assert.match(note('auto_projected'), /auto budget projected from this month/);
  assert.match(note('other'), /default budget/);
  assert.match(note('auto_history'), /budget is an estimate, not a real limit/);
  assert.doesNotMatch(note('user'), /budget is an estimate/);
});

test('an authoritative or mock basis says so, with the reset time when there is one', () => {
  const reset = '2026-11-01T00:00:00.000Z';
  const expected = new Date(reset).toLocaleString();
  const authoritative = buildBudgetSectionHtml(summary({ budget_basis: 'authoritative', spend_limit: { resets_at: reset } }));
  assert.ok(authoritative.includes(`verified against your account limit · resets ${expected.replace(/&/g, '&amp;')}`));
  assert.match(buildBudgetSectionHtml(summary({ budget_basis: 'authoritative' })), /verified against your account limit<|verified against your account limit ·(?! resets)/);

  const mock = buildBudgetSectionHtml(summary({ budget_basis: 'mock', spend_limit: { resets_at: reset } }));
  assert.match(mock, /MOCK DATA — not your real limit · resets/);
  assert.match(buildBudgetSectionHtml(summary({ budget_basis: 'mock' })), /MOCK DATA — not your real limit(?! · resets)/);
});

test('Anthropic-reported cost is compared with the estimate only when it is real and non-zero', () => {
  const real = buildBudgetSectionHtml(
    summary({ cost_basis: 'real_otel', real_cost_month_usd: 10, estimated_total_weighted_cost: 11 })
  );
  assert.match(real, /grounded in Anthropic's own reported cost \(\$10\.00 real vs our own \$11\.00 estimate, 10\.0% off\)/);
  assert.doesNotMatch(buildBudgetSectionHtml(summary({ cost_basis: 'real_otel', real_cost_month_usd: 0 })), /grounded in/);
  assert.doesNotMatch(buildBudgetSectionHtml(summary({ cost_basis: 'estimated', real_cost_month_usd: 10 })), /grounded in/);
});

test('the project count is only shown when the scope is all projects', () => {
  assert.match(buildBudgetSectionHtml(summary({ scope: 'all', project_count: 3 })), /· 3 projects/);
  assert.doesNotMatch(buildBudgetSectionHtml(summary({ scope: 'repo-a', project_count: 3 })), /projects<\/div>/);
  // Without an explicit count it follows the breakdown.
  assert.match(buildBudgetSectionHtml(summary({ project_breakdown: [{ project: 'a', tokens: 1, percent: 100 }, { project: 'b', tokens: 1, percent: 0 }] })), /· 2 projects/);
});

test('alerts render with their level, and are replaced by nothing in percent mode', () => {
  const alerts = [{ level: 'critical', message: 'Over <limit>' }, { level: 'info', message: 'Heads up' }];
  const html = buildBudgetSectionHtml(summary({ alerts }));
  assert.ok(html.includes('<div class="alert critical">Over &lt;limit&gt;</div>'));
  assert.ok(html.includes('<div class="alert warning">Heads up</div>'));
  assert.doesNotMatch(buildBudgetSectionHtml(summary({ alerts, plan: PRO_PLAN })), /class="alert/);
});

test('recommendations are listed and escaped', () => {
  const html = buildBudgetSectionHtml(summary({ recommendations: ['Use <Haiku>', 'Compact earlier'] }));
  assert.ok(html.includes('<li>Use &lt;Haiku&gt;</li>'));
  assert.ok(html.includes('<li>Compact earlier</li>'));
});

test('pace delta reads as plain language, not a signed number', () => {
  assert.match(buildBudgetSectionHtml(summary({ pace_delta: 0 })), />On pace</);
  assert.ok(buildBudgetSectionHtml(summary({ pace_delta: 5_000 })).includes(`${compact(5_000)} over pace`));
  assert.ok(buildBudgetSectionHtml(summary({ pace_delta: -5_000 })).includes(`${compact(5_000)} under pace`));
});

test('the month-over-month card is red when spending rose, green when it fell, and a dash without history', () => {
  const up = buildBudgetSectionHtml(summary({ efficiency_delta_percent: 12.345, previous_month: '2026-09', previous_month_tokens: 300_000 }));
  assert.match(up, /color:#f14c4c">\+12\.35%/);
  assert.ok(up.includes(`vs 2026-09 (${compact(300_000)} tokens)`));
  const down = buildBudgetSectionHtml(summary({ efficiency_delta_percent: -4, previous_month: '2026-09' }));
  assert.match(down, /color:#3fb950">-4\.00%/);
  const none = buildBudgetSectionHtml(summary());
  assert.match(none, /color:#8b8b8b">—/);
  assert.match(none, /No previous month to compare/);
});

test('projected month end turns red above 100% of budget', () => {
  assert.match(buildBudgetSectionHtml(summary({ projected_percent: 120 })), /Projected month end<\/div>\s*<div class="stat-value" style="color:#f14c4c"/);
  assert.match(buildBudgetSectionHtml(summary({ projected_percent: 100 })), /Projected month end<\/div>\s*<div class="stat-value" style="color:#3fb950"/);
});

test('the model bars carry the tier colour and name, scaled to the biggest share', () => {
  const html = buildBudgetSectionHtml(
    summary({
      model_breakdown: [
        { model: 'opus', tokens: 100, percent: 50, tier: 'premium' },
        { model: 'sonnet', tokens: 100, percent: 25, tier: 'balanced' },
        { model: 'haiku', tokens: 300, percent: 10, tier: 'economy' },
        { model: 'mystery', tokens: 1, percent: 0, tier: 'other' },
        { tokens: 1 },
      ],
    })
  );
  assert.match(html, /opus<span class="tier" style="background:#f14c4c">premium/);
  assert.match(html, /sonnet<span class="tier" style="background:#e2a336">balanced/);
  assert.match(html, /haiku<span class="tier" style="background:#3fb950">economy/);
  assert.match(html, /mystery<span class="tier" style="background:#8b8b8b">other/);
  assert.match(html, /width:100\.0%;background:#f14c4c/);
  assert.match(html, /width:50\.0%;background:#e2a336/);
  // The agent is the model with the most tokens, not the biggest share.
  assert.match(html, /Model: haiku/);
  assert.match(html, /unknown<span class="tier" style="background:#8b8b8b">unknown/);
});

test('with no model usage the tab says so', () => {
  const html = buildBudgetSectionHtml(summary());
  assert.match(html, /No usage recorded for this month yet\./);
  assert.match(html, /Model: No usage yet/);
});

test('projects are drawn as a stacked bar plus one row each, cycling the palette', () => {
  const projects = Array.from({ length: 10 }, (_, i) => ({ project: `p${i}`, tokens: 1_000 * (i + 1), percent: 10 }));
  const html = buildBudgetSectionHtml(summary({ project_breakdown: projects }));
  assert.match(html, /<div class="stacked">/);
  assert.equal((html.match(/data-tooltip="p\d: [\d,\s.  ]+ tokens \(10\.00% of cost\)"/g) ?? []).length, 20);
  assert.match(buildBudgetSectionHtml(summary()), /No project usage recorded this month\./);
  // A project with no name or numbers still renders.
  assert.match(buildBudgetSectionHtml(summary({ project_breakdown: [{}] })), /unknown/);
});

test('the daily chart marks today, days over target, and says so when empty', () => {
  const series = [
    { day: 1, tokens: 10_000 },
    { day: 2, tokens: 50_000 },
    { day: 3, tokens: 0 },
    { day: 4, tokens: 20_000 },
  ];
  const html = buildBudgetSectionHtml(summary({ daily_series: series, day_of_month: 4, recommended_daily_tokens: 30_000 }));
  assert.match(html, /aria-label="Daily token usage"/);
  assert.match(html, /Day 4: 20,000 tokens \(today\)|Day 4: 20.000 tokens \(today\)|Day 4: [\d.,\s  ]+ tokens \(today\)/);
  assert.match(html, /tokens — over target/);
  assert.match(html, /fill="#6b8fc7"/);
  assert.match(html, /fill="#c96a67"/);
  assert.match(html, /opacity="0\.12"/);
  assert.ok(html.includes(`daily target ${compact(30_000)}`));
  assert.match(html, /day 4<\/text>/);
  assert.match(buildBudgetSectionHtml(summary()), /No daily usage yet\./);
});

test('the daily chart copes with a zero target and zero usage', () => {
  const html = buildBudgetSectionHtml(summary({ daily_series: [{ day: 1, tokens: 0 }], recommended_daily_tokens: 0 }));
  assert.match(html, /<svg viewBox="0 0 720 190"/);
});

test('month over month needs two months, marks months above budget, and says so otherwise', () => {
  const html = buildBudgetSectionHtml(
    summary({ history: [{ month: '2026-09', tokens: 1_500_000 }, { month: '2026-10', tokens: 400_000 }] })
  );
  assert.match(html, /2026-09/);
  assert.match(html, /background:#c96a67"><\/div><\/div>\s*<div class="bar-value">1\.50M/);
  assert.match(html, /background:#6b8fc7"><\/div><\/div>\s*<div class="bar-value">400\.00K/);
  assert.match(buildBudgetSectionHtml(summary({ history: [{ month: '2026-09', tokens: 1 }] })), /Not enough history yet to compare months\./);
});

test('a percent-mode plan swaps in the session reading and drops the dollar sections', () => {
  const rate: UnifiedRateLimitSnapshot = { fiveHour: window(0.9), sevenDay: window(0.2) };
  const html = buildBudgetSectionHtml(summary({ plan: PRO_PLAN, status: 'on_track', alerts: [{ level: 'critical', message: 'x' }] }), rate);
  assert.match(html, /of session used/);
  assert.match(html, /plan usage as reported by Anthropic \(session \/ weekly\)/);
  // 90% of the session is over budget on the status bar's thresholds, whatever Python scored.
  assert.match(html, /<span class="pill" style="background:#f14c4c">Over Budget<\/span>/);
  assert.match(html, /tokens today/);
  assert.doesNotMatch(html, /Recommended daily pace|Daily usage vs target|Month over month|Above Pace|Below Pace/);

  // With only the weekly window, that one drives the donut; with none, zero.
  const weekly = buildBudgetSectionHtml(summary({ plan: PRO_PLAN }), { fiveHour: undefined, sevenDay: window(0.6) });
  assert.match(weekly, /<span class="pill" style="background:#e2a336">Warning<\/span>/);
  assert.match(buildBudgetSectionHtml(summary({ plan: PRO_PLAN })), /<span class="pill" style="background:#3fb950">On Track<\/span>/);
});

test('the real-cost comparison is skipped in percent mode', () => {
  const html = buildBudgetSectionHtml(
    summary({ plan: PRO_PLAN, cost_basis: 'real_otel', real_cost_month_usd: 10, estimated_total_weighted_cost: 11 })
  );
  assert.doesNotMatch(html, /grounded in/);
});

test('a missing summary field falls back to a harmless default', () => {
  assert.doesNotThrow(() => buildBudgetSectionHtml({}));
  assert.match(buildBudgetSectionHtml({}), /day 1 · 0 days left/);
});
