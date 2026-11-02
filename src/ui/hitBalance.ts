/**
 * How a turn is tinted by its hits: the rule behind the red, green and amber of the cache cells, and
 * the one the tips use to find the turns that paid for a cache write that did not pay off.
 */
import { aggregate, isFailedHit, LedgerEntry } from '../analytics/tracker';

export type Balance = 'red' | 'green' | 'amber' | 'none';

/**
 * How a turn is tinted on each basis, judged by its hits and not by its total: red when every hit
 * wrote more than it read, green when every hit read more than it wrote, amber when it has both.
 */
export interface HitBalance {
  tokens: Balance;
  units: Balance;
}

function balanceOfHits(kinds: ReadonlySet<'red' | 'green'>): Balance {
  if (kinds.has('red') && kinds.has('green')) {
    return 'amber';
  }
  return kinds.has('red') ? 'red' : kinds.has('green') ? 'green' : 'none';
}

export function hitBalanceOf(entries: readonly LedgerEntry[]): HitBalance {
  const tokens = new Set<'red' | 'green'>();
  const units = new Set<'red' | 'green'>();
  for (const entry of entries) {
    if (isFailedHit(entry)) {
      continue;
    }
    const hit = aggregate([entry]);
    if (hit.cacheWriteTokens > hit.cacheReadTokens) {
      tokens.add('red');
    } else if (hit.cacheReadTokens > hit.cacheWriteTokens) {
      tokens.add('green');
    }
    if (hit.cacheWritePremiumUnits > hit.cacheReadSavedUnits) {
      units.add('red');
    } else if (hit.cacheReadSavedUnits > hit.cacheWritePremiumUnits) {
      units.add('green');
    }
  }
  return { tokens: balanceOfHits(tokens), units: balanceOfHits(units) };
}
