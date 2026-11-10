import { recordError } from '../errorLog';
/**
 * Cache keep-alive (F-43).
 *
 * The prompt cache lives 5 minutes from its last use. After a pause the whole prefix is
 * rewritten at 1.25x instead of read at 0.1x. A tiny replay of the last request, sent a
 * little before the cache would expire, renews it for the price of one read. Pings stop
 * `maxMinutes` after the last real request, so an idle session is allowed to expire
 * (every ping on a session that never resumes is pure loss).
 *
 * Credentials and the last request body are held in memory only, per conversation.
 */

/**
 * Which chat a request belongs to: Claude Code's `session_id` (inside `metadata.user_id`),
 * else the project. A cache belongs to one conversation, never to a model or a whole project.
 */
export function chatKey(payload: object, project: string | undefined): string {
  const userId = (payload as { metadata?: { user_id?: unknown } }).metadata?.user_id;
  if (typeof userId === 'string') {
    try {
      const session = (JSON.parse(userId) as { session_id?: unknown }).session_id;
      if (typeof session === 'string' && session) {
        return session;
      }
    } catch {
      // older clients send a plain string: `..._session_<uuid>`
      const match = /session_([0-9a-f-]{36})/i.exec(userId);
      if (match) {
        return match[1];
      }
    }
  }
  return `project:${project ?? ''}`;
}

/** The chat's own `session_id`, or undefined when the client did not send one. */
export function sessionIdOf(payload: object): string | undefined {
  const key = chatKey(payload, undefined);
  return key.startsWith('project:') ? undefined : key;
}

/** The last successful request of one conversation, enough to replay it byte for byte. */
export interface KeepAliveSnapshot {
  /** The serialized body that went upstream (already optimized). */
  body: string;
  /** Headers the upstream needs (credentials, version, beta flags). */
  headers: Record<string, string>;
  project: string | undefined;
  sessionId?: string;
  /** The terminal the chat runs in (shell pid and start), when the proxy could tell. */
  terminalKey?: string;
  /**
   * When the request went upstream (epoch ms). The cache lives 5 minutes from its last use, which is
   * when the request arrived, not when its answer finished: a long answer must not push the ping later.
   */
  usedAt?: number;
}

export type PingResult = { status: number; usage?: Record<string, unknown>; model?: string };

export interface KeepAliveOptions {
  /** Stop pinging this long after the last real request. 0 disables keep-alive. */
  maxMinutes: number;
  /** Time between pings; must stay below the 5 minute cache lifetime. */
  intervalMs?: number;
  /** How long the cache lives after its last use (5 minutes, or 1 hour when the proxy asks for it). Read at every ping. */
  lifetimeMs?: () => number;
  /** Asked before every ping; false stops keeping this chat warm (its terminal is closed). */
  shouldPing?: (snapshot: KeepAliveSnapshot) => boolean;
  send: (snapshot: KeepAliveSnapshot, body: string) => Promise<PingResult>;
  onPing?: (snapshot: KeepAliveSnapshot, result: PingResult, count: number) => void;
  log?: (message: string) => void;
  now?: () => number;
}

export const KEEP_ALIVE_INTERVAL_MS = 270_000;

/** The default cache lifetime, and how close to it a ping may still be sent: past that the cache is already gone. */
export const KEEP_ALIVE_CACHE_LIFETIME_MS = 300_000;
const KEEP_ALIVE_SAFETY_MS = 5_000;

/**
 * Build the ping body from the real one: same prefix, no streaming, one output token.
 * Returns undefined when the request cannot be replayed cheaply (explicit thinking
 * budget: `max_tokens` must exceed it, and changing thinking invalidates the cache).
 */
export function buildPingBody(body: string): string | undefined {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const thinking = payload['thinking'] as { type?: string } | undefined;
  if (thinking?.type === 'enabled') {
    return undefined;
  }
  delete payload['stream'];
  payload['max_tokens'] = 1;
  return JSON.stringify(payload);
}

interface Entry {
  snapshot: KeepAliveSnapshot;
  lastRealAt: number;
  /** When the cache was last used: the last real request went upstream, or the last ping was sent. */
  touchedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  pings: number;
  busy: boolean;
}

/** A ping that read nothing and wrote the prompt: the cache it was meant to keep was already gone. */
function wroteCache(usage: Record<string, unknown> | undefined): boolean {
  const read = Number(usage?.['cache_read_input_tokens'] ?? 0);
  const written = Number(usage?.['cache_creation_input_tokens'] ?? 0);
  return read === 0 && written > 0;
}

export class KeepAlive {
  private readonly entries = new Map<string, Entry>();
  /** Real requests currently upstream, per chat. */
  private readonly inflight = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private options: KeepAliveOptions) {
    this.intervalMs = options.intervalMs ?? KEEP_ALIVE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options.maxMinutes > 0;
  }

  setMaxMinutes(minutes: number): void {
    this.options = { ...this.options, maxMinutes: minutes };
    if (!this.enabled) {
      this.stop();
    }
  }

  /**
   * A real request for chat `key` starts: it renews the cache itself, so the pending ping is cancelled and no ping is
   * scheduled or sent until every request in flight for the chat has ended (`end`). Concurrent requests (agents, parallel
   * tool turns) share a chat key, so a plain cancel would be undone by whichever of them finishes first.
   */
  begin(key: string): void {
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    this.cancel(key);
  }

  /** A request started with `begin` has ended (any outcome). The countdown restarts once none is left in flight. */
  end(key: string): void {
    const left = (this.inflight.get(key) ?? 0) - 1;
    if (left > 0) {
      this.inflight.set(key, left);
      return;
    }
    this.inflight.delete(key);
    const entry = this.entries.get(key);
    if (entry && !entry.timer && !entry.busy) {
      this.arm(key, entry);
    }
  }

  /** A real request is about to go upstream for chat `key`: it renews the cache itself. */
  cancel(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** A real request for this chat succeeded: remember it and (re)start the countdown. */
  remember(key: string, snapshot: KeepAliveSnapshot): void {
    if (!this.enabled || !buildPingBody(snapshot.body)) {
      this.entries.delete(key);
      return;
    }
    const previous = this.entries.get(key);
    if (previous?.timer) {
      clearTimeout(previous.timer);
    }
    const entry: Entry = { snapshot, lastRealAt: this.now(), touchedAt: Math.min(this.now(), snapshot.usedAt ?? this.now()), timer: undefined, pings: 0, busy: false };
    this.entries.set(key, entry);
    this.arm(key, entry);
  }

  /**
   * When the cache of chat `key` was last used, by a real request or by one of this keep-alive's pings (epoch ms); undefined when
   * the chat is not being kept warm. A ping renews Anthropic's cache without any request passing through the optimizer, so the
   * optimizer's own record of the last request cannot tell that the cache is still alive.
   */
  lastTouchedAt(key: string): number | undefined {
    return this.entries.get(key)?.touchedAt;
  }

  /** Forget everything (shutdown, or keep-alive switched off). */
  stop(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.entries.clear();
    this.inflight.clear();
  }

  private arm(key: string, entry: Entry): void {
    if ((this.inflight.get(key) ?? 0) > 0) {
      return; // a turn is being processed: `end` re-arms when it finishes
    }
    const deadline = entry.lastRealAt + this.options.maxMinutes * 60_000;
    if (this.now() + this.intervalMs > deadline) {
      this.entries.delete(key); // the next ping would land past the cap
      return;
    }
    // The interval runs from the last use of the cache, so a long answer or a slow ping does not delay the next one.
    const delay = Math.max(0, entry.touchedAt + this.intervalMs - this.now());
    entry.timer = setTimeout(() => void this.fire(key, entry), delay);
    entry.timer.unref?.();
  }

  private async fire(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key) !== entry || entry.busy) {
      return;
    }
    const body = buildPingBody(entry.snapshot.body);
    if (!body) {
      this.entries.delete(key);
      return;
    }
    // A ping only keeps a warm cache warm. When the machine slept or was suspended the timer fires
    // long after it was due, the cache is already gone, and a ping would only pay to write it again
    // for nobody: stop here and let the next real request do that once.
    const lifetime = this.options.lifetimeMs?.() ?? KEEP_ALIVE_CACHE_LIFETIME_MS;
    const age = this.now() - entry.touchedAt;
    if (age >= lifetime - KEEP_ALIVE_SAFETY_MS) {
      this.options.log?.(`keep-alive: the cache of [${entry.snapshot.project ?? '-'}] is ${Math.round(age / 1000)}s old (it lasts ${Math.round(lifetime / 1000)}s), not pinging`);
      this.entries.delete(key);
      return;
    }
    if (this.options.shouldPing && !this.options.shouldPing(entry.snapshot)) {
      this.options.log?.(`keep-alive: the terminal of [${entry.snapshot.project ?? '-'}] is closed, not pinging`);
      this.entries.delete(key);
      return;
    }
    entry.busy = true;
    entry.timer = undefined;
    const sentAt = this.now();
    try {
      const result = await this.options.send(entry.snapshot, body);
      entry.pings += 1;
      entry.touchedAt = sentAt;
      this.options.onPing?.(entry.snapshot, result, entry.pings);
      // A ping that had to write the cache found it already gone: it paid for nothing, and the next
      // one would do the same if the cause is still there. One wasted write at most.
      if (result.status === 200 && wroteCache(result.usage)) {
        this.options.log?.(`keep-alive: the ping had to write the cache of [${entry.snapshot.project ?? '-'}] (it was already gone), stopping`);
        this.entries.delete(key);
        return;
      }
      if (result.status !== 200) {
        this.options.log?.(`keep-alive: ping answered HTTP ${result.status}, stopping for [${entry.snapshot.project ?? '-'}]`);
        recordError('keepalive.ping', `ping answered HTTP ${result.status}`, { status: result.status, project: entry.snapshot.project });
        this.entries.delete(key);
        return;
      }
    } catch (error) {
      this.options.log?.(`keep-alive: ping failed (${error instanceof Error ? error.message : String(error)}), stopping`);
      recordError('keepalive.ping', error, { project: entry.snapshot.project });
      this.entries.delete(key);
      return;
    } finally {
      entry.busy = false;
    }
    // A real request may have replaced this entry while the ping was in flight.
    if (this.entries.get(key) === entry) {
      this.arm(key, entry);
    }
  }
}
