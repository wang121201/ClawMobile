from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{8,128}$")


class ContractError(RuntimeError):
    """A fail-closed experiment contract violation."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def expand_path(raw: str, *, base: Path | None = None) -> Path:
    value = os.path.expandvars(os.path.expanduser(raw))
    path = Path(value)
    if not path.is_absolute():
        if base is None:
            raise ContractError(f"path must be absolute: {raw}")
        path = base / path
    return path.resolve()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def write_bytes_exclusive(path: Path, payload: bytes, mode: int = 0o600) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    except FileExistsError as exc:
        raise ContractError(f"refusing to overwrite existing evidence: {path}") from exc
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise OSError("exclusive write made no progress")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {"path": str(path), "bytes": len(payload), "sha256": sha256_file(path)}


def write_json_exclusive(path: Path, value: Any) -> dict[str, Any]:
    return write_bytes_exclusive(path, json_bytes(value))


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ContractError(f"JSON root must be an object: {path}")
    return value


def http_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    token: str | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise ContractError(f"{method} {url} returned HTTP {exc.code}: {text}") from exc
    except URLError as exc:
        raise ContractError(f"{method} {url} failed: {exc.reason}") from exc
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ContractError(f"{method} {url} returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise ContractError(f"{method} {url} returned a non-object JSON value")
    return value


def wait_http_json(
    url: str, *, predicate, timeout: float, interval: float = 0.25
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = http_json("GET", url, timeout=min(5.0, max(0.5, timeout)))
            if predicate(value):
                return value
        except Exception as exc:  # health probing intentionally retries until deadline
            last_error = exc
        time.sleep(interval)
    suffix = f": {last_error}" if last_error else ""
    raise ContractError(f"health check did not become ready for {url}{suffix}")


def run_checked(
    arguments: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            arguments,
            cwd=str(cwd) if cwd else None,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ContractError(f"command could not run: {arguments[0]}: {exc}") from exc
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()
        raise ContractError(
            f"command failed ({result.returncode}): {' '.join(arguments)}: {message}"
        )
    return result


def ensure_descendant(path: Path, root: Path, label: str) -> None:
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ContractError(f"{label} must remain under {root}: {path}") from exc
