"""Export the proxy's monthly JSONL ledger to CSV and a JSON summary for the demo.

Usage: python tools/export_demo_data.py [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--projects a,b]
Dates are local days, inclusive. Output goes to demo/data/.
"""
import argparse, csv, glob, json, os
from collections import defaultdict
from datetime import datetime, timedelta

STORE = os.path.join(os.environ.get('APPDATA', ''), 'Code', 'User', 'globalStorage', 'pablo-villalobos.claude-budget-advisor')
OUT = os.path.join(os.path.dirname(__file__), '..', 'demo', 'data')

ap = argparse.ArgumentParser()
ap.add_argument('--from', dest='start', default=(datetime.now() - timedelta(days=13)).strftime('%Y-%m-%d'))
ap.add_argument('--to', dest='end', default=datetime.now().strftime('%Y-%m-%d'))
ap.add_argument('--projects', default='core-banking,claude-budget-advisor')
ap.add_argument('--store', default=STORE)
args = ap.parse_args()
projects = set(args.projects.split(','))

rows = []
for path in sorted(glob.glob(os.path.join(args.store, 'ledger', '*.jsonl'))):
    with open(path, encoding='utf8') as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))

def local(ts): return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone()
sel = []
for r in rows:
    at = local(r['timestamp'])
    day = at.strftime('%Y-%m-%d')
    if args.start <= day <= args.end and r.get('project') in projects:
        r['_day'] = day
        sel.append(r)
# Only turns Anthropic answered carry a baseline to compare with.
priced = [r for r in sel if (r.get('baselineUnitCost') or 0) > 0]

def g(r, k): return r.get(k) or 0
def total(rs, k): return sum(g(r, k) for r in rs)

def block(rs):
    actual, base = total(rs, 'actualUnitCost'), total(rs, 'baselineUnitCost')
    floor = sum(r['floorBaselineUnitCost'] if r.get('floorBaselineUnitCost') is not None else r['baselineUnitCost'] for r in rs)
    central = sum(r['centralBaselineUnitCost'] if r.get('centralBaselineUnitCost') is not None else r['baselineUnitCost'] for r in rs)
    cr, cw = total(rs, 'cacheReadTokens'), total(rs, 'cacheWriteTokens')
    pct = lambda b: round((1 - actual / b) * 100, 2) if b else 0
    return {
        'turns': len(rs), 'rawTokens': total(rs, 'rawTokens'), 'removedByCleanup': total(rs, 'prunedByNormalization'),
        'removedBySummary': total(rs, 'prunedByCompaction'), 'optimizedTokens': total(rs, 'optimizedTokens'),
        'cacheReadTokens': cr, 'cacheWriteTokens': cw, 'cacheReadShare': round(cr / (cr + cw) * 100, 2) if cr + cw else 0,
        'actualUnits': round(actual), 'baselineUnits': round(base), 'floorUnits': round(floor), 'centralUnits': round(central),
        'savingsVsBaselinePct': pct(base), 'savingsVsFloorPct': pct(floor), 'savingsVsCentralPct': pct(central),
        'summarizerUnits': round(total(rs, 'summarizerUnitCost')),
        'modelSwapped': sum(1 for r in rs if r.get('modelSwapped')), 'summaries': sum(1 for r in rs if r.get('compactionTriggered')),
    }

def group(rs, key):
    d = defaultdict(list)
    for r in rs: d[key(r)].append(r)
    return {k: block(v) for k, v in sorted(d.items())}

summary = {
    'period': {'from': args.start, 'to': args.end, 'timezone': datetime.now().astimezone().tzname()},
    'source': {'store': 'VS Code globalStorage, ledger/YYYY-MM.jsonl (append-only JSON Lines, one line per turn)',
               'turnsInPeriod': len(sel), 'turnsWithBaseline': len(priced)},
    'units': 'billed units = tokens x model price weight (Sonnet input = 1)',
    'total': block(priced), 'byProject': group(priced, lambda r: r['project']),
    'byServedModel': group(priced, lambda r: r.get('servedModel') or '?'),
    'byRequestedModel': group(priced, lambda r: r.get('requestedModel') or '?'),
    'byDay': group(priced, lambda r: r['_day']),
}
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf8') as f:
    json.dump(summary, f, indent=2, ensure_ascii=False)

cols = ['timestamp', 'project', 'requestedModel', 'servedModel', 'modelSwapped', 'routingReason', 'rawTokens', 'prunedByNormalization',
        'prunedByCompaction', 'optimizedTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
        'actualUnitCost', 'baselineUnitCost', 'floorBaselineUnitCost', 'centralBaselineUnitCost', 'summarizerUnitCost', 'savingsPercent', 'status']
with open(os.path.join(OUT, 'ledger-export.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f); w.writerow(cols)
    for r in sel: w.writerow([r.get(c, '') for c in cols])
with open(os.path.join(OUT, 'daily-breakdown.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    days = summary['byDay']; keys = ['day'] + list(next(iter(days.values())).keys()) if days else ['day']
    w = csv.writer(f); w.writerow(keys)
    for d, b in days.items(): w.writerow([d] + list(b.values()))
print(json.dumps({k: summary[k] for k in ('period', 'source', 'total')}, indent=1))
