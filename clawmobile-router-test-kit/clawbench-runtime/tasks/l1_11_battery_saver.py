from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    require_readable_settings,
    run_best_effort_shell,
    snapshot_display_settings,
)


class L1_11_BatterySaver(Task):
    task_id = "L1-11"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"state": state} for state in ("on", "off")]

    def get_instruction(self, params: dict) -> str:
        return f"Turn battery saver {params['state']}"

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(device, (("global", "low_power"),))

    def setup(self, device, params: dict) -> None:
        self._original_state = parse_int(device.get_setting("global", "low_power"))
        _set_battery_saver(device, enabled=params["state"] == "off")
        self._snapshot = snapshot_display_settings(device)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        expected = 1 if params["state"] == "on" else 0
        raw = device.get_setting("global", "low_power")
        actual = parse_int(raw)
        result.add(
            "battery_saver_matches",
            actual == expected,
            "settings",
            detail=f"value={raw!r}, expected={expected}",
        )
        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        original = getattr(self, "_original_state", None)
        _set_battery_saver(
            device,
            enabled=bool(original) if original is not None else False,
        )


def _set_battery_saver(device, enabled: bool) -> None:
    run_best_effort_shell(device, f"cmd power set-mode {1 if enabled else 0}")
    device.put_setting("global", "low_power", 1 if enabled else 0)
