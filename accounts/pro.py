"""Claude Pro / Max account profile.

Pro and Max seats have no budget/spend-limit API of their own — the member
can't self-provision an admin key for a personal account the way an org
admin could, and there's nothing analogous to Enterprise's spend limit to
query anyway. This value is a straight carry-over of what
`BUDGET_API_BY_ORG_TYPE` returned for these org types before the accounts/
split: Pro's behavior must stay exactly as it was, verified by the existing
test suite.
"""

PROFILE = {"budget_api": "unavailable"}
