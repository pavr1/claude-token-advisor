/**
 * The Express Proxy Router.
 *
 * Runs inside the extension host and stands in for the Anthropic API. A client
 * pointed at `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` sends its normal traffic
 * here; `POST /v1/messages` goes through the optimization engine and everything
 * else is passed straight through so the client keeps working.
 *
 * Two hard rules in this file:
 *   - Bind to loopback only. This server carries the user's API credentials.
 *   - Never log credentials, prompt text, or response text.
 */

import * as http from 'http';
import express, { Express, Request, Response } from 'express';
import { upstreamFetch } from './upstreamClient';
import {
  DEFAULT_OPTIMIZER_CONFIG,
  HAIKU_MODEL_ID,
  hasToolResults,
  isFreshUserTurn,
  manifestMaxOutputTokens,
  manifestSystemPrompt,
  manifestTargetTokens,
  OptimizationTelemetry,
  OptimizerConfig,
  optimizePayload,
  SummarizerUsage,
  SUMMARIZER_CHUNK_CHARS,
  SummaryStore,
  BaselineMemory,
} from './optimizer';
import { countTokensRemote, estimatePayloadTokens, MessagesPayload } from './tokenCounter';
import { ApiUsage, LedgerEntry } from '../analytics/tracker';
import { InFlightStage } from '../analytics/inflight';
import { RealCostEvent, realCostSeriesKey } from '../analytics/realCostTracker';
import { decodeExportMetricsRequest } from '../otel/otlpDecoder';

/**
 * Identifies this proxy on `/health`, so a second VS Code window that finds the
 * port taken can tell "our proxy, join it" apart from "some other program".
 */
export const PROXY_SERVICE_ID = 'claude-token-improver';

/**
 * Version of the window-to-window contract: the `/w/<project>` prefix and the
 * `/events` stream. A proxy from before the singleton (no `service` on `/health`)
 * is protocol 0 and supports neither.
 */
export const PROXY_PROTOCOL = 1;

/**
 * Prefix a window adds to its base URL so the shared proxy knows which project a
 * request belongs to: `http://127.0.0.1:4000/w/<project>`. Clients append
 * `/v1/messages` to the base URL, so the tag arrives on every request.
 */
const PROJECT_PREFIX = /^\/w\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/;

/** Lifecycle events the owning window streams to the windows that joined it. */
export type ProxyEvent =
  | { type: 'start'; project: string; newUserTurn?: boolean; id?: string }
  | { type: 'optimized'; project: string; preflight: InFlightStage; id?: string }
  | { type: 'turn'; entry: LedgerEntry }
  | { type: 'realCost'; sample: RealCostEvent }
  | { type: 'rateLimit'; info: UnifiedRateLimitSnapshot }
  | { type: 'extensionVersion'; version: string };

/** True when dotted numeric version `a` is newer than `b` (`0.2.10` > `0.2.9`); non-numeric parts count as 0. */
export function isNewerVersion(a: string, b: string): boolean {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

/** Thrown by `start()` when the port is taken, so the caller can probe who holds it. */

/** Split on fresh user turns so no tool_use/tool_result pair straddles two chunks. */
export function splitForSummarizer(
  messages: Array<Record<string, unknown>>,
  maxChars: number
): Array<Array<Record<string, unknown>>> {
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let size = 0;
  for (const message of messages) {
    const length = JSON.stringify(message).length;
    if (current.length && size + length > maxChars && isFreshUserTurn(message)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += length;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}

export class ProxyPortInUseError extends Error {
  constructor(port: number) {
    super(`port ${port} is already in use`);
    this.name = 'ProxyPortInUseError';
  }
}

/**
 * The real Anthropic Messages API origin.
 *
 * Note: the spec for this feature said to forward to `https://anthropic.com`, which
 * is the marketing site and does not serve the API. The Messages API lives at
 * `https://api.anthropic.com`, which is what we use (overridable via settings).
 */
export const DEFAULT_UPSTREAM_BASE_URL = 'https://api.anthropic.com';

export const DEFAULT_PROXY_PORT = 4000;

/** Request body ceiling. Agentic payloads with file contents get large. */
const MAX_BODY_SIZE = '96mb';

/** An OTLP metrics export batch is a handful of counters, nowhere near the Messages ceiling. */
const METRICS_BODY_SIZE = '512kb';

/** Headers that belong to one hop and must not be forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);

export interface ProxyConfig {
  port: number;
  upstreamBaseUrl: string;
  optimizer: OptimizerConfig;
  /** Use `POST /v1/messages/count_tokens` for the baseline instead of the local estimate. */
  exactTokenCounting: boolean;
  /** Where the stored compaction summaries are kept between restarts; in memory only when unset. */
  summaryStorePath?: string;
  /** Where the last request time per conversation is kept between restarts; in memory only when unset. */
  baselineMemoryPath?: string;
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: DEFAULT_PROXY_PORT,
  upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
  optimizer: { ...DEFAULT_OPTIMIZER_CONFIG },
  exactTokenCounting: false,
};

/** Everything the extension needs to know about one completed turn. */
/** Node's `fetch failed` hides the reason in `error.cause`; surface its code (ECONNRESET, ETIMEDOUT...) and text. */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const detail = [cause?.code, cause?.message].filter((part, i, all) => part && all.indexOf(part) === i).join(' ');
  return detail ? `${error.message} (${detail})` : error.message;
}

const RETRYABLE_CONNECTION_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'UND_ERR_SOCKET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']);

/** True for failures where the connection broke before any response, so nothing reached the model. */
export function isRetryableConnectionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code !== undefined && RETRYABLE_CONNECTION_CODES.has(code);
}

export interface TurnRecord {
  telemetry: OptimizationTelemetry;
  usage: ApiUsage | undefined;
  /** Upstream HTTP status, or 0 when the request never reached the server. */
  status: number;
  /** Why the request never reached the server (status 0): the network error and its cause code. */
  failure?: string;
  /** Project from the `/w/<project>` prefix, or undefined when the client used the bare address. */
  project: string | undefined;
}

/**
 * 5.3: one `anthropic-ratelimit-unified-*` window reading (`5h` = session, `7d` = weekly),
 * as confirmed live on a Pro account in 5.1 — these ride every ordinary Messages
 * response, no admin key needed.
 */
export interface RateLimitWindow {
  /** 0-1 fraction of the window consumed, exactly as Anthropic reports it. */
  utilization: number;
  /** Unix seconds the window resets, when Anthropic sent one. */
  resetEpochSeconds: number | undefined;
}

/** The latest reading of both unified rate-limit windows, from the most recent Messages response. */
export interface UnifiedRateLimitSnapshot {
  fiveHour: RateLimitWindow | undefined;
  sevenDay: RateLimitWindow | undefined;
}

function parseRateLimitWindow(upstream: globalThis.Response, windowKey: '5h' | '7d'): RateLimitWindow | undefined {
  const utilizationRaw = upstream.headers.get(`anthropic-ratelimit-unified-${windowKey}-utilization`);
  if (utilizationRaw === null) {
    return undefined;
  }
  const utilization = Number(utilizationRaw);
  if (!Number.isFinite(utilization)) {
    return undefined;
  }
  const resetRaw = upstream.headers.get(`anthropic-ratelimit-unified-${windowKey}-reset`);
  const resetParsed = resetRaw !== null ? Number(resetRaw) : NaN;
  return { utilization, resetEpochSeconds: Number.isFinite(resetParsed) ? resetParsed : undefined };
}

/**
 * 5.3: reads the session (5h) and weekly (7d) unified rate-limit windows off a
 * Messages response, when Anthropic sent them (Pro/Max/Team; not seen on API/Enterprise
 * in 5.1's check). `undefined` when neither window is present, so callers can skip
 * reporting anything rather than broadcasting an empty snapshot.
 */
export function parseUnifiedRateLimitHeaders(upstream: globalThis.Response): UnifiedRateLimitSnapshot | undefined {
  const fiveHour = parseRateLimitWindow(upstream, '5h');
  const sevenDay = parseRateLimitWindow(upstream, '7d');
  if (!fiveHour && !sevenDay) {
    return undefined;
  }
  return { fiveHour, sevenDay };
}

/**
 * Lifecycle callbacks for an optimized turn.
 *
 * `onRequestStart` and `onTurnComplete` are guaranteed to be balanced: every start
 * is followed by exactly one completion, whatever the outcome. The UI keeps an
 * in-flight counter off these, so an unbalanced pair would leave a spinner
 * running forever.
 *
 * Only `POST /v1/messages` reports through here. Passthrough traffic
 * (`count_tokens`, `models`) is not an LLM turn and would make the indicator noisy.
 */
export interface ProxyObserver {
  /** A valid Messages request arrived and processing has begun; `newUserTurn` is false for a tool-result continuation. */
  onRequestStart?: (project: string | undefined, newUserTurn: boolean, id?: string) => void;
  /** Optimization finished and the request is about to go upstream: raw → sent is known before the response. */
  onRequestOptimized?: (project: string | undefined, preflight: InFlightStage, id?: string) => void;
  /** The turn ended: upstream responded, failed, or the stream broke. */
  onTurnComplete: (record: TurnRecord) => void;
  /** A `claude_code.cost.usage` data point arrived over the local OTLP sink. */
  onRealCost?: (sample: RealCostEvent) => void;
  /**
   * 3b.3: the running output token count during a streaming turn, for a live
   * "↓ tokens" indicator — fires many times per turn, unlike every other
   * callback here. Owner-window-local only: not broadcast to joined windows,
   * since re-streaming every delta over `/events` for a cosmetic counter isn't
   * worth the traffic.
   */
  onStreamProgress?: (outputTokens: number, project: string | undefined) => void;
  /** 5.3: a fresh session/weekly rate-limit reading arrived on a Messages response. */
  onRateLimitUpdate?: (info: UnifiedRateLimitSnapshot) => void;
  /** A window running a newer extension version than any announced so far joined (or this proxy's own window announced). */
  onExtensionVersion?: (version: string) => void;
}

export type LogFn = (message: string) => void;

/** A zeroed telemetry record, for failures that happen before the pipeline runs. */
function fallbackTelemetry(payload: MessagesPayload): OptimizationTelemetry {
  const model = String(payload?.model ?? 'unknown');
  return {
    rawTokens: 0,
    optimizedTokens: 0,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    compactionTriggered: false,
    originalModel: model,
    effectiveModel: model,
    modelDowngraded: false,
    routingReason: 'request failed before routing',
    startupModelDefaulted: false,
    cacheAnchorPlaced: false,
    cacheAnchorBelowMinimum: false,
    strippedCacheControlBlocks: 0,
    isNewUserTurn: !hasToolResults(payload ?? {}),
  };
}

/** Copy client headers that the upstream API needs, dropping hop-by-hop ones. */
function forwardableHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    headers[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

/** Credential + versioning headers only, for calls the proxy makes on its own behalf. */
function credentialHeaders(source: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta']) {
    const value = source[name];
    if (value) {
      headers[name] = value;
    }
  }
  if (!headers['anthropic-version']) {
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

/**
 * Accumulates `usage` out of a streamed SSE response.
 *
 * `message_start` carries the input side (uncached, cache write, cache read) and
 * `message_delta` carries the running output count. The parser only looks at
 * `data:` lines and keeps a carry buffer, so it is safe across chunk boundaries.
 */
class StreamUsageParser {
  private carry = '';
  private usage: ApiUsage = {};
  private sawUsage = false;

  /**
   * 3b.3: called with the running output token count on every `message_delta`,
   * for a live "↓ tokens" indicator — separate from `result()`, which is only
   * read once the stream ends.
   */
  constructor(private readonly onProgress?: (outputTokens: number) => void) {}

  feed(chunk: string): void {
    this.carry += chunk;

    // Keep the final (possibly partial) line in the buffer for the next chunk.
    const lines = this.carry.split('\n');
    this.carry = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      try {
        this.consume(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // A malformed event must not break the passthrough; the bytes are already
        // on their way to the client regardless.
      }
    }
  }

  private consume(event: Record<string, unknown>): void {
    if (event['type'] === 'message_start') {
      const message = event['message'] as Record<string, unknown> | undefined;
      const usage = message?.['usage'] as ApiUsage | undefined;
      if (usage) {
        this.usage = { ...this.usage, ...usage };
        this.sawUsage = true;
      }
      return;
    }

    if (event['type'] === 'message_delta') {
      const usage = event['usage'] as ApiUsage | undefined;
      if (usage) {
        // output_tokens on message_delta is cumulative, so overwrite rather than add.
        this.usage = { ...this.usage, ...usage };
        this.sawUsage = true;
        if (typeof usage.output_tokens === 'number') {
          this.onProgress?.(usage.output_tokens);
        }
      }
    }
  }

  result(): ApiUsage | undefined {
    return this.sawUsage ? this.usage : undefined;
  }
}

export class TokenImproverProxy {
  /**
   * Validates the cache lifetime from the response itself: any tokens written to the
   * 1 hour cache bill at 2x instead of 1.25x. Warns, and forces 5 minutes on every
   * later request even if the setting was off or the client re-added a `ttl`.
   */
  private checkCacheLifetime(usage: ApiUsage | undefined): void {
    const written1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    if (written1h <= 0) {
      return;
    }
    this.log(
      `WARNING: ${written1h} tokens were written to the 1 hour cache (2x instead of 1.25x). ` +
        (this.config.optimizer.forceFiveMinuteCache && !this.forceFiveMinuteCacheOverride
          ? 'forceFiveMinuteCache was on, so a breakpoint kept its ttl; forcing 5 minutes from now on.'
          : this.forceFiveMinuteCacheOverride
            ? 'Still seen after forcing 5 minutes: the ttl is being set somewhere the proxy does not rewrite.'
            : 'Forcing 5 minutes from now on.')
    );
    this.forceFiveMinuteCacheOverride = true;
  }

  private readonly app: Express;
  private server: http.Server | undefined;
  private config: ProxyConfig;
  private readonly observer: ProxyObserver;
  private readonly log: LogFn;
  /** Open `/events` streams from windows sharing this proxy. */
  private readonly eventClients = new Set<Response>();
  /**
   * The most recent `anthropic-ratelimit-unified-*` reading, if any request has
   * gotten one since this proxy started. Replayed to a window that joins after
   * the reading already landed, so it doesn't have to wait for the next turn to
   * see what every already-connected window already knows.
   */
  private lastRateLimitInfo: UnifiedRateLimitSnapshot | undefined;
  /** Newest extension version any window sharing this proxy has announced; replayed to windows that join later. */
  private newestVersion: string | undefined;
  /**
   * Consumed by the first `/v1/messages` request handled after `start()`, so Stage 0
   * (`applyStartupModelDefault`) fires exactly once per proxy start and never fights
   * a model the user picks afterwards, including a deliberate `/model opus`.
   */
  private awaitingStartupRequest = true;
  /** Summaries already paid for, per conversation, so history is not re-summarized every turn. */
  private readonly summaryStore: SummaryStore;
  /** Previous request size per conversation, to model the client's own caching in the baseline. */
  private readonly baselineMemory: BaselineMemory;
  /** Set once Anthropic reports a 1 hour cache write: from then on every request is forced to 5 minutes. */
  private forceFiveMinuteCacheOverride = false;
  /** Logged once: `claude_code.cost.usage` reported as DELTA temporality, which `RealCostTracker` has to sum instead of tracking as a running total. */
  private loggedDeltaCostTemporality = false;

  constructor(config: ProxyConfig, observer: ProxyObserver, log: LogFn) {
    this.config = config;
    this.summaryStore = new SummaryStore(undefined, config.summaryStorePath);
    this.baselineMemory = new BaselineMemory(undefined, undefined, config.baselineMemoryPath);
    this.observer = observer;
    this.log = log;
    this.app = this.buildApp();
  }

  get address(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }

  get running(): boolean {
    return !!this.server?.listening;
  }

  /** Send one event to every window that joined this proxy. */
  broadcast(event: ProxyEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      client.write(frame);
    }
  }

  /** Record a window's extension version; only a newer one than any seen is observed and broadcast. */
  announceVersion(version: string): void {
    if (this.newestVersion !== undefined && !isNewerVersion(version, this.newestVersion)) {
      return;
    }
    this.newestVersion = version;
    this.broadcast({ type: 'extensionVersion', version });
    this.observer.onExtensionVersion?.(version);
  }

  private buildApp(): Express {
    const app = express();
    app.disable('x-powered-by');

    // Strip the `/w/<project>` tag before routing, so every route below sees the
    // plain API path. `req.url` (not `originalUrl`) is what later layers match on.
    app.use((req, res, next) => {
      const match = PROJECT_PREFIX.exec(req.url);
      if (match) {
        try {
          res.locals['project'] = decodeURIComponent(match[1]);
        } catch {
          res.locals['project'] = match[1];
        }
        req.url = `${match[2] || '/'}${match[3] ?? ''}`;
      }
      next();
    });

    // Liveness probe, and the identity check a second window uses to decide
    // whether the process holding the port is a proxy it can join.
    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: PROXY_SERVICE_ID,
        protocol: PROXY_PROTOCOL,
        pid: process.pid,
        upstream: this.config.upstreamBaseUrl,
        optimizer: this.config.optimizer,
      });
    });

    // Turn lifecycle for the windows sharing this proxy, as server-sent events.
    app.get('/events', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      // A window joining after the reading already landed still needs to see it
      // immediately, not wait for the next turn `broadcast()` would carry it on.
      if (this.lastRateLimitInfo) {
        res.write(`data: ${JSON.stringify({ type: 'rateLimit', info: this.lastRateLimitInfo })}\n\n`);
      }
      if (this.newestVersion) {
        res.write(`data: ${JSON.stringify({ type: 'extensionVersion', version: this.newestVersion })}\n\n`);
      }
      this.eventClients.add(res);
      req.on('close', () => this.eventClients.delete(res));
    });

    // A window joining this proxy says which extension version it runs, so windows
    // still on an older one can ask to reload.
    app.post('/announce', express.json({ limit: '1kb' }), (req, res) => {
      const version: unknown = req.body?.version;
      if (typeof version !== 'string' || !/^\d+(\.\d+)*([-+][\w.-]+)?$/.test(version)) {
        res.status(400).json({ error: 'invalid version' });
        return;
      }
      this.announceVersion(version);
      res.json({ status: 'ok' });
    });

    // The optimized path.
    app.post('/v1/messages', express.json({ limit: MAX_BODY_SIZE }), (req, res) => {
      void this.handleMessages(req, res);
    });

    // Local OTel sink for Claude Code's own cost.usage — never forwarded upstream.
    app.post('/v1/metrics', express.raw({ type: 'application/x-protobuf', limit: METRICS_BODY_SIZE }), (req, res) => {
      this.handleMetrics(req, res);
    });

    // Everything else (count_tokens, models, batches, files) is relayed untouched
    // so pointing a client at this proxy does not cost it any other endpoint.
    app.use(express.raw({ type: () => true, limit: MAX_BODY_SIZE }), (req, res) => {
      void this.handlePassthrough(req, res);
    });

    return app;
  }

  // -------------------------------------------------------------------------
  // POST /v1/messages
  // -------------------------------------------------------------------------

  private requestSeq = 0;

  private async handleMessages(req: Request, res: Response): Promise<void> {
    // Logged before anything can reject it: an empty log is how the user tells
    // "no client is routed here" apart from "the pipeline broke".
    this.log('<- POST /v1/messages');

    const original = req.body as MessagesPayload;

    if (!original || typeof original !== 'object' || !Array.isArray(original.messages)) {
      // Rejected before it becomes a turn, so no start is emitted and none is owed.
      res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Body must be a Messages API request object.' },
      });
      return;
    }

    const project = res.locals['project'] as string | undefined;
    const requestId = String(++this.requestSeq);
    res.locals['requestId'] = requestId;
    this.observer.onRequestStart?.(project, !hasToolResults(original), requestId);

    // Exactly one completion per start, whichever path the request takes out.
    let settled = false;
    let telemetry: OptimizationTelemetry | undefined;
    const settle = (record: Omit<TurnRecord, 'project'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.checkCacheLifetime(record.usage);
      this.observer.onTurnComplete({ ...record, project });
    };

    try {
      await this.processTurn(req, res, original, (value) => {
        telemetry = value;
      }, settle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`turn failed: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: `Claude Token Improver failed to process the request: ${message}` },
        });
      } else {
        res.end();
      }
    } finally {
      // Backstop: a throw before any explicit settle still closes the turn.
      settle({ telemetry: telemetry ?? fallbackTelemetry(original), usage: undefined, status: 0 });
    }
  }

  private async processTurn(
    req: Request,
    res: Response,
    original: MessagesPayload,
    reportTelemetry: (telemetry: OptimizationTelemetry) => void,
    settle: (record: Omit<TurnRecord, 'project'>) => void
  ): Promise<void> {
    const headers = forwardableHeaders(req);

    // Consumed synchronously (no `await` before this line) so two requests racing
    // in right after startup can't both see themselves as the startup request.
    const isStartupRequest = this.awaitingStartupRequest;
    this.awaitingStartupRequest = false;

    // Baseline: what this turn would have cost unoptimized.
    let exactRawTokens: number | undefined;
    if (this.config.exactTokenCounting) {
      const counted = await countTokensRemote(original, this.config.upstreamBaseUrl, credentialHeaders(headers), undefined, (reason) =>
        this.log(
          `count_tokens failed (${reason}); raw falls back to the local estimate: body ${JSON.stringify(original).length} B, ` +
            `${original.messages?.length ?? 0} messages, estimate ${estimatePayloadTokens(original)} tokens`
        )
      );
      exactRawTokens = counted ?? undefined;
    }

    const optimizerConfig = this.forceFiveMinuteCacheOverride
      ? { ...this.config.optimizer, forceFiveMinuteCache: true }
      : this.config.optimizer;
    const { payload, telemetry } = await optimizePayload(original, optimizerConfig, {
      exactRawTokens,
      isStartupRequest,
      summaryStore: this.summaryStore,
      baselineMemory: this.baselineMemory,
      summarize: (messages) => this.summarizeHistory(messages, credentialHeaders(headers)),
      onStage: (stage) =>
        this.observer.onRequestOptimized?.(res.locals['project'] as string | undefined, stage, res.locals['requestId'] as string),
    });
    if (telemetry.summaryMismatch) {
      this.log('compaction: stored summary no longer matches this history; discarded and rebuilt');
    }
    reportTelemetry(telemetry);

    const isStreaming = payload['stream'] === true;
    const body = JSON.stringify(payload);

    let upstream: globalThis.Response;
    try {
      upstream = await this.fetchWithRetry(`${this.config.upstreamBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      });
    } catch (error) {
      const message = describeFetchError(error);
      this.log(`upstream request failed: ${message}`);
      settle({ telemetry, usage: undefined, status: 0, failure: message });
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: `Claude Token Improver could not reach the upstream API: ${message}` },
      });
      return;
    }

    this.logRateLimitHeaders(upstream);
    const rateLimitInfo = parseUnifiedRateLimitHeaders(upstream);
    if (rateLimitInfo) {
      this.lastRateLimitInfo = rateLimitInfo;
      this.observer.onRateLimitUpdate?.(rateLimitInfo);
    }

    // Relay the upstream status and headers before any body work begins.
    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'content-encoding') {
        res.setHeader(name, value);
      }
    });

    if (isStreaming && upstream.body) {
      await this.relayStream(upstream, res, telemetry, settle);
      return;
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      this.log(`upstream HTTP ${upstream.status} (${res.locals['project'] ?? 'unknown'}): ${text.slice(0, 300)}`);
    }
    let usage: ApiUsage | undefined;
    try {
      usage = (JSON.parse(text) as { usage?: ApiUsage }).usage;
    } catch {
      usage = undefined;
    }

    settle({ telemetry, usage, status: upstream.status });
    res.send(text);
  }

  /**
   * 5.1: whether `anthropic-ratelimit-unified-*` headers are available at all decides
   * whether Phase 2 (Pro/Max/Team % tooltip) is even possible — Anthropic doesn't
   * publish how % maps to tokens or $, so reading it off these headers is the only
   * lead. Silent when absent, so this doesn't spam the log on every turn for a plan
   * that never gets them (API/Enterprise's own headers, if any, may differ).
   */
  private logRateLimitHeaders(upstream: globalThis.Response): void {
    const found: string[] = [];
    upstream.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith('anthropic-ratelimit-unified')) {
        found.push(`${name}: ${value}`);
      }
    });
    if (found.length > 0) {
      this.log(`rate-limit headers (5.1): ${found.join(', ')}`);
    }
  }

  /**
   * Pipe an SSE response to the client while reading `usage` off the same bytes.
   *
   * The client is the priority here: every chunk is written through immediately and
   * the parser only observes. If the upstream stream breaks mid-flight we still
   * record whatever usage arrived, then end the response.
   */
  private async relayStream(
    upstream: globalThis.Response,
    res: Response,
    telemetry: OptimizationTelemetry,
    settle: (record: Omit<TurnRecord, 'project'>) => void
  ): Promise<void> {
    const project = res.locals['project'] as string | undefined;
    const parser = new StreamUsageParser((outputTokens) => this.observer.onStreamProgress?.(outputTokens, project));
    const decoder = new TextDecoder();
    const reader = upstream.body!.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        res.write(Buffer.from(value));
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`stream relay interrupted: ${message}`);
    } finally {
      settle({ telemetry, usage: parser.result(), status: upstream.status });
      res.end();
    }
  }

  // -------------------------------------------------------------------------
  // POST /v1/metrics — local-only OTel sink for Claude Code's own cost.usage
  // -------------------------------------------------------------------------

  /**
   * Claude Code's own reported cost, via the OTLP metrics it already exports when
   * `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` are set (`applyTerminalEnv` in
   * extension.ts). Never forwarded upstream — this exists purely so the tooltip
   * can show Anthropic's own number next to our estimate.
   */
  private handleMetrics(req: Request, res: Response): void {
    // OTLP/HTTP requires a 2xx with a (possibly empty) ExportMetricsServiceResponse
    // body; an empty buffer is a valid encoding since every field is optional.
    // Reply before decoding: a malformed export must never look like a failed
    // export to Claude Code's own retry logic.
    res.status(200).set('content-type', 'application/x-protobuf').end();

    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return;
    }

    let dataPoints: ReturnType<typeof decodeExportMetricsRequest>;
    try {
      dataPoints = decodeExportMetricsRequest(buffer);
    } catch (error) {
      // A malformed export must never break the proxy; the response above already went out.
      this.log(`failed to decode OTLP metrics export: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const point of dataPoints) {
      if (point.metricName !== 'claude_code.cost.usage') {
        continue; // token.usage / session.count / lines_of_code etc. are out of scope for now
      }
      if (point.temporality === 'delta' && !this.loggedDeltaCostTemporality) {
        this.loggedDeltaCostTemporality = true;
        this.log('claude_code.cost.usage reported DELTA temporality (expected cumulative) — summing increments instead of tracking a running total');
      }
      this.observer.onRealCost?.({
        seriesKey: realCostSeriesKey(point.attributes),
        timestampMs: point.timestampMs,
        valueUsd: point.valueUsd,
        temporality: point.temporality,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Stage 2 helper: summarize dropped history with Haiku
  // -------------------------------------------------------------------------

  /**
   * Turn the oldest slice of history into a dense technical manifest.
   *
   * Throws on any failure so `applyCompaction` can keep the original history — a
   * lost summary is a missed optimization, never a lost conversation.
   */
  private async summarizeHistory(
    messages: Array<Record<string, unknown>>,
    headers: Record<string, string>
  ): Promise<{ text: string; usage: SummarizerUsage | undefined }> {
    // Haiku's window is 200k tokens; a long session can hand over far more. The slice is
    // summarized in sequential chunks (cut on fresh user turns, sized by the real
    // serialized length), each into its own manifest, joined in order. No manifest is
    // ever fed back into the summarizer. On "prompt is too long" the chunk budget halves.
    let budgetChars = SUMMARIZER_CHUNK_CHARS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const texts: string[] = [];
        let usage: SummarizerUsage | undefined;
        for (const chunk of splitForSummarizer(messages, budgetChars)) {
          const result = await this.summarizeChunk(chunk, headers);
          texts.push(result.text);
          if (result.usage) {
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + result.usage.inputTokens,
              outputTokens: (usage?.outputTokens ?? 0) + result.usage.outputTokens,
            };
          }
        }
        return { text: texts.filter((t) => t.trim()).join('\n\n'), usage };
      } catch (error) {
        const tooLong = error instanceof Error && /too long|HTTP 413/i.test(error.message);
        if (!tooLong || attempt >= 3) {
          throw error;
        }
        budgetChars = Math.floor(budgetChars / 2);
        this.log(`compaction: summarizer input too long, retrying with ${budgetChars}-char chunks`);
      }
    }
  }

  private async summarizeChunk(
    messages: Array<Record<string, unknown>>,
    headers: Record<string, string>
  ): Promise<{ text: string; usage: SummarizerUsage | undefined }> {
    const chunkTokens = estimatePayloadTokens({ messages });
    const request = {
      model: HAIKU_MODEL_ID,
      // The prompt only *asks* for the target size; models routinely overshoot
      // a self-reported length target. This enforces it — Haiku's output tokens are
      // priced above Sonnet's input rate, so an unbounded manifest can cost more than
      // the history it replaces prunes (see MIN_COMPACTABLE_TOKENS in optimizer.ts).
      max_tokens: manifestMaxOutputTokens(chunkTokens),
      system: manifestSystemPrompt(manifestTargetTokens(chunkTokens)),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Compress this conversation history into the manifest:\n\n${JSON.stringify(messages)}`,
            },
          ],
        },
      ],
    };

    const response = await upstreamFetch(`${this.config.upstreamBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      // Keep Anthropic's own message: a bare 400 cannot be told apart from an oversized
      // request, a bad model id or a rejected parameter.
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`summarizer returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const parsed = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();
    // No cache fields: this request never sets `cache_control`.
    const usage: SummarizerUsage | undefined = parsed.usage
      ? { inputTokens: parsed.usage.input_tokens ?? 0, outputTokens: parsed.usage.output_tokens ?? 0 }
      : undefined;

    this.log(
      `compaction: summarized ${messages.length} messages ` +
        `(~${estimatePayloadTokens({ messages })} tokens) into ~${Math.ceil(text.length / 3.8)} tokens`
    );

    return { text, usage };
  }

  // -------------------------------------------------------------------------
  // Everything that is not POST /v1/messages
  // -------------------------------------------------------------------------

  private async handlePassthrough(req: Request, res: Response): Promise<void> {
    this.log(`<- ${req.method} ${req.path} (passthrough)`);

    // req.url, not originalUrl: the `/w/<project>` tag must not reach the upstream.
    const target = `${this.config.upstreamBaseUrl}${req.url}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    try {
      const upstream = await upstreamFetch(target, {
        method: req.method,
        headers: forwardableHeaders(req),
        // fetch takes a BodyInit; a Node Buffer has to be handed over as a plain view.
        body: hasBody && Buffer.isBuffer(req.body) && req.body.length ? new Uint8Array(req.body) : undefined,
      });

      res.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'content-encoding') {
          res.setHeader(name, value);
        }
      });

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      const message = describeFetchError(error);
      this.log(`passthrough to ${req.method} ${req.path} failed: ${message}`);
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: `Claude Token Improver could not reach the upstream API: ${message}` },
      });
    }
  }

  /** One retry after a short pause when the connection broke before any response (e.g. a stale keep-alive socket). */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<globalThis.Response> {
    try {
      return await upstreamFetch(url, init);
    } catch (error) {
      if (!isRetryableConnectionError(error)) {
        throw error;
      }
      this.log(`upstream connection failed (${describeFetchError(error)}); retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return upstreamFetch(url, init);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Bind to loopback. Rejects with a readable message when the port is taken. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server?.listening) {
        resolve();
        return;
      }

      // A fresh bind is a fresh "claude starts" moment for Stage 0, whether this is
      // the extension's first activation or a takeover after the owning window closed.
      this.awaitingStartupRequest = true;

      const server = http.createServer(this.app);

      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          reject(new ProxyPortInUseError(this.config.port));
        } else {
          reject(error);
        }
      };

      const onListening = () => {
        server.removeListener('error', onError);
        // Past startup, a socket error must not take down the extension host.
        server.on('error', (error) => this.log(`proxy server error: ${error.message}`));
        this.server = server;
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      // 127.0.0.1, never 0.0.0.0: this endpoint relays the user's API credentials.
      server.listen(this.config.port, '127.0.0.1');
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      this.server = undefined;
      // Ending the event streams is what tells joined windows to take over.
      for (const client of this.eventClients) {
        client.end();
      }
      this.eventClients.clear();
      server.close(() => resolve());
      // Drop keep-alive sockets so close() is not held open by an idle client.
      server.closeAllConnections?.();
    });
  }
}
