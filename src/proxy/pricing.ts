/**
 * Normalized Cost Units (NCU) for the Claude Token Improver.
 *
 * A "weight" is a model's input price expressed as a multiple of Claude Sonnet's
 * input price, so Sonnet is 1.0 by definition. Working in NCUs keeps the savings
 * math stable when Anthropic changes absolute prices: only the underlying rates move.
 *
 * One price source (3.4): rates come from the same LiteLLM feed
 * `claude_budget_advisor.py` already reads, cached the same way (7 days), falling
 * back to the same published tier rates Python hardcodes for the worst case — so
 * the two languages agree even when neither can reach the network, not just on
 * the happy path. No second hand-guessed `$/MTok` table lives here anymore.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Identical to PRICING_URL in claude_budget_advisor.py — the same feed, not a mirror. */
export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const PRICING_CACHE_FILENAME = 'model_pricing_cache.json';
/** Same 7 days as PRICING_CACHE_TTL_SECONDS in claude_budget_advisor.py. */
const PRICING_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface ModelRates {
  input: number;
  output: number;
  /** Per-token cache rates; `cacheMultipliers` turns them into multiples of `input`. */
  cacheRead: number;
  cacheWrite: number;
  /** 1 hour cache write rate; absent when the feed does not publish one (and in caches saved before it was read). */
  cacheWrite1h?: number;
}

/**
 * Last-resort rates, used only when neither a fresh fetch nor a cached copy is
 * available. Mirrors FALLBACK_TIER_PRICING in claude_budget_advisor.py exactly —
 * same $/token values — so the two languages' worst case agrees too.
 */
const FALLBACK_TIER_RATES: Record<'premium' | 'balanced' | 'economy' | 'unknown', ModelRates> = {
  premium: { input: 15e-6, output: 75e-6, cacheWrite: 18.75e-6, cacheRead: 1.5e-6, cacheWrite1h: 30e-6 },
  balanced: { input: 3e-6, output: 15e-6, cacheWrite: 3.75e-6, cacheRead: 0.3e-6, cacheWrite1h: 6e-6 },
  economy: { input: 1e-6, output: 5e-6, cacheWrite: 1.25e-6, cacheRead: 0.1e-6, cacheWrite1h: 2e-6 },
  unknown: { input: 3e-6, output: 15e-6, cacheWrite: 3.75e-6, cacheRead: 0.3e-6, cacheWrite1h: 6e-6 },
};

function classifyModel(modelId: string): keyof typeof FALLBACK_TIER_RATES {
  const lowered = modelId.toLowerCase();
  if (lowered.includes('opus')) {
    return 'premium';
  }
  if (lowered.includes('sonnet')) {
    return 'balanced';
  }
  if (lowered.includes('haiku')) {
    return 'economy';
  }
  return 'unknown';
}

/**
 * Cache multipliers (cache rate over the model's input rate) for the model that served a hit,
 * read from the pricing table, so a repricing or a model with its own cache rates shows up
 * without a code change. Only when the table has no usable rate for a kind (an old cache file, a
 * model the feed omits) does that kind fall back to Anthropic's published rule: 0.10x read,
 * 1.25x 5 minute write, 2x 1 hour write.
 */
/** The kinds of cache token that carry their own price. */
export type CacheKind = 'read' | 'write' | 'write1h';

export interface CacheMultipliers {
  read: number;
  write: number;
  write1h: number;
  /**
   * Kinds the pricing table gave no rate for. Their multiplier is 0, so those tokens add no units;
   * nothing is guessed. Absent on rows recorded before this was tracked.
   */
  unpriced?: CacheKind[];
}

/** A model's cache rates as multiples of its input price, straight from the pricing table. */
export function cacheMultipliers(modelId: string | undefined): CacheMultipliers {
  const rates = resolveRates(modelId);
  const unpriced: CacheKind[] = [];
  const ratio = (kind: CacheKind, rate: number | undefined): number => {
    if (rate && rates.input > 0) {
      return rate / rates.input;
    }
    unpriced.push(kind);
    return 0;
  };
  const multipliers: CacheMultipliers = {
    read: ratio('read', rates.cacheRead),
    write: ratio('write', rates.cacheWrite),
    write1h: ratio('write1h', rates.cacheWrite1h),
  };
  return unpriced.length > 0 ? { ...multipliers, unpriced } : multipliers;
}

export interface PricingTable {
  /** $/token rates, keyed by lowercased LiteLLM model id. */
  rates: Record<string, ModelRates>;
  source: 'fallback' | 'cache' | 'stale_cache' | 'litellm' | 'remote';
  /** Epoch ms the table was loaded. */
  loadedAt: number;
}

let activeTable: PricingTable = { rates: {}, source: 'fallback', loadedAt: Date.now() };

export function getPricingTable(): PricingTable {
  return activeTable;
}

/**
 * Resolve a model id to its rates. Exact match first, then the longest known key
 * that shares a prefix in either direction — mirrors `resolve_model_rates()` in
 * claude_budget_advisor.py exactly, so a fictional/dated id resolves the same way
 * a generic family lookup (e.g. `'claude-sonnet'`) does against real fetched data.
 */
function resolveRates(modelId: string | undefined): ModelRates {
  if (!modelId) {
    return FALLBACK_TIER_RATES.unknown;
  }
  const lowered = modelId.toLowerCase();
  const exact = activeTable.rates[lowered];
  if (exact) {
    return exact;
  }

  let bestMatch = '';
  for (const key of Object.keys(activeTable.rates)) {
    if ((key.startsWith(lowered) || lowered.startsWith(key)) && key.length > bestMatch.length) {
      bestMatch = key;
    }
  }
  if (bestMatch) {
    return activeTable.rates[bestMatch];
  }

  return FALLBACK_TIER_RATES[classifyModel(modelId)];
}

/**
 * The NCU denominator. Mathematically any positive constant here would produce
 * the same final USD figures (it cancels out in `usdPerNormalizedUnit`), but
 * resolving it live is what keeps "1.0 NCU is one Sonnet input token" literally
 * true instead of merely "the math still works out" — see the plan for the
 * fuller derivation.
 *
 * Deliberately a specific id (`claude-sonnet-5`, this codebase's own current
 * Sonnet everywhere else — defaults, fixtures, tests), not a generic `'claude-sonnet'`
 * prefix: a live feed carries *several* Sonnet-family entries at once (dated
 * snapshots alongside the current alias, each its own real price), and generic
 * prefix-matching's "longest key wins" rule — correct for resolving a specific
 * queried id against generic known keys — picks an arbitrary, often-older
 * snapshot when asked in the opposite direction (a generic query against many
 * specific keys). An exact match on the one id this codebase actually calls
 * Sonnet has no such ambiguity, and still degrades to the same prefix match
 * (with the same caveat) if that exact id ever disappears from the feed.
 */
function sonnetInputUsdPerToken(): number {
  return resolveRates('claude-sonnet-5').input;
}

export function modelWeight(modelId: string | undefined): number {
  return resolveRates(modelId).input / sonnetInputUsdPerToken();
}

/** A model's output-token weight, in the same NCU scale as `modelWeight` (input). */
export function modelOutputWeight(modelId: string | undefined): number {
  return resolveRates(modelId).output / sonnetInputUsdPerToken();
}

/** One Normalized Cost Unit, in dollars. Dynamic: reflects whatever Sonnet's real, currently-resolved rate is. */
export function usdPerNormalizedUnit(): number {
  return sonnetInputUsdPerToken();
}

/** Back to the network-free fallback state. Every lookup still degrades gracefully via `resolveRates`. */
export function resetPricing(): void {
  activeTable = { rates: {}, source: 'fallback', loadedAt: Date.now() };
}

interface CacheFile {
  savedAt: number;
  rates: Record<string, ModelRates>;
}

function cachePath(storageDir: string): string {
  return path.join(storageDir, PRICING_CACHE_FILENAME);
}

function readCache(storageDir: string): CacheFile | undefined {
  try {
    const raw = fs.readFileSync(cachePath(storageDir), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed && typeof parsed.savedAt === 'number' && parsed.rates && typeof parsed.rates === 'object') {
      return parsed;
    }
  } catch {
    // No cache yet, or an unreadable one. Either is "no cache" to the caller.
  }
  return undefined;
}

async function writeCache(storageDir: string, rates: Record<string, ModelRates>): Promise<void> {
  const file: CacheFile = { savedAt: Date.now(), rates };
  try {
    await fs.promises.mkdir(storageDir, { recursive: true });
    const target = cachePath(storageDir);
    const tempPath = `${target}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(file), 'utf8');
    await fs.promises.rename(tempPath, target);
  } catch {
    // A failed cache write must not fail pricing itself — the fetched table is
    // already active in memory regardless.
  }
}

/** Same field names LiteLLM publishes — see PRICING_FIELDS in claude_budget_advisor.py. */
const LITELLM_FIELDS: Record<keyof ModelRates, string> = {
  cacheWrite1h: 'cache_creation_input_token_cost_above_1hr',
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite: 'cache_creation_input_token_cost',
};

/** Same filter as `_extract_anthropic_pricing()` in claude_budget_advisor.py. */
function extractAnthropicRates(payload: unknown): Record<string, ModelRates> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const rates: Record<string, ModelRates> = {};
  for (const [modelId, entry] of Object.entries(payload as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || (entry as Record<string, unknown>)['litellm_provider'] !== 'anthropic') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const input = record[LITELLM_FIELDS.input];
    const output = record[LITELLM_FIELDS.output];
    if (typeof input !== 'number' || typeof output !== 'number' || !input || !output) {
      continue;
    }
    const cacheRead = record[LITELLM_FIELDS.cacheRead];
    const cacheWrite = record[LITELLM_FIELDS.cacheWrite];
    const cacheWrite1h = record[LITELLM_FIELDS.cacheWrite1h];
    rates[modelId.toLowerCase()] = {
      input,
      output,
      cacheRead: typeof cacheRead === 'number' ? cacheRead : 0,
      cacheWrite: typeof cacheWrite === 'number' ? cacheWrite : 0,
      cacheWrite1h: typeof cacheWrite1h === 'number' ? cacheWrite1h : undefined,
    };
  }
  return Object.keys(rates).length ? rates : undefined;
}

async function fetchLiteLLMPricing(url: string, timeoutMs: number): Promise<Record<string, ModelRates> | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    return extractAnthropicRates(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve pricing: a fresh disk cache, then a live fetch (writing a new cache on
 * success), then a stale disk cache, then the built-in fallback tier — the same
 * order `load_pricing()` in claude_budget_advisor.py already uses. Called once at
 * activation and again whenever the `pricingUrl` setting changes; `customUrl`
 * lets it point at a self-hosted mirror of the same LiteLLM JSON shape instead of
 * the public feed.
 */
export async function loadPricing(
  storageDir: string,
  customUrl?: string,
  timeoutMs = 5000
): Promise<{ ok: boolean; detail: string }> {
  const cached = readCache(storageDir);
  if (cached && Date.now() - cached.savedAt < PRICING_CACHE_TTL_MS) {
    activeTable = { rates: cached.rates, source: 'cache', loadedAt: Date.now() };
    return { ok: true, detail: `using cached pricing for ${Object.keys(cached.rates).length} models` };
  }

  const url = customUrl || LITELLM_PRICING_URL;
  const fetched = await fetchLiteLLMPricing(url, timeoutMs);
  if (fetched) {
    activeTable = { rates: fetched, source: customUrl ? 'remote' : 'litellm', loadedAt: Date.now() };
    // Awaited so a caller that immediately calls loadPricing() again (a new
    // window binding right after this one, or a test) sees the cache on disk
    // rather than racing an unwritten file.
    await writeCache(storageDir, fetched);
    return { ok: true, detail: `fetched pricing for ${Object.keys(fetched).length} models from ${url}` };
  }

  if (cached) {
    activeTable = { rates: cached.rates, source: 'stale_cache', loadedAt: Date.now() };
    return { ok: false, detail: `could not reach ${url}; using a stale cached copy` };
  }

  resetPricing();
  return { ok: false, detail: `could not reach ${url} and no cache exists; using published fallback rates` };
}
