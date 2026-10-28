/**
 * The Optimization Engine: the pre-flight pipeline that every
 * `POST /v1/messages` payload passes through before it leaves the machine.
 *
 *   Stage 0  Startup model default     (Opus -> Sonnet, first hit since proxy start only)
 *   Stage 1  String normalization      (trim, CRLF -> LF)
 *   Stage 2  Sliding compaction        (strip fluff, summarize old history)
 *   Stage 3  Smart model routing       (downgrade trivial turns to Haiku)
 *   Stage 4  Single sliding cache anchor
 *   Stage 5  Cloudside execution       (see proxy/server.ts)
 *
 * Every stage is individually switchable, and every stage records what it did in
 * `OptimizationTelemetry` so the status bar and the analytics ledger can explain
 * the savings rather than just assert them.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cacheMultipliers, modelOutputWeight, modelWeight } from './pricing';
import { estimatePayloadTokens, MessagesPayload } from './tokenCounter';

/** Current-generation cheap model used for routing downgrades and history summaries. */
export const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';

/** Default model for the one-time startup override (Stage 0) — see `applyStartupModelDefault`. */
export const SONNET_MODEL_ID = 'claude-sonnet-5';

/** Haiku 4.5 caps output at 64K and context at 200K; respect both when downgrading. */
const HAIKU_MAX_OUTPUT_TOKENS = 64_000;
const HAIKU_SAFE_INPUT_TOKENS = 180_000;

/** Smallest and largest manifest one summarizer call may write, and its share of what it summarizes. */
export const MANIFEST_MIN_TOKENS = 150;
export const MANIFEST_MAX_TOKENS = 4_000;
const MANIFEST_SHARE = 0.02;

/**
 * Target size of the manifest for a chunk of `inputTokens`. It grows with what is being
 * summarized (about 2%) so a 100K history keeps paths, decisions and open threads in
 * detail, but stays bounded: Haiku's output tokens cost more than its input, so an
 * unbounded manifest could cost more than the history it replaces saves.
 */
export function manifestTargetTokens(inputTokens: number): number {
  return Math.min(MANIFEST_MAX_TOKENS, Math.max(MANIFEST_MIN_TOKENS, Math.round(inputTokens * MANIFEST_SHARE)));
}

/** `max_tokens` for the summarizer call: enforces the target, which the prompt only asks for. */
export function manifestMaxOutputTokens(inputTokens: number): number {
  return Math.round(manifestTargetTokens(inputTokens) * 1.5);
}

/**
 * Below this many tokens, the "older" segment being compacted can't pay for a
 * Haiku summarization call. The call bills the summarizer's own prompt overhead
 * plus a manifest priced at Haiku's (higher) output rate; when `older` is this
 * thin, that fixed cost alone can exceed the raw tokens even a minimal manifest
 * would prune, making compaction a net loss regardless of how tight the summary is.
 */
const MIN_COMPACTABLE_TOKENS = 1_500;

/** Unsummarized history that clears a conversation's `resumed` flag, so a later cold cache may compact again. */
const RESUMED_RESET_TOKENS = 50_000;

/**
 * The summarizer is billed on `JSON.stringify(messages)`, which the local estimator
 * undercounts. Measured on a real session: 9.84K NCU of Haiku input for a segment the
 * estimator sized at ~13K tokens, a ratio of ~2.1. Used to price the Haiku call before
 * making it, so the estimate errs towards "not worth it".
 */
const SUMMARIZER_INPUT_INFLATION = 2;

/** ~150k tokens at a pessimistic 2.5 chars/token (tool JSON tokenizes densely): the most one summarizer call receives; a bigger segment is split into several calls. */
export const SUMMARIZER_CHUNK_CHARS = 375_000;

/** What compacting a segment is expected to cost and save, in NCU (Sonnet input = 1.0). */
export interface CompactionEconomics {
  /** Haiku call: its (inflated) input plus a maximum-length manifest at Haiku's output rate. */
  haikuCost: number;
  /** One-off cache rewrite of everything after the manifest (0 when the cache is already cold). */
  rewriteCost: number;
  /** Input cost avoided across `expectedRequests` requests by not resending the pruned tokens. */
  savings: number;
  /** `savings - haikuCost - rewriteCost`; compact only when this is positive. */
  net: number;
}

/** The gate's inputs plus its estimate, recorded so the ledger can be compared with real costs later. */
export interface CompactionDecision extends CompactionEconomics {
  olderTokens: number;
  keptTokens: number;
  cacheWarm: boolean;
  expectedRequests: number;
}

/**
 * Expected economics of summarizing `olderTokens` while keeping `keptTokens` verbatim.
 *
 * Warm cache: the old history is read at 0.10x, so each pruned token only saves 0.10x
 * per request, and the kept tail plus manifest must be rewritten once at 1.25x.
 * Cold cache: the next request writes the whole history at 1.25x anyway, so a pruned
 * token saves 1.25x immediately (then 0.10x on later requests) with no rewrite penalty.
 * `expectedRequests` is the one thing that cannot be known in advance.
 */
export function estimateCompactionEconomics(input: {
  olderTokens: number;
  keptTokens: number;
  cacheWarm: boolean;
  expectedRequests: number;
  /** `JSON.stringify` length of the segment; sets how many summarizer calls (each with its own manifest) it takes. */
  serializedChars?: number;
  /** Model whose cache rates apply; the table's default when omitted. */
  model?: string;
}): CompactionEconomics {
  const requests = Math.max(1, input.expectedRequests);
  const { read: readRate, write: writeRate, unpriced } = cacheMultipliers(input.model);
  const calls = Math.max(1, Math.ceil((input.serializedChars ?? 0) / SUMMARIZER_CHUNK_CHARS));
  // One manifest per chunk, each sized to its share of the segment (worst case: the cap).
  const manifestTokens = calls * manifestMaxOutputTokens(input.olderTokens / calls);
  const pruned = Math.max(0, input.olderTokens - manifestTokens);

  const haikuCost =
    input.olderTokens * SUMMARIZER_INPUT_INFLATION * modelWeight(HAIKU_MODEL_ID) +
    manifestTokens * modelOutputWeight(HAIKU_MODEL_ID);

  // Without the model's cache rates the saving cannot be estimated, and a guess would decide a real
  // spend: do not compact until the pricing table has them.
  if (unpriced?.includes('read') || unpriced?.includes('write')) {
    return { haikuCost, rewriteCost: 0, savings: 0, net: -haikuCost };
  }

  const rewriteCost = input.cacheWarm
    ? (input.keptTokens + manifestTokens) * (writeRate - readRate)
    : 0;
  const savings = input.cacheWarm
    ? pruned * readRate * requests
    : pruned * (writeRate + readRate * (requests - 1));

  return { haikuCost, rewriteCost, savings, net: savings - haikuCost - rewriteCost };
}

/**
 * Conversational filler that carries no instruction. Stripped from the head of
 * user text, most specific pattern first: the generic greeting rule would
 * otherwise eat the "Please" out of "Please help me with X" and strand the rest.
 */
const FLUFF_PATTERNS: RegExp[] = [
  /^\s*(could|can|would)\s+you\s+(please\s+)?(help\s+me\s+(with|to)\s+)?/i,
  /^\s*please\s+help\s+me\s+(with|to)\s+/i,
  /^\s*i\s+(was\s+)?wondering\s+if\s+you\s+(could|can)\s+/i,
  /^\s*(just\s+)?a\s+quick\s+question[,:.\s]+/i,
  /^\s*(hey|hi|hello|yo|ok|okay|thanks|thank you|please)[,!.\s]+(claude|there)?[,!.\s]*/i,
  // Runs after the greeting rule above has consumed a leading "Please".
  /^\s*help\s+me\s+(with|to)\s+/i,
];

/** Latest-turn signals that a request is mechanical enough for Haiku. */
const SIMPLE_TASK_PATTERNS: RegExp[] = [
  /\b(regex|regular expression)\b/i,
  /\b(reformat|re-format|format|prettify|indent)\b/i,
  /\b(rename|typo|spelling|grammar)\b/i,
  /\b(convert|translate)\s+(this|the following|it)\s+(to|into)\b/i,
  /\b(list|extract|sort|dedupe|deduplicate|count)\b/i,
  /\b(what does|what is)\s+this\s+(do|mean)\b/i,
  /\b(formatea|formatear|renombra|renombrar|cambia(le)? el nombre|corrige|corregir|ortograf[ií]a|gram[aá]tica|ordena|ordenar|cuenta|contar|lista|listar|extrae|extraer|elimina duplicados)\b/i,
  /\b(traduce|traducir|convierte|convertir)\s+(esto|este|esta|lo siguiente|el siguiente)\b/i,
  /\bqu[eé]\s+(hace|significa)\s+(esto|este|esta)\b/i,
  /\b(expresi[oó]n regular)\b/i,
];

/** A whole turn that is just a greeting or courtesy, in English or Spanish. */
const GREETING_PATTERN =
  /^\s*(hola|hey|hi|hello|buen(os|as)\s+(d[ií]as|tardes|noches)|good\s+(morning|afternoon|evening)|gracias|muchas gracias|thanks|thank you|ok(ay)?|vale|listo|perfecto|genial|great|cool|entendido|got it)\b[\s\S]{0,80}$/i;

const CODE_FENCE_PATTERN = /```|`[^`\n]+`/;

/** A short question with no code is cheap enough for Haiku. */
const SHORT_QUESTION_MAX_CHARS = 150;

/** Latest-turn signals that the request needs the full-strength model regardless of length. */
const COMPLEX_TASK_PATTERNS: RegExp[] = [
  /\b(architect|architecture|design|refactor|migrate|debug|investigate|root cause)\b/i,
  /\b(why (is|does|did|are)|trace|diagnose|race condition|deadlock|memory leak)\b/i,
  /\b(implement|build|write)\s+(a|an|the)\s+\w+\s+(system|service|feature|module|pipeline)\b/i,
  /\b(security|vulnerability|threat model|performance regression)\b/i,
  /\b(arquitectura|dise[ñn]a|dise[ñn]o|refactoriza|refactorizar|migra|migrar|depura|depurar|investiga|investigar|causa ra[ií]z|diagnostica|fuga de memoria|condici[oó]n de carrera)\b/i,
  // No trailing \b: without the `u` flag it does not treat an accented letter as a word character.
  /\b(por qu[eé]|c[oó]mo (arreglo|soluciono|resuelvo))/i,
  /\b(implementa|implementar|construye|crea|escribe)\s+(un|una|el|la)\s+\w+/i,
  /\b(seguridad|vulnerabilidad|modelo de amenazas)\b/i,
];

/** Above this many characters the latest turn is never treated as trivial. */
const SIMPLE_TASK_MAX_CHARS = 400;

export interface OptimizerConfig {
  enableNormalization: boolean;
  enableCompaction: boolean;
  enableModelRouting: boolean;
  enableCacheAnchor: boolean;
  /** Drop `ttl` from every `cache_control`, so all writes use the 5 minute cache (1.25x, not 2x for 1 hour). */
  forceFiveMinuteCache: boolean;
  /** Stage 0. See `applyStartupModelDefault`. */
  enableStartupSonnetDefault: boolean;
  /** Cumulative history size that triggers a Cache Reset Optimization. */
  slidingThresholdTokens: number;
  /** Fraction of the oldest history replaced by the manifest. */
  compactionFraction: number;
    /** Requests assumed to follow a compaction when judging whether it pays for itself. */
  expectedRequestsAfterCompaction: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  enableNormalization: true,
  enableCompaction: true,
  enableModelRouting: true,
  enableCacheAnchor: true,
  forceFiveMinuteCache: true,
  enableStartupSonnetDefault: true,
  slidingThresholdTokens: 15_000,
  compactionFraction: 0.75,
  expectedRequestsAfterCompaction: 10,
};

export interface OptimizationTelemetry {
  /** Locally estimated (or exactly counted) input tokens before any stage ran. */
  rawTokens: number;
  /** Estimated input tokens after all stages ran. */
  optimizedTokens: number;
  /** Tokens removed by normalization + fluff stripping. */
  prunedByNormalization: number;
  /** Tokens removed by replacing old history with the manifest. */
  prunedByCompaction: number;
  compactionTriggered: boolean;
  /** True when `rawTokens` is the API's own `count_tokens` figure; false when it is the local estimate. */
  rawTokensExact?: boolean;
  /** History tokens the compaction gate measured on this turn (stored summaries + unsummarized messages), before any compaction. Set only when the gate ran. */
  historyTokens?: number;
  /** The history size at which the gate fires for this turn (cold vs warm cache threshold). */
  compactionTriggerTokens?: number;
  compactionError?: string;
  /** Why a history that reached the threshold was not summarized, when the proxy chose not to. */
  compactionSkippedReason?: string;
  /** Inputs and verdict of the economics gate, set whenever it was evaluated (compacted or skipped). */
  compactionEconomics?: CompactionDecision;
  originalModel: string;
  effectiveModel: string;
  modelDowngraded: boolean;
  routingReason: string;
  /**
   * True when Stage 0 rewrote an Opus request to Sonnet because it was the first
   * `/v1/messages` hit since the proxy started. Distinct from `modelDowngraded`
   * (Stage 3's per-turn Haiku routing) so the status bar can explain the two
   * separately instead of attributing a startup default to the routing heuristic.
   */
  startupModelDefaulted: boolean;
  cacheAnchorPlaced: boolean;
  /** True when the anchored prefix is too short for the server to actually cache it. */
  cacheAnchorBelowMinimum: boolean;
  strippedCacheControlBlocks: number;
  /**
   * False when this request is a tool-result continuation of an agentic loop rather
   * than a fresh human-typed message. One Enter press in the client can fan out into
   * several of these before the loop hands control back, so the UI groups them under
   * one "last turn" instead of showing only the final hit.
   */
  isNewUserTurn: boolean;
  /** Role and block kinds of the last messages sent, kept only when the request opens a turn, to audit why it did. */
  newTurnShape?: string;
  /**
   * Usage of the Haiku call that produced the compaction manifest, when compaction
   * ran (3.2). No cache fields: the summarizer's own request never sets
   * `cache_control`, so there is nothing to read read/write on that call.
   */
  summarizerUsage?: SummarizerUsage;
  /**
   * True when this request reused summaries the proxy already paid for, with no
   * Haiku call. `compactionTriggered` stays false on such a turn: it counts
   * summarizer calls, while `prunedByCompaction` still reports the tokens this
   * request did not have to send.
   */
  summaryReused?: boolean;
  /** True when a stored summary no longer matched the incoming history and was discarded. */
  summaryMismatch?: boolean;
  /**
   * How many tokens of the original request the client's own prompt caching would
   * have read at the cache-read price had the proxy not been there. Lets the
   * baseline be "what this request costs with the caching Claude Code already
   * does" instead of "with no caching at all", which credited the proxy for a
   * discount the client gets anyway. Undefined when the client does not mark
   * anything for caching, or when no memory was supplied.
   */
  baselineCachedTokens?: number;
  /** Cache lifetime the client's own breakpoints asked for (5 min or 1 h). */
  clientCacheTtlMs?: number;
  /**
   * Tokens the client would have read from cache with the longest-lived cache there is:
   * the previous request's whole prefix if it was sent within the last hour. The
   * best case for the client, so the baseline built on it is a floor on the saving.
   */
  floorCachedTokens?: number;
  /**
   * Where the request's cacheable prefix first differs from the previous request of the
   * same conversation (see `describePrefixChange`), for what the client sent and for what
   * the proxy forwarded. A change in `sentPrefixChange` with none in `clientPrefixChange`
   * means the proxy broke the cache. Optional: absent on older rows.
   */
  clientPrefixChange?: string;
  sentPrefixChange?: string;
}

export interface OptimizationResult {
  payload: MessagesPayload;
  telemetry: OptimizationTelemetry;
}

export interface SummarizerUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Callback used by Stage 2 to summarize old history. Injected rather than imported
 * so the engine stays testable without a network or credentials. Returns the usage
 * of that Haiku call alongside the manifest text so its real cost can be counted
 * (3.2) instead of vanishing into an untracked side effect.
 */
export type SummarizeFn = (
  messages: Array<Record<string, unknown>>
) => Promise<{ text: string; usage: SummarizerUsage | undefined }>;

/** The prompt that turns dropped history into a dense technical state manifest. */
export function manifestSystemPrompt(targetTokens: number): string {
  return [
    'You compress software-engineering conversation history into a technical state manifest.',
    `Produce at most ${targetTokens} tokens of bulleted Markdown under exactly these headings:`,
    '**Active Stack**, **Code Inventory**, **Resolved Bugs**, **Open Threads**.',
    'Record only durable facts: file paths, symbol names, decisions made, bugs fixed, and work still outstanding.',
    'Omit pleasantries, restated questions, and anything already superseded. No preamble, no closing remarks.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Stage 0: one-time startup model default
// ---------------------------------------------------------------------------

/**
 * Claude Code defaults new sessions to Opus. Left alone, that means every
 * accidental "just start a session" runs at Opus pricing until the user notices
 * and runs `/model` themselves. This stage only ever fires on the first
 * `/v1/messages` request the proxy handles after it (re)starts (`isStartupRequest`,
 * set by the caller) — every later request, including one where the user has
 * explicitly picked Opus again via `/model`, passes through untouched.
 */
function applyStartupModelDefault(payload: MessagesPayload, telemetry: OptimizationTelemetry): MessagesPayload {
  const model = String(payload.model ?? '');
  if (!model.includes('opus')) {
    return payload;
  }
  telemetry.startupModelDefaulted = true;
  telemetry.effectiveModel = SONNET_MODEL_ID;
  return { ...payload, model: SONNET_MODEL_ID };
}

// ---------------------------------------------------------------------------
// Stage 1: string normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a text value: Windows line endings become Unix, trailing whitespace on
 * each line goes away, and the value is trimmed. Byte-identical prefixes are what
 * make a cache hit possible, so this runs before anything else touches the payload.
 */
export function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Recursively normalize every string reachable from a content value. */
function normalizeContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return normalizeText(content);
  }
  if (Array.isArray(content)) {
    return content.map(normalizeContent);
  }
  if (content && typeof content === 'object') {
    const source = content as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      // `text` is the only free-text field we rewrite; other strings (ids, model
      // names, media types) must survive byte-for-byte. `thinking` is left alone
      // too: its `signature` covers the exact text, so a trimmed block is rejected.
      if (key === 'text' && typeof value === 'string') {
        out[key] = normalizeText(value);
      } else if (key === 'content') {
        out[key] = normalizeContent(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }
  return content;
}

function applyNormalization(payload: MessagesPayload): MessagesPayload {
  const next: MessagesPayload = { ...payload };
  if (next.system !== undefined) {
    next.system = normalizeContent(next.system);
  }
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message) => ({
      ...message,
      content: normalizeContent(message['content']),
    }));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Stage 2: fluff stripping + sliding compaction
// ---------------------------------------------------------------------------

/** Remove leading conversational filler. Applied only to user-authored text. */
export function stripFluff(text: string): string {
  let out = text;
  let changed = true;

  // Filler often stacks ("Hey Claude, could you please ..."), so loop until stable.
  while (changed) {
    changed = false;
    for (const pattern of FLUFF_PATTERNS) {
      const stripped = out.replace(pattern, '');
      if (stripped !== out) {
        out = stripped;
        changed = true;
      }
    }
  }

  return out.trim() || text.trim();
}

function applyFluffStripping(payload: MessagesPayload): MessagesPayload {
  if (!Array.isArray(payload.messages)) {
    return payload;
  }

  const messages = payload.messages.map((message) => {
    if (message['role'] !== 'user') {
      return message;
    }

    const content = message['content'];
    if (typeof content === 'string') {
      return { ...message, content: stripFluff(content) };
    }
    if (!Array.isArray(content)) {
      return message;
    }

    // Only the first text block can carry a greeting; later blocks are payload.
    let done = false;
    const blocks = content.map((block) => {
      if (done || !block || typeof block !== 'object') {
        return block;
      }
      const typed = block as Record<string, unknown>;
      if (typed['type'] !== 'text' || typeof typed['text'] !== 'string') {
        return block;
      }
      done = true;
      return { ...typed, text: stripFluff(typed['text'] as string) };
    });

    return { ...message, content: blocks };
  });

  return { ...payload, messages };
}

/**
 * True for a `user` message that starts a fresh turn rather than continuing an
 * agentic loop. A message carrying `tool_result` blocks answers a `tool_use` in the
 * immediately preceding assistant message; cutting between them strands that
 * `tool_result` with no matching `tool_use` in the payload, which the API rejects as
 * an orphaned tool_result.
 */
export function isFreshUserTurn(message: Record<string, unknown> | undefined): boolean {
  if (!message || message['role'] !== 'user') {
    return false;
  }
  const content = message['content'];
  if (!Array.isArray(content)) {
    return true;
  }
  return !content.some(
    (block) => !!block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result'
  );
}

/**
 * Summaries the proxy has already paid for, per conversation.
 *
 * The client resends its whole history on every request, so a stateless proxy
 * would summarize the same old turns again each time. This remembers, for one
 * conversation, the summaries produced so far and which leading messages they
 * replace. A later request whose leading messages hash the same reuses them with
 * no Haiku call, and the summary text stays byte-identical, so the provider's
 * prompt cache keeps matching that prefix.
 */
export interface SummaryState {
  /** How many leading messages of the normalized history the summaries replace. */
  coveredCount: number;
  /** Hash of those leading messages, so an edited or unrelated history never matches. */
  prefixHash: string;
  /** One manifest per block, oldest first. A stored manifest is never rewritten. */
  summaries: string[];
  /**
   * True once a cold cache already triggered a compaction for this conversation. A later
   * cold cache then reuses the stored summary instead of paying Haiku again, until 50K tokens
   * of new history pile up after the summary (RESUMED_RESET_TOKENS).
   */
  resumed?: boolean;
  /** Epoch ms of the last write or reuse. Entries unused for `SUMMARY_TTL_MS` are dropped on load. */
  lastUsed?: number;
}

/** A stored summary nobody has touched for this long is deleted: it holds project paths and decisions. */
export const SUMMARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A reuse only rewrites the file when the stored `lastUsed` is older than this, so reads stay cheap. */
const SUMMARY_TOUCH_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded (least recently used) store of `SummaryState`, keyed by conversation.
 *
 * With a `filePath` it survives restarts: loaded once at construction and rewritten
 * (atomically) whenever a state is added or removed. That only happens when a
 * compaction runs, so the synchronous write is rare and small. A missing or corrupt
 * file just means starting empty; a stale state can never be applied because every
 * use is checked against `prefixHash`.
 */
export class SummaryStore {
  private readonly states = new Map<string, SummaryState>();

  constructor(
    private readonly maxConversations = 50,
    private readonly filePath?: string,
    private readonly now: () => number = Date.now
  ) {
    this.load();
  }

  private load(): void {
    if (!this.filePath) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { states?: Record<string, SummaryState> };
      for (const [key, state] of Object.entries(parsed.states ?? {})) {
        if (
          state &&
          typeof state.coveredCount === 'number' &&
          typeof state.prefixHash === 'string' &&
          Array.isArray(state.summaries) &&
          state.summaries.every((summary) => typeof summary === 'string')
        ) {
          // An entry from before `lastUsed` existed starts its month now.
          const lastUsed = typeof state.lastUsed === 'number' ? state.lastUsed : this.now();
          if (this.now() - lastUsed < SUMMARY_TTL_MS) {
            this.states.set(key, { ...state, lastUsed });
          }
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
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, states: Object.fromEntries(this.states) }), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch {
      // Persistence is best effort: a failed write costs a re-summarize, never a request.
    }
  }

  get size(): number {
    return this.states.size;
  }

  get(key: string): SummaryState | undefined {
    const state = this.states.get(key);
    if (state) {
      // Re-insert so the Map's iteration order tracks recency.
      this.states.delete(key);
      this.states.set(key, state);
      if (this.now() - (state.lastUsed ?? 0) > SUMMARY_TOUCH_MS) {
        state.lastUsed = this.now();
        this.save();
      }
    }
    return state;
  }

  set(key: string, state: SummaryState): void {
    this.states.delete(key);
    this.states.set(key, { ...state, lastUsed: this.now() });
    while (this.states.size > this.maxConversations) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.states.delete(oldest);
    }
    this.save();
  }

  delete(key: string): void {
    if (this.states.delete(key)) {
      this.save();
    }
  }

  clear(): void {
    this.states.clear();
    this.save();
  }
}

/** True when the client marks anything for caching: system, tools or messages. */
export function hasClientCacheControl(payload: MessagesPayload): boolean {
  const found = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(found);
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return 'cache_control' in record || Object.values(record).some(found);
    }
    return false;
  };
  return found(payload.system) || found(payload.tools) || found(payload.messages);
}

export const CACHE_TTL_5M_MS = 5 * 60 * 1000;
export const CACHE_TTL_1H_MS = 60 * 60 * 1000;

/**
 * The cache lifetime the client asked for: 1 hour when any of its `cache_control`
 * breakpoints carries `ttl: "1h"` (Claude Code does this for its system prompt and
 * tools), otherwise the 5 minute default. Assuming 5 minutes for a 1 hour cache made
 * every pause look cold, so the proxy compacted early and the baseline overcharged.
 */
export function clientCacheTtlMs(payload: MessagesPayload): number {
  const longLived = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(longLived);
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const control = record['cache_control'];
      if (control && typeof control === 'object' && (control as Record<string, unknown>)['ttl'] === '1h') {
        return true;
      }
      return Object.values(record).some(longLived);
    }
    return false;
  };
  return longLived(payload.system) || longLived(payload.tools) || longLived(payload.messages)
    ? CACHE_TTL_1H_MS
    : CACHE_TTL_5M_MS;
}

/**
 * Removes `ttl` from every `cache_control` so the API falls back to its 5 minute
 * default. A 1 hour write bills 2x base input against 1.25x, and pauses over 5 minutes
 * are rare, so the longer lifetime costs more than it saves.
 */
export function forceFiveMinuteCache(payload: MessagesPayload): MessagesPayload {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'cache_control' && child && typeof child === 'object') {
          const { ttl: _ttl, ...control } = child as Record<string, unknown>;
          out[key] = control;
        } else {
          out[key] = visit(child);
        }
      }
      return out;
    }
    return value;
  };
  return {
    ...payload,
    ...(payload.system !== undefined ? { system: visit(payload.system) as MessagesPayload['system'] } : {}),
    ...(payload.tools !== undefined ? { tools: visit(payload.tools) as MessagesPayload['tools'] } : {}),
    ...(payload.messages !== undefined ? { messages: visit(payload.messages) as MessagesPayload['messages'] } : {}),
  };
}

/**
 * Remembers the size of each conversation's previous request, so the baseline can
 * model the client's own caching: the previous request's prefix is still cached
 * (and gets read at 0.10x) if it was sent within the cache lifetime, and only the
 * growth since then is written (1.25x). The conversation is identified by its
 * first message, like `SummaryStore`.
 */
export class BaselineMemory {
  private readonly last = new Map<string, { rawTokens: number; at: number; ttlMs?: number }>();

  /**
   * With a `filePath` the last request time of every conversation survives a proxy
   * restart, so a restart no longer makes a warm cache look cold. Best effort: a
   * missing or corrupt file starts empty.
   */
  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly maxConversations = 200,
    private readonly filePath?: string
  ) {
    this.load();
  }

  private load(): void {
    if (!this.filePath) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as {
        last?: Record<string, { rawTokens: number; at: number; ttlMs?: number }>;
      };
      for (const [key, value] of Object.entries(parsed.last ?? {})) {
        if (value && typeof value.rawTokens === 'number' && typeof value.at === 'number') {
          this.last.set(key, {
            rawTokens: value.rawTokens,
            at: value.at,
            ttlMs: typeof value.ttlMs === 'number' ? value.ttlMs : undefined,
          });
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
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, last: Object.fromEntries(this.last) }), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch {
      // A failed write only makes the next restart treat the cache as cold.
    }
  }

  /**
   * Tokens the best possible client cache would read for this request: the previous prefix,
   * as long as it is at most 1 hour old. No cache lives longer, so this is a true upper bound
   * on what the client reads (a floor on the saving), without pretending a cache survived
   * a night. Call before `cachedTokens`, which overwrites the entry.
   */
  warmCachedTokens(key: string, rawTokens: number, now: number): number {
    const previous = this.last.get(key);
    return previous && now - previous.at <= CACHE_TTL_1H_MS ? Math.min(previous.rawTokens, rawTokens) : 0;
  }

  /**
   * Tokens the client's caching would have read for this request, then remembers it.
   * What the previous request wrote lives for the lifetime that request asked for
   * (`ttlMs`), so the cache is judged by the TTL it was written with.
   */
  cachedTokens(key: string, rawTokens: number, now: number, ttlMs: number = this.ttlMs): number {
    const previous = this.last.get(key);
    const cached =
      previous && now - previous.at <= (previous.ttlMs ?? this.ttlMs) ? Math.min(previous.rawTokens, rawTokens) : 0;
    this.last.delete(key);
    this.last.set(key, { rawTokens, at: now, ttlMs });
    while (this.last.size > this.maxConversations) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.last.delete(oldest);
    }
    this.save();
    return cached;
  }
}

/**
 * Hash of a run of messages, ignoring `cache_control`: the client moves its own
 * breakpoints between turns, which must not make an unchanged history look edited.
 */
function hashMessages(messages: Array<Record<string, unknown>>): string {
  const { messages: stable } = stripMessageCacheControl(messages);
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

interface PrefixFingerprint {
  model: string;
  tools: string;
  system: string;
  messages: string[];
}

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

/** Drops `cache_control` (client breakpoints move every turn) so only real content is compared. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCacheControl);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key !== 'cache_control') {
        out[key] = withoutCacheControl(child);
      }
    }
    return out;
  }
  return value;
}

function fingerprintPrefix(payload: MessagesPayload): PrefixFingerprint {
  const record = payload as Record<string, unknown>;
  return {
    model: String(record['model'] ?? ''),
    tools: sha(withoutCacheControl(record['tools'])),
    system: sha(withoutCacheControl(record['system'])),
    messages: ((record['messages'] as unknown[] | undefined) ?? []).map((message) => sha(withoutCacheControl(message))),
  };
}

/**
 * First place the cacheable prefix differs from the previous request, in the order the API
 * builds it (tools, system, messages): 'model', 'tools', 'system', 'msg[i]', 'shrunk' when
 * the history got shorter, or 'none' when the previous prefix is still intact.
 */
export function describePrefixChange(previous: PrefixFingerprint | undefined, current: PrefixFingerprint): string {
  if (!previous) {
    return 'first';
  }
  if (previous.model !== current.model) {
    return 'model';
  }
  if (previous.tools !== current.tools) {
    return 'tools';
  }
  if (previous.system !== current.system) {
    return 'system';
  }
  const shared = Math.min(previous.messages.length, current.messages.length);
  for (let i = 0; i < shared; i += 1) {
    if (previous.messages[i] !== current.messages[i]) {
      return `msg[${i}]`;
    }
  }
  return current.messages.length < previous.messages.length ? 'shrunk' : 'none';
}

const MAX_TRACKED_CONVERSATIONS = 64;
const lastClientPrefix = new Map<string, PrefixFingerprint>();
const lastSentPrefix = new Map<string, PrefixFingerprint>();

function trackPrefix(store: Map<string, PrefixFingerprint>, key: string, payload: MessagesPayload): string {
  const current = fingerprintPrefix(payload);
  const change = describePrefixChange(store.get(key), current);
  store.delete(key);
  store.set(key, current);
  if (store.size > MAX_TRACKED_CONVERSATIONS) {
    store.delete(store.keys().next().value as string);
  }
  return change;
}

/**
 * The manifest that stands in for the summarized history: one user message with
 * one text block per summary, followed by a fixed assistant acknowledgement. A
 * summary gets its own block so appending another leaves the earlier blocks, and
 * therefore the cacheable prefix, untouched.
 */
function buildManifestTurns(summaries: string[]): Array<Record<string, unknown>> {
  const blocks = summaries.map((text, index) => ({
    type: 'text',
    text:
      index === 0
        ? `Compacted session state (earlier history replaced):\n\n${normalizeText(text)}`
        : `Later update:\n\n${normalizeText(text)}`,
  }));
  return [
    { role: 'user', content: blocks },
    { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged. Continuing from that state.' }] },
  ];
}

/**
 * Where to cut `messages` so everything before the cut can be summarized: the
 * newest `(1 - compactionFraction)` share of the threshold, measured in tokens,
 * stays verbatim. Returns -1 when there is no usable cut.
 */
function pickCompactionCutoff(messages: Array<Record<string, unknown>>, config: OptimizerConfig): number {
  // Always leave the newest turn (and its preceding assistant turn) untouched.
  const maxCompactable = messages.length - 2;

  // Grow the kept "recent" tail backward from the newest message, message by
  // message, until it would exceed the token budget. The last two messages are
  // always kept regardless of size (see above); beyond that, growth stops as soon
  // as the budget would be exceeded rather than at a fixed fraction of the message
  // count, so the tail's actual weight — not its length — decides where it ends.
  const keepBudgetTokens = Math.max(1, Math.round((1 - config.compactionFraction) * config.slidingThresholdTokens));
  let cutoff = messages.length;
  let recentTokens = 0;
  for (let index = messages.length - 1; index >= maxCompactable; index -= 1) {
    recentTokens += estimatePayloadTokens({ messages: [messages[index]] });
    cutoff = index;
  }
  for (let index = maxCompactable - 1; index >= 0; index -= 1) {
    const messageTokens = estimatePayloadTokens({ messages: [messages[index]] });
    if (recentTokens + messageTokens > keepBudgetTokens) {
      break;
    }
    recentTokens += messageTokens;
    cutoff = index;
  }

  // Walk back to the nearest boundary that doesn't split a tool_use/tool_result pair.
  while (cutoff >= 2 && !isFreshUserTurn(messages[cutoff])) {
    cutoff -= 1;
  }
  return cutoff < 2 ? -1 : cutoff;
}

/**
 * Sliding compaction, in blocks.
 *
 * Once the history that is not yet summarized crosses the sliding threshold, that
 * slice (and only that slice) is summarized into one manifest and appended after
 * the manifests already stored, keeping a `(1 - compactionFraction)` token budget
 * of the newest messages verbatim. What the model receives is always
 * `stored summaries + newer turns, verbatim`. Earlier summaries are never
 * summarized again, so no detail is lost to repeated compression, and their text
 * stays identical from one request to the next.
 *
 * With a `store`, the proxy remembers those summaries per conversation and reuses
 * them on later requests, including tool-result continuations, without another
 * Haiku call. Without one it behaves statelessly: every trigger summarizes the
 * whole older history, as it did before the store existed.
 *
 * A new summary is only ever *created* on a fresh user turn (`telemetry.isNewUserTurn`),
 * never on a tool_result continuation: within one agentic loop the unsummarized
 * slice only grows, and summarizing it on every round trip cost more in Haiku
 * tokens than it pruned (real session data: 93% of triggers fired on a
 * continuation). Reusing a stored summary is free, so it applies on every turn.
 *
 * The newest turn is never compacted, and the rebuilt history always starts on a
 * fresh `user` turn (never a `tool_result` continuation) so a `tool_use` never ends
 * up on one side of the cut while its `tool_result` ends up on the other.
 */
async function applyCompaction(
  payload: MessagesPayload,
  config: OptimizerConfig,
  summarize: SummarizeFn | undefined,
  telemetry: OptimizationTelemetry,
  store?: SummaryStore
): Promise<MessagesPayload> {
  const messages = payload.messages ?? [];
  if (messages.length < 2) {
    return payload;
  }

  // The conversation is identified by its first message; the prefix hash below
  // is what actually proves the stored summaries still describe this history.
  const key = store ? hashMessages(messages.slice(0, 1)) : undefined;
  let state: SummaryState | undefined;
  if (store && key) {
    const saved = store.get(key);
    if (saved) {
      const matches =
        messages.length > saved.coveredCount &&
        hashMessages(messages.slice(0, saved.coveredCount)) === saved.prefixHash;
      if (matches) {
        state = saved;
      } else {
        store.delete(key);
        telemetry.summaryMismatch = true;
      }
    }
  }

  let coveredCount = state?.coveredCount ?? 0;
  let summaries = state?.summaries ?? [];
  let summarizedNow = false;

  if (summarize && telemetry.isNewUserTurn) {
    const unsummarized = messages.slice(coveredCount);
    const storedTokens = summaries.length ? estimatePayloadTokens({ messages: buildManifestTurns(summaries) }) : 0;
    const historyTokens = storedTokens + estimatePayloadTokens({ messages: unsummarized });

    const cacheWarm = (telemetry.baselineCachedTokens ?? 0) > 0;
    const unsummarizedTokens = estimatePayloadTokens({ messages: unsummarized });
    const alreadyResumed = state?.resumed === true && unsummarizedTokens < RESUMED_RESET_TOKENS;
    const triggerTokens = config.slidingThresholdTokens;
    const eligible = historyTokens >= triggerTokens;
    telemetry.historyTokens = historyTokens;
    telemetry.compactionTriggerTokens = cacheWarm ? undefined : triggerTokens;

    // Every turn that was big enough to consider leaves a reason (the sizes are in
    // `historyTokens` / `compactionTriggerTokens`), so a missing compaction is never silent.
    if (eligible && cacheWarm) {
      telemetry.compactionSkippedReason = 'cache is warm; compaction waits for a cold cache';
    } else if (eligible && alreadyResumed) {
      telemetry.compactionSkippedReason = 'cache is cold again; this conversation was already resumed on an earlier pause';
    } else if (eligible && unsummarized.length < 4) {
      telemetry.compactionSkippedReason = 'fewer than 4 unsummarized messages';
    }

    if (eligible && !cacheWarm && !alreadyResumed && unsummarized.length >= 4) {
      const cutoff = pickCompactionCutoff(unsummarized, config);
      const older = cutoff === -1 ? [] : unsummarized.slice(0, cutoff);
      const olderTokens = cutoff === -1 ? 0 : estimatePayloadTokens({ messages: older });

      // Never call Haiku unless the expected saving beats what the call and the
      // cache rewrite cost; a loss here is spent before any request can recoup it.
      let worthIt = cutoff !== -1 && olderTokens >= MIN_COMPACTABLE_TOKENS;
      if (worthIt) {
        const inputs = {
          olderTokens,
          keptTokens: estimatePayloadTokens({ messages: unsummarized.slice(cutoff) }),
          cacheWarm,
          expectedRequests: config.expectedRequestsAfterCompaction,
          serializedChars: JSON.stringify(older).length,
          model: telemetry.effectiveModel,
        };
        const economics = estimateCompactionEconomics(inputs);
        telemetry.compactionEconomics = { ...inputs, ...economics };
        if (economics.net <= 0) {
          worthIt = false;
          telemetry.compactionSkippedReason =
            `expected net ${Math.round(economics.net)} NCU: saves ${Math.round(economics.savings)}, ` +
            `costs ${Math.round(economics.haikuCost + economics.rewriteCost)}`;
        }
      }

      if (worthIt) {
        try {
          const result = await summarize(older);
          if (!result.text.trim()) {
            telemetry.compactionError = 'summarizer returned an empty manifest';
          } else {
            summaries = [...summaries, result.text];
            coveredCount += cutoff;
            summarizedNow = true;
            telemetry.summarizerUsage = result.usage;
            if (store && key) {
              store.set(key, {
                coveredCount,
                prefixHash: hashMessages(messages.slice(0, coveredCount)),
                summaries,
                resumed: true,
              });
            }
          }
        } catch (error) {
          // A failed summarization must never drop the user's history.
          telemetry.compactionError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  if (!summaries.length) {
    return payload;
  }

  const manifestTurns = buildManifestTurns(summaries);
  // `messages[coveredCount]` is a fresh user turn (see `pickCompactionCutoff`), so
  // the rest can follow the manifest pair without further adjustment.
  const rebuilt = [...manifestTurns, ...messages.slice(coveredCount)];

  telemetry.compactionTriggered = summarizedNow;
  telemetry.summaryReused = !summarizedNow;
  telemetry.prunedByCompaction = Math.max(
    0,
    estimatePayloadTokens({ messages: messages.slice(0, coveredCount) }) -
      estimatePayloadTokens({ messages: manifestTurns })
  );

  return { ...payload, messages: rebuilt };
}

// ---------------------------------------------------------------------------
// Stage 3: smart model routing
// ---------------------------------------------------------------------------

/** Flatten the latest user turn to plain text for classification. */
export function latestUserText(payload: MessagesPayload): string {
  const messages = payload.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message['role'] !== 'user') {
      continue;
    }

    const content = message['content'];
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
        .filter((block) => block['type'] === 'text' && !isInjectedText(block))
        .map((block) => String(block['text'] ?? ''))
        .join('\n');
    }
    return '';
  }
  return '';
}

export interface RoutingDecision {
  downgrade: boolean;
  reason: string;
}

/** A text block Claude Code injected (`<system-reminder>`, environment snapshots, ...) rather than something the user typed. */
function isInjectedText(block: unknown): boolean {
  const text =
    typeof block === 'string'
      ? block
      : block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'text'
        ? (block as Record<string, unknown>)['text']
        : undefined;
  return typeof text === 'string' && text.trimStart().startsWith('<');
}

/** `user[text"<system-re"] > assistant[tool_use] > user[tool_result,text"<envir"]`: the last three messages, for the ledger. */
export function describeTail(payload: MessagesPayload): string {
  const messages = (payload.messages ?? []) as Record<string, unknown>[];
  return messages
    .slice(-3)
    .map((message) => {
      const content = message?.['content'];
      const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      const kinds = blocks.map((block) => {
        const b = (block ?? {}) as Record<string, unknown>;
        return b['type'] === 'text' ? `text"${String(b['text'] ?? '').slice(0, 16).replace(/\s+/g, ' ')}"` : String(b['type']);
      });
      return `${String(message?.['role'])}[${kinds.join(',')}]`;
    })
    .join(' > ')
    .slice(0, 400);
}

/**
 * True when the request continues an agentic loop. Walking back from the end of the history, the
 * first message that matters decides: one with a tool result means the loop goes on; one with text
 * the user typed means a new prompt. Messages made only of tagged, injected text (reminders, the
 * environment snapshot, file-changed nudges) are skipped whatever their tag, because Claude Code
 * appends them after a tool result and, without skipping them, one Enter split into several turns.
 */
export function hasToolResults(payload: MessagesPayload): boolean {
  const messages = (payload.messages ?? []) as Record<string, unknown>[];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.['role'] !== 'user') {
      return false;
    }
    const content = message['content'];
    const blocks: unknown[] = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [];
    if (
      blocks.some((block) => !!block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result')
    ) {
      return true;
    }
    if (blocks.some((block) => !isInjectedText(block))) {
      return false;
    }
  }
  return false;
}

/**
 * Decide whether the latest turn is mechanical enough for Haiku.
 *
 * The classifier is deliberately conservative: it downgrades only when the turn is
 * short, matches a simple-task signal, and shows no complexity signal. A wrong
 * downgrade costs a bad answer and a retry, which is more expensive than the tokens
 * it would have saved.
 */
export function classifyRouting(payload: MessagesPayload, estimatedInputTokens: number): RoutingDecision {
  const model = String(payload.model ?? '');

  if (model.includes('haiku')) {
    return { downgrade: false, reason: 'already on Haiku' };
  }
  if (estimatedInputTokens > HAIKU_SAFE_INPUT_TOKENS) {
    return { downgrade: false, reason: 'input exceeds the Haiku context window' };
  }
  // A turn that hands back tool results is mid-agentic-loop; swapping models there
  // breaks caching and often the loop's own expectations.
  if (hasToolResults(payload)) {
    return { downgrade: false, reason: 'turn carries tool results' };
  }

  const text = latestUserText(payload);
  if (!text.trim()) {
    return { downgrade: false, reason: 'no user text to classify' };
  }
  if (text.length > SIMPLE_TASK_MAX_CHARS) {
    return { downgrade: false, reason: 'latest turn is too long to be trivial' };
  }
  if (COMPLEX_TASK_PATTERNS.some((pattern) => pattern.test(text))) {
    return { downgrade: false, reason: 'latest turn matches a complexity signal' };
  }
  if (CODE_FENCE_PATTERN.test(text)) {
    return { downgrade: false, reason: 'latest turn contains code' };
  }
  const trimmed = text.trim();
  const isSimple =
    GREETING_PATTERN.test(trimmed) ||
    SIMPLE_TASK_PATTERNS.some((pattern) => pattern.test(text)) ||
    (trimmed.length <= SHORT_QUESTION_MAX_CHARS && /[?¿]/.test(trimmed));
  if (!isSimple) {
    return { downgrade: false, reason: 'no simple-task signal matched' };
  }

  return { downgrade: true, reason: 'short mechanical turn routed to Haiku' };
}

/**
 * Rewrite the payload for Haiku 4.5.
 *
 * Haiku does not accept `output_config.effort` and does not support adaptive
 * thinking, so those have to be translated rather than carried over — otherwise the
 * downgrade turns a working request into a 400.
 */
function applyModelDowngrade(payload: MessagesPayload): MessagesPayload {
  const next: MessagesPayload = { ...payload, model: HAIKU_MODEL_ID };

  if (next['output_config'] && typeof next['output_config'] === 'object') {
    const outputConfig = { ...(next['output_config'] as Record<string, unknown>) };
    delete outputConfig['effort'];
    if (Object.keys(outputConfig).length) {
      next['output_config'] = outputConfig;
    } else {
      delete next['output_config'];
    }
  }

  const thinking = next['thinking'];
  if (thinking && typeof thinking === 'object') {
    const typed = thinking as Record<string, unknown>;
    if (typed['type'] === 'adaptive') {
      // Haiku 4.5 predates adaptive thinking; it takes an explicit budget instead,
      // and the budget must stay below max_tokens.
      const maxTokens = Number(next['max_tokens'] ?? 0);
      const budget = Math.max(1024, Math.min(8192, Math.floor(maxTokens / 2) || 1024));
      if (maxTokens > budget) {
        next['thinking'] = { type: 'enabled', budget_tokens: budget };
      } else {
        delete next['thinking'];
      }
    }
  }

  const maxTokens = Number(next['max_tokens'] ?? 0);
  if (maxTokens > HAIKU_MAX_OUTPUT_TOKENS) {
    next['max_tokens'] = HAIKU_MAX_OUTPUT_TOKENS;
  }

  return next;
}

// ---------------------------------------------------------------------------
// Stage 4: the single sliding cache anchor
// ---------------------------------------------------------------------------

/**
 * Minimum cacheable prefix, in tokens. Below this the server silently ignores the
 * breakpoint, so an anchor placed there is a no-op rather than an error.
 */
function minimumCacheablePrefix(model: string): number {
  return model.includes('haiku') ? 2048 : 1024;
}

/** Remove every `cache_control` inside `messages`, counting what was dropped. */
function stripMessageCacheControl(messages: Array<Record<string, unknown>>): {
  messages: Array<Record<string, unknown>>;
  stripped: number;
} {
  let stripped = 0;

  const cleaned = messages.map((message) => {
    const content = message['content'];
    if (!Array.isArray(content)) {
      return message;
    }

    const blocks = content.map((block) => {
      if (!block || typeof block !== 'object' || !('cache_control' in (block as object))) {
        return block;
      }
      stripped += 1;
      const rest = { ...(block as Record<string, unknown>) };
      delete rest['cache_control'];
      return rest;
    });

    return { ...message, content: blocks };
  });

  return { messages: cleaned, stripped };
}

/** Anthropic accepts at most this many `cache_control` breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

function countCacheControl(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countCacheControl(item), 0);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return ('cache_control' in record ? 1 : 0) + Object.values(record).reduce<number>((sum, item) => sum + countCacheControl(item), 0);
  }
  return 0;
}

/**
 * Second breakpoint, on the last block of the compaction manifest (`messages[0]`).
 *
 * The manifest is append-only and byte-stable between compactions, so marking its
 * end lets the next request read it from the cache even though everything after it
 * changes when a new summary is appended (the sliding anchor alone only matches
 * prefixes that end at the previous assistant turn). Skipped when there is no
 * manifest, when it is smaller than the minimum cacheable prefix (the breakpoint
 * would buy nothing), or when `system`/`tools` already use up the breakpoint
 * budget left by the sliding anchor.
 */
function applyManifestAnchor(
  payload: MessagesPayload,
  cleaned: Array<Record<string, unknown>>,
  telemetry: OptimizationTelemetry
): boolean {
  if (!telemetry.compactionTriggered && !telemetry.summaryReused) {
    return false;
  }
  const manifest = cleaned[0];
  const content = manifest?.['content'];
  if (!manifest || manifest['role'] !== 'user' || !Array.isArray(content) || !content.length) {
    return false;
  }
  const lastBlock = content[content.length - 1];
  if (!lastBlock || typeof lastBlock !== 'object') {
    return false;
  }

  const used = countCacheControl(payload.system) + countCacheControl(payload.tools);
  if (used + 2 > MAX_CACHE_BREAKPOINTS) {
    return false;
  }

  const prefixTokens = estimatePayloadTokens({ system: payload.system, tools: payload.tools, messages: [manifest] });
  if (prefixTokens < minimumCacheablePrefix(String(payload.model ?? ''))) {
    return false;
  }

  const blocks = content.slice();
  blocks[blocks.length - 1] = { ...(lastBlock as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
  cleaned[0] = { ...manifest, content: blocks };
  return true;
}

/**
 * Place exactly one ephemeral breakpoint on the last content block of the final
 * message — the same spot Claude Code marks.
 *
 * The anchor must sit at the very end: whatever follows it is billed at the plain
 * input rate this turn, and only reaches the cache (at 1.25x) on the next turn, so
 * an anchor one turn behind pays for every tool result twice. With the anchor on the
 * tail, this turn writes the tail once and the next turn reads it back at 0.10x.
 *
 * `system` and `tools` breakpoints are left alone on purpose. They sit earlier in
 * the render order (`tools` -> `system` -> `messages`) and are usually the largest
 * stable prefix a client caches; stripping them to satisfy "exactly one anchor"
 * would cost far more than it saves.
 */
function applyCacheAnchor(payload: MessagesPayload, telemetry: OptimizationTelemetry): MessagesPayload {
  const messages = payload.messages ?? [];
  const { messages: cleaned, stripped } = stripMessageCacheControl(messages);
  telemetry.strippedCacheControlBlocks = stripped;

  applyManifestAnchor(payload, cleaned, telemetry);

  const anchorIndex = cleaned.length - 1;

  if (anchorIndex < 0) {
    return { ...payload, messages: cleaned };
  }

  const target = cleaned[anchorIndex];
  let content = target['content'];

  // A string body has no block to annotate; promote it to a single text block.
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content) || !content.length) {
    return { ...payload, messages: cleaned };
  }

  const blocks = content.slice();
  const lastIndex = blocks.length - 1;
  const lastBlock = blocks[lastIndex];
  if (!lastBlock || typeof lastBlock !== 'object') {
    return { ...payload, messages: cleaned };
  }
  // The API rejects breakpoints on thinking blocks.
  const lastType = (lastBlock as Record<string, unknown>)['type'];
  if (lastType === 'thinking' || lastType === 'redacted_thinking') {
    return { ...payload, messages: cleaned };
  }

  blocks[lastIndex] = { ...(lastBlock as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
  cleaned[anchorIndex] = { ...target, content: blocks };

  // Everything up to and including the anchor is what the server would cache.
  const prefixTokens = estimatePayloadTokens({
    system: payload.system,
    tools: payload.tools,
    messages: cleaned.slice(0, anchorIndex + 1),
  });

  telemetry.cacheAnchorPlaced = true;
  telemetry.cacheAnchorBelowMinimum = prefixTokens < minimumCacheablePrefix(String(payload.model ?? ''));

  return { ...payload, messages: cleaned };
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

export async function optimizePayload(
  original: MessagesPayload,
  config: OptimizerConfig,
  options: {
    summarize?: SummarizeFn;
    summaryStore?: SummaryStore;
    baselineMemory?: BaselineMemory;
    exactRawTokens?: number;
    isStartupRequest?: boolean;
    /** Called as each figure becomes known: raw, then cleanup, then compression, then sent. */
    onStage?: (stage: { rawTokens?: number; prunedByNormalization?: number; prunedByCompaction?: number; summaryCreated?: boolean; optimizedTokens?: number }) => void;
  } = {}
): Promise<OptimizationResult> {
  const originalModel = String(original.model ?? 'unknown');
  // `rawTokens` may be the API's exact count while every later figure comes from the
  // local estimator, which runs ~25% low. Savings are therefore always measured as an
  // estimator-vs-estimator difference and applied to `rawTokens`, never as
  // `rawTokens - estimate` (that would book the estimator's bias as "pruned").
  const estimatedOriginal = estimatePayloadTokens(original);
  const rawTokens = options.exactRawTokens ?? estimatedOriginal;

  const telemetry: OptimizationTelemetry = {
    rawTokens,
    optimizedTokens: rawTokens,
    prunedByNormalization: 0,
    prunedByCompaction: 0,
    compactionTriggered: false,
    rawTokensExact: options.exactRawTokens !== undefined,
    originalModel,
    effectiveModel: originalModel,
    modelDowngraded: false,
    routingReason: 'routing disabled',
    startupModelDefaulted: false,
    cacheAnchorPlaced: false,
    cacheAnchorBelowMinimum: false,
    strippedCacheControlBlocks: 0,
    isNewUserTurn: !hasToolResults(original),
    newTurnShape: hasToolResults(original) ? undefined : describeTail(original),
  };

  if (options.baselineMemory && hasClientCacheControl(original)) {
    const key = hashMessages((original.messages ?? []).slice(0, 1));
    telemetry.clientCacheTtlMs = config.forceFiveMinuteCache ? CACHE_TTL_5M_MS : clientCacheTtlMs(original);
    telemetry.floorCachedTokens = options.baselineMemory.warmCachedTokens(key, rawTokens, Date.now());
    telemetry.baselineCachedTokens = options.baselineMemory.cachedTokens(key, rawTokens, Date.now(), telemetry.clientCacheTtlMs);
  }

  options.onStage?.({ rawTokens });

  let payload = original;

  // Stage 0: one-time Opus -> Sonnet default on the first hit since proxy startup.
  if (config.enableStartupSonnetDefault && options.isStartupRequest) {
    payload = applyStartupModelDefault(payload, telemetry);
  }

  // Stage 1 + the pruning half of Stage 2 both shrink text, so measure them together.
  if (config.enableNormalization) {
    payload = applyNormalization(payload);
  }
  if (config.enableCompaction) {
    payload = applyFluffStripping(payload);
  }
  if (config.enableNormalization || config.enableCompaction) {
    telemetry.prunedByNormalization = Math.max(0, estimatedOriginal - estimatePayloadTokens(payload));
  }
  options.onStage?.({ prunedByNormalization: telemetry.prunedByNormalization });

  // Stage 2: sliding compaction.
  if (config.enableCompaction) {
    payload = await applyCompaction(payload, config, options.summarize, telemetry, options.summaryStore);
  }
  options.onStage?.({ prunedByCompaction: telemetry.prunedByCompaction, summaryCreated: telemetry.compactionTriggered });

  // Stage 3: smart model routing.
  if (config.enableModelRouting) {
    const decision = classifyRouting(payload, estimatePayloadTokens(payload));
    telemetry.routingReason = decision.reason;
    if (decision.downgrade) {
      payload = applyModelDowngrade(payload);
      telemetry.modelDowngraded = true;
      telemetry.effectiveModel = HAIKU_MODEL_ID;
    }
  }

  // Stage 4: the single sliding cache anchor.
  if (config.enableCacheAnchor) {
    payload = applyCacheAnchor(payload, telemetry);
  }

  if (config.forceFiveMinuteCache) {
    payload = forceFiveMinuteCache(payload);
  }

  const conversationKey = hashMessages((original.messages ?? []).slice(0, 1));
  telemetry.clientPrefixChange = trackPrefix(lastClientPrefix, conversationKey, original);
  telemetry.sentPrefixChange = trackPrefix(lastSentPrefix, conversationKey, payload);

  telemetry.optimizedTokens = Math.max(0, rawTokens + estimatePayloadTokens(payload) - estimatedOriginal);
  options.onStage?.({ optimizedTokens: telemetry.optimizedTokens });
  return { payload, telemetry };
}
