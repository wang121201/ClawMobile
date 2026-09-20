from __future__ import annotations

from datetime import datetime

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from core.preflight import PreflightCheckError
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    run_best_effort_shell,
    snapshot_display_settings,
)


ALARM_LABEL = "ClawBench L1-04"
ALARM_PROVIDER_URIS = (
    "content://com.android.deskclock/alarm",
    "content://com.google.android.deskclock/alarm",
)


class L1_04_Alarm(Task):
    task_id = "L1-04"
    layer = "L1"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"time": time} for time in ("7:30 AM", "8:00 AM", "9:15 PM")]

    def get_instruction(self, params: dict) -> str:
        return f"Set an alarm for {params['time']} named {ALARM_LABEL}"

    def preflight(self, device, params: dict) -> None:
        _require_alarm_provider_readable(device)

    def setup(self, device, params: dict) -> None:
        _delete_test_alarms(device)
        self._snapshot = snapshot_display_settings(device)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        hour, minute = _parse_time(params["time"])
        records = _query_alarm_records(device)
        matching = [
            record
            for record in records
            if _record_matches_alarm(record, hour=hour, minute=minute)
        ]

        result.add(
            "alarm_exists",
            len(matching) == 1,
            "alarm_provider",
            detail=f"matches={len(matching)}, target={hour:02d}:{minute:02d}",
        )
        result.add(
            "no_extra_test_alarms",
            len(_test_alarm_records(records)) == 1,
            "alarm_provider",
            is_negative=True,
            detail=f"test_alarm_count={len(_test_alarm_records(records))}",
        )

        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        _delete_test_alarms(device)


def _delete_test_alarms(device) -> None:
    for uri in ALARM_PROVIDER_URIS:
        for column in ("message", "label", "name"):
            run_best_effort_shell(
                device,
                f"content delete --uri {uri} --where \"{column}='{ALARM_LABEL}'\"",
            )


def _require_alarm_provider_readable(device) -> None:
    errors: list[str] = []
    for uri in ALARM_PROVIDER_URIS:
        readable, reason = _alarm_provider_readable(device, uri)
        if readable:
            return
        errors.append(f"{uri}: {reason}")
    raise PreflightCheckError(
        "Alarm provider is not readable through known URIs; "
        + "; ".join(errors)
    )


def _alarm_provider_readable(device, uri: str) -> tuple[bool, str]:
    try:
        output = device.shell(
            f"content query --uri {uri} --projection _id 2>&1 || true"
        )
    except Exception as exc:
        return False, str(exc)
    lowered = output.lower()
    failure_markers = (
        "permission denial",
        "unknown url",
        "no content provider",
        "exception",
        "java.lang",
    )
    for marker in failure_markers:
        if marker in lowered:
            return False, output[:240]
    return True, ""


def _query_alarm_records(device) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for uri in ALARM_PROVIDER_URIS:
        output = run_best_effort_shell(device, f"content query --uri {uri}")
        records.extend(_parse_content_rows(output))
    return records


def _parse_content_rows(output: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for line in output.splitlines():
        if not line.startswith("Row:"):
            continue
        parts = line.split(" ", 2)
        fields = parts[2] if len(parts) == 3 else ""
        record: dict[str, str] = {}
        for part in fields.split(","):
            key, separator, value = part.strip().partition("=")
            if separator:
                record[key.strip()] = value.strip()
        if record:
            records.append(record)
    return records


def _record_matches_alarm(record: dict[str, str], hour: int, minute: int) -> bool:
    if not _is_test_alarm(record):
        return False
    if not _record_enabled(record):
        return False
    return _record_int(record, ("hour", "hours")) == hour and _record_int(
        record,
        ("minutes", "minute"),
    ) == minute


def _test_alarm_records(records: list[dict[str, str]]) -> list[dict[str, str]]:
    return [record for record in records if _is_test_alarm(record)]


def _is_test_alarm(record: dict[str, str]) -> bool:
    text = " ".join(
        record.get(key, "")
        for key in ("message", "label", "name", "title")
    )
    return ALARM_LABEL.lower() in text.lower()


def _record_enabled(record: dict[str, str]) -> bool:
    value = record.get("enabled")
    if value is None:
        return True
    return value.lower() not in {"0", "false", "off"}


def _record_int(record: dict[str, str], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = record.get(key)
        if value is None:
            continue
        try:
            return int(value)
        except ValueError:
            continue
    return None


def _parse_time(value: str) -> tuple[int, int]:
    parsed = datetime.strptime(value, "%I:%M %p")
    return parsed.hour, parsed.minute
