/**
 * Extension entry point.
 *
 * Hosts two cooperating features:
 *   - Claude Budget Advisor: reads local Claude session data and reports monthly
 *     token pacing against a budget.
 *   - Claude Token Improver: a loopback HTTP proxy that optimizes outgoing
 *     Messages API traffic and records the resulting savings.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

import {
  aggregate,
  AnalyticsTracker,
  computeTurnCost,
  reconcileWithUsage,
  dayKey,
  localDayKey,
  localMonthKey,
  lastTurnEntries,
  LedgerEntry,
  monthKey,
} from './analytics/tracker';
import { readActiveAccount } from './analytics/activeAccount';
import { InFlightStage, inFlightRequests } from './analytics/inflight';
import { RealCostEvent, RealCostTracker } from './analytics/realCostTracker';
import { detectPython, MIN_PYTHON, PythonMissingError, PythonRuntime } from './budget/pythonRuntime';
import { BypassMonitor } from './proxy/bypassMonitor';
import { checkInstall, readFingerprint, readInstallTime } from './proxy/installWatch';
import { DEFAULT_OPTIMIZER_CONFIG } from './proxy/optimizer';
import { getPricingTable, loadPricing } from './proxy/pricing';
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_UPSTREAM_BASE_URL,
  isNewerVersion,
  ProxyConfig,
  ProxyEvent,
  ProxyPortInUseError,
  TokenImproverProxy,
  TurnRecord,
  UnifiedRateLimitSnapshot,
} from './proxy/server';
import { newestInstalledVersion } from './proxy/installedVersions';
import { announceVersion, EventSubscription, probeProxy, ProbeResult, subscribeToEvents } from './proxy/coordinator';
import { DashboardPanel, DashboardTab } from './ui/dashboardPanel';
import { Summary } from './ui/budgetDashboard';
import { StatusBar } from './ui/statusBar';

const execFileAsync = promisify(execFile);

/** When the running install was created (epoch ms); the floor for every figure this window shows. */

const BUDGET_SECTION = 'claudeBudgetAdvisor';
const IMPROVER_SECTION = 'claudeTokenImprover';

/** Both features report through one status bar item, owned here. */
let statusBar: StatusBar | undefined;
/** Set once at activation so timers and turn-driven refreshes don't need it threaded through every call. */
let extensionContext: vscode.ExtensionContext | undefined;
let budgetRefreshTimer: ReturnType<typeof setInterval> | undefined;
/** 1.3: a completed turn triggers a refresh, but a fast agentic loop can complete
 *  many hits per user turn — this keeps that from spawning a `py` process per hit. */
const AUTO_REFRESH_MIN_INTERVAL_MS = 60_000;
let lastAutoRefreshAt = 0;

/**
 * One proxy serves every VS Code window (see `proxy/coordinator.ts`).
 *
 * - `owner`: this window bound the port. `proxy` is set, and this window alone
 *   writes the ledger and broadcasts `start`/`turn` events.
 * - `joined`: another window's proxy holds the port. `subscription` follows its
 *   events; when they stop, this window tries to take the port over.
 * - `undefined`: not using the proxy.
 */
let proxy: TokenImproverProxy | undefined;
let proxyRole: 'owner' | 'joined' | undefined;
let subscription: EventSubscription | undefined;
/** The user wants the proxy on (auto-start or Start Proxy); cleared by Stop Proxy. */
let proxyWanted = false;
/** Start, stop and takeover run one at a time, so a config restart and a takeover can't interleave. */
let proxyLifecycle: Promise<void> = Promise.resolve();

/** A holder that doesn't answer `/health` may be a proxy that is still shutting down; retry the bind. */
const BIND_ATTEMPTS = 3;
const BIND_RETRY_MS = 500;
/** Random delay before a joined window tries to take over, so windows don't all race at once. */
const TAKEOVER_JITTER_MIN_MS = 150;
const TAKEOVER_JITTER_RANGE_MS = 450;
/** A failed takeover is retried with a growing delay (capped), so the port never stays unserved. */
const TAKEOVER_RETRIES = 20;
const TAKEOVER_RETRY_BASE_MS = 1000;
const TAKEOVER_RETRY_MAX_MS = 5000;
/** A joined window probes the owner's `/health` this often and takes over after this many misses in a row. */
const OWNER_WATCH_INTERVAL_MS = 5000;
const OWNER_WATCH_MISSES = 2;
let ownerWatch: ReturnType<typeof setInterval> | undefined;
let ledgerFollower: ReturnType<typeof setInterval> | undefined;

let tracker: AnalyticsTracker | undefined;
/** Anthropic's own reported cost, from the local OTLP sink. Undefined until telemetry lands. */
let realCostTracker: RealCostTracker | undefined;
/** `globalStorage` folder; the compaction summaries are kept here so a proxy restart doesn't re-pay for them. */
let storageDir: string | undefined;
/**
 * Whether this window has ever seen a real `anthropic-ratelimit-unified-*` reading,
 * as owner or joined. Scoped to the window's whole lifetime, not to the current
 * `TokenImproverProxy` instance, so a config-triggered proxy restart doesn't look
 * like "no reading yet" and re-fire the startup warm-up (`triggerRateLimitWarmup`).
 */
let lastKnownRateLimitInfo: UnifiedRateLimitSnapshot | undefined;
let output: vscode.OutputChannel;
let cavemanAvailable = false;

/**
 * Ledger entries belonging to the user turn currently being reported.
 *
 * One Enter press in an agentic client can fan out into several `/v1/messages`
 * hits (tool call, tool result, tool call, ... until the loop hands control back).
 * Those all belong to the same turn from the user's point of view, so they are
 * grouped here and the "Last turn" tooltip row is the aggregate over the group,
 * not just the most recent hit. `optimizer.ts` tells them apart via
 * `isNewUserTurn`: false whenever a request is a tool-result continuation.
 */
let currentTurnEntries: LedgerEntry[] = [];

/**
 * Injects ANTHROPIC_BASE_URL into integrated terminals so a Claude client started
 * inside VS Code routes through the proxy with no manual setup.
 *
 * Deliberately tied to the proxy's actual state: set on a successful listen,
 * cleared the moment it stops or fails. A base URL pointing at a dead port would
 * break every Claude session in the window, so the variable only exists while
 * something is there to answer it. It is also non-persistent, so a restart that
 * fails to bind never leaves a stale value behind, and VS Code removes it
 * automatically when the extension is disabled or uninstalled.
 */
let terminalEnv: vscode.ExtensionContext['environmentVariableCollection'] | undefined;
/** Warns when a `claude` of this window runs without the proxy variable (started before it was injected). */
let bypassMonitor: BypassMonitor | undefined;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/** Workspace folder name, used to attribute ledger entries to a project. */
function currentProjectName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.basename(folder.uri.fsPath) : 'unknown';
}

// ---------------------------------------------------------------------------
// Budget Advisor
// ---------------------------------------------------------------------------

async function getSummary(context: vscode.ExtensionContext): Promise<Summary> {
  const workspaceRoot = getWorkspaceRoot();
  const scriptPath = path.join(context.extensionPath, 'claude_budget_advisor.py');
  const config = vscode.workspace.getConfiguration(BUDGET_SECTION);
  const scope = config.get<string>('scope', 'all') === 'project' ? 'project' : 'all';
  const budget = config.get<number>('budget', 0) ?? 0;
  const budgetUsd = config.get<number>('budgetUsd', 0) ?? 0;

  // --month/--day come from the local clock; usage is bucketed in local time too
  // (timestamps are stored in UTC and always displayed in local time).
  const now = new Date();
  const [year, monthIndex, day] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  const args = [
    scriptPath,
    '--scope',
    scope,
    '--cwd',
    workspaceRoot,
    '--month',
    month,
    '--day',
    String(day),
    '--day-grouping',
    'local',
  ];

  const baseDir = (config.get<string>('baseDir', '') ?? '').trim();
  if (baseDir) {
    args.push('--base-dir', baseDir);
  }
  if (budget > 0) {
    args.push('--budget', String(budget));
  }
  if (budgetUsd > 0) {
    args.push('--budget-usd', String(budgetUsd));
  }

  const spendLimitFile = (config.get<string>('spendLimitFile', '') ?? '').trim();
  if (spendLimitFile) {
    args.push('--spend-limit-file', spendLimitFile);
  }

  args.push('--spend-source', config.get<string>('spendSource', 'auto'));

  // Ground the Python-side budget math in Anthropic's own reported cost when the
  // local OTel receiver already has it for the current day/month. Omitted entirely
  // (not zero) when no real sample has landed yet, so the script stays estimated.
  if (realCostTracker) {
    syncActiveAccount(baseDir);
    const { dayStart, dayEnd, monthStart, monthEnd } = utcTodayAndMonthBounds();
    // Scoped to whichever account is currently active: a prior login on this
    // machine (e.g. an Enterprise seat exhausted mid-month, then switched to a
    // personal Pro account) must never have its readings folded into today's total.
    const todayUsd = realCostTracker.currentAccountTotalUsdInRange(dayStart, dayEnd);
    const monthUsd = realCostTracker.currentAccountTotalUsdInRange(monthStart, monthEnd);
    if (todayUsd !== undefined) {
      args.push('--real-cost-today-usd', String(todayUsd));
    }
    if (monthUsd !== undefined) {
      args.push('--real-cost-month-usd', String(monthUsd));
    }
  }

  // No install cutoff: transcripts and telemetry are read in full. Once telemetry has begun the
  // cutoff moves up to its first reading so both sides cover one window.
  const since = realCostTracker?.earliestTimestampMs() ?? 0;
  if (since > 0) {
    args.push('--since', new Date(since).toISOString());
  }

  const python = await ensurePython();
  const { stdout } = await execFileAsync(python.command, [...python.args, ...args], {
    cwd: workspaceRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Summary;
}

const PYTHON_DOWNLOAD_URL = 'https://www.python.org/downloads/';
let pythonRuntime: PythonRuntime | undefined;
let pythonPromptShown = false;

/** The interpreter the Budget Advisor script runs on. A miss is not cached, so installing Python is picked up on the next refresh. */
async function ensurePython(): Promise<PythonRuntime> {
  if (!pythonRuntime) {
    pythonRuntime = await detectPython();
    if (pythonRuntime) {
      output.appendLine(`python: ${pythonRuntime.command} ${pythonRuntime.args.join(' ')} (${pythonRuntime.version})`);
    }
  }
  if (!pythonRuntime) {
    throw new PythonMissingError();
  }
  return pythonRuntime;
}

/** Budget pacing needs Python; ask the user to install it, once per session unless `force` (an explicit click). */
function promptInstallPython(context: vscode.ExtensionContext, force = false): void {
  if (pythonPromptShown && !force) {
    return;
  }
  pythonPromptShown = true;
  output.appendLine('python: not found; budget pacing is disabled until it is installed');
  void vscode.window
    .showWarningMessage(
      `Claude Budget Advisor needs Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer to calculate your budget, and none was found. ` +
        'Install it and the budget will start working by itself (the Token Improver proxy is not affected).',
      'Download Python',
      'Check again'
    )
    .then((choice) => {
      if (choice === 'Download Python') {
        void vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD_URL));
      } else if (choice === 'Check again') {
        void refreshBudget(context);
      }
    });
}

async function refreshBudget(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.getConfiguration(BUDGET_SECTION).get<boolean>('enabled', true)) {
    // No real spend-limit source on file yet — show "Not set" instead of a figure
    // nobody has confirmed, rather than spawning the script for a number we'd hide anyway.
    statusBar?.setBudgetDisabled();
    return;
  }
  try {
    const summary = await getSummary(context);
    statusBar?.setBudget(summary);
    DashboardPanel.updateSummary(summary);
  } catch (error) {
    if (error instanceof PythonMissingError) {
      statusBar?.setPythonMissing();
      promptInstallPython(context);
      return;
    }
    statusBar?.setBudgetError(error instanceof Error ? error.message : String(error));
  }
}

/** Refresh from a completed turn, throttled so a fast agentic loop can't spawn a `py` process per hit. */
function refreshBudgetThrottled(): void {
  if (!extensionContext) {
    return;
  }
  const now = Date.now();
  if (now - lastAutoRefreshAt < AUTO_REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  lastAutoRefreshAt = now;
  void refreshBudget(extensionContext);
}

/** 1.3: periodic refresh alongside activation and the manual Refresh command. 0 disables it. */
function startBudgetRefreshTimer(): void {
  stopBudgetRefreshTimer();
  if (!extensionContext) {
    return;
  }
  const minutes = vscode.workspace.getConfiguration(BUDGET_SECTION).get<number>('refreshIntervalMinutes', 15) ?? 15;
  if (minutes <= 0) {
    return;
  }
  const context = extensionContext;
  budgetRefreshTimer = setInterval(() => void refreshBudget(context), minutes * 60_000);
}

function stopBudgetRefreshTimer(): void {
  if (budgetRefreshTimer) {
    clearInterval(budgetRefreshTimer);
    budgetRefreshTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Token Improver
// ---------------------------------------------------------------------------

function readProxyConfig(): ProxyConfig {
  const config = vscode.workspace.getConfiguration(IMPROVER_SECTION);
  const upstream = (config.get<string>('upstreamBaseUrl', DEFAULT_UPSTREAM_BASE_URL) ?? '').trim();

  return {
    port: config.get<number>('port', DEFAULT_PROXY_PORT) ?? DEFAULT_PROXY_PORT,
    // Trailing slashes would produce `//v1/messages` upstream.
    upstreamBaseUrl: (upstream || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, ''),
    exactTokenCounting: config.get<boolean>('exactTokenCounting', false) ?? false,
    optimizer: {
      enableNormalization: config.get<boolean>('stage1Normalization', true) ?? true,
      enableCompaction: config.get<boolean>('stage2Compaction', true) ?? true,
      enableModelRouting: config.get<boolean>('stage3ModelRouting', true) ?? true,
      enableCacheAnchor: config.get<boolean>('stage4CacheAnchor', true) ?? true,
      forceFiveMinuteCache: config.get<boolean>('forceFiveMinuteCache', true) ?? true,
      enableStartupSonnetDefault: config.get<boolean>('startupSonnetDefault', true) ?? true,
      slidingThresholdTokens:
        config.get<number>('slidingThresholdTokens', DEFAULT_OPTIMIZER_CONFIG.slidingThresholdTokens) ??
        DEFAULT_OPTIMIZER_CONFIG.slidingThresholdTokens,
      compactionFraction: Math.min(
        0.95,
        Math.max(
          0.1,
          config.get<number>('compactionFraction', DEFAULT_OPTIMIZER_CONFIG.compactionFraction) ??
            DEFAULT_OPTIMIZER_CONFIG.compactionFraction
        )
      ),
      expectedRequestsAfterCompaction: Math.max(
        1,
        config.get<number>('expectedRequestsAfterCompaction', DEFAULT_OPTIMIZER_CONFIG.expectedRequestsAfterCompaction) ??
          DEFAULT_OPTIMIZER_CONFIG.expectedRequestsAfterCompaction
      ),
    },
  };
}

/**
 * System dependency check for the local Caveman indexer.
 *
 * Caveman ships as a Claude Code skill (a folder under `~/.claude/skills`), not a
 * PATH binary, so presence is checked by listing that directory rather than
 * shelling out. Caveman is optional — the proxy works without it — so a missing
 * skill is only logged (and shown in the tooltip), never a popup: it is outside the core flow.
 */
async function checkCavemanDependency(context: vscode.ExtensionContext): Promise<boolean> {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  let hasCaveman = false;
  try {
    const entries = await fs.promises.readdir(skillsDir);
    hasCaveman = entries.some((entry) => entry.toLowerCase().includes('caveman'));
  } catch (err) {
    output.appendLine(
      `dependency check: could not read ${skillsDir} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (hasCaveman) {
    output.appendLine('dependency check: caveman skill found in ~/.claude/skills');
    return true;
  }

  output.appendLine('dependency check: no caveman skill found in ~/.claude/skills');

  return false;
}

/**
 * Rebuild the tooltip's savings windows from the ledger on activation.
 *
 * The status bar holds its stats in memory, so a window reload used to blank
 * "Last turn", "Today" and "This month" until the next proxied turn landed. The
 * ledger already has that history; this replays it. Buckets are keyed off the
 * entry timestamps' own ISO slices, exactly as `onTurnCompleted` does, so a
 * restored total and a live one never disagree.
 */
function restoreStatusBarHistory(): void {
  if (!tracker || !statusBar) {
    return;
  }

  const all = tracker.getEntries();
  if (all.length === 0) {
    return;
  }

  const nowLocal = new Date();
  const today = all.filter((entry) => dayKey(entry) === localDayKey(nowLocal));
  const month = all.filter((entry) => monthKey(entry) === localMonthKey(nowLocal));

  // The turn that was in flight when the window went away is still the newest one
  // on record, so it also seeds the in-memory group: a tool-result continuation
  // arriving after the reload extends it instead of starting a bogus new turn.
  currentTurnEntries = lastTurnEntries(all);

  statusBar.restoreHistory(
    aggregate(currentTurnEntries),
    today.length > 0 ? aggregate(today) : undefined,
    month.length > 0 ? aggregate(month) : undefined,
    currentTurnEntries.length > 0 ? currentTurnEntries[currentTurnEntries.length - 1].servedModel : undefined
  );
}

/**
 * Whether a request tagged with `project` belongs to this window.
 *
 * Terminals get `/w/<project>` in their base URL. An untagged request comes from a
 * client configured by hand, so the owner window reports it as its own.
 */
function isThisWindowsProject(project: string | undefined): boolean {
  return project === undefined || project === currentProjectName();
}

/** Owner only: a request reached the proxy. */
function onRequestStarted(project: string | undefined, newUserTurn: boolean, id?: string): void {
  checkAccountSwitch();
  proxy?.broadcast({ type: 'start', project: project ?? currentProjectName(), newUserTurn, id });
  inFlightRequests.start(project ?? currentProjectName(), newUserTurn, Date.now(), id);
  DashboardPanel.refreshIfOpen();
  if (isThisWindowsProject(project)) {
    statusBar?.beginRequest();
  }
}

/** Owner only: a request cleared optimization, so its raw → sent numbers are known before the response. */
function onRequestOptimized(project: string | undefined, preflight: InFlightStage, id?: string): void {
  const name = project ?? currentProjectName();
  proxy?.broadcast({ type: 'optimized', project: name, preflight, id });
  inFlightRequests.optimized(name, preflight, id);
  DashboardPanel.refreshIfOpen();
}

/** Owner only, this window's project only: 3b.3 live output count while streaming. */
function onStreamProgress(outputTokens: number, project: string | undefined): void {
  if (isThisWindowsProject(project)) {
    statusBar?.updateStreamProgress(outputTokens);
  }
}

/** Joined windows only: an event from the owner's proxy. */
function onProxyEvent(event: ProxyEvent): void {
  if (event.type === 'start') {
    checkAccountSwitch();
    inFlightRequests.start(event.project, event.newUserTurn === true, Date.now(), event.id);
    DashboardPanel.refreshIfOpen();
    if (event.project === currentProjectName()) {
      statusBar?.beginRequest();
    }
    return;
  }
  if (event.type === 'optimized') {
    inFlightRequests.optimized(event.project, event.preflight, event.id);
    DashboardPanel.refreshIfOpen();
    return;
  }
  if (event.type === 'realCost') {
    // The owner already persisted this reading. Keep it in memory only, exactly
    // like a joined window's ledger entries.
    output.appendLine(`real cost.usage (from owner): $${event.sample.valueUsd.toFixed(4)} (${event.sample.temporality})`);
    realCostTracker?.ingest(event.sample);
    refreshRealCostOnStatusBar();
    return;
  }
  if (event.type === 'rateLimit') {
    // 5.3: just the latest reading, no ledger — nothing to persist.
    applyRateLimitReading(event.info);
    return;
  }
  if (event.type === 'extensionVersion') {
    onNewerExtensionVersion(event.version);
    return;
  }
  // The owner already wrote this entry to disk. Keep it in memory only, so the
  // analytics panel stays current without a second writer on the ledger.
  tracker?.ingest(event.entry);
  inFlightRequests.finish(event.entry.project);
  if (event.entry.project === currentProjectName()) {
    showTurn(event.entry);
  } else {
    DashboardPanel.refreshIfOpen();
  }
}

let reloadPromptedFor: string | undefined;
let reloadItem: vscode.StatusBarItem | undefined;

/**
 * Another window runs a newer version of this extension (reinstalled from there). This
 * window keeps the old code until it reloads, so offer the reload, once per version.
 */
function onNewerExtensionVersion(version: string): void {
  const own = extensionContext?.extension.packageJSON?.version as string | undefined;
  if (!own || !isNewerVersion(version, own) || reloadPromptedFor === version) {
    return;
  }
  reloadPromptedFor = version;
  output.appendLine(`extension ${version} was installed from another window; this one still runs ${own}`);
  // The toast hides itself after a few seconds; this item stays until the window reloads.
  reloadItem ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
  reloadItem.text = `$(debug-restart) Click to reload: Token Improver ${version}`;
  const tooltip = new vscode.MarkdownString(
    `Token Improver ${version} was installed, but this window still runs ${own}.

[$(debug-restart) Reload window](command:workbench.action.reloadWindow)`,
    true
  );
  tooltip.isTrusted = { enabledCommands: ['workbench.action.reloadWindow'] };
  reloadItem.tooltip = tooltip;
  reloadItem.command = 'workbench.action.reloadWindow';
  reloadItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  reloadItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  reloadItem.show();
  void vscode.window
    .showWarningMessage(
      `Claude Token Improver was updated to ${version}. Reload this window to use it (this one still runs ${own}).`,
      'Reload now'
    )
    .then((choice) => {
      if (choice === 'Reload now') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

/**
 * The window a VSIX is installed from keeps running the old code until its extensions restart, and
 * only a window already on the new code can announce it through the proxy. So every window also
 * watches the extensions folder: a newer version appearing there raises the same "Reload" item and
 * prompt as the announcement does. A full window reload (what that item runs) brings back the open
 * Claude Code sessions; restarting only the extension host, as VS Code's own prompt does, drops them.
 */
function watchForNewerInstall(context: vscode.ExtensionContext): void {
  const own = context.extension.packageJSON?.version as string | undefined;
  const ownDir = context.extensionUri.fsPath;
  if (!own) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const check = (): void => {
    try {
      const newest = newestInstalledVersion(ownDir, context.extension.id, own);
      if (newest) {
        onNewerExtensionVersion(newest);
      }
    } catch {
      // Best effort: the folder can be mid-write while VS Code installs.
    }
  };
  try {
    const watcher = fs.watch(path.dirname(ownDir), () => {
      clearTimeout(timer);
      timer = setTimeout(check, 1500);
    });
    watcher.on('error', () => watcher.close());
    context.subscriptions.push({
      dispose: () => {
        clearTimeout(timer);
        watcher.close();
      },
    });
  } catch {
    // The folder cannot be watched: the proxy announcement still covers windows that start later.
  }
}

/** Tell the shared proxy which version this window runs; windows on an older one will offer a reload. */
function announceOwnVersion(port: number): void {
  const own = extensionContext?.extension.packageJSON?.version as string | undefined;
  if (own) {
    void announceVersion(port, own);
  }
}

/** Owner only: a real cost.usage sample arrived over the local OTLP sink. */
function onRealCostReceived(sample: RealCostEvent): void {
  if (!realCostTracker) {
    return;
  }
  output.appendLine(`real cost.usage: $${sample.valueUsd.toFixed(4)} (${sample.temporality}, series ${sample.seriesKey.slice(0, 60)}...)`);
  realCostTracker.record(sample);
  proxy?.broadcast({ type: 'realCost', sample });
  refreshRealCostOnStatusBar();
}

/** Owner only: a fresh session/weekly rate-limit reading arrived on a Messages response. */
function onRateLimitReceived(info: UnifiedRateLimitSnapshot): void {
  applyRateLimitReading(info);
  proxy?.broadcast({ type: 'rateLimit', info });
}

const RATE_LIMIT_STATE_KEY = 'claudeTokenImprover.lastRateLimit';

/** Keep the reading in memory, show it, and persist it (tagged with its account) so the next load starts with it. */
function applyRateLimitReading(info: UnifiedRateLimitSnapshot): void {
  lastKnownRateLimitInfo = info;
  statusBar?.setRateLimitInfo(info);
  DashboardPanel.updateRateLimit(info);
  void extensionContext?.globalState.update(RATE_LIMIT_STATE_KEY, { ...info, accountUuid: lastSeenAccountUuid });
}

let lastSeenAccountUuid: string | undefined;

/**
 * Called whenever a request is routed through the proxy: if the signed-in account differs from the
 * one the displayed data belongs to, drop the previous account's rate-limit reading and reload the
 * budget immediately (unthrottled) so nothing from the old plan lingers.
 */
function checkAccountSwitch(): void {
  const baseDir = (vscode.workspace.getConfiguration(BUDGET_SECTION).get<string>('baseDir', '') ?? '').trim();
  const uuid = readActiveAccount(baseDir)?.accountUuid;
  if (uuid === lastSeenAccountUuid) {
    return;
  }
  const previous = lastSeenAccountUuid;
  lastSeenAccountUuid = uuid;
  if (previous === undefined) {
    return; // first observation this session, nothing stale to drop
  }
  output.appendLine(`account switch detected (${previous} -> ${uuid ?? 'signed out'}); reloading data`);
  lastKnownRateLimitInfo = undefined;
  statusBar?.setRateLimitInfo(undefined);
  DashboardPanel.updateRateLimit(undefined);
  void extensionContext?.globalState.update(RATE_LIMIT_STATE_KEY, undefined);
  syncActiveAccount(baseDir);
  refreshRealCostOnStatusBar();
  if (extensionContext) {
    lastAutoRefreshAt = Date.now();
    void refreshBudget(extensionContext);
  }
}

/** Load the last persisted reading, dropping any window that has already reset (its figure is stale) or belongs to another account. */
function restoreRateLimitReading(context: vscode.ExtensionContext): void {
  const saved = context.globalState.get<UnifiedRateLimitSnapshot & { accountUuid?: string }>(RATE_LIMIT_STATE_KEY);
  if (!saved) {
    return;
  }
  const baseDir = (vscode.workspace.getConfiguration(BUDGET_SECTION).get<string>('baseDir', '') ?? '').trim();
  const currentUuid = readActiveAccount(baseDir)?.accountUuid;
  lastSeenAccountUuid = currentUuid;
  // Untagged (pre-fix) readings can't be attributed to an account, so they are discarded too.
  if (!saved.accountUuid || saved.accountUuid !== currentUuid) {
    void context.globalState.update(RATE_LIMIT_STATE_KEY, undefined);
    return;
  }
  const nowSeconds = Date.now() / 1000;
  const live = (w: UnifiedRateLimitSnapshot['fiveHour']) =>
    w && (w.resetEpochSeconds === undefined || w.resetEpochSeconds > nowSeconds) ? w : undefined;
  const fiveHour = live(saved.fiveHour);
  const sevenDay = live(saved.sevenDay);
  if (!fiveHour && !sevenDay) {
    return;
  }
  const restored = { fiveHour, sevenDay };
  lastKnownRateLimitInfo = restored;
  statusBar?.setRateLimitInfo(restored);
  DashboardPanel.updateRateLimit(restored);
}

/**
 * Fires one minimal real request through the proxy so a genuine
 * `anthropic-ratelimit-unified-*` reading lands without waiting on the user's own
 * first turn. Best-effort: no `claude` CLI on PATH, no auth, or a network hiccup
 * just leaves the status bar at 0% until the user's first real turn, exactly like
 * before this existed.
 */
function triggerRateLimitWarmup(address: string): void {
  const baseUrl = `${address}/w/${encodeURIComponent(currentProjectName())}`;
  // On Windows the npm install exposes `claude` as `claude.cmd`, which `execFile`
  // can't resolve without a shell (ENOENT) — so go through the shell there, quoting
  // the one argument that contains spaces.
  const useShell = process.platform === 'win32';
  const args = [
    '-p',
    useShell ? '"Reply with only the word OK."' : 'Reply with only the word OK.',
    '--model',
    'haiku',
    '--disallowedTools',
    'Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,NotebookEdit',
  ];
  execFileAsync('claude', args, {
    cwd: getWorkspaceRoot(),
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl },
    timeout: 30_000,
    shell: useShell,
  })
    .then(() => output.appendLine('rate-limit warm-up: request sent'))
    .catch((error) => {
      output.appendLine(`rate-limit warm-up skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * Re-read the signed-in account from the Claude profile and pin the cost tracker to it, so a login
 * switch takes effect on the very next refresh. Called before every figure is computed.
 */
function syncActiveAccount(baseDir?: string): void {
  const account = readActiveAccount(baseDir);
  realCostTracker?.setActiveIdentity(account ? { identifiers: account.identifiers, email: account.email } : undefined);
  tracker?.setActiveAccount(account?.accountUuid);
}

/** Local day/month boundaries `RealCostTracker.totalUsdInRange` needs — shared so callers agree on "today"/"this month". */
function utcTodayAndMonthBounds(): { dayStart: number; dayEnd: number; monthStart: number; monthEnd: number } {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return {
    dayStart,
    dayEnd: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(),
    monthStart: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    monthEnd: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
  };
}

/** Push the current UTC-today/this-month real cost totals into the status bar tooltip. */
function refreshRealCostOnStatusBar(): void {
  if (!realCostTracker || !statusBar) {
    return;
  }
  syncActiveAccount((vscode.workspace.getConfiguration(BUDGET_SECTION).get<string>('baseDir', '') ?? '').trim());
  const { dayStart, dayEnd, monthStart, monthEnd } = utcTodayAndMonthBounds();
  statusBar.setRealCost(
    realCostTracker.currentAccountTotalUsdInRange(dayStart, dayEnd),
    realCostTracker.currentAccountTotalUsdInRange(monthStart, monthEnd),
    realCostTracker.currentAccountEmail()
  );
}

/** Add a turn from this window's project to the current group and refresh the status bar. */
function showTurn(entry: LedgerEntry): void {
  if (!tracker) {
    return;
  }

  if (entry.newUserTurn) {
    currentTurnEntries = [];
    // 1.3: a completed turn changes usage, so the budget shouldn't wait for the
    // next periodic timer or a manual click — only on the turn that actually
    // opened (not every tool-result hit inside it), and throttled regardless.
    refreshBudgetThrottled();
  }
  currentTurnEntries.push(entry);
  const lastTurnStats = aggregate(currentTurnEntries);

  const all = tracker.getEntries();
  const todayStats = aggregate(all.filter((candidate) => dayKey(candidate) === dayKey(entry)));
  const monthStats = aggregate(all.filter((candidate) => monthKey(candidate) === monthKey(entry)));
  statusBar?.reportTurn(lastTurnStats, todayStats, monthStats, entry.servedModel);

  DashboardPanel.refreshIfOpen();
}

/** Owner only: record a proxied turn in the ledger, share it with joined windows, and show it here if it's ours. */
function onTurnCompleted(record: TurnRecord): void {
  if (!tracker) {
    return;
  }

  // A login switch must apply to this very turn, not the next refresh.
  syncActiveAccount((vscode.workspace.getConfiguration(BUDGET_SECTION).get<string>('baseDir', '') ?? '').trim());

  const cost = computeTurnCost(record.telemetry, record.usage);
  const reconciled = reconcileWithUsage(record.telemetry, cost);
  const entry: LedgerEntry = {
    timestamp: new Date().toISOString(),
    project: record.project ?? currentProjectName(),
    requestedModel: record.telemetry.originalModel,
    servedModel: record.telemetry.effectiveModel,
    modelSwapped: record.telemetry.modelDowngraded,
    routingReason: record.telemetry.routingReason,
    rawTokens: record.telemetry.rawTokens,
    optimizedTokens: reconciled.optimizedTokens,
    prunedByNormalization: record.telemetry.prunedByNormalization,
    prunedByCompaction: reconciled.prunedByCompaction,
    compactionTriggered: record.telemetry.compactionTriggered,
    summaryReused: record.telemetry.summaryReused,
    compactionEconomics: record.telemetry.compactionEconomics,
    compactionSkippedReason: record.telemetry.compactionSkippedReason,
    historyTokens: record.telemetry.historyTokens,
    compactionTriggerTokens: record.telemetry.compactionTriggerTokens,
    baselineCachedTokens: record.telemetry.baselineCachedTokens,
    clientCacheTtlMs: record.telemetry.clientCacheTtlMs,
    rawTokensExact: record.telemetry.rawTokensExact,
    cacheWrite1hTokens: cost.cacheWrite1hTokens,
    cacheAnchorPlaced: record.telemetry.cacheAnchorPlaced,
    uncachedInputTokens: cost.uncachedInputTokens,
    cacheWriteTokens: cost.cacheWriteTokens,
    cacheReadTokens: cost.cacheReadTokens,
    outputTokens: cost.outputTokens,
    cacheReadUnits: cost.cacheReadUnits,
    cacheWriteUnits: cost.cacheWriteUnits,
    regularInputUnits: cost.regularInputUnits,
    outputUnits: cost.outputUnits,
    cacheMultipliers: cost.cacheMultipliers,
    baselineUnitCost: cost.baselineUnitCost,
    actualUnitCost: cost.actualUnitCost,
    savingsPercent: cost.savingsPercent,
    floorBaselineUnitCost: cost.floorBaselineUnitCost,
    centralBaselineUnitCost: cost.centralBaselineUnitCost,
    cacheNoCacheUnitCost: cost.cacheNoCacheUnitCost,
    cacheActualUnitCost: cost.cacheActualUnitCost,
    summarizerUnitCost: cost.summarizerUnitCost,
    cavemanAvailable,
    newUserTurn: record.telemetry.isNewUserTurn,
    newTurnShape: record.telemetry.newTurnShape,
    status: record.status,
    failure: record.failure,
    accountId: tracker.getActiveAccountId(),
  };

  tracker.record(entry);
  inFlightRequests.finish(entry.project);
  proxy?.broadcast({ type: 'turn', entry });

  if (isThisWindowsProject(record.project)) {
    showTurn(entry);
  } else {
    DashboardPanel.refreshIfOpen();
  }

  output.appendLine(
    `turn [${entry.project}]: ${entry.requestedModel}${entry.modelSwapped ? ` -> ${entry.servedModel}` : ''} ` +
      `raw=${entry.rawTokens} sent=${entry.optimizedTokens} ` +
      `cacheRead=${entry.cacheReadTokens} saved=${entry.savingsPercent.toFixed(1)}% status=${record.status}`
  );

  if (cost.cacheWrite1hTokens > 0) {
    output.appendLine(
      `  WARNING: ${cost.cacheWrite1hTokens} cache-write tokens went to the 1 hour cache (billed 2x, not 1.25x); the proxy now forces the 5 minute cache.`
    );
  }
  if (record.telemetry.compactionError) {
    output.appendLine(`  compaction skipped: ${record.telemetry.compactionError}`);
  }
  if (record.telemetry.cacheAnchorBelowMinimum) {
    output.appendLine('  note: cache anchor prefix is below the minimum cacheable length; the server will ignore it');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run proxy lifecycle steps one at a time; a failed step doesn't block the next. */
function enqueueLifecycle(task: () => Promise<void>): Promise<void> {
  const next = proxyLifecycle.then(task, task);
  proxyLifecycle = next.catch(() => undefined);
  return next;
}

function startProxy(notify: boolean, quiet = false): Promise<void> {
  return enqueueLifecycle(() => startProxyNow(notify, quiet));
}

/**
 * `keepTerminalEnv`: the window is going away (close, reload, update), not the user turning the proxy off. VS Code
 * caches the terminal variables and applies them to terminals it restores at the next start, before this
 * extension has activated, so they must survive a reload.
 */
function stopProxy(keepTerminalEnv = false): Promise<void> {
  return enqueueLifecycle(() => stopProxyNow(keepTerminalEnv));
}

/**
 * Stop using the proxy in this window: close the owned server or leave the shared one.
 *
 * A joined window only drops its subscription, so the owner keeps serving the
 * other windows. An owner flushes the ledger before it closes the event stream,
 * because closing the stream is what tells joined windows to take over, and the
 * new owner reloads the ledger from disk before it writes.
 */
async function releaseProxy(): Promise<boolean> {
  const wasActive = proxyRole !== undefined;
  subscription?.close();
  subscription = undefined;
  clearInterval(ownerWatch);
  ownerWatch = undefined;
  const owned = proxy;
  proxy = undefined;
  proxyRole = undefined;
  if (owned) {
    await tracker?.drain();
    await realCostTracker?.drain();
    await owned.stop();
  }
  return wasActive;
}

/**
 * Serve the proxy from this window, or share the one another window already serves.
 *
 * Never kills whatever holds the port. It may be another window's extension host,
 * and killing that would break the proxy for every window using it.
 */
/** `quiet`: a takeover retry; failures are logged and retried, not shown as an error popup each time. */
async function startProxyNow(notify: boolean, quiet: boolean): Promise<void> {
  proxyWanted = true;
  const config = readProxyConfig();
  config.summaryStorePath = storageDir ? path.join(storageDir, 'compaction_summaries.json') : undefined;
  config.baselineMemoryPath = storageDir ? path.join(storageDir, 'cache_last_request.json') : undefined;
  await releaseProxy();

  for (let attempt = 1; ; attempt++) {
    // The previous owner may have written turns this window only holds in memory,
    // or none at all. Start from what is on disk so the first write loses nothing.
    tracker?.reload();
    realCostTracker?.reload();
    const candidate = new TokenImproverProxy(
      config,
      {
        onRequestStart: onRequestStarted,
        onRequestOptimized,
        onTurnComplete: onTurnCompleted,
        onRealCost: onRealCostReceived,
        onStreamProgress,
        onRateLimitUpdate: onRateLimitReceived,
        onExtensionVersion: onNewerExtensionVersion,
      },
      (message) => output.appendLine(message)
    );

    try {
      await candidate.start();
      proxy = candidate;
      proxyRole = 'owner';
      statusBar?.setProxyContext({ running: true, address: candidate.address, cavemanAvailable, role: 'owner' });
      applyTerminalEnv(candidate.address);
      const ownVersion = extensionContext?.extension.packageJSON?.version as string | undefined;
      if (ownVersion) {
        candidate.announceVersion(ownVersion);
      }
      // Only when this window has never seen a reading — a config-triggered
      // restart of the same window's proxy must not re-spend a real request.
      if (lastKnownRateLimitInfo === undefined) {
        triggerRateLimitWarmup(candidate.address);
      }
      output.appendLine(`proxy listening on ${candidate.address}, forwarding to ${config.upstreamBaseUrl}`);
      if (notify) {
        void vscode.window.showInformationMessage(`Claude Token Improver proxy is listening on ${candidate.address}.`);
      }
      return;
    } catch (error) {
      if (!(error instanceof ProxyPortInUseError)) {
        failStart(error instanceof Error ? error.message : String(error), quiet);
        return;
      }
    }

    const probe = await probeProxy(config.port);
    if (probe.kind === 'ours') {
      joinProxy(config.port, probe.pid, notify);
      return;
    }
    if (probe.kind === 'none' && attempt < BIND_ATTEMPTS) {
      await delay(BIND_RETRY_MS);
      continue;
    }
    failStart(describePortConflict(config.port, probe), quiet);
    return;
  }
}

/** Use the proxy another window serves on `port`, following its events for the status bar. */
function joinProxy(port: number, ownerPid: number, notify: boolean): void {
  const address = `http://127.0.0.1:${port}`;
  proxyRole = 'joined';
  subscription = subscribeToEvents(port, onProxyEvent, () => {
    subscription = undefined;
    void onOwnerGone();
  });
  watchOwner(port);
  announceOwnVersion(port);
  statusBar?.setProxyContext({ running: true, address, cavemanAvailable, role: 'joined' });
  applyTerminalEnv(address);
  output.appendLine(`proxy on ${address} is served by another VS Code window (pid ${ownerPid}); sharing it`);
  if (notify) {
    void vscode.window.showInformationMessage(
      `Claude Token Improver: sharing the proxy another VS Code window serves on ${address}.`
    );
  }
}

/**
 * The owner's event stream ended: its window closed, or it stopped or restarted the proxy.
 * After a short random delay, try to become the owner. If another window got there
 * first, `startProxyNow` finds it on the port and joins it instead.
 */
async function onOwnerGone(): Promise<void> {
  if (!proxyWanted || proxyRole !== 'joined') {
    return;
  }
  output.appendLine('shared proxy owner went away; taking over');
  await delay(TAKEOVER_JITTER_MIN_MS + Math.random() * TAKEOVER_JITTER_RANGE_MS);
  if (!(proxyWanted && proxyRole === 'joined' && !subscription)) {
    return;
  }

  // A failed attempt leaves the role undefined and nothing serving, so keep trying
  // with backoff until this window owns the port or joins whoever does.
  for (let attempt = 1; attempt <= TAKEOVER_RETRIES; attempt++) {
    await startProxy(false, true);
    if (proxyRole !== undefined || !proxyWanted) {
      return;
    }
    const wait = Math.min(TAKEOVER_RETRY_MAX_MS, TAKEOVER_RETRY_BASE_MS * attempt);
    output.appendLine(`takeover attempt ${attempt}/${TAKEOVER_RETRIES} failed; retrying in ${wait} ms`);
    await delay(wait);
    if (!proxyWanted || proxyRole !== undefined) {
      return;
    }
  }
  void vscode.window.showErrorMessage('Claude Token Improver: no proxy is serving and this window could not take over. Run "Start Proxy".');
}

/**
 * Joined windows only: the `/events` stream can stay open while the owner is hung or
 * gone without closing the socket. Probe `/health` and force a takeover when the
 * owner stops answering, so there is always a server.
 */
function watchOwner(port: number): void {
  let misses = 0;
  let probing = false;
  ownerWatch = setInterval(() => {
    if (probing || proxyRole !== 'joined') {
      return;
    }
    probing = true;
    void probeProxy(port)
      .then((probe) => {
        misses = probe.kind === 'none' ? misses + 1 : 0;
        if (misses >= OWNER_WATCH_MISSES && proxyRole === 'joined') {
          misses = 0;
          output.appendLine('shared proxy owner stopped answering /health; taking over');
          subscription?.close();
          subscription = undefined;
          void onOwnerGone();
        }
      })
      .finally(() => {
        probing = false;
      });
  }, OWNER_WATCH_INTERVAL_MS);
}

function describePortConflict(port: number, probe: ProbeResult): string {
  switch (probe.kind) {
    case 'outdated':
      return (
        `port ${port} is held by an older Claude Token Improver in another VS Code window` +
        `${probe.pid !== undefined ? ` (pid ${probe.pid})` : ''}. Reload that window so both run the same version, ` +
        'and this window will share its proxy'
      );
    case 'foreign':
      return `port ${port} is used by another program. Free it or change ${IMPROVER_SECTION}.port`;
    default:
      return `port ${port} is in use and its holder does not answer. Free it or change ${IMPROVER_SECTION}.port`;
  }
}

function failStart(message: string, quiet = false): void {
  // Never leave terminals pointed at a port nothing (of ours) is listening on.
  clearTerminalEnv();
  statusBar?.setProxyContext({ running: false });
  statusBar?.reportProxyError(`Proxy failed to start: ${message}`);
  output.appendLine(`proxy failed to start: ${message}`);
  if (!quiet) {
    void vscode.window.showErrorMessage(`Claude Token Improver proxy failed to start: ${message}`);
  }
}

async function stopProxyNow(keepTerminalEnv: boolean): Promise<void> {
  proxyWanted = false;
  const role = proxyRole;
  if (!(await releaseProxy())) {
    return;
  }
  if (!keepTerminalEnv) {
    clearTerminalEnv();
  }
  statusBar?.setProxyContext({ running: false });
  output.appendLine(role === 'joined' ? 'stopped using the shared proxy (other windows keep it)' : 'proxy stopped');
}

/** Point new integrated terminals at the proxy. No-op when the user opted out. */
function applyTerminalEnv(address: string): void {
  if (!terminalEnv) {
    return;
  }

  if (!vscode.workspace.getConfiguration(IMPROVER_SECTION).get<boolean>('autoConfigureTerminals', true)) {
    terminalEnv.clear();
    clearHostEnv();
    bypassMonitor?.setAddress(undefined);
    return;
  }

  // The /w/<project> prefix tells the shared proxy which window a request came from,
  // so each window's status bar and ledger rows show its own turns. The proxy
  // strips the prefix before forwarding anything upstream.
  const baseUrl = `${address}/w/${encodeURIComponent(currentProjectName())}`;
  const hadCachedEnv = terminalEnv.get('ANTHROPIC_BASE_URL') !== undefined;
  terminalEnv.replace('ANTHROPIC_BASE_URL', baseUrl);
  routeHostEnv(baseUrl);
  bypassMonitor?.setAddress(address);

  // OTLP export goes straight to the proxy's bare address — telemetry is not a
  // per-project Messages call, so it does not need the /w/<project> tag. Claude
  // Code only exports anything at all with the protocol set explicitly (confirmed
  // empirically: the default protocol delivers nothing).
  terminalEnv.replace('CLAUDE_CODE_ENABLE_TELEMETRY', '1');
  terminalEnv.replace('OTEL_METRICS_EXPORTER', 'otlp');
  terminalEnv.replace('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf');
  terminalEnv.replace('OTEL_EXPORTER_OTLP_ENDPOINT', address);

  terminalEnv.description = `Claude Token Improver: ANTHROPIC_BASE_URL routed through ${baseUrl}`;
  output.appendLine(`terminals: ANTHROPIC_BASE_URL=${baseUrl}, OTLP metrics -> ${address} (new and restored terminals)`);
  // No cached value means the terminals already open were created without it: a `claude` running in
  // one of them talks to Anthropic directly. VS Code cannot change a running terminal, only relaunch it.
  if (!hadCachedEnv && vscode.window.terminals.length > 0) {
    warnTerminalsNeedRelaunch();
  }
}

let terminalRelaunchWarned = false;

/** Once per window: terminals opened before the proxy was set up are not routed through it until they are reopened. */
function warnTerminalsNeedRelaunch(): void {
  if (terminalRelaunchWarned) {
    return;
  }
  terminalRelaunchWarned = true;
  output.appendLine('terminals: some were opened before the proxy; claude started in them bypasses it until they are reopened');
  void vscode.window.showWarningMessage(
    'Claude Token Improver: terminals that were already open when it started are not routed through the proxy, so claude run in them goes straight to Anthropic. Close and reopen those terminals (VS Code also offers a relaunch icon on them).'
  );
}

/** `ANTHROPIC_BASE_URL` this window's extension host had before we set it (restored when the proxy stops). */
let hostEnvBackup: { value: string | undefined } | undefined;

/**
 * Route the Claude Code panel (and any extension that spawns `claude`) through the proxy.
 *
 * `environmentVariableCollection` only reaches integrated terminals. The Claude Code
 * extension builds its process env as `{ ...process.env, ...claudeCode.environmentVariables }`
 * at spawn time, and every extension in a window shares one extension host, so setting the
 * variable on this host's `process.env` covers the panel. A conversation already running keeps
 * its old env until a new one starts.
 */
function routeHostEnv(baseUrl: string): void {
  if (!hostEnvBackup) {
    hostEnvBackup = { value: process.env.ANTHROPIC_BASE_URL };
  }
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  output.appendLine(`extension host: ANTHROPIC_BASE_URL=${baseUrl} (Claude Code panel sessions started from now on)`);
}

function clearHostEnv(): void {
  if (!hostEnvBackup) {
    return;
  }
  if (hostEnvBackup.value === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = hostEnvBackup.value;
  }
  hostEnvBackup = undefined;
  output.appendLine('extension host: ANTHROPIC_BASE_URL restored');
}

/** Remove the injected variable. Always called when the proxy is not listening. */
function clearTerminalEnv(): void {
  clearHostEnv();
  bypassMonitor?.setAddress(undefined);
  if (terminalEnv && terminalEnv.get('ANTHROPIC_BASE_URL')) {
    terminalEnv.clear();
    output.appendLine('terminals: ANTHROPIC_BASE_URL injection removed');
  }
}

/**
 * Fetch real per-model rates, same LiteLLM feed and cache TTL `claude_budget_advisor.py`
 * already uses (3.4) — an empty `pricingUrl` setting means "use the public feed
 * automatically," not "skip fetching and use a hand-guessed table."
 */
async function applyPricingConfig(storageDir: string): Promise<void> {
  const customUrl = (vscode.workspace.getConfiguration(IMPROVER_SECTION).get<string>('pricingUrl', '') ?? '').trim();
  const result = await loadPricing(storageDir, customUrl || undefined);
  output.appendLine(`pricing: ${result.detail} (source: ${getPricingTable().source})`);
  // A custom mirror the user configured failing is worth surfacing; the public
  // feed being briefly unreachable and falling back to cache/tier rates is not.
  if (!result.ok && customUrl) {
    void vscode.window.showWarningMessage(
      `Claude Token Improver could not load pricing from ${customUrl}: ${result.detail}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** The status bar's click action, and both dashboard commands: open the single merged panel, on the given tab. */
async function showDashboard(context: vscode.ExtensionContext, initialTab: DashboardTab): Promise<void> {
  if (!tracker) {
    return;
  }
  DashboardPanel.show(tracker, realCostTracker, initialTab);
  try {
    DashboardPanel.updateSummary(await getSummary(context));
  } catch (error) {
    if (error instanceof PythonMissingError) {
      statusBar?.setPythonMissing();
      promptInstallPython(context, true);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Claude Budget Advisor failed: ${message}`);
  }
}

/** How often a host checks that the code it loaded is still the code on disk. */
const INSTALL_CHECK_MS = 5_000;
const RELOAD_JITTER_MIN_MS = 500;
const RELOAD_JITTER_RANGE_MS = 4_000;
const RELOAD_BUSY_POLL_MS = 2_000;

/**
 * Reinstalling (or installing another version over) the extension deletes the folder this host loaded,
 * which looks like an uninstall. A sibling folder of the same extension means it was a reinstall, so the
 * window must reload instead of being left without routing, bypass warning or status bar.
 */
async function installedElsewhere(extensionPath: string): Promise<boolean> {
  const parent = path.dirname(extensionPath);
  const prefix = path.basename(extensionPath).replace(/-\d[\w.+-]*$/, '') + '-';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (fs.readdirSync(parent).some((name) => name.startsWith(prefix) && !name.startsWith('.'))) {
        return true;
      }
    } catch {
      // parent unreadable: treat as not reinstalled
    }
    await delay(1_000);
  }
  return false;
}

/**
 * Let go of the shared proxy when this host is running code that was uninstalled or
 * replaced. VS Code keeps the old extension host alive in every other window until
 * that window reloads, and that host would otherwise keep serving the port (and
 * the old logic) for every window sharing it.
 */
function watchInstall(context: vscode.ExtensionContext): void {
  const entryFile = path.join(context.extensionPath, 'out', 'extension.js');
  const baseline = readFingerprint(entryFile);
  let released = false;

  const timer = setInterval(() => {
    if (released) {
      return;
    }
    const status = checkInstall(entryFile, baseline);
    if (status === 'current') {
      return;
    }
    released = true;
    clearInterval(timer);
    output.appendLine(
      status === 'removed'
        ? 'extension was uninstalled: releasing the proxy so another window can take over'
        : 'extension was updated on disk: releasing the proxy so a window running the new version can take over'
    );
    void stopProxy(status !== 'removed').then(async () => {
      if (status === 'removed' && !(await installedElsewhere(context.extensionPath))) {
        void vscode.window.showInformationMessage('Claude Token Improver was uninstalled. Its proxy in this window has stopped.');
        return;
      }
      // Reload by itself so the new version takes the port without the user visiting every
      // window. The jitter staggers windows so they don't all restart (and race for the port) at once.
      output.appendLine('reloading this window to load the new version');
      await delay(RELOAD_JITTER_MIN_MS + Math.random() * RELOAD_JITTER_RANGE_MS);
      // Never cut a turn in progress: wait until this window's requests have finished.
      while (statusBar?.isBusy) {
        await delay(RELOAD_BUSY_POLL_MS);
      }
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }, INSTALL_CHECK_MS);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

/** How often a window that does not own the proxy checks whether the owner appended to the ledger. */
const LEDGER_FOLLOW_MS = 1_000;

/**
 * Keep a window that does not own the proxy in step with the ledger. The owner writes it; every
 * other window reads the same file, so a stat per second (a few small files) catches an append
 * within a second even when the owner's event stream dropped one.
 */
function followLedger(context: vscode.ExtensionContext): void {
  ledgerFollower = setInterval(() => {
    if (proxyRole === 'owner' || !tracker?.refreshIfChanged()) {
      return;
    }
    realCostTracker?.refreshIfChanged();
    restoreStatusBarHistory();
    DashboardPanel.refreshIfOpen();
  }, LEDGER_FOLLOW_MS);
  context.subscriptions.push({ dispose: () => clearInterval(ledgerFollower) });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Claude Token Improver');
  watchInstall(context);
  watchForNewerInstall(context);

  storageDir = context.globalStorageUri.fsPath;
  tracker = new AnalyticsTracker(context.globalStorageUri.fsPath);
  const installedAt = readInstallTime(context.extensionPath);
  // No install cutoff on the ledger: updating or reinstalling keeps globalStorage, so the whole
  // persisted history stays queryable (Turns, day and month totals).
  tracker.load();
  output.appendLine(`ledger: ${tracker.ledgerPath}`);

  realCostTracker = new RealCostTracker(context.globalStorageUri.fsPath);
  realCostTracker.load();
  followLedger(context);
  syncActiveAccount();
  output.appendLine(`installed: ${installedAt ? new Date(installedAt).toLocaleString() : 'unknown'} (no data cutoff)`);

  terminalEnv = context.environmentVariableCollection;
  bypassMonitor = new BypassMonitor((line) => output.appendLine(line), ensurePython);
  context.subscriptions.push(
    bypassMonitor,
    vscode.commands.registerCommand(BypassMonitor.COMMAND, () => bypassMonitor?.explain())
  );
  // Persistent on purpose: VS Code applies the cached variables to the terminals it restores when a window
  // opens, which happens before this extension activates. A non-persistent collection left those terminals
  // (and every `claude` started in them) talking to Anthropic directly. VS Code drops the cache when the
  // extension is uninstalled; `clearTerminalEnv()` drops it when the proxy is stopped on purpose or fails.
  terminalEnv.persistent = true;

  // One status bar item for both features.
  statusBar = new StatusBar(
    { running: false, address: `http://127.0.0.1:${readProxyConfig().port}`, cavemanAvailable: false },
    `${BUDGET_SECTION}.showMenu`
  );
  context.subscriptions.push(output, { dispose: () => statusBar?.dispose() });

  restoreStatusBarHistory();
  refreshRealCostOnStatusBar();
  restoreRateLimitReading(context);

  void refreshBudget(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(`${BUDGET_SECTION}.showMenu`, () => showDashboard(context, 'budget')),
    vscode.commands.registerCommand(`${BUDGET_SECTION}.showSummary`, () => showDashboard(context, 'budget')),
    vscode.commands.registerCommand(`${BUDGET_SECTION}.refresh`, () => refreshBudget(context)),
    // 1.3: scheduled refresh, restarted when the interval setting changes.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${BUDGET_SECTION}.refreshIntervalMinutes`)) {
        startBudgetRefreshTimer();
      }
    })
  );
  startBudgetRefreshTimer();

  context.subscriptions.push(
    vscode.commands.registerCommand(`${IMPROVER_SECTION}.showAnalytics`, () => showDashboard(context, 'improver')),
    vscode.commands.registerCommand(`${IMPROVER_SECTION}.startProxy`, () => startProxy(true)),
    vscode.commands.registerCommand(`${IMPROVER_SECTION}.stopProxy`, async () => {
      await stopProxy();
      void vscode.window.showInformationMessage('Claude Token Improver proxy stopped.');
    }),
    vscode.commands.registerCommand(`${IMPROVER_SECTION}.copyBaseUrl`, async () => {
      const address = proxy?.address ?? `http://127.0.0.1:${readProxyConfig().port}`;
      await vscode.env.clipboard.writeText(address);
      void vscode.window.showInformationMessage(
        `Copied ${address}. Set ANTHROPIC_BASE_URL to this value in the terminal your Claude client runs in.`
      );
    }),
    vscode.commands.registerCommand(`${IMPROVER_SECTION}.openLedger`, async () => {
      if (!tracker) {
        return;
      }
      if (!fs.existsSync(tracker.ledgerPath)) {
        void vscode.window.showInformationMessage('No turns recorded this month yet.');
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(tracker.ledgerPath));
      await vscode.window.showTextDocument(document);
    }),
    // Configuration changes restart the proxy so the new settings actually take effect.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(IMPROVER_SECTION)) {
        return;
      }
      if (event.affectsConfiguration(`${IMPROVER_SECTION}.pricingUrl`)) {
        await applyPricingConfig(context.globalStorageUri.fsPath);
      }
      // A joined window re-runs start too: it re-joins, and picks up an autoConfigureTerminals change.
      if (proxyRole) {
        await startProxy(false);
      } else if (event.affectsConfiguration(`${IMPROVER_SECTION}.autoConfigureTerminals`)) {
        // Opting out while the proxy is stopped still has to withdraw the variable.
        clearTerminalEnv();
      }
    })
  );

  // The proxy comes up before anything slow (pricing feed, dependency check) so terminals opened right
  // after startup find it listening.
  if (vscode.workspace.getConfiguration(IMPROVER_SECTION).get<boolean>('autoStart', true)) {
    await startProxy(false);
  }

  cavemanAvailable = await checkCavemanDependency(context);
  statusBar.setProxyContext({ cavemanAvailable });

  await applyPricingConfig(context.globalStorageUri.fsPath);
}

export async function deactivate(): Promise<void> {
  stopBudgetRefreshTimer();
  // Flushes the ledger before the event stream closes, so the window taking over
  // reloads a complete ledger. The terminal variables stay cached for the next start.
  await stopProxy(true);
  await tracker?.drain();
  await realCostTracker?.drain();
  statusBar?.dispose();
}
