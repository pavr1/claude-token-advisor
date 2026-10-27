/**
 * Requests that reached the proxy and have not produced a ledger row yet, per project.
 *
 * Fed by the owner's own `start` callback and by joined windows' `start` events, and
 * cleared by the matching turn. The proxy emits no event for a request that fails or
 * is cancelled, so an entry that never completes expires instead of staying
 * highlighted forever.
 */

/** A request with no turn after this long is assumed failed or cancelled. */
export const IN_FLIGHT_EXPIRY_MS = 5 * 60_000;

/** What the pre-flight pipeline measured, known before the upstream answers. */
export interface InFlightPreflight {
  rawTokens: number;
  prunedByNormalization: number;
  prunedByCompaction: number;
  /** True when this hit wrote a new summary (Haiku call); false when it reused one or did not compact. */
  summaryCreated: boolean;
  optimizedTokens: number;
}

/** Pipeline stages report one figure at a time; `optimizedTokens` is the last, so it marks a request complete. */
export type InFlightStage = Partial<InFlightPreflight>;

export interface InFlightProject {
  /** Requests still waiting for their turn to land. */
  count: number;
  /** Pre-flight measurements of the pending requests that already got past optimization. */
  preflight: InFlightStage[];
  /** One of them opened a new user turn (so no ledger row exists for it yet). */
  newTurn: boolean;
  /** When the oldest of the project's pending requests began. */
  since: number;
}

export class InFlightTracker {
  private readonly started: Array<{ project: string; at: number; newTurn: boolean; preflight?: InFlightStage; id?: string }> = [];

  /** `newTurn`: the request opens a new prompt rather than continuing one with a tool result. */
  start(project: string, newTurn: boolean, now = Date.now(), id?: string): void {
    this.started.push({ project, at: now, newTurn, id });
  }

  /** One more pipeline figure for `project`'s oldest request that has not finished optimization. */
  optimized(project: string, stage: InFlightStage, id?: string): void {
    // With an id the figure goes to exactly that request, so overlapping requests of one
    // project can't mix their stages; without one it falls back to the oldest unfinished.
    const request = this.started.find((candidate) =>
      id !== undefined
        ? candidate.id === id
        : candidate.project === project && candidate.preflight?.optimizedTokens === undefined
    );
    if (request) {
      request.preflight = { ...request.preflight, ...stage };
    }
  }

  /** A turn landed for `project`: its oldest pending request is done. */
  finish(project: string): void {
    const index = this.started.findIndex((request) => request.project === project);
    if (index >= 0) {
      this.started.splice(index, 1);
    }
  }

  /** Projects with at least one live request. */
  snapshot(now = Date.now()): Map<string, InFlightProject> {
    for (let index = this.started.length - 1; index >= 0; index -= 1) {
      if (now - this.started[index].at >= IN_FLIGHT_EXPIRY_MS) {
        this.started.splice(index, 1);
      }
    }
    const projects = new Map<string, InFlightProject>();
    for (const request of this.started) {
      const current = projects.get(request.project);
      projects.set(request.project, {
        count: (current?.count ?? 0) + 1,
        preflight: request.preflight ? [...(current?.preflight ?? []), request.preflight] : (current?.preflight ?? []),
        newTurn: (current?.newTurn ?? false) || request.newTurn,
        since: current?.since ?? request.at,
      });
    }
    return projects;
  }
}

/** Shared by the proxy callbacks in `extension.ts` and the Token Improver tab. */
export const inFlightRequests = new InFlightTracker();
