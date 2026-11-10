import { execFile } from 'child_process';

import type { PythonRuntime } from '../budget/pythonRuntime';

/** A running `claude` process of this window and the `ANTHROPIC_BASE_URL` it was started with. */
export interface ClaudeProcess {
  pid: number;
  baseUrl: string | undefined;
  /** Pid of the shell (or extension host) this claude descends from; used to find its terminal. */
  rootPid?: number;
}

const SCAN_TIMEOUT_MS = 15_000;

/**
 * Prints `pid|ANTHROPIC_BASE_URL` for every `claude.exe` descended from the pids given as arguments.
 *
 * VS Code and the OS have no API to ask a running process which variables it was started with,
 * and a `claude` started before the proxy variable was injected never gets it. This reads the
 * environment block out of the process's PEB (x64 Windows, same user) with `ctypes`.
 *
 * It runs in Python rather than PowerShell because managed machines commonly block Node from
 * spawning `powershell.exe` (EPERM), while the extension already depends on Python.
 */
export const PY_SCAN = String.raw`
import ctypes, sys
from ctypes import wintypes

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
nt = ctypes.WinDLL('ntdll')
k32.OpenProcess.restype = ctypes.c_void_p
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [ctypes.c_void_p]
k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
k32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
k32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
nt.NtQueryInformationProcess.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]

class ENTRY(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('pid', wintypes.DWORD),
                ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                ('ppid', wintypes.DWORD), ('pri', ctypes.c_long), ('flags', wintypes.DWORD),
                ('exe', ctypes.c_wchar * 260)]

def processes():
    snap = k32.CreateToolhelp32Snapshot(2, 0)
    entry = ENTRY()
    entry.dwSize = ctypes.sizeof(ENTRY)
    found = {}
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        found[entry.pid] = (entry.ppid, entry.exe)
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return found

def read(handle, address, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, address, buf, size, ctypes.byref(got)):
        raise OSError('read')
    return buf.raw[:got.value]

def pointer(handle, address):
    return int.from_bytes(read(handle, address, 8), 'little')

def env_value(pid, name):
    handle = k32.OpenProcess(0x0410, False, pid)
    if not handle:
        return None
    try:
        info = (ctypes.c_void_p * 6)()
        if nt.NtQueryInformationProcess(handle, 0, info, ctypes.sizeof(info), ctypes.byref(ctypes.c_ulong())) != 0:
            return None
        params = pointer(handle, info[1] + 0x20)
        env = pointer(handle, params + 0x80)
        size = pointer(handle, params + 0x3F0)
        if size <= 0 or size > 4 * 1024 * 1024:
            return None
        block = read(handle, env, size).decode('utf-16-le', 'ignore')
        for item in block.split(chr(0)):
            if item.upper().startswith(name.upper() + '='):
                return item[len(name) + 1:]
        return ''
    except Exception:
        return None
    finally:
        k32.CloseHandle(handle)

roots = set(int(arg) for arg in sys.argv[1:])
table = processes()
for pid, (ppid, exe) in table.items():
    if exe.lower() != 'claude.exe':
        continue
    current, hops, mine, root = ppid, 0, False, 0
    while current in table and hops < 25:
        if current in roots:
            mine, root = True, current
            break
        current, hops = table[current][0], hops + 1
    if not mine:
        continue
    value = env_value(pid, 'ANTHROPIC_BASE_URL')
    if value is not None:
        print(str(pid) + '|' + value + '|' + str(root))
`;

/** Parse the script's output. A process whose environment could not be read is not listed, so it is never accused. */
export function parseScanOutput(stdout: string): ClaudeProcess[] {
  const result: ClaudeProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\|([^|]*)(?:\|(\d+))?$/.exec(line.trim());
    if (match) {
      const proc: ClaudeProcess = { pid: Number(match[1]), baseUrl: match[2] === '' ? undefined : match[2] };
      if (match[3]) {
        proc.rootPid = Number(match[3]);
      }
      result.push(proc);
    }
  }
  return result;
}

/** The processes that talk to Anthropic directly: no base URL, or one that is not the proxy. */
export function findBypassing(processes: readonly ClaudeProcess[], proxyAddress: string): ClaudeProcess[] {
  return processes.filter((proc) => !proc.baseUrl || !proc.baseUrl.startsWith(proxyAddress));
}

/** `claude.exe` processes descended from `rootPids` (terminal shells and the extension host) with their base URL. */
export function scan(python: PythonRuntime, rootPids: number[]): Promise<ClaudeProcess[]> {
  return new Promise((resolve, reject) => {
    execFile(
      python.command,
      [...python.args, '-c', PY_SCAN, ...rootPids.map(String)],
      { timeout: SCAN_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(parseScanOutput(stdout)))
    );
  });
}
