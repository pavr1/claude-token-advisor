/**
 * Summaries waiting to be handed to a fresh chat.
 *
 * When a new local day starts, the proxy summarizes the previous day's history and asks the
 * user to `/clear` the client. A cleared chat has a new first message, so the stored summary
 * (keyed by the old one) would never match it. This keeps the summaries per project, in a
 * file, until the first request of the next chat takes them (one-shot) and forwards them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** A pending summary nobody claimed within this long is dropped; it covers a weekend after a Friday-night summary. */
export const PENDING_HISTORY_TTL_MS = 72 * 60 * 60 * 1000;

interface PendingEntry {
  summaries: string[];
  /** Epoch ms when the summaries were saved. */
  savedAt: number;
}

export class PendingHistoryStore {
  private readonly entries = new Map<string, PendingEntry>();

  constructor(
    private readonly filePath?: string,
    private readonly ttlMs = PENDING_HISTORY_TTL_MS
  ) {
    this.load();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Saves (replacing any earlier one) the summaries in force for `project`. */
  set(project: string, summaries: string[], now: number): void {
    this.entries.set(project, { summaries: [...summaries], savedAt: now });
    this.save();
  }

  /** True when `project` has unexpired summaries waiting. */
  has(project: string, now: number): boolean {
    const entry = this.entries.get(project);
    return !!entry && now - entry.savedAt <= this.ttlMs;
  }

  /** Returns and deletes the summaries waiting for `project`; undefined when none or expired. */
  take(project: string, now: number): string[] | undefined {
    const entry = this.entries.get(project);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(project);
    this.save();
    return now - entry.savedAt <= this.ttlMs ? entry.summaries : undefined;
  }

  private load(): void {
    if (!this.filePath) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { pending?: Record<string, PendingEntry> };
      for (const [project, value] of Object.entries(parsed.pending ?? {})) {
        if (
          value &&
          typeof value.savedAt === 'number' &&
          Array.isArray(value.summaries) &&
          value.summaries.every((summary) => typeof summary === 'string')
        ) {
          this.entries.set(project, { summaries: value.summaries, savedAt: value.savedAt });
        }
      }
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  private save(): void {
    if (!this.filePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, pending: Object.fromEntries(this.entries) }), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch {
      // A failed write only loses the hand-over; the summary is still in the SummaryStore.
    }
  }
}
