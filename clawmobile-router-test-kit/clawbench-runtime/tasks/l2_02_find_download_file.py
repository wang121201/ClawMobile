from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    download_path,
    path_exists,
    reply_mentions_path,
    require_downloads_access,
    rm_rf,
)
from tasks._file_helpers import write_text_file


FIND_FILE_CONTENT = {
    "budget.txt": "CLAWBENCH_TARGET_BUDGET_7F3A",
    "recipe.txt": "CLAWBENCH_TARGET_RECIPE_9B2C",
}
FIND_FILE_DISTRACTORS = {
    "budget_draft.txt": "CLAWBENCH_DISTRACTOR_BUDGET",
    "recipe_old.txt": "CLAWBENCH_DISTRACTOR_RECIPE",
}


class L2_02_FindDownloadFile(Task):
    task_id = "L2-02"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.READ_ONLY
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"filename": filename} for filename in ("budget.txt", "recipe.txt")]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Find the file named {params['filename']} in Downloads and reply "
            "with only its full path"
        )

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)

    def setup(self, device, params: dict) -> None:
        for filename in _all_test_filenames(params):
            rm_rf(device, download_path(filename))
        write_text_file(
            device,
            download_path(params["filename"]),
            FIND_FILE_CONTENT[params["filename"]],
        )
        for filename, content in FIND_FILE_DISTRACTORS.items():
            write_text_file(device, download_path(filename), content)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        target_path = download_path(params["filename"])
        reply = (completed_run or {}).get("replyText")

        result.add(
            "target_file_exists",
            path_exists(device, target_path),
            "filesystem",
            detail=f"path={target_path!r}",
        )
        result.add(
            "reply_contains_target_path",
            reply_mentions_path(reply, target_path),
            "assistant_reply",
            detail=f"reply={reply!r}, expected={target_path!r}",
        )
        for distractor in FIND_FILE_DISTRACTORS:
            distractor_path = download_path(distractor)
            result.add(
                f"reply_omits_{distractor}",
                not reply_mentions_path(reply, distractor_path),
                "assistant_reply",
                is_negative=True,
                detail=f"reply={reply!r}, forbidden={distractor_path!r}",
            )
        return result

    def teardown(self, device, params: dict) -> None:
        for filename in _all_test_filenames(params):
            rm_rf(device, download_path(filename))


def _all_test_filenames(params: dict) -> tuple[str, ...]:
    return (*FIND_FILE_CONTENT.keys(), *FIND_FILE_DISTRACTORS.keys())
