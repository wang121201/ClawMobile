from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    require_readable_settings,
    snapshot_display_settings,
)


class L1_05_AutoRotate(Task):
    task_id = "L1-05"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"state": state} for state in ("on", "off")]

    def get_instruction(self, params: dict) -> str:
        return f"Turn auto-rotate {params['state']}"

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(device, (("system", "accelerometer_rotation"),))

    def setup(self, device, params: dict) -> None:
        device.put_setting(
            "system",
            "accelerometer_rotation",
            0 if params["state"] == "on" else 1,
        )
        self._snapshot = snapshot_display_settings(
            device,
            exclude=("accelerometer_rotation",),
        )

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        expected = 1 if params["state"] == "on" else 0

        rotation_raw = device.get_setting("system", "accelerometer_rotation")
        rotation = parse_int(rotation_raw)
        result.add(
            "auto_rotate_matches",
            rotation == expected,
            "settings",
            detail=f"value={rotation_raw!r}, expected={expected}",
        )

        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        device.put_setting("system", "accelerometer_rotation", 0)
