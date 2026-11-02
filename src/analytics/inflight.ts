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
  /** Chat of the newest pending request that opened a turn, when the client sent one. */
  sessionId?: string;
}

/** Local tools can run for a while with nothing in flight; past this the turn is assumed interrupted. */
export const TOOL_WAIT_EXPIRY_MS = 10 * 60_000;

export class InFlightTracker {
  /** Projects whose last hit ended in `tool_use`: the client is running local tools, still part of the turn. */
  private readonly runningTools = new Map<string, { at: number; sessionId?: string }>();
  private readonly started: Array<{ project: string; at: number; newTurn: boolean; preflight?: InFlightStage; id?: string; sessionId?: string }> = [];

  /** `newTurn`: the request opens a new prompt rather than continuing one with a tool result. */
  start(project: string, newTurn: boolean, now = Date.now(), id?: string, sessionId?: string): void {
    this.runningTools.delete(project);
    this.started.push({ project, at: now, newTurn, id, sessionId });
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
  finish(project: string, stopReason?: string, sessionId?: string, now = Date.now()): void {
    const index = this.started.findIndex((request) => request.project === project);
    if (index >= 0) {
      this.started.splice(index, 1);
    }
    // `tool_use`: the answer asks for local tools, so the turn is not over until the next hit lands.
    if (stopReason === 'tool_use') {
      this.runningTools.set(project, { at: now, sessionId });
    } else {
      // A side request (title, classifier) of another chat ending in plain text must not end this chat's turn.
      const wait = this.runningTools.get(project);
      if (wait && (wait.sessionId === undefined || sessionId === undefined || wait.sessionId === sessionId)) {
        this.runningTools.delete(project);
      }
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
        sessionId: request.newTurn ? request.sessionId : current?.sessionId ?? request.sessionId,
      });
    }
    for (const [project, wait] of this.runningTools) {
      if (now - wait.at >= TOOL_WAIT_EXPIRY_MS) {
        this.runningTools.delete(project);
      } else if (!projects.has(project)) {
        projects.set(project, { count: 0, preflight: [], newTurn: false, since: wait.at, sessionId: wait.sessionId });
      }
    }
    return projects;
  }
}

/** Shared by the proxy callbacks in `extension.ts` and the Token Improver tab. */
export const inFlightRequests = new InFlightTracker();
