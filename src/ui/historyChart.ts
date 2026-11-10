/**
 * Day-by-day charts of the persistent ledger: the request flow the Last turns table shows (raw,
 * cleanup, summary, received, billed), and cache reads vs writes in billed units. Hand-drawn SVG like the donut, so the webview needs no chart library. Kept free
 * of `vscode` imports so it can be unit tested.
 */

import { aggregate, AggregateStats, CLIENT_PREFIX_REUSE, LedgerEntry, localDayKey, sentTokens } from '../analytics/tracker';
import { CHART, compact, escapeHtml } from './shared';

/**
 * The charts' palette: slate grey and the icon's teal for the main series, with a muted trio only
 * where several lines must stay apart. Nothing is saturated, so no series shouts over the rest.
 */
const SERIES = {
  raw: '#8a9bad',
  accent: CHART.accent,
  sage: '#6fc4b3',
  lilac: '#7f9bb8',
  amber: '#e0b45a',
  copper: '#e08a6c',
};

/** A range longer than this keeps only its newest days, so every bar stays readable. */
export const MAX_CHART_DAYS = 62;

const FLOW_WIDTH = 1040;
const HALF_WIDTH = 520;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayPoint {
  /** Local `YYYY-MM-DD`, or `YYYY-MM-DD HH:00` for an hourly bucket. */
  day: string;
  /** Short text under the bar. */
  label: string;
  turns: number;
  /** The table's flow for the day: raw tokens, removed by cleanup, removed by the summary, received by Anthropic (tokens), billed (units). */
  raw: number;
  cleaned: number;
  summarized: number;
  received: number;
  billed: number;
  /** Cache reads and writes in billed units (tokens × multiplier), the same basis as the table's CR/CW colour. */
  readUnits: number;
  writeUnits: number;
  /** Cache reads and writes as raw tokens. */
  readTokens: number;
  writeTokens: number;
  /** Models whose CR / CW rate was not in the pricing table: their tokens are counted but add no units. */
  unpricedRead: string[];
  unpricedWrite: string[];
}

function groupEntries(entries: readonly LedgerEntry[], startMs: number, endMs: number, keyOf: (at: Date) => string): Map<string, LedgerEntry[]> {
  const buckets = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    if (at >= startMs && at < endMs) {
      const key = keyOf(new Date(at));
      const list = buckets.get(key);
      if (list) {
        list.push(entry);
      } else {
        buckets.set(key, [entry]);
      }
    }
  }
  return buckets;
}

function pointOf(entries: readonly LedgerEntry[], day: string, label: string): DayPoint {
  const stats = aggregate(entries);
  return {
    day,
    label,
    turns: stats.turns,
    raw: entries.reduce((sum, e) => sum + e.rawTokens, 0),
    cleaned: stats.prunedByNormalization,
    summarized: stats.prunedByCompaction,
    received: sentTokens(stats),
    billed: stats.actualUnitCost,
    readUnits: stats.cacheReadUnits,
    writeUnits: stats.cacheWriteUnits,
    readTokens: stats.cacheReadTokens,
    writeTokens: stats.cacheWriteTokens,
    unpricedRead: stats.unpriced.read,
    unpricedWrite: stats.unpriced.write,
  };
}

/** One point per local day in `[startMs, endMs)`, empty days included so gaps show as gaps. */
export function dailySeries(entries: readonly LedgerEntry[], startMs: number, endMs: number): DayPoint[] {
  const byDay = groupEntries(entries, startMs, endMs, localDayKey);
  const first = new Date(startMs);
  const days = Math.max(0, Math.round((endMs - startMs) / DAY_MS));
  const skip = Math.max(0, days - MAX_CHART_DAYS);
  const keys: string[] = [];
  for (let i = skip; i < days; i += 1) {
    keys.push(localDayKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
  }
  // Under two weeks the bar carries month-day; beyond that only the day, so the labels fit.
  return keys.map((day) => pointOf(byDay.get(day) ?? [], day, keys.length <= 14 ? day.slice(5) : day.slice(8)));
}

const hourKey = (at: Date): string => `${localDayKey(at)} ${String(at.getHours()).padStart(2, '0')}:00`;

/** One point per local hour of the day starting at `startMs`, up to `endMs` (so today stops at the current hour). */
export function hourlySeries(entries: readonly LedgerEntry[], startMs: number, endMs: number): DayPoint[] {
  const byHour = groupEntries(entries, startMs, endMs, hourKey);
  const first = new Date(startMs);
  const points: DayPoint[] = [];
  for (let h = 0; h < 24; h += 1) {
    const at = new Date(first.getFullYear(), first.getMonth(), first.getDate(), h);
    if (at.getTime() >= endMs) {
      break;
    }
    const key = hourKey(at);
    points.push(pointOf(byHour.get(key) ?? [], key, `${String(h).padStart(2, '0')}:00`));
  }
  return points;
}

interface Layer {
  name: string;
  unit: 'tokens' | 'units';
  color: string;
  value: (point: DayPoint) => number;
  /** Extra tooltip text for the point, such as the average rate that turned tokens into units. */
  note?: (point: DayPoint) => string;
  /**
   * A warning about the point itself, such as tokens that add no units because their rate is unknown.
   * Such a part has no height to hover, so the warning is shown with the period.
   */
  warning?: (point: DayPoint) => string;
  /** Drawn against the right-hand axis (units) instead of the left one (tokens). Lines only. */
  axis?: 'right';
}

const PAD = { left: 48, right: 10, top: 14, bottom: 26 };
/** Room for the right-hand axis labels when a chart has one. */
const RIGHT_AXIS_PAD = 52;
const MAX_BAR_WIDTH = 56;

/** Axis maximum rounded up to a step whose quarter is still a round number, so the gridlines read cleanly. */
function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step = [1, 1.2, 1.6, 2, 2.4, 2.8, 3.2, 4, 4.8, 5.6, 6.4, 8, 10].find((s) => fraction <= s) ?? 10;
  return step * base;
}

/** Black or white text, whichever reads better on the `#rrggbb` fill. */
function textOn(fill: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(fill)?.[1];
  if (!hex) {
    return '#fff';
  }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111' : '#fff';
}

/** Three significant digits (`42.4M`, `987K`), short enough to sit inside a narrow bar. */
function shortFigure(value: number): string {
  const abs = Math.abs(value);
  const [divisor, suffix] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const scaled = value / divisor;
  const text = scaled >= 100 || suffix === '' ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return `${text.includes('.') ? text.replace(/\.?0+$/, '') : text}${suffix}`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One stacked bar per point, the same in every chart; `lines` run over the bars through the middle
 * of each one. All share one scale, so a line can be read against the bars. Each value is written
 * on its segment or point when it fits without touching another label; the tooltip always has every value.
 */
function chartSvg(
  points: readonly DayPoint[],
  bars: readonly Layer[],
  ariaLabel: string,
  width: number,
  height: number,
  lines: readonly Layer[] = []
): string {
  const rightLines = lines.filter((l) => l.axis === 'right');
  const leftLines = lines.filter((l) => l.axis !== 'right');
  const padRight = rightLines.length > 0 ? RIGHT_AXIS_PAD : PAD.right;
  const plotW = width - PAD.left - padRight;
  const plotH = height - PAD.top - PAD.bottom;
  const tops = points.map((p) => Math.max(bars.reduce((sum, l) => sum + l.value(p), 0), ...leftLines.map((l) => l.value(p))));
  const max = niceMax(Math.max(1, ...tops));
  // The right axis (units) has its own scale, so a line on it is read against that axis, not the bars.
  const maxRight = niceMax(Math.max(1, ...points.flatMap((p) => rightLines.map((l) => l.value(p)))));
  const slot = plotW / Math.max(1, points.length);
  const barArea = Math.max(1, Math.min(MAX_BAR_WIDTH, slot - Math.min(4, slot * 0.12)));
  const y = (value: number, axis?: 'right'): number => PAD.top + plotH - (Math.max(0, value) / (axis === 'right' ? maxRight : max)) * plotH;
  const centre = (i: number): number => PAD.left + i * slot + slot / 2;
  const all = [...bars, ...lines];

  /** The tooltip of one part of the chart: the period and that part's own value, nothing else. */
  const partTip = (p: DayPoint, layer: Layer): string =>
    `${p.day} · ${p.turns.toLocaleString()} requests\n${layer.name}: ${compact(layer.value(p))} ${layer.unit === 'tokens' ? 't' : 'u'}${layer.note?.(p) ?? ''}`;

  // Labels already on the chart: a new one that would overlap any of them is left out.
  const placed: Box[] = [];
  const free = (box: Box): boolean => !placed.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h);
  const label = (value: number, x: number, yMid: number, textFill: string, room: number, backing?: string, heightRoom?: number): string => {
    if (value <= 0) {
      return '';
    }
    const text = shortFigure(value);
    const size = Math.min(10, room / (text.length * 0.6));
    if (size < 7.5) {
      // Too wide for a narrow bar: stand the figure upright inside it when the segment is tall enough.
      const upright = Math.min(10, room - 3);
      const length = text.length * upright * 0.6;
      if (heightRoom === undefined || upright < 7 || length + 4 > heightRoom) {
        return '';
      }
      const box = { x: x - upright / 2 - 1, y: yMid - length / 2, w: upright + 2, h: length };
      if (!free(box)) {
        return '';
      }
      placed.push(box);
      return `<text x="${x.toFixed(1)}" y="${yMid.toFixed(1)}" transform="rotate(-90 ${x.toFixed(1)} ${yMid.toFixed(1)})" dy="${(upright * 0.35).toFixed(1)}" text-anchor="middle" class="value" style="font-size:${upright.toFixed(1)}px" fill="${textFill}">${escapeHtml(text)}</text>`;
    }
    const w = text.length * size * 0.6 + 1;
    const h = size + 3;
    const box = { x: x - w / 2, y: yMid - h / 2, w, h };
    if (box.y < 0 || !free(box)) {
      return '';
    }
    placed.push(box);
    const pill = backing
      ? `<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${backing}" fill-opacity="0.88"></rect>`
      : '';
    return `${pill}<text x="${x.toFixed(1)}" y="${(yMid + size * 0.35).toFixed(1)}" text-anchor="middle" class="value" style="font-size:${size.toFixed(1)}px" fill="${textFill}">${escapeHtml(text)}</text>`;
  };

  const axisText = (value: number): string => compact(value).replace(/\.00(?=[KMB]|$)/, '');
  const grid = [0, 1, 2, 3, 4]
    .map((k) => {
      const gy = y((max * k) / 4);
      const line = k === 0 ? '' : `<line x1="${PAD.left}" y1="${gy.toFixed(1)}" x2="${width - padRight}" y2="${gy.toFixed(1)}" stroke="${CHART.grid}"></line>`;
      // The right axis shares the gridlines, in the colour of the line it measures.
      const right =
        rightLines.length > 0
          ? `<text x="${width - padRight + 6}" y="${(gy + 3).toFixed(1)}" text-anchor="start" class="axis" fill="${rightLines[0].color}">${axisText((maxRight * k) / 4)}</text>`
          : '';
      return `${line}<text x="${PAD.left - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="axis">${axisText((max * k) / 4)}</text>${right}`;
    })
    .join('');

  // Skip axis labels when they would crowd each other (24 hours in a half-width chart).
  const labelStep = Math.max(1, Math.ceil((points[0]?.label.length ?? 1) * 5.4 / slot));

  const columns = points
    .map((p, i) => {
      const warnings = all.map((l) => l.warning?.(p) ?? '').filter((text) => text !== '');
      const period = [`${p.day} · ${p.turns.toLocaleString()} requests`, ...warnings.map((text) => `⚠ ${text}`)].join('\n');
      let rects = '';
      let labels = '';
      let stackTop = 0;
      for (const layer of bars) {
        const value = Math.max(0, layer.value(p));
        const top = y(stackTop + value);
        const barHeight = y(stackTop) - top;
        if (barHeight > 0) {
          rects += `<rect x="${(centre(i) - barArea / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barArea.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${layer.color}" fill-opacity="0.9" rx="2" data-series="${escapeHtml(layer.name)}"><title>${escapeHtml(partTip(p, layer))}</title></rect>`;
          // Only a segment tall enough for a line of text carries its figure.
          if (barHeight >= 13) {
            labels += `<g data-series="${escapeHtml(layer.name)}">${label(value, centre(i), top + barHeight / 2, textOn(layer.color), barArea + 2, undefined, barHeight)}</g>`;
          }
        }
        stackTop += value;
      }
      const axisLabel =
        i % labelStep === 0
          ? `<text x="${centre(i).toFixed(1)}" y="${height - 9}" text-anchor="middle" class="axis" style="font-size:${Math.min(10, Math.max(7, slot * 0.5)).toFixed(1)}px">${escapeHtml(p.label)}</text>`
          : '';
      // The empty space around the bars only names the period; each value lives in its own part.
      return `<g><rect x="${(PAD.left + i * slot).toFixed(1)}" y="${PAD.top}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"><title>${escapeHtml(period)}</title></rect>${rects}${labels}${axisLabel}</g>`;
    })
    .join('');

  const overlays = lines
    .map((layer) => {
      const coords = points.map((p, i) => `${centre(i).toFixed(1)},${y(layer.value(p), layer.axis).toFixed(1)}`);
      // Each point is hoverable on its own: a larger invisible circle makes the small dot easy to hit.
      const dots = points
        .map((p, i) => {
          const cx = centre(i).toFixed(1);
          const cy = y(layer.value(p), layer.axis).toFixed(1);
          return `<g data-series="${escapeHtml(layer.name)}"><circle cx="${cx}" cy="${cy}" r="2.2" fill="${layer.color}" stroke="var(--vscode-editor-background, #1e1e1e)" stroke-width="1.5"></circle><circle cx="${cx}" cy="${cy}" r="8" fill="transparent"><title>${escapeHtml(partTip(p, layer))}</title></circle></g>`;
        })
        .join('');
      // Line figures sit on a pill of the page colour, so they read over any bar behind them.
      const labels = points
        .map((p, i) => label(layer.value(p), centre(i), y(layer.value(p), layer.axis) - 9, `color-mix(in srgb, ${layer.color} 65%, var(--vscode-foreground, #888))`, slot + 12, 'var(--vscode-editor-background, #1e1e1e)'))
        .join('');
      const name = escapeHtml(layer.name);
      return `<polyline points="${coords.join(' ')}" fill="none" stroke="${layer.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" pointer-events="stroke" data-series="${name}"></polyline>${dots}<g pointer-events="none" data-series="${name}">${labels}</g>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="${escapeHtml(ariaLabel)}">
    ${grid}
    <line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${width - padRight}" y2="${PAD.top + plotH}" stroke="${CHART.target}" stroke-opacity="0.5"></line>
    ${columns}${overlays}
  </svg>`;
}

function legend(items: ReadonlyArray<{ name: string; color: string; series?: string }>): string {
  return `<div class="legend">${items
    .map((item) => `<span class="legend-item" data-series="${escapeHtml(item.series ?? item.name)}"><span class="dot" style="background:${item.color}"></span>${escapeHtml(item.name)}</span>`)
    .join('')}</div>`;
}

/**
 * The two charts for the table's date filter `range`: one bar per day, or per hour when the range
 * is a single day (Today, Yesterday). Days after `now` are left out.
 */
export function historyChartsHtml(
  entries: readonly LedgerEntry[],
  range: { start: number; end: number },
  now: Date = new Date()
): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const { start } = range;
  const end = Math.min(range.end, tomorrow);
  const singleDay = range.end - range.start <= DAY_MS + 3_600_000;
  // Today ends at the current hour; other single days show all 24.
  const hourEnd = Math.min(range.end, now.getTime() + 1);

  const series = singleDay ? hourlySeries(entries, start, hourEnd) : dailySeries(entries, start, end);
  if (series.length === 0 || series.every((p) => p.turns === 0)) {
    return `<h2>History</h2><div class="empty">No requests in this period.</div>`;
  }
  // Hours before the first request of the day are left out, so the bars use the width for the hours that have data.
  const firstActive = series.findIndex((p) => p.turns > 0);
  const points = singleDay ? series.slice(firstActive) : series;

  const flowBars: Layer[] = [
    { name: 'Raw', unit: 'tokens', color: SERIES.raw, value: (p) => p.raw },
    { name: 'Received', unit: 'tokens', color: SERIES.accent, value: (p) => p.received },
  ];
  const flowLines: Layer[] = [
    { name: 'Cleanup removed', unit: 'tokens', color: SERIES.sage, value: (p) => p.cleaned },
    { name: 'Summarized removed', unit: 'tokens', color: SERIES.lilac, value: (p) => p.summarized },
    { name: 'Billed', unit: 'units', color: SERIES.amber, value: (p) => p.billed, axis: 'right' },
  ];
  const flow = chartSvg(points, flowBars, 'Raw and received tokens per period, with removals and billed units as lines', FLOW_WIDTH, 170, flowLines);
  // Units are tokens × the model's price for that kind of token, so the tooltip shows the average rate.
  const avgRate = (units: (p: DayPoint) => number, tokens: (p: DayPoint) => number) => (p: DayPoint): string =>
    tokens(p) > 0 ? ` (avg × ${Number((units(p) / tokens(p)).toFixed(3))})` : '';
  const unpricedWarning = (kind: string, unpriced: (p: DayPoint) => string[]) => (p: DayPoint): string =>
    unpriced(p).length > 0 ? `${kind}: no rate for ${unpriced(p).join(', ')}, adds no u` : '';
  const cacheChart = (unit: 'tokens' | 'units', read: (p: DayPoint) => number, write: (p: DayPoint) => number): string =>
    chartSvg(
      points,
      [
        { name: 'CR', unit, color: SERIES.accent, value: read, note: unit === 'units' ? avgRate((p) => p.readUnits, (p) => p.readTokens) : undefined, warning: unit === 'units' ? unpricedWarning('CR', (p) => p.unpricedRead) : undefined },
        { name: 'CW', unit, color: SERIES.copper, value: write, note: unit === 'units' ? avgRate((p) => p.writeUnits, (p) => p.writeTokens) : undefined, warning: unit === 'units' ? unpricedWarning('CW', (p) => p.unpricedWrite) : undefined },
      ],
      `CR versus CW ${unit === 'tokens' ? 't' : 'u'} per period`,
      HALF_WIDTH,
      150
    );
  const cacheLegend = legend([
    { name: 'CR', color: SERIES.accent },
    { name: 'CW', color: SERIES.copper },
  ]);

  return `<h2>History</h2>
  <div data-chart-scope>
    <div class="stat-label" style="text-transform:none">Request flow: tokens on the left axis, Billed units on the right</div>
    ${flow}
    ${legend([
      { name: 'Raw', color: SERIES.raw },
      { name: 'Received', color: SERIES.accent },
      { name: 'Cleanup removed (line)', series: 'Cleanup removed', color: SERIES.sage },
      { name: 'Summarized removed (line)', series: 'Summarized removed', color: SERIES.lilac },
      { name: 'Billed, units (line, right axis)', series: 'Billed', color: SERIES.amber },
    ])}
  </div>
  <hr style="border:0;border-top:1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));margin:16px 0 0">
  <div class="chart-grid" style="margin-top:14px">
    <div data-chart-scope>
      <div class="stat-label" style="text-transform:none">CR vs CW, Tokens</div>
      ${cacheChart('tokens', (p) => p.readTokens, (p) => p.writeTokens)}
      ${cacheLegend}
    </div>
    <div data-chart-scope>
      <div class="stat-label" style="text-transform:none">CR vs CW, Units</div>
      ${cacheChart('units', (p) => p.readUnits, (p) => p.writeUnits)}
      ${cacheLegend}
    </div>
  </div>
  <div style="height:14px"></div>
  <hr style="border:0;border-top:1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));margin:0 0 16px">`;
}

// ---------------------------------------------------------------------------
// Saving trend: the percentage the header donuts used to show, over time
// ---------------------------------------------------------------------------

/** The headline percentage of a set of turns: the typical case vs. a client reusing most of its cache, else the estimate. */
function savingPercentOf(entries: readonly LedgerEntry[]): { percent: number; mark: string } | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  return { percent: headlineSavingPercent(aggregate(entries)), mark: '~' };
}

/** The figure the charts headline, shared with the status bar tooltip so both always agree. */
export function headlineSavingPercent(stats: AggregateStats): number {
  return stats.floorTurns > 0 ? stats.centralSavingsPercent : stats.savingsPercent;
}

/** The headline percentage worked out step by step, so every figure in it can be checked against the table. */
function savingFormula(entries: readonly LedgerEntry[]): string {
  if (entries.length === 0) {
    return 'No requests in this period.';
  }
  const stats = aggregate(entries);
  const n = (value: number): string => Math.round(value).toLocaleString();
  const floor = stats.floorTurns > 0;
  const billed = floor ? stats.floorActualUnitCost : stats.actualUnitCost;
  const without = floor ? stats.centralBaselineUnitCost : stats.baselineUnitCost;
  const percent = floor ? stats.centralSavingsPercent : stats.savingsPercent;
  const rows = floor ? entries.filter((e) => e.floorBaselineUnitCost !== undefined) : entries;
  const sum = (pick: (e: LedgerEntry) => number | undefined): number => rows.reduce((total, e) => total + (pick(e) ?? 0), 0);
  const exact = rows.filter((e) => e.rawTokensExact === true).length;
  const cachedKnown = rows.every((e) => e.floorCachedTokens !== undefined);
  const lines = [
    'Saving = 1 − Billed ÷ Without proxy',
    '',
    `Billed = what Anthropic charged, ${rows.length.toLocaleString()} requests = ${n(billed)} u`,
    `  regular input ${n(sum((e) => e.regularInputUnits))} + cache read ${n(sum((e) => e.cacheReadUnits))}`,
    `  + cache write ${n(sum((e) => e.cacheWriteUnits))} + output ${n(sum((e) => e.outputUnits))}`,
    `  + summaries a model wrote ${n(sum((e) => e.summarizerUnitCost))}`,
    '',
    `Without proxy = same requests as Claude Code sends them = ${n(without)} u`,
    '  per request: cached × read rate + (raw − cached) × write rate + output × rate',
    `  raw (size before the proxy) = ${n(sum((e) => e.rawTokens))} t`,
    `    exact count on ${exact.toLocaleString()} of ${rows.length.toLocaleString()} requests, rest estimated locally`,
    cachedKnown
      ? `  cached (prefix the client cache still holds, ≤ 1 h, × ${CLIENT_PREFIX_REUSE}) = ${n(sum((e) => e.floorCachedTokens) * CLIENT_PREFIX_REUSE)} t`
      : `  cached (prefix the client cache still holds) is not stored on older requests`,
    `  output = ${n(sum((e) => e.outputTokens))} t; rates are the original model's price per token`,
    floor ? `  typical client: reuses ${(CLIENT_PREFIX_REUSE * 100).toFixed(0)}% of its prefix from cache (measured without the proxy)` : '',
    '',
    `1 − ${n(billed)} ÷ ${n(without)} = ${percent.toFixed(2)}%`,
  ];
  return lines.filter((line, i) => line !== '' || lines[i - 1] !== '').join(String.fromCharCode(10));
}

interface TrendPoint {
  /** Bottom-axis text: the hour (`14:00`) or the day (`10-28`). */
  label: string;
  /** Saving of all turns up to the end of this bucket. */
  percent: number | undefined;
}

const TREND = { width: 420, height: 96, left: 34, right: 10, top: 10, bottom: 22 };
/** About this many labels along the bottom; more would touch each other. */
const TREND_TICKS = 6;

/**
 * A small line chart of the saving percentage per hour or per day. One line, the time along the
 * bottom, and a tooltip with just the time and the percentage. It scales with the width of its
 * column, so the header charts share the page width instead of being a fixed size.
 */
export function savingTrendSvg(
  entries: readonly LedgerEntry[],
  startMs: number,
  endMs: number,
  unit: 'hour' | 'day',
  ariaLabel: string
): string {
  const buckets = groupEntries(entries, startMs, endMs, unit === 'hour' ? hourKey : localDayKey);
  const first = new Date(startMs);
  const slots: Array<{ key: string; label: string }> = [];
  if (unit === 'hour') {
    for (let h = 0; h < 24; h += 1) {
      const at = new Date(first.getFullYear(), first.getMonth(), first.getDate(), h);
      if (at.getTime() >= endMs) {
        break;
      }
      slots.push({ key: hourKey(at), label: `${String(h).padStart(2, '0')}:00` });
    }
  } else {
    const days = Math.min(MAX_CHART_DAYS, Math.max(0, Math.round((endMs - startMs) / DAY_MS)));
    for (let i = 0; i < days; i += 1) {
      const key = localDayKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
      slots.push({ key, label: key.slice(5) });
    }
  }
  // Leading empty buckets add nothing: start at the first one with data.
  const firstActive = slots.findIndex((slot) => (buckets.get(slot.key)?.length ?? 0) > 0);
  if (firstActive < 0) {
    return `<div class="trend-empty">No requests yet</div>`;
  }

  // Running figure: each point is the saving of everything up to the end of its bucket, so the last
  // point is the headline number and a quiet bucket simply repeats the previous value.
  const seen: LedgerEntry[] = [];
  const points: TrendPoint[] = slots.slice(firstActive).map((slot) => {
    seen.push(...(buckets.get(slot.key) ?? []));
    return { label: slot.label, percent: savingPercentOf(seen)?.percent };
  });

  // An hour with one tiny request can read -400 %: the line is clamped, the tooltip keeps the real value.
  const clamp = (value: number): number => Math.max(-100, Math.min(100, value));
  const values = points.map((p) => p.percent).filter((v): v is number => v !== undefined).map(clamp);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const plotW = TREND.width - TREND.left - TREND.right;
  const plotH = TREND.height - TREND.top - TREND.bottom;
  const x = (i: number): number => TREND.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (value: number): number => TREND.top + (1 - (clamp(value) - lo) / span) * plotH;

  // Break the line where a bucket has no value instead of drawing across the gap.
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.percent === undefined) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.percent).toFixed(1)} `;
    pen = true;
  });

  const dots = points
    .map((p, i) =>
      p.percent === undefined
        ? ''
        : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.percent).toFixed(1)}" r="2.5" fill="${SERIES.accent}" data-series="saving"></circle>` +
          `<circle cx="${x(i).toFixed(1)}" cy="${y(p.percent).toFixed(1)}" r="8" fill="transparent"><title>${escapeHtml(`${p.label} · ${p.percent.toFixed(1)}%`)}</title></circle>`
    )
    .join('');

  // Times along the bottom, evenly spaced; the last one is dropped when it would sit on its neighbour.
  const step = Math.max(1, Math.ceil(points.length / TREND_TICKS));
  const ticks = points
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % step === 0 && (i + step <= points.length - 1 || i === points.length - 1 || points.length - 1 - i >= step / 2));
  const tickText = ticks
    .map(({ p, i }) => {
      const anchor = i === 0 ? 'start' : 'middle';
      return `<text x="${x(i).toFixed(1)}" y="${TREND.height - 6}" text-anchor="${anchor}" class="trend-axis">${escapeHtml(p.label)}</text>`;
    })
    .join('');

  const zeroY = y(0).toFixed(1);
  return `<svg viewBox="0 0 ${TREND.width} ${TREND.height}" class="trend-svg" role="img" aria-label="${escapeHtml(ariaLabel)}">
    <line x1="${TREND.left}" x2="${TREND.width - TREND.right}" y1="${zeroY}" y2="${zeroY}" stroke="${CHART.target}" stroke-dasharray="3 3"></line>
    <text x="${TREND.left - 5}" y="${TREND.top + 4}" text-anchor="end" class="trend-axis">${Math.round(hi)}%</text>
    <text x="${TREND.left - 5}" y="${TREND.height - TREND.bottom}" text-anchor="end" class="trend-axis">${Math.round(lo)}%</text>
    ${tickText}
    <path d="${d.trim()}" fill="none" stroke="${SERIES.accent}" stroke-width="2" pointer-events="stroke" data-series="saving"></path>
    ${dots}
  </svg>`;
}

/** The header block: today (or the filtered range) by hour on the left, this month by day on the right. */
export function savingTrendsHtml(
  rangeEntries: readonly LedgerEntry[],
  range: { start: number; end: number },
  rangeTitle: string,
  monthEntries: readonly LedgerEntry[],
  tone: (percent: number) => string,
  now: Date = new Date()
): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const singleDay = range.end - range.start <= DAY_MS + 3_600_000;
  const rangeEnd = singleDay ? Math.min(range.end, now.getTime() + 1) : Math.min(range.end, tomorrow);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const grain = singleDay ? 'hour' : 'day';

  const block = (title: string, hint: string, entries: readonly LedgerEntry[], svg: string): string => {
    const headline = savingPercentOf(entries);
    const figure = headline
      ? `<span class="trend-figure" style="color:${tone(headline.percent)}" data-tooltip="${escapeHtml(savingFormula(entries))}">${escapeHtml(headline.mark + headline.percent.toFixed(2))}%</span>`
      : '<span class="trend-figure">—</span>';
    return `<div class="trend-block" title="${escapeHtml(hint)}">
      <div class="trend-title">${escapeHtml(title)} ${figure}</div>
      ${svg}
    </div>`;
  };

  return `<div class="trend-row">
    ${block(rangeTitle, `Saving so far, at the end of each ${grain}; the last point is the figure beside the title.`, rangeEntries, savingTrendSvg(rangeEntries, range.start, rangeEnd, grain, `${rangeTitle}: saving by ${grain}`))}
    ${block('This month · all repos', 'Saving so far, at the end of each day; the last point is the figure beside the title.', monthEntries, savingTrendSvg(monthEntries, monthStart, tomorrow, 'day', 'This month: saving by day'))}
  </div>`;
}
