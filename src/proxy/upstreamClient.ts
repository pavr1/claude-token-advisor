/**
 * HTTP client for the calls to Anthropic. Node's global `fetch` keeps idle sockets alive for a long
 * time; behind a corporate firewall or VPN those sockets are dropped silently, and the next request
 * sent down one waits for the OS to give up (ETIMEDOUT). This client retires idle sockets quickly and
 * fails a dead connect fast, so the retry in the server goes out on a fresh connection.
 */
import { Agent, fetch as undiciFetch } from 'undici';

const dispatcher = new Agent({
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 10_000,
  connect: { timeout: 6_000 },
});

export function upstreamFetch(url: string, init: RequestInit): Promise<globalThis.Response> {
  return undiciFetch(url, { ...(init as object), dispatcher }) as unknown as Promise<globalThis.Response>;
}

export function closeUpstreamClient(): Promise<void> {
  return dispatcher.close();
}
