from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from phone_controller.common import ContractError
from phone_controller.configure_phone import _canonicalize_clawbench_paths


class PhoneConfigureTests(unittest.TestCase):
    def test_replaces_only_other_clawbench_plugin_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            canonical = root / "canonical-channel"
            legacy = root / "legacy-channel"
            unrelated = root / "unrelated-plugin"
            for path in (canonical, legacy, unrelated):
                path.mkdir()
            (legacy / "openclaw.plugin.json").write_text(
                json.dumps({"id": "clawbench"}), encoding="utf-8"
            )
            (unrelated / "openclaw.plugin.json").write_text(
                json.dumps({"id": "mobile-ui"}), encoding="utf-8"
            )

            paths, removed = _canonicalize_clawbench_paths(
                [str(legacy), str(unrelated), str(canonical), str(legacy)], canonical
            )

            self.assertEqual(paths, [str(canonical.resolve()), str(unrelated)])
            self.assertEqual(removed, [str(legacy)])

    def test_rejects_non_string_plugin_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ContractError, "must be strings"):
                _canonicalize_clawbench_paths([42], Path(temporary))


if __name__ == "__main__":
    unittest.main()
