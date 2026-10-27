from __future__ import annotations

import argparse
import calendar
import json
import os
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import accounts

TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)

CONFIG_KEYS = ("project_name", "repo_name", "claude_project_name")

# Relative price weight per token, normalised so the economy tier == 1.
MODEL_TIERS = (
    ("opus", "premium", 12.0),
    ("sonnet", "balanced", 3.0),
    ("haiku", "economy", 1.0),
)

# Published per-token rates are fetched from this feed and cached locally, so an upstream
# price change does not silently corrupt every percentage we report.
PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
PRICING_CACHE_TTL_SECONDS = 7 * 24 * 3600

PRICING_FIELDS = {
    "input": "input_cost_per_token",
    "output": "output_cost_per_token",
    "cache_read": "cache_read_input_token_cost",
    "cache_write": "cache_creation_input_token_cost",
}

# Last-resort rates (USD per token), used only when the feed and cache are unavailable.
FALLBACK_TIER_PRICING = {
    "premium": {"input": 15e-6, "output": 75e-6, "cache_write": 18.75e-6, "cache_read": 1.5e-6},
    "balanced": {"input": 3e-6, "output": 15e-6, "cache_write": 3.75e-6, "cache_read": 0.3e-6},
    "economy": {"input": 1e-6, "output": 5e-6, "cache_write": 1.25e-6, "cache_read": 0.1e-6},
    "unknown": {"input": 3e-6, "output": 15e-6, "cache_write": 3.75e-6, "cache_read": 0.3e-6},
}

COMPONENT_FIELDS = {
    "input": "input_tokens",
    "output": "output_tokens",
    "cache_read": "cache_read_input_tokens",
    "cache_write": "cache_creation_input_tokens",
}

ALERT_THRESHOLDS = (95, 90, 80)
# Budget sources with no prior-month baseline (derived from the current month or a placeholder).
NO_BASELINE_SOURCES = ("auto_projected", "auto_default")


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def classify_model(model_name: str) -> tuple[str, float]:
    lowered = (model_name or "").lower()
    for marker, tier, weight in MODEL_TIERS:
        if marker in lowered:
            return tier, weight
    return "unknown", 2.0


def _pricing_cache_path() -> Path:
    return Path.home() / ".claude-budget-advisor" / "model_pricing.json"


def _extract_anthropic_pricing(payload: dict) -> dict:
    pricing: dict[str, dict] = {}
    for model_name, entry in payload.items():
        if not isinstance(entry, dict) or entry.get("litellm_provider") != "anthropic":
            continue
        rates = {}
        for key, field in PRICING_FIELDS.items():
            value = entry.get(field)
            if isinstance(value, (int, float)):
                rates[key] = float(value)
        if rates.get("input") and rates.get("output"):
            pricing[str(model_name).lower()] = rates
    return pricing


def fetch_remote_pricing(timeout: float = 10.0) -> dict | None:
    try:
        import urllib.request

        with urllib.request.urlopen(PRICING_URL, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

    return _extract_anthropic_pricing(payload) or None


def load_pricing(allow_network: bool = True, pricing_file: str | Path | None = None) -> tuple[dict, str]:
    """Resolve per-token rates: explicit file, fresh cache, live feed, then fallback."""
    if pricing_file:
        try:
            payload = json.loads(Path(pricing_file).read_text(encoding="utf-8-sig"))
            pricing = _extract_anthropic_pricing(payload) or {
                str(key).lower(): value for key, value in payload.items() if isinstance(value, dict)
            }
            if pricing:
                return pricing, "file"
        except (OSError, json.JSONDecodeError):
            pass

    cache_path = _pricing_cache_path()
    cached: dict | None = None
    try:
        if cache_path.exists():
            loaded = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and loaded:
                cached = loaded
                age = datetime.now().timestamp() - cache_path.stat().st_mtime
                if age < PRICING_CACHE_TTL_SECONDS:
                    return cached, "cache"
    except (OSError, json.JSONDecodeError):
        cached = None

    if allow_network:
        fresh = fetch_remote_pricing()
        if fresh:
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(json.dumps(fresh), encoding="utf-8")
            except OSError:
                pass
            return fresh, "remote"

    if cached:
        return cached, "stale_cache"

    return {}, "fallback"


def resolve_model_rates(model_name: str, pricing: dict) -> tuple[dict, bool]:
    lowered = (model_name or "").lower()
    if lowered in pricing:
        return pricing[lowered], True

    matches = [key for key in pricing if key.startswith(lowered) or lowered.startswith(key)]
    if matches:
        return pricing[max(matches, key=len)], True

    tier, _ = classify_model(model_name)
    return FALLBACK_TIER_PRICING.get(tier, FALLBACK_TIER_PRICING["unknown"]), False


def cost_units(model_name: str, components: dict, pricing: dict | None = None) -> float:
    """Convert tokens to real cost; token types differ in price by up to ~100x."""
    rates, _ = resolve_model_rates(model_name, pricing or {})
    return sum(components.get(key, 0) * rates.get(key, 0.0) for key in COMPONENT_FIELDS)


def load_project_name_config(base_dir: str | Path) -> str | None:
    root = Path(base_dir)
    for config_file in (
        root / "config.json",
        root / ".claude-budget-advisor.json",
        root / ".claude-claude-budget-advisor.json",
    ):
        if not config_file.exists():
            continue

        try:
            payload = json.loads(config_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        if isinstance(payload, dict):
            for key in CONFIG_KEYS:
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def resolve_project_name(base_dir: str | Path, project_name: str | None = None) -> str:
    if project_name and project_name.strip():
        return project_name.strip()

    configured = load_project_name_config(base_dir)
    if configured:
        return configured

    return "current"


def resolve_claude_root(explicit: str | Path | None = None) -> Path:
    """Locate the Claude data directory without hard-coding a user-specific path."""
    if explicit and str(explicit).strip() and str(explicit).strip() != ".":
        return Path(str(explicit).strip()).expanduser()

    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured and configured.strip():
        return Path(configured.strip()).expanduser()

    home_root = Path.home() / ".claude"
    if home_root.exists():
        return home_root

    # The CLI on PATH lives in an install dir (~/.local/bin), not the data dir,
    # so walk up from it looking for a sibling .claude folder.
    executable = shutil.which("claude")
    if executable:
        for parent in Path(executable).resolve().parents:
            candidate = parent / ".claude"
            if candidate.exists():
                return candidate

    return home_root


def encode_workspace_path(workspace_path: str | Path) -> str:
    # Claude names project folders after the workspace path with ":", separators
    # and spaces flattened to "-" (C:\Users\me\App -> c--Users-me-App).
    text = str(workspace_path).rstrip("\\/")
    for char in (":", "\\", "/", " ", "_"):
        text = text.replace(char, "-")
    return text


def _find_project_dir_for_workspace(projects_root: Path, workspace_path: str | Path) -> Path | None:
    if not workspace_path or not projects_root.exists():
        return None

    encoded = encode_workspace_path(workspace_path).lower()
    for path in projects_root.iterdir():
        if path.is_dir() and path.name.lower() == encoded:
            return path
    return None


def _find_matching_project_dir(projects_root: Path, project_value: str) -> Path | None:
    # Claude flattens the whole workspace path into the folder name
    # ("talent-app-back" -> "c--Users-...-Documents-Talent-App-talent-app-back").
    if not projects_root.exists():
        return None

    target = project_value.lower().replace("_", "-").replace(" ", "-")
    candidates = [path for path in projects_root.iterdir() if path.is_dir()]

    exact = [path for path in candidates if path.name.lower() == target]
    suffix = [path for path in candidates if path.name.lower().endswith(f"-{target}")]
    contains = [path for path in candidates if target in path.name.lower()]

    for group in (exact, suffix, contains):
        if group:
            group.sort(key=lambda path: path.stat().st_mtime, reverse=True)
            return group[0]
    return None


def _project_dir(base_dir: str | Path, project_name: str, workspace_path: str | Path | None = None) -> Path:
    root = Path(base_dir)
    project_value = resolve_project_name(root, project_name)
    projects_root = root / "projects"

    workspace_match = _find_project_dir_for_workspace(projects_root, workspace_path) if workspace_path else None
    if workspace_match is not None:
        return workspace_match

    if not project_value or project_value == "current":
        if not projects_root.exists():
            return projects_root

        candidates = sorted(
            [path for path in projects_root.iterdir() if path.is_dir()],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            return projects_root
        return candidates[0]

    project_path = Path(project_value)
    if project_path.is_absolute() and project_path.exists():
        return project_path

    exact_dir = projects_root / project_value
    if exact_dir.exists():
        return exact_dir

    matched_dir = _find_matching_project_dir(projects_root, project_value)
    if matched_dir is not None:
        return matched_dir

    return exact_dir


def _parse_timestamp(raw_value, use_utc: bool = False) -> datetime | None:
    if not isinstance(raw_value, str) or not raw_value:
        return None
    try:
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if use_utc:
        # Matches claude.ai's own usage page, which buckets days in UTC (1.2).
        return parsed.astimezone(timezone.utc)
    # Claude records UTC; report in local time so "today" matches the user's clock.
    return parsed.astimezone()


# Entries before this instant are ignored (set by --since). Lets a demo or a
# fresh install count only the period Anthropic's telemetry also covers.
_SINCE: datetime | None = None

# Time windows during which the current account was the signed-in one. Transcripts do
# not record which account produced a message, so entries outside these windows belong
# to another login (or to a period before this plan) and are ignored. None = no scoping.
_ACCOUNT_WINDOWS: list[tuple[datetime | None, datetime | None]] | None = None


def _in_account_windows(stamp: datetime) -> bool:
    if _ACCOUNT_WINDOWS is None:
        return True
    return any(
        (start is None or stamp >= start) and (end is None or stamp < end)
        for start, end in _ACCOUNT_WINDOWS
    )


def _iter_usage_entries(project_root: Path, use_utc: bool = False):
    seen_messages: set[str] = set()
    for file_path in sorted(project_root.rglob("*.jsonl")):
        if not file_path.is_file():
            continue
        try:
            handle = file_path.open("r", encoding="utf-8", errors="ignore")
        except OSError:
            continue
        with handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    continue

                dedupe_key = message.get("id") or entry.get("requestId")
                if isinstance(dedupe_key, str) and dedupe_key:
                    if dedupe_key in seen_messages:
                        continue
                    seen_messages.add(dedupe_key)

                stamp = _parse_timestamp(entry.get("timestamp"), use_utc=use_utc)
                if stamp is None:
                    continue
                if _SINCE is not None and stamp < _SINCE:
                    continue
                if not _in_account_windows(stamp):
                    continue

                components = {key: _as_int(usage.get(field)) for key, field in COMPONENT_FIELDS.items()}
                tokens = sum(components.values())
                if tokens <= 0:
                    continue

                model_name = message.get("model") or entry.get("model") or "unknown"
                workspace_cwd = entry.get("cwd") if isinstance(entry.get("cwd"), str) else None
                yield stamp, str(model_name), tokens, components, file_path, workspace_cwd


def iter_project_dirs(projects_root: Path) -> list[Path]:
    if not projects_root.exists():
        return []
    return sorted((path for path in projects_root.iterdir() if path.is_dir()), key=lambda path: path.name)


def analyze_all_projects(base_dir: str | Path, month: str, pricing: dict | None = None, use_utc: bool = False) -> dict:
    """Aggregate usage across every Claude project for the given month."""
    root = Path(base_dir)
    projects_root = root / "projects"
    pricing = pricing or {}
    unpriced: set[str] = set()

    by_model: dict[str, int] = defaultdict(int)
    by_model_weighted: dict[str, float] = defaultdict(float)
    by_day: dict[int, int] = defaultdict(int)
    by_day_weighted: dict[int, float] = defaultdict(float)
    by_month: dict[str, int] = defaultdict(int)
    by_month_weighted: dict[str, float] = defaultdict(float)
    by_project: dict[str, int] = defaultdict(int)
    by_project_weighted: dict[str, float] = defaultdict(float)
    project_labels: dict[str, str] = {}
    covered_files: set[str] = set()
    total_tokens = 0
    total_weighted = 0.0

    for project_dir in iter_project_dirs(projects_root):
        for stamp, model_name, tokens, components, file_path, workspace_cwd in _iter_usage_entries(project_dir, use_utc=use_utc):
            entry_month = stamp.strftime("%Y-%m")
            rates, exact = resolve_model_rates(model_name, pricing)
            if not exact:
                unpriced.add(model_name)
            weighted = sum(components.get(key, 0) * rates.get(key, 0.0) for key in COMPONENT_FIELDS)
            by_month[entry_month] += tokens
            by_month_weighted[entry_month] += weighted
            if entry_month != month:
                continue

            total_tokens += tokens
            total_weighted += weighted
            by_model[model_name] += tokens
            by_model_weighted[model_name] += weighted
            by_day[stamp.day] += tokens
            by_day_weighted[stamp.day] += weighted
            by_project[project_dir.name] += tokens
            by_project_weighted[project_dir.name] += weighted
            covered_files.add(str(file_path))
            # The cwd recorded in each entry is the real repo path, so it gives a clean label.
            if workspace_cwd and project_dir.name not in project_labels:
                project_labels[project_dir.name] = Path(workspace_cwd.rstrip("\\/")).name or project_dir.name

    return {
        "project_name": "",
        "project_dir": str(projects_root),
        "scope": "all",
        "month": month,
        "total_tokens_used": total_tokens,
        "total_weighted": total_weighted,
        "by_model": dict(sorted(by_model.items())),
        "by_model_weighted": dict(by_model_weighted),
        "by_day": {str(day): by_day[day] for day in sorted(by_day)},
        "by_day_weighted": {str(day): by_day_weighted[day] for day in sorted(by_day_weighted)},
        "by_month": dict(sorted(by_month.items())),
        "by_month_weighted": dict(sorted(by_month_weighted.items())),
        "by_project": {project_labels.get(key, key): value for key, value in by_project.items()},
        "by_project_weighted": {project_labels.get(key, key): value for key, value in by_project_weighted.items()},
        "project_count": len([key for key, value in by_project.items() if value > 0]),
        "unpriced_models": sorted(unpriced),
        "covered_files": sorted(covered_files),
    }


def analyze_project_usage(
    base_dir: str | Path,
    project_name: str | None,
    month: str,
    workspace_path: str | Path | None = None,
    pricing: dict | None = None,
    use_utc: bool = False,
) -> dict:
    project_value = resolve_project_name(base_dir, project_name)
    project_root = _project_dir(base_dir, project_value, workspace_path)
    pricing = pricing or {}
    unpriced: set[str] = set()

    by_model: dict[str, int] = defaultdict(int)
    by_model_weighted: dict[str, float] = defaultdict(float)
    by_day: dict[int, int] = defaultdict(int)
    by_day_weighted: dict[int, float] = defaultdict(float)
    by_month: dict[str, int] = defaultdict(int)
    by_month_weighted: dict[str, float] = defaultdict(float)
    covered_files: set[str] = set()
    detected_label = ""
    total_tokens = 0
    total_weighted = 0.0

    for stamp, model_name, tokens, components, file_path, workspace_cwd in _iter_usage_entries(project_root, use_utc=use_utc):
        entry_month = stamp.strftime("%Y-%m")
        rates, exact = resolve_model_rates(model_name, pricing)
        if not exact:
            unpriced.add(model_name)
        weighted = sum(components.get(key, 0) * rates.get(key, 0.0) for key in COMPONENT_FIELDS)
        by_month[entry_month] += tokens
        by_month_weighted[entry_month] += weighted
        if entry_month != month:
            continue

        total_tokens += tokens
        total_weighted += weighted
        by_model[model_name] += tokens
        by_model_weighted[model_name] += weighted
        by_day[stamp.day] += tokens
        by_day_weighted[stamp.day] += weighted
        covered_files.add(str(file_path))
        if workspace_cwd and not detected_label:
            detected_label = Path(workspace_cwd.rstrip("\\/")).name

    if workspace_path:
        resolved_name = Path(str(workspace_path).rstrip("\\/")).name
    elif project_value and project_value != "current":
        resolved_name = project_value
    else:
        resolved_name = detected_label or project_root.name

    return {
        "project_name": resolved_name,
        "project_dir": str(project_root),
        "month": month,
        "total_tokens_used": total_tokens,
        "total_weighted": total_weighted,
        "by_model": dict(sorted(by_model.items())),
        "by_model_weighted": dict(by_model_weighted),
        "by_day": {str(day): by_day[day] for day in sorted(by_day)},
        "by_day_weighted": {str(day): by_day_weighted[day] for day in sorted(by_day_weighted)},
        "by_month": dict(sorted(by_month.items())),
        "by_month_weighted": dict(sorted(by_month_weighted.items())),
        "unpriced_models": sorted(unpriced),
        "covered_files": sorted(covered_files),
    }


def derive_budget(summary: dict, month: str | None, day: int | None = None) -> tuple[float, str]:
    """Infer a monthly budget from prior usage so the user does not have to supply one."""
    by_month = {key: float(value) for key, value in (summary.get("by_month_weighted") or {}).items()}
    # Only months strictly before `month` are "completed" — a later (UTC-bucketed) month is not history.
    completed = [amount for key, amount in sorted(by_month.items()) if (month is None or key < month) and amount > 0]

    if completed:
        # Drop onboarding/partial months so a single light month cannot deflate the baseline.
        peak = max(completed)
        representative = [amount for amount in completed[-3:] if amount >= peak * 0.25]
        return max(representative) if representative else peak, "auto_history"

    current_total = float(summary.get("total_weighted", 0) or 0)
    if current_total > 0:
        days_in_month = _days_in_month_for(month)
        # `day` should be the same UTC-or-local basis `summary` was bucketed in
        # (1.2) — a mismatched "now" here would scale the projection off by
        # however far local and UTC disagree on the date. Falls back to local
        # `now` only for callers that don't pass one.
        current_day = day if day is not None else datetime.now().day
        return (current_total / max(min(current_day, days_in_month), 1)) * days_in_month, "auto_projected"

    return 1.0, "auto_default"


def resolve_budget(
    summary: dict, budget_tokens: int, budget_usd: float, month: str | None, day: int | None = None
) -> tuple[float, str]:
    """Pick the monthly budget (in weighted-USD units) and where it came from.

    `budget_usd` is the most literal figure a user can supply — the real cap for a
    dollar-native plan (Enterprise, API) usually only exists as a USD number on
    Anthropic's own usage page, never as a token count — so it takes priority over
    a token budget when both are given, with no token-mix conversion to distort it.
    Falls back to the token budget (converted at this month's own weighted-cost
    mix) and finally to `derive_budget()`'s own inference from history.
    """
    if budget_usd and budget_usd > 0:
        return float(budget_usd), "user"

    if budget_tokens and budget_tokens > 0:
        total_tokens = float(summary.get("total_tokens_used", 0) or 0)
        total_weighted = float(summary.get("total_weighted", 0) or 0)
        ratio = (total_weighted / total_tokens) if total_tokens else 0
        if ratio:
            return budget_tokens * ratio, "user"

    return derive_budget(summary, month, day=day)


def _days_in_month_for(month: str | None) -> int:
    if not month or len(month) != 7 or "-" not in month:
        return 30

    try:
        year_value, month_value = month.split("-")
        return calendar.monthrange(int(year_value), int(month_value))[1]
    except ValueError:
        return 30


def _previous_month(month: str | None) -> str | None:
    if not month:
        return None
    try:
        year_value, month_value = (int(part) for part in month.split("-"))
    except ValueError:
        return None
    if month_value == 1:
        return f"{year_value - 1}-12"
    return f"{year_value}-{month_value - 1:02d}"


def _pace_status(delta_ratio: float) -> str:
    if delta_ratio > 0.1:
        return "over_pace"
    if delta_ratio < -0.1:
        return "under_pace"
    return "on_track"


def build_model_breakdown(by_model: dict, total_tokens: int, by_model_weighted: dict | None = None) -> list[dict]:
    weighted_map = by_model_weighted or {}
    total_weighted = sum(weighted_map.values())
    breakdown = []
    for model_name, tokens in by_model.items():
        tier, weight = classify_model(model_name)
        weighted = float(weighted_map.get(model_name, 0.0))
        breakdown.append(
            {
                "model": model_name,
                "tokens": int(tokens),
                "percent": round((weighted / total_weighted) * 100, 1) if total_weighted else 0.0,
                "token_percent": round((int(tokens) / total_tokens) * 100, 1) if total_tokens else 0.0,
                "tier": tier,
                "cost_weight": weight,
                "weighted_cost": weighted,
            }
        )
    breakdown.sort(key=lambda item: item["weighted_cost"], reverse=True)
    return breakdown


# 2.6: general Claude Code usage habits that cut token spend regardless of model
# mix or pace. "Pick the right model" is deliberately left out here — the
# premium/economy tips above already cover that ground with numbers from this
# account's own usage, which is more useful than a generic restatement.
GENERAL_USAGE_TIPS = [
    "Start a fresh session every 15-20 messages, or run /clear or /compact — a long "
    "history means every new message re-sends and re-bills the whole conversation.",
    "Disconnect MCP servers and tools you are not using this session — their "
    "definitions are re-sent with every request even while idle.",
    "Combine related questions into one message instead of sending them one at a "
    "time — each message re-sends the full context so far.",
    "Use Plan Mode before large changes — reviewing a plan is far cheaper than "
    "paying for a wrong implementation and a redo.",
    "Keep CLAUDE.md concise — it is loaded into every single request in this project.",
]


def build_recommendations(breakdown: list[dict], pace_status: str, percent_used: float) -> list[str]:
    recommendations: list[str] = []
    total_weighted = sum(item["weighted_cost"] for item in breakdown) or 1
    premium_share = sum(item["weighted_cost"] for item in breakdown if item["tier"] == "premium") / total_weighted * 100
    economy_tokens = sum(item["tokens"] for item in breakdown if item["tier"] == "economy")

    if premium_share >= 50:
        recommendations.append(
            f"Premium models drive {premium_share:.0f}% of your cost. Keep Opus for architecture, "
            "multi-file refactors and hard debugging; send reviews and boilerplate to Sonnet."
        )
    elif premium_share > 0:
        recommendations.append(
            f"Premium usage is a healthy {premium_share:.0f}% of cost. Keep Opus for deep reasoning only."
        )

    if breakdown and economy_tokens == 0:
        recommendations.append(
            "No economy-tier usage detected. Route formatting, renames, doc lookups and simple Q&A to Haiku."
        )

    if pace_status == "over_pace":
        recommendations.append(
            "You are burning faster than the ideal pace. Trim context windows and avoid resending large files."
        )
    elif pace_status == "under_pace" and percent_used < 60:
        recommendations.append(
            "You are comfortably under pace, so there is headroom for stronger models on complex tasks."
        )

    if not recommendations:
        recommendations.append("Usage looks balanced. Keep the current model mix.")

    recommendations.extend(GENERAL_USAGE_TIPS)
    return recommendations


SPIKE_SHARE = 0.5


def _spike_recommendations(by_day: dict, total_tokens: int, active_days: int) -> list[str]:
    """Flag one day that dominates the month, since it skews averages and projections."""
    if active_days < 3 or total_tokens <= 0:
        return []
    day, tokens = max(by_day.items(), key=lambda item: item[1])
    if tokens / total_tokens < SPIKE_SHARE:
        return []
    return [
        f"Day {day} alone is {tokens / total_tokens * 100:.0f}% of this month's tokens, which skews the "
        "averages and projection. Check that session for a runaway loop or oversized context."
    ]


def build_alerts(percent_used: float, pace_status: str, budget_source: str = "user") -> list[dict]:
    alerts: list[dict] = []
    # A budget projected from the current month itself is circular (it reaches 100%
    # by construction at month end), so it can't honestly raise a threshold alert.
    for threshold in () if budget_source in NO_BASELINE_SOURCES else ALERT_THRESHOLDS:
        if percent_used >= threshold:
            alerts.append(
                {
                    "level": "critical" if threshold >= 90 else "warning",
                    "message": f"You have consumed {percent_used:.1f}% of the {'monthly budget' if budget_source == 'user' else 'estimated monthly baseline (not a real limit)'} (over the {threshold}% threshold).",
                }
            )
            break

    # No "will close the month over budget" alert: the budget is a cap, not a
    # projection — going over 100% at month end can't happen (2.5).
    if pace_status == "over_pace":
        alerts.append({"level": "warning", "message": "Daily burn is above the recommended pace."})

    return alerts


def build_budget_snapshot(
    summary: dict,
    budget_tokens: float,
    month_day: int | None = None,
    month: str | None = None,
    budget_source: str = "user",
    real_cost_today_usd: float | None = None,
    real_cost_month_usd: float | None = None,
) -> dict:
    total_usage = int(summary.get("total_tokens_used", 0) or 0)
    total_weighted = float(summary.get("total_weighted", 0) or 0)
    # `total_weighted` is already genuine USD (LiteLLM $/token rates, not a relative
    # weighting), so Anthropic's own reported cost is directly comparable, no unit
    # conversion needed. Trust the real figure and use the local one only for the
    # comparison caption — same philosophy as `apply_spend_calibration`, applied to
    # a different, admin-key-free data source (the local OTel receiver).
    estimated_total_weighted = total_weighted
    cost_basis = "estimated"
    if real_cost_month_usd is not None and real_cost_month_usd > 0:
        total_weighted = real_cost_month_usd
        cost_basis = "real_otel"
    budget = max(float(budget_tokens), 1e-9)
    month_label = month or summary.get("month")
    days_this_month = _days_in_month_for(month_label)
    current_day = min(max(month_day or 1, 1), days_this_month)
    days_remaining = max(days_this_month - current_day, 0)

    percent_used = round((total_weighted / budget) * 100, 1)
    projected_weighted = (total_weighted / current_day) * days_this_month
    projected_month_end = round((total_usage / current_day) * days_this_month)
    projected_percent = round((projected_weighted / budget) * 100, 1)
    calendar_average_tokens = round(total_usage / current_day) if current_day else 0
    percent_remaining = max(round(100 - percent_used, 1), 0.0)
    remaining_weighted = max(budget - total_weighted, 0.0)
    # Token allowance implied by the weighted headroom, so the UI can stay in tokens.
    tokens_per_weighted_unit = (total_usage / total_weighted) if total_weighted else 0
    remaining_tokens = round(remaining_weighted * tokens_per_weighted_unit)
    remaining_daily_allowance = round(remaining_tokens / days_remaining) if days_remaining else remaining_tokens
    daily_target_tokens = round((budget / days_this_month) * tokens_per_weighted_unit)

    expected_to_date = (budget / days_this_month) * current_day
    pace_delta_weighted = total_weighted - expected_to_date
    pace_status = _pace_status(pace_delta_weighted / expected_to_date if expected_to_date else 0.0)
    pace_delta = round(pace_delta_weighted * tokens_per_weighted_unit)

    by_day = {int(day): int(tokens) for day, tokens in (summary.get("by_day") or {}).items()}
    by_day_weighted = {int(day): float(value) for day, value in (summary.get("by_day_weighted") or {}).items()}
    today_tokens = by_day.get(current_day, 0)
    today_weighted = by_day_weighted.get(current_day, 0.0)
    estimated_today_weighted = today_weighted
    if real_cost_today_usd is not None and real_cost_today_usd > 0:
        today_weighted = real_cost_today_usd
    daily_weighted_target = budget / days_this_month
    # Token-based so it agrees with the token figures shown beside it
    # (`today_tokens` vs `recommended_daily_tokens`); cost-based when no token rate exists.
    if daily_target_tokens and not (real_cost_today_usd and real_cost_today_usd > 0):
        today_ratio = today_tokens / daily_target_tokens
    elif daily_weighted_target:
        today_ratio = today_weighted / daily_weighted_target
    else:
        today_ratio = 0.0
    today_percent_of_pace = round(today_ratio * 100, 1)
    today_status = _pace_status(today_ratio - 1) if (daily_target_tokens or daily_weighted_target) else "on_track"
    active_days = len([day for day, tokens in by_day.items() if tokens > 0])
    average_daily = round(total_usage / active_days) if active_days else 0

    if budget_source in NO_BASELINE_SOURCES:
        # No prior history to compare against: percent_used is self-referential, so
        # don't report over/near-budget (and keep pace_status consistent with it).
        status = "on_track"
        pace_status = "on_track"
        pace_delta = 0
    elif total_weighted >= budget:
        status = "over_budget"
    elif percent_used >= 90:
        status = "warning"
    elif percent_used >= 80:
        status = "watch"
    else:
        status = "on_track"

    by_model = summary.get("by_model", {}) or {}
    breakdown = build_model_breakdown(by_model, total_usage, summary.get("by_model_weighted"))

    by_project = summary.get("by_project", {}) or {}
    by_project_weighted = summary.get("by_project_weighted", {}) or {}
    project_weighted_total = sum(by_project_weighted.values())
    project_breakdown = [
        {
            "project": name,
            "tokens": int(tokens),
            "percent": round((float(by_project_weighted.get(name, 0.0)) / project_weighted_total) * 100, 1)
            if project_weighted_total
            else 0.0,
        }
        for name, tokens in sorted(
            by_project.items(),
            key=lambda item: by_project_weighted.get(item[0], 0.0),
            reverse=True,
        )
    ]

    by_month = summary.get("by_month", {}) or {}
    by_month_weighted = summary.get("by_month_weighted", {}) or {}
    previous_label = _previous_month(month_label)
    previous_total = int(by_month.get(previous_label, 0) or 0) if previous_label else 0
    previous_weighted = float(by_month_weighted.get(previous_label, 0.0) or 0.0) if previous_label else 0.0
    efficiency_delta_percent = (
        round(((projected_weighted - previous_weighted) / previous_weighted) * 100, 1) if previous_weighted else None
    )

    history = [
        {
            "month": key,
            "tokens": int(value),
            "percent_of_budget": round((float(by_month_weighted.get(key, 0.0)) / budget) * 100, 1),
        }
        for key, value in sorted(by_month.items())
        if not month_label or key <= month_label
    ][-6:]

    daily_series = [{"day": day, "tokens": by_day.get(day, 0)} for day in range(1, days_this_month + 1)]

    return {
        "project_name": summary.get("project_name"),
        "project_dir": summary.get("project_dir"),
        "month": month_label,
        "day_of_month": current_day,
        "days_in_month": days_this_month,
        "days_remaining": days_remaining,
        "total_tokens_used": total_usage,
        "total_weighted_cost": total_weighted,
        "budget_tokens": round(budget * tokens_per_weighted_unit),
        "budget_source": budget_source,
        "percent_used": percent_used,
        "percent_remaining": percent_remaining,
        "remaining_tokens": remaining_tokens,
        "status": status,
        "projected_month_end": projected_month_end,
        "projected_percent": projected_percent,
        "recommended_daily_tokens": daily_target_tokens,
        "average_daily_tokens": calendar_average_tokens,
        "remaining_daily_allowance": remaining_daily_allowance,
        "expected_to_date": expected_to_date,
        "pace_delta": pace_delta,
        "pace_status": pace_status,
        "today_tokens": today_tokens,
        "today_percent_of_pace": today_percent_of_pace,
        "today_status": today_status,
        "average_daily": average_daily,
        "active_days": active_days,
        "by_model": by_model,
        "model_breakdown": breakdown,
        "project_breakdown": project_breakdown,
        "project_count": summary.get("project_count", len(project_breakdown)),
        "scope": summary.get("scope", "project"),
        "daily_series": daily_series,
        "history": history,
        "previous_month": previous_label,
        "previous_month_tokens": previous_total,
        "efficiency_delta_percent": efficiency_delta_percent,
        "alerts": build_alerts(percent_used, pace_status, budget_source),
        "recommendations": _spike_recommendations(by_day, total_usage, active_days)
        + build_recommendations(breakdown, pace_status, percent_used),
        "covered_files": summary.get("covered_files", []),
        # Grounding against Anthropic's own reported cost (local OTel receiver, no
        # admin key needed). Only ever covers the current day/month — there is no
        # real figure for past months to substitute into `history`.
        "cost_basis": cost_basis,
        "estimated_total_weighted_cost": estimated_total_weighted,
        "estimated_today_weighted_cost": estimated_today_weighted,
        "real_cost_today_usd": real_cost_today_usd,
        "real_cost_month_usd": real_cost_month_usd,
        # 3.5: `budget`/`today_weighted` are already genuine USD post-3.4 (see the
        # `total_weighted_cost` comment above) — exposed under their own names so the
        # $-view tooltip doesn't have to reverse-engineer them out of `budget_tokens`
        # (which is deliberately converted back to a token count for the token view).
        "budget_usd": budget,
        "today_weighted_cost": today_weighted,
        "daily_target_usd": daily_weighted_target,
    }


ADMIN_ROLES = ("admin", "owner", "primary_owner")


def detect_plan(base_dir: str | Path) -> dict:
    """Read the local Claude profile. Only non-secret fields; the auth token is never read."""
    info = {
        "account_uuid": None,
        "organization_uuid": None,
        "email": None,
        "organization_name": None,
        "organization_type": None,
        "organization_role": None,
        "seat_tier": None,
        "billing_type": None,
        "extra_usage_enabled": None,
        "subscription_created_at": None,
        "rate_limit_tier": None,
        "budget_api": "unavailable",
        "can_self_provision_key": False,
    }

    # The profile lives next to the .claude directory, not inside it.
    candidates = [Path(base_dir).parent / ".claude.json", Path.home() / ".claude.json"]
    account: dict = {}
    for candidate in candidates:
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get("oauthAccount"), dict):
            account = payload["oauthAccount"]
            break

    if not account:
        return info

    info.update(
        {
            "account_uuid": account.get("accountUuid"),
            "organization_uuid": account.get("organizationUuid"),
            "email": account.get("emailAddress"),
            "organization_name": account.get("organizationName"),
            "organization_type": account.get("organizationType"),
            "organization_role": account.get("organizationRole"),
            "seat_tier": account.get("seatTier"),
            "billing_type": account.get("billingType"),
            "extra_usage_enabled": account.get("hasExtraUsageEnabled"),
            "subscription_created_at": account.get("subscriptionCreatedAt"),
            "rate_limit_tier": account.get("organizationRateLimitTier"),
        }
    )
    info["budget_api"] = accounts.resolve_account_profile(info["organization_type"])["budget_api"]
    info["can_self_provision_key"] = str(info["organization_role"] or "").lower() in ADMIN_ROLES
    return info


def _account_ledger_path() -> Path:
    return Path.home() / ".claude-budget-advisor" / "accounts.json"


def update_account_ledger(plan: dict, now: datetime | None = None, path: str | Path | None = None) -> list[dict]:
    """Record which account is signed in now and return every window it has been active.

    Each run compares the signed-in account with the last one seen. On a change the
    previous window is closed at the last moment it was observed and a new one opens
    now, so usage in the unobserved gap counts for neither account. Only an empty
    ledger opens an unbounded window, since nothing is known about earlier history.
    """
    account_id = plan.get("account_uuid")
    if not account_id:
        return []
    ledger_path = Path(path) if path else _account_ledger_path()
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()

    windows: list[dict] = []
    try:
        payload = json.loads(ledger_path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("windows"), list):
            windows = [w for w in payload["windows"] if isinstance(w, dict) and w.get("account_uuid")]
    except (OSError, json.JSONDecodeError):
        pass

    open_window = next((w for w in reversed(windows) if w.get("end") is None), None)
    if open_window and open_window["account_uuid"] == account_id:
        open_window["last_seen"] = stamp
    else:
        if open_window:
            open_window["end"] = open_window.get("last_seen") or open_window.get("start") or stamp
        windows.append(
            {
                "account_uuid": account_id,
                "email": plan.get("email"),
                "organization_type": plan.get("organization_type"),
                "start": stamp if windows else None,
                "end": None,
                "last_seen": stamp,
            }
        )

    try:
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = ledger_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps({"version": 1, "windows": windows}, indent=2), encoding="utf-8")
        temp_path.replace(ledger_path)
    except OSError:
        pass
    return windows


def resolve_account_windows(
    windows: list[dict], account_id: str | None, plan_start: str | None = None
) -> list[tuple[datetime | None, datetime | None]] | None:
    """Windows in which `account_id` was active, clipped to when its current plan began.

    Returns None (no scoping) when the account cannot be identified.
    """
    if not account_id:
        return None
    floor = _parse_timestamp(plan_start, use_utc=True)
    resolved: list[tuple[datetime | None, datetime | None]] = []
    for window in windows:
        if window.get("account_uuid") != account_id:
            continue
        start = _parse_timestamp(window.get("start"), use_utc=True)
        end = _parse_timestamp(window.get("end"), use_utc=True)
        if floor is not None and (start is None or start < floor):
            start = floor
        if start is not None and end is not None and end <= start:
            continue
        resolved.append((start, end))
    return resolved


def period_reset_at(month: str | None, period: str = "monthly") -> str | None:
    """The API has no member-level reset field, so derive it: 00:00 UTC on the 1st."""
    if (period or "monthly").lower() != "monthly" or not month:
        return None
    try:
        year_value, month_value = (int(part) for part in month.split("-"))
    except ValueError:
        return None
    year_value, month_value = (year_value + 1, 1) if month_value == 12 else (year_value, month_value + 1)
    return datetime(year_value, month_value, 1, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _as_minor_units(value):
    """The documented Admin API returns minor units as decimal strings, not numbers."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def parse_spend_limit(payload: dict, month: str | None = None) -> dict:
    """Normalise a spend-limit payload into minor units, without assuming USD or /100."""
    cap = payload.get("cap") if isinstance(payload.get("cap"), dict) else {}
    credits = cap.get("credits") if isinstance(cap.get("credits"), dict) else {}

    limit_minor = _as_minor_units(credits.get("amount_minor"))
    if limit_minor is None:
        limit_minor = _as_minor_units(payload.get("monthly_credit_limit"))
    # The documented Admin API names these differently to the internal endpoint.
    if limit_minor is None:
        limit_minor = _as_minor_units(payload.get("amount"))

    used_minor = _as_minor_units(payload.get("used_credits"))
    if used_minor is None:
        used_minor = _as_minor_units(payload.get("period_to_date_spend"))

    exponent = credits.get("exponent")
    if not isinstance(exponent, int):
        exponent = 2

    pooled = bool(payload.get("pooled_limit_enabled"))
    if pooled:
        pooled_limit = _as_minor_units(payload.get("effective_pooled_limit"))
        if pooled_limit is not None:
            limit_minor = pooled_limit
            pooled_used = _as_minor_units(payload.get("pooled_used_credits_minor_units"))
            if pooled_used is not None:
                used_minor = pooled_used

    used_value = used_minor if used_minor is not None else 0.0
    period = payload.get("period") or "monthly"

    resets_at = payload.get("pooled_period_resets_at") if pooled else None
    if not resets_at:
        resets_at = period_reset_at(month, period)

    return {
        # A null amount means unlimited, which is not the same as a zero budget.
        "available": limit_minor is not None and limit_minor > 0,
        "unlimited": limit_minor is None,
        "limit_minor": limit_minor,
        "used_minor": used_value,
        "exponent": exponent,
        "currency": payload.get("currency") or "USD",
        "period": period,
        "limit_type": payload.get("limit_type"),
        "pooled": pooled,
        "is_enabled": payload.get("is_enabled"),
        "disabled_reason": payload.get("disabled_reason"),
        "out_of_credits": payload.get("out_of_credits"),
        "used_basis": payload.get("used_credits_basis"),
        "account_uuid": payload.get("account_uuid"),
        "resets_at": resets_at,
        "percent_used": round((used_value / limit_minor) * 100, 1) if limit_minor else None,
    }


def apply_spend_calibration(snapshot: dict, spend: dict, origin: str = "file") -> dict:
    """Trust the API total and use local data only to apportion it."""
    if not spend.get("available") or not spend.get("limit_minor"):
        snapshot["budget_basis"] = "estimated"
        snapshot["spend_source"] = origin if origin in ("none", "estimated") else "estimated"
        snapshot["spend_limit"] = spend
        return snapshot

    scale = float(spend["exponent"] or 0)
    divisor = 10**scale if scale else 1
    limit_major = spend["limit_minor"] / divisor
    used_major = spend["used_minor"] / divisor

    local_total = float(snapshot.get("total_weighted_cost") or 0.0)
    calibration = (used_major / local_total) if local_total > 0 else None

    percent_used = round((used_major / limit_major) * 100, 1) if limit_major else 0.0
    day = max(int(snapshot.get("day_of_month") or 1), 1)
    days_in_month = int(snapshot.get("days_in_month") or 30)
    projected_percent = round((percent_used / day) * days_in_month, 1)

    snapshot.update(
        {
            # Mock data must never be presented as if it came from the account.
            "budget_basis": "mock" if origin == "mock" else "authoritative",
            "spend_source": origin,
            "percent_used": percent_used,
            "percent_remaining": round(max(100 - percent_used, 0), 1),
            "projected_percent": projected_percent,
            "calibration_factor": round(calibration, 4) if calibration else None,
            "spend_limit": spend,
        }
    )

    if percent_used >= 100:
        snapshot["status"] = "over_budget"
    elif percent_used >= 90:
        snapshot["status"] = "warning"
    elif percent_used >= 80:
        snapshot["status"] = "watch"
    else:
        snapshot["status"] = "on_track"

    expected_to_date = (100 / days_in_month) * day
    snapshot["pace_status"] = _pace_status((percent_used - expected_to_date) / expected_to_date if expected_to_date else 0.0)
    snapshot["alerts"] = build_alerts(percent_used, snapshot["pace_status"])

    if spend.get("disabled_reason"):
        snapshot["alerts"].insert(
            0, {"level": "critical", "message": f"Claude reports this account is blocked: {spend['disabled_reason']}."}
        )

    if origin == "mock":
        snapshot["alerts"].insert(
            0, {"level": "warning", "message": "Showing mock spend data. Real figures require an admin key."}
        )

    return snapshot


def load_spend_limit_payload(path: str | Path | None) -> dict | None:
    if not path:
        return None
    try:
        # utf-8-sig so a file saved from a browser or editor with a BOM still parses.
        payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(payload, dict) and isinstance(payload.get("data"), list) and payload["data"]:
        return payload["data"][0]
    return payload if isinstance(payload, dict) else None


SPEND_LIMITS_ENDPOINT = "https://api.anthropic.com/v1/organizations/spend_limits/effective"
ANTHROPIC_VERSION = "2023-06-01"

# Shape mirrors the live response. Identity fields are filled from the local profile
# at runtime so no personal data is shipped inside the package.
SPEND_MOCK_TEMPLATE = {
    "limit_type": "member",
    "seat_tier": None,
    "group_uuid": None,
    "is_enabled": True,
    "monthly_credit_limit": 20000,
    "pooled_limit_enabled": False,
    "pooled_monthly_credit_limit": None,
    "effective_pooled_limit": None,
    "pooled_used_credits_minor_units": None,
    "pooled_period_resets_at": None,
    "period": "monthly",
    "currency": "USD",
    "used_credits": 20009,
    "used_credits_basis": "post_discount",
    "disabled_reason": None,
    "out_of_credits": None,
    "discount_percent": None,
    "cap": {"money": None, "credits": {"amount_minor": 20000, "exponent": 2}},
}


def build_mock_spend_payload(plan: dict | None = None) -> dict:
    payload = json.loads(json.dumps(SPEND_MOCK_TEMPLATE))
    plan = plan or {}
    payload["account_uuid"] = plan.get("account_uuid")
    payload["organization_uuid"] = plan.get("organization_uuid")
    payload["account_email"] = plan.get("email")
    payload["seat_tier"] = plan.get("seat_tier")
    return payload


def fetch_spend_limit_api(admin_key: str, account_uuid: str | None, timeout: float = 10.0) -> dict | None:
    """Documented Admin API call. Inert until an admin key with read:spend_limits exists."""
    if not admin_key:
        return None

    import urllib.error
    import urllib.parse
    import urllib.request

    query = {"limit": "1"}
    if account_uuid:
        # Filtering server-side returns only this member instead of the whole org.
        query["user_ids[]"] = account_uuid

    url = f"{SPEND_LIMITS_ENDPOINT}?{urllib.parse.urlencode(query)}"
    request = urllib.request.Request(
        url,
        headers={
            "x-api-key": admin_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "accept": "application/json",
            "user-agent": "claude-budget-advisor/0.1",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

    if isinstance(payload, dict) and isinstance(payload.get("data"), list) and payload["data"]:
        return payload["data"][0]
    return payload if isinstance(payload, dict) else None


def resolve_spend_limit(
    source: str,
    plan: dict,
    month: str | None,
    spend_file: str | Path | None = None,
    admin_key: str | None = None,
) -> tuple[dict, str]:
    """Pick the spend-limit source. Supplying an admin key is the only switch needed."""
    if source == "none":
        return {"available": False}, "none"

    if spend_file and source in ("auto", "file"):
        payload = load_spend_limit_payload(spend_file)
        if payload:
            return parse_spend_limit(payload, month), "file"

    if admin_key and source in ("auto", "api"):
        payload = fetch_spend_limit_api(admin_key, plan.get("account_uuid"))
        if payload:
            return parse_spend_limit(payload, month), "api"

    if source == "mock":
        return parse_spend_limit(build_mock_spend_payload(plan), month), "mock"

    return {"available": False}, "estimated"


def main() -> None:
    # Timestamps are stored in UTC and shown in local time: --month/--day default to
    # the local clock, matching --day-grouping's own default (local), below.
    today = datetime.now().astimezone()
    parser = argparse.ArgumentParser(description="Track Claude Code token pacing across your projects for the current month.")
    parser.add_argument("--base-dir", default=None, help="Claude data directory. Auto-resolved from CLAUDE_CONFIG_DIR, the home directory, or the CLI on PATH.")
    parser.add_argument("--scope", choices=("all", "project"), default="all", help="Aggregate every project (default) or only one project.")
    parser.add_argument("--cwd", "--workspace", dest="workspace", default=None, help="Workspace folder path, used to pick the project when scope is 'project'.")
    parser.add_argument("--project", "--project-name", "--repo-name", dest="project", default=None, help="Optional project or repo name under <claude>/projects.")
    parser.add_argument("--month", default=today.strftime("%Y-%m"), help="Month to inspect as YYYY-MM. Defaults to the current month in the --day-grouping basis.")
    parser.add_argument("--budget", type=int, default=0, help="Monthly token budget. When omitted or 0, it is inferred from your own usage history.")
    parser.add_argument(
        "--budget-usd",
        type=float,
        default=0.0,
        help="Monthly budget in USD, taken literally with no token-mix conversion. Takes priority over --budget when both are given.",
    )
    parser.add_argument("--day", type=int, default=today.day, help="Current day of the month. Defaults to today in the --day-grouping basis.")
    parser.add_argument("--day-grouping", choices=("utc", "local"), default="local", help="Bucket usage by day/month in UTC to match claude.ai's usage page, or in local time to match your own clock. Default: local.")
    parser.add_argument("--pricing-file", default=None, help="Optional JSON file of per-token model rates, overriding the published feed.")
    parser.add_argument("--offline", action="store_true", help="Never fetch pricing over the network; use the local cache or built-in fallback.")
    parser.add_argument("--spend-limit-file", default=None, help="JSON payload from the spend limits endpoint. When present, its totals override the local estimate.")
    parser.add_argument("--spend-source", choices=("auto", "mock", "file", "api", "none"), default="auto", help="Where spend figures come from. 'auto' uses the API when an admin key is set, otherwise falls back to the local estimate.")
    parser.add_argument("--since", default=None, help="ISO-8601 instant (e.g. 2026-09-25T20:01:00Z). Transcript entries before it are ignored, so local figures cover the same window as OTel telemetry.")
    parser.add_argument("--real-cost-today-usd", type=float, default=None, help="Anthropic's own reported cost for today (local OTel receiver). Replaces the local estimate for today's pace math when given.")
    parser.add_argument("--real-cost-month-usd", type=float, default=None, help="Anthropic's own reported cost for this month so far. Replaces the local estimate for budget math when given.")
    parser.add_argument("--all-accounts", action="store_true", help="Count usage from every account that has used this machine instead of only the signed-in one.")
    parser.add_argument("--account-ledger", default=None, help="Override the path of the account ledger (default: ~/.claude-budget-advisor/accounts.json).")
    args = parser.parse_args()
    global _SINCE, _ACCOUNT_WINDOWS
    _SINCE = _parse_timestamp(args.since, use_utc=True) if args.since else None
    use_utc = args.day_grouping == "utc"

    claude_root = resolve_claude_root(args.base_dir)

    # Budget and pace are per account and plan: only usage recorded while the signed-in
    # account was active is counted, so switching logins never mixes their figures.
    plan_info = detect_plan(claude_root)
    account_windows = None
    if not args.all_accounts:
        ledger = update_account_ledger(plan_info, path=args.account_ledger)
        account_windows = resolve_account_windows(
            ledger, plan_info.get("account_uuid"), plan_info.get("subscription_created_at")
        )
    _ACCOUNT_WINDOWS = account_windows

    pricing, pricing_source = load_pricing(allow_network=not args.offline, pricing_file=args.pricing_file)

    if args.scope == "project" or args.project:
        project_name = resolve_project_name(claude_root, args.project)
        summary = analyze_project_usage(
            claude_root, project_name, args.month, workspace_path=args.workspace, pricing=pricing, use_utc=use_utc
        )
    else:
        summary = analyze_all_projects(claude_root, args.month, pricing=pricing, use_utc=use_utc)

    summary["claude_root"] = str(claude_root)

    budget, budget_source = resolve_budget(summary, args.budget, args.budget_usd, args.month, args.day)

    snapshot = build_budget_snapshot(
        summary,
        budget,
        month_day=args.day,
        month=args.month,
        budget_source=budget_source,
        real_cost_today_usd=args.real_cost_today_usd,
        real_cost_month_usd=args.real_cost_month_usd,
    )
    snapshot["claude_root"] = str(claude_root)
    snapshot["pricing_source"] = pricing_source
    snapshot["priced_models"] = len(pricing)
    snapshot["unpriced_models"] = summary.get("unpriced_models", [])
    snapshot["plan"] = plan_info
    snapshot["account_scope"] = {
        "scoped": account_windows is not None,
        "account_uuid": plan_info.get("account_uuid"),
        "email": plan_info.get("email"),
        "windows": [
            {"start": start.isoformat() if start else None, "end": end.isoformat() if end else None}
            for start, end in (account_windows or [])
        ],
    }

    # Only an account profile that actually declares the Admin spend-limit API as its
    # source attempts it — e.g. Enterprise is tagged "rate_limit" instead (see
    # accounts/enterprise.py), so a managed seat with no admin key never makes this
    # network call or carries a stale "estimated" dollar figure the UI won't show.
    if accounts.wants_spend_limit_api(plan_info):
        # The key is read from the environment so it never has to be passed on the command line.
        admin_key = os.environ.get("ANTHROPIC_ADMIN_KEY", "").strip()
        spend, origin = resolve_spend_limit(
            args.spend_source, plan_info, args.month, spend_file=args.spend_limit_file, admin_key=admin_key
        )
    else:
        spend, origin = {"available": False}, "none"
    snapshot = apply_spend_calibration(snapshot, spend, origin)

    print(json.dumps(snapshot, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
