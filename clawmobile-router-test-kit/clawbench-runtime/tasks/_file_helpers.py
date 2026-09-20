from __future__ import annotations

import posixpath

from core.results import CheckResult
from core.preflight import PreflightCheckError, require_preflight



DOWNLOAD_DIR = "/sdcard/Download"

def download_path(*parts: str) -> str:
    if not parts:
        return DOWNLOAD_DIR
    for part in parts:
        if not isinstance(part, str) or not part:
            raise ValueError("Downloads path fragments must be non-empty strings")
        if posixpath.isabs(part) or "\\" in part:
            raise ValueError(f"Downloads path fragment must be relative: {part!r}")
        components = part.split("/")
        if any(component in {"", ".", ".."} for component in components):
            raise ValueError(
                f"Downloads path fragment contains an unsafe component: {part!r}"
            )

    path = posixpath.normpath(posixpath.join(DOWNLOAD_DIR, *parts))
    return _require_downloads_path(path, allow_root=False)


def write_text_file(device, path: str, content: str) -> None:
    device.write_text_file(_require_downloads_path(path), content)


def read_text_file(device, path: str) -> str | None:
    path = _require_downloads_path(path)
    if not device.path_exists(path):
        return None
    return device.read_text_file(path)


def path_exists(device, path: str) -> bool:
    return device.path_exists(_require_downloads_path(path))


def file_sha256(device, path: str) -> str | None:
    path = _require_downloads_path(path)
    if not device.path_exists(path):
        return None
    return device.file_sha256(path)


def mkdir_p(device, path: str) -> None:
    device.mkdir_p(_require_downloads_path(path))


def rm_rf(device, path: str) -> None:
    device.rm_rf(_require_downloads_path(path))


def mv_file(device, src: str, dst: str) -> None:
    device.mv_file(_require_downloads_path(src), _require_downloads_path(dst))


def _require_downloads_path(path: str, allow_root: bool = False) -> str:
    if not isinstance(path, str) or not path or not posixpath.isabs(path):
        raise ValueError("file task path must be a non-empty absolute path")
    if "\x00" in path or ".." in path.split("/"):
        raise ValueError("file task path must not contain NUL or '..'")

    normalized = posixpath.normpath(path)
    if normalized == DOWNLOAD_DIR:
        if allow_root:
            return normalized
        raise ValueError("file task path must be a descendant of Downloads")
    if not normalized.startswith(f"{DOWNLOAD_DIR}/"):
        raise ValueError(f"file task path escapes {DOWNLOAD_DIR}: {path!r}")
    return normalized


def add_file_exists_check(
    result: CheckResult,
    device,
    name: str,
    path: str,
    expected: bool = True,
    is_negative: bool = False,
) -> None:
    exists = path_exists(device, path)
    result.add(
        name,
        exists == expected,
        "filesystem",
        is_negative=is_negative,
        detail=f"path={path!r}, exists={exists}, expected={expected}",
    )


def add_hash_matches_check(
    result: CheckResult,
    device,
    name: str,
    path: str,
    expected_hash: str | None,
    is_negative: bool = False,
) -> None:
    actual_hash = file_sha256(device, path)
    result.add(
        name,
        actual_hash is not None and actual_hash == expected_hash,
        "filesystem",
        is_negative=is_negative,
        detail=f"path={path!r}, sha256={actual_hash!r}, expected={expected_hash!r}",
    )


def reply_mentions_path(reply: str | None, path: str) -> bool:
    if not reply:
        return False
    normalized = _normalize_reply(reply)
    return _normalize_path(path) in normalized


def _normalize_reply(reply: str) -> str:
    return reply.strip().strip("`'\"").replace("file://", "")


def _normalize_path(path: str) -> str:
    return path.replace("file://", "").rstrip("/")


def require_downloads_access(
    device,
    require_hash: bool = False,
    require_zip: bool = False,
) -> None:
    try:
        sdcard_accessible = device.path_exists("/sdcard")
    except Exception as exc:
        raise PreflightCheckError(
            f"Shared storage /sdcard is not accessible through the device wrapper: {exc}"
        ) from exc
    require_preflight(
        sdcard_accessible,
        "Shared storage /sdcard is not accessible through the device wrapper",
    )

    try:
        device.path_exists(DOWNLOAD_DIR)
    except Exception as exc:
        raise PreflightCheckError(
            f"Downloads path {DOWNLOAD_DIR} is not accessible through the device wrapper: {exc}"
        ) from exc

    if require_hash:
        require_preflight(
            _command_available(device, "sha256sum"),
            "sha256sum is not available for file hash verification",
        )
    if require_zip:
        require_preflight(
            hasattr(device, "zip_entries") and hasattr(device, "zip_member_sha256"),
            "Device wrapper does not support zip inspection",
        )


def _command_available(device, command: str) -> bool:
    checker = getattr(device, "command_available", None)
    if checker is None:
        return False
    try:
        return bool(checker(command))
    except Exception as exc:
        raise PreflightCheckError(
            f"Cannot check whether command {command!r} is available: {exc}"
        ) from exc
