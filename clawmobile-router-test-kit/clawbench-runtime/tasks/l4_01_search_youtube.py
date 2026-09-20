from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._ui_helpers import (
    YOUTUBE_PACKAGE,
    add_foreground_package_check,
    add_ui_contains_any_check,
    dump_ui_for_check,
    force_stop_if_supported,
    require_app_ui_access,
)


YOUTUBE_RESULT_SIGNALS = (
    "Filters",
    "Search results",
    "Views",
    "Subscribe",
    "Shorts",
    "Videos",
    "Latest",
    "Relevant",
)


class L4_01_SearchYoutube(Task):
    task_id = "L4-01"
    layer = "L4"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"query": "ClawMobile demo"},
            {"query": "lofi study music"},
        ]

    def get_instruction(self, params: dict) -> str:
        return f"Open YouTube and search for {params['query']}"

    def preflight(self, device, params: dict) -> None:
        require_app_ui_access(device, YOUTUBE_PACKAGE, "YouTube")

    def setup(self, device, params: dict) -> None:
        force_stop_if_supported(device, YOUTUBE_PACKAGE)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        add_foreground_package_check(result, device, YOUTUBE_PACKAGE, "YouTube")
        xml = dump_ui_for_check(result, device)
        add_ui_contains_any_check(
            result,
            "query_visible",
            xml,
            (params["query"],),
        )
        add_ui_contains_any_check(
            result,
            "search_results_visible",
            xml,
            YOUTUBE_RESULT_SIGNALS,
        )
        return result

    def teardown(self, device, params: dict) -> None:
        force_stop_if_supported(device, YOUTUBE_PACKAGE)
