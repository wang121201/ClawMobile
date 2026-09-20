from __future__ import annotations

import re

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    download_path,
    path_exists,
    read_text_file,
    require_downloads_access,
    rm_rf,
)


class L2_07_CreateQualitativeNote(Task):
    task_id = "L2-07"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": (
                    "Create a short packing checklist named trip_checklist.txt "
                    "in Downloads"
                ),
                "filename": "trip_checklist.txt",
                "keywords": (
                    "charger",
                    "toothbrush",
                    "passport",
                    "clothes",
                    "wallet",
                    "medicine",
                    "shoes",
                ),
                "minimum_matches": 3,
            },
            {
                "instruction": (
                    "Create a simple grocery list named groceries.txt in Downloads"
                ),
                "filename": "groceries.txt",
                "keywords": (
                    "milk",
                    "eggs",
                    "bread",
                    "fruit",
                    "rice",
                    "coffee",
                    "apples",
                ),
                "minimum_matches": 3,
            },
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)

    def setup(self, device, params: dict) -> None:
        rm_rf(device, download_path(params["filename"]))

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        path = download_path(params["filename"])
        content = read_text_file(device, path) or ""
        normalized = content.lower()
        matched = [
            keyword for keyword in params["keywords"] if keyword in normalized
        ]

        result.add(
            "note_exists",
            path_exists(device, path),
            "filesystem",
            detail=f"path={path!r}",
        )
        result.add(
            "note_has_relevant_items",
            len(matched) >= int(params["minimum_matches"]),
            "filesystem_content",
            detail=(
                f"matches={matched!r}, minimum={params['minimum_matches']}, "
                f"keywords={params['keywords']!r}"
            ),
        )

        word_count = len(re.findall(r"\b[\w'-]+\b", content))
        result.add(
            "note_is_short",
            3 <= word_count <= 80,
            "filesystem_content",
            detail=f"word_count={word_count}, minimum=3, maximum=80",
        )
        return result

    def teardown(self, device, params: dict) -> None:
        rm_rf(device, download_path(params["filename"]))
