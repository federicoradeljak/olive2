"""Hourly Modal billing for the Olive GPU app (``Workspace.billing.report``).

Modal reports cost per App object and interval, never per function call, and
every deploy of ``olive-gpu`` gets a new App id — so rows are matched on the
App description and summed per hour across ids and resource types.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

# Modal rejects hourly reports spanning more than 7 days.
MAX_HOURLY_RANGE_SEC = 7 * 24 * 3600


@dataclass(frozen=True)
class ModalBillingHour:
    hour_start_ms: int
    cost_usd: float
    cost_by_resource: dict[str, float] = field(default_factory=dict)


def _to_ms(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


def aggregate_app_hours(items: list[Any], app_name: str) -> list[ModalBillingHour]:
    """Sums ``BillingReportItem`` rows of ``app_name`` per hour, oldest first."""
    totals: dict[int, float] = defaultdict(float)
    resources: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for item in items:
        if str(getattr(item, "description", "") or "") != app_name:
            continue
        hour = _to_ms(item.interval_start)
        totals[hour] += float(item.cost)
        for resource, cost in dict(getattr(item, "cost_by_resource", None) or {}).items():
            resources[hour][str(resource)] += float(cost)
    return [
        ModalBillingHour(
            hour_start_ms=hour,
            cost_usd=round(totals[hour], 8),
            cost_by_resource={k: round(v, 8) for k, v in resources[hour].items() if v},
        )
        for hour in sorted(totals)
    ]


async def fetch_hourly_app_costs(
    token_id: str,
    token_secret: str,
    app_name: str,
    start: datetime,
    end: datetime,
) -> list[ModalBillingHour]:
    """Fetches the workspace's hourly report and keeps ``app_name``'s rows."""
    import modal

    client = await modal.Client.from_credentials.aio(token_id, token_secret)
    workspace = modal.Workspace.from_context(client=client)
    items = await workspace.billing.report.aio(start=start, end=end, resolution="h")
    return aggregate_app_hours(list(items), app_name)
