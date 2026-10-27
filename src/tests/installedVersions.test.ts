import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { newestInstalledVersion } from '../proxy/installedVersions';

function extensionsDir(folders: string[], obsolete?: Record<string, boolean>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-versions-'));
  for (const name of folders) {
    fs.mkdirSync(path.join(dir, name));
  }
  if (obsolete) {
    fs.writeFileSync(path.join(dir, '.obsolete'), JSON.stringify(obsolete));
  }
  return dir;
}

const ID = 'Pablo-Villalobos.claude-budget-advisor';

test('newestInstalledVersion finds a newer install next to the running one', () => {
  const dir = extensionsDir([`${ID.toLowerCase()}-0.2.8`, `${ID.toLowerCase()}-0.2.9`, 'other.ext-9.9.9']);
  assert.equal(newestInstalledVersion(path.join(dir, `${ID.toLowerCase()}-0.2.8`), ID, '0.2.8'), '0.2.9');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('newestInstalledVersion ignores the running version, older ones and obsolete folders', () => {
  const name = (v: string): string => `${ID.toLowerCase()}-${v}`;
  const dir = extensionsDir([name('0.2.5'), name('0.2.8'), name('0.3.0')], { [name('0.3.0')]: true });
  assert.equal(newestInstalledVersion(path.join(dir, name('0.2.8')), ID, '0.2.8'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('newestInstalledVersion accepts platform suffixes and picks the highest', () => {
  const name = (v: string): string => `${ID.toLowerCase()}-${v}`;
  const dir = extensionsDir([name('0.2.8'), name('0.2.10-win32-x64'), name('0.2.9')]);
  assert.equal(newestInstalledVersion(path.join(dir, name('0.2.8')), ID, '0.2.8'), '0.2.10');
  fs.rmSync(dir, { recursive: true, force: true });
});
