from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    require_readable_settings,
    snapshot_display_settings,
)


class L1_07_QualitativeBrightness(Task):
    task_id = "L1-07"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": "Set the screen brightness to low",
                "level": "low",
                "initial_percent": 75,
            },
            {
                "instruction": "Set the screen brightness to medium",
                "level": "medium",
                "initial_percent": 100,
            },
            {
                "instruction": "Set mid screen brightness",
                "level": "medium",
                "initial_percent": 25,
            },
            {
                "instruction": "Set the screen brightness to high",
                "level": "high",
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
        device.put_setting("system", "screen_brightness_mode", 0)
        device.put_setting(
            "system",
            "screen_brightness",
            _brightness_for_percent(int(params["initial_percent"])),
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
        low, high = _brightness_range_for_level(str(params["level"]))

        brightness_raw = device.get_setting("system", "screen_brightness")
        brightness = parse_int(brightness_raw)
        result.add(
            "brightness_level_matches",
            brightness is not None and low <= brightness <= high,
            "settings",
            detail=f"value={brightness_raw!r}, expected_range={low}..{high}",
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


def _brightness_range_for_level(level: str) -> tuple[int, int]:
    ranges = {
        "low": (0, 35),
        "medium": (30, 70),
        "high": (65, 100),
    }
    low_percent, high_percent = ranges[level]
    return _brightness_for_percent(low_percent), _brightness_for_percent(high_percent)
