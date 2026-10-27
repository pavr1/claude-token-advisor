# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules (always follow, in every response and every change)

1. **Findings are always named with ID + short description**, never the ID alone ("F-04 – compactación falla con HTTP 400"), including when repeated.
2. **Time: store UTC, show local.** Never show UTC to the user (ledger timestamps included: convert before quoting them); never persist local time. Day/month groupings are local.
3. **Compare costs in billed units** (tokens x multiplier: read 0.10x, write 1.25x), never raw token counts, for any highlight, sort or "which is bigger" decision.
4. **Reuse the existing UI surface** (one status bar item, the existing panels); do not add a parallel one. Budget thresholds own the status bar colour.
5. **Cache TTL is 5 minutes from the very first request** once the proxy is installed: `forceFiveMinuteCache` defaults to true, and nothing may leave the proxy with a 1 h `ttl`. The 1 h option is only for deliberate measurement.
6. **No dollars in presented savings:** use tokens, units and percentages. The conservative defensible figure is ~34 % (see `latest/findings.md`, F-03).
7. **Panel labels:** `u` = units and `t` = tokens in table cells, always as `<abbr>` with the full word as tooltip; billed cells show units, percentages go in tooltips.
8. **Priority: the tool first.** Presentation (deck) and documentation (F-05, F-29) are the last steps, only once the tool is 100 % functional; do not work on them before.
9. **Verify before claiming.** Say what was measured versus assumed; do not state a cause or a number that was not checked in the code or the ledger.

## Commands

```bash
npm install                  # install TS deps
npm run compile               # tsc -p ./  (src/**/*.ts -> out/)
npm run watch                  # tsc -watch -p ./
npm test                       # compile, then node --test over out/tests/*.test.js
npm run package                 # build the .vsix (vsce package)

py -m pytest tests/             # Python analyzer's own suite (tests/test_budget.py)
```

Run a single test:

```bash
# TypeScript (node:test) - compile first, then filter by name or run one file
npm run compile && node --test --test-name-pattern="<name>" out/tests/*.test.js
npm run compile && node --test out/tests/pricing.test.js

# Python
py -m pytest tests/test_budget.py -k test_percent_used_reflects_cost_weight_not_raw_tokens
```

Run the budget analyzer directly (useful for debugging without the extension host):

```bash
py claude_budget_advisor.py --project claude-budget-advisor --month 2026-09 --budget 500000 --day 17
py claude_budget_advisor.py --offline --scope all   # skip network pricing fetch, use local/cached rates
```

## Architecture

This is a single VS Code extension (`src/extension.ts`) that bundles **two cooperating features sharing one status bar item** — there is no separate UI for each:

- **Claude Token Improver** — a loopback HTTP proxy (Express) that Anthropic clients (the `claude` CLI) are pointed at via `ANTHROPIC_BASE_URL`, injected automatically into new VS Code integrated terminals while the proxy is listening.
- **Claude Budget Advisor** — a separate Python script (`claude_budget_advisor.py`) that reads local Claude Code session `.jsonl` transcripts directly (not the proxy/ledger) and reports monthly token/dollar pacing. It is invoked as a subprocess (`py claude_budget_advisor.py ...`) from `extension.ts`'s `getSummary()`, which builds the CLI args and parses the JSON stdout into a `Summary` object. This TS↔Python process boundary is the main seam to be aware of when tracing a bug: UI code in `src/ui/` only ever sees the JSON shape the Python script prints, so a field like `percent_used` must be traced back into `claude_budget_advisor.py`, not into any TS state.

### Proxy internals (`src/proxy/`)

- `server.ts` — Express router + streaming relay, `/health`, `/events` (SSE).
- `coordinator.ts` — **multi-window sharing**: only one process can bind the port. The first VS Code window to start becomes the *serving* window (binds the port, writes the ledger); every later window detects the port is taken, confirms via `GET /health` that the holder is this same proxy, and *joins* — sharing status bar, terminals and ledger reads without writing. If the serving window closes, joined windows follow its `/events` stream and one of them takes over the port. Proxy settings (stages, upstream URL) always come from whichever window is currently serving.
- `optimizer.ts` — the 5-stage pre-flight pipeline applied to outgoing `POST /v1/messages` bodies only (every other endpoint is relayed untouched): (1) string normalization for cache-prefix stability, (2) chat compaction via an extra Haiku call, only on a cold cache (>5 min since the last request, tracked by `BaselineMemory`), once history crosses `slidingThresholdTokens`, gated by `estimateCompactionEconomics`; `SummaryStore` persists summaries and a per-conversation `resumed` flag so a later cold cache reuses the summary until 50K new tokens pile up, (3) routing short/mechanical turns to Haiku (with parameter translation — `output_config.effort` dropped, thinking budget made explicit, `max_tokens` clamped — since Haiku rejects Sonnet/Opus-shaped params), (4) collapsing all `cache_control` breakpoints in message history to a single sliding anchor on the last assistant turn (system/tools breakpoints are left alone deliberately), (5) forward to `upstreamBaseUrl`.
- `pricing.ts` — Normalized Cost Units (Sonnet = 1.0 baseline weight); fetches the public LiteLLM price table by default, `claudeTokenImprover.pricingUrl` overrides it, a failed fetch falls back to a built-in table.
- `tokenCounter.ts` — local token estimator used for the optimizer's baseline measurement, or `exactTokenCounting` to call `count_tokens` instead.

### Analytics / cost tracking (`src/analytics/`, `src/otel/`)

Two independent, differently-scoped cost signals exist and must not be conflated:

- `tracker.ts` — the durable **ledger** (`claude_token_improver_history.json`), one row per proxied turn, written only by the serving window. This is the proxy's own savings math (before/after cost per turn), unrelated to Anthropic's billing.
- `otel/otlpDecoder.ts` + `analytics/realCostTracker.ts` — a local OTLP receiver (`POST /v1/metrics` on the proxy) that decodes Anthropic's own `claude_code.cost.usage` counter, emitted by the `claude` CLI itself when `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` env vars are injected into a terminal. `RealCostTracker` keeps only the **latest cumulative reading per series** (session+model+...), since the OTel counter is cumulative-since-meter-start, not a delta. Because it only ever records sessions that were live and routed through the proxy *after* telemetry was wired up, its month-to-date sum is a **partial, monotonically-improving lower bound**, not a complete month total — it must never be treated as strictly more authoritative than a complete local scan just because it's "real". (`extension.ts`'s `getSummary()` passes it into the Python script as `--real-cost-today-usd`/`--real-cost-month-usd`, which currently *replaces* rather than floors the local estimate in `build_budget_snapshot` — a known sharp edge when the override's coverage is thinner than the full month.)

### Budget Advisor (`claude_budget_advisor.py`)

Pure-Python, no VS Code dependency, runnable standalone. Reads every `.jsonl` transcript under the Claude data directory (`~/.claude/projects/**`, or `CLAUDE_CONFIG_DIR`/`--base-dir` override), aggregates tokens and a dollar-weighted cost per day/model/project/month, and produces one JSON snapshot (`build_budget_snapshot`). Key things that span multiple call sites:

- **Project resolution order**: explicit `--project`/`--project-name`/`--repo-name` > `.claude-budget-advisor.json` in the workspace > most recently active project under `~/.claude/projects` (when scope resolves to `current`).
- **Budget inference** (`derive_budget`): when `--budget` is `0`/omitted, it's inferred from the user's own history — the max of the last 3 completed months (dropping any that are under 25% of the peak, to avoid a light onboarding month deflating the baseline) — or, with no completed months, the current pace projected to month-end, or `1.0` as a last-resort default. `budget_source` in the output tells you which path was taken.
- **`percent_used` is always dollar-weighted internally**, even in the tooltip's "token view" — the token-vs-dollar UI split (`planViewMode` in `src/ui/statusBar.ts`, driven by `detect_plan()`'s plan info) only changes what's *displayed*, not the underlying math.

### UI (`src/ui/`)

- `statusBar.ts` — the single shared status bar item for both features. Default view is budget pacing; while a request is in flight the icon spins and overlapping requests are counted per-window; after a turn, the savings segment shows until the next turn. Color is driven only by budget thresholds, never by savings.
- `budgetDashboard.ts`, `analyticsPanel.ts` — the two webview dashboards (budget pacing detail; Token Improver monthly savings), reachable from a quick pick since one status bar item now fronts both.
- `planView.ts`, `liveTurnRow.ts`, `shared.ts` — presentation helpers (plan/mode detection, in-flight turn rows, shared formatting).
