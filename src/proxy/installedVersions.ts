import * as fs from 'fs';
import * as path from 'path';
import { isNewerVersion } from './server';

/**
 * The newest installed version of this extension on disk, if it is newer than `own`.
 * VS Code keeps every installed version in the extensions folder (replaced ones listed in
 * `.obsolete`), named `<publisher>.<name>-<version>[-<platform>]`.
 */
export function newestInstalledVersion(ownDir: string, id: string, own: string): string | undefined {
  const parent = path.dirname(ownDir);
  let obsolete: Record<string, boolean> = {};
  try {
    obsolete = JSON.parse(fs.readFileSync(path.join(parent, '.obsolete'), 'utf8')) as Record<string, boolean>;
  } catch {
    // No marker file: every folder counts.
  }
  const prefix = `${id.toLowerCase()}-`;
  let newest: string | undefined;
  for (const name of fs.readdirSync(parent)) {
    if (!name.toLowerCase().startsWith(prefix)) {
      continue;
    }
    const version = /^\d+\.\d+\.\d+/.exec(name.slice(prefix.length))?.[0];
    if (version && !obsolete[name] && isNewerVersion(version, newest ?? own)) {
      newest = version;
    }
  }
  return newest;
}
