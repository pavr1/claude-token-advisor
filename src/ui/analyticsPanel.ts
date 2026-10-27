/**
 * The Token Improver Analytics tab's content: reads the persistent ledger and
 * renders aggregate token/financial savings, with in-panel date and repo filters
 * (local days). Embedded (not a standalone document) inside the merged
 * `DashboardPanel` (`./dashboardPanel.ts`), which owns the webview, the nonce, and
 * the filter/tab postMessage wiring.
 */

import * as vscode from 'vscode';
import {
  aggregate,
  AggregateStats,
  AnalyticsTracker,
  dayKey,
  localDayKey,
  localMonthKey,
  groupBy,
  groupTurns,
  lastTurnEntries,
  TurnGroup,
  LedgerEntry,
  monthKey,
  unitsToUsd,
} from '../analytics/tracker';
import { RealCostTracker } from '../analytics/realCostTracker';
import { InFlightProject, inFlightRequests } from '../analytics/inflight';
import { RANGE_LABELS, RangeId, resolveRange } from './dateRange';
import { ARROW_CELL, haikuSummaryCell, liveHitRows, liveRow, PROCESSING, pendingTotals, savingsTone, SummaryUse, timeCell } from './liveTurnRow';
import { CLIENT_PREFIX_REUSE, isFailedHit, sentTokens } from '../analytics/tracker';
import { historyChartsHtml } from './historyChart';
import { PlanInfo, planLabel, planViewMode } from './planView';
import { DEFAULT_OPTIMIZER_CONFIG } from '../proxy/optimizer';
import { getPricingTable } from '../proxy/pricing';
import {
  barRow,
  CATEGORICAL_PALETTE,
  COLORS,
  compact,
  donutChart,
  miniDonut,
  escapeHtml,
  formatPercent,
  formatShare,
  formatUsd,
  helpIcon,
} from './shared';

export const ALL = '__all__';

/** Quiet time after a turn's last hit before it is considered finished and added to the period table. */
export const TURN_SETTLE_MS = 2000;

export interface AnalyticsFilters {
  project: string;
  range: RangeId;
  from?: string;
  to?: string;
}

/** Start of the current local day (epoch ms), matching `dayKey`'s local-time bucket. */
function localDayStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** UTC month bounds (epoch ms) for a `YYYY-MM` key, matching `monthKey`'s own UTC-sliced ISO timestamp. */
function monthBoundsUtc(month: string): { start: number; end: number } {
  const [year, mon] = month.split('-').map(Number);
  const start = Date.UTC(year, mon - 1, 1);
  const end = mon === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, mon, 1);
  return { start, end };
}

/** The Token Improver tab's inner body markup — no document wrapper, no `<script>` tag (the host panel owns those). */
export function buildAnalyticsSectionHtml(
  tracker: AnalyticsTracker,
  filters: AnalyticsFilters,
  realCostTracker?: RealCostTracker,
  plan?: PlanInfo
): string {
  const all = tracker.getEntries();
  if (!all.length) {
    return buildEmptyState();
  }

  const months = [...new Set(all.map(monthKey))].sort().reverse();

  // Everything below the title follows the Date and Repo filters. A repo with no entries in the
  // range would render an empty panel with no hint why, so fall back to all repos.
  const range = resolveRange(filters);
  const inRange = all.filter((entry) => {
    const at = Date.parse(entry.timestamp);
    return at >= range.start && at < range.end;
  });
  const projects = [...new Set(inRange.map((entry) => entry.project))].sort();
  const projectExists = filters.project === ALL || projects.includes(filters.project);
  const effectiveProject = projectExists ? filters.project : ALL;
  const entries = effectiveProject === ALL ? inRange : inRange.filter((entry) => entry.project === effectiveProject);

  const stats = aggregate(entries);

  return buildReport(entries, stats, months, projects, effectiveProject, all, realCostTracker, plan, filters);
}

function buildEmptyState(): string {
  return `
  <h1>Claude Token Improver</h1>
  <div class="subtitle">No optimized requests recorded yet.</div>
  <div class="alert info">
    Start the proxy, then point your Claude client at it with
    <code>ANTHROPIC_BASE_URL=http://127.0.0.1:4000</code>.
    Every turn that flows through the proxy is recorded here.
  </div>`;
}

function buildReport(
  entries: readonly LedgerEntry[],
  stats: AggregateStats,
  months: string[],
  projects: string[],
  effectiveProject: string,
  all: readonly LedgerEntry[],
  realCostTracker: RealCostTracker | undefined,
  plan: PlanInfo | undefined,
  filters: AnalyticsFilters
): string {
  const pricing = getPricingTable();
  // Pro/Max/Team pay a flat subscription, so per-token dollars are what the same
  // usage would cost on the API, not what was billed.
  const subscriptionPlan = planViewMode(plan) !== 'dollar';
  const baselineSub = 'normalized cost units (input-token equivalents), unoptimized vs actual';
  const percentPlan = planViewMode(plan) === 'percent';
  // Headline = the floor: what the proxy saved against a client with the best possible cache (one hour, no misses).
  // Rows from before the floor existed have no such baseline, so until a row carries one the
  // headline falls back to the modelled estimate and says so.
  const hasFloor = stats.floorTurns > 0;
  const savingLabel = hasFloor ? 'Saving, at least' : 'Estimated saving';
  const headBaseline = hasFloor ? stats.floorBaselineUnitCost : stats.baselineUnitCost;
  const headActual = hasFloor ? stats.floorActualUnitCost : stats.actualUnitCost;
  const savedNcu = headBaseline - headActual;
  const savingsPercent = hasFloor ? stats.floorSavingsPercent : stats.savingsPercent;
  const typicalNote = `Typical case: a client reusing ${(CLIENT_PREFIX_REUSE * 100).toFixed(0)}% of its prompt from cache.`;
  const savingsPrefix = hasFloor ? 'at least ' : 'est. ';
  const savingsNote = hasFloor
    ? `Worst case: vs. a client with the best possible cache. The real saving can be higher.`
    : 'Estimate vs. what Claude would have used without the proxy.';

  // The selected range can be a single day with few turns: a compaction turn pays the whole summary
  // up front while its saving lands over the following turns, so it swings. The month averages that
  // out and is the steadier figure, which is why it sits beside the filtered one.
  const monthKeyNow = localMonthKey(new Date());
  // The monthly donut is the fixed reference: this month, every repo, whatever the filters say.
  const monthEntries = all.filter((entry) => monthKey(entry) === monthKeyNow);
  const monthView = savingView(aggregate(monthEntries));
  const dayView = savingView(stats);
  // The at-least figure needs per-turn data that older rows never recorded, so until the month is
  // covered it measures only the turns that carry it, and says so instead of looking like a full month.
  const monthAgg = aggregate(monthEntries);
  const partialMonth = monthAgg.floorTurns > 0 && monthAgg.floorTurns < monthAgg.turns;
  const rangeLabel = filters.range === 'custom' ? `${filters.from ?? ''} → ${filters.to ?? filters.from ?? ''}` : RANGE_LABELS[filters.range].replace('…', '');
  const scopeLabel = effectiveProject === ALL ? 'all repos' : effectiveProject;
  // A small ring with the figure beneath it, so the head stays about as tall as the title and subtitle.
  const savedDonut = (view: { percent: number; mark: string } | undefined): string =>
    view
      ? `${miniDonut(Math.max(0, view.percent), savingsTone(view.percent), 'saved')}<div class="donut-figure" style="color:${savingsTone(view.percent)}">${escapeHtml(view.mark + formatPercent(view.percent))}</div>`
      : `${miniDonut(0, 'var(--vscode-badge-background, #555)', 'no requests')}<div class="donut-figure">—</div>`;
  const rangeDonut = savedDonut(stats.turns > 0 ? dayView : undefined);
  const monthDonut = savedDonut(monthAgg.turns > 0 ? monthView : undefined);

  return `
  <div class="head">
    <div>
      <h1>Claude Token Improver</h1>
      <div class="subtitle">${stats.turns.toLocaleString()} optimized requests · Normalized Cost Units, Sonnet input = 1.0 · pricing source: ${pricing.source}</div>
    </div>
    <div class="donut-row">
      <div class="donut-block" title="${escapeHtml(hasFloor ? 'Saving, at least: worst case vs. the best client cache. Short ranges can swing.' : 'Estimated saving. Short ranges can swing.')}">
        ${rangeDonut}
        <div class="donut-title">${escapeHtml(rangeLabel)} · ${escapeHtml(scopeLabel)}</div>
      </div>
      <div class="donut-block" title="${escapeHtml(partialMonth ? `This month, all repos. Only ${monthAgg.floorTurns.toLocaleString()} of ${monthAgg.turns.toLocaleString()} turns carry the data for the worst-case figure.` : 'This month, all repos: the steadier figure.')}">
        ${monthDonut}
        <div class="donut-title">This month · all repos</div>
      </div>
    </div>
  </div>

  ${lastTurnsTable(all, filters, inFlightRequests.snapshot())}
  <hr style="border:0;border-top:1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));margin:16px 0">

  ${historyChartsHtml(
    effectiveProject === ALL ? all : all.filter((entry) => entry.project === effectiveProject),
    resolveRange(filters)
  )}

  ${
    stats.turns > 0 && savedNcu < 0
      ? `<div class="stat-sub" style="border-left:3px solid ${savingsTone(savedNcu)};padding:6px 10px;margin:8px 0">The proxy cost ${compact(-savedNcu)} ${UNITS_ABBR} more than the baseline in this range. Cache writes were ${compact(stats.cacheWriteUnits)} ${UNITS_ABBR}. A short range or a cold cache can do this; the month view is the steadier figure.</div>`
      : ''
  }
  <div class="top">
    <div class="stats">
      <div>
        <div class="stat-label">${savingLabel}</div>
        <div class="stat-value" style="color:${savingsTone(savedNcu)}">${compact(savedNcu)} ${UNITS_ABBR}</div>
        <div class="stat-sub" title="${escapeHtml(savingsNote)}">${hasFloor ? 'worst case, vs. the best possible client cache' : 'avoided vs. baseline'}</div>
        ${
          hasFloor
            ? `<div class="stat-sub" style="color:${savingsTone(stats.centralSavingsPercent)}" title="${escapeHtml(typicalNote)}">typical ~${formatPercent(stats.centralSavingsPercent)} vs. a client reusing ${(CLIENT_PREFIX_REUSE * 100).toFixed(0)}% of its cache</div>`
            : ''
        }
        <div class="stat-sub" title="${escapeHtml(baselineSub)}">${compact(headBaseline)} → ${compact(headActual)} ${UNITS_ABBR}</div>
      </div>
      <div>
        <div class="stat-label">Cache</div>
        <div class="stat-value" style="color:${COLORS.info}">${stats.cacheHitTurns} / ${stats.turns} requests read it</div>
        <div class="stat-sub">${compact(stats.cacheReadTokens)} ${TOKENS_ABBR} read at ${effectiveRate(stats.cacheReadUnits, stats.cacheReadTokens)}× = ${compact(stats.cacheReadUnits)} ${UNITS_ABBR}${stats.unpriced.read.length > 0 ? ` <span title="${escapeHtml(unpricedNote(stats.unpriced.read))}">⚠ rate not found</span>` : ''}</div>
        <div class="stat-sub">${compact(stats.cacheWriteTokens)} ${TOKENS_ABBR} written at ${effectiveRate(stats.cacheWriteUnits, stats.cacheWriteTokens)}× = ${compact(stats.cacheWriteUnits)} ${UNITS_ABBR}${stats.unpriced.write.length > 0 ? ` <span title="${escapeHtml(unpricedNote(stats.unpriced.write))}">⚠ rate not found</span>` : ''}</div>
        <div class="stat-sub" title="Cache reads and writes together, against paying the plain input price for the same tokens.">net vs. no cache: ${compact(stats.cacheNoCacheUnitCost - stats.cacheActualUnitCost)} ${UNITS_ABBR}</div>
      </div>
      <div>
        <div class="stat-label">Pruning &amp; compaction</div>
        <div class="stat-value">${compact(stats.prunedByNormalization + stats.prunedByCompaction)} ${TOKENS_ABBR} pruned</div>
        <div class="stat-sub">${compact(stats.prunedByNormalization)} normalization · ${compact(stats.prunedByCompaction)} compaction</div>
        <div class="stat-sub">${stats.compactions.toLocaleString()} compactions · ${stats.turns ? ((stats.compactions / stats.turns) * 100).toFixed(2) : '0'}% of requests${
          stats.compactions === 0 && skipReasonCounts(entries)[0]
            ? ` · mostly skipped: ${escapeHtml(skipReasonCounts(entries)[0].reason)}`
            : ''
        }</div>
      </div>
      <div>
        <div class="stat-label">Model downgrades</div>
        <div class="stat-value">${stats.modelSwaps.toLocaleString()}</div>
        <div class="stat-sub">${stats.turns ? ((stats.modelSwaps / stats.turns) * 100).toFixed(2) : '0'}% of requests routed to Haiku</div>
      </div>
    </div>
  </div>

  <h2>Chat compaction</h2>
  ${compactionSection(entries)}

  <h2>Savings by project <span class="stat-sub">${escapeHtml(rangeLabel)} · local time</span></h2>
  ${breakdownSection(entries, (entry) => entry.project, 'No project data for this selection.')}

  <h2>Savings by requested model</h2>
  ${breakdownSection(entries, (entry) => entry.requestedModel, 'No model data for this selection.')}

  <h2>Recent requests</h2>
  ${recentTable(entries)}`;
}

/**
 * "Last turns" table: the history of user turns in the selected range (local days), one row
 * per prompt, newest first, every project mixed unless the Project filter narrows it. The
 * columns follow a request's life: what the machine does to it (raw → cleanup → compression
 * → sent), the handoff to Anthropic, and what comes back (total received split by cache
 * kind, then billed units).
 *
 * A project handles one turn at a time, so whatever it has in flight is a hit of its
 * newest turn: that row is "in progress". A request that opens a new prompt has no ledger
 * row yet, so it gets a "started" row on top until its first hit lands.
 */
function lastTurnsTable(all: readonly LedgerEntry[], filters: AnalyticsFilters, inFlight: ReadonlyMap<string, InFlightProject>): string {
  const range = resolveRange(filters);
  const inRange = all.filter((entry) => {
    const at = Date.parse(entry.timestamp);
    return at >= range.start && at < range.end;
  });
  const projects = [...new Set(inRange.map((entry) => entry.project))].sort();
  const project = filters.project === ALL || projects.includes(filters.project) ? filters.project : ALL;
  const groups = groupTurns(inRange).filter((group) => project === ALL || group.project === project);
  // In-flight requests belong to now, so they only show when the range reaches today.
  const live = new Map(range.includesNow ? [...inFlight].filter(([name]) => project === ALL || name === project) : []);
  // Other ranges number their turns under their own prefix so an expanded turn of one range
  // is not mistaken for the same-numbered turn of another.
  const prefix = filters.range === 'today' ? '' : `${filters.range}${filters.range === 'custom' ? `${filters.from}${filters.to}` : ''}:`;
  // Every row shows its date and time, whatever range is selected.
  const withDate = true;

  const newestOf = new Map<string, TurnGroup>();
  for (const group of groups) {
    newestOf.set(group.project, group);
  }

  // Turn number within its project: a live new-turn row and the row it becomes share one,
  // so the client can tell which cells changed instead of treating the swap as a new row.
  const ordinals = new Map<TurnGroup, string>();
  const perProject = new Map<string, number>();
  for (const group of groups) {
    const n = (perProject.get(group.project) ?? 0) + 1;
    perProject.set(group.project, n);
    ordinals.set(group, `${prefix}${n}`);
  }

  const started = [...live]
    .filter(([, state]) => state.newTurn)
    .sort(([, a], [, b]) => b.since - a.since)
    .map(([name, state]) => liveRow(name, state, `${prefix}${(perProject.get(name) ?? 0) + 1}`));

  const done = [...groups].reverse().map((group) => {
    const state = live.get(group.project);
    const isLive = state !== undefined && !state.newTurn && newestOf.get(group.project) === group;
    return turnRow(group, isLive ? state : undefined, ordinals.get(group) ?? '0', withDate);
  });

  const rangeOptions = (Object.keys(RANGE_LABELS) as RangeId[])
    .map((id) => `<option value="${id}"${filters.range === id ? ' selected' : ''}>${RANGE_LABELS[id]}</option>`)
    .join('');
  const projectOptions = [
    `<option value="${ALL}"${project === ALL ? ' selected' : ''}>All repos</option>`,
    ...projects.map((name) => `<option value="${escapeHtml(name)}"${project === name ? ' selected' : ''}>${escapeHtml(name)}</option>`),
  ].join('');
  const todayKey = localDayKey(new Date());
  const custom =
    filters.range === 'custom'
      ? `<div class="range-custom">From <input type="date" id="from" value="${escapeHtml(filters.from ?? todayKey)}"> to <input type="date" id="to" value="${escapeHtml(filters.to ?? filters.from ?? todayKey)}"></div>`
      : '';
  const body = [...started, ...done].join('');
  // The totals follow the table: they add up exactly the rows the filters leave in, and sit under
  // the column labels (both sticky) so they stay in view while the turns scroll.
  const shown = groups.flatMap((group) => group.entries);
  // In-flight hits count too, exactly as the rows add them, so any cell that moves moves the total.
  const pend = [...live.values()].map((state) => pendingTotals(state));
  const sum = (pick: (t: ReturnType<typeof pendingTotals>) => number): number => pend.reduce((n, t) => n + pick(t), 0);
  const liveHits = [...live.values()].reduce((n, state) => n + state.count, 0);
  const liveTurns = [...live.values()].filter((state) => state.newTurn).length;
  const totals = shown.length || live.size
    ? (() => {
        const s = aggregate(shown);
        return `<tr class="totals"><td colspan="3"></td><td class="num">${(groups.length + liveTurns).toLocaleString()}</td><td class="num">${(s.turns + liveHits).toLocaleString()}</td>${flowCells(s, { rawTokens: s.rawTokens + sum((t) => t.raw), prunedNorm: s.prunedByNormalization + sum((t) => t.pruned), comp: compressionOf(shown), reused: reusedOf(shown), skipped: skippedOf(shown), sent: s.optimizedTokens + sum((t) => t.sent) })}</tr>`;
      })()
    : '';
  const title = filters.range === 'today' ? 'Turns' : `Turns · ${RANGE_LABELS[filters.range].replace('…', '')}`;
  return `<h2>${title}</h2>
  ${custom}
  <div class="turns-scroll turns-main"><table class="turns-table">
    <colgroup><col style="width:13%"><col style="width:10%"><col style="width:4%"><col style="width:5%"><col style="width:5%"><col style="width:8%"><col style="width:7%"><col style="width:8%"><col style="width:6%"><col style="width:6.5%"><col style="width:8%"><col style="width:6.5%"><col style="width:6.5%"><col style="width:6.5%"><col style="width:9%"></colgroup>
    <thead><tr>
      <th class="filter-th">${withDate ? 'Date' : 'Time'}<select id="range" title="Filter by date">${rangeOptions}</select></th><th class="filter-th">Repo<select id="project" title="Filter by repo">${projectOptions}</select></th><th>Status</th><th class="num">Turns</th><th class="num">Hits${HEADER_HELP.hits}</th><th class="num">Raw request${HEADER_HELP.raw}</th><th class="num">Cleanup${HEADER_HELP.cleanup}</th><th class="num">Summarized${HEADER_HELP.haiku}</th>
      <th class="num">Estimate${HEADER_HELP.estimate}</th><th></th><th class="num">Received${HEADER_HELP.received}</th><th class="cache-col">CR${HEADER_HELP.cr}</th><th class="cache-col">CW${HEADER_HELP.cw}</th><th class="cache-col">RI${HEADER_HELP.ri}</th><th class="num">Billed${HEADER_HELP.billed}</th>
    </tr>${totals}</thead>
    <tbody>${body || '<tr><td colspan="15" class="empty">No optimized turns in this selection.</td></tr>'}</tbody>
  </table></div>`;
}

/** Cleanup-stage size and tokens removed by hits that created a new summary; reuse hits count as 0. */
/** Short unit labels for table cells; hovering the letter shows the full word. */
const UNITS_ABBR = '<abbr title="units">u</abbr>';
const TOKENS_ABBR = '<abbr title="tokens">t</abbr>';

function compressionOf(entries: readonly LedgerEntry[]): SummaryUse {
  const created = entries.filter((entry) => entry.compactionTriggered);
  return {
    hits: created.length,
    haikuUnits: created.reduce((sum, e) => sum + (e.summarizerUnitCost ?? 0), 0),
    before: created.reduce((sum, e) => sum + e.rawTokens - e.prunedByNormalization, 0),
    pruned: created.reduce((sum, e) => sum + e.prunedByCompaction, 0),
  };
}

/** Hits that reused an already written summary: same before → after, no Haiku call. */
function reusedOf(entries: readonly LedgerEntry[]): SummaryUse {
  const reused = entries.filter((entry) => entry.summaryReused === true && !entry.compactionTriggered);
  return {
    hits: reused.length,
    haikuUnits: 0,
    before: reused.reduce((sum, e) => sum + e.rawTokens - e.prunedByNormalization, 0),
    pruned: reused.reduce((sum, e) => sum + e.prunedByCompaction, 0),
  };
}

/** Why the hits that got no summary were skipped, as the proxy recorded it; a reason seen on several hits carries its count. */
function skippedOf(entries: readonly LedgerEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.compactionTriggered && entry.summaryReused !== true && entry.compactionSkippedReason) {
      counts.set(entry.compactionSkippedReason, (counts.get(entry.compactionSkippedReason) ?? 0) + 1);
    }
  }
  const parts = [...counts].map(([reason, n]) => (n > 1 ? `${reason} (×${n})` : reason));
  return parts.length > 0 ? parts.join('; ') : undefined;
}

const HEADER_HELP = {
  hits: helpIcon('Requests Claude Code sent to Anthropic; one prompt can make several (tool use).'),
  raw: helpIcon('The request as Claude Code sent it. Raw − Cleanup − Summarized = Sent.'),
  cleanup: helpIcon('Tokens removed without changing the meaning (whitespace, filler). Applies to every hit.'),
  haiku: helpIcon('✓ new summary written · ↻ stored one reused · · none. Only when the 5-minute cache is cold.'),
  estimate: helpIcon('What the proxy sent after cleanup and summary, counted locally. Received is the real figure.'),
  received: helpIcon('Tokens Anthropic processed: RI + CW + CR, from the API response.'),
  cr: helpIcon('Cache read: tokens served from cache. Top row t = tokens, bottom row u = units.'),
  cw: helpIcon('Cache write: tokens stored in cache, billed above input. Top row t = tokens, bottom row u = units.'),
  ri: helpIcon('Regular input: tokens sent without caching. Top row t = tokens, bottom row u = units.'),
  billed: helpIcon('What Anthropic charged, in units: input, cache, output and summary. Hover for the breakdown.'),
};

/**
 * The Raw request → Cleanup → Summarized → Sent → Received → Cached → Billed cells,
 * shared by the "Last turns" rows and the period totals so both read the same way.
 * `flow` carries the pre-flight figures (they include hits still in flight); received and
 * billed come from the completed hits in `s`.
 */
/**
 * What each token of a kind actually billed at: its units over its tokens. It folds in the served
 * model's weight and the 1h write rate, so it is what was charged, not a published constant.
 */
function unpricedNote(models: readonly string[]): string {
  return models.length > 0 ? `⚠ No rate for ${models.join(', ')}: counted in t, adds no u.` : '';
}

function effectiveRate(units: number, tokens: number): string {
  return tokens > 0 ? String(Number((units / tokens).toPrecision(3))) : '—';
}

function flowCells(
  s: AggregateStats,
  flow: { rawTokens: number; prunedNorm: number; comp: SummaryUse; reused: SummaryUse; sent: number; skipped?: string }
): string {
  const afterCleanup = flow.rawTokens - flow.prunedNorm;
  // Billed is the ledger's own invoice figure (input, output and the Haiku summary), and the
  // saving is measured against what the same turn would have billed without the proxy.
  const billed = s.actualUnitCost;
  const readUnits = s.cacheReadUnits;
  const writeUnits = s.cacheWriteUnits;
  const uncachedUnits = s.regularInputUnits;
  const outputUnits = s.outputUnits;
  // Short on purpose: the rate behind each part is in the Cached cell's own tooltips.
  const billedTooltip =
    `CR ${compact(readUnits)} + CW ${compact(writeUnits)} + RI ${compact(uncachedUnits)} + output ${compact(outputUnits)}` +
    (s.summarizerUnitCost > 0 ? ` + Haiku summary ${compact(s.summarizerUnitCost)}` : '') +
    ` = ${compact(billed)} u`;

  const step = (value: number, pruned: number, base: number): string =>
    `<td class="num">${compact(value)}<div class="turn-sub" style="color:${savingsTone(pruned)}">−${compact(pruned)} (${formatShare(pruned, base)})</div></td>`;
  // Short labels so no figure gets clipped; the full name and meaning live in the tooltip.
  // The cell shows each kind's billed units; tokens and their share of the received total live in the tooltip.
  // A hit can mix kinds, so the hit counts need not add up to the total.
  const received = sentTokens(s);
  const share = (tokens: number): string => (received > 0 ? `${((tokens / received) * 100).toFixed(1)}%` : '—');
  // One column per kind, centred, each with its tokens on the top row and its billed units below.
  // A row is tinted on its own basis: tokens say whether the cache worked (was the prefix reused?),
  // units say what it cost (a written token is 12.5x a read one), so the two can disagree.
  const tokensBalance = cacheBalanceStyle(s.cacheReadTokens, s.cacheWriteTokens, 't');
  const unitsBalance = cacheBalanceStyle(readUnits, writeUnits, 'u');
  const cacheCell = (abbr: string, tokens: number, units: number, unpriced: readonly string[] = []): string => {
    const rate = effectiveRate(units, tokens);
    const tokensTitle = `${abbr}: ${compact(tokens)} t, ${share(tokens)} of Received. ${tokensBalance.note}`.trim();
    const unitsTitle = `${abbr}: ${compact(tokens)} t × ${rate} = ${compact(units)} u. ${unpricedNote(unpriced)} ${unitsBalance.note}`.replace(/\s+/g, ' ').trim();
    return `<td class="cache-col"><div class="cache-val"${tokensBalance.style} title="${escapeHtml(tokensTitle)}">${compact(tokens)} ${TOKENS_ABBR}</div><div class="cache-val"${unitsBalance.style} title="${escapeHtml(unitsTitle)}">${compact(units)} ${UNITS_ABBR}</div></td>`;
  };
  const receivedTitle = 'RI + CW + CR, as Anthropic reported it';

  return `<td class="num">${compact(flow.rawTokens)}</td>
    ${step(afterCleanup, flow.prunedNorm, flow.rawTokens)}
    ${haikuSummaryCell(flow.comp, flow.reused, flow.skipped)}
    <td class="num">${compact(flow.sent)}</td>
    ${ARROW_CELL}
    <td class="num" title="${receivedTitle}">${compact(received)}</td>
    ${cacheCell('CR', s.cacheReadTokens, readUnits, s.unpriced.read)}${cacheCell('CW', s.cacheWriteTokens, writeUnits, s.unpriced.write)}${cacheCell('RI', s.uncachedInputTokens, uncachedUnits)}
    <td class="num" title="${escapeHtml(billedTooltip)}">${compact(billed)} ${UNITS_ABBR}</td>`;
}

/**
 * Light red when the cache was written more than read, light green when read more than written, on
 * the given basis. The tokens row measures whether the cache worked (was the prefix reused?); the
 * units row measures what it cost, where a written token is 12.5x a read one. The two can disagree:
 * a healthy turn with a large new prefix is green in tokens and red in units.
 */
function cacheBalanceStyle(reads: number, writes: number, basis: string): { style: string; note: string } {
  if (writes > reads) {
    return { style: ' style="background:rgba(229,83,75,0.16)"', note: `Writes > reads (${basis}).` };
  }
  if (reads > writes) {
    return { style: ' style="background:rgba(63,185,80,0.16)"', note: `Reads > writes (${basis}).` };
  }
  return { style: '', note: '' };
}

function turnRow(group: TurnGroup, live: InFlightProject | undefined, ordinal: number | string, withDate = false): string {
  const isLive = live !== undefined;
  const s = aggregate(group.entries);
  // Hits still in flight add their pre-flight numbers; received/billed stay completed-only.
  const p = pendingTotals(live);
  const rawTokens = s.rawTokens + p.raw;
  const prunedNorm = s.prunedByNormalization + p.pruned;
  const sent = s.optimizedTokens + p.sent;
  const hits = group.entries.length + (live?.count ?? 0);
  const flow = flowCells(s, { rawTokens, prunedNorm, comp: compressionOf(group.entries), reused: reusedOf(group.entries), skipped: skippedOf(group.entries), sent });

  // A failure is judged on the turn's newest hit: a retry that went through makes it done again.
  const lastStatus = group.entries[group.entries.length - 1].status;
  const failed = isFailedHit({ status: lastStatus });
  const lastFailure = group.entries[group.entries.length - 1].failure;
  const failedLabel = lastStatus === 0 ? `failed (no response)${lastFailure ? ` · ${lastFailure}` : ''}` : `failed (HTTP ${lastStatus})`;
  // Earlier hits that failed were retried and the turn went through: still done, but say so.
  const retried = group.entries.filter(isFailedHit).length;
  const doneLabel = retried > 0 && !failed ? `Done · ${retried} of ${group.entries.length} hits failed and were retried` : 'Done';
  // ✖ only when nothing in the turn went through; a mix of failed and done hits is a warning.
  const allFailed = retried === group.entries.length;
  const statusCell = isLive
    ? PROCESSING
    : allFailed
      ? `<span style="color:${COLORS.bad}" title="${escapeHtml(failedLabel)}">✖</span>`
      : failed || retried > 0
        ? `<span style="color:${COLORS.warn}" title="${escapeHtml(failed ? `${failedLabel} · ${retried} of ${group.entries.length} hits failed` : doneLabel)}">⚠</span>`
        : `<span style="color:${COLORS.good}" title="Done">✔</span>`;

  const key = `${escapeHtml(group.project)}#${ordinal}`;
  // Every hit of the turn, newest first like the turns themselves (in-flight ones on top). Each goes
  // through the same cells as the turn row, and the turn row sums these same entries (plus the
  // in-flight ones), so the hits add up to it. Numbers stay chronological: the newest has the highest.
  const hitRows =
    (live ? liveHitRows(key, live) : '') +
    group.entries
      .map((entry, index) => hitRow(entry, key, index))
      .reverse()
      .join('');
  return `<tr${isLive ? ' class="turn-live"' : ''} data-row="${key}" data-toggle="${key}">
    ${timeCell(Date.parse(group.entries[group.entries.length - 1].timestamp), live?.since, true, withDate)}
    <td>${escapeHtml(group.project)}</td>
    <td>${statusCell}</td>
    <td class="num">1</td>
    <td class="num">${hits}</td>
    ${flow}
  </tr>${hitRows}`;
}

/** One completed hit of a turn, shown when the turn is expanded. */
function hitRow(entry: LedgerEntry, turnKey: string, index: number): string {
  const s = aggregate([entry]);
  // From the aggregate, not the raw row, so a failed hit shows what the turn counts for it: nothing.
  const flow = flowCells(s, {
    rawTokens: s.rawTokens,
    prunedNorm: s.prunedByNormalization,
    comp: compressionOf([entry]),
    reused: reusedOf([entry]),
    skipped: skippedOf([entry]),
    sent: s.optimizedTokens,
  });
  const failed = entry.status !== undefined && (entry.status < 200 || entry.status >= 300);
  const statusCell = failed
    ? `<span style="color:${COLORS.bad}" title="${entry.status === 0 ? `failed (no response)${entry.failure ? ` · ${escapeHtml(entry.failure)}` : ''}` : `failed (HTTP ${entry.status})`}">✖</span>`
    : `<span style="color:${COLORS.good}" title="Done">✔</span>`;
  return `<tr class="hit-row" data-row="${turnKey}/h${index}" data-parent="${turnKey}">
    <td></td>
    <td class="hit-label" title="${escapeHtml(`${new Date(entry.timestamp).toLocaleString()} · ${entry.servedModel ?? ''}`)}">↳ hit ${index + 1}</td>
    <td>${statusCell}</td>
    <td></td>
    <td class="num">1</td>
    ${flow}
  </tr>`;
}

/** One grouped bar chart: bar length is cost avoided, label carries the percentage. */
function breakdownSection(
  entries: readonly LedgerEntry[],
  key: (entry: LedgerEntry) => string,
  emptyMessage: string
): string {
  if (!entries.length) {
    return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
  }

  const groups = [...groupBy(entries, key).entries()]
    .map(([name, groupEntries]) => {
      const stats = aggregate(groupEntries);
      return { name, stats, saving: savingView(stats) };
    })
    .sort((a, b) => b.saving.units - a.saving.units);

  const maxSaved = Math.max(...groups.map((group) => Math.abs(group.saving.units))) || 1;

  return groups
    .map((group, index) =>
      barRow(
        group.name,
        `${group.saving.mark}${compact(group.saving.units)} u · ${group.saving.mark}${formatPercent(group.saving.percent)} ·${group.stats.turns} requests`,
        (Math.abs(group.saving.units) / maxSaved) * 100,
        group.saving.percent >= 0 ? CATEGORICAL_PALETTE[index % CATEGORICAL_PALETTE.length] : savingsTone(group.saving.percent),
        `${group.name}: ${compact(group.stats.rawTokens)} t raw. ${SAVING_MARK_HELP}`
      )
    )
    .join('');
}

/**
 * Drill-down on the sliding-window compaction trigger (Stage 2): how often it
 * actually fires against the configured token threshold, and whether the Haiku
 * summarizer call it pays for nets out ahead of the tokens it prunes. The "Chat
 * compression" row in the table above nets this against the rest of the turn;
 * this section isolates it, because a summarizer call that costs more than what
 * it prunes can make a compacted turn cost *more* than doing nothing at all.
 */
/** Groups skip reasons by kind (the economics one carries per-turn numbers) and counts them, most common first. */
function skipReasonCounts(entries: readonly LedgerEntry[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const raw = entry.compactionSkippedReason;
    if (!raw) {
      continue;
    }
    const reason = raw.startsWith('expected net')
      ? 'economics gate: the saving would not cover the Haiku call plus cache rewrite'
      : raw;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

function compactionSection(entries: readonly LedgerEntry[]): string {
  if (!entries.length) {
    return '<div class="empty">No turns for this selection.</div>';
  }

  const config = vscode.workspace.getConfiguration('claudeTokenImprover');
  const thresholdTokens =
    config.get<number>('slidingThresholdTokens', DEFAULT_OPTIMIZER_CONFIG.slidingThresholdTokens) ??
    DEFAULT_OPTIMIZER_CONFIG.slidingThresholdTokens;
  const fraction =
    config.get<number>('compactionFraction', DEFAULT_OPTIMIZER_CONFIG.compactionFraction) ??
    DEFAULT_OPTIMIZER_CONFIG.compactionFraction;

  const configLine = `<div class="stat-sub">Fires only on a cold cache (over 5 minutes since the last request), once session history reaches ${thresholdTokens.toLocaleString()} tokens (and at least 4 messages), and only once per conversation until it is rebuilt; replaces the oldest ${(
    fraction * 100
  ).toFixed(0)}% of it with a Haiku-written summary.</div>`;

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  // Turns where the economics gate declined to call Haiku. `net` is the estimate, not a measured cost.
  const skipped = entries.filter((entry) => entry.compactionSkippedReason);
  const skippedWithEstimate = skipped.filter((entry) => entry.compactionEconomics && entry.compactionEconomics.net <= 0);
  const avoidedNcu = sum(skippedWithEstimate.map((entry) => -(entry.compactionEconomics?.net ?? 0)));
  const skippedLine = skipped.length
    ? `<div class="stat-sub" style="margin-top:8px;">${skipped.length.toLocaleString()} turn${skipped.length === 1 ? '' : 's'} skipped compaction${
        skippedWithEstimate.length
          ? `; the gate estimated ${compact(avoidedNcu)} Units of net loss avoided across ${skippedWithEstimate.length.toLocaleString()} of them`
          : ''
      }:<ul>${skipReasonCounts(entries)
        .map(({ reason, count }) => `<li>${count.toLocaleString()} × ${escapeHtml(reason)}</li>`)
        .join('')}</ul></div>`
    : '';

  const triggered = entries.filter((entry) => entry.compactionTriggered);
  if (!triggered.length) {
    return `${configLine}${skippedLine}<div class="empty" style="margin-top:8px;">No compactions in this selection.</div>`;
  }

  const triggerRate = (triggered.length / entries.length) * 100;
  const avgRawAtTrigger = sum(triggered.map((e) => e.rawTokens)) / triggered.length;
  const avgPruned = sum(triggered.map((e) => e.prunedByCompaction)) / triggered.length;
  const totalPruned = sum(triggered.map((e) => e.prunedByCompaction));
  const summarizerNcu = sum(triggered.map((e) => e.summarizerUnitCost));
  const triggeredBaselineNcu = sum(triggered.map((e) => e.baselineUnitCost));
  const triggeredActualNcu = sum(triggered.map((e) => e.actualUnitCost));
  const netNcu = triggeredBaselineNcu - triggeredActualNcu;
  const netLossTurns = triggered.filter((e) => e.actualUnitCost > e.baselineUnitCost);
  const overheadTurns = triggered.filter((e) => e.summarizerUnitCost > e.prunedByCompaction);
  const netColor = savingsTone(netNcu);

  const lossWarning = netLossTurns.length
    ? `<div class="alert ${netLossTurns.length / triggered.length > 0.25 ? 'critical' : 'warning'}">
         ${netLossTurns.length} of ${triggered.length} compacted turns (${(
        (netLossTurns.length / triggered.length) *
        100
      ).toFixed(0)}%) cost <em>more</em> than the unoptimized baseline once the summarizer call is counted —
         the Haiku summarization itself (${compact(summarizerNcu)} Units total across this selection) is the largest
         single line item on those turns.
       </div>`
    : '';

  return `
  ${configLine}${skippedLine}
  <div class="stats" style="margin-top:10px;">
    <div>
      <div class="stat-label">Trigger rate</div>
      <div class="stat-value">${triggered.length.toLocaleString()} / ${entries.length.toLocaleString()} turns</div>
      <div class="stat-sub">${triggerRate.toFixed(1)}% of turns in this selection</div>
    </div>
    <div>
      <div class="stat-label">History size at trigger</div>
      <div class="stat-value">${compact(avgRawAtTrigger)} ${TOKENS_ABBR} avg</div>
      <div class="stat-sub">threshold is ${compact(thresholdTokens)}</div>
    </div>
    <div>
      <div class="stat-label">Pruned per trigger</div>
      <div class="stat-value">${compact(avgPruned)} ${TOKENS_ABBR} avg</div>
      <div class="stat-sub">${compact(totalPruned)} pruned in total</div>
    </div>
    <div>
      <div class="stat-label">Summarizer cost</div>
      <div class="stat-value" style="color:${COLORS.warn}">${compact(summarizerNcu)} ${UNITS_ABBR}</div>
      <div class="stat-sub">${overheadTurns.length} / ${triggered.length} triggers cost more in Haiku tokens than they pruned</div>
    </div>
    <div>
      <div class="stat-label">Net effect on triggered turns</div>
      <div class="stat-value" style="color:${netColor}">${compact(netNcu)} ${UNITS_ABBR}</div>
      <div class="stat-sub">baseline ${compact(triggeredBaselineNcu)} → actual ${compact(triggeredActualNcu)}, summarizer cost included</div>
    </div>
    <div>
      <div class="stat-label">Net-loss turns</div>
      <div class="stat-value" style="color:${netLossTurns.length ? COLORS.warn : COLORS.good}">${netLossTurns.length.toLocaleString()}</div>
      <div class="stat-sub">compacted turns that ended up costing more than doing nothing</div>
    </div>
  </div>
  ${lossWarning}`;
}

/**
 * A group's saving on the worst-case basis (see the headline): the floor over the rows that
 * carry one, else the modelled estimate for groups made only of older rows. `mark` is the
 * short prefix that keeps the two from being read as the same kind of number.
 */
function savingView(stats: AggregateStats): { units: number; percent: number; mark: string } {
  return stats.floorTurns > 0
    ? { units: stats.floorBaselineUnitCost - stats.floorActualUnitCost, percent: stats.floorSavingsPercent, mark: '≥ ' }
    : { units: stats.baselineUnitCost - stats.actualUnitCost, percent: stats.savingsPercent, mark: '~' };
}

const SAVING_MARK_HELP =
  '≥ at least, vs. the best client cache · ~ estimated';

function recentTable(entries: readonly LedgerEntry[]): string {
  if (!entries.length) {
    return '<div class="empty">No turns for this selection.</div>';
  }

  const rows = entries
    .slice(-25)
    .reverse()
    .map((entry) => {
      const when = new Date(entry.timestamp);
      const model = entry.modelSwapped ? `${entry.requestedModel} → ${entry.servedModel}` : entry.servedModel;
      const saving = savingView(aggregate([entry]));
      return `<tr>
        <td>${escapeHtml(when.toLocaleString())}</td>
        <td>${escapeHtml(entry.project)}</td>
        <td>${escapeHtml(model)}</td>
        <td class="num">${compact(entry.rawTokens)}</td>
        <td class="num">${compact(sentTokens(entry))}</td>
        <td class="num">${compact(entry.cacheReadTokens)}</td>
        <td class="num" style="color:${COLORS.bad}">${compact(entry.cacheWriteTokens)}</td>
        <td class="num" style="color:${savingsTone(saving.percent)}">${saving.mark}${formatPercent(saving.percent)}</td>
      </tr>`;
    })
    .join('');

  return `<table>
    <thead><tr>
      <th>When</th><th>Project</th><th>Model</th>
      <th class="num">Raw</th><th class="num">Sent</th><th class="num">Cache read</th><th class="num">Cache written</th><th class="num" title="${escapeHtml(SAVING_MARK_HELP)}">Saved</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
