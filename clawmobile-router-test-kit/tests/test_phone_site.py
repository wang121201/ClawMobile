from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from phone_controller.common import ContractError
from phone_controller.config_plan import PACKAGE_ROOT
from phone_controller.environment import load_site


class PhoneSiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.value = json.loads(
            (PACKAGE_ROOT / "phone" / "phone-site.example.json").read_text(encoding="utf-8")
        )

    def _write(self, value: dict) -> Path:
        directory = Path(tempfile.mkdtemp())
        path = directory / "phone-site.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_example_is_phone_native_and_has_no_ssh_dependency(self) -> None:
        site = load_site(
            PACKAGE_ROOT / "phone" / "phone-site.example.json",
            check_executables=False,
        )
        self.assertEqual(site.channel_url, "http://127.0.0.1:8765")
        self.assertEqual(site.gateway_url, "http://127.0.0.1:18789")
        self.assertEqual(site.proxy_url, "http://127.0.0.1:18081")

    def test_rejects_non_loopback_service(self) -> None:
        self.value["endpoints"]["proxy"] = "http://10.0.0.5:18081"
        with self.assertRaisesRegex(ContractError, "loopback"):
            load_site(self._write(self.value), check_executables=False)

    def test_rejects_host_or_ssh_keys(self) -> None:
        self.value["ssh_host"] = "10.127.121.62"
        with self.assertRaisesRegex(ContractError, "host-only"):
            load_site(self._write(self.value), check_executables=False)

    def test_rejects_windows_output_path(self) -> None:
        self.value["paths"]["output_root"] = "D:\\codexdataspace\\outputs"
        with self.assertRaises(ContractError):
            load_site(self._write(self.value), check_executables=False)


if __name__ == "__main__":
    unittest.main()
