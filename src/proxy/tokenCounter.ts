/**
 * Local token estimation for the pre-flight baseline.
 *
 * The proxy has to know how big a payload was *before* it optimized it, and it
 * has to know that without paying for a round trip. Anthropic's tokenizer is not
 * published, so this is a deliberate approximation, not a measurement:
 *
 *   - Latin text averages ~3.8 characters per token.
 *   - Code and JSON are punctuation-dense and average closer to ~3.1.
 *   - Non-ASCII text (CJK, emoji) is far denser, ~1.6.
 *
 * Accuracy is typically within ~10% on mixed prompts, which is enough for a
 * savings percentage. For an exact figure the Messages API exposes
 * `POST /v1/messages/count_tokens`; `countTokensRemote` below uses it when the
 * user opts into exact accounting and accepts the extra round trip.
 */

import { upstreamFetch } from './upstreamClient';

const CHARS_PER_TOKEN_PROSE = 3.8;
const CHARS_PER_TOKEN_CODE = 3.1;
const CHARS_PER_TOKEN_WIDE = 1.6;

/** Per-message framing overhead the API adds for role markers and block delimiters. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Rough cost of an image block when we cannot measure the decoded image. */
const IMAGE_BLOCK_FALLBACK_TOKENS = 1600;

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  let ascii = 0;
  let wide = 0;
  let punctuation = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      wide += 1;
    } else {
      ascii += 1;
      // Braces, brackets, operators and quotes are what make code tokenize densely.
      if (/[{}()[\]<>/\|=+*&^%$#@~`"';:,.!?-]/.test(char)) {
        punctuation += 1;
      }
    }
  }

  const punctuationRatio = ascii ? punctuation / ascii : 0;
  // Blend prose and code densities by how punctuation-heavy the text actually is.
  const codeWeight = Math.min(1, punctuationRatio / 0.2);
  const asciiCharsPerToken = CHARS_PER_TOKEN_PROSE + (CHARS_PER_TOKEN_CODE - CHARS_PER_TOKEN_PROSE) * codeWeight;

  return Math.ceil(ascii / asciiCharsPerToken + wide / CHARS_PER_TOKEN_WIDE);
}

/** Estimate a single content block, which may be a string or a typed object. */
function estimateBlockTokens(block: unknown): number {
  if (typeof block === 'string') {
    return estimateTextTokens(block);
  }
  if (!block || typeof block !== 'object') {
    return 0;
  }

  const typed = block as Record<string, unknown>;
  switch (typed['type']) {
    case 'text':
      return estimateTextTokens(String(typed['text'] ?? ''));
    case 'thinking':
      return estimateTextTokens(String(typed['thinking'] ?? ''));
    case 'image':
    case 'document':
      return IMAGE_BLOCK_FALLBACK_TOKENS;
    case 'tool_use':
      return estimateTextTokens(JSON.stringify(typed['input'] ?? {})) + estimateTextTokens(String(typed['name'] ?? ''));
    case 'tool_result':
      return estimateBlockList(typed['content']);
    default:
      // Unknown block shape: price it as its serialized JSON rather than ignoring it.
      return estimateTextTokens(JSON.stringify(typed));
  }
}

function estimateBlockList(content: unknown): number {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }
  if (Array.isArray(content)) {
    return content.reduce<number>((sum, block) => sum + estimateBlockTokens(block), 0);
  }
  return estimateBlockTokens(content);
}

export interface MessagesPayload {
  model?: string;
  system?: unknown;
  messages?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Estimate the full billable input of a Messages API payload:
 * tools + system + every message, in the order the API renders them.
 */
export function estimatePayloadTokens(payload: MessagesPayload): number {
  let total = 0;

  for (const tool of payload.tools ?? []) {
    total += estimateTextTokens(String(tool['name'] ?? ''));
    total += estimateTextTokens(String(tool['description'] ?? ''));
    total += estimateTextTokens(JSON.stringify(tool['input_schema'] ?? {}));
  }

  total += estimateBlockList(payload.system);

  for (const message of payload.messages ?? []) {
    total += MESSAGE_OVERHEAD_TOKENS;
    total += estimateBlockList(message['content']);
  }

  return total;
}

/**
 * Exact token count via `POST /v1/messages/count_tokens`.
 *
 * Costs a round trip and requires the caller's credentials, so the proxy only
 * calls this when `exactTokenCounting` is enabled. Returns null on any failure so
 * the caller can fall back to the local estimate rather than dropping the request.
 */
export async function countTokensRemote(
  payload: MessagesPayload,
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs = 10_000,
  onFailure?: (reason: string) => void
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // count_tokens rejects generation-only parameters; send just what shapes the input.
    const body: Record<string, unknown> = { model: payload.model, messages: payload.messages ?? [] };
    if (payload.system !== undefined) {
      body['system'] = payload.system;
    }
    if (payload.tools !== undefined) {
      body['tools'] = payload.tools;
    }

    const response = await upstreamFetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      onFailure?.(`HTTP ${response.status}`);
      return null;
    }

    const parsed = (await response.json()) as { input_tokens?: number };
    if (typeof parsed.input_tokens !== 'number') {
      onFailure?.('response had no input_tokens');
      return null;
    }
    return parsed.input_tokens;
  } catch (error) {
    onFailure?.(controller.signal.aborted ? `timeout after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
