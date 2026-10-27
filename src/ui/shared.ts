/**
 * Presentation helpers shared by the budget dashboard and the Token Improver
 * analytics panel, so both webviews read as one extension.
 */

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
  good: '#3fb950',
  info: '#3794ff',
  warn: '#e2a336',
  bad: '#f14c4c',
  muted: '#8b8b8b',
  accent: '#c586c0',
  teal: '#4ec9b0',
};

export const CATEGORICAL_PALETTE = [
  COLORS.info,
  COLORS.good,
  COLORS.warn,
  COLORS.accent,
  COLORS.teal,
  COLORS.bad,
  '#d7ba7d',
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
export const BASE_STYLES = `
  body { font-family: var(--vscode-font-family); font-size: 14px; color: var(--vscode-foreground); padding: 18px 22px 32px; }
  h1 { font-size: 1.15em; margin: 0 0 2px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { font-size: 0.95em; margin: 26px 0 10px; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 6px; }
  .subtitle { opacity: 0.7; font-size: 0.8em; margin-bottom: 16px; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.72em; font-weight: 600; color: #111; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .head .donut-row { margin: 0; }
  .top { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
  .donut { width: 150px; height: 150px; flex: 0 0 auto; }
  .donut-value { font-size: 22px; font-weight: 700; fill: var(--vscode-foreground); }
  .donut-mini { width: 34px; height: 34px; flex: 0 0 auto; }
  .donut-figure { font-size: 0.85em; font-weight: 700; line-height: 1.1; }
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
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.75em; opacity: 0.8; margin-top: 2px; }
  .legend-item { display: inline-flex; align-items: center; gap: 5px; }
  .axis { font-size: 10px; fill: var(--vscode-descriptionForeground, #999); }
  .bar-row { display: grid; grid-template-columns: 210px 1fr 150px; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-name { font-size: 0.82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .bar-track { background: var(--vscode-input-background, #2a2a2a); border-radius: 4px; height: 14px; overflow: hidden; border: 1px solid var(--vscode-widget-border, #444); }
  .bar-fill { height: 100%; }
  .bar-value { font-size: 0.78em; text-align: right; opacity: 0.85; }
  .tier { font-size: 0.72em; padding: 1px 6px; border-radius: 8px; color: #111; font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
  .stacked { display: flex; height: 18px; border-radius: 4px; overflow: hidden; margin-bottom: 14px; border: 1px solid var(--vscode-widget-border, #444); }
  .stacked div { height: 100%; }
  .alert { padding: 8px 12px; border-radius: 4px; margin-bottom: 6px; font-size: 0.82em; border-left: 3px solid; }
  .alert.critical { background: rgba(241,76,76,0.12); border-color: #f14c4c; }
  .alert.warning { background: rgba(226,163,54,0.12); border-color: #e2a336; }
  .alert.info { background: rgba(55,148,255,0.12); border-color: #3794ff; }
  ul { margin: 0; padding-left: 18px; font-size: 0.82em; line-height: 1.6; }
  .empty { opacity: 0.6; font-style: italic; font-size: 0.85em; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8em; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  th { opacity: 0.65; font-weight: 600; text-transform: uppercase; font-size: 0.9em; letter-spacing: 0.03em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  @keyframes cell-flash { from { background: rgba(55,148,255,0.55); } to { background: transparent; } }
  td.flash { animation: cell-flash 1.6s ease-out; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
  .spin { display: inline-block; width: 0.8em; height: 0.8em; margin-right: 6px; vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .dots::after { content: ''; display: inline-block; width: 1.2em; text-align: left; animation: dots 1.2s steps(1) infinite; }
  .turns-table td.turn-arrow, .turns-table th.turn-arrow { text-align: center; font-size: 1.15em; color: color-mix(in srgb, var(--vscode-foreground) 60%, transparent); }
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
  .turns-table thead th { position: sticky; top: 0; z-index: 2; opacity: 1; color: color-mix(in srgb, var(--vscode-foreground) 65%, transparent); background: color-mix(in srgb, var(--vscode-editor-background) 86%, black); border-bottom: none; }
  .turns-table thead tr.totals td { position: sticky; top: var(--head-h, 2.6em); z-index: 2; background: color-mix(in srgb, var(--vscode-editor-background) 86%, black); font-weight: 600; vertical-align: top; border-bottom: 1px solid var(--vscode-widget-border, #444); }
  .turns-table thead:not(:has(.totals)) th { border-bottom: 1px solid var(--vscode-widget-border, #444); }
.help { display: inline-block; margin-left: 4px; width: 1.25em; height: 1.25em; line-height: 1.25em; text-align: center; border: 1px solid var(--vscode-descriptionForeground, #888); border-radius: 50%; font-size: 0.72em; font-weight: normal; color: var(--vscode-descriptionForeground, #888); cursor: help; vertical-align: middle; }
  .help:hover, .help:focus { color: var(--vscode-foreground); border-color: var(--vscode-foreground); outline: none; }
  .hover-tooltip { position: fixed; z-index: 1000; display: none; max-width: 340px; line-height: 1.35; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); padding: 4px 9px; border-radius: 4px; font-size: 0.78em; pointer-events: none; white-space: normal; font-weight: normal; text-align: left; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
  .filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
  .filters label { font-size: 0.78em; opacity: 0.7; display: flex; align-items: center; gap: 6px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #444); border-radius: 3px; padding: 3px 6px; font-size: 0.95em; }
  .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-widget-border, #444); }
  .tab { background: none; border: none; color: var(--vscode-foreground); opacity: 0.65; font-family: var(--vscode-font-family); font-size: 0.88em; padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { opacity: 0.9; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #3794ff); font-weight: 600; }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';${scriptSrc}">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLES}</style>
</head>
<body>
${body}${scriptTag}
</body>
</html>`;
}
