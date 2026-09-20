from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import download_path, file_sha256, mkdir_p, path_exists
from tasks._file_helpers import require_downloads_access, rm_rf, write_text_file


ZIP_FOLDER_FILES = {
    "overview.txt": "ClawBench project overview",
    "notes/todo.txt": "Review L2 zip task",
}


class L2_05_ZipDownloadFolder(Task):
    task_id = "L2-05"
    layer = "L2"
    M = ExecutionMode.SHELL
    T = TaskLength.MEDIUM
    R = RiskLevel.LOCAL_REVERSIBLE
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [{"folder": "ProjectDocs", "zipname": "project_docs.zip"}]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Compress the folder {params['folder']} into a zip file named "
            f"{params['zipname']}"
        )

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device, require_hash=True, require_zip=True)

    def setup(self, device, params: dict) -> None:
        folder = download_path(params["folder"])
        zip_path = download_path(params["zipname"])
        rm_rf(device, folder)
        rm_rf(device, zip_path)
        mkdir_p(device, folder)
        self._expected_hashes = {}
        for relative_path, content in ZIP_FOLDER_FILES.items():
            path = download_path(params["folder"], relative_path)
            write_text_file(device, path, content)
            self._expected_hashes[relative_path] = file_sha256(device, path)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        zip_path = download_path(params["zipname"])

        result.add(
            "zip_exists",
            path_exists(device, zip_path),
            "filesystem",
            detail=f"path={zip_path!r}",
        )
        entries = _read_zip_entries(device, zip_path)
        for relative_path, expected_hash in getattr(self, "_expected_hashes", {}).items():
            member = _find_zip_member(entries, params["folder"], relative_path)
            result.add(
                f"{relative_path}_in_zip",
                member is not None,
                "zip",
                detail=f"member={member!r}, entries={entries!r}",
            )
            actual_hash = (
                device.zip_member_sha256(zip_path, member)
                if member is not None
                else None
            )
            result.add(
                f"{relative_path}_hash_matches",
                actual_hash == expected_hash,
                "zip",
                detail=f"sha256={actual_hash!r}, expected={expected_hash!r}",
            )
        return result

    def teardown(self, device, params: dict) -> None:
        rm_rf(device, download_path(params["folder"]))
        rm_rf(device, download_path(params["zipname"]))


def _read_zip_entries(device, zip_path: str) -> list[str]:
    if not path_exists(device, zip_path):
        return []
    return device.zip_entries(zip_path)


def _find_zip_member(
    entries: list[str],
    folder: str,
    relative_path: str,
) -> str | None:
    candidates = (relative_path, f"{folder}/{relative_path}")
    for candidate in candidates:
        if candidate in entries:
            return candidate
    return None
