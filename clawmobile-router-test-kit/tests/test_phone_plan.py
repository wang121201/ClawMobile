from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from phone_controller.config_plan import PACKAGE_ROOT, build_plan, load_frozen_config


class PhonePlanTests(unittest.TestCase):
    def test_all_frozen_plans_match_manifest_counts(self) -> None:
        manifest = json.loads((PACKAGE_ROOT / "phone" / "frozen-configs.json").read_text())
        for entry in manifest["configs"]:
            with self.subTest(config=entry["file"]):
                config, _ = load_frozen_config(PACKAGE_ROOT / entry["file"])
                self.assertEqual(
                    len(build_plan(config, "Smoke")), entry["expected_cells"]["smoke"]
                )
                if entry["expected_cells"]["formal"]:
                    self.assertEqual(
                        len(build_plan(config, "Formal")),
                        entry["expected_cells"]["formal"],
                    )

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell parity check runs on release host")
    def test_python_plans_equal_original_powershell_plans(self) -> None:
        module = PACKAGE_ROOT / "five-group-v4" / "ExperimentCore.psm1"
        manifest = json.loads((PACKAGE_ROOT / "phone" / "frozen-configs.json").read_text())
        for entry in manifest["configs"]:
            path = PACKAGE_ROOT / entry["file"]
            config, _ = load_frozen_config(path)
            stages = ["Smoke"]
            if config["formal"]["matrix_cell_count"]:
                stages.append("Formal")
            for stage in stages:
                command = (
                    f"Import-Module '{module.as_posix()}' -Force; "
                    f"$c=Get-Content -LiteralPath '{path.as_posix()}' -Raw|ConvertFrom-Json; "
                    f"$p=@(Get-V4Plan -Config $c -Stage {stage}); "
                    "ConvertTo-Json -InputObject $p -Depth 20 -Compress"
                )
                result = subprocess.run(
                    ["pwsh", "-NoProfile", "-Command", command],
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                with self.subTest(config=path.name, stage=stage):
                    self.assertEqual(json.loads(result.stdout), build_plan(config, stage))


if __name__ == "__main__":
    unittest.main()
