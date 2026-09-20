from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._ui_helpers import (
    MAPS_PACKAGE,
    add_foreground_package_check,
    add_ui_contains_any_check,
    dump_ui_for_check,
    force_stop_if_supported,
    require_app_ui_access,
)


PLACE_ALIASES = {
    "MBZUAI": (
        "MBZUAI",
        "Mohamed bin Zayed University",
        "Mohamed Bin Zayed University of Artificial Intelligence",
    ),
    "Abu Dhabi Central Bus Station": (
        "Abu Dhabi Central Bus Station",
        "Central Bus Station",
    ),
}
MAPS_PLACE_SIGNALS = (
    "Directions",
    "Start",
    "Save",
    "Share",
    "Reviews",
    "Call",
    "Website",
    "Route",
)


class L4_02_OpenMapsLocation(Task):
    task_id = "L4-02"
    layer = "L4"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"place": "MBZUAI"},
            {"place": "Abu Dhabi Central Bus Station"},
        ]

    def get_instruction(self, params: dict) -> str:
        return f"Open Google Maps and search for {params['place']}"

    def preflight(self, device, params: dict) -> None:
        require_app_ui_access(device, MAPS_PACKAGE, "Google Maps")

    def setup(self, device, params: dict) -> None:
        force_stop_if_supported(device, MAPS_PACKAGE)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        add_foreground_package_check(result, device, MAPS_PACKAGE, "Google Maps")
        xml = dump_ui_for_check(result, device)
        add_ui_contains_any_check(
            result,
            "place_visible",
            xml,
            PLACE_ALIASES[params["place"]],
        )
        add_ui_contains_any_check(
            result,
            "place_card_visible",
            xml,
            MAPS_PLACE_SIGNALS,
        )
        return result

    def teardown(self, device, params: dict) -> None:
        force_stop_if_supported(device, MAPS_PACKAGE)
