/**
 * The Budget Advisor dashboard: month-scoped token pacing against a budget,
 * rendered from the summary emitted by `claude_budget_advisor.py`.
 *
 * This is the original dashboard, moved out of `extension.ts` and re-pointed at the
 * shared presentation helpers. Its behaviour is unchanged.
 */

import * as vscode from 'vscode';
import { accentShade, CHART, COLORS, compact, donutChart, escapeHtml } from './shared';
import { extractPlanInfo, formatRateLimitWindow, planLabel, planViewMode, resolveStatusPercent } from './planView';
import { UnifiedRateLimitSnapshot } from '../proxy/server';

/**
 * 2.2: like `barRow` in `shared.ts`, but emits `data-tooltip` for this page's own
 * hover-tooltip script instead of a native `title`. Kept local (not a `shared.ts`
 * change) because the Analytics panel also calls `barRow` and has no such listener —
 * switching the shared helper would silently drop its native tooltips.
 */
function dashboardBarRow(label: string, value: string, fillPercent: number, color: string, tooltip: string): string {
  const width = Math.max(0, Math.min(100, fillPercent)).toFixed(1);
  return `
    <div class="bar-row">
      <div class="bar-name" data-tooltip="${escapeHtml(tooltip)}">${escapeHtml(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color}"></div></div>
      <div class="bar-value">${escapeHtml(value)}</div>
    </div>`;
}

export type Summary = Record<string, unknown>;

export function statusToIcon(status: string): string {
  switch (status) {
    case 'over_budget':
      return '$(flame)';
    case 'warning':
      return '$(alert)';
    case 'watch':
      return '$(info)';
    default:
      return '$(pass-filled)';
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'over_budget':
      return 'Over Budget';
    case 'warning':
      return 'Warning';
    case 'watch':
      return 'Watch';
    default:
      return 'On Track';
  }
}

/**
 * Threshold-derived status for a plan whose Python-computed `status` field doesn't
 * apply — Pro/Max/Team's status bar percentage comes from the Session/Weekly
 * rate-limit reading (`resolveStatusPercent`), not the dollar-weighted budget Python
 * scores `status` against, so the icon has to be derived from that same percentage
 * instead. Mirrors the status bar's own colour thresholds (`applyBudgetColor`).
 */
export function statusFromPercent(percent: number): string {
  if (percent > 80) {
    return 'over_budget';
  }
  if (percent >= 51) {
    return 'warning';
  }
  return 'on_track';
}

export function paceLabel(status: string): string {
  switch (status) {
    case 'over_pace':
      return 'Above Pace';
    case 'under_pace':
      return 'Below Pace';
    default:
      return 'On track';
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'over_budget':
      return COLORS.bad;
    case 'warning':
      return COLORS.warn;
    case 'watch':
      return '#d7ba7d';
    default:
      return COLORS.good;
  }
}

export function paceColor(status: string): string {
  switch (status) {
    case 'over_pace':
      return COLORS.bad;
    case 'under_pace':
      return COLORS.info;
    default:
      return COLORS.good;
  }
}

function tierColor(tier: string): string {
  switch (tier) {
    case 'premium':
      return COLORS.bad;
    case 'balanced':
      return COLORS.warn;
    case 'economy':
      return COLORS.good;
    default:
      return COLORS.muted;
  }
}

/** Inline text bar for the status bar item: `42.5% $(alert)`. */
export function renderEmbeddedProgressBar(percent: number, statusText: string, size = 10): string {
  return `${percent.toFixed(2)}% ${statusText}`;
}

export function buildTooltip(summary: Summary): vscode.MarkdownString {
  const totalUsage = Number(summary['total_tokens_used'] ?? 0);
  const budget = Number(summary['budget_tokens'] ?? 0);
  const percentUsed = Number(summary['percent_used'] ?? 0);
  const todayTokens = Number(summary['today_tokens'] ?? 0);
  const dailyPace = Number(summary['recommended_daily_tokens'] ?? 0);
  const status = String(summary['status'] ?? 'on_track');
  const paceStatus = String(summary['pace_status'] ?? 'on_track');

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`Consumed: ${percentUsed.toFixed(2)}% — **${statusLabel(status)}**\n\n`);
  md.appendMarkdown(`Budget: ${compact(totalUsage)} of ${compact(budget)} tokens\n\n`);
  md.appendMarkdown(`Today: ${compact(todayTokens)} of ${compact(dailyPace)} daily pace — ${paceLabel(paceStatus)}\n\n`);
  md.appendMarkdown('Click to open the dashboard.');
  return md;
}

function dailyChart(series: Array<{ day: number; tokens: number }>, target: number, today: number): string {
  if (!series.length) {
    return '<div class="empty">No daily usage yet.</div>';
  }

  const width = 720;
  const height = 190;
  const left = 40;
  const right = 12;
  const top = 14;
  const bottom = 26;
  const plotH = height - top - bottom;
  const maxTokens = Math.max(target, ...series.map((point) => point.tokens)) || 1;
  const slot = (width - left - right) / series.length;
  const barWidth = Math.max(slot * 0.62, 2);
  const yOf = (tokens: number): number => top + plotH - (tokens / maxTokens) * plotH;

  const grid = [0, 0.5, 1]
    .map((fraction) => {
      const y = yOf(maxTokens * fraction).toFixed(1);
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="${CHART.grid}" stroke-width="1"></line>
    <text x="${left - 8}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end" class="axis">${compact(maxTokens * fraction)}</text>`;
    })
    .join('');

  const bars = series
    .map((point, index) => {
      const barHeight = (point.tokens / maxTokens) * plotH;
      const x = left + index * slot + (slot - barWidth) / 2;
      const y = top + plotH - barHeight;
      const isToday = point.day === today;
      const over = point.tokens > target;
      const fill = over ? CHART.over : CHART.accent;
      const opacity = !point.tokens ? 0.12 : isToday ? 1 : over ? 0.85 : 0.55;
      const tooltip = escapeHtml(
        `Day ${point.day}: ${point.tokens.toLocaleString()} tokens${isToday ? ' (today)' : over ? ' — over target' : ''}`
      );
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(barHeight, 0).toFixed(1)}" rx="2" fill="${fill}" opacity="${opacity}" data-tooltip="${tooltip}"></rect>`;
    })
    .join('');

  const targetY = yOf(target).toFixed(1);

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Daily token usage">
    ${grid}
    <line x1="${left}" y1="${targetY}" x2="${width - right}" y2="${targetY}" stroke="${CHART.target}" stroke-width="1" stroke-dasharray="4 4"></line>
    <text x="${width - right}" y="${(Number(targetY) - 5).toFixed(1)}" text-anchor="end" class="axis">daily target ${compact(target)}</text>
    ${bars}
    <text x="${left}" y="${height - 8}" class="axis">day 1</text>
    <text x="${width - right}" y="${height - 8}" text-anchor="end" class="axis">day ${series.length}</text>
  </svg>`;
}

function historyChart(history: Array<{ month: string; tokens: number }>, budget: number): string {
  if (history.length < 2) {
    return '<div class="empty">Not enough history yet to compare months.</div>';
  }

  const maxTokens = Math.max(budget, ...history.map((item) => item.tokens)) || 1;
  return history
    .map((item) =>
      dashboardBarRow(
        item.month,
        compact(item.tokens),
        (item.tokens / maxTokens) * 100,
        item.tokens > budget ? CHART.over : CHART.accent,
        `${item.month}: ${item.tokens.toLocaleString()} tokens vs a budget of ${compact(budget)}`
      )
    )
    .join('');
}

function projectChart(projects: Array<Record<string, unknown>>): string {
  if (!projects.length) {
    return '<div class="empty">No project usage recorded this month.</div>';
  }

  // Bar width and label share one basis: cost share (`percent`), same as the stacked bar below.
  const maxPercent = Math.max(...projects.map((item) => Number(item['percent'] ?? 0))) || 1;

  const segments = projects
    .map((item, index) => {
      const name = String(item['project'] ?? 'unknown');
      const tokens = Number(item['tokens'] ?? 0);
      const percent = Number(item['percent'] ?? 0);
      const color = accentShade(Math.max(100 - index * 14, 28));
      return dashboardBarRow(
        name,
        `${compact(tokens)} · ${percent.toFixed(2)}%`,
        (percent / maxPercent) * 100,
        color,
        `${name}: ${tokens.toLocaleString()} tokens (${percent.toFixed(2)}% of cost)`
      );
    })
    .join('');

  const stacked = projects
    .map((item, index) => {
      const name = String(item['project'] ?? 'unknown');
      const tokens = Number(item['tokens'] ?? 0);
      const percent = Number(item['percent'] ?? 0);
      const color = accentShade(Math.max(100 - index * 14, 28));
      const tooltip = escapeHtml(`${name}: ${tokens.toLocaleString()} tokens (${percent.toFixed(2)}% of cost)`);
      return `<div style="width:${percent.toFixed(2)}%;background:${color}" data-tooltip="${tooltip}"></div>`;
    })
    .join('');

  return `<div class="stacked">${stacked}</div>${segments}`;
}

/**
 * Account / plan / Session (5h) / Weekly (7d) — general info rendered above the
 * dashboard tabs, not inside any one of them. Account/plan come from
 * claude_budget_advisor.py's detect_plan() (the `plan` field on every snapshot).
 */
export function buildAccountHeaderHtml(summary: Summary | undefined, rateLimit?: UnifiedRateLimitSnapshot): string {
  const planInfo = summary ? extractPlanInfo(summary) : undefined;
  const planRaw = summary?.['plan'];
  const accountEmail =
    planRaw && typeof planRaw === 'object' && typeof (planRaw as Record<string, unknown>)['email'] === 'string'
      ? ((planRaw as Record<string, unknown>)['email'] as string)
      : undefined;
  const accountLine = `${escapeHtml(accountEmail ?? 'Unknown')} (${escapeHtml(planLabel(planInfo))})`;
  const showLimits = rateLimit?.fiveHour || rateLimit?.sevenDay || (planInfo && planViewMode(planInfo) === 'percent');
  const limits = showLimits
    ? `
    <div class="stats">
      <div>
        <div class="stat-label">Session (5h)</div>
        <div class="stat-value">${rateLimit?.fiveHour ? formatRateLimitWindow(rateLimit.fiveHour, false) : 'No data yet'}</div>
      </div>
      <div>
        <div class="stat-label">Weekly (7d)</div>
        <div class="stat-value">${rateLimit?.sevenDay ? formatRateLimitWindow(rateLimit.sevenDay, true) : 'No data yet'}</div>
      </div>
    </div>
    <div class="subtitle">Anthropic's own rate-limit reading; dollar figures don't apply to your plan.</div>`
    : '';
  return `<div class="account-header">
    <div class="subtitle">Account: ${accountLine}</div>${limits}
  </div>`;
}

/** The Budget tab's inner body markup — no document wrapper, for embedding in the merged dashboard panel. */
export function buildBudgetSectionHtml(summary: Summary, rateLimit?: UnifiedRateLimitSnapshot): string {
  // Pro/Max/Team have no token or $ budget: `percent_used`/`budget_tokens` are this
  // tool's own estimate, so the headline switches to Anthropic's session/weekly reading.
  const percentMode = planViewMode(extractPlanInfo(summary)) === 'percent';
  const month = escapeHtml(String(summary['month'] ?? ''));
  const totalUsage = Number(summary['total_tokens_used'] ?? 0);
  const budget = Number(summary['budget_tokens'] ?? 0);
  const budgetSource = String(summary['budget_source'] ?? 'user');
  const percentUsed = Number(summary['percent_used'] ?? 0);
  const percentRemaining = Number(summary['percent_remaining'] ?? 0);
  const projected = Number(summary['projected_month_end'] ?? 0);
  const projectedPercent = Number(summary['projected_percent'] ?? 0);
  const dailyPace = Number(summary['recommended_daily_tokens'] ?? 0);
  const remainingAllowance = Number(summary['remaining_daily_allowance'] ?? 0);
  const remaining = Number(summary['remaining_tokens'] ?? 0);
  const todayTokens = Number(summary['today_tokens'] ?? 0);
  const todayPercent = Number(summary['today_percent_of_pace'] ?? 0);
  const todayStatus = String(summary['today_status'] ?? 'on_track');
  const paceStatus = String(summary['pace_status'] ?? 'on_track');
  const paceDelta = Number(summary['pace_delta'] ?? 0);
  const averageDaily = Number(summary['average_daily_tokens'] ?? 0);
  const averageActiveDay = Number(summary['average_daily'] ?? 0);
  const daysRemaining = Number(summary['days_remaining'] ?? 0);
  const status = percentMode
    ? statusFromPercent(resolveStatusPercent('percent', summary, rateLimit))
    : String(summary['status'] ?? 'on_track');
  const previousMonth = String(summary['previous_month'] ?? '');
  const previousTokens = Number(summary['previous_month_tokens'] ?? 0);
  const efficiencyDelta = summary['efficiency_delta_percent'];

  const breakdown = (summary['model_breakdown'] ?? []) as Array<Record<string, unknown>>;
  const projects = (summary['project_breakdown'] ?? []) as Array<Record<string, unknown>>;
  const projectCount = Number(summary['project_count'] ?? projects.length);
  const scope = String(summary['scope'] ?? 'all');
  const daily = (summary['daily_series'] ?? []) as Array<{ day: number; tokens: number }>;
  const history = (summary['history'] ?? []) as Array<{ month: string; tokens: number }>;
  const alerts = (summary['alerts'] ?? []) as Array<{ level: string; message: string }>;
  const recommendations = (summary['recommendations'] ?? []) as string[];
  const dayOfMonth = Number(summary['day_of_month'] ?? 1);

  // Bar width and label share one basis: cost share (`percent`), matching the "Spend by model" heading.
  const maxModelPercent = breakdown.length ? Math.max(...breakdown.map((item) => Number(item['percent'] ?? 0))) : 1;
  const modelBars = breakdown
    .map((item) => {
      const model = String(item['model'] ?? 'unknown');
      const tokens = Number(item['tokens'] ?? 0);
      const percent = Number(item['percent'] ?? 0);
      const tier = String(item['tier'] ?? 'unknown');
      const label = `${model}`;
      const width = (percent / (maxModelPercent || 1)) * 100;
      const tooltip = escapeHtml(`${model} (${tier}): ${tokens.toLocaleString()} tokens · ${percent.toFixed(2)}% of cost`);
      return `
        <div class="bar-row">
          <div class="bar-name" data-tooltip="${tooltip}">${escapeHtml(label)}<span class="tier" style="background:${tierColor(tier)}">${escapeHtml(tier)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%;background:${tierColor(tier)}"></div></div>
          <div class="bar-value">${compact(tokens)} · ${percent.toFixed(2)}%</div>
        </div>`;
    })
    .join('');

  const alertItems = alerts
    .map(
      (alert) =>
        `<div class="alert ${alert.level === 'critical' ? 'critical' : 'warning'}">${escapeHtml(alert.message)}</div>`
    )
    .join('');

  const recommendationItems = recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  // 2.3: plain-language replacements for the old signed-delta / bare-arrow cards —
  // a number's sign or an unlabelled ▲/▼ forces the reader to remember which
  // direction is good, and this trend's ▲ meant "spending more" (worse), the
  // opposite of the usual "up is good" reading.
  const paceDeltaText = paceDelta === 0 ? 'On pace' : `${compact(Math.abs(paceDelta))} ${paceDelta > 0 ? 'over pace' : 'under pace'}`;
  const efficiencyValueText = typeof efficiencyDelta === 'number' ? `${efficiencyDelta > 0 ? '+' : ''}${efficiencyDelta.toFixed(2)}%` : '—';
  const efficiencyColor =
    typeof efficiencyDelta === 'number' ? (efficiencyDelta > 0 ? COLORS.bad : COLORS.good) : COLORS.muted;
  const efficiencySub =
    typeof efficiencyDelta === 'number'
      ? `vs ${escapeHtml(previousMonth)} (${compact(previousTokens)} tokens)`
      : 'No previous month to compare';

  const budgetNote =
    budgetSource === 'user'
      ? 'configured budget'
      : budgetSource === 'auto_history'
        ? 'auto budget from your usage history'
        : budgetSource === 'auto_projected'
          ? 'auto budget projected from this month'
          : 'default budget';

  const basis = String(summary['budget_basis'] ?? 'estimated');
  const spendLimit = (summary['spend_limit'] ?? {}) as Record<string, unknown>;
  const resetsAt = String(spendLimit['resets_at'] ?? '');
  const resetText = resetsAt ? new Date(resetsAt).toLocaleString() : '';
  const basisNote = percentMode
    ? 'plan usage as reported by Anthropic (session / weekly), not a token or $ budget'
    : basis === 'authoritative'
      ? `verified against your account limit${resetText ? ` · resets ${escapeHtml(resetText)}` : ''}`
      : basis === 'mock'
        ? `MOCK DATA — not your real limit${resetText ? ` · resets ${escapeHtml(resetText)}` : ''}`
        : `estimated from local usage · ${budgetNote}`;

  // Independent from `basisNote` above: that one is about an admin-key spend LIMIT
  // (still unavailable — see plan §4). This one is the local OTel receiver's real
  // reported cost, which only ever covers the current month, never a credit cap.
  const costBasis = String(summary['cost_basis'] ?? 'estimated');
  const estimatedMonthCost = Number(summary['estimated_total_weighted_cost'] ?? 0);
  const realMonthCost = Number(summary['real_cost_month_usd'] ?? 0);
  const costBasisNote =
    !percentMode && costBasis === 'real_otel' && realMonthCost > 0
      ? ` · grounded in Anthropic's own reported cost ($${realMonthCost.toFixed(2)} real vs our own $${estimatedMonthCost.toFixed(2)} estimate, ${(
          (Math.abs(estimatedMonthCost - realMonthCost) / realMonthCost) *
          100
        ).toFixed(1)}% off)`
      : '';

  // Account/plan come straight from claude_budget_advisor.py's detect_plan() (the
  // `plan` field on every snapshot); `extractPlanInfo`/`planLabel` are the same
  // helpers the status bar tooltip already uses for its "Budget — email (Plan)" line.

  // Agent: the model with the most tokens this month, i.e. the one actually doing
  // the work — not tied to any single proxied turn, so it stays meaningful even
  // outside a Token Improver session.
  const topModel = breakdown.length
    ? breakdown.reduce((max, item) => (Number(item['tokens'] ?? 0) > Number(max['tokens'] ?? 0) ? item : max))
    : undefined;
  const agentLine = topModel ? String(topModel['model'] ?? 'unknown') : 'No usage yet';

  const sessionPercent = rateLimit?.fiveHour ? rateLimit.fiveHour.utilization * 100 : rateLimit?.sevenDay ? rateLimit.sevenDay.utilization * 100 : 0;
  const body = `
  <h1>Claude Budget Advisor
    <span class="pill" style="background:${statusColor(status)}">${statusLabel(status)}</span>
    ${percentMode ? '' : `<span class="pill" style="background:${paceColor(paceStatus)}">${paceLabel(paceStatus)}</span>`}
  </h1>
  <div class="subtitle">Model: ${escapeHtml(agentLine)}</div>
  <div class="subtitle">${month} · day ${dayOfMonth} · ${daysRemaining} days left · ${basisNote}${costBasisNote}${scope === 'all' ? ` · ${projectCount} projects` : ''}</div>

  ${percentMode ? '' : alertItems}

  <div class="top">
    ${percentMode ? donutChart(sessionPercent, statusColor(status), 'of session used') : donutChart(percentUsed, statusColor(status), 'of budget used')}
    <div class="stats">
      <div>
        <div class="stat-label">Today</div>
        <div class="stat-value" style="color:${percentMode ? COLORS.info : paceColor(todayStatus)}">${compact(todayTokens)}</div>
        <div class="stat-sub">${percentMode ? 'tokens today' : `${todayPercent.toFixed(2)}% of daily pace · ${paceLabel(todayStatus)}`}</div>
      </div>
      ${percentMode ? '' : `      <div>
        <div class="stat-label">Recommended daily pace</div>
        <div class="stat-value">${compact(dailyPace)}</div>
        <div class="stat-sub">avg so far ${compact(averageDaily)}/day · need ${compact(remainingAllowance)}/day to stay in budget</div>
      </div>
      <div>
        <div class="stat-label">Used / Budget</div>
        <div class="stat-value">${compact(totalUsage)} / ${compact(budget)}</div>
        <div class="stat-sub">${percentRemaining.toFixed(2)}% remaining (${compact(remaining)})${budgetSource !== 'user' ? ' · budget is an estimate, not a real limit' : ''}</div>
      </div>
      <div>
        <div class="stat-label">Projected month end</div>
        <div class="stat-value" style="color:${projectedPercent > 100 ? COLORS.bad : COLORS.good}">${compact(projected)}</div>
        <div class="stat-sub">${projectedPercent.toFixed(2)}% of budget</div>
      </div>
      <div>
        <div class="stat-label">Ahead / behind pace</div>
        <div class="stat-value" style="color:${paceColor(paceStatus)}">${paceDeltaText}</div>
        <div class="stat-sub">avg ${compact(averageActiveDay)}/active day</div>
      </div>
      `}
      <div>
        <div class="stat-label">Vs last month</div>
        <div class="stat-value" style="color:${efficiencyColor}">${efficiencyValueText}</div>
        <div class="stat-sub">${efficiencySub}</div>
      </div>
    </div>
  </div>

  ${percentMode ? '' : `<h2>Daily usage vs target</h2>
  ${dailyChart(daily, dailyPace, dayOfMonth)}`}

  <h2>Consumption by project</h2>
  ${projectChart(projects)}

  <h2>Spend by model</h2>
  ${breakdown.length ? modelBars : '<div class="empty">No usage recorded for this month yet.</div>'}

  ${percentMode ? '' : `<h2>Month over month</h2>
  ${historyChart(history, budget)}`}

  <h2>Recommendations</h2>
  <ul>${recommendationItems}</ul>`;

  return body;
}
