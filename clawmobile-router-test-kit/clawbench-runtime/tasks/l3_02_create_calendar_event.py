from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._calendar_helpers import (
    add_calendar_event_checks,
    delete_test_events,
    require_calendar_access,
    tomorrow_at_local_time_ms,
)


class L3_02_CreateCalendarEvent(Task):
    task_id = "L3-02"
    layer = "L3"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"title": "Team sync", "time": "10 AM"},
            {"title": "Doctor appointment", "time": "3 PM"},
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Create a calendar event titled {params['title']} tomorrow at "
            f"{params['time']}"
        )

    def preflight(self, device, params: dict) -> None:
        require_calendar_access(device)

    def setup(self, device, params: dict) -> None:
        delete_test_events(device, params["title"])
        self._expected_start_ms = tomorrow_at_local_time_ms(device, params["time"])

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        add_calendar_event_checks(
            result,
            device,
            params["title"],
            params["time"],
            expected_start_ms=getattr(self, "_expected_start_ms", None),
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_events(device, params["title"])
