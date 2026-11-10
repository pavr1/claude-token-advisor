import { execFile } from 'child_process';
import { promisify } from 'util';
import { recordError } from '../errorLog';

/**
 * Diagnostic (temporary): which process and which terminal shell sent a request to the proxy.
 *
 * The proxy only sees a loopback TCP connection. The OS says which process owns the client end of it (`netstat -ano`),
 * and the process tree leads from that `claude` process to its parent, the shell of the integrated terminal, whose pid
 * is what `vscode.Terminal.processId` reports. Windows uses netstat and CIM; macOS uses lsof and ps; Linux uses ss (lsof as
 * a fallback) and ps. Other platforms resolve to undefined.
 */

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  name: string;
  parent: number;
  /** When the process started (epoch ms); 0 or undefined when the OS did not say. */
  start?: number;
}

export interface ClientProcess {
  srcPort: number;
  /** The process that owns the client socket (normally `claude`). */
  pid: number;
  /** The `claude` process found on the way up the tree, when there is one. */
  claudePid?: number;
  /** The parent of that `claude` process: the shell of the terminal it runs in. */
  shellPid?: number;
  /**
   * Identity of that terminal: the shell's pid and start time. A pid alone is reused once the process dies, so the start
   * time keeps a later terminal from being taken for an earlier one.
   */
  terminalKey?: string;
  chain: string[];
}

/** `<pid>@<startMs>` (`<pid>@0` when the start time is unknown). */
export function terminalKeyOf(pid: number, start: number | undefined): string {
  return `${pid}@${start && start > 0 ? Math.round(start) : 0}`;
}

/** The shell pid inside a terminal key, or undefined when it is not one. */
export function shellPidOfKey(key: string | undefined): number | undefined {
  const pid = key === undefined ? NaN : Number(key.split('@')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether the shell behind a terminal key is still a running process (any window's: closing a terminal ends its shell). */
export function isShellRunning(key: string | undefined, kill: (pid: number, signal: 0) => unknown = process.kill): boolean {
  const pid = shellPidOfKey(key);
  if (pid === undefined) {
    return true; // no terminal known for the chat: nothing says it is closed
  }
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, but not ours to signal
  }
}

/** The pid that owns the client end of the connection `srcPort -> proxyPort`, from `netstat -ano -p tcp` output. */
export function parseNetstatOwner(output: string, srcPort: number, proxyPort: number): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') {
      continue;
    }
    const [local, remote, , pid] = [cols[1], cols[2], cols[3], cols[4]];
    if (local.endsWith(`:${srcPort}`) && remote.endsWith(`:${proxyPort}`)) {
      const owner = Number(pid);
      return Number.isInteger(owner) && owner > 0 ? owner : undefined;
    }
  }
  return undefined;
}

/** The pid that owns the client end of `srcPort -> proxyPort`, from `lsof -nP -iTCP:<srcPort> -sTCP:ESTABLISHED -Fpn` output. */
export function parseLsofOwner(output: string, srcPort: number, proxyPort: number): number | undefined {
  let pid: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) && value > 0 ? value : undefined;
    } else if (line.startsWith('n') && pid !== undefined) {
      const match = /^n(.+):(\d+)->(.+):(\d+)(?:\s.*)?$/.exec(line);
      if (match && Number(match[2]) === srcPort && Number(match[4]) === proxyPort) {
        return pid;
      }
    }
  }
  return undefined;
}

/** The pid that owns the client end of `srcPort -> proxyPort`, from `ss -tnp` output. */
export function parseSsOwner(output: string, srcPort: number, proxyPort: number): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^ESTAB/i.test(cols[0])) {
      continue;
    }
    if (cols[3].endsWith(`:${srcPort}`) && cols[4].endsWith(`:${proxyPort}`)) {
      const pid = /pid=(\d+)/.exec(line)?.[1];
      return pid ? Number(pid) : undefined;
    }
  }
  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `Thu Nov  5 10:00:00 2026` (ps `lstart`, C locale, local time) as epoch ms; 0 when it does not parse. */
export function parseLstart(text: string): number {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1;
  if (!match || month < 0) {
    return 0;
  }
  return new Date(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime();
}

/**
 * The name `describeChain` looks for. A native install runs `.../claude/versions/<n>` (the file is not called claude) and an
 * npm install runs `node .../claude-code/cli.js`; both count as `claude`.
 */
export function posixProcessName(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? '';
  if (/^claude$/i.test(base) || /\/claude\/versions\/[^/\s]+/.test(args)) {
    return 'claude';
  }
  if (/^(node|bun)$/i.test(base) && /\/claude(-code)?\/|@anthropic-ai\/claude-code/i.test(args)) {
    return 'claude';
  }
  return base || first;
}

/** The process table from `ps -axo pid=,ppid=,lstart=,args=` (run with LC_ALL=C). */
export function parsePsTable(output: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (match) {
      table.set(Number(match[1]), { name: posixProcessName(match[4]), parent: Number(match[2]), start: parseLstart(match[3]) });
    }
  }
  return table;
}

const POSIX_ENV = { ...process.env, LC_ALL: 'C' };

async function posixOwner(platform: string, srcPort: number, proxyPort: number): Promise<number | undefined> {
  const opts = { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: POSIX_ENV };
  const lsof = async () =>
    parseLsofOwner((await execFileAsync('lsof', ['-nP', `-iTCP:${srcPort}`, '-sTCP:ESTABLISHED', '-Fpn'], opts)).stdout, srcPort, proxyPort);
  if (platform === 'darwin') {
    return lsof();
  }
  try {
    return parseSsOwner((await execFileAsync('ss', ['-tnp', `sport = :${srcPort}`], opts)).stdout, srcPort, proxyPort);
  } catch {
    return lsof(); // no ss on this machine
  }
}

async function readPosixTable(): Promise<Map<number, ProcessInfo>> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,lstart=,args='], {
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
    env: POSIX_ENV,
  });
  return parsePsTable(stdout);
}

/** Walk up from `pid`, naming each ancestor; stops at a missing parent, a loop or `maxDepth`. */
export function describeChain(pid: number, table: Map<number, ProcessInfo>, srcPort: number, maxDepth = 10): ClientProcess {
  const chain: string[] = [];
  const seen = new Set<number>();
  let claudePid: number | undefined;
  let shellPid: number | undefined;
  let terminalKey: string | undefined;
  let current: number | undefined = pid;
  while (current !== undefined && table.has(current) && !seen.has(current) && chain.length < maxDepth) {
    seen.add(current);
    const info: ProcessInfo = table.get(current)!;
    chain.push(`${info.name}(${current})`);
    if (claudePid === undefined && /^claude(\.exe)?$/i.test(info.name)) {
      claudePid = current;
      shellPid = info.parent;
      terminalKey = shellPid > 0 ? terminalKeyOf(shellPid, table.get(shellPid)?.start) : undefined;
    }
    current = info.parent;
  }
  return { srcPort, pid, claudePid, shellPid, terminalKey, chain };
}

// Passed as -EncodedCommand (UTF-16LE base64) so no quoting of the braces and quotes survives to go wrong.
const TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Start';e={if($_.CreationDate){[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}} | ConvertTo-Json -Compress";

/**
 * Ways to run the table script. Some machines refuse to spawn `powershell -EncodedCommand` from the extension host (an
 * `EPERM` on spawn, seen with security software), so the plain `-Command` form and PowerShell 7 are tried too. The one that
 * worked is tried first next time.
 */
const POWERSHELL_VARIANTS: Array<{ label: string; file: string; args: () => string[] }> = [
  {
    label: 'powershell -EncodedCommand',
    file: 'powershell.exe',
    args: () => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(TABLE_SCRIPT, 'utf16le').toString('base64')],
  },
  { label: 'powershell -Command', file: 'powershell.exe', args: () => ['-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT] },
  { label: 'pwsh -Command', file: 'pwsh.exe', args: () => ['-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT] },
];
let preferredVariant = 0;

type Runner = (file: string, args: string[]) => Promise<{ stdout: string }>;

const runPowerShell: Runner = (file, args) => execFileAsync(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

async function readProcessTable(): Promise<Map<number, ProcessInfo>> {
  return process.platform === 'win32' ? readWindowsTable(runPowerShell) : readPosixTable();
}

/** The Windows process table; `run` is replaced in tests. Exported for them. */
export async function readWindowsTable(run: Runner): Promise<Map<number, ProcessInfo>> {
  const failures: string[] = [];
  for (let i = 0; i < POWERSHELL_VARIANTS.length; i++) {
    const index = (preferredVariant + i) % POWERSHELL_VARIANTS.length;
    const variant = POWERSHELL_VARIANTS[index];
    try {
      const { stdout } = await run(variant.file, variant.args());
      const rows = JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number; Name: string; Start?: number }>;
      preferredVariant = index;
      return new Map(rows.map((row) => [row.ProcessId, { name: row.Name, parent: row.ParentProcessId, start: row.Start }]));
    } catch (error) {
      failures.push(`${variant.label}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`process table unavailable (${failures.join('; ')})`);
}

/** The process table is shared by the requests that arrive together, and re-read after a few seconds. */
const TABLE_TTL_MS = 5_000;
let tableCache: { at: number; promise: Promise<Map<number, ProcessInfo>> } | undefined;

function processTable(fresh = false): Promise<Map<number, ProcessInfo>> {
  if (fresh || !tableCache || Date.now() - tableCache.at > TABLE_TTL_MS) {
    const promise = readProcessTable();
    tableCache = { at: Date.now(), promise };
    promise.catch(() => {
      if (tableCache?.promise === promise) {
        tableCache = undefined;
      }
    });
  }
  return tableCache.promise;
}

const CACHE_LIMIT = 200;
/** A source port is reused by the OS sooner or later, by another process: an answer is not trusted for long. */
const CACHE_TTL_MS = 120_000;

/** What the resolver reads from the machine; replaced in tests. */
export interface ResolverDeps {
  platform: string;
  /** The output of `netstat -ano -p tcp` (Windows). */
  netstat: () => Promise<string>;
  /** Replaces the per-platform lookup of the pid that owns the client socket. */
  owner?: (srcPort: number, proxyPort: number) => Promise<number | undefined>;
  /** The process table; `fresh` skips the few seconds it is shared for. */
  table: (fresh?: boolean) => Promise<Map<number, ProcessInfo>>;
  now: () => number;
}

const realDeps: ResolverDeps = {
  platform: process.platform,
  netstat: async () => (await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout,
  table: processTable,
  now: Date.now,
};

/**
 * A resolver of the client behind a connection, from its source port; cached per port for a while (a client reuses its
 * socket). An answer without a terminal is never cached, so the next request looks again.
 */
export function createClientResolver(overrides: Partial<ResolverDeps> = {}): (srcPort: number, proxyPort: number) => Promise<ClientProcess | undefined> {
  const deps = { ...realDeps, ...overrides };
  const cache = new Map<number, { at: number; promise: Promise<ClientProcess | undefined> }>();
  return (srcPort, proxyPort) => {
    if (deps.platform !== 'win32' && deps.platform !== 'darwin' && deps.platform !== 'linux') {
      return Promise.resolve(undefined);
    }
    const cached = cache.get(srcPort);
    if (cached && deps.now() - cached.at <= CACHE_TTL_MS) {
      return cached.promise;
    }
    const pending = (async () => {
      // A failure here never reaches the request: the turn is simply not grouped by terminal. It is written to errors.json
      // (one entry per message, with a count) so a platform where this does not work shows up there.
      const posix = deps.platform !== 'win32';
      let step = 'owner';
      try {
        const pid = deps.owner
          ? await deps.owner(srcPort, proxyPort)
          : deps.platform === 'win32'
            ? parseNetstatOwner(await deps.netstat(), srcPort, proxyPort)
            : await posixOwner(deps.platform, srcPort, proxyPort);
        if (pid === undefined) {
          cache.delete(srcPort); // the socket may not be listed yet: try again on the next request
          if (posix) {
            recordError('proxy.client_process', 'no process found for the client socket', { platform: deps.platform, step });
          }
          return undefined;
        }
        step = 'table';
        let client = describeChain(pid, await deps.table(), srcPort);
        if (client.shellPid && client.terminalKey?.endsWith('@0')) {
          // The shell is not in the table read a moment ago (it is younger): without its start time the key could not tell
          // this terminal from a later one that reuses the pid, nor match the same terminal's other turns. Look again.
          client = describeChain(pid, await deps.table(true), srcPort);
          if (client.terminalKey?.endsWith('@0')) {
            client = { ...client, terminalKey: undefined };
          }
        }
        if (!client.terminalKey) {
          cache.delete(srcPort); // a process younger than the cached table is not in it yet: look again next time
          if (posix) {
            recordError('proxy.client_process', 'no claude process in the client process chain', {
              platform: deps.platform,
              step,
              chain: client.chain.join(' <- ').slice(0, 300),
            });
          }
        }
        return client;
      } catch (error) {
        cache.delete(srcPort);
        recordError('proxy.client_process', error, { platform: deps.platform, step });
        return undefined;
      }
    })();
    if (cache.size >= CACHE_LIMIT) {
      cache.delete(cache.keys().next().value as number);
    }
    cache.set(srcPort, { at: deps.now(), promise: pending });
    return pending;
  };
}

/** The resolver the extension uses. */
export const resolveClientProcess = createClientResolver();
