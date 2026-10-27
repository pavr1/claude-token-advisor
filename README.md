# claude-budget-advisor

A VS Code extension with two cooperating features:

- **Claude Budget Advisor** — reads local Claude Code session data and reports token usage against a monthly budget, projected month-end usage, and the recommended daily pace.
- **Claude Token Improver** — a loopback HTTP proxy that intercepts outgoing Anthropic Messages API traffic, prunes and compacts it, manages a single sliding cache anchor, and reports the financial savings.

---

## Installation

The extension is distributed as a `.vsix` file (it is not on the Marketplace).

1. Build it with `npm install && npm run package`, or get `claude-budget-advisor-<version>.vsix` from whoever distributes it.
2. In VS Code, run **Extensions: Install from VSIX…** and pick the file. From a terminal you can run `code --install-extension claude-budget-advisor-0.2.0.vsix` instead.
3. Reload the window. The proxy starts by itself (`claudeTokenImprover.autoStart`). Claude sessions started in **new** integrated terminals route through it.
4. Install Python 3.8 or newer (the Budget Advisor runs `claude_budget_advisor.py`). The extension looks for `py -3`, `python` and `python3` on its own; if none is found the status bar shows **Python required** and a prompt offers the download, then the budget starts working at the next refresh. The proxy does not need Python. Optional: the Caveman skill (see below).

---

## Claude Token Improver

### How interception actually works

A VS Code extension cannot transparently intercept another process's HTTPS traffic. The proxy works by being *pointed at*: it speaks the Messages API, so any Anthropic client will talk to it if you set its base URL.

**Inside VS Code this is automatic.** The extension injects `ANTHROPIC_BASE_URL` into integrated terminals via `context.environmentVariableCollection`, so a `claude` session started in a VS Code terminal routes through the proxy with no setup. Deliberate limits:

- The variable exists **only while the proxy is actually listening**. It is set when the proxy binds and withdrawn the moment it stops or fails, because a base URL pointing at a dead port would break every Claude session in the window.
- It is **persistent** (cached by VS Code), so terminals VS Code restores when a window opens already have it before the extension activates. It is dropped when the proxy is stopped on purpose or fails to start, and VS Code removes it when the extension is uninstalled. A reload or window close does **not** clear it.

The first time the proxy is set up, terminals that were already open do not have it (VS Code cannot change a running terminal); the extension warns about it and VS Code shows a "relaunch terminal" hint on them. A `claude` in such a terminal, in the Claude Code VS Code panel or outside VS Code goes straight to Anthropic. Set `claudeTokenImprover.autoConfigureTerminals` to `false` to opt out.

This covers VS Code's own terminals and nothing else. For a terminal outside VS Code, set it yourself — run **Claude Token Improver: Copy Proxy Base URL** to get the address:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000   # bash / zsh
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:4000' # PowerShell
```

Requests to `POST /v1/messages` are optimized; every other endpoint (`count_tokens`, `models`, `batches`, `files`) is relayed untouched, so nothing else breaks.

> **Why not write `~/.claude/settings.json` instead?** That would also cover the CLI launched outside VS Code, but the edit would outlive the extension (VS Code only runs an uninstall script on the next start) and break `claude` everywhere the moment the proxy wasn't running. Writing it from the extension, with cleanup on disable/uninstall, is tracked as a possible future improvement (`latest/findings.md`, F-35). If you want that anyway, add it by hand; it's your file, not the extension's.

The injected value carries the project name: `http://127.0.0.1:4000/w/<project>`. The proxy strips that prefix before anything goes upstream, and uses it to attribute each turn to the window it came from. A base URL set by hand without the prefix works too; its turns are attributed to the window that serves the proxy.

### Several VS Code windows

Only one process can listen on the port, so all windows share **one** proxy:

- The first window to start binds the port and **serves** the proxy. It is also the only one that writes the ledger.
- Every later window finds the port taken, checks through `GET /health` that the holder is this proxy, and **shares** it. Its terminals, status bar and ledger view work the same way. The status bar tooltip tells you which role a window has.
- When the serving window closes, the remaining windows notice right away (they follow its `GET /events` stream) and one of them takes the port over. Nothing needs restarting.
- If the port is held by **another program**, or by an older build of this extension in another window, you get an error and nothing is killed. Free the port, change `claudeTokenImprover.port`, or reload the other window.
- Proxy settings (stages, upstream) come from the serving window. Changing them in a sharing window has no effect until that window serves the proxy.
- **Stop Proxy** in a sharing window only stops *that* window from using the proxy; the other windows keep it.

The proxy binds to `127.0.0.1` only — it relays your API credentials and must never be reachable off the machine. It does not log credentials, prompt text, or response text.

### The 5-stage pre-flight pipeline

| Stage | What it does | Setting |
| --- | --- | --- |
| 1. String normalization | `.trim()` on text, `\r\n` → `\n`, trailing whitespace removed, so cache prefixes match byte-for-byte | `stage1Normalization` |
| 2. Chat compression | Strips greeting fluff; once history crosses the threshold, summarizes the oldest 75% into a ~150-token technical manifest via Haiku | `stage2Compaction` |
| 3. Smart model routing | Routes short, mechanical turns to `claude-haiku-4-5` | `stage3ModelRouting` |
| 4. Single sliding cache anchor | Strips `cache_control` from message history, places exactly one `ephemeral` breakpoint on the last assistant turn | `stage4CacheAnchor` |
| 5. Cloudside execution | Forwards the lean payload to `https://api.anthropic.com` | `upstreamBaseUrl` |

Stage 3 also rewrites parameters Haiku 4.5 would reject: `output_config.effort` is dropped, adaptive thinking becomes an explicit `budget_tokens`, and `max_tokens` is clamped to 64K. Without that translation the downgrade would turn a working request into a 400.

Stage 4 deliberately leaves `cache_control` on `system` and `tools` alone. They render before `messages` and are usually the largest stable prefix a client caches; stripping them to satisfy "exactly one anchor" would cost far more than it saves.

### Financial analytics

Savings are computed in **Normalized Cost Units** — a model's input price as a multiple of Sonnet's, so Sonnet is 1.0 by definition:

```
Baseline Unit Cost = rawTokens * originalModelWeight
Actual Unit Cost   = uncachedInput * actualWeight
                   + cacheWrite    * actualWeight * 1.25
                   + cacheRead     * actualWeight * 0.10
Savings %          = (1 - actual / baseline) * 100
```

Baseline is the *unoptimized* request on the *originally requested* model with no cache, so the percentage answers "what did the middleware buy me". Aggregate percentages are computed from summed costs, not by averaging per-turn percentages.

Weights are derived from real input prices (`src/proxy/pricing.ts`). Set `claudeTokenImprover.pricingUrl` to a JSON endpoint returning `{"<model-id>": <input $/MTok>}` to override them; a failed fetch keeps the built-in table.

### UI

Both features share **one** status bar item — there is no separate Token Improver bar.

- **Default view** is budget pacing (`$(pulse) ████░░░░░░ 42.5%`), because that is continuously true.
- **While a request is in flight** the leading icon spins (`$(sync~spin)` instead of `$(pulse)`), from the moment the request enters the proxy until the response is fully back — including the Stage 2 summarization call and the tail of a stream. Overlapping requests are counted, so an agentic client shows `🦖 ×3` and the spinner stops only when the last one lands. Each window counts only its own project's requests.
- **After the turn completes** the savings segment (`· 🦖 34.00%`, with `×N` when one Enter press fanned out into several API calls) stays until the next turn replaces it. On reload it is restored from the ledger.
- **Colour** is driven by the budget thresholds only. A bad savings number is described in the tooltip but never masks an over-budget warning.
- **The tooltip** has both sections: budget pacing, and a full Token Improver breakdown (compaction pruning, model downgrades, cache hits, whether Caveman is available). When the proxy is idle it shows the address and the `ANTHROPIC_BASE_URL` line instead.
- **Clicking** opens a quick pick for the two dashboards, since one bar now fronts both. Either is also reachable directly from the command palette.

**Claude Token Improver: Show Monthly Analytics** opens the savings dashboard over the persistent ledger, filterable by month and by workspace project folder.

### Telemetry ledger

Every turn is appended to `claude_token_improver_history.json` in the extension's global storage directory (**Claude Token Improver: Open Telemetry Ledger** reveals it). Writes go through a temp file and a rename so a crash cannot truncate it. Only the window serving the proxy writes it, so several open windows cannot overwrite each other's turns. It records timestamp, project folder, raw and optimized tokens, cache reads and writes, model swaps, and the full cost calculation, and survives editor restarts.

### Caveman dependency check

Caveman is a Claude Code skill that makes responses terser (fewer output tokens). On activation the extension looks for a folder whose name contains `caveman` under `~/.claude/skills`. If there is none you get a dismissible warning recommending it; Caveman is optional and the proxy works without it. Whether it was available is recorded on every ledger entry.

### Settings

| Setting (`claudeTokenImprover.*`) | Default | What it does |
| --- | --- | --- |
| `autoStart` | `true` | Start (or share) the proxy when the extension activates. |
| `autoConfigureTerminals` | `true` | Inject `ANTHROPIC_BASE_URL` into integrated terminals (new and restored) while the proxy runs. |
| `port` | `4000` | Loopback port. Shared by all windows. |
| `upstreamBaseUrl` | `https://api.anthropic.com` | Where optimized traffic goes. Change only for a gateway or a mock. |
| `stage1Normalization` … `stage4CacheAnchor` | `true` | Turn each pipeline stage on or off (table above). |
| `slidingThresholdTokens` | `15000` | History size that triggers Stage 2 compaction. |
| `compactionFraction` | `0.75` | Share of the oldest history replaced by the manifest. |
| `exactTokenCounting` | `false` | Measure the baseline with `count_tokens` instead of the local estimate. |
| `pricingUrl` | empty | JSON map of model id → input $/MTok, overriding the built-in prices. |

By default the baseline is measured with a local token estimator (no round trip, typically within ~10%). Enable `exactTokenCounting` to use `POST /v1/messages/count_tokens` instead, at the cost of one extra request per turn.

### Things to know before enabling Stage 2

Sliding compaction **rewrites your conversation history**. It replaces the oldest 75% of the transcript with a generated summary, which is lossy by design and can drop detail a later turn needed. It also costs one extra Haiku call per compaction, and the turn it fires on takes a one-time cache-miss penalty — that turn can legitimately show a *negative* saving. If a session needs full fidelity, turn `stage2Compaction` off.

---

## Claude Budget Advisor

Reads local Claude session JSONL files and reports pacing for the selected month and project.

### How it resolves the correct project

1. explicit CLI `--project` / `--project-name` / `--repo-name`
2. a local config file such as `.claude-budget-advisor.json`
3. the most recent project under `~/.claude/projects` when `current` is used

This matters because a VS Code-installed tool may run from a different working directory than the repo being tracked.

```json
{
  "project_name": "claude-budget-advisor"
}
```

### Example usage

```bash
py claude_budget_advisor.py --project claude-budget-advisor --month 2026-09 --budget 500000 --day 17
py claude_budget_advisor.py --project current --month 2026-09 --budget 500000 --day 17
```

### What it calculates

- total tokens used for the selected month/project
- model split for that usage
- % of budget consumed, projected month-end usage, recommended daily pace
- on-track / warning / over-budget status

### Settings

| Setting (`claudeBudgetAdvisor.*`) | Default | What it does |
| --- | --- | --- |
| `scope` | `all` | `all` Claude projects, or only the `project` matching the workspace. |
| `budget` | `0` | Monthly token budget. `0` infers it from your own usage history. |
| `projectName` | empty | Used only with `scope: project`. Empty detects it from the workspace folder. |
| `baseDir` | empty | Override for the Claude data directory. Empty resolves it from `CLAUDE_CONFIG_DIR` or your home folder. |
| `spendSource` | `auto` | Where spend figures come from: `auto` (Admin API when `ANTHROPIC_ADMIN_KEY` is set, else the local estimate), `mock`, `file`, `api`, `none`. |
| `spendLimitFile` | empty | Path to a JSON payload from the spend limits endpoint; its totals replace the local estimate. |

`ANTHROPIC_ADMIN_KEY` must be an Admin API key with `read:spend_limits`. Set it in the environment VS Code is launched from; it is never stored by the extension.

---

## Development

```bash
npm install
npm run compile      # tsc -p ./
npm test             # compile, then node --test over out/tests
py -m pytest tests/  # the Python analyzer's own suite
npm run package      # build the .vsix
```

Source layout:

```
src/proxy/server.ts        Express proxy router + streaming relay, /health, /events
src/proxy/coordinator.ts   multi-window sharing: probe, join, follow events
src/proxy/optimizer.ts     the 5-stage optimization engine
src/proxy/pricing.ts       Normalized Cost Units
src/proxy/tokenCounter.ts  local estimation + count_tokens
src/analytics/tracker.ts   cost math + durable ledger
src/ui/statusBar.ts        the single shared status bar item
src/ui/                    webviews and presentation helpers
src/tests/                 node:test suites
claude_budget_advisor.py   the budget analyzer
```

## Notes

- Commands and settings are namespaced `claudeBudgetAdvisor.*` and `claudeTokenImprover.*`. Before v0.2.0 `package.json` declared the budget commands as `tokenBudgetAdvisor.*` while the code registered `claudeBudgetAdvisor.*`, so neither command nor any setting actually worked; both sides now use `claudeBudgetAdvisor.*`.
- Budget scope is per-project and self-service; the data source is local Claude session JSONL files, not a shared org dashboard.
