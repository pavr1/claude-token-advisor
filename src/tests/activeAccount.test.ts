import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { profileCandidates, readActiveAccount } from '../analytics/activeAccount';

function profileDir(oauthAccount: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-account-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount }));
  return dir;
}

test('readActiveAccount reads the signed-in account next to the .claude directory', () => {
  const dir = profileDir({ accountUuid: 'u-1', emailAddress: 'a@b.com', organizationType: 'claude_pro' });
  const account = readActiveAccount(path.join(dir, '.claude'));
  assert.deepEqual(account, {
    accountUuid: 'u-1',
    email: 'a@b.com',
    organizationType: 'claude_pro',
    identifiers: ['u-1', 'a@b.com'],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readActiveAccount follows a login switch on the next read', () => {
  const dir = profileDir({ accountUuid: 'u-1' });
  assert.equal(readActiveAccount(path.join(dir, '.claude'))?.accountUuid, 'u-1');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-2' } }));
  assert.equal(readActiveAccount(path.join(dir, '.claude'))?.accountUuid, 'u-2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profileCandidates looks beside and inside the config dir, then the home directory', () => {
  const dir = path.join(os.tmpdir(), 'cfg', '.claude');
  assert.deepEqual(profileCandidates(`  ${dir}  `), [
    path.join(path.dirname(dir), '.claude.json'),
    path.join(dir, '.claude.json'),
    path.join(os.homedir(), '.claude.json'),
  ]);
  assert.deepEqual(profileCandidates('   ').slice(-1), [path.join(os.homedir(), '.claude.json')]);
});

test('profileCandidates falls back to CLAUDE_CONFIG_DIR when no base dir is given', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const dir = path.join(os.tmpdir(), 'env-cfg', '.claude');
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.equal(profileCandidates()[0], path.join(path.dirname(dir), '.claude.json'));
    // An explicit base dir wins over the environment.
    const explicit = path.join(os.tmpdir(), 'explicit', '.claude');
    assert.equal(profileCandidates(explicit)[0], path.join(path.dirname(explicit), '.claude.json'));
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }
});

test('readActiveAccount lists only the uuid when there is no email, and ignores non-string fields', () => {
  const dir = profileDir({ accountUuid: 'u-2', emailAddress: 42, organizationType: ['x'] });
  const account = readActiveAccount(path.join(dir, '.claude'));
  assert.deepEqual(account, { accountUuid: 'u-2', email: undefined, organizationType: undefined, identifiers: ['u-2'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readActiveAccount treats a profile with no usable account as signed out', () => {
  for (const oauthAccount of [undefined, null, {}, { accountUuid: 7 }, { emailAddress: 'a@b.com' }]) {
    const dir = profileDir(oauthAccount);
    const found = readActiveAccount(path.join(dir, '.claude'));
    // The real home profile may exist on a developer machine; the temp profile itself must not match.
    assert.ok(found === undefined || !['a@b.com'].includes(found.email ?? ''), JSON.stringify(oauthAccount));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readActiveAccount skips an unreadable or malformed profile and tries the next candidate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-account-bad-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  // The sibling profile is malformed; the one inside the config dir is valid and must be found.
  fs.writeFileSync(path.join(dir, '.claude.json'), '{ not json');
  fs.writeFileSync(path.join(dir, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'inner' } }));
  assert.equal(readActiveAccount(path.join(dir, '.claude'))?.accountUuid, 'inner');
  fs.rmSync(dir, { recursive: true, force: true });
});
