"""Per-account-type budget profiles.

`resolve_account_profile()` replaces the old flat `BUDGET_API_BY_ORG_TYPE`
dict in claude_budget_advisor.py: each account type that has genuinely
distinct logic (Pro, Enterprise) gets its own module here, so one account's
behavior can change without risking another's. Team and API are not part of
this split yet (nobody has asked for their own module) and keep the exact
values `BUDGET_API_BY_ORG_TYPE` always gave them, inline below.
"""

from . import enterprise, pro

# Org types mapped to a dedicated module. Anything else falls through to
# DEFAULT_PROFILES, then to the unmapped default.
_MODULE_PROFILES = {
    "claude_pro": pro.PROFILE,
    "claude_max": pro.PROFILE,
    "claude_enterprise": enterprise.PROFILE,
}

# Unchanged from the pre-split BUDGET_API_BY_ORG_TYPE — not part of this
# request, left exactly as they were.
DEFAULT_PROFILES = {
    "claude_team": {"budget_api": "unavailable"},
    "api": {"budget_api": "usage_cost"},
}

UNMAPPED_PROFILE = {"budget_api": "unavailable"}


def resolve_account_profile(organization_type: str | None) -> dict:
    """The budget profile for an org type: a dedicated module, a known default, or the unmapped fallback."""
    key = str(organization_type or "").lower()
    if key in _MODULE_PROFILES:
        return _MODULE_PROFILES[key]
    return DEFAULT_PROFILES.get(key, UNMAPPED_PROFILE)


def wants_spend_limit_api(plan: dict) -> bool:
    """True only for a profile that actually declares the Admin spend-limit API as its source.

    Gates `resolve_spend_limit()`/`apply_spend_calibration()` in claude_budget_advisor.py
    so an account type with no realistic path to an admin key (Enterprise, today)
    never makes the network attempt or carries stale "estimated" dollar figures
    the UI won't show anyway.
    """
    return plan.get("budget_api") == "spend_limits"
