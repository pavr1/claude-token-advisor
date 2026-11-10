/**
 * Summaries waiting to be handed to a fresh chat.
 *
 * When a new local day starts, the proxy summarizes the previous day's history and asks the
 * user to `/clear` the client. A cleared chat has a new first message, so the stored summary
 * (keyed by the old one) would never match it. This keeps the summaries per project, in a
 * file, until the first request of the next chat takes them (one-shot) and forwards them.
 */

import { recordError, recordUnlessMissing } from '../errorLog';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A pending summary nobody claimed within this long is dropped; it covers a weekend after a Friday-night summary. */
export const PENDING_HISTORY_TTL_MS = 72 * 60 * 60 * 1000;

interface PendingEntry {
  summaries: string[];
  /** Epoch ms when the summaries were saved. */
  savedAt: number;
  /** The terminal (shell pid@start) whose chat made them. A /clear keeps it; closing Claude Code or the project changes it. */
  terminalKey?: string;
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

  /** Saves (replacing any earlier one) the summaries in force for `project`, made in `terminalKey`. */
  set(project: string, summaries: string[], now: number, terminalKey?: string): void {
    this.entries.set(project, { summaries: [...summaries], savedAt: now, ...(terminalKey ? { terminalKey } : {}) });
    this.save();
  }

  /**
   * Drops the entry when a different terminal asks: a chat started in a new terminal (Claude Code or the project was
   * closed and reopened) has nothing to do with the old one, so its summary must not wait for it. Only a known
   * terminal can make an entry stale; entries saved without one (older files) go stale the same way.
   */
  private dropIfStale(project: string, terminalKey: string | undefined): void {
    const entry = this.entries.get(project);
    if (entry && terminalKey && entry.terminalKey !== terminalKey) {
      this.entries.delete(project);
      this.save();
    }
  }

  /** True when `project` has unexpired summaries waiting for the chat in `terminalKey`. */
  has(project: string, now: number, terminalKey?: string): boolean {
    this.dropIfStale(project, terminalKey);
    const entry = this.entries.get(project);
    return !!entry && now - entry.savedAt <= this.ttlMs;
  }

  /** Returns and deletes the summaries waiting for `project`; undefined when none, expired or from another terminal. */
  take(project: string, now: number, terminalKey?: string): string[] | undefined {
    this.dropIfStale(project, terminalKey);
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
          this.entries.set(project, {
            summaries: value.summaries,
            savedAt: value.savedAt,
            ...(typeof value.terminalKey === 'string' ? { terminalKey: value.terminalKey } : {}),
          });
        }
      }
    } catch (error) {
      // No file yet, or unreadable: start empty.
      recordUnlessMissing('pending_history.load', error);
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
    } catch (error) {
      // A failed write only loses the hand-over; the summary is still in the SummaryStore.
      recordError('pending_history.write', error);
    }
  }
}
