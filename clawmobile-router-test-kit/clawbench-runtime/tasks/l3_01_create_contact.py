from __future__ import annotations

from core.preflight import require_preflight
from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._contacts_helpers import (
    add_contact_identity_checks,
    add_phone_exists_check,
    delete_test_contacts,
    require_contacts_access,
)


class L3_01_CreateContact(Task):
    task_id = "L3-01"
    layer = "L3"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"name": "Alice Test", "phone": "+971500001111"},
            {"name": "Bob Test", "phone": "+971500002222"},
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Create a contact named {params['name']} with phone number "
            f"{params['phone']}"
        )

    def preflight(self, device, params: dict) -> None:
        require_contacts_access(device)
        require_preflight(
            device.contact_count_by_name(params["name"]) == 0,
            f"Refusing to delete or overwrite existing contact: {params['name']!r}",
        )

    def setup(self, device, params: dict) -> None:
        pass

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        add_contact_identity_checks(result, device, params["name"])
        add_phone_exists_check(result, device, params["name"], params["phone"])
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
