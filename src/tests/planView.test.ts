/**
 * Unit tests for 5.2's plan-detection reader: the `plan` object
 * `claude_budget_advisor.py`'s `detect_plan()` attaches to every summary, and the
 * $-vs-% view decision built on top of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPlanInfo,
  formatRateLimitWindow,
  showsBudgetTab,
  paceForecast,
  paceForecastIcon,
  planLabel,
  planViewMode,
  resolveDollarBudget,
  resolveStatusPercent,
} from '../ui/planView';

function summaryWithPlan(plan: Record<string, unknown> | undefined): Record<string, unknown> {
  return plan === undefined ? {} : { plan };
}

test('extractPlanInfo returns undefined when the summary has no plan object', () => {
  assert.equal(extractPlanInfo({}), undefined);
  assert.equal(extractPlanInfo(summaryWithPlan(null as unknown as Record<string, unknown>)), undefined);
});

test('extractPlanInfo reads the snake_case fields detect_plan() emits', () => {
  const plan = extractPlanInfo(
    summaryWithPlan({
      organization_type: 'claude_enterprise',
      billing_type: 'invoiced',
      seat_tier: 'enterprise',
      budget_api: 'spend_limits',
    })
  );
  assert.deepEqual(plan, {
    organizationType: 'claude_enterprise',
    billingType: 'invoiced',
    seatTier: 'enterprise',
    budgetApi: 'spend_limits',
  });
});

test('extractPlanInfo treats missing/non-string fields as null, not a thrown error', () => {
  const plan = extractPlanInfo(summaryWithPlan({ organization_type: null, budget_api: 42 }));
  assert.deepEqual(plan, { organizationType: null, billingType: null, seatTier: null, budgetApi: null });
});

test('planViewMode: API maps to dollar (a real $ figure exists)', () => {
  assert.equal(planViewMode({ organizationType: 'api', billingType: null, seatTier: null, budgetApi: 'usage_cost' }), 'dollar');
});

test('planViewMode: Team (and anything else Python could not price) maps to percent', () => {
  assert.equal(planViewMode({ organizationType: 'claude_team', billingType: null, seatTier: null, budgetApi: 'unavailable' }), 'percent');
});

test('planViewMode: Pro is not in BUDGET_API_BY_ORG_TYPE, so it also falls to percent', () => {
  // detect_plan()'s BUDGET_API_BY_ORG_TYPE.get(..., "unavailable") default — confirmed live
  // on a real Pro account in 5.1's writeup (organizationType: claude_pro).
  assert.equal(planViewMode({ organizationType: 'claude_pro', billingType: null, seatTier: null, budgetApi: 'unavailable' }), 'percent');
});

test('planViewMode: Enterprise maps to dollar (estimated weighted-cost fallback; accounts/enterprise.ts)', () => {
  assert.equal(planViewMode({ organizationType: 'claude_enterprise', billingType: null, seatTier: null, budgetApi: 'rate_limit' }), 'dollar');
});

test('planViewMode: no plan detected at all maps to unknown, not a guess', () => {
  assert.equal(planViewMode(undefined), 'unknown');
  assert.equal(planViewMode({ organizationType: null, billingType: null, seatTier: null, budgetApi: null }), 'unknown');
});

test('planLabel: known org types get a human label; unknown ones fall back to the raw value', () => {
  assert.equal(planLabel({ organizationType: 'claude_pro', billingType: null, seatTier: null, budgetApi: 'unavailable' }), 'Pro');
  assert.equal(planLabel({ organizationType: 'claude_enterprise', billingType: null, seatTier: null, budgetApi: 'spend_limits' }), 'Enterprise');
  assert.equal(planLabel({ organizationType: 'api', billingType: null, seatTier: null, budgetApi: 'usage_cost' }), 'API');
  assert.equal(planLabel({ organizationType: 'some_future_plan', billingType: null, seatTier: null, budgetApi: null }), 'some_future_plan');
  assert.equal(planLabel(undefined), 'Unknown');
});

test('resolveDollarBudget: no admin key on file (budget_basis "estimated") uses our own weighted-cost projection', () => {
  const result = resolveDollarBudget({ budget_basis: 'estimated', estimated_total_weighted_cost: 42.5, budget_usd: 100 });
  assert.deepEqual(result, { usedUsd: 42.5, limitUsd: 100, source: 'estimated' });
});

test('resolveDollarBudget: estimated with no derivable cap at all reports an undefined limit, not zero', () => {
  const result = resolveDollarBudget({ budget_basis: 'estimated', estimated_total_weighted_cost: 42.5, budget_usd: 0 });
  assert.deepEqual(result, { usedUsd: 42.5, limitUsd: undefined, source: 'estimated' });
});

test('resolveDollarBudget: authoritative spend_limit (real admin-API/file figure) takes priority and converts minor units', () => {
  const result = resolveDollarBudget({
    budget_basis: 'authoritative',
    total_weighted_cost: 42.5,
    budget_usd: 100,
    spend_limit: { limit_minor: 500000, used_minor: 123450, exponent: 2 },
  });
  assert.deepEqual(result, { usedUsd: 1234.5, limitUsd: 5000, source: 'authoritative' });
});

test('resolveDollarBudget: budget_basis says authoritative but the spend limit has no usable amount falls back to estimated', () => {
  const result = resolveDollarBudget({
    budget_basis: 'authoritative',
    estimated_total_weighted_cost: 42.5,
    budget_usd: 100,
    spend_limit: { available: false },
  });
  assert.deepEqual(result, { usedUsd: 42.5, limitUsd: 100, source: 'estimated' });
});

test('formatRateLimitWindow: undefined window reads "unavailable"', () => {
  assert.equal(formatRateLimitWindow(undefined, false), 'unavailable');
});

test('formatRateLimitWindow: rounds utilization to a whole percent and appends the reset time', () => {
  const label = formatRateLimitWindow({ utilization: 0.381, resetEpochSeconds: 1790366400 }, false);
  assert.match(label, /^38% — resets /);
});

test('formatRateLimitWindow: weekly window includes a weekday in the reset label', () => {
  const label = formatRateLimitWindow({ utilization: 0.1, resetEpochSeconds: 1790917200 }, true);
  assert.match(label, /^10% — resets \w+, /);
});

test('formatRateLimitWindow: no reset header omits the reset clause entirely', () => {
  assert.equal(formatRateLimitWindow({ utilization: 0.5, resetEpochSeconds: undefined }, false), '50%');
});

test('resolveStatusPercent: dollar/token modes are unchanged — plain percent_used', () => {
  assert.equal(resolveStatusPercent('dollar', { percent_used: 42.5 }, undefined), 42.5);
  assert.equal(resolveStatusPercent('unknown', { percent_used: 10 }, undefined), 10);
});

test('resolveStatusPercent: percent mode with no rate-limit reading yet defaults to 0, not percent_used', () => {
  assert.equal(resolveStatusPercent('percent', { percent_used: 90 }, undefined), 0);
});

test('resolveStatusPercent: percent mode with only Session (5h) data uses it', () => {
  const percent = resolveStatusPercent(
    'percent',
    { percent_used: 5 },
    { fiveHour: { utilization: 0.42, resetEpochSeconds: undefined }, sevenDay: undefined }
  );
  assert.equal(percent, 42);
});

test('resolveStatusPercent: percent mode with only Weekly (7d) data uses it', () => {
  const percent = resolveStatusPercent(
    'percent',
    {},
    { fiveHour: undefined, sevenDay: { utilization: 0.6, resetEpochSeconds: undefined } }
  );
  assert.equal(percent, 60);
});

test('resolveStatusPercent: percent mode with both windows always uses Session (5h)', () => {
  const percent = resolveStatusPercent(
    'percent',
    {},
    {
      fiveHour: { utilization: 0.3, resetEpochSeconds: undefined },
      sevenDay: { utilization: 0.75, resetEpochSeconds: undefined },
    }
  );
  assert.equal(percent, 30);
});

test('paceForecast: no window, or no reset header, means no forecast', () => {
  assert.equal(paceForecast(undefined, 'sevenDay'), undefined);
  assert.equal(paceForecast({ utilization: 0.5, resetEpochSeconds: undefined }, 'sevenDay'), undefined);
});

test('paceForecast: window barely started has no signal to project from yet', () => {
  const now = new Date('2026-03-05T00:00:00Z');
  // 7d window, only ~1 minute elapsed (reset almost exactly 7 days out).
  const resetEpochSeconds = now.getTime() / 1000 + 7 * 24 * 60 * 60 - 30;
  const result = paceForecast({ utilization: 0.01, resetEpochSeconds }, 'sevenDay', now);
  assert.equal(result, undefined);
});

test('paceForecast: burning slower than time elapsed reports "ahead"', () => {
  const now = new Date('2026-03-05T00:00:00Z');
  const durationSeconds = 7 * 24 * 60 * 60;
  // Half the window elapsed, only 20% used — well under the 90% pace threshold.
  const resetEpochSeconds = now.getTime() / 1000 + durationSeconds / 2;
  const result = paceForecast({ utilization: 0.2, resetEpochSeconds }, 'sevenDay', now);
  assert.equal(result?.status, 'ahead');
  assert.match(result!.message, /doing well/);
  assert.match(result!.message, /reset/);
});

test('paceForecast: burning right at time-elapsed pace reports "on_track"', () => {
  const now = new Date('2026-03-05T00:00:00Z');
  const durationSeconds = 5 * 60 * 60;
  // Half the session elapsed, ~48% used — within the 0.9-1.15 on-track band.
  const resetEpochSeconds = now.getTime() / 1000 + durationSeconds / 2;
  const result = paceForecast({ utilization: 0.48, resetEpochSeconds }, 'fiveHour', now);
  assert.equal(result?.status, 'on_track');
  assert.match(result!.message, /pacing right on target/);
});

test('paceForecast: burning faster than time elapsed reports "behind"', () => {
  const now = new Date('2026-03-05T00:00:00Z');
  const durationSeconds = 5 * 60 * 60;
  // Only 10% of the session elapsed but already 50% used — way over pace.
  const resetEpochSeconds = now.getTime() / 1000 + durationSeconds * 0.9;
  const result = paceForecast({ utilization: 0.5, resetEpochSeconds }, 'fiveHour', now);
  assert.equal(result?.status, 'behind');
  assert.match(result!.message, /burning faster/);
});

test('paceForecast: weekly reset label names the weekday, session reset label does not', () => {
  const now = new Date('2026-03-05T00:00:00Z');
  const weekly = paceForecast(
    { utilization: 0.2, resetEpochSeconds: now.getTime() / 1000 + (7 * 24 * 60 * 60) / 2 },
    'sevenDay',
    now
  );
  const session = paceForecast(
    { utilization: 0.2, resetEpochSeconds: now.getTime() / 1000 + (5 * 60 * 60) / 2 },
    'fiveHour',
    now
  );
  assert.match(weekly!.message, /'s reset/);
  assert.match(session!.message, /today's session reset/);
});

test('paceForecast: stale/out-of-range reset headers (already past, or beyond the window duration) are ignored', () => {
  const now = new Date('2026-03-05T00:00:00Z');
  assert.equal(paceForecast({ utilization: 0.5, resetEpochSeconds: now.getTime() / 1000 - 10 }, 'fiveHour', now), undefined);
  assert.equal(
    paceForecast({ utilization: 0.5, resetEpochSeconds: now.getTime() / 1000 + 999999999 }, 'fiveHour', now),
    undefined
  );
});

test('paceForecastIcon maps each status to a distinct codicon', () => {
  assert.equal(paceForecastIcon('ahead'), '$(pass-filled)');
  assert.equal(paceForecastIcon('behind'), '$(alert)');
  assert.equal(paceForecastIcon('on_track'), '$(info)');
});

test('showsBudgetTab hides the Budget tab for dollar-mode plans without an authoritative limit', () => {
  const plan = (organizationType: string, budgetApi: string) =>
    extractPlanInfo({ plan: { organization_type: organizationType, budget_api: budgetApi } });
  const authoritative = { budget_basis: 'authoritative', spend_limit: { limit_minor: 25000, used_minor: 1873, exponent: 2 } };

  // Enterprise today: no admin key, so no limit to read.
  assert.equal(showsBudgetTab(plan('claude_enterprise', 'rate_limit'), {}), false);
  // Enterprise once a key makes the limit authoritative: the tab comes back by itself.
  assert.equal(showsBudgetTab(plan('claude_enterprise', 'spend_limits'), authoritative), true);
  // Pro/Max are percent-mode and unaffected.
  assert.equal(showsBudgetTab(plan('claude_pro', 'unavailable'), {}), true);
  // Nothing loaded yet.
  assert.equal(showsBudgetTab(undefined, undefined), true);
});
