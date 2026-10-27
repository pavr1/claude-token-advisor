/**
 * Claude Enterprise account view.
 *
 * Enterprise is a monthly plan: it has no Session(5h)/Weekly(7d) windows and no daily
 * budget, and its real $ spend limit requires an org-admin API key
 * (`spend_limits/effective`) that a "managed" seat (a regular member) can never
 * self-provision — see accounts/enterprise.py.
 *
 * Until such a key exists, Enterprise is shown the month view only: Raw request and
 * Billed input from the proxy ledger (tokens and billed units), with no dollar figures
 * and no budget percentage, and the dashboard's Budget tab is hidden (`showsBudgetTab()` in
 * src/ui/planView.ts). `ENTERPRISE_VIEW_MODE` stays 'dollar' on purpose: when a key arrives
 * and `accounts/enterprise.py` is switched to `spend_limits`, the dollar view and the Budget
 * tab turn on by themselves. Step-by-step: latest/admin-key.md.
 */

export const ENTERPRISE_ORG_TYPES = ['claude_enterprise'];
export const ENTERPRISE_VIEW_MODE = 'dollar' as const;
