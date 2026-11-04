import * as fs from 'fs';
import * as path from 'path';

/**
 * Every error the extension meets is written to `errors.json` in its data folder, so nothing fails silently.
 * Repeats of the same error (same source and message) are one entry with a count, and the file keeps the newest
 * `MAX_ENTRIES`. Recording never throws and never waits on the network: it must be safe to call from any `catch`.
 */
export interface ErrorEntry {
  /** First time this error was seen (ISO). */
  firstAt: string;
  /** Last time it was seen (ISO). */
  lastAt: string;
  /** Where it happened, e.g. `proxy.upstream`, `ledger.write`. */
  source: string;
  message: string;
  /** How many times it happened. */
  count: number;
  /** Short facts that help find the cause (status, project, path...). Of the last occurrence. */
  context?: Record<string, string | number | boolean | undefined>;
  stack?: string;
}

export interface ErrorFile {
  version: 1;
  entries: ErrorEntry[];
}

export const MAX_ERROR_ENTRIES = 500;
const MAX_MESSAGE_CHARS = 600;
const MAX_STACK_CHARS = 1500;

let filePath: string | undefined;
let cache: ErrorFile | undefined;
let now: () => Date = () => new Date();

/** Points the log at a file (the data folder's `errors.json`); without one, errors are only counted in memory. */
export function configureErrorLog(file: string | undefined, clock?: () => Date): void {
  filePath = file;
  cache = undefined;
  now = clock ?? (() => new Date());
}

function load(): ErrorFile {
  if (cache) {
    return cache;
  }
  cache = { version: 1, entries: [] };
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ErrorFile>;
      if (Array.isArray(parsed.entries)) {
        cache.entries = parsed.entries.filter((e) => e && typeof e.source === 'string' && typeof e.message === 'string');
      }
    } catch {
      // No file yet, or one that is not ours: start empty (the next write replaces it).
    }
  }
  return cache;
}

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack };
  }
  return { message: typeof error === 'string' ? error : safeJson(error) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Records one error. `error` may be an `Error`, a string or anything thrown. Returns nothing and never throws.
 * Secrets must not be passed in `context`: it is written to disk as is.
 */
export function recordError(source: string, error: unknown, context?: ErrorEntry['context']): void {
  try {
    const { message: rawMessage, stack } = describe(error);
    const message = rawMessage.slice(0, MAX_MESSAGE_CHARS);
    const at = now().toISOString();
    const file = load();
    const existing = file.entries.find((e) => e.source === source && e.message === message);
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      existing.context = context ?? existing.context;
      // Move to the end: the list stays ordered by last occurrence.
      file.entries.splice(file.entries.indexOf(existing), 1);
      file.entries.push(existing);
    } else {
      file.entries.push({ firstAt: at, lastAt: at, source, message, count: 1, context, stack: stack?.slice(0, MAX_STACK_CHARS) });
      if (file.entries.length > MAX_ERROR_ENTRIES) {
        file.entries.splice(0, file.entries.length - MAX_ERROR_ENTRIES);
      }
    }
    persist(file);
  } catch {
    // The error log must never be the cause of an error.
  }
}

function persist(file: ErrorFile): void {
  if (!filePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 1), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // Nowhere left to report it: keep the entries in memory.
  }
}

/** Like `recordError`, but a file that simply is not there yet (`ENOENT`) is normal and not recorded. */
export function recordUnlessMissing(source: string, error: unknown, context?: ErrorEntry['context']): void {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return;
  }
  recordError(source, error, context);
}

/** The entries recorded so far, newest last. */
export function readErrors(): readonly ErrorEntry[] {
  return load().entries;
}
