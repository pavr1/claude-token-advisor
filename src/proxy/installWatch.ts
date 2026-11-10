/**
 * Detects that the code this extension host loaded is no longer the code on disk.
 *
 * VS Code never unloads an extension from a window because it was uninstalled or
 * reinstalled in another one: each window's extension host keeps running whatever
 * it loaded at startup until that window reloads. The proxy lives inside one of
 * those hosts, so an old host could keep serving the shared port long after the
 * extension was removed or replaced, and every other window would keep sharing it.
 * The host compares its own entry file with the one it started from, and once it
 * changed or disappeared it lets go of the port so a window with current code can
 * take it over.
 */

import * as fs from 'fs';

export interface InstallFingerprint {
  mtimeMs: number;
  size: number;
}

export type InstallStatus = 'current' | 'replaced' | 'removed';

/** Size and modification time of `file`, or undefined when it cannot be read. */
export function readFingerprint(file: string): InstallFingerprint | undefined {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/**
 * Compare the file as it is now with how it was when this host started.
 *
 * With no baseline there is nothing to compare against, so it reports `current`
 * rather than releasing a proxy on a guess.
 */
export function checkInstall(file: string, baseline: InstallFingerprint | undefined): InstallStatus {
  if (!baseline) {
    return 'current';
  }
  const now = readFingerprint(file);
  if (!now) {
    return 'removed';
  }
  return now.mtimeMs !== baseline.mtimeMs || now.size !== baseline.size ? 'replaced' : 'current';
}

/**
 * When the code on disk was installed, in epoch ms, or undefined when it cannot be told.
 *
 * VS Code keeps `globalStorage` across an uninstall, so the ledger outlives the
 * extension. The extension's own folder does not: every install creates it fresh,
 * so its creation time marks the last (re)install. Filesystems without a birth time
 * report 0, in which case the modification time stands in.
 */
export function readInstallTime(extensionPath: string): number | undefined {
  try {
    const stat = fs.statSync(extensionPath);
    const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    return Number.isFinite(born) && born > 0 ? born : undefined;
  } catch {
    return undefined;
  }
}
