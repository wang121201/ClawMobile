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


class L3_06_FindWorkContactEmail(Task):
    task_id = "L3-06"
    layer = "L3"
    M = ExecutionMode.SYSTEM_QUERY
    T = TaskLength.SHORT
    R = RiskLevel.READ_ONLY
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": (
                    "In Contacts, find Priya Work's work email and reply "
                    "with only the email address"
                ),
                "name": "Priya Work",
                "email": "priya.work@example.com",
                "decoy_name": "Priya Personal",
                "decoy_email": "priya.personal@example.com",
            },
            {
                "instruction": (
                    "In Contacts, find Sam Client's work email and reply "
                    "with only the email address"
                ),
                "name": "Sam Client",
                "email": "sam.client@example.com",
                "decoy_name": "Sam Friend",
                "decoy_email": "sam.friend@example.com",
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
            email=params["email"],
        )
        create_test_contact(
            device,
            params["decoy_name"],
            email=params["decoy_email"],
        )

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        reply = (completed_run or {}).get("replyText", "")
        normalized_reply = reply.strip().lower()
        result.add(
            "reply_contains_target_email",
            params["email"].lower() in normalized_reply,
            "assistant_reply",
            detail=f"reply={reply!r}, expected={params['email']!r}",
        )
        result.add(
            "reply_omits_decoy_email",
            params["decoy_email"].lower() not in normalized_reply,
            "assistant_reply",
            is_negative=True,
            detail=f"reply={reply!r}, decoy={params['decoy_email']!r}",
        )
        add_contact_identity_checks(result, device, params["name"])
        add_email_exists_check(
            result,
            device,
            params["name"],
            params["email"],
            raw_id=getattr(self, "_raw_contact_id", None),
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_test_contacts(device, params["name"])
        delete_test_contacts(device, params["decoy_name"])
