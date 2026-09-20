from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    require_readable_settings,
    snapshot_display_settings,
)


class L1_12_FontSize(Task):
    task_id = "L1-12"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": "Make text size small",
                "scale": 0.85,
                "initial_scale": 1.15,
            },
            {
                "instruction": "Set text size back to default",
                "scale": 1.0,
                "initial_scale": 1.3,
            },
            {
                "instruction": "Make text size larger",
                "scale": 1.15,
                "initial_scale": 0.85,
            },
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(device, (("system", "font_scale"),))

    def setup(self, device, params: dict) -> None:
        device.put_setting("system", "font_scale", params["initial_scale"])
        self._snapshot = snapshot_display_settings(device, exclude=("font_scale",))

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        raw = device.get_setting("system", "font_scale")
        actual = _parse_float(raw)
        expected = float(params["scale"])
        result.add(
            "font_size_matches",
            actual is not None and abs(actual - expected) <= 0.03,
            "settings",
            detail=f"value={raw!r}, expected={expected}",
        )
        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        device.put_setting("system", "font_scale", 1.0)


def _parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None
