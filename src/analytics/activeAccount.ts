/**
 * The Anthropic account this machine is signed in as right now, read from Claude
 * Code's own profile (`.claude.json`). It is the single source of truth for which
 * account every budget/cost figure belongs to — the same file the Python advisor
 * reads — so the two sides can never disagree after a login switch. Only non-secret
 * profile fields are read; the OAuth token is never touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ActiveAccount {
  accountUuid: string;
  email?: string;
  organizationType?: string;
  /** Every value a telemetry series might use to name this account. */
  identifiers: string[];
}

export function profileCandidates(baseDir?: string): string[] {
  const candidates: string[] = [];
  const configDir = baseDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    candidates.push(path.join(path.dirname(configDir), '.claude.json'), path.join(configDir, '.claude.json'));
  }
  candidates.push(path.join(os.homedir(), '.claude.json'));
  return candidates;
}

/** `undefined` when nobody is signed in or the profile is unreadable. */
export function readActiveAccount(baseDir?: string): ActiveAccount | undefined {
  for (const candidate of profileCandidates(baseDir)) {
    try {
      const payload = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { oauthAccount?: Record<string, unknown> };
      const account = payload.oauthAccount;
      const accountUuid = typeof account?.accountUuid === 'string' ? account.accountUuid : undefined;
      if (!account || !accountUuid) {
        continue;
      }
      const email = typeof account.emailAddress === 'string' ? account.emailAddress : undefined;
      const organizationType = typeof account.organizationType === 'string' ? account.organizationType : undefined;
      return {
        accountUuid,
        email,
        organizationType,
        identifiers: email ? [accountUuid, email] : [accountUuid],
      };
    } catch {
      continue;
    }
  }
  return undefined;
}
