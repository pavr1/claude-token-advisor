/**
 * Durable store for Anthropic's own reported `claude_code.cost.usage`, received
 * over the extension's local OTLP sink (see `src/otel/otlpDecoder.ts` and
 * `TokenImproverProxy`'s `POST /v1/metrics`).
 *
 * Kept separate from `AnalyticsTracker`'s ledger: a `LedgerEntry` is one row per
 * proxied turn, but `cost.usage` has no per-turn id at all — it aggregates by
 * account and session, confirmed empirically. There is no natural join key, so
 * bolting real-cost fields onto `LedgerEntry` would mean fake/undefined fields on
 * every historical row instead of a store shaped for what this data actually is.
 */

import * as fs from 'fs';
import * as path from 'path';

export const REAL_COST_FILENAME = 'claude_code_real_cost.json';
const REAL_COST_VERSION = 2;

/** One `cost.usage` data point, as decoded off the wire. */
export interface RealCostEvent {
  seriesKey: string;
  timestampMs: number;
  /** The raw exporter value: a running total if `temporality` is 'cumulative', an increment if 'delta'. */
  valueUsd: number;
  temporality: 'delta' | 'cumulative';
}

/**
 * Stable identity for one OTel series: sorted attribute pairs, so the same
 * session+model always maps to the same key regardless of attribute emission order.
 */
export function realCostSeriesKey(attributes: Record<string, string | number>): string {
  return Object.entries(attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

/**
 * Recovers the flat attribute list a seriesKey was built from (inverse of
 * `realCostSeriesKey`). Reparses the key instead of storing attributes separately so
 * the on-disk shape (`RealCostFile`) doesn't need a version bump for new lookups.
 */
function parseSeriesKey(seriesKey: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const pair of seriesKey.split('|')) {
    const eq = pair.indexOf('=');
    if (eq !== -1) {
      attrs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return attrs;
}

/**
 * Recovers the Anthropic account behind a series from its key, so readings from a
 * different logged-in account (e.g. an Enterprise seat vs. a personal Pro account
 * on the same machine) never get summed together. `user.account_id` is preferred;
 * `user.account_uuid`/`user.email` are fallbacks for older or partial attribute sets.
 */
export function accountIdFromSeriesKey(seriesKey: string): string | undefined {
  const attrs = parseSeriesKey(seriesKey);
  return attrs['user.account_id'] || attrs['user.account_uuid'] || attrs['user.email'];
}

/** The `user.email` attribute of a series, when telemetry included one. */
export function emailFromSeriesKey(seriesKey: string): string | undefined {
  return parseSeriesKey(seriesKey)['user.email'];
}

interface SeriesReading {
  timestampMs: number;
  /** The running total for this series, post-baseline — what every reader should use. */
  totalUsd: number;
  /**
   * The last raw value the exporter reported for the current cumulative cycle.
   * Only meaningful for 'cumulative' series: compared against the next reading to
   * detect a meter reset (the raw value drops even though real spend never does).
   */
  lastRawUsd: number;
  /**
   * Cumulative spend the series had already reached before the last install. The
   * counter cannot be split by date, so it is remembered here and subtracted from
   * every figure; absent when the series started after the install.
   */
  baselineUsd?: number;
}

/** Shape written by `REAL_COST_VERSION` 1, before 'totalUsd'/'lastRawUsd' existed. */
interface LegacySeriesReadingV1 {
  timestampMs: number;
  cumulativeUsd: number;
  baselineUsd?: number;
}

interface RealCostFile {
  version: number;
  series: Record<string, SeriesReading | LegacySeriesReadingV1>;
}

/** A v1 reading has no `totalUsd` — migrate it to v2 by treating its one number as both the running total and the last raw value, so nothing already recorded is lost. */
function migrateSeriesReading(reading: SeriesReading | LegacySeriesReadingV1): SeriesReading {
  if ('totalUsd' in reading) {
    return reading;
  }
  return {
    timestampMs: reading.timestampMs,
    totalUsd: reading.cumulativeUsd,
    lastRawUsd: reading.cumulativeUsd,
    ...(reading.baselineUsd ? { baselineUsd: reading.baselineUsd } : {}),
  };
}

/**
 * Keeps a running total per series rather than summing every export, since Claude
 * Code's OTel counters are cumulative by default — each export carries the running
 * total since the meter started, not a delta since the last export. But that running
 * value has been observed to *drop* mid-session for the same series (same session,
 * model, effort, query_source) — most likely the exporter resets its meter per query
 * while reusing the same attributes, since this metric carries no per-turn id. A drop
 * is treated as a reset: whatever had accrued is banked, and the new, lower reading
 * starts a fresh cycle on top of it, rather than silently replacing (and losing) it.
 * A 'delta' series (temporality read straight off the wire, not assumed) is summed
 * unconditionally instead, since each export there already is its own increment.
 */
export class RealCostTracker {
  private readonly filePath: string;
  private series = new Map<string, SeriesReading>();
  private loaded = false;
  /** Size and mtime of the store as of the last `load`. */
  private diskSignature = '';
  /** The account signed in right now (from the Claude profile). When set it overrides inference from telemetry. */
  private activeIdentity: { identifiers: Set<string>; email?: string } | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, REAL_COST_FILENAME);
  }

  get storePath(): string {
    return this.filePath;
  }

  /**
   * Pin every `currentAccount*` figure to the signed-in account. A series belongs to it when any of its
   * account attributes (`user.account_id`, `user.account_uuid`, `user.email`) matches an identifier.
   * Pass `undefined` to go back to inferring the account from the latest reading.
   */
  setActiveIdentity(identity: { identifiers: string[]; email?: string } | undefined): void {
    this.activeIdentity = identity && identity.identifiers.length
      ? { identifiers: new Set(identity.identifiers), email: identity.email }
      : undefined;
  }

  /**
   * Every series, its spend reduced by any baseline stored by an earlier version. All
   * figures below iterate this instead of the raw store.
   */
  private visibleSeries(): Array<[string, SeriesReading]> {
    this.load();
    const visible: Array<[string, SeriesReading]> = [];
    for (const [seriesKey, reading] of this.series) {
      const totalUsd = Math.max(0, reading.totalUsd - (reading.baselineUsd ?? 0));
      visible.push([seriesKey, { timestampMs: reading.timestampMs, totalUsd, lastRawUsd: reading.lastRawUsd }]);
    }
    return visible;
  }

  private matchesActiveIdentity(seriesKey: string): boolean {
    const identity = this.activeIdentity;
    if (!identity) {
      return false;
    }
    const attrs = parseSeriesKey(seriesKey);
    return ['user.account_id', 'user.account_uuid', 'user.email'].some((name) => {
      const value = attrs[name];
      return value !== undefined && identity.identifiers.has(value);
    });
  }

  /** Read from disk. A missing or corrupt file starts an empty store. */
  load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.diskSignature = this.currentSignature();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RealCostFile;
      this.series = new Map(
        Object.entries(parsed.series ?? {}).map(([key, reading]) => [key, migrateSeriesReading(reading)])
      );
    } catch {
      this.series = new Map();
    }
  }

  private currentSignature(): string {
    try {
      const stat = fs.statSync(this.filePath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'gone';
    }
  }

  /** Reload when another window rewrote the store since the last read; returns whether it did. Never call it from the owner, whose memory is the newest copy. */
  refreshIfChanged(): boolean {
    if (!this.loaded || this.currentSignature() === this.diskSignature) {
      return false;
    }
    this.reload();
    return true;
  }

  /** Re-read from disk, dropping the in-memory copy — mirrors `AnalyticsTracker.reload()`. */
  reload(): void {
    this.loaded = false;
    this.load();
  }

  /**
   * Add a reading to the in-memory view without writing it. Used by windows that
   * joined the shared proxy, replaying the owner's broadcast — the owner already
   * persisted the reading, and a second writer would race it.
   */
  ingest(event: RealCostEvent): void {
    this.load();
    const existing = this.series.get(event.seriesKey);
    if (existing && event.timestampMs < existing.timestampMs) {
      return; // out of order, ignore
    }

    const baselineUsd = existing?.baselineUsd;

    let totalUsd: number;
    if (!existing) {
      totalUsd = event.valueUsd;
    } else if (event.temporality === 'delta') {
      totalUsd = existing.totalUsd + event.valueUsd;
    } else if (event.valueUsd >= existing.lastRawUsd) {
      totalUsd = existing.totalUsd + (event.valueUsd - existing.lastRawUsd);
    } else {
      // The raw counter dropped: the exporter reset its meter. Bank what had
      // already accrued and start the new, lower cycle from its own value.
      totalUsd = existing.totalUsd + event.valueUsd;
    }

    this.series.set(event.seriesKey, {
      timestampMs: event.timestampMs,
      totalUsd,
      lastRawUsd: event.valueUsd,
      ...(baselineUsd ? { baselineUsd } : {}),
    });
  }

  /** Owner only: ingest and schedule a durable write. */
  record(event: RealCostEvent): void {
    this.ingest(event);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    const snapshot: RealCostFile = { version: REAL_COST_VERSION, series: Object.fromEntries(this.series) };
    this.writeChain = this.writeChain.then(() => this.flush(snapshot)).catch(() => undefined);
  }

  private async flush(snapshot: RealCostFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.promises.mkdir(directory, { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.promises.rename(tempPath, this.filePath);
  }

  /** Wait for every pending write. Called on deactivate so nothing is lost on exit. */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Sum of the latest reading for every series last updated within [startMs, endMs).
   *
   * Known limitation: a session's whole cumulative total is attributed to the
   * day/month of its *most recent* observed export, not split proportionally
   * across a midnight/month-end boundary it crossed mid-session. Acceptable for a
   * single-user local demo; would need delta-tracking per series to fix properly.
   */
  totalUsdInRange(startMs: number, endMs: number): number | undefined {
    this.load();
    let total = 0;
    let any = false;
    for (const reading of this.visibleSeries().map(([, r]) => r)) {
      if (reading.timestampMs >= startMs && reading.timestampMs < endMs) {
        total += reading.totalUsd;
        any = true;
      }
    }
    return any ? total : undefined;
  }

  /** Same as `totalUsdInRange`, restricted to series belonging to one Anthropic account. */
  totalUsdInRangeForAccount(startMs: number, endMs: number, accountId: string): number | undefined {
    this.load();
    let total = 0;
    let any = false;
    for (const [seriesKey, reading] of this.visibleSeries()) {
      if (reading.timestampMs < startMs || reading.timestampMs >= endMs) {
        continue;
      }
      if (accountIdFromSeriesKey(seriesKey) !== accountId) {
        continue;
      }
      total += reading.totalUsd;
      any = true;
    }
    return any ? total : undefined;
  }

  /** The series key of the single most recent account-tagged reading in the store. */
  private mostRecentAccountSeriesKey(): string | undefined {
    this.load();
    let bestTimestamp = -Infinity;
    let bestSeriesKey: string | undefined;
    for (const [seriesKey, reading] of this.visibleSeries()) {
      if (accountIdFromSeriesKey(seriesKey) && reading.timestampMs > bestTimestamp) {
        bestTimestamp = reading.timestampMs;
        bestSeriesKey = seriesKey;
      }
    }
    return bestSeriesKey;
  }

  /**
   * The account behind the single most recent reading in the whole store — i.e.
   * whichever Anthropic account this machine is currently authenticated as, inferred
   * from telemetry rather than read from disk credentials. `undefined` when the store
   * is empty or has no account-tagged readings (older attribute shape).
   */
  currentAccountId(): string | undefined {
    const seriesKey = this.mostRecentAccountSeriesKey();
    return seriesKey ? accountIdFromSeriesKey(seriesKey) : undefined;
  }

  /**
   * The `user.email` of the currently active account (same reading `currentAccountId`
   * resolves from), for display — e.g. the status bar tooltip title. `undefined` when
   * there's no account-tagged reading yet, or the CLI attributes didn't include email.
   */
  currentAccountEmail(): string | undefined {
    if (this.activeIdentity) {
      return this.activeIdentity.email;
    }
    const seriesKey = this.mostRecentAccountSeriesKey();
    return seriesKey ? emailFromSeriesKey(seriesKey) : undefined;
  }

  /**
   * Distinct accounts seen in the store, most-recently-active first. Lets the UI warn
   * when more than one is present, e.g. right after switching from an Enterprise seat
   * to a personal account (or back) on the same machine.
   */
  distinctAccountIds(): string[] {
    this.load();
    const lastSeen = new Map<string, number>();
    for (const [seriesKey, reading] of this.visibleSeries()) {
      const accountId = accountIdFromSeriesKey(seriesKey);
      if (!accountId) {
        continue;
      }
      const prev = lastSeen.get(accountId);
      if (prev === undefined || reading.timestampMs > prev) {
        lastSeen.set(accountId, reading.timestampMs);
      }
    }
    return [...lastSeen.entries()].sort((a, b) => b[1] - a[1]).map(([accountId]) => accountId);
  }

  /**
   * `totalUsdInRange` scoped to `currentAccountId()` — the number every caller should
   * use for "how much has this account spent", so readings left over from a previous
   * login on this machine never get folded into the active account's total. Falls
   * back to summing every account when nothing in the store is account-tagged, so
   * older stores degrade gracefully instead of going blank.
   */
  currentAccountTotalUsdInRange(startMs: number, endMs: number): number | undefined {
    if (this.activeIdentity) {
      // Strict: readings from other accounts, or untagged ones, are never this account's spend.
      this.load();
      let total = 0;
      let any = false;
      for (const [seriesKey, reading] of this.visibleSeries()) {
        if (reading.timestampMs >= startMs && reading.timestampMs < endMs && this.matchesActiveIdentity(seriesKey)) {
          total += reading.totalUsd;
          any = true;
        }
      }
      return any ? total : undefined;
    }
    const accountId = this.currentAccountId();
    return accountId ? this.totalUsdInRangeForAccount(startMs, endMs, accountId) : this.totalUsdInRange(startMs, endMs);
  }

  /**
   * Timestamp of the oldest reading in the store, i.e. roughly when telemetry
   * began. Used as the `--since` cutoff so local transcript figures cover the
   * same window as Anthropic's reported cost.
   */
  earliestTimestampMs(): number | undefined {
    this.load();
    let earliest: number | undefined;
    for (const [seriesKey, reading] of this.visibleSeries()) {
      if (this.activeIdentity && !this.matchesActiveIdentity(seriesKey)) {
        continue;
      }
      if (earliest === undefined || reading.timestampMs < earliest) {
        earliest = reading.timestampMs;
      }
    }
    return earliest;
  }
}
