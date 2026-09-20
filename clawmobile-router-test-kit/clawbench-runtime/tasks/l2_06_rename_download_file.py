from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    add_file_exists_check,
    add_hash_matches_check,
    download_path,
    file_sha256,
    require_downloads_access,
    rm_rf,
    write_text_file,
)


RENAME_FILE_CONTENT = "CLAWBENCH_RENAME_NOTE_CONTENT"


class L2_06_RenameDownloadFile(Task):
    task_id = "L2-06"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"old_name": "note.txt", "new_name": "renamed_note.txt"}]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Rename the file {params['old_name']} to {params['new_name']} "
            "in the Downloads folder"
        )

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device, require_hash=True)

    def setup(self, device, params: dict) -> None:
        old_path = download_path(params["old_name"])
        new_path = download_path(params["new_name"])
        rm_rf(device, old_path)
        rm_rf(device, new_path)
        write_text_file(device, old_path, RENAME_FILE_CONTENT)
        self._original_hash = file_sha256(device, old_path)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        old_path = download_path(params["old_name"])
        new_path = download_path(params["new_name"])

        add_file_exists_check(
            result,
            device,
            "old_file_removed",
            old_path,
            expected=False,
        )
        add_file_exists_check(result, device, "new_file_exists", new_path)
        add_hash_matches_check(
            result,
            device,
            "content_hash_preserved",
            new_path,
            getattr(self, "_original_hash", None),
        )
        return result

    def teardown(self, device, params: dict) -> None:
        rm_rf(device, download_path(params["old_name"]))
        rm_rf(device, download_path(params["new_name"]))
