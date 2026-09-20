from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    add_file_exists_check,
    download_path,
    mkdir_p,
    require_downloads_access,
    rm_rf,
    write_text_file,
)


class L2_09_MoveDescribedFile(Task):
    task_id = "L2-09"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {
                "instruction": (
                    "Move the important receipt from Downloads into the Receipts folder"
                ),
                "target": "important_receipt.pdf",
                "target_content": "IMPORTANT RECEIPT - move this one",
                "folder": "Receipts",
                "distractors": {
                    "old_receipt.pdf": "Old receipt to leave in Downloads",
                    "receipt_notes.txt": "Receipt notes to leave in Downloads",
                },
            },
            {
                "instruction": "Move the vacation photo from Downloads into PhotosToKeep",
                "target": "vacation_photo.jpg",
                "target_content": "VACATION PHOTO - move this one",
                "folder": "PhotosToKeep",
                "distractors": {
                    "work_photo.jpg": "Work photo to leave in Downloads",
                    "photo_readme.txt": "Photo notes to leave in Downloads",
                },
            },
        ]

    def get_instruction(self, params: dict) -> str:
        return str(params["instruction"])

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)

    def setup(self, device, params: dict) -> None:
        self._paths = [
            download_path(params["target"]),
            download_path(params["folder"], params["target"]),
            download_path(params["folder"]),
        ]
        rm_rf(device, download_path(params["folder"]))
        rm_rf(device, download_path(params["target"]))
        mkdir_p(device, download_path(params["folder"]))
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
            "target_moved_to_folder",
            download_path(params["folder"], params["target"]),
        )
        add_file_exists_check(
            result,
            device,
            "target_removed_from_downloads",
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
