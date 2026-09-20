"""Per-run benchmark lifecycle."""

from __future__ import annotations

import hashlib
import json
import time
import traceback
import uuid
from dataclasses import asdict
from pathlib import Path

from core.completion import wait_for_run_completion
from core.outcome import FAILURE, INFRA_FAILURE, SUCCESS, TIMEOUT
from core.trigger import trigger
from core.preflight import PreflightCheckError


def run_one(task, params, seed, device, record_metadata: dict | None = None) -> dict:
    """Run one task parameterization and write one JSON result."""

    record = dict(record_metadata or {})
    record.setdefault("result_batch_id", uuid.uuid4().hex)
    record.update({
        "task_id": task.task_id,
        "device_serial": getattr(device, "serial", None),
        "params": params,
        "seed": seed,
        "layer": task.layer,
        "batch_fatal": False,
    })
    outcome = INFRA_FAILURE
    subchecks = None
    setup_started = False
    phase = "preflight"

    try:
        task.preflight(device, params)
        setup_started = True
        phase = "setup"
        task.setup(device, params)
        run_id = uuid.uuid4().hex
        record["run_id"] = run_id

        phase = "instruction"
        instruction = task.get_instruction(params)
        _append_chat_turn(record, "user", instruction)
        instruction_bytes = instruction.encode("utf-8")
        record["instruction_provenance"] = {
            "utf8_bytes": len(instruction_bytes),
            "sha256": hashlib.sha256(instruction_bytes).hexdigest(),
        }
        planned_sha256 = record.get("planned_instruction_sha256")
        if (
            planned_sha256 is not None
            and planned_sha256 != record["instruction_provenance"]["sha256"]
        ):
            raise RuntimeError(
                "task instruction does not match the persisted execution plan"
            )
        start = time.perf_counter()
        phase = "endpoint_trigger"
        trigger(instruction, run_id, device)

        # The capability benchmark intentionally imposes no outer task
        # deadline.  OpenClaw/ClawMobile keep their native runtime behavior.
        phase = "endpoint_poll"
        completed_run = wait_for_run_completion(run_id, timeout_s=0)
        status = str(completed_run.get("status", "TIMEOUT"))
        _record_agent_result_fields(record, completed_run)
        _record_clawbench_latency(record, start)

        if status == "COMPLETED":
            phase = "verifier"
            result = task.check(device, params, completed_run=completed_run)
            subchecks = [asdict(subcheck) for subcheck in result.subchecks]
            outcome = SUCCESS if result.passed else FAILURE
        elif status == "TIMEOUT":
            outcome = TIMEOUT
            _mark_batch_fatal(record, "agent_timeout")
        elif status == "FAILED":
            outcome = INFRA_FAILURE
            _mark_batch_fatal(record, "agent_failed")
        else:
            phase = "agent_status"
            raise RuntimeError(f"unexpected completion status: {status}")
    except PreflightCheckError as exc:
        outcome = INFRA_FAILURE
        record["preflight_failure_reason"] = str(exc)
        _mark_batch_fatal(record, "preflight_failure")
    except Exception as exc:
        outcome = INFRA_FAILURE
        record["exception"] = str(exc)
        record["traceback"] = traceback.format_exc()
        _mark_batch_fatal(record, f"{phase}_exception")
    finally:
        if setup_started:
            try:
                task.teardown(device, params)
            except Exception as exc:
                outcome = INFRA_FAILURE
                record["teardown_exception"] = str(exc)
                record["teardown_traceback"] = traceback.format_exc()
                _mark_batch_fatal(record, "teardown_exception")

    _record_results(record, outcome, subchecks)
    try:
        _write_record(record)
    except Exception as exc:
        outcome = INFRA_FAILURE
        record["result_write_exception"] = str(exc)
        record["result_write_traceback"] = traceback.format_exc()
        _mark_batch_fatal(record, "result_write_exception")
        _record_results(record, outcome, subchecks)
    return record


def _mark_batch_fatal(record: dict, reason: str) -> None:
    record["batch_fatal"] = True
    reasons = record.setdefault("batch_fatal_reasons", [])
    if reason not in reasons:
        reasons.append(reason)


def _record_agent_result_fields(record: dict, completed_run: dict) -> None:
    record["agent_run_status"] = dict(completed_run)
    field_mapping = {
        "error": "agent_error",
        "trajectory": "agent_trajectory",
        "tokenUsage": "agent_token_usage",
    }
    for source_key, record_key in field_mapping.items():
        if source_key in completed_run:
            record[record_key] = completed_run[source_key]
    if "replyText" in completed_run:
        _append_chat_turn(record, "assistant", completed_run["replyText"])
    openclaw_latency = completed_run.get("latency")
    if isinstance(openclaw_latency, dict) and "totalMs" in openclaw_latency:
        record.setdefault("latency", {})["openclaw_total_ms"] = openclaw_latency["totalMs"]


def _append_chat_turn(record: dict, role: str, content: str) -> None:
    history = record.setdefault("chatting_history", [])
    history.append({"turn": len(history) + 1, "role": role, "content": content})


def _record_clawbench_latency(record: dict, start: float) -> None:
    record.setdefault("latency", {})["clawbench_submit_to_completion_ms"] = round(
        (time.perf_counter() - start) * 1000
    )


def _record_results(record: dict, outcome: str, subchecks: list[dict] | None = None) -> None:
    results = {"outcome": outcome}
    if subchecks is not None:
        results["subchecks"] = subchecks
    record["results"] = results


def _write_record(record: dict) -> None:
    from core.result_store import store_result_record

    store_result_record(record)


def _write_json_record(output_path: Path, record: dict) -> None:
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
