# claude-budget-advisor

A VS Code extension (`Claude Budget Advisor & Token Improver`) with two cooperating features that share **one** status bar item and **one** dashboard:

- **Claude Budget Advisor** — reads local Claude Code session data and reports usage against a monthly budget, projected month-end usage and the recommended daily pace.
- **Claude Token Improver** — a loopback HTTP proxy that sits between the `claude` CLI and Anthropic, trims and compacts what is sent, keeps the prompt cache warm, and records what each turn cost and saved.

---

## Installation

The extension is distributed as a `.vsix` (it is not on the Marketplace).

1. Build it with `npm install && npm run package`, or get `claude-budget-advisor-<version>.vsix` from whoever distributes it.
2. In VS Code run **Extensions: Install from VSIX…** and pick the file, or `code --install-extension claude-budget-advisor-<version>.vsix`.
3. Reload the window. The proxy starts by itself (`claudeTokenImprover.autoStart`). Claude sessions started in **new** integrated terminals route through it.
4. Install Python 3.8 or newer for the Budget Advisor. The extension looks for `py -3`, `python` and `python3`; if none works the status bar shows **Python required** and offers the download. The proxy itself does not need Python.

Requires VS Code 1.95 or newer.

---

## Claude Token Improver

### How requests reach the proxy

A VS Code extension cannot transparently intercept another process's HTTPS traffic. The proxy works by being *pointed at*: it speaks the Messages API, so any Anthropic client talks to it once its base URL is set.

**Inside VS Code this is automatic.** The extension injects `ANTHROPIC_BASE_URL` into integrated terminals (`environmentVariableCollection`), so a `claude` started in a VS Code terminal goes through the proxy with no setup.

- The variable exists **only while the proxy is listening**. It is withdrawn when the proxy stops or fails, because a base URL pointing at a dead port would break every Claude session in the window.
- It is persistent: terminals VS Code restores already have it. A reload or window close does not clear it; stopping the proxy on purpose, a failed start or uninstalling does.
- Terminals that were open before the proxy was set up do not have it (VS Code cannot change a running terminal). The extension warns, and a **bypass monitor** keeps a persistent warning for any `claude` of this window that is talking straight to Anthropic. Set `claudeTokenImprover.autoConfigureTerminals` to `false` to opt out.

For a terminal outside VS Code, set it yourself (**Claude Token Improver: Copy Proxy Base URL** gives the address):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000   # bash / zsh
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:4000' # PowerShell
```

The injected value carries the project name (`http://127.0.0.1:4000/w/<project>`). The proxy strips that prefix before anything goes upstream and uses it to attribute each turn to its window.

Only `POST /v1/messages` is optimized. Every other endpoint (`count_tokens`, `models`, `batches`, `files`) is relayed untouched.

The same terminals also receive the `CLAUDE_CODE_ENABLE_TELEMETRY` / `OTEL_*` variables, so the `claude` CLI reports its own cost counter to a local OTLP receiver on the proxy (`POST /v1/metrics`). That figure feeds the budget (see below).

### Several VS Code windows

Only one process can bind the port, so all windows share **one** proxy:

- The first window to start **serves** it and is the only one that writes the ledger.
- Later windows find the port taken, confirm through `GET /health` that the holder is this proxy, and **join**: same terminals, status bar and ledger view, no writes.
- When the serving window closes, the others notice (they follow its `GET /events` stream) and one takes the port over.
- If the port is held by another program, you get an error and nothing is killed. Free the port, change `claudeTokenImprover.port`, or reload the other window.
- Proxy settings (stages, upstream) come from the window currently serving.
- If an old extension host keeps serving after the extension was replaced in another window, the **install watch** detects that its code is no longer the code on disk and tells you to reload.

The proxy binds to `127.0.0.1` only. It relays your API credentials and must never be reachable off the machine. It does not log credentials, prompt text or response text.

### The pre-flight pipeline

| Stage | What it does | Setting |
| --- | --- | --- |
| 0. Startup default | If the first request after the proxy starts is Opus, it goes to Sonnet. Later requests keep the model the user chose. | `startupSonnetDefault` |
| 1. String normalization | `trim`, `\r\n` → `\n`, trailing whitespace removed, so cache prefixes match byte for byte. | `stage1Normalization` |
| 2. Chat compaction | Strips greeting filler; once history crosses the threshold **on a cold cache**, the oldest slice is replaced by a summary (see below). | `stage2Compaction` |
| 3. Smart model routing | Routes short, mechanical turns to the newest Haiku. | `stage3ModelRouting` |
| 4. Single sliding cache anchor | Collapses the `cache_control` breakpoints in message history to one on the last assistant turn. | `stage4CacheAnchor` |
| 5. Forward | Sends the payload to `upstreamBaseUrl`. | `upstreamBaseUrl` |

The newest Sonnet and Haiku are asked of Anthropic (`GET /v1/models`, with the credentials of the request being served) and cached on disk, so the proxy does not keep sending users to a superseded model.

**Stage 2 details.** Compaction fires only when the cache is cold (more than 5 minutes since the last request), the history is past `slidingThresholdTokens`, and an economics check says the summary will pay for itself over `expectedRequestsAfterCompaction` requests. With a warm cache it fires only from `warmCacheCompactionTokens`. The summary is written by a short `claude -p` run (Haiku, from a neutral folder) when `agentSummary` is on; if that fails, or it is off, the proxy builds a summary locally from the messages, with no model call. A bare Haiku call from the proxy is not used: Anthropic refuses it when it does not present itself as Claude Code. Summaries are stored per conversation and reused on later cold caches until about 50K new tokens accumulate.

**New day.** On the first request of a new local day the proxy summarizes the previous day's history and asks you to run `/clear`. The popup, a warning icon on the status bar item and a banner in the dashboard carry that notice. The next chat receives the stored summary once.

**Stage 3** also rewrites the parameters Haiku would reject: `output_config.effort` is dropped, adaptive thinking becomes an explicit `budget_tokens`, and `max_tokens` is clamped. Without that, the downgrade would turn a working request into a 400.

**Stage 4** deliberately leaves `cache_control` on `system` and `tools` alone: they are usually the largest stable prefix a client caches, and stripping them would cost far more than it saves.

### Cache lifetime and keep-alive

`claudeTokenImprover.cacheTtl` (`5m` or `1h`, default `5m`) is the single source for every cache decision, from the very first request once the proxy is installed. Nothing leaves the proxy with a 1 h `ttl` unless it is `1h`, which exists only for deliberate measurement.

The cache lives 5 minutes from its last use. The **keep-alive** sends a one-token replay of the last request about every 4.5 minutes, renewing the cache for the price of a read instead of rewriting the whole prefix at 1.25×. It stops `keepAliveMaxMinutes` after the last real request, so an idle session is allowed to expire. Pings cannot fire while the machine is in modern standby, and a cache older than its lifetime after waking is not pinged on purpose.

### Cost model

Costs are compared in **billed units**, never in raw tokens. A model's weight is its input price as a multiple of Sonnet's (Sonnet = 1.0), and each token class is multiplied by its cache rate:

```
Baseline units = rawTokens * originalModelWeight                (unoptimized, no cache)
Actual units   = uncachedInput * actualWeight
               + cacheWrite    * actualWeight * 1.25
               + cacheRead     * actualWeight * 0.10
Savings %      = (1 - actual / baseline) * 100
```

Aggregate percentages come from summed units, not from averaging per-turn percentages. Savings are reported in tokens, units and percentages only. Weights come from the public LiteLLM price table (`pricingUrl`); a failed fetch falls back to a built-in table.

### UI

Both features share **one** status bar item.

- **Default view** is budget pacing (a gauge and percent used).
- **While a request is in flight** the icon spins; overlapping requests are counted, and it stops when the last one lands.
- **After a turn** the savings segment stays until the next turn replaces it; it is restored from the ledger on reload.
- **Colour** is driven only by the budget thresholds. A bad savings number is described in the tooltip but never masks an over-budget warning.
- **Clicking** opens the dashboard.

**Claude: Show Dashboard** opens one panel with two tabs, switched instantly in the page:

- **Budget** — pacing detail for the month.
- **Token Improver** — savings over the ledger, filterable by date range and repo, with a per-turn table (grouped by `Terminal #N` or `chat xxxx`), a history chart, cache hit balance per turn and tips for saving tokens based on what the ledger shows. In table cells `u` is units and `t` is tokens, each with the full word as a tooltip; billed cells show units and percentages go in tooltips.

Terminal grouping resolves the owner of each client socket and its process tree (netstat/PowerShell on Windows, `ss`/`lsof` on Linux, `lsof` on macOS). It is verified on Windows and in Linux (Docker); macOS is untested. If a terminal cannot be resolved nothing breaks: the request is untouched and the row shows `chat xxxx`. The cause is written to `errors.json`.

### Ledger and error log

Every proxied turn is appended to `claude_token_improver_history.json` in the extension's global storage directory (**Open Telemetry Ledger** reveals it). Writes go through a temp file and a rename, and only the serving window writes. It records the timestamp (stored in UTC, shown in local time), project, raw and optimized tokens, cache reads and writes, model swaps and the full cost calculation.

Every error the extension meets is written to `errors.json` in the same folder; repeats are one entry with a count.

### Caveman

Caveman is an optional Claude Code skill that makes responses terser. On activation the extension looks for a folder containing `caveman` under `~/.claude/skills`; if there is none you get a dismissible warning. Whether it was available is recorded on each ledger entry.

### Settings

| Setting (`claudeTokenImprover.*`) | Default | What it does |
| --- | --- | --- |
| `autoStart` | `true` | Start (or share) the proxy when the extension activates. |
| `autoConfigureTerminals` | `true` | Inject `ANTHROPIC_BASE_URL` into integrated terminals. |
| `port` | `4000` | Loopback port, shared by all windows. |
| `upstreamBaseUrl` | `https://api.anthropic.com` | Where optimized traffic goes. Change only for a gateway or a mock. |
| `stage1Normalization`, `stage2Compaction`, `stage3ModelRouting`, `stage4CacheAnchor` | `true` | Turn each stage on or off. |
| `startupSonnetDefault` | `true` | Stage 0: send the first Opus request after startup to Sonnet. |
| `cacheTtl` | `5m` | Cache lifetime set on every request (`5m` or `1h`). |
| `slidingThresholdTokens` | `15000` | History size that triggers compaction on a cold cache. |
| `warmCacheCompactionTokens` | `300000` | History size from which a summary is made even with a warm cache. |
| `compactionFraction` | `0.75` | Controls how much of the newest history stays verbatim. |
| `expectedRequestsAfterCompaction` | `10` | Requests expected after a summary, used to decide whether it pays off. |
| `agentSummary` | `true` | Write the summary with a short `claude -p` run; otherwise build it locally. |
| `exactTokenCounting` | `false` | Measure the baseline with `count_tokens` instead of the local estimate (one extra request per turn). |
| `keepAliveMaxMinutes` | `30` | Keep the cache warm with pings until this long after the last real request. |
| `pricingUrl` | LiteLLM price table | Model price feed. Change only to use a mirror. |

### Before relying on compaction

Compaction **rewrites your conversation history**: the oldest slice is replaced by a summary, which is lossy by design and can drop detail a later turn needed. The turn it fires on pays a one-time cache-miss cost and can legitimately show a *negative* saving. If a session needs full fidelity, turn `stage2Compaction` off.

---

## Claude Budget Advisor

`claude_budget_advisor.py` is a standalone Python script with no VS Code dependency. It reads every `.jsonl` session transcript under the Claude data directory (`~/.claude/projects/**`, or `CLAUDE_CONFIG_DIR` / `--base-dir`) and prints one JSON snapshot. The extension runs it as a subprocess and renders that JSON; it does not read the proxy ledger.

### Which project it uses

1. explicit `--project` / `--project-name` / `--repo-name`
2. `.claude-budget-advisor.json` in the workspace (`{ "project_name": "claude-budget-advisor" }`)
3. the most recently active project under `~/.claude/projects` when scope resolves to `current`

### What it calculates

- usage for the selected month and project, split by model and day
- percent of budget used, projected month-end usage and recommended daily pace
- on-track / warning / over-budget status

`percent_used` is cost-weighted internally. The plan view (token or cost display, driven by the detected account type) only changes what is displayed, not the math.

**Budget.** With `budget` set to `0` it is inferred from your own history: the largest of the last three completed months (dropping any under 25 % of the peak), or the current pace projected to month-end when there are none. The snapshot's `budget_source` says which path was taken.

**Account types.** `accounts/` (Python) and `src/accounts/` (TypeScript) hold per-account logic for Pro/Max and Enterprise, so one account type can change without affecting another. Which account is active is read from Claude Code's own profile (`.claude.json`; only non-secret fields, never the OAuth token).

**Real cost.** The `claude` CLI's own `claude_code.cost.usage` counter, received through the proxy's OTLP endpoint, is passed to the script as `--real-cost-today-usd` / `--real-cost-month-usd`. It only covers sessions that were live and routed through the proxy after telemetry was wired up, so it is a partial lower bound for the month, not a complete total.

**Spend source.** `spendSource` (`auto`, `mock`, `file`, `api`, `none`): `auto` calls the Admin API when `ANTHROPIC_ADMIN_KEY` is set (an Admin key with `read:spend_limits`, read from the environment VS Code was launched from and never stored) and otherwise uses the local estimate.

### Running it directly

```bash
py claude_budget_advisor.py --project claude-budget-advisor --month 2026-09 --budget 500000 --day 17
py claude_budget_advisor.py --offline --scope all   # skip the network pricing fetch
```

### Settings

| Setting (`claudeBudgetAdvisor.*`) | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Show budget pacing in the status bar and dashboard. |
| `scope` | `all` | `all` Claude projects, or only the project of the open workspace. |
| `projectName` | empty | Only used when scope is `project`; empty detects it from the workspace folder. |
| `budget` | `0` | Monthly budget. `0` infers it from your history. |
| `baseDir` | empty | Claude data directory. Empty resolves `CLAUDE_CONFIG_DIR` or your home folder. |
| `spendSource` | `auto` | Where spend figures come from (see above). |
| `spendLimitFile` | empty | JSON payload from the spend limits endpoint; its totals replace the local estimate. |
| `refreshIntervalMinutes` | `15` | Automatic refresh interval; `0` disables it. |

### Commands

| Command | Title |
| --- | --- |
| `claudeBudgetAdvisor.showMenu` | Claude: Show Dashboard |
| `claudeBudgetAdvisor.showSummary` | Claude: Show Dashboard (Budget tab) |
| `claudeTokenImprover.showAnalytics` | Claude: Show Dashboard (Token Improver tab) |
| `claudeBudgetAdvisor.refresh` | Claude Budget Advisor: Refresh |
| `claudeTokenImprover.startProxy` / `stopProxy` | Claude Token Improver: Start / Stop Proxy |
| `claudeTokenImprover.copyBaseUrl` | Claude Token Improver: Copy Proxy Base URL |
| `claudeTokenImprover.openLedger` | Claude Token Improver: Open Telemetry Ledger |

---

## Development

```bash
npm install
npm run compile      # tsc -p ./   (src/**/*.ts -> out/)
npm run watch        # tsc -watch
npm test             # compile, then node --test over out/tests/*.test.js
npm run test:py      # Python analyzer suite (tests/)
npm run test:all     # TypeScript tests with coverage gates + Python tests
npm run package      # build the .vsix
```

`npm run test:coverage` enforces minimum coverage (96 % lines, 90 % branches, 88 % functions) and `vscode:prepublish` runs `test:all`, so a package cannot be built with failing tests. Every change ships with its tests.

Source layout:

```
src/extension.ts             activation, wiring, terminal environment, getSummary()
src/proxy/server.ts          Express router + streaming relay, /health, /events, /v1/metrics
src/proxy/coordinator.ts     multi-window sharing: probe, join, follow events
src/proxy/optimizer.ts       the pre-flight pipeline
src/proxy/localSummary.ts    summary built from the messages, no model call
src/proxy/agentSummary.ts    summary written by a `claude -p` run
src/proxy/keepAlive.ts       cache keep-alive pings
src/proxy/pendingHistory.ts  new-day summaries waiting for a fresh chat
src/proxy/modelCatalog.ts    newest Sonnet / Haiku from GET /v1/models
src/proxy/pricing.ts         Normalized Cost Units
src/proxy/tokenCounter.ts    local estimate + count_tokens
src/proxy/clientProcess.ts   socket owner -> process tree -> terminal
src/proxy/bypassMonitor.ts   warns when `claude` skips the proxy
src/proxy/installWatch.ts    detects a stale extension host
src/analytics/tracker.ts     cost math + durable ledger
src/analytics/realCostTracker.ts, src/otel/   Anthropic's own cost counter via OTLP
src/accounts/                per-account-type behaviour (mirrors accounts/*.py)
src/budget/pythonRuntime.ts  finds a usable Python 3
src/ui/                      status bar, dashboard panel, terminals, tips, helpers
src/tests/                   node:test suites
claude_budget_advisor.py     the budget analyzer
accounts/                    per-account-type logic for the analyzer
tests/                       analyzer tests (pytest)
docs/                        notes (token-saving best practices)
```

## Notes

- Budget scope is per project and self-service; the data source is the local Claude session JSONL files, not a shared organization dashboard.
- Time is stored in UTC and shown in local time; day and month groupings are local.

## Author

Pablo Villalobos Rodríguez — [pvillalobos@growthaccelerationpartners.com](mailto:pvillalobos@growthaccelerationpartners.com)
