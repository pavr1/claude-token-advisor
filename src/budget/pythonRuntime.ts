/**
 * Finds a usable Python 3 interpreter for `claude_budget_advisor.py`.
 *
 * The Budget Advisor is a Python script, and the command that starts Python differs by
 * OS: `py` (the launcher) only exists on Windows, `python3` is the norm on macOS and
 * Linux, and a bare `python` may be Python 2 or a Windows Store stub that exits with an
 * error instead of running. Each candidate is asked for its version and only a real
 * Python at or above `MIN_PYTHON` is accepted.
 *
 * Nothing here depends on `vscode`, so it is covered by the node:test suites.
 */

import { execFile } from 'child_process';

export const MIN_PYTHON = { major: 3, minor: 8 };

export interface PythonRuntime {
  command: string;
  /** Arguments that go before the script path (`-3` for the Windows launcher). */
  args: string[];
  version: string;
}

interface Candidate {
  command: string;
  args: string[];
}

/** Runs `command args` and resolves with its combined output; rejects on a non-zero exit or a spawn failure. */
export type Runner = (command: string, args: string[]) => Promise<string>;

export function pythonCandidates(platform: NodeJS.Platform = process.platform): Candidate[] {
  if (platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] },
    ];
  }
  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
}

/** `Python 3.12.1` → `{ major: 3, minor: 12, version: '3.12.1' }`; undefined for anything else. */
export function parsePythonVersion(output: string): { major: number; minor: number; version: string } | undefined {
  const match = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return { major, minor, version: `${major}.${minor}${match[3] !== undefined ? `.${match[3]}` : ''}` };
}

export function isSupported(version: { major: number; minor: number }): boolean {
  return version.major > MIN_PYTHON.major || (version.major === MIN_PYTHON.major && version.minor >= MIN_PYTHON.minor);
}

const defaultRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      // Python 2 prints its version on stderr.
      resolve(`${stdout}\n${stderr}`);
    });
  });

/** The first candidate that is a working Python at or above `MIN_PYTHON`, or undefined when none is. */
export async function detectPython(
  run: Runner = defaultRunner,
  candidates: Candidate[] = pythonCandidates()
): Promise<PythonRuntime | undefined> {
  for (const candidate of candidates) {
    try {
      const parsed = parsePythonVersion(await run(candidate.command, [...candidate.args, '--version']));
      if (parsed && isSupported(parsed)) {
        return { command: candidate.command, args: candidate.args, version: parsed.version };
      }
    } catch {
      // Not installed, or a stub that refuses to run: try the next one.
    }
  }
  return undefined;
}

export class PythonMissingError extends Error {
  constructor() {
    super(`Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer was not found`);
    this.name = 'PythonMissingError';
  }
}
