from __future__ import annotations

from core.results import CheckResult
from core.preflight import PreflightCheckError, require_preflight


COMMON_DISPLAY_SETTINGS = (
    "screen_brightness",
    "screen_brightness_mode",
    "screen_off_timeout",
    "font_scale",
    "display_color_mode",
    "accelerometer_rotation",
)


def parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def snapshot_settings(
    device,
    settings: tuple[tuple[str, str], ...],
) -> dict[tuple[str, str], str | None]:
    return {
        (namespace, key): device.get_setting(namespace, key)
        for namespace, key in settings
    }


def snapshot_display_settings(
    device,
    exclude: tuple[str, ...] = (),
) -> dict[tuple[str, str], str | None]:
    excluded = set(exclude)
    return snapshot_settings(
        device,
        tuple(
            ("system", key)
            for key in COMMON_DISPLAY_SETTINGS
            if key not in excluded
        ),
    )


def add_unchanged_setting_checks(
    result: CheckResult,
    device,
    snapshot: dict[tuple[str, str], str | None],
) -> None:
    for (namespace, key), expected in snapshot.items():
        actual = device.get_setting(namespace, key)
        result.add(
            f"{key}_unchanged",
            actual == expected,
            "settings",
            is_negative=True,
            detail=f"value={actual!r}, expected={expected!r}",
        )


def run_best_effort_shell(device, command: str) -> str:
    return device.shell(f"{command} 2>/dev/null || true")


def require_readable_settings(
    device,
    settings: tuple[tuple[str, str], ...],
) -> None:
    for namespace, key in settings:
        try:
            value = device.get_setting(namespace, key)
        except Exception as exc:
            raise PreflightCheckError(
                f"Android setting {namespace}.{key} is not readable: {exc}"
            ) from exc
        require_preflight(
            value is not None,
            f"Android setting {namespace}.{key} is not readable",
        )
