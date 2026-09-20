"""Thin ADB-backed device wrapper."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import shlex
import subprocess
import tempfile
import uuid
import zipfile


_ALLOWED_RECURSIVE_DELETE_ROOTS = ("/sdcard/Download",)
_DEFAULT_ADB_TIMEOUT_SECONDS = 10.0


def _adb_timeout_seconds() -> float:
    raw = os.environ.get("CLAWBENCH_ADB_TIMEOUT_SECONDS")
    if raw is None:
        return _DEFAULT_ADB_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError as exc:
        raise ValueError(
            "CLAWBENCH_ADB_TIMEOUT_SECONDS must be a positive number"
        ) from exc
    if timeout <= 0:
        raise ValueError(
            "CLAWBENCH_ADB_TIMEOUT_SECONDS must be a positive number"
        )
    return timeout


class Device:
    """Small wrapper around `adb -s <serial> shell ...`."""

    def __init__(self, serial: str) -> None:
        self.serial = serial

    def get_setting(self, namespace: str, key: str) -> str | None:
        """Return an Android setting value, or None for empty/null output."""

        output = self._adb_shell(["settings", "get", namespace, key])
        if output == "" or output == "null":
            return None
        return output

    def put_setting(self, namespace: str, key: str, value) -> None:
        """Write an Android setting value."""

        self._adb_shell(["settings", "put", namespace, key, str(value)])

    def shell(self, command: str) -> str:
        """Run an arbitrary shell command and return stripped stdout."""

        return self._adb_shell([command])

    def command_available(self, command: str) -> bool:
        output = self.shell(
            f"command -v {_quote(command)} >/dev/null 2>&1 && echo 1 || echo 0"
        )
        return output == "1"

    def path_exists(self, path: str) -> bool:
        output = self.shell(
            f"if [ -e {_quote(path)} ]; then echo 1; else echo 0; fi"
        )
        return output == "1"

    def mkdir_p(self, path: str) -> None:
        self.shell(f"mkdir -p {_quote(path)}")

    def rm_rf(self, path: str) -> None:
        safe_path = _require_safe_recursive_delete_path(path)
        self.shell(f"rm -rf {_quote(safe_path)}")

    def write_text_file(self, path: str, content: str) -> None:
        parent = posixpath.dirname(path)
        self.shell(
            f"mkdir -p {_quote(parent)} && printf %s {_quote(content)} > {_quote(path)}"
        )

    def read_text_file(self, path: str) -> str:
        return self.shell(f"cat {_quote(path)}")

    def file_sha256(self, path: str) -> str | None:
        output = self.shell(f"sha256sum {_quote(path)}")
        if not output:
            return None
        return output.split()[0]

    def mv_file(self, src: str, dst: str) -> None:
        parent = posixpath.dirname(dst)
        self.shell(f"mkdir -p {_quote(parent)} && mv -f {_quote(src)} {_quote(dst)}")

    def zip_entries(self, path: str) -> list[str]:
        with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
            self._adb(["pull", path, tmp.name])
            with zipfile.ZipFile(tmp.name) as archive:
                return archive.namelist()

    def zip_member_sha256(self, path: str, member: str) -> str | None:
        with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
            self._adb(["pull", path, tmp.name])
            with zipfile.ZipFile(tmp.name) as archive:
                try:
                    data = archive.read(member)
                except KeyError:
                    return None
        return hashlib.sha256(data).hexdigest()

    def package_installed(self, package: str) -> bool:
        output = self.shell(f"pm path {_quote(package)} 2>/dev/null")
        return output.startswith("package:")

    def force_stop(self, package: str) -> None:
        self.shell(f"am force-stop {_quote(package)}")

    def current_app(self) -> dict[str, str]:
        window_output = self.shell("dumpsys window 2>/dev/null")
        parsed = _parse_foreground_app(window_output)
        if parsed:
            return parsed

        activity_output = self.shell("dumpsys activity top 2>/dev/null")
        parsed = _parse_foreground_app(activity_output)
        if parsed:
            return parsed

        raise RuntimeError("could not parse foreground app from dumpsys output")

    def ui_dump_xml(self) -> str:
        dump_path = f"/data/local/tmp/clawbench_uidump_{uuid.uuid4().hex}.xml"
        dump_error: BaseException | None = None
        try:
            return self.shell(
                f"uiautomator dump {_quote(dump_path)} >/dev/null "
                f"&& cat {_quote(dump_path)}"
            )
        except BaseException as exc:
            dump_error = exc
            raise
        finally:
            try:
                self.shell(f"rm -f {_quote(dump_path)}")
            except Exception:
                if dump_error is None:
                    raise

    def skill_runner_available(self) -> bool:
        return bool(os.environ.get("CLAWBENCH_SKILL_RUNNER"))

    def run_skill(
        self,
        skill_name: str,
        params: dict | None = None,
        skill_path: str | None = None,
    ) -> dict:
        runner = os.environ.get("CLAWBENCH_SKILL_RUNNER")
        if not runner:
            raise RuntimeError(
                "CLAWBENCH_SKILL_RUNNER is not set; cannot run benchmark skill"
            )
        payload = {
            "skill_name": skill_name,
            "skill_path": skill_path,
            "parameters": params or {},
        }
        command = [
            *shlex.split(runner),
            json.dumps(payload, ensure_ascii=False),
        ]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "skill runner failed with exit code "
                f"{completed.returncode}: {completed.stderr.strip()}"
            )
        if not completed.stdout.strip():
            return {"ok": True}
        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return {"ok": True, "stdout": completed.stdout.strip()}
        if isinstance(parsed, dict):
            return parsed
        return {"ok": True, "result": parsed}

    def content_query(
        self,
        uri: str,
        projection: tuple[str, ...] = (),
        where: str | None = None,
    ) -> list[dict[str, str]]:
        command = f"content query --uri {_quote(uri)}"
        if projection:
            command += f" --projection {_quote(':'.join(projection))}"
        if where:
            command += f" --where {_quote(where)}"
        output = self.shell(f"{command} 2>&1")
        _raise_on_content_error(output)
        return _parse_content_rows(output)

    def content_insert(
        self,
        uri: str,
        values: dict[str, tuple[str, str | int]],
    ) -> int:
        command = f"content insert --uri {_quote(uri)}"
        for key, (value_type, value) in values.items():
            command += f" --bind {_quote(f'{key}:{value_type}:{value}')}"
        output = self.shell(f"{command} 2>&1")
        _raise_on_content_error(output)
        if not output.strip():
            return -1
        return _parse_inserted_id(output)

    def content_delete(self, uri: str, where: str | None = None) -> int | None:
        command = f"content delete --uri {_quote(uri)}"
        if where:
            command += f" --where {_quote(where)}"
        output = self.shell(f"{command} 2>&1")
        _raise_on_content_error(output)
        return _parse_deleted_count(output)

    def contacts_provider_readable(self) -> bool:
        self.content_query("content://com.android.contacts/data", projection=("_id",))
        return True

    def create_contact(
        self,
        name: str,
        phone: str | None = None,
        email: str | None = None,
    ) -> int:
        raw_ids_before = set(self._raw_contact_ids())
        raw_id = self.content_insert(
            "content://com.android.contacts/raw_contacts",
            {"account_type": ("s", ""), "account_name": ("s", "")},
        )
        if raw_id < 0:
            raw_id = _new_raw_contact_id(raw_ids_before, self._raw_contact_ids())
        self.content_insert(
            "content://com.android.contacts/data",
            {
                "raw_contact_id": ("i", raw_id),
                "mimetype": ("s", "vnd.android.cursor.item/name"),
                "data1": ("s", name),
            },
        )
        if phone:
            self.add_contact_phone(raw_id, phone)
        if email:
            self.add_contact_email(raw_id, email)
        return raw_id

    def _raw_contact_ids(self) -> list[int]:
        rows = self.content_query(
            "content://com.android.contacts/raw_contacts",
            projection=("_id",),
        )
        return sorted(
            raw_id
            for row in rows
            if (raw_id := _parse_int(row.get("_id"))) is not None
        )

    def delete_contacts_by_name(self, name: str) -> None:
        for raw_id in self.contact_raw_ids_by_name(name):
            self.content_delete(
                "content://com.android.contacts/data",
                where=f"raw_contact_id={raw_id}",
            )
            self.content_delete(
                "content://com.android.contacts/raw_contacts",
                where=f"_id={raw_id}",
            )

    def contact_raw_ids_by_name(self, name: str) -> list[int]:
        rows = self.content_query(
            "content://com.android.contacts/data",
            projection=("raw_contact_id", "display_name", "data1"),
            where=f"display_name={_sql_quote(name)} OR data1={_sql_quote(name)}",
        )
        ids: set[int] = set()
        for row in rows:
            raw_id = _parse_int(row.get("raw_contact_id"))
            if raw_id is not None:
                ids.add(raw_id)
        return sorted(ids)

    def contact_count_by_name(self, name: str) -> int:
        return len(self.contact_raw_ids_by_name(name))

    def contact_phone_exists(self, name: str, phone: str) -> bool:
        return any(
            _normalize_phone(row.get("data1", "")) == _normalize_phone(phone)
            for row in self._contact_phone_rows(name=name)
        )

    def raw_contact_phone_exists(self, raw_id: int, phone: str) -> bool:
        return any(
            _normalize_phone(row.get("data1", "")) == _normalize_phone(phone)
            for row in self._contact_phone_rows(raw_id=raw_id)
        )

    def contact_email_exists(self, name: str, email: str) -> bool:
        return any(
            row.get("data1", "").lower() == email.lower()
            for row in self._contact_email_rows(name=name)
        )

    def raw_contact_email_exists(self, raw_id: int, email: str) -> bool:
        return any(
            row.get("data1", "").lower() == email.lower()
            for row in self._contact_email_rows(raw_id=raw_id)
        )

    def add_contact_phone(self, raw_id: int, phone: str) -> None:
        self.content_insert(
            "content://com.android.contacts/data",
            {
                "raw_contact_id": ("i", raw_id),
                "mimetype": ("s", "vnd.android.cursor.item/phone_v2"),
                "data1": ("s", phone),
                "data2": ("i", 2),
            },
        )

    def update_contact_phone(self, raw_id: int, phone: str) -> None:
        self.content_delete(
            "content://com.android.contacts/data",
            where=(
                f"raw_contact_id={raw_id} AND "
                "mimetype='vnd.android.cursor.item/phone_v2'"
            ),
        )
        self.add_contact_phone(raw_id, phone)

    def add_contact_email(self, raw_id: int, email: str) -> None:
        self.content_insert(
            "content://com.android.contacts/data",
            {
                "raw_contact_id": ("i", raw_id),
                "mimetype": ("s", "vnd.android.cursor.item/email_v2"),
                "data1": ("s", email),
                "data2": ("i", 1),
            },
        )

    def _contact_phone_rows(
        self,
        name: str | None = None,
        raw_id: int | None = None,
    ) -> list[dict[str, str]]:
        return self._contact_data_rows("vnd.android.cursor.item/phone_v2", name, raw_id)

    def _contact_email_rows(
        self,
        name: str | None = None,
        raw_id: int | None = None,
    ) -> list[dict[str, str]]:
        return self._contact_data_rows("vnd.android.cursor.item/email_v2", name, raw_id)

    def _contact_data_rows(
        self,
        mimetype: str,
        name: str | None,
        raw_id: int | None,
    ) -> list[dict[str, str]]:
        clauses = [f"mimetype={_sql_quote(mimetype)}"]
        if name is not None:
            clauses.append(f"display_name={_sql_quote(name)}")
        if raw_id is not None:
            clauses.append(f"raw_contact_id={raw_id}")
        return self.content_query(
            "content://com.android.contacts/data",
            projection=("raw_contact_id", "display_name", "mimetype", "data1"),
            where=" AND ".join(clauses),
        )

    def device_timezone(self) -> str:
        timezone = self.shell("getprop persist.sys.timezone")
        return timezone or "UTC"

    def writable_calendar_ids(self) -> list[int]:
        rows = self.content_query(
            "content://com.android.calendar/calendars",
            projection=("_id", "calendar_access_level", "visible"),
        )
        ids: list[int] = []
        for row in rows:
            calendar_id = _parse_int(row.get("_id"))
            access_level = _parse_int(row.get("calendar_access_level"))
            visible = row.get("visible")
            if (
                calendar_id is not None
                and access_level is not None
                and access_level >= 500
                and visible != "0"
            ):
                ids.append(calendar_id)
        return ids

    def create_calendar_event(
        self,
        title: str,
        start_ms: int,
        end_ms: int,
        timezone: str,
        calendar_id: int | None = None,
    ) -> int:
        if calendar_id is None:
            calendar_ids = self.writable_calendar_ids()
            if not calendar_ids:
                raise RuntimeError("no writable calendar is available")
            calendar_id = calendar_ids[0]
        return self.content_insert(
            "content://com.android.calendar/events",
            {
                "calendar_id": ("i", calendar_id),
                "title": ("s", title),
                "dtstart": ("l", start_ms),
                "dtend": ("l", end_ms),
                "eventTimezone": ("s", timezone),
            },
        )

    def delete_calendar_events_by_title(self, title: str) -> None:
        self.content_delete(
            "content://com.android.calendar/events",
            where=f"title={_sql_quote(title)}",
        )

    def calendar_events_by_title(self, title: str) -> list[dict[str, str]]:
        return self.content_query(
            "content://com.android.calendar/events",
            projection=("_id", "title", "dtstart", "dtend", "calendar_id"),
            where=f"title={_sql_quote(title)}",
        )

    def _adb_shell(self, args: list[str]) -> str:
        completed = self._adb(["shell", *args])
        return completed.stdout.strip()

    def _adb(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            ["adb", "-s", self.serial, *args],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=_adb_timeout_seconds(),
        )
        return completed


def _quote(value: str) -> str:
    return shlex.quote(value)


def _require_safe_recursive_delete_path(path: str) -> str:
    """Return a normalized allowlisted descendant path or fail closed."""

    if not isinstance(path, str) or not path or not posixpath.isabs(path):
        raise ValueError("recursive delete path must be a non-empty absolute path")
    if "\x00" in path or ".." in path.split("/"):
        raise ValueError("recursive delete path must not contain NUL or '..'")

    normalized = posixpath.normpath(path)
    for root in _ALLOWED_RECURSIVE_DELETE_ROOTS:
        if normalized.startswith(f"{root}/"):
            return normalized
    allowed = ", ".join(_ALLOWED_RECURSIVE_DELETE_ROOTS)
    raise ValueError(
        f"recursive delete path {path!r} is outside an allowed descendant; "
        f"allowed roots: {allowed}"
    )


def _parse_foreground_app(text: str) -> dict[str, str] | None:
    patterns = (
        r"mCurrentFocus=[^\n]*?\s([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)",
        r"mFocusedApp=[^\n]*?\s([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)",
        r"topResumedActivity=[^\n]*?\s([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)",
        r"ResumedActivity:[^\n]*?\s([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)",
        r"ACTIVITY\s+([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)",
    )
    for pattern in patterns:
        match = re.search(pattern, text or "")
        if not match:
            continue
        parsed = _parse_component(match.group(1))
        if parsed:
            return parsed
    return None


def _parse_component(component: str) -> dict[str, str] | None:
    cleaned = component.strip().rstrip(")}]")
    package, separator, activity = cleaned.partition("/")
    if not separator or not package or not activity:
        return None
    if activity.startswith("."):
        activity = f"{package}{activity}"
    return {
        "package": package,
        "activity": activity,
        "component": f"{package}/{activity}",
    }


def _sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _raise_on_content_error(output: str) -> None:
    lowered = output.lower()
    for marker in (
        "permission denial",
        "unknown url",
        "no content provider",
        "exception",
        "java.lang",
    ):
        if marker in lowered:
            raise RuntimeError(output)


def _parse_content_rows(output: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for line in output.splitlines():
        if not line.startswith("Row:"):
            continue
        parts = line.split(" ", 2)
        fields = parts[2] if len(parts) == 3 else ""
        record: dict[str, str] = {}
        for part in fields.split(","):
            key, separator, value = part.strip().partition("=")
            if separator:
                record[key.strip()] = value.strip()
        if record:
            records.append(record)
    return records


def _parse_inserted_id(output: str) -> int:
    for token in reversed(output.replace(":", " ").split()):
        parsed = _parse_int(token)
        if parsed is not None:
            return parsed
    raise RuntimeError(f"could not parse inserted row id from content output: {output}")


def _new_raw_contact_id(before: set[int], after: list[int]) -> int:
    created = sorted(set(after) - before)
    if created:
        return created[-1]
    if after:
        return after[-1]
    raise RuntimeError("could not determine inserted raw contact id")


def _parse_deleted_count(output: str) -> int | None:
    for token in output.replace(":", " ").split():
        parsed = _parse_int(token)
        if parsed is not None:
            return parsed
    return None


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _normalize_phone(value: str) -> str:
    return "".join(char for char in value if char.isdigit() or char == "+")
