from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from core.preflight import require_preflight
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    parse_int,
    run_best_effort_shell,
    snapshot_display_settings,
)


class L1_06_Bluetooth(Task):
    task_id = "L1-06"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"state": state} for state in ("on", "off")]

    def get_instruction(self, params: dict) -> str:
        return f"Turn Bluetooth {params['state']}"

    def preflight(self, device, params: dict) -> None:
        require_preflight(
            _read_bluetooth_state(device) is not None,
            "Bluetooth state is not readable through dumpsys bluetooth_manager or global bluetooth_on",
        )

    def setup(self, device, params: dict) -> None:
        self._original_state = device.get_setting("global", "bluetooth_on")
        _set_bluetooth(device, enabled=params["state"] == "off")
        self._snapshot = snapshot_display_settings(device)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        expected_enabled = params["state"] == "on"

        state = _read_bluetooth_state(device)
        result.add(
            "bluetooth_state_matches",
            state is not None and state == expected_enabled,
            "bluetooth_manager",
            detail=f"value={state!r}, expected={expected_enabled}",
        )

        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        original = parse_int(getattr(self, "_original_state", None))
        _set_bluetooth(device, enabled=bool(original) if original is not None else False)


def _set_bluetooth(device, enabled: bool) -> None:
    command = "enable" if enabled else "disable"
    run_best_effort_shell(device, f"cmd bluetooth_manager {command}")
    device.put_setting("global", "bluetooth_on", 1 if enabled else 0)


def _read_bluetooth_state(device) -> bool | None:
    dumpsys = run_best_effort_shell(device, "dumpsys bluetooth_manager")
    parsed = _parse_bluetooth_dumpsys(dumpsys)
    if parsed is not None:
        return parsed

    setting = parse_int(device.get_setting("global", "bluetooth_on"))
    if setting is None:
        return None
    return setting != 0


def _parse_bluetooth_dumpsys(output: str) -> bool | None:
    normalized = output.lower()
    if "enabled: true" in normalized or "state: on" in normalized:
        return True
    if "enabled: false" in normalized or "state: off" in normalized:
        return False
    return None
