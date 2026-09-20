from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    add_file_exists_check,
    download_path,
    require_downloads_access,
    rm_rf,
    write_text_file,
)


class L2_08_DeleteDescribedFile(Task):
    task_id = "L2-08"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_DESTRUCTIVE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": "Delete the outdated draft note from Downloads",
                "target": "old_draft.txt",
                "target_content": "OUTDATED DRAFT - remove this note",
                "distractors": {
                    "current_draft.txt": "CURRENT DRAFT - keep this note",
                    "draft_archive.txt": "Archived draft notes to keep",
                },
            },
            {
                "instruction": "Delete the temporary scratch note from Downloads",
                "target": "scratch_note_tmp.txt",
                "target_content": "Temporary scratch note - safe to delete",
                "distractors": {
                    "project_note.txt": "Permanent project note to keep",
                    "scratch_reference.txt": "Reference scratch material to keep",
                },
            },
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)

    def setup(self, device, params: dict) -> None:
        self._paths = [download_path(params["target"])]
        rm_rf(device, download_path(params["target"]))
        write_text_file(
            device,
            download_path(params["target"]),
            params["target_content"],
        )
        for filename, content in params["distractors"].items():
            self._paths.append(download_path(filename))
            rm_rf(device, download_path(filename))
            write_text_file(device, download_path(filename), content)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        add_file_exists_check(
            result,
            device,
            "target_deleted",
            download_path(params["target"]),
            expected=False,
        )
        for filename in params["distractors"]:
            add_file_exists_check(
                result,
                device,
                f"{filename}_preserved",
                download_path(filename),
                expected=True,
                is_negative=True,
            )
        return result

    def teardown(self, device, params: dict) -> None:
        for path in getattr(self, "_paths", []):
            rm_rf(device, path)
