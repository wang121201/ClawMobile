from __future__ import annotations

import re

from core.results import CheckResult
from tasks._file_helpers import download_path, path_exists, read_text_file, rm_rf
from tasks._ui_helpers import normalize_ui_text


def note_path(filename: str) -> str:
    return download_path(filename)


def delete_note(device, filename: str) -> None:
    rm_rf(device, note_path(filename))


def note_text(device, filename: str) -> str:
    return read_text_file(device, note_path(filename)) or ""


def add_note_exists_check(result: CheckResult, device, filename: str) -> None:
    path = note_path(filename)
    exists = path_exists(device, path)
    result.add(
        "note_exists",
        exists,
        "filesystem",
        detail=f"path={path!r}, exists={exists}",
    )


def add_keyword_group_text_checks(
    result: CheckResult,
    text: str,
    groups: tuple[tuple[str, ...], ...],
    name_prefix: str,
    mechanism: str = "filesystem_content",
) -> None:
    normalized = normalize_ui_text(text)
    for index, group in enumerate(groups, start=1):
        matches = [candidate for candidate in group if normalize_ui_text(candidate) in normalized]
        result.add(
            f"{name_prefix}_{index}",
            bool(matches),
            mechanism,
            detail=f"matches={matches!r}, candidates={group!r}",
        )


def add_word_count_check(
    result: CheckResult,
    text: str,
    minimum: int,
    maximum: int | None = None,
    name: str = "note_has_expected_length",
) -> None:
    words = re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?", text)
    passed = len(words) >= minimum and (maximum is None or len(words) <= maximum)
    result.add(
        name,
        passed,
        "filesystem_content",
        detail=f"word_count={len(words)}, minimum={minimum}, maximum={maximum}",
    )


def add_price_count_check(
    result: CheckResult,
    text: str,
    minimum: int = 2,
) -> None:
    prices = re.findall(r"(?:\$|AED\s*)?\d+(?:\.\d{2})?", text, flags=re.IGNORECASE)
    result.add(
        "two_prices_present",
        len(prices) >= minimum,
        "filesystem_content",
        detail=f"prices={prices!r}, minimum={minimum}",
    )
