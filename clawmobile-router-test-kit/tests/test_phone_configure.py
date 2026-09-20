from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from phone_controller.common import ContractError
from phone_controller.configure_phone import (
    _canonicalize_clawbench_paths,
    _link_clawbench_plugin,
)


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

    def test_links_canonical_channel_through_supported_openclaw_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            channel = Path(temporary) / "channel"
            channel.mkdir()
            with patch(
                "phone_controller.configure_phone.run_checked"
            ) as run_checked:
                _link_clawbench_plugin("/termux/bin/openclaw", channel)

            run_checked.assert_called_once_with(
                [
                    "/termux/bin/openclaw",
                    "plugins",
                    "install",
                    "--link",
                    str(channel.resolve()),
                ],
                timeout=60,
            )


if __name__ == "__main__":
    unittest.main()
