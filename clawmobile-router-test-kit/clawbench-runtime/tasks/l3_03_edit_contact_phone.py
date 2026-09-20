from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._contacts_helpers import (
    add_contact_identity_checks,
    add_phone_exists_check,
    create_test_contact,
    delete_test_contacts,
    require_contacts_access,
)


OLD_PHONE = "+971500001111"


class L3_03_EditContactPhone(Task):
    task_id = "L3-03"
    layer = "L3"
    M = ExecutionMode.APP_UI
    T = TaskLength.MEDIUM
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"name": "Alice Test", "new_phone": "+971500009999"}]

    def get_instruction(self, params: dict) -> str:
        return f"Change {params['name']}'s phone number to {params['new_phone']}"

    def preflight(self, device, params: dict) -> None:
        require_contacts_access(device)

    def setup(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
        self._raw_contact_id = create_test_contact(
            device,
            params["name"],
            phone=OLD_PHONE,
        )

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        raw_id = getattr(self, "_raw_contact_id", None)
        add_contact_identity_checks(result, device, params["name"])
        add_phone_exists_check(
            result,
            device,
            params["name"],
            params["new_phone"],
            raw_id=raw_id,
        )
        add_phone_exists_check(
            result,
            device,
            params["name"],
            OLD_PHONE,
            raw_id=raw_id,
            expected=False,
            is_negative=True,
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
