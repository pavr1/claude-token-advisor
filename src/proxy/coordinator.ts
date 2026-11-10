/**
 * Window-to-window coordination for the shared proxy.
 *
 * Every VS Code window runs its own extension host, but only one process can
 * listen on the proxy port. The first window to bind it becomes the owner; any
 * later window finds the port taken, confirms through `/health` that the holder
 * is our proxy, and joins it instead of starting a second one. Joined windows
 * follow the owner's `/events` stream for their status bar, and when that stream
 * ends (the owner's window closed) they race to bind the port and one of them
 * becomes the new owner.
 *
 * Nothing here depends on `vscode`, so it is covered by the node:test suites.
 */

import * as http from 'http';
import { PROXY_PROTOCOL, PROXY_SERVICE_ID, ProxyEvent } from './server';

/** How long a `/health` probe may take before the holder is treated as unresponsive. */
const PROBE_TIMEOUT_MS = 1500;

export type ProbeResult =
  /** Our proxy, new enough to share: join it. */
  | { kind: 'ours'; pid: number }
  /** Our proxy from before the singleton: it can't tag projects or stream events. */
  | { kind: 'outdated'; pid: number | undefined }
  /** Something else answered on the port. Never kill it; report it. */
  | { kind: 'foreign' }
  /** Nothing answered in time: the port is free, or its holder is hung. */
  | { kind: 'none' };

/** Ask whoever holds `port` on loopback what it is. */
export async function probeProxy(port: number): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return { kind: 'none' };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { kind: 'foreign' };
  }

  if (body['service'] === PROXY_SERVICE_ID) {
    const pid = typeof body['pid'] === 'number' ? body['pid'] : undefined;
    const protocol = typeof body['protocol'] === 'number' ? body['protocol'] : 0;
    return protocol >= PROXY_PROTOCOL && pid !== undefined ? { kind: 'ours', pid } : { kind: 'outdated', pid };
  }
  // A pre-singleton build of this proxy has the same /health shape minus `service`.
  if (body['status'] === 'ok' && 'upstream' in body && 'optimizer' in body) {
    return { kind: 'outdated', pid: undefined };
  }
  return { kind: 'foreign' };
}

/**
 * Tell the proxy on `port` which extension version this window runs, so windows on an
 * older one can ask to reload. Best effort: a proxy from before this endpoint answers
 * 404 and a dead one errors, and neither is worth surfacing.
 */
export function announceVersion(port: number, version: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ version });
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/announce',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: PROBE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.on('end', resolve);
        response.on('error', () => resolve());
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve());
    request.end(body);
  });
}

export interface EventSubscription {
  close(): void;
}

/**
 * Follow the owner's `/events` stream.
 *
 * `onEnd` fires exactly once, when the stream ends for any reason (the owner
 * stopped, its window closed, or the connection could not be opened), and never
 * after `close()`. That single signal is what drives the takeover.
 */
export function subscribeToEvents(
  port: number,
  onEvent: (event: ProxyEvent) => void,
  onEnd: () => void
): EventSubscription {
  let closed = false;
  let ended = false;
  const end = (): void => {
    if (!ended && !closed) {
      ended = true;
      onEnd();
    }
  };

  const request = http.get({ host: '127.0.0.1', port, path: '/events' }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      end();
      return;
    }

    response.setEncoding('utf8');
    let carry = '';
    response.on('data', (chunk: string) => {
      carry += chunk;
      // SSE frames are separated by a blank line; keep a partial frame for the next chunk.
      const frames = carry.split('\n\n');
      carry = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }
          try {
            onEvent(JSON.parse(line.slice(5).trim()) as ProxyEvent);
          } catch {
            // A malformed frame is dropped; the stream itself is still healthy.
          }
        }
      }
    });
    response.on('end', end);
    response.on('close', end);
    response.on('error', end);
  });
  request.on('error', end);

  return {
    close: () => {
      closed = true;
      request.destroy();
    },
  };
}
