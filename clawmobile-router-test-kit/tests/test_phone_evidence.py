from __future__ import annotations

import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from phone_controller.common import ContractError
from phone_controller.evidence import copy_file_verified, validate_capture


RUN_ID = "a" * 32
ARM_ID = "router-rm-dsv4-agent-dsv4-qwen36-logical-local"


def _raw_fields(text: str) -> dict:
    raw = text.encode("utf-8")
    return {
        "raw_response_base64": base64.b64encode(raw).decode("ascii"),
        "raw_response_bytes": len(raw),
        "raw_response_sha256": hashlib.sha256(raw).hexdigest(),
        "raw_response_text": text,
    }


class PhoneEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.calls = self.root / "model-calls.jsonl"
        self.events = self.root / "proxy-events.jsonl"
        records = [
            {
                "capture_sequence": 1,
                "session_id": RUN_ID,
                "arm_id": ARM_ID,
                "event": "proxy_request",
                "proxy_request_id": "req-1",
            },
            {
                "capture_sequence": 2,
                "session_id": RUN_ID,
                "arm_id": ARM_ID,
                "event": "model_call",
                "proxy_request_id": "req-1",
                "call_role": "router_helper",
                "service_role": "router_helper",
                "upstream_session_id": "router-session",
                "service_request_id": "svc-router",
                "attempt_index": 1,
                "response_status": 200,
                "capture_complete": True,
                **_raw_fields('{"ok":true}'),
            },
            {
                "capture_sequence": 3,
                "session_id": RUN_ID,
                "arm_id": ARM_ID,
                "event": "model_call",
                "proxy_request_id": "req-1",
                "call_role": "cloud_agent",
                "service_role": "cloud_agent",
                "upstream_session_id": "cloud-session",
                "service_request_id": "svc-cloud",
                "attempt_index": 1,
                "response_status": 200,
                "capture_complete": True,
                **_raw_fields('{"done":true}'),
            },
        ]
        event_rows = [
            {
                "session_id": RUN_ID,
                "arm_id": ARM_ID,
                "event": "router_decision",
                "request_id": "req-1",
                "route_policy_version": "g4-rm-moderate-action-v1",
                "predicted_route_class": "PERSIST_OR_SYSTEM_MUTATION",
                "final_backend": "cloud",
                "route_state": {
                    "semantics": "deterministic_projection_from_current_request_history_only",
                    "request_ordinal": 1,
                    "phase": "PRECHECK",
                },
            }
        ]
        self.calls.write_text(
            "".join(json.dumps(row) + "\n" for row in records), encoding="utf-8"
        )
        self.events.write_text(
            "".join(json.dumps(row) + "\n" for row in event_rows), encoding="utf-8"
        )

    def test_valid_capture(self) -> None:
        result = validate_capture(self.calls, self.events, RUN_ID, ARM_ID)
        self.assertTrue(result["structurally_healthy"])
        self.assertEqual(result["model_call_count"], 2)

    def test_detects_response_hash_mismatch(self) -> None:
        text = self.calls.read_text(encoding="utf-8").replace(
            hashlib.sha256(b'{"ok":true}').hexdigest(), "0" * 64
        )
        self.calls.write_text(text, encoding="utf-8")
        with self.assertRaisesRegex(ContractError, "sha256"):
            validate_capture(self.calls, self.events, RUN_ID, ARM_ID)

    def test_copy_is_exclusive_and_hash_verified(self) -> None:
        destination = self.root / "cell" / "model-calls.jsonl"
        result = copy_file_verified(self.calls, destination, self.root)
        self.assertEqual(result["sha256"], hashlib.sha256(self.calls.read_bytes()).hexdigest())
        with self.assertRaisesRegex(ContractError, "overwrite"):
            copy_file_verified(self.calls, destination, self.root)


if __name__ == "__main__":
    unittest.main()
