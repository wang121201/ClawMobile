from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from phone_controller.environment import load_site
from phone_controller.services import PACKAGE_ROOT, PROXY_CLI, _matches_managed_identity


class ManagedServiceIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        example = json.loads((PACKAGE_ROOT / "phone" / "phone-site.example.json").read_text())
        with tempfile.TemporaryDirectory() as temp_dir:
            site_path = Path(temp_dir) / "phone-site.json"
            site_path.write_text(json.dumps(example), encoding="utf-8")
            self.site = load_site(site_path, check_executables=False)

    def record(self, kind: str, command: list[str], ticks: int | None = 123) -> dict:
        return {
            "schema_version": 2 if ticks is not None else 1,
            "record_type": "phone_native_managed_service",
            "kind": kind,
            "pid": 100,
            "proc_start_ticks": ticks,
            "command": command,
            "package_root": str(PACKAGE_ROOT),
        }

    def test_accepts_pinned_proxy_post_exec_identity(self) -> None:
        record = self.record("proxy", [self.site.node_executable, str(PROXY_CLI)])
        observed = [
            "/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1",
            "--library-path",
            "/data/data/com.termux/files/usr/glibc/lib",
            "/data/data/com.termux/files/home/.openclaw-android/node/bin/node.real",
            str(PROXY_CLI),
        ]
        self.assertTrue(_matches_managed_identity(self.site, "proxy", record, observed, 123))

    def test_accepts_pinned_gateway_post_exec_identity(self) -> None:
        command = [
            self.site.openclaw_executable,
            "gateway",
            "--bind",
            "loopback",
            "--port",
            "18789",
            "--verbose",
        ]
        record = self.record("gateway", command)
        observed = [
            "/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1",
            "--library-path",
            "/data/data/com.termux/files/usr/glibc/lib",
            "openclaw   ",
        ]
        self.assertTrue(_matches_managed_identity(self.site, "gateway", record, observed, 123))

    def test_rejects_pid_reuse_by_start_tick(self) -> None:
        record = self.record("proxy", [self.site.node_executable, str(PROXY_CLI)])
        observed = ["node.real", str(PROXY_CLI)]
        self.assertFalse(_matches_managed_identity(self.site, "proxy", record, observed, 124))

    def test_rejects_different_proxy_script(self) -> None:
        record = self.record("proxy", [self.site.node_executable, str(PROXY_CLI)], ticks=None)
        observed = ["node.real", str(PACKAGE_ROOT / "unrelated.js")]
        self.assertFalse(_matches_managed_identity(self.site, "proxy", record, observed, None))


if __name__ == "__main__":
    unittest.main()
