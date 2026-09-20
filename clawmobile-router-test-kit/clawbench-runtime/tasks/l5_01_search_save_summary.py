from __future__ import annotations

from core.preflight import require_preflight
from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import download_path, path_exists, require_downloads_access
from tasks._note_helpers import (
    add_keyword_group_text_checks,
    add_note_exists_check,
    add_word_count_check,
    delete_note,
    note_text,
)


SUMMARY_KEYWORD_GROUPS = {
    "benefits of drinking water": (
        ("water",),
        ("hydration", "hydrate", "fluid"),
        ("health", "benefit", "energy", "digestion", "skin"),
    ),
}

SUMMARY_MINIMUM_WORDS = 12
SUMMARY_MAXIMUM_WORDS = 300


class L5_01_SearchSaveSummary(Task):
    task_id = "L5-01"
    layer = "L5"
    M = ExecutionMode.MULTI_APP
    T = TaskLength.LONG
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "topic": "benefits of drinking water",
                "filename": "water_summary.txt",
            }
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Search the web for {params['topic']} and save a short summary in "
            f"a note named {params['filename']} in Downloads."
        )

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)
        target = download_path(params["filename"])
        require_preflight(
            not path_exists(device, target),
            f"Refusing to overwrite existing benchmark target: {target}",
        )

    def setup(self, device, params: dict) -> None:
        pass

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        text = note_text(device, params["filename"])
        add_note_exists_check(result, device, params["filename"])
        add_keyword_group_text_checks(
            result,
            text,
            SUMMARY_KEYWORD_GROUPS[params["topic"]],
            "summary_keywords_present",
        )
        add_word_count_check(
            result,
            text,
            minimum=SUMMARY_MINIMUM_WORDS,
            maximum=SUMMARY_MAXIMUM_WORDS,
        )
        return result

    def teardown(self, device, params: dict) -> None:
        delete_note(device, params["filename"])
