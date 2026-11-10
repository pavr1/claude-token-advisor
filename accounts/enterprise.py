"""Claude Enterprise account profile.

Enterprise is a monthly plan: it has no Session(5h)/Weekly(7d) windows and no daily
budget. Its spend limit ($X of $Y, resets monthly) only exists behind Anthropic's
Admin API (`spend_limits/effective`), which requires an org-admin API key. A
"managed" enterprise seat (a regular member, not an org owner/admin) can never
self-provision that key — `can_self_provision_key` in `detect_plan()` is false for
exactly this reason.

Tagged "rate_limit" instead of "spend_limits" so `accounts.wants_spend_limit_api()`
is false: no admin-key attempt, no network call and no calibration of the snapshot
against a limit that cannot be read. The extension then shows Enterprise the month
view only (Raw request / Billed input from the proxy ledger, no dollars, no budget
percentage; see src/accounts/enterprise.ts).

If GAP (or another org) ever issues a member a `read:spend_limits`-scoped admin key,
re-enabling the real dollar path for Enterprise is a deliberate one-line follow-up:
change `budget_api` below to "spend_limits" (full checklist: latest/admin-key.md).
"""

PROFILE = {"budget_api": "rate_limit"}
