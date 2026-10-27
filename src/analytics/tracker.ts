/**
 * The Analytics Tracker: turns one proxied turn into Normalized Cost Units, then
 * appends it to a durable on-disk ledger that survives editor restarts.
 *
 * Cost model (all figures in NCUs, where 1.0 NCU is one Sonnet input token):
 *
 *   Baseline Unit Cost = rawTokens * originalModelWeight            (no client caching known)
 *                      + outputTokens * originalModelOutputWeight
 *   or, when the client caches (baselineCachedTokens known):
 *                      = cached * weight * 0.10 + (rawTokens - cached) * weight * 1.25
 *                      + outputTokens * originalModelOutputWeight
 *   Actual Unit Cost   = uncachedInput * actualWeight
 *                      + cacheWrite    * actualWeight * 1.25
 *                      + cacheRead     * actualWeight * 0.10
 *                      + outputTokens  * actualModelOutputWeight
 *                      + summarizerInputTokens  * haikuWeight
 *                      + summarizerOutputTokens * haikuOutputWeight
 *   Savings %          = (1 - actual / baseline) * 100
 *
 * Baseline is deliberately the *unoptimized* request on the *originally requested*
 * model with no cache, so the percentage answers "what did the middleware buy me".
 * Output tokens are the same count on both sides (nothing about generation length
 * is optimized) but priced at each side's own model rate, so a downgrade's effect
 * on output pricing shows up too, not just its effect on input pricing. The
 * compaction summarizer's own Haiku call (3.2) is real spend the optimizer alone
 * caused — it belongs only on the *actual* side; the baseline scenario never runs
 * compaction, so it never pays for a summary either.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CacheMultipliers,
  cacheMultipliers,
  modelOutputWeight,
  modelWeight,
  usdPerNormalizedUnit,
} from '../proxy/pricing';
import { CompactionDecision, HAIKU_MODEL_ID, OptimizationTelemetry } from '../proxy/optimizer';

/** Filename of the single-file ledger used before monthly files; migrated on first load, then kept as a backup. */
export const LEDGER_FILENAME = 'claude_token_improver_history.json';

/** Directory (inside the global storage directory) holding one append-only `YYYY-MM.jsonl` file per local month. */
export const LEDGER_DIRNAME = 'ledger';

/** Per-day totals of the months whose raw rows were dropped. */
export const SUMMARY_FILENAME = 'daily-summary.json';

/** Summary file format version, so a future shape change can migrate rather than crash. */
const SUMMARY_VERSION = 1;

/** Raw rows are kept for the current local month and this many months before it; older months become daily summaries. */
const RAW_MONTHS_KEPT_BEFORE_CURRENT = 1;

/**
 * Share of the previous request's prefix a real client still reads from cache. 1.0 is a
 * client whose prefix never changes (the floor); 0.97 was measured over 3,831 turns of
 * Claude Code run without the proxy (2026-10-21, F-03 in `latest/findings.md`). Applied to
 * the floor's cached tokens it lands within ~8% of what the client paid, on half of that
 * data held out of the fit.
 */
export const CLIENT_PREFIX_REUSE = 0.97;

/** The `usage` object as returned by the Messages API. */
export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Cache writes split by lifetime; the 1 hour share bills at 2x instead of 1.25x. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Tokens of this response's cache write that went to the 1 hour cache (0 when not reported). */
export function cacheWrite1hTokens(usage: ApiUsage | undefined): number {
  return Math.max(0, usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0);
}

export interface LedgerEntry {
  /** ISO-8601 timestamp of the turn. */
  timestamp: string;
  /** Workspace folder name the turn was issued from, or 'unknown'. */
  project: string;
  requestedModel: string;
  servedModel: string;
  modelSwapped: boolean;
  /** Why the router did or did not downgrade the model. Optional: older ledgers have none. */
  routingReason?: string;
  rawTokens: number;
  optimizedTokens: number;
  prunedByNormalization: number;
  prunedByCompaction: number;
  compactionTriggered: boolean;
  /**
   * Tokens of the original request that the client's own caching would have read at
   * 0.10x (see `OptimizationTelemetry.baselineCachedTokens`). Optional: absent on
   * rows recorded before the baseline modelled client caching.
   */
  baselineCachedTokens?: number;
  /**
   * What this turn would have cost with no proxy and the best possible client cache (it
   * stays valid for the full hour and writes at the cheap 1.25x), so `1 - actual / floor` is the least
   * the proxy saved. Absent on rows recorded before the floor existed.
   */
  floorBaselineUnitCost?: number;
  /** The same turn with the client reusing `CLIENT_PREFIX_REUSE` of its previous prefix: the typical case, not a bound. Written with the floor. */
  centralBaselineUnitCost?: number;
  /** Cache lifetime the client asked for (300000 = 5 min, 3600000 = 1 h); absent before it was recorded. */
  clientCacheTtlMs?: number;
  /** True when `rawTokens` came from `count_tokens`, false for the local estimate. Absent on older rows. */
  rawTokensExact?: boolean;
  /**
   * True when this hit reused summaries the proxy already paid for, with no Haiku
   * call (`compactionTriggered` counts summarizer calls only). Optional: ledgers
   * written before summaries were stored have no such turns.
   */
  summaryReused?: boolean;
  /**
   * Economics gate inputs and estimate (NCU) when compaction was evaluated, to compare
   * against the real cost of later turns. Optional: absent on older rows and on turns
   * that never reached the gate.
   */
  compactionEconomics?: CompactionDecision;
  /** Why a history that reached the threshold was not summarized. */
  compactionSkippedReason?: string;
  /** History size the compaction gate measured, and the size at which it fires. Optional: absent on older rows and on hits that never reached the gate. */
  historyTokens?: number;
  compactionTriggerTokens?: number;
  cacheAnchorPlaced: boolean;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  /** Part of `cacheWriteTokens` written to the 1 hour cache (billed 2x). Absent before it was recorded. */
  cacheWrite1hTokens?: number;
  cacheReadTokens: number;
  outputTokens: number;
  /**
   * Billed units per kind, frozen when the turn was recorded (model weight and the 1h write rate
   * included), so the panel shows what was charged and not a recomputation with today's prices.
   * Absent on older rows; `entryUnits` derives them.
   */
  cacheReadUnits?: number;
  cacheWriteUnits?: number;
  regularInputUnits?: number;
  outputUnits?: number;
  /** Cache multipliers of the served model when the turn was priced; absent on older rows. */
  cacheMultipliers?: CacheMultipliers;
  baselineUnitCost: number;
  actualUnitCost: number;
  savingsPercent: number;
  /** What cacheWriteTokens + cacheReadTokens would have cost with no caching at all. */
  cacheNoCacheUnitCost: number;
  /** What cacheWriteTokens + cacheReadTokens actually cost with the 1.25x/0.10x multipliers. */
  cacheActualUnitCost: number;
  /** Cost of the Haiku call that produced the compaction manifest, already folded into `actualUnitCost`. Zero when compaction didn't run. */
  summarizerUnitCost: number;
  /** True when a `*caveman*` skill folder was found under `~/.claude/skills` at activation. */
  cavemanAvailable: boolean;
  /**
   * True when this hit opened a new user turn, false when it continued the
   * previous one (a tool-result round trip).
   *
   * Persisted so the "Last turn" window can be rebuilt from the ledger after a
   * reload. Optional because ledgers written before this field existed have no
   * turn boundaries; `lastTurnEntries` falls back to the final hit for those.
   */
  newUserTurn?: boolean;
  /** Last messages of a request that opened a turn (see `describeTail`); absent on continuations and older rows. */
  newTurnShape?: string;
  /**
   * Upstream HTTP status of this hit, or 0 when it never reached the server. Optional:
   * rows recorded before the table showed failures have none and count as succeeded.
   */
  status?: number;
  /** Why a status-0 hit never reached the server (network error and cause code). */
  failure?: string;
  /**
   * `accountUuid` of the Claude account signed in when the turn ran. Optional: rows
   * recorded before accounts were tracked have none, and belong to no known account.
   */
  accountId?: string;
}

export interface TurnCost {
  baselineUnitCost: number;
  /** Best-case-client baseline; undefined when the client's caching was not modelled for this turn. */
  floorBaselineUnitCost?: number;
  centralBaselineUnitCost?: number;
  actualUnitCost: number;
  savingsPercent: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** Billed units per kind of input and for the output, at the served model's weight; they add up to `actualUnitCost` minus the summary. */
  cacheReadUnits: number;
  cacheWriteUnits: number;
  regularInputUnits: number;
  outputUnits: number;
  /** The cache multipliers of the served model that priced this turn, from the pricing table. */
  cacheMultipliers: CacheMultipliers;
  /**
   * What the cache-write and cache-read tokens would have cost at the plain,
   * uncached rate (both priced 1x instead of 1.25x/0.10x) — the "if caching were
   * off" comparison for just the tokens caching actually touched.
   */
  cacheNoCacheUnitCost: number;
  /** Those same tokens at their real, multiplier-adjusted price. */
  cacheActualUnitCost: number;
  /** Cost of the compaction summarizer's own Haiku call, already folded into `actualUnitCost`. Zero when compaction didn't run. */
  summarizerUnitCost: number;
}

/**
 * Compute the Normalized Cost Units for a single turn.
 *
 * When the API reports no usage at all (a streaming error, or a request that never
 * reached the server), actual cost falls back to the optimized token estimate so
 * the ledger records something honest rather than a free turn.
 */
export function computeTurnCost(telemetry: OptimizationTelemetry, usage: ApiUsage | undefined): TurnCost {
  const baselineWeight = modelWeight(telemetry.originalModel);
  const actualWeight = modelWeight(telemetry.effectiveModel);
  const baselineOutputWeight = modelOutputWeight(telemetry.originalModel);
  const actualOutputWeight = modelOutputWeight(telemetry.effectiveModel);
  // Cache rates of each side's own model, read from the pricing table.
  const baselineCache = cacheMultipliers(telemetry.originalModel);
  const actualCache = cacheMultipliers(telemetry.effectiveModel);

  // No `usage` means Anthropic never answered (status 0, a cut stream). Nothing is known about
  // billing, so the local estimate is not charged as if it had been: the turn counts for neither
  // side of the savings figure. Only the summarizer's Haiku call, which did return, is still paid.
  const uncachedInputTokens = usage ? usage.input_tokens ?? telemetry.optimizedTokens : 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite1h = Math.min(cacheWriteTokens, cacheWrite1hTokens(usage));
  const outputTokens = usage?.output_tokens ?? 0;

  // With the client's own caching modelled (`baselineCachedTokens`), the baseline is that
  // request as Claude Code would have sent it alone: the still-cached prefix read at
  // 0.10x and the growth written at 1.25x. Without it (older ledgers, clients that do
  // not cache) it stays the plain uncached price.
  const baselineCached = telemetry.baselineCachedTokens;
  const baselineInputCost =
    baselineCached === undefined
      ? telemetry.rawTokens * baselineWeight
      : baselineCached * baselineWeight * baselineCache.read +
        Math.max(0, telemetry.rawTokens - baselineCached) * baselineWeight * baselineCache.write;
  const baselineUnitCost = usage ? baselineInputCost + outputTokens * baselineOutputWeight : 0;

  // The floor: the same request, but the client's cache holds the whole previous prefix for up to an hour. No
  // real client does better, so whatever the proxy saves against it is a lower bound.
  // A client that does not cache at all already has the plain price as its best case.
  const floorCached = telemetry.floorCachedTokens;
  const floorBaselineUnitCost = !usage
    ? 0
    : floorCached !== undefined
      ? floorCached * baselineWeight * baselineCache.read +
        Math.max(0, telemetry.rawTokens - floorCached) * baselineWeight * baselineCache.write +
        outputTokens * baselineOutputWeight
      : baselineCached === undefined
        ? baselineUnitCost
        : undefined;
  const centralBaselineUnitCost = !usage
    ? 0
    : floorCached !== undefined
      ? floorCached * CLIENT_PREFIX_REUSE * baselineWeight * baselineCache.read +
        Math.max(0, telemetry.rawTokens - floorCached * CLIENT_PREFIX_REUSE) * baselineWeight * baselineCache.write +
        outputTokens * baselineOutputWeight
      : floorBaselineUnitCost;

  const cacheActualUnitCost =
    (cacheWriteTokens - cacheWrite1h) * actualWeight * actualCache.write +
    cacheWrite1h * actualWeight * actualCache.write1h +
    cacheReadTokens * actualWeight * actualCache.read;
  const cacheNoCacheUnitCost = (cacheWriteTokens + cacheReadTokens) * actualWeight;

  // Always priced at Haiku's own rate: the summarizer is a fixed-model call the
  // optimizer makes on its own, independent of whichever model this turn used.
  const summarizerUsage = telemetry.summarizerUsage;
  const summarizerUnitCost = summarizerUsage
    ? summarizerUsage.inputTokens * modelWeight(HAIKU_MODEL_ID) + summarizerUsage.outputTokens * modelOutputWeight(HAIKU_MODEL_ID)
    : 0;

  const cacheReadUnits = cacheReadTokens * actualWeight * actualCache.read;
  const cacheWriteUnits = cacheActualUnitCost - cacheReadUnits;
  const regularInputUnits = uncachedInputTokens * actualWeight;
  const outputUnits = outputTokens * actualOutputWeight;
  const actualUnitCost = regularInputUnits + cacheActualUnitCost + outputUnits + summarizerUnitCost;

  // A zero baseline means there was nothing to save; report 0% rather than dividing by zero.
  const savingsPercent = baselineUnitCost > 0 ? (1 - actualUnitCost / baselineUnitCost) * 100 : 0;

  return {
    baselineUnitCost,
    floorBaselineUnitCost,
    centralBaselineUnitCost,
    actualUnitCost,
    savingsPercent,
    uncachedInputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: cacheWrite1h,
    cacheReadTokens,
    outputTokens,
    cacheReadUnits,
    cacheWriteUnits,
    regularInputUnits,
    outputUnits,
    cacheMultipliers: actualCache,
    cacheNoCacheUnitCost,
    cacheActualUnitCost,
    summarizerUnitCost,
  };
}

/**
 * Input tokens Anthropic actually received: regular + cache write + cache read, from
 * the API's own `usage`. Unlike `optimizedTokens` (a local estimate that runs low),
 * this is the real size of the request that left the machine.
 */
export function sentTokens(entry: { uncachedInputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number }): number {
  return (entry.uncachedInputTokens ?? 0) + (entry.cacheWriteTokens ?? 0) + (entry.cacheReadTokens ?? 0);
}

/**
 * Re-bases the optimizer's estimated sizes on what Anthropic actually received. The
 * local estimator is accurate on plain history but misjudges the dense tool output a
 * summary replaces (a 270.9K request measured 84.7K sent against 148.2K estimated), so
 * the tokens "pruned by compaction" are whatever the raw size lost beyond normalization
 * and the real sent size. With no `usage` (failed request) the estimates stand.
 */
export function reconcileWithUsage(
  entry: { rawTokens: number; prunedByNormalization: number; prunedByCompaction: number; optimizedTokens: number; compactionTriggered: boolean; summaryReused?: boolean },
  usage: { uncachedInputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number } | undefined
): { optimizedTokens: number; prunedByCompaction: number } {
  const sent = usage ? sentTokens(usage) : 0;
  if (sent <= 0) {
    return { optimizedTokens: entry.optimizedTokens, prunedByCompaction: entry.prunedByCompaction };
  }
  const compacted = entry.compactionTriggered || entry.summaryReused === true;
  return {
    optimizedTokens: sent,
    prunedByCompaction: compacted
      ? Math.max(0, entry.rawTokens - entry.prunedByNormalization - sent)
      : entry.prunedByCompaction,
  };
}

type UsageLike = { uncachedInputTokens?: number; cacheWriteTokens?: number; cacheWrite1hTokens?: number; cacheReadTokens?: number; summarizerUnitCost?: number };

/**
 * What the sent tokens actually billed at, applying the 0.10x read / 1.25x write
 * multipliers directly to the real API usage — no assumption about what a client
 * without the proxy would or wouldn't have cached on its own. The compaction
 * summarizer's own Haiku call is real spend too, so it is counted here.
 */
export function billedUnits(entry: UnitsInput): number {
  const units = entryUnits(entry);
  return units.read + units.write + units.regular + (entry.summarizerUnitCost ?? 0);
}

/**
 * The units each kind of token billed. Read from the row when it was recorded with them; older rows
 * are rebuilt from their tokens at the served model's current weight, and the output is whatever
 * the invoice figure leaves after the rest.
 */
export function entryUnits(entry: UnitsInput): { read: number; write: number; regular: number; output: number } {
  const weight = modelWeight(entry.servedModel);
  const rates = entry.cacheMultipliers ?? cacheMultipliers(entry.servedModel);
  const write1h = entry.cacheWrite1hTokens ?? 0;
  const read = entry.cacheReadUnits ?? (entry.cacheReadTokens ?? 0) * rates.read * weight;
  const write =
    entry.cacheWriteUnits ??
    (((entry.cacheWriteTokens ?? 0) - write1h) * rates.write + write1h * rates.write1h) * weight;
  const regular = entry.regularInputUnits ?? (entry.uncachedInputTokens ?? 0) * weight;
  const output = entry.outputUnits ?? Math.max(0, (entry.actualUnitCost ?? 0) - (entry.summarizerUnitCost ?? 0) - read - write - regular);
  return { read, write, regular, output };
}

/**
 * The kinds of cache token of this hit that were left without units because the pricing table had no
 * rate for them. Only kinds the hit actually used count: a missing 1h rate is irrelevant to a hit
 * that wrote nothing to the 1h cache.
 */
export function unpricedKinds(
  entry: Pick<LedgerEntry, 'servedModel' | 'cacheMultipliers' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheWrite1hTokens'>
): Array<'read' | 'write'> {
  const missing = (entry.cacheMultipliers ?? cacheMultipliers(entry.servedModel)).unpriced ?? [];
  const write1h = entry.cacheWrite1hTokens ?? 0;
  const kinds: Array<'read' | 'write'> = [];
  if (missing.includes('read') && (entry.cacheReadTokens ?? 0) > 0) {
    kinds.push('read');
  }
  if ((missing.includes('write') && (entry.cacheWriteTokens ?? 0) - write1h > 0) || (missing.includes('write1h') && write1h > 0)) {
    kinds.push('write');
  }
  return kinds;
}

type UnitsInput = UsageLike &
  Partial<
    Pick<LedgerEntry, 'servedModel' | 'cacheMultipliers' | 'cacheReadUnits' | 'cacheWriteUnits' | 'regularInputUnits' | 'outputUnits' | 'actualUnitCost'>
  >;

/** Convert Normalized Cost Units to dollars for display. */
export function unitsToUsd(units: number): number {
  return units * usdPerNormalizedUnit();
}

/**
 * Ledgers written before the cache cost fields existed lack them, and summing
 * `undefined` turns every cache total into NaN. Recompute them from the entry's
 * own cache token counts and served model — the same formula `computeTurnCost` uses.
 */
export function backfillCacheCosts(entry: LedgerEntry): LedgerEntry {
  if (typeof entry.cacheNoCacheUnitCost === 'number' && typeof entry.cacheActualUnitCost === 'number') {
    return entry;
  }
  const weight = modelWeight(entry.servedModel);
  const rates = entry.cacheMultipliers ?? cacheMultipliers(entry.servedModel);
  const cacheWriteTokens = entry.cacheWriteTokens ?? 0;
  const cacheReadTokens = entry.cacheReadTokens ?? 0;
  const write1h = entry.cacheWrite1hTokens ?? 0;
  return {
    ...entry,
    cacheNoCacheUnitCost: (cacheWriteTokens + cacheReadTokens) * weight,
    cacheActualUnitCost:
      ((cacheWriteTokens - write1h) * rates.write + write1h * rates.write1h + cacheReadTokens * rates.read) * weight,
  };
}

/** Totals of one local day for one account, project and served model, kept after the raw rows of its month are dropped. */
export interface DaySummary {
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  accountId?: string;
  project: string;
  model: string;
  /** Prompts that opened a new user turn that day. */
  userTurns: number;
  stats: AggregateStats;
}

interface SummaryFile {
  version: number;
  days: DaySummary[];
}

/** Group raw rows into per-day totals (local day, account, project, served model). */
export function summarizeDays(entries: readonly LedgerEntry[]): DaySummary[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([dayKey(entry), entry.accountId ?? '', entry.project, entry.servedModel]);
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  return [...groups.values()].map((group) => ({
    day: dayKey(group[0]),
    accountId: group[0].accountId,
    project: group[0].project,
    model: group[0].servedModel,
    userTurns: group.filter((entry) => entry.newUserTurn === true).length,
    stats: aggregate(group),
  }));
}

/** `YYYY-MM` of the month `back` months before `month`. */
function monthBefore(month: string, back: number): string {
  const [year, mon] = month.split('-').map(Number);
  const index = year * 12 + (mon - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function parseJsonl(raw: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(backfillCacheCosts(JSON.parse(line) as LedgerEntry));
    } catch {
      // A line cut short by a crash is skipped; every other row still loads.
    }
  }
  return entries;
}

/**
 * Ledger persisted as one append-only JSONL file per local month.
 *
 * A turn costs one appended line, never a rewrite of the whole history. Raw rows are
 * kept for the current month and the one before it; older months are folded into
 * per-day totals (`daily-summary.json`) and their file is deleted. Writes are
 * serialized through a promise chain so two fast turns cannot interleave, and only
 * the proxy owner writes or rolls months up.
 */
export class AnalyticsTracker {
  private readonly ledgerDir: string;
  private readonly legacyPath: string;
  private readonly summaryPath: string;
  private entries: LedgerEntry[] = [];
  private loaded = false;
  /** Size and mtime of the kept month files as of the last `load`, to notice another window's appends. */
  private diskSignature = '';
  private activeAccountId: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private rolledUpFor: string | undefined;

  constructor(
    storageDir: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.ledgerDir = path.join(storageDir, LEDGER_DIRNAME);
    this.legacyPath = path.join(storageDir, LEDGER_FILENAME);
    this.summaryPath = path.join(this.ledgerDir, SUMMARY_FILENAME);
  }

  /** The current month's ledger file (the one new turns are appended to). */
  get ledgerPath(): string {
    return this.monthFile(localMonthKey(this.now()));
  }

  private monthFile(month: string): string {
    return path.join(this.ledgerDir, `${month}.jsonl`);
  }

  /** Months whose raw rows are still loaded and kept: the current one and the previous one(s). */
  private keptMonths(): Set<string> {
    const current = localMonthKey(this.now());
    return new Set(Array.from({ length: RAW_MONTHS_KEPT_BEFORE_CURRENT + 1 }, (_, back) => monthBefore(current, back)));
  }

  private ledgerMonths(): string[] {
    try {
      return fs
        .readdirSync(this.ledgerDir)
        .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
        .map((name) => name.slice(0, 7))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Move the single-file ledger of earlier versions into monthly files. The old file is
   * renamed, not deleted, so a bad migration can always be redone from it.
   */
  private migrateLegacy(): void {
    if (!fs.existsSync(this.legacyPath) || this.ledgerMonths().length > 0) {
      return;
    }
    let rows: LedgerEntry[];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.legacyPath, 'utf8')) as { entries?: LedgerEntry[] };
      rows = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return; // unreadable: leave it untouched and start clean
    }
    try {
      fs.mkdirSync(this.ledgerDir, { recursive: true });
      const byMonth = new Map<string, string[]>();
      for (const row of rows) {
        const month = monthKey(row);
        const lines = byMonth.get(month) ?? [];
        lines.push(JSON.stringify(row));
        byMonth.set(month, lines);
      }
      for (const [month, lines] of byMonth) {
        fs.writeFileSync(this.monthFile(month), lines.join('\n') + '\n', 'utf8');
      }
      fs.renameSync(this.legacyPath, `${this.legacyPath}.migrated.bak`);
    } catch {
      // Best effort: the legacy file is still there for the next start.
    }
  }

  /** Read the kept months from disk. Missing or unreadable files start an empty ledger. */
  load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.entries = [];

    this.migrateLegacy();
    // Taken before reading: a row appended meanwhile changes it again, so the next check reloads.
    this.diskSignature = this.currentSignature();
    const kept = this.keptMonths();
    for (const month of this.ledgerMonths()) {
      if (!kept.has(month)) {
        continue; // older months wait for the owner's roll-up and never enter memory
      }
      try {
        this.entries.push(...parseJsonl(fs.readFileSync(this.monthFile(month), 'utf8')));
      } catch {
        // Unreadable month: skip it rather than fail activation.
      }
    }
  }

  /** Size and mtime of every kept month file; changes whenever any window appends or rewrites one. */
  private currentSignature(): string {
    const kept = this.keptMonths();
    return this.ledgerMonths()
      .filter((month) => kept.has(month))
      .map((month) => {
        try {
          const stat = fs.statSync(this.monthFile(month));
          return `${month}:${stat.size}:${stat.mtimeMs}`;
        } catch {
          return `${month}:gone`;
        }
      })
      .join('|');
  }

  /**
   * Reload when the ledger on disk is not what this window last read. A window that does not own
   * the proxy never writes the ledger and only hears about turns through the owner's event stream;
   * a missed event would leave it behind for good. The owner never calls this: its memory is the
   * newest copy, and the disk can lag it by a write.
   *
   * Returns whether anything was reloaded.
   */
  refreshIfChanged(): boolean {
    if (!this.loaded || this.currentSignature() === this.diskSignature) {
      return false;
    }
    this.reload();
    return true;
  }

  /** Per-day totals of the months already rolled up. */
  getDailySummaries(): DaySummary[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.summaryPath, 'utf8')) as SummaryFile;
      return Array.isArray(parsed.days) ? parsed.days : [];
    } catch {
      return [];
    }
  }

  /**
   * Fold every month older than the kept ones into daily totals and delete its raw file.
   * The summary is written before the file is deleted, so a crash in between only repeats
   * the same month on the next run (its days are replaced, never added twice).
   */
  private async rollUpOldMonths(): Promise<void> {
    const month = localMonthKey(this.now());
    if (this.rolledUpFor === month) {
      return;
    }
    this.rolledUpFor = month;

    const kept = this.keptMonths();
    const old = this.ledgerMonths().filter((name) => !kept.has(name));
    let days = this.getDailySummaries();
    for (const oldMonth of old) {
      try {
        const rows = parseJsonl(await fs.promises.readFile(this.monthFile(oldMonth), 'utf8'));
        days = days.filter((summary) => !summary.day.startsWith(oldMonth)).concat(summarizeDays(rows));
        const temp = `${this.summaryPath}.tmp`;
        await fs.promises.writeFile(temp, JSON.stringify({ version: SUMMARY_VERSION, days } satisfies SummaryFile), 'utf8');
        await fs.promises.rename(temp, this.summaryPath);
        await fs.promises.unlink(this.monthFile(oldMonth));
      } catch {
        // Leave the month on disk; the next run retries it.
      }
    }
  }

  /**
   * Pin `getEntries()` to the signed-in account. Once set, rows from other accounts
   * and untagged legacy rows are excluded; `undefined` returns every row again.
   */
  setActiveAccount(accountId: string | undefined): void {
    this.activeAccountId = accountId;
  }

  getActiveAccountId(): string | undefined {
    return this.activeAccountId;
  }

  /** Every persisted row of the active account (all rows when no account is set). */
  getEntries(): readonly LedgerEntry[] {
    this.load();
    const accountId = this.activeAccountId;
    if (!accountId) {
      return this.entries;
    }
    return this.entries.filter((entry) => entry.accountId === accountId);
  }

  /**
   * Re-read the ledger from disk, dropping the in-memory copy.
   *
   * Only the window that owns the shared proxy writes the file. A window taking
   * over ownership calls this first, so its first write builds on everything the
   * previous owner saved instead of overwriting it with a stale copy.
   */
  reload(): void {
    this.loaded = false;
    this.load();
  }

  /** Record one turn and schedule a durable write. Only the proxy owner calls this. */
  record(entry: LedgerEntry): void {
    this.ingest(entry);
    this.scheduleAppend(entry);
  }

  /**
   * Add a turn to the in-memory view without writing it.
   *
   * Used by windows that joined the shared proxy: the owner already persisted the
   * entry, and a second writer would race it and drop turns.
   */
  ingest(entry: LedgerEntry): void {
    this.load();
    this.entries.push(entry);
  }

  private scheduleAppend(entry: LedgerEntry): void {
    this.writeChain = this.writeChain.then(() => this.append(entry)).catch(() => undefined);
  }

  private async append(entry: LedgerEntry): Promise<void> {
    await fs.promises.mkdir(this.ledgerDir, { recursive: true });
    await this.rollUpOldMonths();
    await fs.promises.appendFile(this.monthFile(monthKey(entry)), JSON.stringify(entry) + '\n', 'utf8');
  }

  /** Wait for every pending write. Called on deactivate so nothing is lost on exit. */
  async drain(): Promise<void> {
    await this.writeChain;
  }
}

// ---------------------------------------------------------------------------
// Aggregation for the analytics dashboard
// ---------------------------------------------------------------------------

export interface AggregateStats {
  turns: number;
  rawTokens: number;
  optimizedTokens: number;
  prunedByNormalization: number;
  prunedByCompaction: number;
  /** Input tokens Anthropic billed at the plain 1x rate (neither cache read nor cache write). */
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  /** Count of turns where at least one cached token was read. */
  cacheHitTurns: number;
  /** Count of turns where at least one token was written to cache. */
  cacheWriteTurns: number;
  /** Count of hits that had regular (uncached) input. */
  uncachedHitTurns: number;
  outputTokens: number;
  modelSwaps: number;
  compactions: number;
  baselineUnitCost: number;
  actualUnitCost: number;
  savingsPercent: number;
  /** Turns that carry a floor baseline; the others predate it and are left out of the floor figures. */
  floorTurns: number;
  /** Floor baseline and the actual cost of those same turns. */
  floorBaselineUnitCost: number;
  /** Typical-case baseline of those same turns, and the saving against it. */
  centralBaselineUnitCost: number;
  centralSavingsPercent: number;
  floorActualUnitCost: number;
  /** The least the proxy saved, against a client with the best possible cache (previous prefix cached for up to an hour). 0 when `floorTurns` is 0. */
  floorSavingsPercent: number;
  savedUsd: number;
  /** What the cached tokens (read + write) would have cost with no caching at all. */
  cacheNoCacheUnitCost: number;
  /** What the cached tokens actually cost, multipliers included. */
  cacheActualUnitCost: number;
  /** Savings from caching alone, isolated from normalization/compaction/model routing. */
  cacheSavingsPercent: number;
  cacheSavedUsd: number;
  /** Cost of the compaction summarizer's Haiku calls, already folded into `actualUnitCost`. */
  summarizerUnitCost: number;
  /** Billed units per kind of input, model-weighted; see `inputUnits`. */
  cacheReadUnits: number;
  cacheWriteUnits: number;
  regularInputUnits: number;
  outputUnits: number;
  /** Models whose cache rate was not in the pricing table, per kind of token; those tokens are counted in t but add no u. */
  unpriced: Record<'read' | 'write', string[]>;
}

export function emptyStats(): AggregateStats {
  return {
    turns: 0,
    rawTokens: 0,
    optimizedTokens: 0,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheHitTurns: 0,
    cacheWriteTurns: 0,
    uncachedHitTurns: 0,
    outputTokens: 0,
    modelSwaps: 0,
    compactions: 0,
    baselineUnitCost: 0,
    actualUnitCost: 0,
    savingsPercent: 0,
    floorTurns: 0,
    floorBaselineUnitCost: 0,
    centralBaselineUnitCost: 0,
    centralSavingsPercent: 0,
    floorActualUnitCost: 0,
    floorSavingsPercent: 0,
    savedUsd: 0,
    cacheNoCacheUnitCost: 0,
    cacheActualUnitCost: 0,
    cacheSavingsPercent: 0,
    cacheSavedUsd: 0,
    summarizerUnitCost: 0,
    cacheReadUnits: 0,
    cacheWriteUnits: 0,
    regularInputUnits: 0,
    outputUnits: 0,
    unpriced: { read: [], write: [] },
  };
}

/**
 * Fold entries into one set of totals.
 *
 * The aggregate savings percentage is computed from summed costs, not by averaging
 * per-turn percentages — a big turn and a tiny turn must not count equally.
 */
/** A hit Anthropic never answered with success (no response, or a non-2xx): nothing was billed. Rows without a status predate the field and count as succeeded. */
export function isFailedHit(entry: Pick<LedgerEntry, 'status'>): boolean {
  return entry.status !== undefined && (entry.status < 200 || entry.status >= 300);
}

export function aggregate(entries: readonly LedgerEntry[]): AggregateStats {
  const stats = emptyStats();

  for (const entry of entries) {
    stats.turns += 1;
    // A failed hit was not billed, so the flow columns (raw, cleanup, summarized, sent) count it as
    // nothing, like the cost columns. The row keeps its real numbers in the ledger; the retry that
    // goes through carries the request's tokens.
    if (!isFailedHit(entry)) {
      stats.rawTokens += entry.rawTokens;
      stats.optimizedTokens += entry.optimizedTokens;
      stats.prunedByNormalization += entry.prunedByNormalization;
      stats.prunedByCompaction += entry.prunedByCompaction;
    }
    stats.uncachedInputTokens += entry.uncachedInputTokens;
    stats.cacheReadTokens += entry.cacheReadTokens;
    stats.cacheWriteTokens += entry.cacheWriteTokens;
    stats.cacheWrite1hTokens += entry.cacheWrite1hTokens ?? 0;
    stats.cacheHitTurns += entry.cacheReadTokens > 0 ? 1 : 0;
    stats.cacheWriteTurns += entry.cacheWriteTokens > 0 ? 1 : 0;
    stats.uncachedHitTurns += entry.uncachedInputTokens > 0 ? 1 : 0;
    stats.outputTokens += entry.outputTokens;
    stats.modelSwaps += entry.modelSwapped ? 1 : 0;
    stats.compactions += entry.compactionTriggered ? 1 : 0;
    stats.baselineUnitCost += entry.baselineUnitCost;
    stats.actualUnitCost += entry.actualUnitCost;
    if (entry.floorBaselineUnitCost !== undefined) {
      stats.floorTurns += 1;
      stats.floorBaselineUnitCost += entry.floorBaselineUnitCost;
      stats.centralBaselineUnitCost += entry.centralBaselineUnitCost ?? entry.floorBaselineUnitCost;
      stats.floorActualUnitCost += entry.actualUnitCost;
    }
    stats.cacheNoCacheUnitCost += entry.cacheNoCacheUnitCost;
    stats.cacheActualUnitCost += entry.cacheActualUnitCost;
    stats.summarizerUnitCost += entry.summarizerUnitCost ?? 0;
    const units = entryUnits(entry);
    stats.cacheReadUnits += units.read;
    stats.cacheWriteUnits += units.write;
    stats.regularInputUnits += units.regular;
    stats.outputUnits += units.output;
    for (const kind of unpricedKinds(entry)) {
      const models = stats.unpriced[kind];
      if (!models.includes(entry.servedModel)) {
        models.push(entry.servedModel);
      }
    }
  }

  if (stats.baselineUnitCost > 0) {
    stats.savingsPercent = (1 - stats.actualUnitCost / stats.baselineUnitCost) * 100;
  }
  if (stats.floorBaselineUnitCost > 0) {
    stats.floorSavingsPercent = (1 - stats.floorActualUnitCost / stats.floorBaselineUnitCost) * 100;
  }
  if (stats.centralBaselineUnitCost > 0) {
    stats.centralSavingsPercent = (1 - stats.floorActualUnitCost / stats.centralBaselineUnitCost) * 100;
  }
  stats.savedUsd = unitsToUsd(stats.baselineUnitCost - stats.actualUnitCost);

  if (stats.cacheNoCacheUnitCost > 0) {
    stats.cacheSavingsPercent = (1 - stats.cacheActualUnitCost / stats.cacheNoCacheUnitCost) * 100;
  }
  stats.cacheSavedUsd = unitsToUsd(stats.cacheNoCacheUnitCost - stats.cacheActualUnitCost);

  return stats;
}

/**
 * The trailing run of entries belonging to the most recently completed user turn.
 *
 * Mirrors the grouping `extension.ts` keeps in memory while the session runs: walk
 * back from the end until the hit that opened the turn. Entries written before
 * `newUserTurn` was recorded carry no boundary, so the walk stops at the first one
 * of those and the caller gets the last hit rather than a wrong-sized group.
 */
export function lastTurnEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.newUserTurn === true) {
      return entries.slice(index);
    }
    if (entry.newUserTurn === undefined) {
      return entries.slice(index);
    }
  }
  return entries.slice();
}

/** The hits of one user turn in one project. */
export interface TurnGroup {
  project: string;
  entries: LedgerEntry[];
}

/**
 * Every user turn in `entries`, oldest first, grouped per project.
 *
 * The ledger interleaves projects, so a plain walk would glue one project's tool-result
 * hits onto another's turn. A hit with `newUserTurn !== false` opens a group (legacy rows
 * without the flag each count as their own turn); `false` continues that project's open one.
 */
export function groupTurns(entries: readonly LedgerEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const open = new Map<string, TurnGroup>();
  for (const entry of entries) {
    const current = open.get(entry.project);
    if (entry.newUserTurn === false && current) {
      current.entries.push(entry);
      continue;
    }
    const group: TurnGroup = { project: entry.project, entries: [entry] };
    groups.push(group);
    open.set(entry.project, group);
  }
  return groups;
}

/** Ledger timestamps are stored in UTC; day/month buckets are shown in the user's local time. */
export function localDayKey(date: Date): string {
  return `${localMonthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

export function localMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` bucket for an entry, in local time (the stored ISO timestamp stays UTC). */
export function monthKey(entry: LedgerEntry): string {
  return localMonthKey(new Date(entry.timestamp));
}

/** `YYYY-MM-DD` bucket for an entry, in local time (the stored ISO timestamp stays UTC). */
export function dayKey(entry: LedgerEntry): string {
  return localDayKey(new Date(entry.timestamp));
}

export function groupBy<K extends string>(
  entries: readonly LedgerEntry[],
  key: (entry: LedgerEntry) => K
): Map<K, LedgerEntry[]> {
  const groups = new Map<K, LedgerEntry[]>();
  for (const entry of entries) {
    const bucket = key(entry);
    const existing = groups.get(bucket);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(bucket, [entry]);
    }
  }
  return groups;
}
