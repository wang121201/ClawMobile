from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import require_downloads_access
from tasks._note_helpers import (
    add_keyword_group_text_checks,
    add_note_exists_check,
    add_word_count_check,
    delete_note,
    note_text,
)


TITLE_KEYWORD_GROUPS = {
    "Android automation tutorial": (
        ("Android",),
        ("automation", "automate", "automating"),
        ("tutorial", "guide", "course", "walkthrough"),
    ),
}


class L5_03_YoutubeToNote(Task):
    task_id = "L5-03"
    layer = "L5"
    M = ExecutionMode.MULTI_APP
    T = TaskLength.LONG
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "query": "Android automation tutorial",
                "filename": "youtube_result.txt",
            }
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Search YouTube for {params['query']} and save the title of the "
            f"first result in a note named {params['filename']} in Downloads."
        )

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)

    def setup(self, device, params: dict) -> None:
        delete_note(device, params["filename"])

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
            TITLE_KEYWORD_GROUPS[params["query"]],
            "title_keywords_present",
        )
        add_word_count_check(result, text, minimum=3, maximum=30)
        return result

    def teardown(self, device, params: dict) -> None:
        delete_note(device, params["filename"])
