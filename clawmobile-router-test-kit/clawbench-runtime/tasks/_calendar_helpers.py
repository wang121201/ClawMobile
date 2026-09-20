from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.results import CheckResult
from core.preflight import PreflightCheckError, require_preflight


PREFLIGHT_EVENT_TITLE = "ClawBench Preflight Event"
DEFAULT_EVENT_DURATION_MINUTES = 30


def require_calendar_access(device) -> None:
    required_methods = (
        "writable_calendar_ids",
        "create_calendar_event",
        "delete_calendar_events_by_title",
        "calendar_events_by_title",
    )
    for method_name in required_methods:
        require_preflight(
            hasattr(device, method_name),
            f"Device wrapper does not support calendar method {method_name}",
        )

    try:
        calendar_ids = device.writable_calendar_ids()
        require_preflight(
            bool(calendar_ids),
            "CalendarProvider has no writable visible calendar",
        )
        device.delete_calendar_events_by_title(PREFLIGHT_EVENT_TITLE)
        timezone_name = _safe_timezone_name(device)
        start_ms = _datetime_to_epoch_ms(
            datetime.now(_zoneinfo(timezone_name)) + timedelta(days=1)
        )
        device.create_calendar_event(
            PREFLIGHT_EVENT_TITLE,
            start_ms=start_ms,
            end_ms=start_ms + DEFAULT_EVENT_DURATION_MINUTES * 60_000,
            timezone=timezone_name,
            calendar_id=calendar_ids[0],
        )
        require_preflight(
            len(device.calendar_events_by_title(PREFLIGHT_EVENT_TITLE)) == 1,
            "CalendarProvider probe event could not be created or queried",
        )
    except PreflightCheckError:
        raise
    except Exception as exc:
        raise PreflightCheckError(f"CalendarProvider preflight failed: {exc}") from exc
    finally:
        try:
            device.delete_calendar_events_by_title(PREFLIGHT_EVENT_TITLE)
        except Exception:
            pass


def delete_test_events(device, title: str) -> None:
    device.delete_calendar_events_by_title(title)


def create_test_event(device, title: str, time_label: str) -> int:
    start_ms = tomorrow_at_local_time_ms(device, time_label)
    timezone_name = _safe_timezone_name(device)
    return device.create_calendar_event(
        title,
        start_ms=start_ms,
        end_ms=start_ms + DEFAULT_EVENT_DURATION_MINUTES * 60_000,
        timezone=timezone_name,
    )


def add_calendar_event_checks(
    result: CheckResult,
    device,
    title: str,
    time_label: str,
    expected_start_ms: int | None = None,
) -> None:
    events = device.calendar_events_by_title(title)
    expected_start = (
        expected_start_ms
        if expected_start_ms is not None
        else tomorrow_at_local_time_ms(device, time_label)
    )
    matching = [
        event
        for event in events
        if _parse_int(event.get("dtstart")) == expected_start
    ]
    result.add(
        "event_count_matches",
        len(events) == 1,
        "calendar_provider",
        detail=f"title={title!r}, count={len(events)}, expected=1",
    )
    result.add(
        "event_time_matches",
        len(matching) == 1,
        "calendar_provider",
        detail=f"title={title!r}, expected_dtstart={expected_start}, events={events!r}",
    )


def tomorrow_at_local_time_ms(device, time_label: str) -> int:
    timezone_name = _safe_timezone_name(device)
    now = datetime.now(_zoneinfo(timezone_name))
    hour, minute = _parse_time_label(time_label)
    tomorrow = now.date() + timedelta(days=1)
    target = datetime(
        tomorrow.year,
        tomorrow.month,
        tomorrow.day,
        hour,
        minute,
        tzinfo=_zoneinfo(timezone_name),
    )
    return _datetime_to_epoch_ms(target)


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


def _parse_time_label(value: str) -> tuple[int, int]:
    parsed = datetime.strptime(value, "%I %p")
    return parsed.hour, parsed.minute


def _datetime_to_epoch_ms(value: datetime) -> int:
    return round(value.timestamp() * 1000)


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None
