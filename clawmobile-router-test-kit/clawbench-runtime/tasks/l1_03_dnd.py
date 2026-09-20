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


class L1_03_DoNotDisturb(Task):
    task_id = "L1-03"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def get_instruction(self, params: dict) -> str:
        return "Turn on Do Not Disturb mode"

    def preflight(self, device, params: dict) -> None:
        require_readable_settings(device, (("global", "zen_mode"),))

    def setup(self, device, params: dict) -> None:
        _set_dnd(device, enabled=False)
        self._snapshot = snapshot_display_settings(device)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()

        zen_raw = device.get_setting("global", "zen_mode")
        zen_mode = parse_int(zen_raw)
        result.add(
            "dnd_enabled",
            zen_mode is not None and zen_mode != 0,
            "settings",
            detail=f"value={zen_raw!r}",
        )

        add_unchanged_setting_checks(result, device, getattr(self, "_snapshot", {}))
        return result

    def teardown(self, device, params: dict) -> None:
        _set_dnd(device, enabled=False)


def _set_dnd(device, enabled: bool) -> None:
    mode = "priority" if enabled else "off"
    run_best_effort_shell(device, f"cmd notification set_dnd {mode}")
    device.put_setting("global", "zen_mode", 1 if enabled else 0)
