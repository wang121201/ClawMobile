from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    add_file_exists_check,
    add_hash_matches_check,
    download_path,
    file_sha256,
    mkdir_p,
    require_downloads_access,
    rm_rf,
    write_text_file,
)


MOVE_FILE_CONTENT = {
    "receipt.pdf": "CLAWBENCH_RECEIPT_CONTENT",
    "photo1.jpg": "CLAWBENCH_PHOTO_CONTENT",
}


class L2_03_MoveDownloadFile(Task):
    task_id = "L2-03"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"filename": "receipt.pdf", "folder": "Receipts"},
            {"filename": "photo1.jpg", "folder": "PhotosToKeep"},
        ]

    def get_instruction(self, params: dict) -> str:
        return f"Move {params['filename']} into the folder {params['folder']}"

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device, require_hash=True)

    def setup(self, device, params: dict) -> None:
        src = download_path(params["filename"])
        dst_dir = download_path(params["folder"])
        rm_rf(device, src)
        rm_rf(device, dst_dir)
        mkdir_p(device, dst_dir)
        write_text_file(device, src, MOVE_FILE_CONTENT[params["filename"]])
        self._source_hash = file_sha256(device, src)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        src = download_path(params["filename"])
        dst = download_path(params["folder"], params["filename"])

        add_file_exists_check(result, device, "source_removed", src, expected=False)
        add_file_exists_check(result, device, "destination_exists", dst)
        add_hash_matches_check(
            result,
            device,
            "destination_hash_matches",
            dst,
            getattr(self, "_source_hash", None),
        )
        return result

    def teardown(self, device, params: dict) -> None:
        rm_rf(device, download_path(params["filename"]))
        rm_rf(device, download_path(params["folder"]))
