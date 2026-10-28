/**
 * The extension's single status bar item.
 *
 * Both features report through here — there is one bar, not one per feature.
 * Budget pacing is the neutral default view and is always shown, because it is
 * the thing that is continuously true. A proxied turn appends a savings segment
 * that stays on the bar permanently until the next turn replaces it — the Token
 * Improver section never expires on its own, so it is always visible in the
 * tooltip once at least one turn has gone through the proxy this session.
 *
 * Colour is driven by the budget thresholds only. A bad savings number is worth
 * reading about in the tooltip, but it must not mask an over-budget warning.
 */

import * as vscode from 'vscode';
import { AggregateStats, billedUnits } from '../analytics/tracker';
import { paceLabel, renderEmbeddedProgressBar, statusFromPercent, statusLabel, statusToIcon, Summary } from './budgetDashboard';
import { compact, formatUsd, progressBarText } from './shared';
import {
  extractPlanInfo,
  formatRateLimitWindow,
  paceForecast,
  paceForecastIcon,
  planLabel,
  planViewMode,
  resolveDollarBudget,
  resolveStatusPercent,
  usesMonthUsageView,
} from './planView';
import { UnifiedRateLimitSnapshot } from '../proxy/server';

export interface ProxyContext {
  running: boolean;
  address: string;
  cavemanAvailable: boolean;
  /** Whether this window serves the shared proxy or uses one another window serves. */
  role?: 'owner' | 'joined';
}

/**
 * Needle positions in `media/budget-icons.woff` are `claude-budget-gauge-1..19`, from full
 * scale (1) to rest (19). While busy the needle behaves like a current meter: it picks a
 * random reading from 0 to 100 %, sometimes a small nudge and sometimes a long jump, eases
 * toward it, hovers there a moment, then picks another. When the work ends it sinks back to
 * rest step by step instead of snapping.
 */
const GAUGE_FRAMES = 19;
const GAUGE_TICK_MS = 55;
const GAUGE_REST = GAUGE_FRAMES;
const pctToPos = (pct: number): number => GAUGE_FRAMES - (pct / 100) * (GAUGE_FRAMES - 1);

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly gaugeItem: vscode.StatusBarItem;

  private budget: Summary | undefined;
  private budgetError: string | undefined;
  /** `claudeBudgetAdvisor.enabled` is off — no figure has been confirmed real, so show "Not set" rather than an estimate. */
  private budgetDisabled = false;
  /** Budget pacing needs Python and none was found: shown as a warning until it is installed. */
  private pythonMissing = false;
  /** Aggregate over every proxy hit belonging to the most recently completed user turn. */
  private lastTurn: AggregateStats | undefined;
  private todayStats: AggregateStats | undefined;
  private monthStats: AggregateStats | undefined;
  /** Anthropic's own reported cost for today/this month, from the local OTel sink. Undefined until it lands. */
  private todayRealUsd: number | undefined;
  private monthRealUsd: number | undefined;
  /** The Anthropic account currently authenticated on this machine, from `RealCostTracker.currentAccountEmail()`. */
  private currentAccountEmail: string | undefined;
  /** The model that actually served the most recent proxied turn (post-downgrade), shown in the tooltip title. */
  private currentAgent: string | undefined;
  /** 5.3: the latest session (5h) / weekly (7d) rate-limit reading, straight off Anthropic's own headers. */
  private rateLimitInfo: UnifiedRateLimitSnapshot | undefined;
  private proxyError: string | undefined;
  private proxy: ProxyContext;

  /**
   * Turns currently in flight through the proxy.
   *
   * A counter rather than a boolean: an agentic client fires overlapping requests,
   * and the spinner must stay up until the last one lands, not the first.
   */
  private inFlight = 0;

  /** Needle position (1 = full scale .. 19 = rest), where it is heading, ticks left hovering, and whether it is sinking to rest. */
  private gaugePos = GAUGE_REST;
  private gaugeTarget = GAUGE_REST;
  private gaugeHold = 0;
  private gaugeReturning = false;
  private gaugeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Whether a proxied request from this window is still running. */
  get isBusy(): boolean {
    return this.inFlight > 0;
  }

  /** 3b.3: running output token count for the currently-streaming turn, or undefined between turns. */
  private streamProgressTokens: number | undefined;

  constructor(proxy: ProxyContext, menuCommand: string, private readonly version?: string) {
    this.proxy = proxy;
    // The gauge is its own item, one slot left of the text, so the text's colour
    // thresholds never tint the icon.
    this.gaugeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.gaugeItem.command = menuCommand;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = menuCommand;
    this.item.text = '$(sync~spin) Claude: loading';
    this.item.tooltip = 'Claude Budget Advisor is loading usage data.';
    this.item.show();
  }

  // --- Budget Advisor input ---

  setBudget(summary: Summary): void {
    this.budget = summary;
    this.budgetError = undefined;
    this.budgetDisabled = false;
    this.pythonMissing = false;
    this.render();
  }

  setBudgetError(message: string): void {
    this.budgetError = message;
    this.budgetDisabled = false;
    this.pythonMissing = false;
    this.render();
  }

  /** Python 3 is not installed: keep the bar alive but flag budget pacing as unavailable until it is. */
  setPythonMissing(): void {
    this.budget = undefined;
    this.budgetError = undefined;
    this.budgetDisabled = false;
    this.pythonMissing = true;
    this.render();
  }

  /** Budget pacing turned off in settings. Clears any stale figure instead of leaving it on screen. */
  setBudgetDisabled(): void {
    this.budget = undefined;
    this.budgetError = undefined;
    this.budgetDisabled = true;
    this.pythonMissing = false;
    this.render();
  }

  // --- Token Improver input ---

  setProxyContext(context: Partial<ProxyContext>): void {
    this.proxy = { ...this.proxy, ...context };
    if (context.running) {
      this.proxyError = undefined;
    }
    this.render();
  }

  /** A request has entered the proxy. Spins until the matching completion. */
  beginRequest(): void {
    // Only clear a stale count when going idle -> busy; an overlapping second
    // request must not blank out the first one's progress mid-stream.
    if (this.inFlight === 0) {
      this.streamProgressTokens = undefined;
    }
    this.inFlight += 1;
    this.startGaugeAnimation();
    this.render();
  }

  /**
   * Sweep the gauge needle right to left while a turn is in flight.
   *
   * A status bar item cannot animate a custom glyph (only `~spin` is built in), so
   * the font carries one glyph per needle position and the text is re-pointed at
   * the next frame on a timer. Only the text is rebuilt per tick; the tooltip and
   * colour do not depend on the frame.
   */
  private startGaugeAnimation(): void {
    this.gaugeReturning = false;
    if (this.gaugeTimer) {
      return;
    }
    this.gaugePos = GAUGE_REST;
    this.gaugeTarget = GAUGE_REST;
    this.gaugeHold = 0;
    this.scheduleGaugeStep();
  }

  private pickGaugeTarget(): void {
    const current = ((GAUGE_REST - this.gaugePos) / (GAUGE_FRAMES - 1)) * 100;
    // Half the time a nudge of 5-25 points, otherwise a jump anywhere on the scale.
    const pct = Math.random() < 0.5 ? current + (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 20) : Math.random() * 100;
    this.gaugeTarget = pctToPos(Math.min(100, Math.max(0, pct)));
    this.gaugeHold = Math.floor(Math.random() * 6);
  }

  private stepGauge(): void {
    if (this.gaugeReturning) {
      this.gaugePos = Math.min(GAUGE_REST, this.gaugePos + Math.max(0.6, (GAUGE_REST - this.gaugePos) * 0.12));
      return;
    }
    const distance = this.gaugeTarget - this.gaugePos;
    if (Math.abs(distance) > 0.5) {
      this.gaugePos += Math.sign(distance) * Math.max(0.6, Math.abs(distance) * 0.35);
    } else if (this.gaugeHold > 0) {
      this.gaugeHold -= 1;
      this.gaugePos = Math.min(GAUGE_REST, Math.max(1, this.gaugePos + (Math.random() - 0.5) * 1.2));
    } else {
      this.pickGaugeTarget();
    }
  }

  private scheduleGaugeStep(): void {
    this.gaugeTimer = setTimeout(() => {
      this.gaugeTimer = undefined;
      this.stepGauge();
      if (this.gaugeReturning && this.gaugePos >= GAUGE_REST) {
        this.gaugeReturning = false;
      } else {
        this.scheduleGaugeStep();
      }
      this.gaugeItem.text = this.buildGaugeText();
    }, GAUGE_TICK_MS);
    this.gaugeTimer.unref?.();
  }

  /** The turn ended: let the needle sink to rest on its own timer. */
  private releaseGauge(): void {
    if (Math.round(this.gaugePos) >= GAUGE_REST) {
      this.stopGaugeAnimation();
    } else if (this.gaugeTimer) {
      this.gaugeReturning = true;
    }
  }

  private stopGaugeAnimation(): void {
    if (this.gaugeTimer) {
      clearTimeout(this.gaugeTimer);
      this.gaugeTimer = undefined;
    }
    this.gaugeReturning = false;
    this.gaugePos = GAUGE_REST;
  }

  /** 3b.3: the running output token count for a live "↓ tokens" indicator, owner-window-local only. */
  updateStreamProgress(outputTokens: number): void {
    this.streamProgressTokens = outputTokens;
    this.render();
  }

  /**
   * Show the savings for a turn that just completed, alongside the running today
   * and month-to-date totals.
   *
   * This is the counterpart to `beginRequest`; the proxy guarantees one call here
   * per start, so the in-flight count cannot drift. Unlike the old behaviour, none
   * of this ever expires on its own — the Token Improver section always reflects
   * the most recent turn until another one replaces it.
   */
  reportTurn(lastTurn: AggregateStats, todayStats: AggregateStats, monthStats: AggregateStats, servedModel: string): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastTurn = lastTurn;
    this.todayStats = todayStats;
    this.monthStats = monthStats;
    this.currentAgent = servedModel;
    this.proxyError = undefined;
    if (this.inFlight === 0) {
      this.streamProgressTokens = undefined;
      this.releaseGauge();
    }
    this.render();
  }

  /**
   * Seed the savings windows from the persisted ledger at activation.
   *
   * Without this, a reload leaves "Last turn", "Today" and "This month" reading
   * "No Data" until the next proxied turn, even though the ledger on disk already
   * describes all three. Unlike `reportTurn` this touches neither the in-flight
   * count nor `proxyError` — nothing has completed here, it is history being
   * restored.
   */
  restoreHistory(
    lastTurn: AggregateStats | undefined,
    todayStats: AggregateStats | undefined,
    monthStats: AggregateStats | undefined,
    servedModel: string | undefined
  ): void {
    this.lastTurn = lastTurn;
    this.todayStats = todayStats;
    this.monthStats = monthStats;
    this.currentAgent = servedModel;
    this.render();
  }

  reportProxyError(message: string): void {
    this.proxyError = message;
    this.render();
  }

  /**
   * Anthropic's own reported cost.usage for today/this month, or undefined while no
   * sample has landed. `accountEmail` is whichever account those figures belong to
   * (see `RealCostTracker.currentAccountEmail`), shown in the tooltip title so it's
   * obvious which account the numbers are scoped to.
   */
  setRealCost(todayUsd: number | undefined, monthUsd: number | undefined, accountEmail?: string): void {
    this.todayRealUsd = todayUsd;
    this.monthRealUsd = monthUsd;
    this.currentAccountEmail = accountEmail;
    this.render();
  }

  /** 5.3: a fresh session/weekly rate-limit reading, straight off Anthropic's own headers. */
  setRateLimitInfo(info: UnifiedRateLimitSnapshot | undefined): void {
    this.rateLimitInfo = info;
    this.render();
  }

  // --- Rendering ---

  private render(): void {
    this.item.text = this.buildText();
    this.item.tooltip = this.buildTooltip();
    this.applyBudgetColor();
    // With a live budget the gauge icon stands alone (the figures live in its tooltip);
    // the text item stays for every state that has no gauge (loading, errors, not set).
    if (this.gaugeVisible) {
      this.item.hide();
    } else {
      this.item.show();
    }
    this.renderGauge();
  }

  /** The gauge only appears next to a live budget figure; every other state shows its own icon in the text item. */
  private get gaugeVisible(): boolean {
    return !this.budgetDisabled && !this.pythonMissing && !this.budgetError && this.budget !== undefined;
  }

  private buildGaugeText(): string {
    if (!this.gaugeTimer) {
      return this.inFlight > 0 ? `$(claude-budget-gauge-${GAUGE_REST})` : '$(claude-budget-gauge)';
    }
    return `$(claude-budget-gauge-${Math.min(GAUGE_FRAMES, Math.max(1, Math.round(this.gaugePos)))})`;
  }

  private renderGauge(): void {
    if (!this.gaugeVisible) {
      this.gaugeItem.hide();
      return;
    }
    this.gaugeItem.text = this.buildGaugeText();
    this.gaugeItem.tooltip = this.item.tooltip;
    // The glyph is a colour font (see tools/build_gauge_font.py) and keeps its own
    // colours; only the tint behind it follows the text item.
    this.gaugeItem.backgroundColor = this.item.backgroundColor;
    this.gaugeItem.show();
  }

  private buildText(): string {
    const segments: string[] = [];
    const busy = this.inFlight > 0;

    // Whether the leading icon is already showing the spinner. When it is, the
    // improver segment must not add a second one.
    let leadingSpins = false;

    if (this.budgetDisabled) {
      segments.push('Budget: Not set');
    } else if (this.pythonMissing) {
      segments.push('$(warning) Python required');
    } else if (this.budgetError) {
      // The error icon is more important than the activity hint; keep it.
      segments.push('$(warning) Unavailable');
    } else if (this.budget) {
      // The gauge (its own item, see `renderGauge`) carries live state: the needle
      // oscillates while a turn is in flight, so no spinner is needed here.
      segments.push(this.formatStatusText(this.budget));
      leadingSpins = busy;
    } else {
      segments.push('$(sync~spin) Claude: loading');
      leadingSpins = true;
    }

    if (busy) {
      if (!leadingSpins) {
        // Leading slot could not carry the spinner, so the improver segment does.
        segments.push('$(sync~spin)');
      }
    } else if (this.proxyError) {
      segments.push('$(warning)');
    }
    // Idle with a completed last turn: no segment here anymore — the same
    // per-turn savings % is already the top row of the tooltip's Improver table,
    // so the status bar text doesn't need to repeat it.

    return segments.join(' · ');
  }

  /**
   * The compact `NN.NN% $(icon)` segment. For Pro/Max/Team (`percent` mode) the
   * percentage comes off claude.ai's own Session/Weekly rate-limit headers
   * (`resolveStatusPercent`), not the dollar-weighted `percent_used` estimate —
   * that estimate isn't a real figure for a plan with no $ or token budget of its
   * own, and this is the one place the status bar previously showed it anyway.
   */
  private formatStatusText(summary: Summary): string {
    const totalUsage = Number(summary['total_tokens_used'] ?? 0);
    if (!Number.isFinite(totalUsage)) {
      return 'Budget Unavailable';
    }
    const plan = extractPlanInfo(summary);
    if (usesMonthUsageView(plan, summary)) {
      const month = this.monthStats;
      return month ? `${compact(month.rawTokens)}/${compact(billedUnits(month))}` : 'No data';
    }
    const mode = planViewMode(plan);
    const percentUsed = resolveStatusPercent(mode, summary, this.rateLimitInfo);
    const status = mode === 'percent' ? statusFromPercent(percentUsed) : String(summary['status'] ?? 'on_track');
    return renderEmbeddedProgressBar(percentUsed, statusToIcon(status));
  }

  /** Budget thresholds own the colour; the improver never overrides them. */
  private applyBudgetColor(): void {
    if (this.pythonMissing) {
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    if (this.budgetError) {
      this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      this.item.backgroundColor = undefined;
      return;
    }

    // No real limit to measure against: a colour here would warn about an invented cap.
    if (this.budget && usesMonthUsageView(extractPlanInfo(this.budget), this.budget)) {
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      return;
    }

    const mode = this.budget ? planViewMode(extractPlanInfo(this.budget)) : 'unknown';
    const percentUsed = this.budget ? resolveStatusPercent(mode, this.budget, this.rateLimitInfo) : 0;

    if (this.budget && percentUsed > 80) {
      this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (this.budget && percentUsed >= 51) {
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
    }
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    this.appendBudgetSection(md);
    md.appendMarkdown('\nClick for dashboards (savings breakdown is in the Token Improver tab).');
    return md;
  }

  private appendBudgetSection(md: vscode.MarkdownString): void {
    // 5.2: which $-or-% view this plan actually supports, read from Python's
    // detect_plan(). Pro/Max/Team have no $ source and fall back to claude.ai's own
    // session/weekly % (5.3, not yet built) — tokens remain the safe default there.
    const plan = this.budget ? extractPlanInfo(this.budget) : undefined;
    const planSuffix = plan ? ` (${planLabel(plan)})` : '';
    md.appendMarkdown(`### Claude Budget Advisor${this.version ? ` v${this.version}` : ''}\n\n`);
    if (this.currentAccountEmail) {
      md.appendMarkdown(`Account: ${this.currentAccountEmail}${planSuffix}\n\n`);
    }
    if (this.currentAgent) {
      md.appendMarkdown(`Agent: ${this.currentAgent}\n\n`);
    }

    if (this.budgetDisabled) {
      md.appendMarkdown('**Not set.** Budget pacing is turned off (`claudeBudgetAdvisor.enabled`) until a real spend-limit source is on file.\n\n');
      return;
    }
    if (this.pythonMissing) {
      md.appendMarkdown(
        '$(warning) **Python 3.8 or newer is required** for budget pacing and was not found on this machine. ' +
          'Install it from https://www.python.org/downloads/ — the budget starts working by itself at the next refresh. ' +
          'The Token Improver proxy is not affected.\n\n'
      );
      return;
    }
    if (this.budgetError) {
      md.appendMarkdown(`$(warning) ${this.budgetError}\n\n`);
      return;
    }
    if (!this.budget) {
      md.appendMarkdown('Loading usage data.\n\n');
      return;
    }

    const summary = this.budget;
    const percentUsed = Number(summary['percent_used'] ?? 0);
    const status = String(summary['status'] ?? 'on_track');
    const paceStatus = String(summary['pace_status'] ?? 'on_track');
    const mode = planViewMode(plan);

    md.appendMarkdown('| Budget | |\n| --- | --- |\n');

    if (mode === 'dollar' && usesMonthUsageView(plan, summary)) {
      // No account spend limit on file, so no % — show what this month actually moved.
      const month = this.monthStats;
      if (month) {
        const billed = billedUnits(month);
        const reduction = month.rawTokens > 0 ? ((month.rawTokens - billed) / month.rawTokens) * 100 : 0;
        md.appendMarkdown(`| Raw request | ${compact(month.rawTokens)} tokens |\n`);
        md.appendMarkdown(`| Billed input | ${compact(billed)} units |\n`);
        md.appendMarkdown(`| Reduction | ${reduction.toFixed(1)}% |\n`);
      } else {
        md.appendMarkdown('| Usage | No data yet |\n');
      }
      // No spend limit can be read without an admin key (docs: latest/admin-key.md), so nothing
      // dollar-denominated is shown here: tokens and billed units only.
      md.appendMarkdown(
        '\n_Raw request is what the client would have sent; Billed input is what Anthropic charged after cleanup, compression and caching (each cache kind at its own rate). No account spend limit on file, so there is no % used._\n\n'
      );
    } else if (mode === 'dollar') {
      // 3.5: real $ figures for Enterprise/API. Prefers the authoritative spend-limit
      // API/file result when one is configured, falls back to this tool's own
      // weighted-cost estimate otherwise (see resolveDollarBudget's own doc comment).
      const dollarBudget = resolveDollarBudget(summary);
      const todayUsedUsd = Number(summary['today_weighted_cost'] ?? 0);
      const dailyTargetUsd = Number(summary['daily_target_usd'] ?? 0);
      const limitLabel = dollarBudget.limitUsd !== undefined ? ` of ${formatUsd(dollarBudget.limitUsd)}` : '';

      md.appendMarkdown(
        `| Consumed | ${formatUsd(dollarBudget.usedUsd)}${limitLabel} — ${percentUsed.toFixed(2)}% — **${statusLabel(status)}** |\n`
      );
      md.appendMarkdown(`| | ${progressBarText(percentUsed)} |\n`);
      md.appendMarkdown(
        `| Today's pace | ${formatUsd(todayUsedUsd)} of ${formatUsd(dailyTargetUsd)} — ${paceLabel(paceStatus)} |\n\n`
      );
      if (dollarBudget.source === 'estimated' && dollarBudget.limitUsd === undefined) {
        md.appendMarkdown("_No account spend limit on file — $ figures are this tool's own usage estimate._\n\n");
      }
    } else if (mode === 'percent') {
      // 5.3: this plan has no $ or local-token ground truth at all (Pro/Max/Team) —
      // the only real number is Anthropic's own `anthropic-ratelimit-unified-*`
      // headers (5.1), read off a Messages response that went through the proxy.
      // Never falls back to this tool's own token estimate here: an inferred number
      // presented next to "Session"/"Weekly" would look like it's the same kind of
      // fact, when it measures something else entirely (a $-derived monthly guess,
      // not Anthropic's 5h/7d rate-limit window) — "No data yet" is more honest.
      const fiveHour = this.rateLimitInfo?.fiveHour;
      const sevenDay = this.rateLimitInfo?.sevenDay;
      md.appendMarkdown(`| Session | ${fiveHour ? formatRateLimitWindow(fiveHour, false) : 'No data yet'} |\n`);
      if (fiveHour) {
        md.appendMarkdown(`| | ${progressBarText(fiveHour.utilization * 100)} |\n`);
      }
      md.appendMarkdown(`| Weekly | ${sevenDay ? formatRateLimitWindow(sevenDay, true) : 'No data yet'} |\n`);
      if (sevenDay) {
        md.appendMarkdown(`| | ${progressBarText(sevenDay.utilization * 100)} |\n`);
      }
      md.appendMarkdown('\n');

      const sevenDayForecast = paceForecast(sevenDay, 'sevenDay');
      if (sevenDayForecast) {
        md.appendMarkdown(`${paceForecastIcon(sevenDayForecast.status)} **Weekly:** ${sevenDayForecast.message}\n\n`);
      }
      const fiveHourForecast = paceForecast(fiveHour, 'fiveHour');
      if (fiveHourForecast) {
        md.appendMarkdown(`${paceForecastIcon(fiveHourForecast.status)} **Session:** ${fiveHourForecast.message}\n\n`);
      }

      if (!fiveHour && !sevenDay) {
        md.appendMarkdown(
          '_Waiting for a request to go through the Token Improver proxy this session — that\'s the only way these headers reach this tool._\n\n'
        );
      }
    } else {
      const totalUsage = Number(summary['total_tokens_used'] ?? 0);
      const budgetTokens = Number(summary['budget_tokens'] ?? 0);
      const todayTokens = Number(summary['today_tokens'] ?? 0);
      const dailyPace = Number(summary['recommended_daily_tokens'] ?? 0);

      md.appendMarkdown(`| Consumed | ${percentUsed.toFixed(2)}% — **${statusLabel(status)}** |\n`);
      md.appendMarkdown(`| | ${progressBarText(percentUsed)} |\n`);
      md.appendMarkdown(`| Total | ${compact(totalUsage)} of ${compact(budgetTokens)} tokens |\n`);
      md.appendMarkdown(`| Today's pace | ${compact(todayTokens)} of ${compact(dailyPace)} tokens — ${paceLabel(paceStatus)} |\n\n`);
    }
  }

  dispose(): void {
    this.stopGaugeAnimation();
    this.item.dispose();
    this.gaugeItem.dispose();
  }
}
