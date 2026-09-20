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


DELETE_FILE_CONTENT = {
    "old_note.txt": "CLAWBENCH_DELETE_OLD_NOTE",
    "temp_image.png": "CLAWBENCH_DELETE_TEMP_IMAGE",
}
DELETE_DISTRACTORS = {
    "keep_note.txt": "CLAWBENCH_KEEP_NOTE",
    "keep_image.png": "CLAWBENCH_KEEP_IMAGE",
}


class L2_04_DeleteDownloadFile(Task):
    task_id = "L2-04"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_DESTRUCTIVE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"filename": filename} for filename in DELETE_FILE_CONTENT]

    def get_instruction(self, params: dict) -> str:
        return f"Delete the file named {params['filename']}"

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device, require_hash=True)

    def setup(self, device, params: dict) -> None:
        for filename in (*DELETE_FILE_CONTENT.keys(), *DELETE_DISTRACTORS.keys()):
            rm_rf(device, download_path(filename))
        write_text_file(
            device,
            download_path(params["filename"]),
            DELETE_FILE_CONTENT[params["filename"]],
        )
        self._distractor_hashes = {}
        for filename, content in DELETE_DISTRACTORS.items():
            path = download_path(filename)
            write_text_file(device, path, content)
            self._distractor_hashes[filename] = file_sha256(device, path)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        target = download_path(params["filename"])
        add_file_exists_check(
            result,
            device,
            "target_deleted",
            target,
            expected=False,
        )
        for filename, expected_hash in getattr(self, "_distractor_hashes", {}).items():
            path = download_path(filename)
            add_file_exists_check(
                result,
                device,
                f"{filename}_still_exists",
                path,
                is_negative=True,
            )
            add_hash_matches_check(
                result,
                device,
                f"{filename}_unchanged",
                path,
                expected_hash,
                is_negative=True,
            )
        return result

    def teardown(self, device, params: dict) -> None:
        for filename in (*DELETE_FILE_CONTENT.keys(), *DELETE_DISTRACTORS.keys()):
            rm_rf(device, download_path(filename))
