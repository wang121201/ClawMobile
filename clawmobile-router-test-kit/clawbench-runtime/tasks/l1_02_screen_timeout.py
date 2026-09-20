from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    require_readable_settings,
    snapshot_display_settings,
)


class L1_02_ScreenTimeout(Task):
    task_id = "L1-02"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"seconds": seconds} for seconds in (15, 30, 60, 120)]

    def get_instruction(self, params: dict) -> str:
        return f"Set the screen timeout to {params['seconds']} seconds"

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(device, (("system", "screen_off_timeout"),))

    def setup(self, device, params: dict) -> None:
        device.put_setting(
            "system",
            "screen_off_timeout",
            _milliseconds_for_seconds(_different_initial_seconds(params)),
        )
        self._snapshot = snapshot_display_settings(
            device,
            exclude=("screen_off_timeout",),
        )

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        target = _milliseconds_for_seconds(int(params["seconds"]))

        timeout_raw = device.get_setting("system", "screen_off_timeout")
        timeout = parse_int(timeout_raw)
        result.add(
            "screen_timeout_matches",
            timeout == target,
            "settings",
            detail=f"value={timeout_raw!r}, target={target}",
        )

        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        device.put_setting("system", "screen_off_timeout", 1800000)


def _different_initial_seconds(params: dict) -> int:
    seconds = int(params["seconds"])
    candidates = [15, 30, 60, 120]
    return candidates[(candidates.index(seconds) + 1) % len(candidates)]


def _milliseconds_for_seconds(seconds: int) -> int:
    return seconds * 1000
