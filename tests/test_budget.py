import json
from datetime import datetime, timezone
from pathlib import Path

import claude_budget_advisor
from claude_budget_advisor import (
    analyze_all_projects,
    analyze_project_usage,
    apply_spend_calibration,
    build_budget_snapshot,
    build_recommendations,
    cost_units,
    derive_budget,
    encode_workspace_path,
    GENERAL_USAGE_TIPS,
    load_pricing,
    parse_spend_limit,
    period_reset_at,
    resolve_account_windows,
    resolve_budget,
    resolve_model_rates,
    resolve_spend_limit,
    update_account_ledger,
)


def _entry(model: str, timestamp: str, tokens: int, message_id: str) -> str:
    return json.dumps(
        {
            "type": "assistant",
            "timestamp": timestamp,
            "message": {
                "id": message_id,
                "model": model,
                "usage": {
                    "input_tokens": tokens,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            },
        }
    )


def test_analyze_project_usage_buckets_by_entry_timestamp(tmp_path: Path):
    project_root = tmp_path / "projects" / "demo-project"
    project_root.mkdir(parents=True)
    other_project = tmp_path / "projects" / "other-project"
    other_project.mkdir(parents=True)

    (project_root / "session_a.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-09-15T12:00:00Z", 2000, "m1") + "\n"
        + _entry("claude-sonnet-4", "2026-09-16T12:00:00Z", 850, "m2") + "\n"
        + _entry("claude-sonnet-4", "2026-08-10T12:00:00Z", 18000, "m3") + "\n",
        encoding="utf-8",
    )
    (other_project / "ignored.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-09-15T12:00:00Z", 99999, "m4") + "\n",
        encoding="utf-8",
    )

    summary = analyze_project_usage(tmp_path, "demo-project", "2026-09")

    assert summary["total_tokens_used"] == 2850
    assert summary["by_model"]["claude-sonnet-4"] == 2850
    assert summary["project_name"] == "demo-project"
    assert summary["by_month"]["2026-08"] == 18000
    assert not any("other-project" in path for path in summary["covered_files"])


def test_parse_timestamp_use_utc_keeps_the_utc_calendar_date(tmp_path: Path):
    # A private helper, but the only place that owns the UTC-vs-local decision (1.2) —
    # tested directly so this doesn't depend on the test machine's own timezone offset.
    from claude_budget_advisor import _parse_timestamp

    stamp = _parse_timestamp("2026-09-15T23:30:00Z", use_utc=True)
    assert stamp.day == 15
    assert stamp.utcoffset().total_seconds() == 0

    # Default (no use_utc) keeps the pre-1.2 behavior: converted to local time.
    local_stamp = _parse_timestamp("2026-09-15T23:30:00Z")
    assert local_stamp.tzinfo is not None


def test_analyze_project_usage_use_utc_buckets_by_the_utc_calendar_day(tmp_path: Path):
    # 23:30 UTC on the 15th: in any timezone west of UTC (a large share of real
    # users, including this project's own GMT-6 reference case) this is still the
    # 15th locally too — but deliberately close enough to midnight that a naive
    # "just use local time" implementation bucketing by UTC-plus-offset arithmetic
    # would be the first thing to get wrong, unlike the mid-day timestamps every
    # other test in this file uses specifically to dodge this ambiguity.
    project_root = tmp_path / "projects" / "demo-project"
    project_root.mkdir(parents=True)
    (project_root / "session.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-09-15T23:30:00Z", 1000, "m1") + "\n",
        encoding="utf-8",
    )

    summary = analyze_project_usage(tmp_path, "demo-project", "2026-09", use_utc=True)

    assert summary["by_day"]["15"] == 1000
    assert summary["by_month"]["2026-09"] == 1000


def test_analyze_project_usage_deduplicates_repeated_message_ids(tmp_path: Path):
    project_root = tmp_path / "projects" / "demo-project"
    project_root.mkdir(parents=True)
    (project_root / "a.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-09-15T12:00:00Z", 500, "dup") + "\n",
        encoding="utf-8",
    )
    (project_root / "b.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-09-15T12:00:00Z", 500, "dup") + "\n",
        encoding="utf-8",
    )

    summary = analyze_project_usage(tmp_path, "demo-project", "2026-09")

    assert summary["total_tokens_used"] == 500


def test_workspace_path_resolves_flattened_claude_folder(tmp_path: Path):
    workspace = r"C:\Users\Someone\Documents\Talent App\talent-app-back"
    encoded = encode_workspace_path(workspace)
    assert encoded == "C--Users-Someone-Documents-Talent-App-talent-app-back"

    project_root = tmp_path / "projects" / encoded
    project_root.mkdir(parents=True)
    (project_root / "session.jsonl").write_text(
        _entry("claude-opus-4", "2026-09-15T12:00:00Z", 1234, "m1") + "\n",
        encoding="utf-8",
    )

    summary = analyze_project_usage(tmp_path, None, "2026-09", workspace_path=workspace)

    assert summary["total_tokens_used"] == 1234
    assert summary["project_name"] == "talent-app-back"


def test_analyze_all_projects_aggregates_and_splits_by_project(tmp_path: Path):
    alpha = tmp_path / "projects" / "c--repos-alpha"
    beta = tmp_path / "projects" / "c--repos-beta"
    alpha.mkdir(parents=True)
    beta.mkdir(parents=True)

    (alpha / "s.jsonl").write_text(
        json.dumps(
            {
                "timestamp": "2026-09-15T12:00:00Z",
                "cwd": r"C:\repos\alpha",
                "message": {"id": "a1", "model": "claude-opus-4", "usage": {"input_tokens": 300}},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (beta / "s.jsonl").write_text(
        json.dumps(
            {
                "timestamp": "2026-09-15T12:00:00Z",
                "cwd": r"C:\repos\beta",
                "message": {"id": "b1", "model": "claude-haiku-4", "usage": {"input_tokens": 100}},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    summary = analyze_all_projects(tmp_path, "2026-09")

    assert summary["total_tokens_used"] == 400
    assert summary["project_count"] == 2
    assert summary["by_project"] == {"alpha": 300, "beta": 100}

    snapshot = build_budget_snapshot(summary, 1000, month_day=15, month="2026-09")
    # Alpha used Opus, so its share of budget impact exceeds its share of tokens.
    assert snapshot["project_breakdown"][0]["project"] == "alpha"
    assert snapshot["project_breakdown"][0]["percent"] > 75.0


SPEND_PAYLOAD = {
    "organization_uuid": "d4b8113b-7493-4bab-96fb-4ef1d0dd7f73",
    "limit_type": "member",
    "account_uuid": "d96b8b00-b533-4508-b709-ec02d5ced5f3",
    "is_enabled": True,
    "monthly_credit_limit": 20000,
    "pooled_limit_enabled": False,
    "period": "monthly",
    "currency": "USD",
    "used_credits": 20009,
    "used_credits_basis": "post_discount",
    "disabled_reason": None,
    "pooled_period_resets_at": None,
    "cap": {"money": None, "credits": {"amount_minor": 20000, "exponent": 2}},
}


PLAN = {
    "account_uuid": "d96b8b00-b533-4508-b709-ec02d5ced5f3",
    "organization_uuid": "d4b8113b-7493-4bab-96fb-4ef1d0dd7f73",
    "email": "someone@example.com",
    "seat_tier": "enterprise_usage_based",
}


def test_mock_source_matches_live_payload_shape_and_totals():
    spend, origin = resolve_spend_limit("mock", PLAN, "2026-09")

    assert origin == "mock"
    assert spend["limit_minor"] == 20000
    assert spend["used_minor"] == 20009
    assert spend["exponent"] == 2
    assert spend["percent_used"] == 100.0
    assert spend["resets_at"] == "2026-10-01T00:00:00Z"
    assert spend["account_uuid"] == PLAN["account_uuid"]


def test_mock_is_labelled_and_never_reported_as_authoritative():
    spend, origin = resolve_spend_limit("mock", PLAN, "2026-09")
    snapshot = apply_spend_calibration(
        {"day_of_month": 17, "days_in_month": 30, "total_weighted_cost": 133.24}, spend, origin
    )

    assert snapshot["budget_basis"] == "mock"
    assert snapshot["spend_source"] == "mock"
    assert any("mock" in alert["message"].lower() for alert in snapshot["alerts"])


def test_auto_source_stays_estimated_without_key_or_file():
    spend, origin = resolve_spend_limit("auto", PLAN, "2026-09")

    assert origin == "estimated"
    assert spend["available"] is False


def test_auto_source_prefers_supplied_file(tmp_path: Path):
    payload_file = tmp_path / "spend.json"
    payload_file.write_text(json.dumps(SPEND_PAYLOAD), encoding="utf-8")

    spend, origin = resolve_spend_limit("auto", PLAN, "2026-09", spend_file=payload_file)

    assert origin == "file"
    assert spend["used_minor"] == 20009


def test_none_source_disables_lookup(tmp_path: Path):
    payload_file = tmp_path / "spend.json"
    payload_file.write_text(json.dumps(SPEND_PAYLOAD), encoding="utf-8")

    _, origin = resolve_spend_limit("none", PLAN, "2026-09", spend_file=payload_file)

    assert origin == "none"


def test_parse_spend_limit_uses_exponent_and_derives_reset():
    spend = parse_spend_limit(SPEND_PAYLOAD, "2026-09")

    assert spend["available"] is True
    assert spend["limit_minor"] == 20000
    assert spend["used_minor"] == 20009
    assert spend["exponent"] == 2
    assert spend["currency"] == "USD"
    assert spend["limit_type"] == "member"
    assert spend["pooled"] is False
    # No member-level reset field exists, so it is derived: 00:00 UTC on the 1st.
    assert spend["resets_at"] == "2026-10-01T00:00:00Z"


def test_parse_spend_limit_reads_documented_admin_api_field_names():
    spend = parse_spend_limit(
        {"amount": "50000", "period_to_date_spend": "31402.5", "currency": "USD", "period": "monthly"},
        "2026-09",
    )

    assert spend["limit_minor"] == 50000.0
    assert spend["used_minor"] == 31402.5


def test_period_reset_at_rolls_over_year_end():
    assert period_reset_at("2026-12") == "2027-01-01T00:00:00Z"
    assert period_reset_at("2026-09", period="weekly") is None


def test_calibration_overrides_estimate_with_authoritative_total():
    snapshot = {
        "day_of_month": 17,
        "days_in_month": 30,
        "total_weighted_cost": 133.24,
        "percent_used": 162.0,
        "status": "over_budget",
    }

    result = apply_spend_calibration(snapshot, parse_spend_limit(SPEND_PAYLOAD, "2026-09"))

    assert result["budget_basis"] == "authoritative"
    # 200.09 of 200.00 -> just past the cap, not the 162% the local estimate claimed.
    assert result["percent_used"] == 100.0
    assert result["status"] == "over_budget"
    # Local estimate ran ~33% low, so the factor corrects it upward.
    assert result["calibration_factor"] == round(200.09 / 133.24, 4)


def test_calibration_is_inert_without_api_data():
    snapshot = {"day_of_month": 17, "days_in_month": 30, "total_weighted_cost": 133.24, "percent_used": 162.0}

    result = apply_spend_calibration(snapshot, {"available": False})

    assert result["budget_basis"] == "estimated"
    assert result["percent_used"] == 162.0


def test_derive_budget_uses_recent_completed_months():
    summary = {"by_month_weighted": {"2026-07": 180.0, "2026-08": 228.0, "2026-09": 99.0}}

    budget, source = derive_budget(summary, "2026-09")

    assert source == "auto_history"
    assert budget == 228.0


def test_derive_budget_ignores_partial_onboarding_months():
    summary = {"by_month_weighted": {"2026-07": 3.6, "2026-08": 280.0, "2026-09": 464.0}}

    budget, _ = derive_budget(summary, "2026-09")

    assert budget == 280.0


def test_derive_budget_projection_uses_the_given_day_not_datetime_now():
    # No completed prior months, so this hits the auto_projected branch, which
    # used to always read datetime.now().day — a mismatch with UTC-bucketed
    # `total_weighted` (1.2) would have skewed the projection near a UTC/local
    # day boundary. Passing `day` explicitly removes that dependency entirely.
    summary = {"total_weighted": 100.0}

    budget_day_10, source = derive_budget(summary, "2026-09", day=10)
    budget_day_20, _ = derive_budget(summary, "2026-09", day=20)

    assert source == "auto_projected"
    # Same total spread over fewer elapsed days projects to a *larger* full-month budget.
    assert budget_day_10 > budget_day_20


def test_resolve_budget_usd_is_taken_literally_with_no_token_mix_conversion():
    # 1000 total tokens costing $5 weighted (a 1:200 ratio) would turn a token
    # budget into a tiny weighted figure — budget_usd must bypass that entirely.
    summary = {"total_tokens_used": 1000, "total_weighted": 5.0}

    budget, source = resolve_budget(summary, 0, 250.0, "2026-09", day=15)

    assert budget == 250.0
    assert source == "user"


def test_resolve_budget_usd_takes_priority_over_token_budget():
    summary = {"total_tokens_used": 1000, "total_weighted": 5.0}

    budget, source = resolve_budget(summary, 10_000, 250.0, "2026-09", day=15)

    assert budget == 250.0
    assert source == "user"


def test_resolve_budget_falls_back_to_token_budget_when_no_usd_given():
    summary = {"total_tokens_used": 1000, "total_weighted": 5.0}

    budget, source = resolve_budget(summary, 10_000, 0, "2026-09", day=15)

    assert source == "user"
    assert budget == 50.0  # 10,000 tokens * (5.0 / 1000) ratio


def test_resolve_budget_falls_back_to_derive_budget_when_nothing_supplied():
    summary = {"by_month_weighted": {"2026-08": 228.0}}

    budget, source = resolve_budget(summary, 0, 0, "2026-09", day=15)

    assert source == "auto_history"
    assert budget == 228.0


def test_projected_budget_never_reports_over_budget_or_threshold_alerts():
    # A budget projected from the current month reaches 100% by construction at
    # month end; that circular figure must not raise over_budget or a critical alert.
    summary = {"total_tokens_used": 1000, "total_weighted": 100.0, "by_day": {30: 1000}, "by_day_weighted": {30: 100.0}}

    snapshot = build_budget_snapshot(summary, 100.0, month_day=30, month="2026-09", budget_source="auto_projected")

    assert snapshot["percent_used"] == 100.0
    assert snapshot["status"] == "on_track"
    assert snapshot["pace_status"] == "on_track"
    assert snapshot["alerts"] == []


def test_cache_reads_cost_far_less_than_fresh_input():
    pricing = {"claude-sonnet-5": {"input": 3e-6, "output": 15e-6, "cache_read": 3e-7, "cache_write": 3.75e-6}}
    fresh = cost_units("claude-sonnet-5", {"input": 1_000_000}, pricing)
    cached = cost_units("claude-sonnet-5", {"cache_read": 1_000_000}, pricing)

    assert fresh == 3.0
    assert cached == 0.3
    assert fresh > cached * 5


def test_resolve_model_rates_prefers_feed_and_flags_fallback():
    pricing = {"claude-sonnet-5": {"input": 3e-6, "output": 15e-6, "cache_read": 3e-7, "cache_write": 3.75e-6}}

    rates, exact = resolve_model_rates("claude-sonnet-5", pricing)
    assert exact is True
    assert rates["input"] == 3e-6

    _, exact_unknown = resolve_model_rates("claude-sonnet-99-preview", {})
    assert exact_unknown is False


def test_load_pricing_uses_explicit_file(tmp_path: Path):
    pricing_file = tmp_path / "prices.json"
    pricing_file.write_text(
        json.dumps(
            {
                "claude-opus-9": {
                    "litellm_provider": "anthropic",
                    "input_cost_per_token": 1e-05,
                    "output_cost_per_token": 5e-05,
                    "cache_read_input_token_cost": 1e-06,
                    "cache_creation_input_token_cost": 1.2e-05,
                }
            }
        ),
        encoding="utf-8",
    )

    pricing, source = load_pricing(allow_network=False, pricing_file=pricing_file)

    assert source == "file"
    assert pricing["claude-opus-9"]["input"] == 1e-05


def test_percent_used_reflects_cost_weight_not_raw_tokens():
    cheap = {
        "total_tokens_used": 1_000_000,
        "total_weighted": cost_units("claude-haiku-4", {"cache_read": 1_000_000}),
        "by_day": {"15": 1_000_000},
        "by_day_weighted": {"15": cost_units("claude-haiku-4", {"cache_read": 1_000_000})},
    }
    expensive = {
        "total_tokens_used": 1_000_000,
        "total_weighted": cost_units("claude-opus-4", {"output": 1_000_000}),
        "by_day": {"15": 1_000_000},
        "by_day_weighted": {"15": cost_units("claude-opus-4", {"output": 1_000_000})},
    }

    cheap_snapshot = build_budget_snapshot(cheap, 10.0, month_day=15, month="2026-09")
    expensive_snapshot = build_budget_snapshot(expensive, 10.0, month_day=15, month="2026-09")

    # Identical token volume, wildly different budget impact.
    assert cheap_snapshot["total_tokens_used"] == expensive_snapshot["total_tokens_used"]
    assert expensive_snapshot["percent_used"] > cheap_snapshot["percent_used"] * 50


def test_build_budget_snapshot_reports_pace_projection_and_today():
    summary = {
        "total_tokens_used": 260000,
        "total_weighted": 260.0,
        "by_model": {"claude-opus-4": 200000, "claude-haiku-4": 60000},
        "by_model_weighted": {"claude-opus-4": 240.0, "claude-haiku-4": 20.0},
        "by_day": {"15": 40000},
        "by_day_weighted": {"15": 40.0},
        "by_month": {"2026-08": 400000},
        "by_month_weighted": {"2026-08": 400.0},
        "covered_files": [],
    }

    snapshot = build_budget_snapshot(summary, 500.0, month_day=15, month="2026-09")

    assert snapshot["percent_used"] == 52.0
    assert snapshot["projected_percent"] == 104.0
    assert snapshot["status"] == "on_track"
    assert snapshot["pace_status"] == "on_track"
    assert snapshot["today_tokens"] == 40000
    assert snapshot["today_status"] == "over_pace"
    assert snapshot["days_remaining"] == 15
    assert snapshot["model_breakdown"][0]["model"] == "claude-opus-4"
    assert snapshot["model_breakdown"][0]["tier"] == "premium"
    # A >100% projection alone raises no alert (2.5) — pace is on_track and
    # percent_used (52%) is under every threshold, so there is nothing to flag.
    assert snapshot["alerts"] == []
    # Regression guard: no real-cost args given, so grounding is a no-op.
    assert snapshot["cost_basis"] == "estimated"
    assert snapshot["real_cost_today_usd"] is None
    assert snapshot["real_cost_month_usd"] is None


def _pace_summary():
    return {
        "total_tokens_used": 260000,
        "total_weighted": 260.0,
        "by_model": {"claude-opus-4": 200000, "claude-haiku-4": 60000},
        "by_model_weighted": {"claude-opus-4": 240.0, "claude-haiku-4": 20.0},
        "by_day": {"15": 40000},
        "by_day_weighted": {"15": 40.0},
        "by_month": {"2026-08": 400000},
        "by_month_weighted": {"2026-08": 400.0},
        "covered_files": [],
    }


def test_real_cost_month_grounds_percent_used_and_status():
    snapshot = build_budget_snapshot(
        _pace_summary(), 500.0, month_day=15, month="2026-09", real_cost_month_usd=480.0
    )

    assert snapshot["cost_basis"] == "real_otel"
    assert snapshot["real_cost_month_usd"] == 480.0
    # The local estimate is kept around for the dashboard's comparison caption.
    assert snapshot["estimated_total_weighted_cost"] == 260.0
    # percent_used now reflects the real figure (480 / 500), not the local one (260 / 500).
    assert snapshot["percent_used"] == 96.0
    assert snapshot["status"] == "warning"


def test_real_cost_today_only_affects_today_pace_not_month_percent():
    baseline = build_budget_snapshot(_pace_summary(), 500.0, month_day=15, month="2026-09")
    assert baseline["today_status"] == "over_pace"

    snapshot = build_budget_snapshot(
        _pace_summary(), 500.0, month_day=15, month="2026-09", real_cost_today_usd=5.0
    )

    assert snapshot["estimated_today_weighted_cost"] == 40.0
    # 5.0 is well under the ~16.67/day target, flipping the pace read the local
    # estimate (40.0, over pace) gave.
    assert snapshot["today_status"] == "under_pace"
    # Only today's fields moved — the month-level total is untouched because
    # real_cost_month_usd was not given.
    assert snapshot["percent_used"] == baseline["percent_used"]
    assert snapshot["cost_basis"] == "estimated"


def test_real_cost_zero_or_missing_is_never_substituted():
    zero = build_budget_snapshot(
        _pace_summary(), 500.0, month_day=15, month="2026-09", real_cost_month_usd=0.0, real_cost_today_usd=0.0
    )
    none = build_budget_snapshot(_pace_summary(), 500.0, month_day=15, month="2026-09")

    assert zero["cost_basis"] == "estimated"
    assert zero["percent_used"] == none["percent_used"]
    assert zero["today_status"] == none["today_status"]


# --- Recommendations (2.6) ----------------------------------------------------

def test_general_usage_tips_always_appear_alongside_personalized_ones():
    breakdown = [{"model": "claude-opus-4", "tier": "premium", "tokens": 100, "weighted_cost": 100.0}]
    recommendations = build_recommendations(breakdown, pace_status="on_track", percent_used=50.0)

    for tip in GENERAL_USAGE_TIPS:
        assert tip in recommendations
    # The personalized premium-share tip still comes first.
    assert "Premium models drive" in recommendations[0]


def test_general_usage_tips_appear_even_with_no_personalized_recommendation():
    recommendations = build_recommendations([], pace_status="on_track", percent_used=50.0)

    assert recommendations[0] == "Usage looks balanced. Keep the current model mix."
    for tip in GENERAL_USAGE_TIPS:
        assert tip in recommendations


def test_general_usage_tips_do_not_restate_model_choice():
    # "Pick the right model" is deliberately not one of the general tips — the
    # premium/economy recommendations above already cover it with real numbers.
    assert not any("pick the right model" in tip.lower() for tip in GENERAL_USAGE_TIPS)


def _at(day: int, hour: int = 12) -> datetime:
    return datetime(2026, 9, day, hour, tzinfo=timezone.utc)


def test_ledger_switching_accounts_closes_the_previous_window(tmp_path: Path):
    ledger = tmp_path / "accounts.json"
    update_account_ledger({"account_uuid": "A"}, now=_at(1), path=ledger)
    update_account_ledger({"account_uuid": "A"}, now=_at(5), path=ledger)
    windows = update_account_ledger({"account_uuid": "B"}, now=_at(9), path=ledger)

    assert [w["account_uuid"] for w in windows] == ["A", "B"]
    assert windows[0]["start"] is None  # empty ledger: earlier history is unknown
    assert windows[0]["end"] == _at(5).isoformat()  # closed when last observed, not at the switch
    assert windows[1]["start"] == _at(9).isoformat() and windows[1]["end"] is None


def test_ledger_returning_to_an_account_adds_a_second_window(tmp_path: Path):
    ledger = tmp_path / "accounts.json"
    for account, day in (("A", 1), ("B", 5), ("B", 7), ("A", 9)):
        windows = update_account_ledger({"account_uuid": account}, now=_at(day), path=ledger)

    assert [w["account_uuid"] for w in windows] == ["A", "B", "A"]
    assert len(resolve_account_windows(windows, "A")) == 2
    assert len(resolve_account_windows(windows, "B")) == 1


def test_ledger_ignores_an_unidentified_account(tmp_path: Path):
    ledger = tmp_path / "accounts.json"
    assert update_account_ledger({"account_uuid": None}, path=ledger) == []
    assert not ledger.exists()
    assert resolve_account_windows([], None) is None


def test_plan_start_clips_windows_to_the_current_subscription():
    windows = [{"account_uuid": "A", "start": None, "end": None}]
    resolved = resolve_account_windows(windows, "A", plan_start="2026-09-23T20:28:07Z")
    assert resolved == [(_at(23, 20).replace(minute=28, second=7), None)]

    closed_before_plan = [{"account_uuid": "A", "start": None, "end": _at(10).isoformat()}]
    assert resolve_account_windows(closed_before_plan, "A", plan_start="2026-09-23T00:00:00Z") == []


def test_usage_counts_only_the_active_account_windows(tmp_path: Path, monkeypatch):
    project = tmp_path / "projects" / "demo"
    project.mkdir(parents=True)
    (project / "s.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-09-02T12:00:00Z", 1000, "a1") + "\n"  # account A
        + _entry("claude-sonnet-4", "2026-09-12T12:00:00Z", 2000, "b1") + "\n"  # account B
        + _entry("claude-sonnet-4", "2026-09-20T12:00:00Z", 4000, "a2") + "\n",  # account A again
        encoding="utf-8",
    )
    windows = [
        {"account_uuid": "A", "start": None, "end": _at(5).isoformat()},
        {"account_uuid": "B", "start": _at(10).isoformat(), "end": _at(15).isoformat()},
        {"account_uuid": "A", "start": _at(18).isoformat(), "end": None},
    ]

    monkeypatch.setattr(claude_budget_advisor, "_ACCOUNT_WINDOWS", resolve_account_windows(windows, "A"))
    assert analyze_all_projects(tmp_path, "2026-09")["total_tokens_used"] == 5000

    monkeypatch.setattr(claude_budget_advisor, "_ACCOUNT_WINDOWS", resolve_account_windows(windows, "B"))
    assert analyze_all_projects(tmp_path, "2026-09")["total_tokens_used"] == 2000

    monkeypatch.setattr(claude_budget_advisor, "_ACCOUNT_WINDOWS", None)
    assert analyze_all_projects(tmp_path, "2026-09")["total_tokens_used"] == 7000


def test_budget_history_is_built_only_from_the_active_account(tmp_path: Path, monkeypatch):
    project = tmp_path / "projects" / "demo"
    project.mkdir(parents=True)
    (project / "s.jsonl").write_text(
        _entry("claude-sonnet-4", "2026-08-10T12:00:00Z", 900000, "old") + "\n"  # other account
        + _entry("claude-sonnet-4", "2026-09-20T12:00:00Z", 1000, "new") + "\n",
        encoding="utf-8",
    )
    windows = [{"account_uuid": "B", "start": _at(1).isoformat(), "end": None}]
    monkeypatch.setattr(claude_budget_advisor, "_ACCOUNT_WINDOWS", resolve_account_windows(windows, "B"))

    summary = analyze_all_projects(tmp_path, "2026-09")
    _, source = derive_budget(summary, "2026-09", day=20)

    assert "2026-08" not in summary["by_month"]
    assert source != "auto_history"


def test_derive_budget_ignores_future_months():
    summary = {"by_month_weighted": {"2026-10": 4.0}, "total_weighted": 100.0}
    budget, source = derive_budget(summary, "2026-09", day=10)
    assert source == "auto_projected"
    assert budget == 300.0
