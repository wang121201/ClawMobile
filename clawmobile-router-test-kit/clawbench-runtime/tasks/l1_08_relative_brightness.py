from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    require_readable_settings,
    snapshot_display_settings,
)


MIN_BRIGHTNESS_DELTA = round(255 * 20 / 100)


class L1_08_RelativeBrightness(Task):
    task_id = "L1-08"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": "Lower the screen brightness",
                "direction": "lower",
                "initial_percent": 75,
            },
            {
                "instruction": "Make the screen dimmer",
                "direction": "lower",
                "initial_percent": 75,
            },
            {
                "instruction": "Raise the screen brightness",
                "direction": "higher",
                "initial_percent": 25,
            },
            {
                "instruction": "Make the screen brighter",
                "direction": "higher",
                "initial_percent": 25,
            },
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(
            device,
            (
                ("system", "screen_brightness"),
                ("system", "screen_brightness_mode"),
            ),
        )

    def setup(self, device, params: dict) -> None:
        self._initial_brightness = _brightness_for_percent(
            int(params["initial_percent"])
        )
        device.put_setting("system", "screen_brightness_mode", 0)
        device.put_setting("system", "screen_brightness", self._initial_brightness)
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
        initial = int(getattr(self, "_initial_brightness", 0))

        brightness_raw = device.get_setting("system", "screen_brightness")
        brightness = parse_int(brightness_raw)
        if params["direction"] == "lower":
            threshold = initial - MIN_BRIGHTNESS_DELTA
            matches = brightness is not None and brightness <= threshold
            detail = f"value={brightness_raw!r}, must_be_at_most={threshold}"
        else:
            threshold = initial + MIN_BRIGHTNESS_DELTA
            matches = brightness is not None and brightness >= threshold
            detail = f"value={brightness_raw!r}, must_be_at_least={threshold}"
        result.add(
            "brightness_moved_in_requested_direction",
            matches,
            "settings",
            detail=detail,
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


def _brightness_for_percent(percent: int) -> int:
    return round(255 * percent / 100)
