/**
 * Presentation helpers shared by the budget dashboard and the Token Improver
 * analytics panel, so both webviews read as one extension.
 */

import * as fs from 'fs';
import * as path from 'path';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A percentage with the panel-wide two decimals; `ratio` is `part / whole` scaled to 100 by the caller. */
export function formatPercent(percent: number): string {
  return `${percent.toFixed(2)}%`;
}

/** `saved / before` as a percentage, or an em dash when there is nothing to divide by. */
export function formatShare(saved: number, before: number): string {
  return before > 0 ? formatPercent((saved / before) * 100) : '—';
}

/** Short human-readable token/number formatting: 1.23K, 3.45M, 5.67B. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Dollars, with enough precision to stay meaningful at small amounts. */
export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (abs >= 0.01) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(4)}`;
}

/**
 * Segmented progress indicator for the status bar tooltip (a `vscode.MarkdownString`,
 * not a webview — no `<div>` fill bar available there). Built from codicons
 * (`$(circle-filled)`/`$(circle-outline)`) rather than Unicode block characters:
 * codicons are theme SVGs of uniform size, so they line up cleanly, while
 * `█`/`░` render with inconsistent glyph widths across fonts. Requires the
 * caller's `MarkdownString.supportThemeIcons = true`, and must NOT be wrapped in
 * a code span — inside one, `$(...)` is left as literal text instead of being
 * substituted for the icon. Kept short (10 segments default): codicons are
 * wider than block characters, so the 20-wide version used to overflow.
 */
export function progressBarText(percent: number, segments = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * segments);
  return '$(circle-filled)'.repeat(filled) + '$(circle-outline)'.repeat(segments - filled);
}

/** Semantic colours, matching the VS Code dark/light palettes closely enough to fit either. */
export const COLORS = {
  good: '#3fd0b6',
  info: '#7f9bb8',
  warn: '#f2b84b',
  bad: '#f2704f',
  muted: '#8a9bad',
  accent: '#d99a6c',
  teal: '#7fe0cf',
};

/**
 * The restrained palette of the dashboard charts: one accent for the data, a muted red
 * reserved for going over target, and neutral grey for scaffolding. Colour carries
 * meaning only where something needs attention.
 */
export const CHART = {
  accent: '#3fc9b0',
  over: '#e8745a',
  grid: 'rgba(128, 128, 128, 0.18)',
  target: 'rgba(160, 160, 160, 0.75)',
};

/** The accent at a given strength (0-100), for ranked series that share one hue. */
export function accentShade(strength: number): string {
  return `color-mix(in srgb, ${CHART.accent} ${Math.round(strength)}%, transparent)`;
}

export const CATEGORICAL_PALETTE = [
  COLORS.info,
  COLORS.good,
  COLORS.warn,
  COLORS.accent,
  COLORS.teal,
  COLORS.bad,
  '#ffd166',
];

/** One labelled horizontal bar. Used for model, project and month breakdowns. */
export function barRow(label: string, value: string, fillPercent: number, color: string, title?: string): string {
  const width = Math.max(0, Math.min(100, fillPercent)).toFixed(1);
  return `
    <div class="bar-row">
      <div class="bar-name" title="${escapeHtml(title ?? label)}">${escapeHtml(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color}"></div></div>
      <div class="bar-value">${escapeHtml(value)}</div>
    </div>`;
}

/**
 * A donut gauge with a percentage in the middle. `valueText` overrides the centre label, so a
 * figure the arc cannot draw (a negative saving) still shows its real value over an empty ring.
 */
export function donutChart(percent: number, color: string, caption: string, valueText?: string): string {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(Math.min(percent, 100), 0);
  const dash = (clamped / 100) * circumference;

  return `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="${escapeHtml(caption)}">
    <circle cx="70" cy="70" r="${radius}" fill="none" stroke="var(--vscode-widget-border, #444)" stroke-width="14"></circle>
    <circle cx="70" cy="70" r="${radius}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 70 70)"></circle>
    <text x="70" y="64" text-anchor="middle" class="donut-value">${escapeHtml(valueText ?? `${percent.toFixed(2)}%`)}</text>
    <text x="70" y="86" text-anchor="middle" class="donut-caption">${escapeHtml(caption)}</text>
  </svg>`;
}

/** A small ring with no text; the figure goes beneath it, so the ring takes little room. */
export function miniDonut(percent: number, color: string, caption: string): string {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(Math.min(percent, 100), 0) / 100) * circumference;
  return `<svg viewBox="0 0 140 140" class="donut-mini" role="img" aria-label="${escapeHtml(caption)}">
    <circle cx="70" cy="70" r="${radius}" fill="none" stroke="var(--vscode-widget-border, #444)" stroke-width="20"></circle>
    <circle cx="70" cy="70" r="${radius}" fill="none" stroke="${color}" stroke-width="20" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 70 70)"></circle>
  </svg>`;
}

/** Stylesheet shared by both webviews. Theme-aware via VS Code CSS variables. */
/**
 * The status bar gauge as a webview icon: `media/budget-icons.woff` inlined (webviews cannot
 * reach the extension's files under the strict CSP), glyphs E002..E014 = needle full scale..rest.
 * Falls back to the CSS spinner if the font cannot be read.
 */
function gaugeFontCss(): string {
  try {
    const data = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'budget-icons.woff')).toString('base64');
    // Needle path: long jumps and small nudges, each step walking through the in-between glyphs.
    const stops = [19, 6, 9, 2, 12, 15, 4, 8, 18, 11, 3, 7, 14, 1, 10, 19];
    const frames: number[] = [];
    for (let i = 0; i < stops.length - 1; i += 1) {
      const dir = stops[i + 1] > stops[i] ? 1 : -1;
      for (let f = stops[i]; f !== stops[i + 1]; f += dir) frames.push(f);
      for (let h = 0; h < 3; h += 1) frames.push(stops[i + 1]); // hover
    }
    const glyph = (n: number): string => String.fromCharCode(92) + (0xe001 + n).toString(16).toUpperCase();
    const keyframes = frames.map((f, i) => `${((i / frames.length) * 100).toFixed(2)}% { content: '${glyph(f)}'; }`).join(' ');
    return `
  @font-face { font-family: 'budget-gauge'; src: url(data:font/woff;base64,${data}) format('woff'); }
  @keyframes gauge-needle { ${keyframes} }
  .gauge-icon { display: inline-block; width: 1em; margin-right: 6px; font-family: 'budget-gauge'; font-style: normal; line-height: 1; vertical-align: -2px; }
  .gauge-icon::before { content: '${glyph(19)}'; animation: gauge-needle var(--gd, 4s) linear var(--go, 0s) infinite; }`;
  } catch {
    return '';
  }
}

const GAUGE_CSS = gaugeFontCss();
/** A processing marker: the gauge with its own needle motion (speed and phase per instance), or the spinner without the font. */
export function processingIcon(seed: string): string {
  if (GAUGE_CSS === '') return '<span class="spin" title="Processing"></span>';
  // Derived from the row's key, so a re-render of the same row keeps its needle where it is.
  let hash = 7;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const duration = 2.6 + (hash % 17) / 5; // 2.6..5.8 s
  const offset = ((hash >>> 5) % 97) / 97 * duration;
  return `<span class="gauge-icon" title="Processing" style="--gd:${duration.toFixed(2)}s;--go:-${offset.toFixed(2)}s"></span>`;
}

export const BASE_STYLES = `
  body { font-family: var(--vscode-font-family); font-size: 14px; color: var(--vscode-foreground); padding: 18px 22px 32px; }
  h1 { font-size: 1.15em; margin: 0 0 2px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { font-size: 0.95em; margin: 26px 0 10px; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 6px; }
  .subtitle { opacity: 0.7; font-size: 0.8em; margin-bottom: 16px; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.72em; font-weight: 600; color: #111; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .head .donut-row, .head .trend-row { margin: 0; }
  .top { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
  .donut { width: 150px; height: 150px; flex: 0 0 auto; }
  .donut-value { font-size: 22px; font-weight: 700; fill: var(--vscode-foreground); }
  .donut-mini { width: 34px; height: 34px; flex: 0 0 auto; }
  .donut-figure { font-size: 0.85em; font-weight: 700; line-height: 1.1; }
  .trend-row { display: flex; gap: 20px; align-items: flex-start; width: 60%; min-width: 420px; }
  .trend-block { display: flex; flex-direction: column; gap: 1px; flex: 1 1 0; min-width: 0; }
  .trend-title { font-size: 0.78em; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
  .trend-figure { font-weight: 700; }
  .trend-svg { width: 100%; height: auto; display: block; }
  .trend-axis { font-size: 10px; fill: var(--vscode-descriptionForeground, #999); }
  .trend-empty { font-size: 0.78em; opacity: 0.6; height: 96px; display: flex; align-items: center; }
  .donut-row { display: flex; gap: 28px; flex-wrap: wrap; margin: 10px 0 14px; }
  .donut-block { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .donut-title { font-size: 0.78em; font-weight: 600; }
  .donut-caption { font-size: 10px; fill: var(--vscode-descriptionForeground, #999); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 20px; flex: 1 1 340px; }
  .stat-label { opacity: 0.65; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-value { font-size: 1.05em; font-weight: 600; margin-top: 2px; }
  .stat-sub { font-size: 0.75em; opacity: 0.7; }
  .chart { width: 100%; height: auto; font-family: var(--vscode-font-family, system-ui, sans-serif); }
  .chart .value { font-weight: 600; paint-order: stroke; stroke: rgba(0,0,0,0.35); stroke-width: 0.5px; pointer-events: none; }
  .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px 24px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; font-size: 0.75em; opacity: 0.8; margin-top: 2px; }
  .legend-item { display: inline-flex; align-items: center; gap: 5px; }
  .chart rect { transition: opacity 0.15s ease; }
  .chart rect:hover { opacity: 1; }
  .axis { font-size: 10px; fill: var(--vscode-descriptionForeground, #999); }
  .bar-row { display: grid; grid-template-columns: 210px 1fr 150px; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-name { font-size: 0.82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .bar-track { background: rgba(128, 128, 128, 0.14); border-radius: 3px; height: 6px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
  .bar-value { font-size: 0.78em; text-align: right; opacity: 0.85; }
  .tier { font-size: 0.72em; padding: 1px 6px; border-radius: 8px; color: #111; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; flex: 0 0 auto; }
  .stacked { display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 16px; }
  .stacked div { height: 100%; }
  .alert { padding: 8px 12px; border-radius: 4px; margin-bottom: 6px; font-size: 0.82em; border-left: 3px solid; }
  .alert.critical { background: rgba(242,112,79,0.12); border-color: #f2704f; }
  .alert.warning { background: rgba(242,184,75,0.12); border-color: #f2b84b; }
  .alert.info { background: rgba(127,155,184,0.12); border-color: #7f9bb8; }
  ul { margin: 0; padding-left: 18px; font-size: 0.82em; line-height: 1.6; }
  .empty { opacity: 0.6; font-style: italic; font-size: 0.85em; }
  .tips { list-style: none; padding-left: 0; }
  .tips li { border-left: 3px solid var(--vscode-widget-border, #444); padding: 2px 10px; margin: 5px 0; }
  .tips li.tip-warn { border-left-color: #f2b84b; }
  .tips li.tip-good { border-left-color: #3fc9b0; }
  .tips li.tip-info { border-left-color: #8a9bad; }
  .clear-banner { border: 1px solid #f2b84b; border-left-width: 4px; border-radius: 4px; padding: 8px 14px; margin: 10px 0; background: var(--vscode-inputValidation-warningBackground, rgba(242, 184, 75, 0.12)); }
  .clear-banner ol { margin: 6px 0 6px 20px; padding: 0; }
  .clear-banner code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.2)); padding: 0 4px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8em; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  th { opacity: 0.65; font-weight: 600; text-transform: uppercase; font-size: 0.9em; letter-spacing: 0.03em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  @keyframes cell-flash { from { background: rgba(55,148,255,0.55); } to { background: transparent; } }
  td.flash { animation: cell-flash 1.6s ease-out; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
  .spin { display: inline-block; width: 0.8em; height: 0.8em; margin-right: 6px; vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
${GAUGE_CSS}
  [data-series] { transition: opacity 0.12s ease; }
  .hl-on [data-series]:not(.hl) { opacity: 0.18; }
  .hl-on rect.hl { fill-opacity: 1; opacity: 1; stroke: var(--vscode-foreground, #ccc); stroke-width: 1px; }
  .hl-on polyline.hl, .hl-on path.hl { stroke-width: 3px; }
  .hl-on circle.hl { r: 3.6px; }
  .hl-on .legend-item.hl { font-weight: 600; }
  .busy-overlay { display: none; position: fixed; inset: 0; z-index: 50; background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 82%, transparent); align-items: center; justify-content: center; }
  .busy-overlay.on { display: flex; }
  .busy-overlay .page-loading { height: auto; }
  .more-row td { text-align: center; padding: 10px; }
  .more-row button { cursor: pointer; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); border: 0; border-radius: 3px; padding: 5px 12px; }
  .page-hidden { display: none; }
  .page-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; height: 80vh; }
  .page-loading-text { opacity: 0.7; font-size: 1.05em; }
  .ping-icon { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #3fc9b0; box-shadow: 0 0 0 2px rgba(63,201,176,0.35); vertical-align: middle; }
  .ping-icon.ping-failed { background: #f2704f; box-shadow: 0 0 0 2px rgba(242,112,79,0.35); }
  .ping-row { opacity: 0.8; }
  .page-welcome { margin: 0 0 6px; font-size: 1.6em; font-weight: 600; text-align: center; }
  .page-loading .gauge-icon { font-size: 64px; margin: 0; }
  .dots::after { content: ''; display: inline-block; width: 1.2em; text-align: left; animation: dots 1.2s steps(1) infinite; }
  .turns-table th:nth-child(3), .turns-table tr:not(.totals) > td:nth-child(3) { text-align: center; padding-left: 2px; padding-right: 2px; }
  .turns-table th:nth-child(3) { text-overflow: clip; }
  .turns-table td.turn-arrow, .turns-table th.turn-arrow { text-align: center; font-size: 1.15em; color: color-mix(in srgb, var(--vscode-foreground) 60%, transparent); }
  .turns-table td.turn-arrow { width: 34px; overflow: hidden; padding-left: 0; padding-right: 0; }
  @keyframes arrow-fly { 0% { transform: translateX(-14px); opacity: 0; } 25% { opacity: 1; } 75% { opacity: 1; } 100% { transform: translateX(14px); opacity: 0; } }
  .arrow-fly { display: inline-block; color: #7f9bb8; animation: arrow-fly 1s ease-in-out infinite; }
  .turn-sub { opacity: 0.75; font-size: 0.85em; font-variant-numeric: tabular-nums; }
  .turn-subrow { display: flex; gap: 12px; margin-top: 2px; padding: 0 4px; border-radius: 3px; font-size: 0.85em; white-space: nowrap; }
  .turn-subcol { opacity: 0.85; font-variant-numeric: tabular-nums; }
  .turns-table td.cache-col, .turns-table th.cache-col { text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cache-val { margin: 1px 2px; padding: 0 4px; border-radius: 3px; font-size: 0.85em; }
  .turns-table { table-layout: fixed; }
  .turns-table td, .turns-table th { overflow: hidden; text-overflow: ellipsis; }
  /* Every turn row is two lines tall (value + sub-line), so a cell gaining its sub-line doesn't grow the row. */
  .turns-table tbody td { height: 2.9em; vertical-align: middle; white-space: nowrap; }
  .filter-th select { display: block; width: 100%; margin-top: 3px; font-size: 0.95em; text-transform: none; font-weight: normal; letter-spacing: 0; }
  /* White in every theme, so the two filters stand out from the table header. */
  .filter-th select, .filter-th input { background: #fff; color: #1e1e1e; border-color: #ccc; }
  .filter-th select option { background: #fff; color: #1e1e1e; }
  .range-custom { font-size: 0.8em; margin-bottom: 6px; display: flex; gap: 6px; align-items: center; }
  .range-custom input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); border-radius: 3px; padding: 2px 4px; }
  .turn-child { display: none; }
  .turn-child.open { display: table-row; }
  .turn-child > td:first-child { padding-left: 22px; }
  .chat-row td { font-weight: 600; background: rgba(55,148,255,0.07); }
  .hit-row { display: none; }
  .hit-row.open { display: table-row; }
  .hit-row td { background: rgba(128,128,128,0.07); }
  .hit-row td.hit-label { padding-left: 18px; opacity: 0.8; }
  tr[data-toggle] > td:first-child { cursor: pointer; }
  .chev { display: inline-block; width: 1.1em; margin-right: 2px; font-size: 1.35em; line-height: 1; vertical-align: -2px; opacity: 0.85; transition: transform 0.12s; }
  tr.open-turn .chev { transform: rotate(90deg); }
  .turns-scroll { max-height: 320px; overflow-y: auto; margin-bottom: 18px; }
  /* The header (with the Date and Repo filters) stays visible while the rows scroll under it. */
  /* Column labels and totals read as one wide, slightly darker band; only its bottom edge has a line. */
  .turns-table thead th { position: sticky; top: 0; z-index: 2; opacity: 1; color: #1e1e1e; background: #f2b84b; border-bottom: none; }
  .turns-table thead tr:first-child th:nth-child(n+4) { vertical-align: top; }
  .turns-table thead tr.totals td { position: sticky; top: var(--head-h, 2.6em); z-index: 2; background: #f2b84b; color: #1e1e1e; font-weight: 600; vertical-align: top; border-bottom: 1px solid var(--vscode-widget-border, #444); }
  .turns-table thead tr.totals td, .turns-table thead tr.totals td * { color: #000 !important; }
  .turns-table thead:not(:has(.totals)) th { border-bottom: 1px solid var(--vscode-widget-border, #444); }
.help { display: inline-block; margin-left: 4px; width: 1.25em; height: 1.25em; line-height: 1.25em; text-align: center; border: 1px solid var(--vscode-descriptionForeground, #888); border-radius: 50%; font-size: 0.72em; font-weight: normal; color: var(--vscode-descriptionForeground, #888); cursor: help; vertical-align: middle; }
  .turns-table thead .help { background: #fff; color: #1e1e1e; border-color: #1e1e1e; }
  .help:hover, .help:focus { color: var(--vscode-foreground); border-color: var(--vscode-foreground); outline: none; }
  .hover-tooltip { position: fixed; z-index: 1000; display: none; max-width: 520px; line-height: 1.35; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); padding: 4px 9px; border-radius: 4px; font-size: 0.78em; pointer-events: none; white-space: pre-wrap; font-weight: normal; text-align: left; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
  .filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
  .filters label { font-size: 0.78em; opacity: 0.7; display: flex; align-items: center; gap: 6px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #444); border-radius: 3px; padding: 3px 6px; font-size: 0.95em; }
  .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-widget-border, #444); }
  .tab { background: none; border: none; color: var(--vscode-foreground); opacity: 0.65; font-family: var(--vscode-font-family); font-size: 0.88em; padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { opacity: 0.9; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #7f9bb8); font-weight: 600; }
  .tips-btn { margin-left: auto; align-self: center; display: inline-flex; align-items: center; gap: 6px; background: none; border: 1px solid var(--vscode-widget-border, #555); border-radius: 4px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 0.85em; padding: 4px 12px; cursor: pointer; }
  .tips-btn:hover { border-color: #f2b84b; color: #f2b84b; }
  .tips-btn svg { width: 14px; height: 14px; }
  .tips-modal { display: none; position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.55); align-items: flex-start; justify-content: center; padding: 7vh 16px 16px; }
  .tips-modal.tips-open { display: flex; }
  .tips-card { position: relative; box-sizing: border-box; color: var(--vscode-foreground); width: 100%; max-width: 780px; max-height: 80vh; overflow: auto; background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e)); border: 1px solid var(--vscode-widget-border, #555); border-radius: 8px; padding: 6px 22px 18px; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
  .tips-card h2 { margin-top: 12px; }
  .tips-close { position: absolute; top: 8px; right: 12px; background: none; border: none; color: var(--vscode-foreground); font-size: 1.6em; line-height: 1; cursor: pointer; opacity: 0.7; }
  .tips-close:hover { opacity: 1; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
`;

/** Random nonce so a webview's inline script can run under a strict per-load CSP. */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let index = 0; index < 32; index += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** A small "?" next to a label; hovering (or focusing) it shows `text` through the delegated tooltip below. */
/** The lightbulb of the Tips button. */
export const TIPS_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.4 8.3c.3.2.4.5.4.8v.9h4v-.9c0-.3.1-.6.4-.8A4.5 4.5 0 0 0 8 1.5z"/></svg>';

export function helpIcon(text: string): string {
  return `<span class="help" tabindex="0" data-tooltip="${escapeHtml(text)}">?</span>`;
}

/**
 * Delegated hover-tooltip behavior for any element carrying `data-tooltip`: a single
 * floating element that follows the cursor, instead of the browser's native `title`
 * (slow to appear, unstyled, and invisible on SVG in some webview builds).
 */
export const HOVER_TOOLTIP_SCRIPT = `
(function () {
  const tip = document.createElement('div');
  tip.className = 'hover-tooltip';
  document.body.appendChild(tip);
  function place(event) {
    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    const rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  document.addEventListener('mouseover', function (event) {
    const target = event.target.closest('[data-tooltip]');
    if (!target) return;
    tip.textContent = target.getAttribute('data-tooltip');
    tip.style.display = 'block';
    place(event);
  });
  document.addEventListener('mousemove', function (event) {
    if (tip.style.display === 'block') place(event);
  });
  document.addEventListener('mouseout', function (event) {
    const target = event.target.closest('[data-tooltip]');
    if (!target) return;
    const to = event.relatedTarget;
    if (!(to && to.closest && to.closest('[data-tooltip]') === target)) {
      tip.style.display = 'none';
    }
  });
})();`;

/**
 * Excel-style highlight for charts: hovering a bar segment, a line, a point or a legend entry
 * lights up everything of the same `data-series` inside its chart (`[data-chart-scope]`, else
 * the svg) and dims the rest.
 */
export const CHART_HIGHLIGHT_SCRIPT = `
(function () {
  let scope = null;
  let name = null;
  function clear() {
    if (!scope) return;
    scope.classList.remove('hl-on');
    scope.querySelectorAll('.hl').forEach(function (el) { el.classList.remove('hl'); });
    scope = null; name = null;
  }
  document.addEventListener('mouseover', function (event) {
    const target = event.target.closest && event.target.closest('[data-series]');
    if (!target) { clear(); return; }
    const next = target.closest('[data-chart-scope]') || target.closest('svg');
    const series = target.getAttribute('data-series');
    if (next === scope && series === name) return;
    clear();
    if (!next) return;
    scope = next; name = series;
    next.classList.add('hl-on');
    next.querySelectorAll('[data-series]').forEach(function (el) {
      if (el.getAttribute('data-series') === series) el.classList.add('hl');
    });
  });
  document.addEventListener('mouseleave', clear);
})();`;

/**
 * Wrap body markup in an HTML document. Pass `nonce`/`script` together to allow one
 * inline script under a strict per-load CSP (`script-src 'nonce-<nonce>'`); omit both
 * to keep the document script-free, as it was before 2.2.
 */
export function htmlDocument(title: string, body: string, interactive?: { nonce: string; script: string }): string {
  const scriptSrc = interactive ? ` script-src 'nonce-${interactive.nonce}';` : '';
  const scriptTag = interactive ? `\n<script nonce="${interactive.nonce}">${interactive.script}</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:;${scriptSrc}">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLES}</style>
</head>
<body>
${body}${scriptTag}
</body>
</html>`;
}
