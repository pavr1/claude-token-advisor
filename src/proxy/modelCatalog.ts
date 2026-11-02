/**
 * The newest Sonnet and Haiku, asked of Anthropic instead of written in the code, so the proxy never
 * keeps sending its users to a model that has been superseded.
 *
 * The proxy needs two models of its own choosing: Sonnet (the default that replaces Opus on the first
 * request, stage 0) and Haiku (the routing of simple turns, stage 3, and the summaries, stage 2). It
 * asks `GET /v1/models` with the credentials of the request it is already serving, picks the newest of
 * each family by creation date, and remembers the answer on disk so the next start does not wait.
 * When it cannot ask (no credentials yet, no network, an answer it does not understand) it keeps what
 * it had: the last answer, or the models below.
 */
import * as fs from 'fs';

export interface LatestModels {
  sonnet: string;
  haiku: string;
}

/** What is used until the first answer arrives, and whenever the lookup fails. Update when new ones appear. */
export const FALLBACK_MODELS: LatestModels = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

export type ModelFamily = keyof LatestModels;

/** How long an answer is trusted, and how long to wait before asking again after a failure. */
const FRESH_MS = 12 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
/** The first request of a run waits this long for the answer, so it already uses the newest model. */
const FIRST_ANSWER_WAIT_MS = 2_000;

interface ModelEntry {
  id?: unknown;
  created_at?: unknown;
}

/** The newest model of `family` in an answer of `GET /v1/models`, by creation date; undefined when there is none. */
export function pickLatest(list: readonly ModelEntry[], family: ModelFamily): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id.startsWith('claude-') || !id.includes(family)) {
      continue;
    }
    const at = Date.parse(String(entry.created_at ?? ''));
    const when = Number.isFinite(at) ? at : 0;
    // Ties (or no dates at all) go to the larger id, which is the newer version in Anthropic's naming.
    if (!best || when > best.at || (when === best.at && id > best.id)) {
      best = { id, at: when };
    }
  }
  return best?.id;
}

export interface ModelCatalogOptions {
  /** Where the proxy talks to, without the trailing slash. Read at every lookup. */
  baseUrl: () => string;
  /** Network call; the proxy passes its own so proxies and certificates behave the same. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Where the last answer is kept between runs; in memory only when unset. */
  storagePath?: string;
  log?: (message: string) => void;
  now?: () => number;
}

export class ModelCatalog {
  private models: LatestModels = { ...FALLBACK_MODELS };
  private askedAt = 0;
  private failedAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: ModelCatalogOptions) {
    this.now = options.now ?? Date.now;
    this.load();
  }

  /** The models to use right now. */
  get current(): LatestModels {
    return this.models;
  }

  /**
   * Ask for the newest models when the last answer is old. Never throws and never blocks a request for
   * long: the very first lookup of a run (nothing remembered yet) is awaited for a couple of seconds so
   * the first request already uses the newest model; later ones run in the background.
   */
  async refreshIfStale(headers: Record<string, string>): Promise<void> {
    const now = this.now();
    if (this.inFlight) {
      return this.askedAt === 0 ? this.waitFor(this.inFlight) : undefined;
    }
    // 0 means never: it must not be read as a moment in time.
    const fresh = this.askedAt !== 0 && now - this.askedAt < FRESH_MS;
    const coolingDown = this.failedAt !== 0 && now - this.failedAt < RETRY_AFTER_FAILURE_MS;
    if (fresh || coolingDown) {
      return;
    }
    if (!headers['x-api-key'] && !headers['authorization']) {
      return; // nothing to ask with yet
    }
    const lookup = this.ask(headers).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = lookup;
    if (this.askedAt === 0) {
      await this.waitFor(lookup);
    }
  }

  private async waitFor(lookup: Promise<void>): Promise<void> {
    await Promise.race([lookup, new Promise<void>((resolve) => setTimeout(resolve, FIRST_ANSWER_WAIT_MS).unref?.())]);
  }

  private async ask(headers: Record<string, string>): Promise<void> {
    try {
      const response = await this.options.fetch(`${this.options.baseUrl()}/v1/models?limit=1000`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as { data?: ModelEntry[] };
      const list = Array.isArray(body?.data) ? body.data : [];
      const sonnet = pickLatest(list, 'sonnet');
      const haiku = pickLatest(list, 'haiku');
      if (!sonnet || !haiku) {
        throw new Error(`no ${!sonnet ? 'Sonnet' : 'Haiku'} in the list of ${list.length} models`);
      }
      this.askedAt = this.now();
      if (sonnet !== this.models.sonnet || haiku !== this.models.haiku) {
        this.options.log?.(`models: newest are Sonnet ${sonnet} and Haiku ${haiku} (were ${this.models.sonnet} and ${this.models.haiku})`);
      }
      this.models = { sonnet, haiku };
      this.save();
    } catch (error) {
      this.failedAt = this.now();
      this.options.log?.(`models: could not ask for the newest (${error instanceof Error ? error.message : String(error)}); keeping ${this.models.sonnet} and ${this.models.haiku}`);
    }
  }

  private load(): void {
    const file = this.options.storagePath;
    if (!file) {
      return;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { sonnet?: unknown; haiku?: unknown; askedAt?: unknown };
      if (typeof saved.sonnet === 'string' && typeof saved.haiku === 'string') {
        this.models = { sonnet: saved.sonnet, haiku: saved.haiku };
        // Remembered answers are used at once but re-checked after the usual time.
        this.askedAt = typeof saved.askedAt === 'number' ? saved.askedAt : 0;
      }
    } catch {
      // no file yet, or one that is not ours: start from the fallback
    }
  }

  private save(): void {
    const file = this.options.storagePath;
    if (!file) {
      return;
    }
    try {
      fs.writeFileSync(file, JSON.stringify({ ...this.models, askedAt: this.askedAt }), 'utf8');
    } catch {
      // the answer is still in memory; a missing file only costs one more lookup next time
    }
  }
}
