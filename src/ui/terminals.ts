import { shellPidOfKey } from '../proxy/clientProcess';

/**
 * Terminals, as the turns table shows them.
 *
 * A ledger row carries `terminalKey` (the terminal's shell pid and start time). The number in "Terminal #N" is not stored:
 * it counts the terminals that are open right now, oldest first, so closing one renumbers the rest and a new one takes the
 * next number. A terminal that is no longer open keeps its rows (still grouped under its key) but has no number.
 */

let livePids: ReadonlySet<number> = new Set();

/** The shell pids of the integrated terminals open in this window; the extension keeps it current. */
export function setLiveTerminalPids(pids: Iterable<number>): void {
  livePids = new Set(pids);
}

export function liveTerminalPids(): ReadonlySet<number> {
  return livePids;
}

export interface TerminalInfo {
  key: string;
  /** Position among the open terminals, from 1; undefined when it is not open (closed, or in another window). */
  number?: number;
  firstAt: number;
  lastAt: number;
}

export function terminalLabel(info: TerminalInfo | undefined): string {
  return info?.number !== undefined ? `Terminal #${info.number}` : 'Terminal (closed)';
}

/** Every terminal in `entries`, with its number among the open ones. */
export function describeTerminals(
  entries: ReadonlyArray<{ terminalKey?: string; timestamp: string }>,
  open: ReadonlySet<number> = livePids,
  /** Whether the shell of a terminal key still runs on the machine: a terminal of another VS Code window is not in `open` but is not closed. */
  running: (key: string) => boolean = () => false
): Map<string, TerminalInfo> {
  const found = new Map<string, TerminalInfo>();
  for (const entry of entries) {
    if (!entry.terminalKey) {
      continue;
    }
    const at = Date.parse(entry.timestamp);
    const known = found.get(entry.terminalKey);
    if (known) {
      known.firstAt = Math.min(known.firstAt, at);
      known.lastAt = Math.max(known.lastAt, at);
    } else {
      found.set(entry.terminalKey, { key: entry.terminalKey, firstAt: at, lastAt: at });
    }
  }
  // Only the newest terminal of a pid can be the open one: an older key with the same pid died before the pid was reused.
  const newestOfPid = new Map<number, TerminalInfo>();
  for (const info of found.values()) {
    const pid = shellPidOfKey(info.key);
    const best = pid === undefined ? undefined : newestOfPid.get(pid);
    if (pid !== undefined && (open.has(pid) || running(info.key)) && (!best || info.lastAt > best.lastAt)) {
      newestOfPid.set(pid, info);
    }
  }
  const alive = [...newestOfPid.values()]
    .sort((x, y) => x.firstAt - y.firstAt || x.key.localeCompare(y.key));
  alive.forEach((info, index) => {
    info.number = index + 1;
  });
  return found;
}
