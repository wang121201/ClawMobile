"""In-memory fake with the same small interface as Device."""

from __future__ import annotations

import hashlib
import posixpath
import zipfile
from io import BytesIO
from typing import Any


class MockDevice:
    """A deterministic test double for task setup/check logic."""

    def __init__(
        self,
        initial_state: dict[tuple[str, str], Any] | None = None,
        shell_responses: dict[str, str] | None = None,
        installed_packages: set[str] | None = None,
        current_package: str = "",
        current_activity: str = "",
        ui_xml: str = "",
        skill_results: dict[str, dict[str, Any]] | None = None,
        serial: str = "mock",
    ) -> None:
        self.serial = serial
        self._settings: dict[tuple[str, str], str] = {
            key: str(value) for key, value in (initial_state or {}).items()
        }
        self._shell_responses = dict(shell_responses or {})
        self._files: dict[str, bytes] = {}
        self._dirs: set[str] = {"/", "/sdcard", "/sdcard/Download"}
        self._next_raw_contact_id = 1
        self._contacts: dict[int, dict[str, Any]] = {}
        self._next_event_id = 1
        self._calendar_ids: list[int] = [1]
        self._calendar_events: dict[int, dict[str, Any]] = {}
        self._installed_packages = set(installed_packages or ())
        self._current_package = current_package
        self._current_activity = current_activity
        self._ui_xml = ui_xml
        self._skill_results = dict(skill_results or {})
        self.shell_commands: list[str] = []

    def get_setting(self, namespace: str, key: str) -> str | None:
        """Return a stored setting value, or None when absent."""

        value = self._settings.get((namespace, key))
        if value == "" or value == "null":
            return None
        return value

    def put_setting(self, namespace: str, key: str, value) -> None:
        """Store a setting value in memory."""

        self._settings[(namespace, key)] = str(value)

    def shell(self, command: str) -> str:
        """Record the shell command and return a configured response."""

        self.shell_commands.append(command)
        return self._shell_responses.get(command, "")

    def command_available(self, command: str) -> bool:
        return command in {"cat", "mkdir", "mv", "printf", "rm", "sha256sum"}

    def path_exists(self, path: str) -> bool:
        normalized = _normalize_path(path)
        return normalized in self._files or normalized in self._dirs

    def mkdir_p(self, path: str) -> None:
        normalized = _normalize_path(path)
        parts = normalized.strip("/").split("/") if normalized != "/" else []
        current = ""
        for part in parts:
            current = f"{current}/{part}" if current else f"/{part}"
            self._dirs.add(current)

    def rm_rf(self, path: str) -> None:
        normalized = _normalize_path(path)
        self._files = {
            file_path: data
            for file_path, data in self._files.items()
            if file_path != normalized and not file_path.startswith(f"{normalized}/")
        }
        self._dirs = {
            dir_path
            for dir_path in self._dirs
            if dir_path == "/" or (
                dir_path != normalized and not dir_path.startswith(f"{normalized}/")
            )
        }

    def write_text_file(self, path: str, content: str) -> None:
        normalized = _normalize_path(path)
        self.mkdir_p(posixpath.dirname(normalized))
        self._files[normalized] = content.encode("utf-8")

    def read_text_file(self, path: str) -> str:
        data = self._files.get(_normalize_path(path))
        if data is None:
            raise FileNotFoundError(path)
        return data.decode("utf-8")

    def file_sha256(self, path: str) -> str | None:
        data = self._files.get(_normalize_path(path))
        if data is None:
            return None
        return hashlib.sha256(data).hexdigest()

    def mv_file(self, src: str, dst: str) -> None:
        normalized_src = _normalize_path(src)
        normalized_dst = _normalize_path(dst)
        data = self._files.pop(normalized_src)
        self.mkdir_p(posixpath.dirname(normalized_dst))
        self._files[normalized_dst] = data

    def write_zip_file(self, path: str, entries: dict[str, str]) -> None:
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, content in entries.items():
                archive.writestr(name, content)
        normalized = _normalize_path(path)
        self.mkdir_p(posixpath.dirname(normalized))
        self._files[normalized] = buffer.getvalue()

    def zip_entries(self, path: str) -> list[str]:
        data = self._files.get(_normalize_path(path))
        if data is None:
            raise FileNotFoundError(path)
        with zipfile.ZipFile(BytesIO(data)) as archive:
            return archive.namelist()

    def zip_member_sha256(self, path: str, member: str) -> str | None:
        data = self._files.get(_normalize_path(path))
        if data is None:
            return None
        with zipfile.ZipFile(BytesIO(data)) as archive:
            try:
                member_data = archive.read(member)
            except KeyError:
                return None
        return hashlib.sha256(member_data).hexdigest()

    def package_installed(self, package: str) -> bool:
        return package in self._installed_packages

    def force_stop(self, package: str) -> None:
        if self._current_package == package:
            self._current_package = ""
            self._current_activity = ""

    def current_app(self) -> dict[str, str]:
        return {
            "package": self._current_package,
            "activity": self._current_activity,
            "component": (
                f"{self._current_package}/{self._current_activity}"
                if self._current_package and self._current_activity
                else ""
            ),
        }

    def set_current_app(self, package: str, activity: str = "") -> None:
        self._current_package = package
        self._current_activity = activity

    def ui_dump_xml(self) -> str:
        return self._ui_xml

    def set_ui_xml(self, xml: str) -> None:
        self._ui_xml = xml

    def skill_runner_available(self) -> bool:
        return bool(self._skill_results)

    def run_skill(
        self,
        skill_name: str,
        params: dict | None = None,
        skill_path: str | None = None,
    ) -> dict:
        if skill_name not in self._skill_results:
            raise RuntimeError(f"skill not configured in mock: {skill_name}")
        result = dict(self._skill_results[skill_name])
        if "current_package" in result:
            self._current_package = str(result["current_package"])
        if "current_activity" in result:
            self._current_activity = str(result["current_activity"])
        if "ui_xml" in result:
            self._ui_xml = str(result["ui_xml"])
        return result

    def contacts_provider_readable(self) -> bool:
        return True

    def create_contact(
        self,
        name: str,
        phone: str | None = None,
        email: str | None = None,
    ) -> int:
        raw_id = self._next_raw_contact_id
        self._next_raw_contact_id += 1
        self._contacts[raw_id] = {
            "name": name,
            "phones": [] if phone is None else [phone],
            "emails": [] if email is None else [email],
        }
        return raw_id

    def delete_contacts_by_name(self, name: str) -> None:
        for raw_id in self.contact_raw_ids_by_name(name):
            self._contacts.pop(raw_id, None)

    def contact_raw_ids_by_name(self, name: str) -> list[int]:
        return sorted(
            raw_id
            for raw_id, contact in self._contacts.items()
            if contact["name"] == name
        )

    def contact_count_by_name(self, name: str) -> int:
        return len(self.contact_raw_ids_by_name(name))

    def contact_phone_exists(self, name: str, phone: str) -> bool:
        return any(
            self.raw_contact_phone_exists(raw_id, phone)
            for raw_id in self.contact_raw_ids_by_name(name)
        )

    def raw_contact_phone_exists(self, raw_id: int, phone: str) -> bool:
        contact = self._contacts.get(raw_id)
        if contact is None:
            return False
        target = _normalize_phone(phone)
        return any(_normalize_phone(value) == target for value in contact["phones"])

    def contact_email_exists(self, name: str, email: str) -> bool:
        return any(
            self.raw_contact_email_exists(raw_id, email)
            for raw_id in self.contact_raw_ids_by_name(name)
        )

    def raw_contact_email_exists(self, raw_id: int, email: str) -> bool:
        contact = self._contacts.get(raw_id)
        if contact is None:
            return False
        return any(value.lower() == email.lower() for value in contact["emails"])

    def add_contact_phone(self, raw_id: int, phone: str) -> None:
        self._contacts[raw_id]["phones"].append(phone)

    def update_contact_phone(self, raw_id: int, phone: str) -> None:
        self._contacts[raw_id]["phones"] = [phone]

    def add_contact_email(self, raw_id: int, email: str) -> None:
        self._contacts[raw_id]["emails"].append(email)

    def device_timezone(self) -> str:
        return "UTC"

    def writable_calendar_ids(self) -> list[int]:
        return list(self._calendar_ids)

    def create_calendar_event(
        self,
        title: str,
        start_ms: int,
        end_ms: int,
        timezone: str,
        calendar_id: int | None = None,
    ) -> int:
        if calendar_id is None:
            if not self._calendar_ids:
                raise RuntimeError("no writable calendar is available")
            calendar_id = self._calendar_ids[0]
        event_id = self._next_event_id
        self._next_event_id += 1
        self._calendar_events[event_id] = {
            "_id": str(event_id),
            "title": title,
            "dtstart": str(start_ms),
            "dtend": str(end_ms),
            "calendar_id": str(calendar_id),
            "eventTimezone": timezone,
        }
        return event_id

    def delete_calendar_events_by_title(self, title: str) -> None:
        self._calendar_events = {
            event_id: event
            for event_id, event in self._calendar_events.items()
            if event["title"] != title
        }

    def calendar_events_by_title(self, title: str) -> list[dict[str, str]]:
        return [
            dict(event)
            for event in self._calendar_events.values()
            if event["title"] == title
        ]


def _normalize_path(path: str) -> str:
    normalized = posixpath.normpath(path)
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    return normalized


def _normalize_phone(value: str) -> str:
    return "".join(char for char in value if char.isdigit() or char == "+")
