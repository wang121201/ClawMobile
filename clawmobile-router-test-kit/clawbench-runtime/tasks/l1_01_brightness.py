# TEMPLATE: copy this file to create new tasks. Only change the class, task_id,
# params, get_instruction, setup, check, teardown.

from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    require_readable_settings,
    snapshot_display_settings,
)


class L1_01_Brightness(Task):
    task_id = "L1-01"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"percent": percent} for percent in (25, 50, 75, 100)]

    def get_instruction(self, params: dict) -> str:
        return f"Set the screen brightness to {params['percent']}%"

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(
            device,
            (
                ("system", "screen_brightness"),
                ("system", "screen_brightness_mode"),
            ),
        )

    def setup(self, device, params: dict) -> None:
        device.put_setting("system", "screen_brightness_mode", 0)
        device.put_setting(
            "system",
            "screen_brightness",
            _brightness_for_percent(_different_initial_percent(params)),
        )
        self._snapshot = snapshot_display_settings(
            device,
            exclude=("screen_brightness", "screen_brightness_mode"),
        )

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        percent = int(params["percent"])
        target = _brightness_for_percent(percent)

        brightness_raw = device.get_setting("system", "screen_brightness")
        brightness = parse_int(brightness_raw)
        result.add(
            "brightness_matches",
            brightness is not None and abs(brightness - target) <= 6,
            "settings",
            detail=f"value={brightness_raw!r}, target={target}",
        )

        mode = device.get_setting("system", "screen_brightness_mode")
        result.add(
            "auto_brightness_off",
            mode == "0",
            "settings",
            is_negative=True,
            detail=f"value={mode!r}",
        )

        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))

        return result

    def teardown(self, device, params: dict) -> None:
        device.put_setting("system", "screen_brightness", 255)
        device.put_setting("system", "screen_brightness_mode", 0)


def _different_initial_percent(params: dict) -> int:
    percent = int(params["percent"])
    candidates = [25, 50, 75, 100]
    return candidates[(candidates.index(percent) + 1) % len(candidates)]


def _brightness_for_percent(percent: int) -> int:
    return round(255 * percent / 100)
