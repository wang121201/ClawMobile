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


class L3_05_FindEmergencyContactPhone(Task):
    task_id = "L3-05"
    layer = "L3"
    M = ExecutionMode.SYSTEM_QUERY
    T = TaskLength.SHORT
    R = RiskLevel.READ_ONLY
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": (
                    "In Contacts, find my emergency contact Mom Emergency's "
                    "phone number and reply with only the phone number"
                ),
                "name": "Mom Emergency",
                "phone": "+971500003333",
                "decoy_name": "Mom Friend",
                "decoy_phone": "+971500009999",
            },
            {
                "instruction": (
                    "In Contacts, find my emergency contact Dad Emergency's "
                    "phone number and reply with only the phone number"
                ),
                "name": "Dad Emergency",
                "phone": "+971500004444",
                "decoy_name": "Dad Friend",
                "decoy_phone": "+971500008888",
            },
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_contacts_access(device)

    def setup(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
        delete_test_contacts(device, params["decoy_name"])
        self._raw_contact_id = create_test_contact(
            device,
            params["name"],
            phone=params["phone"],
        )
        create_test_contact(
            device,
            params["decoy_name"],
            phone=params["decoy_phone"],
        )

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        reply = (completed_run or {}).get("replyText", "")
        result.add(
            "reply_contains_target_phone",
            _normalize_phone(params["phone"]) in _normalize_phone(reply),
            "assistant_reply",
            detail=f"reply={reply!r}, expected={params['phone']!r}",
        )
        result.add(
            "reply_omits_decoy_phone",
            _normalize_phone(params["decoy_phone"]) not in _normalize_phone(reply),
            "assistant_reply",
            is_negative=True,
            detail=f"reply={reply!r}, decoy={params['decoy_phone']!r}",
        )
        add_contact_identity_checks(result, device, params["name"])
        add_phone_exists_check(
            result,
            device,
            params["name"],
            params["phone"],
            raw_id=getattr(self, "_raw_contact_id", None),
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
        delete_test_contacts(device, params["decoy_name"])


def _normalize_phone(value: str) -> str:
    return "".join(char for char in value if char.isdigit() or char == "+")
