/**
 * Guards the test suite itself: every source module must be reached by some test, or be listed
 * here as deliberately untested. Node's coverage report only counts files a test loaded, so a new
 * module no test imports would otherwise sit at an invisible 0% and the totals would still look fine.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const SRC = path.resolve(__dirname, '..', '..', 'src');

/**
 * Modules that need the VS Code runtime and no test reaches yet. Shrink this list, never grow it:
 * add a test (or move the logic into a module that has one) instead of adding a name.
 */
const UNTESTED = new Set(['extension']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(full) : e.name.endsWith('.ts') ? [full] : [];
  });
}

const moduleId = (file: string): string => path.relative(SRC, file).split(path.sep).join('/').replace(/\.ts$/, '');

function imports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|require\()\s*['"](\.[^'"]*)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    // `'../accounts'` may name a folder and mean its index.
    found.push(moduleId(fs.existsSync(target + '.ts') ? target + '.ts' : path.join(target, 'index.ts')));
  }
  return found;
}

test('every source module is imported, directly or not, by a test, or listed as untested', () => {
  const files = sourceFiles(SRC);
  const byId = new Map(files.map((f) => [moduleId(f), f]));
  const reached = new Set<string>();
  const queue = files.filter((f) => f.endsWith('.test.ts')).map(moduleId);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    const file = byId.get(id);
    if (reached.has(id) || !file) {
      continue;
    }
    reached.add(id);
    queue.push(...imports(file));
  }

  const missing = [...byId.keys()].filter((id) => !id.startsWith('tests/') && !reached.has(id) && !UNTESTED.has(id));
  assert.deepEqual(missing, [], `Modules no test reaches: ${missing.join(', ')}. Add a test.`);

  const stale = [...UNTESTED].filter((id) => reached.has(id) || !byId.has(id));
  assert.deepEqual(stale, [], `Now tested or gone, remove from UNTESTED: ${stale.join(', ')}`);
});
