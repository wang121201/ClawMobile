from __future__ import annotations

import re

from core.preflight import require_preflight
from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._settings_helpers import parse_int, run_best_effort_shell


MEDIA_STREAM = 3
DEFAULT_MEDIA_MAX_VOLUME = 25


class L1_09_MediaVolume(Task):
    task_id = "L1-09"
    layer = "L1"
    M = ExecutionMode.SETTINGS_CALL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"instruction": "Set media volume to low", "percent": 25},
            {"instruction": "Set media volume to medium", "percent": 50},
            {"instruction": "Set media volume to high", "percent": 75},
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_preflight(
            _read_media_volume(device) is not None,
            "Media volume is not readable through cmd audio or system volume_music",
        )

    def setup(self, device, params: dict) -> None:
        self._original_volume = _read_media_volume(device)
        max_volume = _read_media_max_volume(device)
        target = _volume_for_percent(max_volume, int(params["percent"]))
        initial = 0 if target > max_volume // 2 else max_volume
        _set_media_volume(device, initial)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        max_volume = _read_media_max_volume(device)
        target = _volume_for_percent(max_volume, int(params["percent"]))

        volume = _read_media_volume(device)
        result.add(
            "media_volume_matches",
            volume is not None and abs(volume - target) <= 1,
            "audio_manager",
            detail=f"value={volume!r}, target={target}, max={max_volume}",
        )

        muted = _read_media_muted(device)
        result.add(
            "media_volume_not_muted",
            muted is not True,
            "audio_manager",
            is_negative=True,
            detail=f"value={muted!r}",
        )
        return result

    def teardown(self, device, params: dict) -> None:
        original = getattr(self, "_original_volume", None)
        _set_media_volume(device, original if original is not None else 7)


def _set_media_volume(device, volume: int) -> None:
    run_best_effort_shell(device, f"cmd audio set-volume {MEDIA_STREAM} {volume}")
    device.put_setting("system", "volume_music", volume)


def _read_media_volume(device) -> int | None:
    output = run_best_effort_shell(
        device,
        f"cmd audio get-stream-volume {MEDIA_STREAM}",
    )
    parsed = _last_int(output)
    if parsed is not None:
        return parsed
    return parse_int(device.get_setting("system", "volume_music"))


def _read_media_max_volume(device) -> int:
    output = run_best_effort_shell(device, f"cmd audio get-max-volume {MEDIA_STREAM}")
    return _last_int(output) or DEFAULT_MEDIA_MAX_VOLUME


def _read_media_muted(device) -> bool | None:
    output = run_best_effort_shell(device, f"cmd audio is-stream-mute {MEDIA_STREAM}")
    normalized = output.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    return None


def _volume_for_percent(max_volume: int, percent: int) -> int:
    return round(max_volume * percent / 100)


def _last_int(value: str) -> int | None:
    matches = re.findall(r"-?\d+", value)
    if not matches:
        return None
    return int(matches[-1])
