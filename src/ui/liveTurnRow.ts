/**
 * The "Last turns" row of a prompt that is still in flight. Kept free of `vscode`
 * imports so it can be unit tested.
 */

import { InFlightProject, InFlightStage } from '../analytics/inflight';
import { COLORS, compact, escapeHtml, formatShare, processingIcon } from './shared';

/** Green when a number is a saving, amber when it is not. Red is reserved for cache writes. */
export function savingsTone(value: number): string {
  return value >= 0 ? COLORS.good : COLORS.warn;
}

/** YYYY-MM-DD HH:MM:SS (local) of the newest hit; an in-flight hit that started later wins. */
export function timeCell(lastAt: number | undefined, liveSince?: number, toggle = false, withDate = true): string {
  const at = Math.max(lastAt ?? 0, liveSince ?? 0);
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  // The tooltip repeats the full local date and time in the user's locale format.
  const title = at ? ` title="${d.toLocaleString()}"` : '';
  const chev = toggle ? '<span class="chev">▸</span>' : '';
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const stamp = withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}` : clock;
  return `<td${title}>${chev}${at ? stamp : '—'}</td>`;
}

/** Status label of a live row; the spinner and trailing dots animate in CSS. */

/** CR, CW, RI and Out have no figures until Anthropic answers. */
const CACHE_PLACEHOLDER = '<td class="cache-col">—</td>'.repeat(4);

/** Settled rows leave the handoff column empty; only a request on its way to Anthropic shows the arrow. */
export const ARROW_CELL = '<td class="turn-arrow"></td>';

/** The arrow flies left to right (CSS) while the optimized request is out and the answer has not come back. */
export const ARROW_FLYING_CELL = '<td class="turn-arrow"><span class="arrow-fly" title="Sent to Anthropic, waiting for the answer">→</span></td>';

/** What the summaries of a set of hits did: how many hits, and the tokens they kept out of the request. */
export interface SummaryUse {
  hits: number;
  /** Request size before the summary (0 when unknown, as on a live row). */
  before: number;
  pruned: number;
  /** What a model charged for writing them, in units: only rows up to 1 Nov 2026 (Haiku) have one. 0 for a summary the proxy built and for a reused one. */
  costUnits: number;
}

/**
 * The single "Summarized" cell: `✓ new` when a hit got a summary (the proxy builds it itself, with no model and no cost),
 * `↻ reused` when it picked up one built earlier, `·` when nothing was summarized. The numbers behind
 * the mark live in the tooltip, so the column answers "did it summarize?" at a glance.
 */
export function summaryColumnCell(created: SummaryUse, reused: SummaryUse, skippedReason?: string): string {
  if (created.hits === 0 && reused.hits === 0) {
    const why = skippedReason ? `: ${skippedReason}` : '';
    return `<td class="num"><span class="muted" title="${escapeHtml(`No summary on this request${why}`)}">·</span></td>`;
  }
  const saved = (use: SummaryUse): string =>
    use.before > 0
      ? `${compact(use.before)} → ${compact(use.before - use.pruned)} t (−${formatShare(use.pruned, use.before)})`
      : `−${compact(use.pruned)} t`;
  const label = (mark: string, word: string, use: SummaryUse): string => `${mark} ${use.hits > 1 ? `${use.hits} ` : ''}${word}`;
  const lines: string[] = [];
  if (created.hits > 0) {
    // Only rows up to 1 Nov 2026 carry a cost: Haiku wrote those summaries. The proxy builds them itself since.
    const title =
      created.costUnits > 0
        ? `A model wrote ${created.hits} summary(ies): ${saved(created)}. Cost ${compact(created.costUnits)} u, in Billed.`
        : `The proxy built ${created.hits} summary(ies) itself: ${saved(created)}. No model, no cost.`;
    lines.push(`<div style="color:${savingsTone(created.pruned)}" title="${escapeHtml(title)}">${label('✓', 'new', created)}</div>`);
  }
  if (reused.hits > 0) {
    const title = `Reused ${reused.hits} stored summary(ies): ${saved(reused)}. Nothing new to build.`;
    lines.push(`<div style="color:${savingsTone(reused.pruned)}" title="${escapeHtml(title)}">${label('↻', 'reused', reused)}</div>`);
  }
  return `<td class="num">${lines.join('')}</td>`;
}

/** Sums of what in-flight requests already measured; zeros while nothing got past optimization. */
export function pendingTotals(live: InFlightProject | undefined) {
  // `known` flags which stages at least one request has reported, so a live row can fill column by column.
  const totals = { raw: 0, pruned: 0, compacted: 0, reused: 0, compactedHits: 0, reusedHits: 0, sent: 0, known: { raw: false, pruned: false, compacted: false, sent: false } };
  for (const p of live?.preflight ?? []) {
    totals.raw += p.rawTokens ?? 0;
    totals.pruned += p.prunedByNormalization ?? 0;
    // A summary written by this hit is Compression; one written earlier is Reused.
    if (p.summaryCreated === true) {
      totals.compacted += p.prunedByCompaction ?? 0;
      totals.compactedHits += 1;
    } else {
      totals.reused += p.prunedByCompaction ?? 0;
      if ((p.prunedByCompaction ?? 0) > 0) {
        totals.reusedHits += 1;
      }
    }
    totals.sent += p.optimizedTokens ?? 0;
    totals.known.raw ||= p.rawTokens !== undefined;
    totals.known.pruned ||= p.prunedByNormalization !== undefined;
    totals.known.compacted ||= p.prunedByCompaction !== undefined;
    totals.known.sent ||= p.optimizedTokens !== undefined;
  }
  return totals;
}

/**
 * A new prompt whose first hit has not come back. Each column fills in as soon as its
 * number exists: raw → sent once optimization ends, received/billed once the upstream answers.
 */
export function liveRow(project: string, live: InFlightProject, ordinal: number | string, chatId?: string): string {
  const key = `${escapeHtml(project)}#${ordinal}`;
  const child = chatId ? ` turn-child" data-parent="${escapeHtml(chatId)}` : '';
  return (
    `<tr class="turn-live${child}" data-row="${key}" data-toggle="${key}">${timeCell(undefined, live.since, true)}<td>${escapeHtml(project)}</td><td>${processingIcon(key)}</td><td class="num">1</td><td class="num">${live.count}</td><td></td>\n    ${liveCells(live)}</tr>` +
    liveHitRows(key, live, chatId)
  );
}

/** One sub-row per request still in flight, so the hits of a live turn add up to its row. */
export function liveHitRows(turnKey: string, live: InFlightProject, chatId?: string): string {
  const ancestors = chatId ? ` data-ancestors="${escapeHtml(chatId)}"` : '';
  let rows = '';
  for (let i = 0; i < live.count; i += 1) {
    const stage: InFlightStage | undefined = live.preflight[i];
    const one: InFlightProject = { count: 1, newTurn: false, since: live.since, preflight: stage ? [stage] : [] };
    rows += `<tr class="hit-row turn-live" data-row="${turnKey}/L${i}" data-parent="${turnKey}"${ancestors}><td></td><td class="hit-label">↳ hit</td><td>${processingIcon(`${turnKey}/L${i}`)}</td><td></td><td class="num">1</td><td></td>\n    ${liveCells(one)}</tr>`;
  }
  return rows;
}

/** Raw → … → billed cells of a live row; each fills in as its figure is reported. */
function liveCells(live: InFlightProject): string {
  const empty = '<td class="num">—</td>';
  const p = pendingTotals(live);
  const afterCleanup = p.raw - p.pruned;
  const step = (known: boolean, value: number, pruned: number, base: number): string =>
    known
      ? `<td class="num">${compact(value)}<div class="turn-sub" style="color:${savingsTone(pruned)}">−${compact(pruned)} (${formatShare(pruned, base)})</div></td>`
      : empty;
  // Each figure shows the moment the pipeline reports it, not when the whole request is optimized.
  const rawCell = p.known.raw ? `<td class="num">${compact(p.raw)}</td>` : empty;
  const cleanupCell = step(p.known.raw && p.known.pruned, afterCleanup, p.pruned, p.raw);
  const compactionKnown = p.known.raw && p.known.pruned && p.known.compacted;
  // Nothing is claimed under Summarized until the compaction stage has reported.
  const summaryCell = compactionKnown
    ? summaryColumnCell(
        { hits: p.compactedHits, before: 0, pruned: p.compacted, costUnits: 0 },
        { hits: p.reusedHits, before: 0, pruned: p.reused, costUnits: 0 }
      )
    : empty;
  const sentCell = p.known.sent ? `<td class="num">${compact(p.sent)}</td>` : empty;
  return `${rawCell}${cleanupCell}${summaryCell}${sentCell}${p.known.sent ? ARROW_FLYING_CELL : ARROW_CELL}${empty}${CACHE_PLACEHOLDER}${empty}`;
}
