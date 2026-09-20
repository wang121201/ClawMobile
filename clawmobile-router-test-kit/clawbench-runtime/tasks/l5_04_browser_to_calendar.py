from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.preflight import require_preflight
from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._calendar_helpers import (
    DEFAULT_EVENT_DURATION_MINUTES,
    delete_test_events,
    require_calendar_access,
)


EVENT_DATES = {
    "World Environment Day": (6, 5),
}


class L5_04_BrowserToCalendar(Task):
    task_id = "L5-04"
    layer = "L5"
    M = ExecutionMode.MULTI_APP
    T = TaskLength.LONG
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"event": "World Environment Day"}]

    def get_instruction(self, params: dict) -> str:
        return f"Find the date of {params['event']} online and create a calendar event for it"

    def preflight(self, device, params: dict) -> None:
        require_calendar_access(device)
        title = params["event"]
        existing = device.calendar_events_by_title(title)
        require_preflight(
            not existing,
            f"Refusing to delete or overwrite existing calendar events: "
            f"title={title!r}, count={len(existing)}",
        )

    def setup(self, device, params: dict) -> None:
        pass

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        title = params["event"]
        expected_month_day = EVENT_DATES[title]
        events = device.calendar_events_by_title(title)
        event_month_days = [event_local_month_day(device, event) for event in events]
        matching = [
            event
            for event, month_day in zip(events, event_month_days)
            if month_day == expected_month_day
        ]
        result.add(
            "event_count_matches",
            len(events) == 1,
            "calendar_provider",
            detail=f"title={title!r}, count={len(events)}, expected=1",
        )
        result.add(
            "event_date_matches",
            len(matching) == 1,
            "calendar_provider",
            detail=(
                f"title={title!r}, expected_month_day={expected_month_day!r}, "
                f"event_month_days={event_month_days!r}, events={events!r}"
            ),
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_events(device, params["event"])


def next_event_start_ms(device, event: str) -> int:
    month, day = EVENT_DATES[event]
    timezone_name = _safe_timezone_name(device)
    zone = _zoneinfo(timezone_name)
    now = datetime.now(zone)
    year = now.year
    if (month, day) < (now.month, now.day):
        year += 1
    target = datetime(year, month, day, 9, 0, tzinfo=zone)
    return round(target.timestamp() * 1000)


def event_end_ms(start_ms: int) -> int:
    return start_ms + DEFAULT_EVENT_DURATION_MINUTES * 60_000


def event_local_month_day(device, event: dict[str, str]) -> tuple[int, int] | None:
    start_ms = _parse_int(event.get("dtstart"))
    if start_ms is None:
        return None
    zone = _zoneinfo(_safe_timezone_name(device))
    local_start = datetime.fromtimestamp(start_ms / 1000, tz=zone)
    return local_start.month, local_start.day


def _safe_timezone_name(device) -> str:
    timezone_name = getattr(device, "device_timezone", lambda: "UTC")() or "UTC"
    try:
        _zoneinfo(timezone_name)
        return timezone_name
    except ZoneInfoNotFoundError:
        return "UTC"


def _zoneinfo(timezone_name: str):
    if timezone_name.upper() == "UTC":
        return timezone.utc
    return ZoneInfo(timezone_name)


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None
