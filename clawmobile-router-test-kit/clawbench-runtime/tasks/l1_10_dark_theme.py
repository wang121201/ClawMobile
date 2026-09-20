from __future__ import annotations

from core.preflight import require_preflight
from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import (
    add_unchanged_setting_checks,
    run_best_effort_shell,
    snapshot_display_settings,
)


class L1_10_DarkTheme(Task):
    task_id = "L1-10"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"state": state} for state in ("on", "off")]

    def get_instruction(self, params: dict) -> str:
        return f"Turn dark theme {params['state']}"

    def preflight(self, device, params: dict) -> None:
        require_preflight(
            _read_dark_theme(device) is not None,
            "Dark theme state is not readable through cmd uimode night or secure ui_night_mode",
        )

    def setup(self, device, params: dict) -> None:
        self._original_state = _read_dark_theme(device)
        _set_dark_theme(device, enabled=params["state"] == "off")
        self._snapshot = snapshot_display_settings(device)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        expected = params["state"] == "on"
        state = _read_dark_theme(device)
        result.add(
            "dark_theme_matches",
            state is not None and state == expected,
            "uimode",
            detail=f"value={state!r}, expected={expected}",
        )
        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        original = getattr(self, "_original_state", None)
        _set_dark_theme(
            device,
            enabled=bool(original) if original is not None else False,
        )


def _set_dark_theme(device, enabled: bool) -> None:
    run_best_effort_shell(device, f"cmd uimode night {'yes' if enabled else 'no'}")
    device.put_setting("secure", "ui_night_mode", 2 if enabled else 1)


def _read_dark_theme(device) -> bool | None:
    output = run_best_effort_shell(device, "cmd uimode night")
    normalized = output.lower()
    if "night mode: yes" in normalized:
        return True
    if "night mode: no" in normalized:
        return False

    setting = device.get_setting("secure", "ui_night_mode")
    if setting == "2":
        return True
    if setting == "1":
        return False
    return None
