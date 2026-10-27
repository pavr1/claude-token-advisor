/**
 * Per-account-type view resolution.
 *
 * Mirrors `accounts/__init__.py`'s `resolve_account_profile` on the Python
 * side: an account type that has genuinely distinct logic (Pro, Enterprise)
 * gets its own module here, so one account's behavior can change without
 * risking another's. Team and API are not part of this split yet and keep
 * falling through to the `budgetApi` heuristic `detect_plan()` already
 * encodes, exactly as before.
 */

import { ENTERPRISE_ORG_TYPES, ENTERPRISE_VIEW_MODE } from './enterprise';
import { PRO_ORG_TYPES, PRO_VIEW_MODE } from './pro';

export type AccountViewMode = 'percent' | 'dollar';

/**
 * Which view (percent vs dollar) an organization type renders. Checks Pro's
 * and Enterprise's explicit registrations first; anything else (Team, API,
 * or an org type Python doesn't recognize) falls back to the `budgetApi`
 * heuristic: `'unavailable'` means no $ source exists (percent), anything
 * else means a real $ figure exists (dollar) — unchanged from before the
 * accounts/ split.
 */
export function resolveAccountViewMode(organizationType: string | null, budgetApi: string | null): AccountViewMode {
  if (organizationType && PRO_ORG_TYPES.includes(organizationType)) {
    return PRO_VIEW_MODE;
  }
  if (organizationType && ENTERPRISE_ORG_TYPES.includes(organizationType)) {
    return ENTERPRISE_VIEW_MODE;
  }
  return budgetApi === 'unavailable' ? 'percent' : 'dollar';
}
