/**
 * Claude Pro / Max account view.
 *
 * Pro/Max have no budget/spend-limit API — this carries over the exact
 * pre-split behavior (these org types always rendered via the Session/Weekly
 * percent view in statusBar.ts/budgetDashboard.ts), so Pro's display is
 * provably unchanged by the accounts/ split. See accounts/pro.py for the
 * matching Python-side profile.
 */

export const PRO_ORG_TYPES = ['claude_pro', 'claude_max'];
export const PRO_VIEW_MODE = 'percent' as const;
