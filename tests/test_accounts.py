from accounts import resolve_account_profile, wants_spend_limit_api


def test_resolve_account_profile_pro_and_max_are_unavailable():
    assert resolve_account_profile("claude_pro")["budget_api"] == "unavailable"
    assert resolve_account_profile("claude_max")["budget_api"] == "unavailable"


def test_resolve_account_profile_enterprise_is_rate_limit_not_spend_limits():
    # Enterprise used to map to "spend_limits" (Admin API, needs an org-admin key
    # a managed seat can never self-provision). It's now "rate_limit": the same
    # Session/Weekly percent view Pro gets, no admin key required.
    assert resolve_account_profile("claude_enterprise")["budget_api"] == "rate_limit"


def test_resolve_account_profile_team_and_api_are_unchanged():
    assert resolve_account_profile("claude_team")["budget_api"] == "unavailable"
    assert resolve_account_profile("api")["budget_api"] == "usage_cost"


def test_resolve_account_profile_unknown_or_missing_falls_back_to_unavailable():
    assert resolve_account_profile(None)["budget_api"] == "unavailable"
    assert resolve_account_profile("some_future_plan")["budget_api"] == "unavailable"


def test_resolve_account_profile_is_case_insensitive():
    assert resolve_account_profile("Claude_Enterprise")["budget_api"] == "rate_limit"


def test_wants_spend_limit_api_is_false_for_every_profile_today():
    # Proves the Admin spend-limit network/admin-key path is fully gated off
    # until an account profile deliberately opts back in to "spend_limits".
    for organization_type in ("claude_pro", "claude_max", "claude_enterprise", "claude_team", "api", None):
        plan = resolve_account_profile(organization_type)
        assert not wants_spend_limit_api(plan), organization_type


def test_wants_spend_limit_api_is_true_only_for_spend_limits():
    assert wants_spend_limit_api({"budget_api": "spend_limits"})
    assert not wants_spend_limit_api({"budget_api": "rate_limit"})
    assert not wants_spend_limit_api({"budget_api": "unavailable"})
    assert not wants_spend_limit_api({})
