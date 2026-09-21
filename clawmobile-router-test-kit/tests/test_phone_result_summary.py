from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tools.summarize_core_ablation import SummaryError, find_formal_statuses, markdown, summarize


def write_cell(
    root: Path,
    plan: dict,
    *,
    run_id: str,
    success: bool,
    roles: list[str],
) -> Path:
    cell = root / plan["group_id"] / f"s{plan['schedule']:04d}"
    cell.mkdir(parents=True)
    records = []
    logical_count = roles.count("proxy_inbound")
    sequence = 1
    for index in range(logical_count):
        records.append(
            {
                "event": "proxy_request",
                "capture_sequence": sequence,
                "session_id": run_id,
                "arm_id": plan["arm_id"],
                "proxy_request_id": f"request-{index}",
            }
        )
        sequence += 1
    for index, role in enumerate(role for role in roles if role != "proxy_inbound"):
        records.append(
            {
                "event": "model_call",
                "capture_sequence": sequence,
                "session_id": run_id,
                "arm_id": plan["arm_id"],
                "call_role": role,
                "response_status": 200,
                "capture_complete": True,
                "service_request_id": f"service-{index}",
                "attempt_index": 1,
            }
        )
        sequence += 1
    capture = cell / "model-calls.jsonl"
    capture.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
    digest = hashlib.sha256(capture.read_bytes()).hexdigest()
    result_dir = cell / "json"
    result_dir.mkdir()
    result_file = result_dir / "result.json"
    outcome = "SUCCESS" if success else "FAILURE"
    result_file.write_text(
        json.dumps({"run_id": run_id, "results": {"outcome": outcome}}),
        encoding="utf-8",
    )
    result_digest = hashlib.sha256(result_file.read_bytes()).hexdigest()
    call_count = sum(1 for row in records if row["event"] == "model_call")
    status = {
        "stage": "formal",
        "schedule": plan["schedule"],
        "group_id": plan["group_id"],
        "arm_id": plan["arm_id"],
        "task_case": plan["task_case"],
        "repetition": plan["repetition"],
        "result_run_id": run_id,
        "session_id": run_id,
        "result_outcome": outcome,
        "classification": "primary_scored_success" if success else "primary_scored_failure",
        "experiment_infrastructure_failure": False,
        "capture_validation": {
            "structurally_healthy": True,
            "proxy_request_count": logical_count,
            "model_call_count": call_count,
            "accepted_local_call_count": 0,
        },
        "capture_files": [
            {
                "local_path": str(capture),
                "bytes": capture.stat().st_size,
                "sha256": digest,
            }
        ],
        "result_evidence": {
            "path": str(result_file),
            "sha256": result_digest,
        },
    }
    status_path = cell / "cell-status.json"
    status_path.write_text(json.dumps(status), encoding="utf-8")
    return status_path


class ResultSummaryTests(unittest.TestCase):
    def test_aggregates_success_and_physical_roles(self) -> None:
        expected = {
            ("G1", 1): {
                "group_id": "G1",
                "schedule": 1,
                "arm_id": "full-dsv4",
                "task_case": "L1-02:1",
                "repetition": 1,
                "config_file": "unified-five-group-experiment-v4.json",
                "config_sha256": "0" * 64,
            },
            ("G1", 2): {
                "group_id": "G1",
                "schedule": 2,
                "arm_id": "full-dsv4",
                "task_case": "L1-03:1",
                "repetition": 1,
                "config_file": "unified-five-group-experiment-v4.json",
                "config_sha256": "0" * 64,
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [
                write_cell(
                    root,
                    expected[("G1", 1)],
                    run_id="1" * 32,
                    success=True,
                    roles=["proxy_inbound", "cloud_agent"],
                ),
                write_cell(
                    root,
                    expected[("G1", 2)],
                    run_id="2" * 32,
                    success=False,
                    roles=["proxy_inbound", "cloud_agent"],
                ),
            ]
            result = summarize(expected, paths)
        row = result["groups"][0]
        self.assertEqual((row["success"], row["cells"]), (1, 2))
        self.assertEqual((row["logical_requests"], row["server_agent"]), (2, 2))
        self.assertEqual(row["physical_requests"], 2)
        self.assertIn("1/2, 50.0%", markdown(result))

    def test_duplicate_run_id_fails_closed(self) -> None:
        first = {
            "group_id": "G1",
            "schedule": 1,
            "arm_id": "full-dsv4",
            "task_case": "L1-02:1",
            "repetition": 1,
            "config_file": "unified-five-group-experiment-v4.json",
            "config_sha256": "0" * 64,
        }
        second = {**first, "schedule": 2, "task_case": "L1-03:1"}
        expected = {("G1", 1): first, ("G1", 2): second}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [
                write_cell(root, first, run_id="a" * 32, success=True, roles=["proxy_inbound", "cloud_agent"]),
                write_cell(root, second, run_id="a" * 32, success=True, roles=["proxy_inbound", "cloud_agent"]),
            ]
            with self.assertRaisesRegex(SummaryError, "reused"):
                summarize(expected, paths)

    def test_full_qwen_cloud_capture_is_attributed_to_local_agent(self) -> None:
        plan = {
            "group_id": "G5",
            "schedule": 1,
            "arm_id": "full-qwen36",
            "task_case": "L1-02:1",
            "repetition": 1,
            "config_file": "unified-five-group-experiment-v4.json",
            "config_sha256": "0" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = write_cell(
                Path(directory),
                plan,
                run_id="5" * 32,
                success=True,
                roles=["proxy_inbound", "cloud_agent"],
            )
            row = summarize({("G5", 1): plan}, [path])["groups"][0]
        self.assertEqual((row["local_agent"], row["server_agent"]), (1, 0))

    def test_explicit_segment_excludes_failed_stop_cell(self) -> None:
        first = {
            "group_id": "G1",
            "schedule": 1,
            "arm_id": "full-dsv4",
            "task_case": "L1-02:1",
            "repetition": 1,
            "config_file": "unified-five-group-experiment-v4.json",
            "config_sha256": "0" * 64,
        }
        failed = {**first, "schedule": 2, "task_case": "L1-03:1"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = write_cell(
                root,
                first,
                run_id="1" * 32,
                success=True,
                roles=["proxy_inbound", "cloud_agent"],
            )
            ignored = write_cell(
                root,
                failed,
                run_id="2" * 32,
                success=False,
                roles=["proxy_inbound", "cloud_agent"],
            )
            ignored_status = json.loads(ignored.read_text(encoding="utf-8"))
            ignored_status["classification"] = "experiment_infrastructure_failure"
            ignored_status["experiment_infrastructure_failure"] = True
            ignored.write_text(json.dumps(ignored_status), encoding="utf-8")
            paths = find_formal_statuses([], [(root, 1, 1)])
            self.assertEqual(paths, [selected])
            result = summarize({("G1", 1): first}, paths)
        self.assertEqual(result["groups"][0]["success"], 1)


if __name__ == "__main__":
    unittest.main()
