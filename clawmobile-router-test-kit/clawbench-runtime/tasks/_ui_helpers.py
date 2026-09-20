from __future__ import annotations

import html
from pathlib import Path

from core.preflight import PreflightCheckError, require_preflight
from core.results import CheckResult


YOUTUBE_PACKAGE = "com.google.android.youtube"
MAPS_PACKAGE = "com.google.android.apps.maps"
AMAZON_PACKAGE = "com.amazon.mShop.android.shopping"
AMAZON_PACKAGE_CANDIDATES = (
    AMAZON_PACKAGE,
    "com.amazon.mShop.android",
)
AMAZON_OPEN_CART_SKILL = "amazon_open_cart"
AMAZON_CLEAR_SEARCH_HISTORY_SKILL = "amazon_clear_search_history"
TOOL_SKILLS_DIR = Path(__file__).resolve().parents[1] / "tool_skills"


def require_app_ui_access(device, package: str, app_name: str) -> None:
    _require_methods(
        device,
        (
            "package_installed",
            "current_app",
            "ui_dump_xml",
            "force_stop",
        ),
        f"{app_name} UI verification",
    )
    try:
        installed = device.package_installed(package)
    except Exception as exc:
        raise PreflightCheckError(
            f"Cannot check whether {app_name} package {package} is installed: {exc}"
        ) from exc
    require_preflight(installed, f"{app_name} package {package} is not installed")

    try:
        xml = device.ui_dump_xml()
    except Exception as exc:
        raise PreflightCheckError(
            f"uiautomator dump is not available for {app_name} verification: {exc}"
        ) from exc
    require_preflight(bool(xml.strip()), "uiautomator dump returned empty UI XML")


def require_any_app_ui_access(
    device,
    packages: tuple[str, ...],
    app_name: str,
) -> str:
    _require_methods(
        device,
        (
            "package_installed",
            "current_app",
            "ui_dump_xml",
            "force_stop",
        ),
        f"{app_name} UI verification",
    )
    installed_package = resolve_installed_package(device, packages, app_name)

    try:
        xml = device.ui_dump_xml()
    except Exception as exc:
        raise PreflightCheckError(
            f"uiautomator dump is not available for {app_name} verification: {exc}"
        ) from exc
    require_preflight(bool(xml.strip()), "uiautomator dump returned empty UI XML")
    return installed_package


def resolve_installed_package(
    device,
    packages: tuple[str, ...],
    app_name: str,
) -> str:
    errors: list[str] = []
    for package in packages:
        try:
            installed = device.package_installed(package)
        except Exception as exc:
            errors.append(f"{package}: {exc}")
            continue
        if installed:
            return package

    checked = ", ".join(packages)
    if errors:
        raise PreflightCheckError(
            f"Cannot check whether any {app_name} package is installed; "
            f"checked packages: {checked}; errors: {'; '.join(errors)}"
        )
    raise PreflightCheckError(
        f"{app_name} package is not installed; checked packages: {checked}"
    )


def require_skill_access(device, skill_name: str) -> None:
    _require_methods(device, ("skill_runner_available", "run_skill"), "skill runner")
    skill_path = tool_skill_path(skill_name)
    require_preflight(
        skill_path.exists(),
        f"required tool skill {skill_name!r} is missing at {skill_path}",
    )
    try:
        available = device.skill_runner_available()
    except Exception as exc:
        raise PreflightCheckError(f"Cannot check skill runner availability: {exc}") from exc
    require_preflight(
        available,
        "CLAWBENCH_SKILL_RUNNER is not configured, so benchmark skills cannot run",
    )


def require_shell_access(device, purpose: str) -> None:
    _require_methods(device, ("shell",), purpose)


def run_tool_skill(device, skill_name: str, params: dict | None = None) -> dict:
    return device.run_skill(
        skill_name,
        params or {},
        skill_path=str(tool_skill_path(skill_name)),
    )


def tool_skill_path(skill_name: str) -> Path:
    return TOOL_SKILLS_DIR / f"{skill_name}.md"


def force_stop_if_supported(device, package: str) -> None:
    force_stop = getattr(device, "force_stop", None)
    if force_stop is not None:
        force_stop(package)


def force_stop_packages_if_supported(device, packages: tuple[str, ...]) -> None:
    for package in packages:
        force_stop_if_supported(device, package)


def add_foreground_package_check(
    result: CheckResult,
    device,
    expected_package: str,
    app_name: str,
) -> dict[str, str] | None:
    try:
        current = device.current_app()
    except Exception as exc:
        result.add(
            "foreground_app_available",
            False,
            "dumpsys",
            detail=f"expected={expected_package!r}, error={exc}",
        )
        return None

    actual_package = str(current.get("package", ""))
    result.add(
        "foreground_app_matches",
        actual_package == expected_package,
        "dumpsys",
        detail=(
            f"app={app_name!r}, package={actual_package!r}, "
            f"expected={expected_package!r}, current={current!r}"
        ),
    )
    return current


def add_foreground_package_in_check(
    result: CheckResult,
    device,
    expected_packages: tuple[str, ...],
    app_name: str,
) -> dict[str, str] | None:
    try:
        current = device.current_app()
    except Exception as exc:
        result.add(
            "foreground_app_available",
            False,
            "dumpsys",
            detail=f"expected_any={expected_packages!r}, error={exc}",
        )
        return None

    actual_package = str(current.get("package", ""))
    result.add(
        "foreground_app_matches",
        actual_package in expected_packages,
        "dumpsys",
        detail=(
            f"app={app_name!r}, package={actual_package!r}, "
            f"expected_any={expected_packages!r}, current={current!r}"
        ),
    )
    return current


def dump_ui_for_check(result: CheckResult, device) -> str:
    try:
        xml = device.ui_dump_xml()
    except Exception as exc:
        result.add(
            "ui_dump_available",
            False,
            "uiautomator",
            detail=f"error={exc}",
        )
        return ""

    result.add(
        "ui_dump_available",
        bool(xml.strip()),
        "uiautomator",
        detail=f"xml_length={len(xml)}",
    )
    return xml


def add_ui_contains_any_check(
    result: CheckResult,
    name: str,
    xml: str,
    candidates: tuple[str, ...],
    mechanism: str = "a11y_tree",
    is_negative: bool = False,
) -> None:
    matches = matching_texts(xml, candidates)
    result.add(
        name,
        bool(matches),
        mechanism,
        is_negative=is_negative,
        detail=f"matches={matches!r}, candidates={candidates!r}",
    )


def add_ui_omits_any_check(
    result: CheckResult,
    name: str,
    xml: str,
    forbidden: tuple[str, ...],
    mechanism: str = "a11y_tree",
) -> None:
    matches = matching_texts(xml, forbidden)
    result.add(
        name,
        not matches,
        mechanism,
        is_negative=True,
        detail=f"matches={matches!r}, forbidden={forbidden!r}",
    )


def add_keyword_group_checks(
    result: CheckResult,
    xml: str,
    groups: tuple[tuple[str, ...], ...],
    name_prefix: str,
) -> None:
    for index, group in enumerate(groups, start=1):
        matches = matching_texts(xml, group)
        result.add(
            f"{name_prefix}_{index}",
            bool(matches),
            "a11y_tree",
            detail=f"matches={matches!r}, candidates={group!r}",
        )


def matching_texts(xml: str, candidates: tuple[str, ...]) -> list[str]:
    normalized = normalize_ui_text(xml)
    return [
        candidate
        for candidate in candidates
        if normalize_ui_text(candidate) in normalized
    ]


def normalize_ui_text(value: str) -> str:
    return " ".join(html.unescape(value or "").replace("-", " ").lower().split())


def _require_methods(device, method_names: tuple[str, ...], purpose: str) -> None:
    missing = [name for name in method_names if not hasattr(device, name)]
    require_preflight(
        not missing,
        f"Device wrapper lacks {purpose} method(s): {', '.join(missing)}",
    )
