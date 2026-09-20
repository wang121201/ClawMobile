from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._contacts_helpers import (
    add_contact_identity_checks,
    add_email_exists_check,
    create_test_contact,
    delete_test_contacts,
    require_contacts_access,
)


class L3_04_AddContactEmail(Task):
    task_id = "L3-04"
    layer = "L3"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"name": "Alice Test", "email": "alice@test.com"}]

    def get_instruction(self, params: dict) -> str:
        return f"Add email {params['email']} to contact {params['name']}"

    def preflight(self, device, params: dict) -> None:
        require_contacts_access(device)

    def setup(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
        self._raw_contact_id = create_test_contact(device, params["name"])

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        raw_id = getattr(self, "_raw_contact_id", None)
        add_contact_identity_checks(result, device, params["name"])
        add_email_exists_check(
            result,
            device,
            params["name"],
            params["email"],
            raw_id=raw_id,
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
