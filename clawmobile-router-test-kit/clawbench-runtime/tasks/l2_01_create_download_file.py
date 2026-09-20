from __future__ import annotations

from core.preflight import require_preflight
from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import (
    download_path,
    path_exists,
    read_text_file,
    require_downloads_access,
    rm_rf,
)


class L2_01_CreateDownloadFile(Task):
    task_id = "L2-01"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.SHORT
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"filename": "todo.txt", "content": "Buy milk"},
            {"filename": "meeting_note.txt", "content": "Discuss ClawBench tasks"},
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Create a text file named {params['filename']} in Downloads "
            f"containing: {params['content']}"
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
        path = download_path(params["filename"])
        content = read_text_file(device, path)

        result.add(
            "file_exists",
            path_exists(device, path),
            "filesystem",
            detail=f"path={path!r}",
        )
        result.add(
            "content_matches",
            content == params["content"],
            "filesystem",
            detail=f"value={content!r}, expected={params['content']!r}",
        )
        return result

    def teardown(self, device, params: dict) -> None:
        rm_rf(device, download_path(params["filename"]))
