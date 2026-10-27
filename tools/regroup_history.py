"""Re-derive `newUserTurn` for ledger rows recorded before the proxy learned to ignore
trailing <system-reminder> messages (0.2.9).

Until then a request whose last message was a bare reminder (environment snapshot, "file was
modified", ...) was flagged as a new user turn, so one Enter showed up as several turns. The
ledger cannot tell the two apart, but Claude Code's own transcripts (~/.claude/projects/**/*.jsonl)
keep every prompt the user actually typed, with its time. A ledger row is a real new turn only
when it is the first main-model hit of its project after one of those prompts.

Dry run by default. `--apply` first copies the ledger to a backup folder, then rewrites each
month file atomically (retrying if the file grew meanwhile, because the proxy appends to it).

    py tools/regroup_history.py            # report only
    py tools/regroup_history.py --apply    # write
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import shutil
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

STORAGE = Path(os.environ.get('APPDATA', '')) / 'Code' / 'User' / 'globalStorage' / 'pablo-villalobos.claude-budget-advisor'
TRANSCRIPTS = Path.home() / '.claude' / 'projects'
# A prompt that produced no API call within this long is not matched to any row.
MAX_PROMPT_TO_HIT_S = 15 * 60
NOT_A_PROMPT = ('<system-reminder>', '<local-command', '<command-', 'Caveat:', '[Request interrupted')


def parse_ts(value: str) -> float:
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def dir_slug(project: str) -> str:
    return re.sub(r'[^A-Za-z0-9]', '-', project)


def prompt_text(entry: dict) -> str | None:
    """Text of a message the user typed, or None for tool results, reminders and bookkeeping."""
    if entry.get('type') != 'user' or entry.get('isSidechain') or entry.get('isMeta') or entry.get('isCompactSummary'):
        return None
    content = (entry.get('message') or {}).get('content')
    if isinstance(content, str):
        blocks = [content]
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
            return None
        blocks = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
    else:
        return None
    for text in blocks:
        text = text.strip()
        if text and not text.startswith(NOT_A_PROMPT):
            return text
    return None


def load_prompts(projects: set[str]) -> dict[str, list[float]]:
    """Sorted prompt times (epoch s) per ledger project, from every transcript of its folders."""
    found: dict[str, list[float]] = defaultdict(list)
    if not TRANSCRIPTS.is_dir():
        return found
    for folder in TRANSCRIPTS.iterdir():
        owners = [p for p in projects if folder.name.endswith('-' + dir_slug(p))]
        if not owners:
            continue
        for path in folder.glob('*.jsonl'):
            with path.open(encoding='utf-8', errors='replace') as handle:
                for line in handle:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if 'timestamp' in entry and prompt_text(entry) is not None:
                        for owner in owners:
                            found[owner].append(parse_ts(entry['timestamp']))
    for times in found.values():
        times.sort()
    return found


def read_rows(path: Path) -> list[dict | str]:
    rows: list[dict | str] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            rows.append(line)  # keep anything unreadable untouched
    return rows


def regroup(files: list[Path]) -> tuple[dict[Path, list[dict | str]], dict]:
    data = {path: read_rows(path) for path in files}
    every = [row for rows in data.values() for row in rows if isinstance(row, dict)]
    prompts = load_prompts({row['project'] for row in every})

    by_project: dict[str, list[dict]] = defaultdict(list)
    for row in every:
        by_project[row['project']].append(row)

    stats = defaultdict(int)
    for project, rows in by_project.items():
        rows.sort(key=lambda r: r['timestamp'])
        times = prompts.get(project, [])
        if not times:
            stats['no transcripts'] += len(rows)
            continue
        main = [r for r in rows if 'haiku' not in str(r.get('requestedModel', ''))]
        main_ts = [parse_ts(r['timestamp']) for r in main]
        real: set[int] = set()
        for i, t in enumerate(times):
            nxt = times[i + 1] if i + 1 < len(times) else float('inf')
            at = bisect.bisect_left(main_ts, t - 2)
            if at < len(main) and main_ts[at] < nxt and main_ts[at] - t <= MAX_PROMPT_TO_HIT_S:
                real.add(id(main[at]))
        for row in rows:
            if parse_ts(row['timestamp']) < times[0] - 2:
                stats['before first transcript (kept)'] += 1
                continue
            want = id(row) in real
            if row.get('newUserTurn') is not want:
                stats['fixed new->continuation' if not want else 'fixed continuation->new'] += 1
                row['newUserTurn'] = want
            stats['turns after'] += 1 if want else 0
        stats['prompts'] += len(times)
    return data, dict(stats)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--apply', action='store_true', help='write the result (default: report only)')
    parser.add_argument('--storage', type=Path, default=STORAGE)
    args = parser.parse_args()

    ledger = args.storage / 'ledger'
    files = sorted(ledger.glob('*.jsonl'))
    if not files:
        print(f'no ledger files in {ledger}')
        return 1

    before = defaultdict(int)
    data, stats = regroup(files)
    for rows in data.values():
        for row in rows:
            if isinstance(row, dict):
                before['rows'] += 1
    originals = {path: read_rows(path) for path in files}
    for rows in originals.values():
        for row in rows:
            if isinstance(row, dict) and row.get('newUserTurn') is True:
                before['turns before'] += 1

    print(f"rows: {before['rows']}   turns before: {before['turns before']}   turns after: {stats.get('turns after', 0)}")
    for key in sorted(stats):
        print(f'  {key}: {stats[key]}')
    if not args.apply:
        print('dry run, nothing written (use --apply)')
        return 0

    backup = args.storage / f"ledger-backup-before-regroup-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copytree(ledger, backup)
    print(f'backup: {backup}')
    for path in files:
        for attempt in range(5):
            size = path.stat().st_size
            rows = regroup([path])[0][path]
            body = ''.join((r if isinstance(r, str) else json.dumps(r, ensure_ascii=False, separators=(',', ':'))) + '\n' for r in rows)
            tmp = path.with_suffix('.jsonl.tmp')
            tmp.write_text(body, encoding='utf-8')
            if path.stat().st_size == size:  # the proxy appended nothing while we worked
                os.replace(tmp, path)
                print(f'  wrote {path.name}')
                break
            tmp.unlink(missing_ok=True)
        else:
            print(f'  SKIPPED {path.name}: it kept growing; close VS Code windows and rerun')
            return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
