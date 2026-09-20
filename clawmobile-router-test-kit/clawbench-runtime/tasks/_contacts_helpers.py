from __future__ import annotations

from core.results import CheckResult
from core.preflight import PreflightCheckError, require_preflight


PREFLIGHT_QUERY_NAME = "__ClawBench_ReadOnly_Preflight_NoMatch__"


def require_contacts_access(device) -> None:
    required_methods = (
        "contacts_provider_readable",
        "create_contact",
        "delete_contacts_by_name",
        "contact_count_by_name",
        "contact_phone_exists",
    )
    for method_name in required_methods:
        require_preflight(
            hasattr(device, method_name),
            f"Device wrapper does not support contacts method {method_name}",
        )

    try:
        require_preflight(
            device.contacts_provider_readable(),
            "ContactsProvider is not readable",
        )
        # This deliberately exercises only a query. Preflight must never create,
        # update, or delete a real contact merely to prove provider access.
        device.contact_count_by_name(PREFLIGHT_QUERY_NAME)
    except PreflightCheckError:
        raise
    except Exception as exc:
        raise PreflightCheckError(f"ContactsProvider preflight failed: {exc}") from exc


def delete_test_contacts(device, name: str) -> None:
    device.delete_contacts_by_name(name)


def create_test_contact(
    device,
    name: str,
    phone: str | None = None,
    email: str | None = None,
) -> int:
    return device.create_contact(name, phone=phone, email=email)


def add_contact_identity_checks(
    result: CheckResult,
    device,
    name: str,
    expected_count: int = 1,
) -> None:
    count = device.contact_count_by_name(name)
    result.add(
        "contact_count_matches",
        count == expected_count,
        "contacts_provider",
        detail=f"name={name!r}, count={count}, expected={expected_count}",
    )


def add_phone_exists_check(
    result: CheckResult,
    device,
    name: str,
    phone: str,
    raw_id: int | None = None,
    expected: bool = True,
    is_negative: bool = False,
) -> None:
    exists = (
        device.raw_contact_phone_exists(raw_id, phone)
        if raw_id is not None
        else device.contact_phone_exists(name, phone)
    )
    result.add(
        _check_name("phone", phone, expected),
        exists == expected,
        "contacts_provider",
        is_negative=is_negative,
        detail=f"name={name!r}, raw_id={raw_id!r}, phone={phone!r}, exists={exists}",
    )


def add_email_exists_check(
    result: CheckResult,
    device,
    name: str,
    email: str,
    raw_id: int | None = None,
    expected: bool = True,
    is_negative: bool = False,
) -> None:
    exists = (
        device.raw_contact_email_exists(raw_id, email)
        if raw_id is not None
        else device.contact_email_exists(name, email)
    )
    result.add(
        _check_name("email", email, expected),
        exists == expected,
        "contacts_provider",
        is_negative=is_negative,
        detail=f"name={name!r}, raw_id={raw_id!r}, email={email!r}, exists={exists}",
    )


def _check_name(kind: str, value: str, expected: bool) -> str:
    suffix = "exists" if expected else "absent"
    safe_value = value.replace("+", "plus_").replace("@", "_at_").replace(".", "_")
    return f"{kind}_{safe_value}_{suffix}"
