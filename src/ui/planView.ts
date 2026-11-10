/**
 * 5.2: plan detection on the TypeScript side.
 *
 * `claude_budget_advisor.py`'s `detect_plan()` already reads the local Claude
 * profile and puts the result on `snapshot["plan"]` — this module is the TS-side
 * reader for that field, plus the $-vs-% view decision the rest of §5 builds on.
 * Pure and `vscode`-free so it can be unit tested directly.
 */

import { resolveAccountViewMode } from '../accounts';
import { ENTERPRISE_ORG_TYPES } from '../accounts/enterprise';
import { RateLimitWindow, UnifiedRateLimitSnapshot } from '../proxy/server';

export interface PlanInfo {
  organizationType: string | null;
  billingType: string | null;
  seatTier: string | null;
  /** Mirrors `BUDGET_API_BY_ORG_TYPE` in claude_budget_advisor.py: 'spend_limits' | 'usage_cost' | 'unavailable'. */
  budgetApi: string | null;
}

export type PlanViewMode = 'dollar' | 'percent' | 'unknown';

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads the `plan` object `claude_budget_advisor.py` already attaches to every summary. */
export function extractPlanInfo(summary: Record<string, unknown>): PlanInfo | undefined {
  const plan = summary['plan'];
  if (!plan || typeof plan !== 'object') {
    return undefined;
  }
  const raw = plan as Record<string, unknown>;
  return {
    organizationType: readString(raw, 'organization_type'),
    billingType: readString(raw, 'billing_type'),
    seatTier: readString(raw, 'seat_tier'),
    budgetApi: readString(raw, 'budget_api'),
  };
}

/**
 * Which tooltip view the plan supports. Delegates to the accounts/ registry
 * (`resolveAccountViewMode`): Pro is explicitly 'percent' there (Session/Weekly
 * rate-limit headers); Enterprise is explicitly 'dollar' (this tool's own
 * weighted-cost estimate, since Session/Weekly needs a proxied request first);
 * API's `usage_cost` has a real $ figure to show (3.5); Team, or an org type
 * Python doesn't recognize, falls back to claude.ai's own session/weekly %
 * (5.3).
 */
export function planViewMode(plan: PlanInfo | undefined): PlanViewMode {
  if (!plan || !plan.budgetApi) {
    return 'unknown';
  }
  return resolveAccountViewMode(plan.organizationType, plan.budgetApi);
}

const ORG_TYPE_LABELS: Record<string, string> = {
  claude_enterprise: 'Enterprise',
  claude_team: 'Team',
  claude_pro: 'Pro',
  claude_max: 'Max',
  api: 'API',
};

/** A human label for the tooltip's "Plan" row. Falls back to the raw org type for one Python hasn't labeled here yet. */
export function planLabel(plan: PlanInfo | undefined): string {
  if (!plan || !plan.organizationType) {
    return 'Unknown';
  }
  return ORG_TYPE_LABELS[plan.organizationType] ?? plan.organizationType;
}

/**
 * 5.3: renders one `anthropic-ratelimit-unified-*` window as "38% — resets 5:20 PM"
 * (or with a weekday for the weekly one), matching the two figures claude.ai's own
 * usage page shows for Pro/Max/Team.
 */
export function formatRateLimitWindow(window: RateLimitWindow | undefined, includeWeekday: boolean): string {
  if (!window) {
    return 'unavailable';
  }
  const percent = Math.round(window.utilization * 100);
  if (window.resetEpochSeconds === undefined) {
    return `${percent}%`;
  }
  const resetDate = new Date(window.resetEpochSeconds * 1000);
  const resetLabel = includeWeekday
    ? resetDate.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : resetDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${percent}% — resets ${resetLabel}`;
}

export type PaceForecastStatus = 'ahead' | 'on_track' | 'behind';

export interface PaceForecast {
  status: PaceForecastStatus;
  message: string;
}

const WINDOW_DURATION_SECONDS: Record<'fiveHour' | 'sevenDay', number> = {
  fiveHour: 5 * 60 * 60,
  sevenDay: 7 * 24 * 60 * 60,
};

/**
 * 5.4: projects Session/Weekly utilization forward at its current burn rate and
 * compares that to the time actually left in the window — the same pacing hint
 * claude.ai's own usage page and the Claude Code CLI show ("You're doing well, you
 * should reach Thursday's reset with room to spare"), derived from the same
 * `anthropic-ratelimit-unified-*` reading this tool already has rather than a
 * separate API call. `resetEpochSeconds` is the only anchor available — there is no
 * window-start header — so the window's fixed duration (5h / 7d) is used to back
 * into elapsed time. Returns undefined when there isn't enough signal to project
 * from yet (no reset header, or the window barely started).
 */
export function paceForecast(
  window: RateLimitWindow | undefined,
  windowKind: 'fiveHour' | 'sevenDay',
  now: Date = new Date()
): PaceForecast | undefined {
  if (!window || window.resetEpochSeconds === undefined) {
    return undefined;
  }
  const durationSeconds = WINDOW_DURATION_SECONDS[windowKind];
  const remainingSeconds = window.resetEpochSeconds - now.getTime() / 1000;
  if (remainingSeconds <= 0 || remainingSeconds >= durationSeconds) {
    return undefined;
  }
  const fractionElapsed = (durationSeconds - remainingSeconds) / durationSeconds;
  if (fractionElapsed < 0.02) {
    return undefined;
  }

  const resetDate = new Date(window.resetEpochSeconds * 1000);
  const resetLabel =
    windowKind === 'sevenDay'
      ? `${resetDate.toLocaleDateString(undefined, { weekday: 'long' })}'s reset`
      : "today's session reset";

  const projectedUtilization = window.utilization / fractionElapsed;
  if (projectedUtilization <= 0.9) {
    return { status: 'ahead', message: `You're doing well — you should reach ${resetLabel} with room to spare.` };
  }
  if (projectedUtilization <= 1.15) {
    return { status: 'on_track', message: `You're pacing right on target for ${resetLabel}.` };
  }
  return {
    status: 'behind',
    message: `You're burning faster than your pace to ${resetLabel} — you may run out before then.`,
  };
}

/** Matches `statusToIcon`'s codicon vocabulary in budgetDashboard.ts. */
export function paceForecastIcon(status: PaceForecastStatus): string {
  switch (status) {
    case 'ahead':
      return '$(pass-filled)';
    case 'behind':
      return '$(alert)';
    default:
      return '$(info)';
  }
}

/**
 * 5.3 follow-up: which number the compact status-bar percentage (and its colour
 * threshold) is driven by. Pro/Max/Team (`percent` mode) have no $ or token ground
 * truth of their own — `percent_used` there is this tool's dollar-weighted estimate,
 * not a figure the plan actually has a budget for — so the status bar must use the
 * same Session (5h) / Weekly (7d) rate-limit reading the tooltip already shows
 * (`formatRateLimitWindow`), not fall back to that estimate. Always tracks Session
 * (5h) — that's the window the user watches turn to turn — and only falls back to
 * Weekly (7d) when Session hasn't been read yet (no proxied request has landed
 * since VS Code started). Falls back to `percent_used` unchanged for every plan
 * that isn't in `percent` mode.
 */
export function resolveStatusPercent(
  mode: PlanViewMode,
  summary: Record<string, unknown>,
  rateLimitInfo: UnifiedRateLimitSnapshot | undefined
): number {
  if (mode !== 'percent') {
    return asFiniteNumber(summary['percent_used']) ?? 0;
  }
  const fiveHourPercent = rateLimitInfo?.fiveHour ? rateLimitInfo.fiveHour.utilization * 100 : undefined;
  const sevenDayPercent = rateLimitInfo?.sevenDay ? rateLimitInfo.sevenDay.utilization * 100 : undefined;
  return fiveHourPercent ?? sevenDayPercent ?? 0;
}

export interface DollarBudget {
  usedUsd: number;
  /** `undefined` means there is no cap to show against — just a spend figure (e.g. API with no limit set). */
  limitUsd: number | undefined;
  /** 'authoritative' when it comes from `apply_spend_calibration()`'s real spend-limit API/file source; 'estimated' when it's this tool's own weighted-cost projection. */
  source: 'authoritative' | 'estimated';
}

function asFiniteNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * 3.5: the $ figures for the dollar-view tooltip (Enterprise/API plans).
 *
 * Prefers the real spend-limit `apply_spend_calibration()` already resolves in
 * Python (Enterprise's admin-API limit, when an admin key is configured) and
 * falls back to this tool's own weighted-cost estimate — the same
 * real-preferring-with-graceful-fallback pattern `cost_basis`/`estimated_total_weighted_cost`
 * already use for the OTel figures.
 */
export function resolveDollarBudget(summary: Record<string, unknown>): DollarBudget {
  const spendLimit = summary['spend_limit'];
  if (summary['budget_basis'] === 'authoritative' && spendLimit && typeof spendLimit === 'object') {
    const raw = spendLimit as Record<string, unknown>;
    const limitMinor = asFiniteNumber(raw['limit_minor']);
    const usedMinor = asFiniteNumber(raw['used_minor']);
    const exponent = asFiniteNumber(raw['exponent']) ?? 2;
    if (limitMinor !== undefined && limitMinor > 0 && usedMinor !== undefined) {
      const divisor = Math.pow(10, exponent);
      return { usedUsd: usedMinor / divisor, limitUsd: limitMinor / divisor, source: 'authoritative' };
    }
  }

  const usedUsd = asFiniteNumber(summary['estimated_total_weighted_cost']) ?? 0;
  const limitUsd = asFiniteNumber(summary['budget_usd']);
  return { usedUsd, limitUsd: limitUsd !== undefined && limitUsd > 0 ? limitUsd : undefined, source: 'estimated' };
}

/**
 * True when a $-view account has no real spend limit on file (Enterprise without an
 * admin key), so any `percent_used` would be measured against a made-up cap. Those
 * accounts show this month's Raw request / Billed input instead of a percentage.
 */
export function usesMonthUsageView(plan: PlanInfo | undefined, summary: Record<string, unknown>): boolean {
  return planViewMode(plan) === 'dollar' && resolveDollarBudget(summary).source !== 'authoritative';
}

/**
 * Whether the dashboard shows its Budget tab. A dollar-mode plan (Enterprise, API) without an
 * authoritative spend limit has no used-vs-budget figure to show — only the month view
 * (Raw request / Billed input), which lives in the Token Improver tab — so the tab is hidden
 * until an admin key makes the limit readable (see latest/admin-key.md). Percent-mode plans
 * (Pro/Max/Team) always show it.
 */
export function showsBudgetTab(plan: PlanInfo | undefined, summary: Record<string, unknown> | undefined): boolean {
  return !summary || !usesMonthUsageView(plan, summary);
}
