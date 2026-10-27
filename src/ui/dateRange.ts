/** Date choices of the Turns table header. Kept free of `vscode` imports so it can be unit tested. */

export type RangeId = 'today' | 'yesterday' | '7d' | 'month' | 'lastMonth' | 'custom';
export const RANGE_LABELS: Record<RangeId, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  month: 'This month',
  lastMonth: 'Last month',
  custom: 'Custom range…',
};

/** Local-day bounds (epoch ms, end exclusive) of the chosen range; `includesNow` when today falls inside it. */
export function resolveRange(filters: { range: RangeId; from?: string; to?: string }, now = new Date()): { start: number; end: number; includesNow: boolean } {
  const day = (offset: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  const parse = (value: string | undefined, fallback: number): number => {
    const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : fallback;
  };
  let start = day(0);
  let end = day(1);
  if (filters.range === 'yesterday') {
    start = day(-1);
    end = day(0);
  } else if (filters.range === '7d') {
    start = day(-6);
  } else if (filters.range === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  } else if (filters.range === 'lastMonth') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    end = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  } else if (filters.range === 'custom') {
    start = parse(filters.from, day(0));
    const last = new Date(Math.max(start, parse(filters.to, start)));
    end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  }
  return { start, end, includesNow: start <= now.getTime() && now.getTime() < end };
}

