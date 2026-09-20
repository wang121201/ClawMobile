from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .common import (
    ContractError,
    RUN_ID_RE,
    ensure_descendant,
    http_json,
    sha256_file,
)
from .environment import Site


def wait_proxy_capture(site: Site, run_id: str) -> dict[str, Any]:
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise ContractError(f"invalid result.run_id: {run_id}")
    deadline = time.monotonic() + site.capture_flush_seconds
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        health = http_json("GET", f"{site.proxy_url}/health?run_id={run_id}")
        capture = health.get("capture")
        if isinstance(capture, dict):
            last = capture
            if (
                capture.get("pending") == 0
                and capture.get("errors") == 0
                and int(capture.get("record_count", 0)) > 0
                and capture.get("record_count") == capture.get("durable_record_count")
                and capture.get("model_call_count")
                == capture.get("durable_model_call_count")
            ):
                return health
        time.sleep(0.25)
    raise ContractError(
        f"Proxy capture did not durably flush within {site.capture_flush_seconds}s: {last}"
    )


def copy_file_verified(source: Path, destination: Path, allowed_root: Path) -> dict[str, Any]:
    source = source.resolve()
    destination = destination.resolve()
    ensure_descendant(source, allowed_root.resolve(), "capture source")
    if source.is_symlink() or not source.is_file():
        raise ContractError(f"capture source must be a regular non-symlink file: {source}")
    if destination.exists():
        raise ContractError(f"refusing to overwrite capture evidence: {destination}")
    source_bytes = source.stat().st_size
    source_hash = sha256_file(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(destination, flags, 0o600)
    try:
        with source.open("rb") as input_stream, os.fdopen(descriptor, "wb", closefd=False) as output:
            shutil.copyfileobj(input_stream, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(descriptor)
    destination_hash = sha256_file(destination)
    destination_bytes = destination.stat().st_size
    if destination_bytes != source_bytes or destination_hash != source_hash:
        raise ContractError(f"capture copy differs from source: {source}")
    return {
        "source_path": str(source),
        "local_path": str(destination),
        "bytes": destination_bytes,
        "sha256": destination_hash,
    }


def copy_capture(site: Site, run_id: str, cell_root: Path) -> list[dict[str, Any]]:
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise ContractError(f"invalid result.run_id: {run_id}")
    source_root = site.capture_root / run_id
    return [
        copy_file_verified(
            source_root / "model-calls.jsonl",
            cell_root / "model-calls.jsonl",
            site.capture_root,
        ),
        copy_file_verified(
            source_root / "proxy-events.jsonl",
            cell_root / "proxy-events.jsonl",
            site.capture_root,
        ),
    ]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ContractError(f"cannot read capture {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ContractError(f"invalid JSONL at {path}:{line_number}") from exc
        if not isinstance(value, dict):
            raise ContractError(f"capture row is not an object at {path}:{line_number}")
        rows.append(value)
    if not rows:
        raise ContractError(f"capture is empty: {path}")
    return rows


def _raw_response(record: dict[str, Any]) -> None:
    if "raw_response_base64" not in record:
        return
    try:
        raw = base64.b64decode(record["raw_response_base64"], validate=True)
    except Exception as exc:
        raise ContractError("raw_response_base64 is invalid") from exc
    if len(raw) != int(record.get("raw_response_bytes", -1)):
        raise ContractError("raw_response_bytes mismatch")
    if hashlib.sha256(raw).hexdigest() != record.get("raw_response_sha256"):
        raise ContractError("raw_response_sha256 mismatch")
    if raw.decode("utf-8") != record.get("raw_response_text"):
        raise ContractError("raw_response_text mismatch")


def _count(rows: list[dict[str, Any]], event: str) -> int:
    return sum(1 for row in rows if row.get("event") == event)


def validate_capture(
    model_calls_path: Path,
    proxy_events_path: Path,
    run_id: str,
    arm_id: str,
) -> dict[str, Any]:
    records = _read_jsonl(model_calls_path)
    events = _read_jsonl(proxy_events_path)
    sequences = [int(record.get("capture_sequence", -1)) for record in records]
    if sequences != list(range(1, len(records) + 1)):
        raise ContractError("capture_sequence is not contiguous from one")
    for record in records:
        if record.get("session_id") != run_id:
            raise ContractError("model capture session_id differs from result.run_id")
        if record.get("arm_id") != arm_id:
            raise ContractError("model capture arm_id differs from plan")
        _raw_response(record)
    for event in events:
        if event.get("session_id") != run_id or event.get("arm_id") != arm_id:
            raise ContractError("Proxy event identity differs from Cell")

    inbound = [row for row in records if row.get("event") == "proxy_request"]
    calls = [row for row in records if row.get("event") == "model_call"]
    if not inbound or not calls:
        raise ContractError("capture lacks proxy_request or model_call records")
    for call in calls:
        if "transport_error" in call:
            raise ContractError("capture contains provider transport failure")
        status = int(call.get("response_status", 0))
        if status < 200 or status >= 300:
            raise ContractError(f"capture contains provider HTTP {status}")
        if call.get("capture_complete") is not True:
            raise ContractError("capture contains incomplete raw response")
        if "The model is starting up" in str(call.get("raw_response_text", "")):
            raise ContractError("capture contains model-starting placeholder")
        if call.get("service_request_id") in {None, ""}:
            raise ContractError("physical model call lacks service_request_id")
        if not isinstance(call.get("attempt_index"), int) or call["attempt_index"] < 1:
            raise ContractError("physical model call has invalid attempt_index")

    service_request_ids = [str(call["service_request_id"]) for call in calls]
    if len(set(service_request_ids)) != len(service_request_ids):
        raise ContractError("physical retries do not have unique service_request_id values")
    attempts: dict[tuple[str, str], list[int]] = defaultdict(list)
    for call in calls:
        key = (str(call.get("proxy_request_id", "")), str(call.get("call_role", "")))
        attempts[key].append(int(call["attempt_index"]))
    for attempt_key, indexes in attempts.items():
        if sorted(indexes) != list(range(1, len(indexes) + 1)):
            raise ContractError(
                f"attempt_index is not contiguous for request/role {attempt_key}"
            )

    expected_roles: list[str]
    if arm_id.startswith("full-xmu-"):
        expected_roles = ["local_agent"]
    elif arm_id.startswith("full-"):
        expected_roles = ["cloud_agent"]
    elif arm_id.startswith("filter-"):
        expected_roles = ["filter_helper", "cloud_agent"]
    elif arm_id.startswith("router-explicit-binary-tool-"):
        expected_roles = []
    elif arm_id.startswith("router-"):
        expected_roles = ["router_helper"]
    else:
        raise ContractError(f"unknown v4 arm: {arm_id}")
    call_roles = [str(row.get("call_role")) for row in calls]
    for role in expected_roles:
        if role not in call_roles:
            raise ContractError(f"capture lacks required role {role}")
    if arm_id.startswith("router-") and not ({"cloud_agent", "local_agent"} & set(call_roles)):
        raise ContractError("Router capture lacks a selected Agent backend")
    if arm_id.startswith("router-explicit-binary-tool-") and "router_helper" in call_roles:
        raise ContractError("explicit policy unexpectedly invoked model Router")

    service_sessions: dict[str, set[str]] = defaultdict(set)
    for call in calls:
        service_role = str(call.get("service_role", ""))
        upstream_session = str(call.get("upstream_session_id", ""))
        if not service_role or not upstream_session:
            raise ContractError("model call lacks service_role or upstream_session_id")
        service_sessions[service_role].add(upstream_session)
    representative_sessions = [next(iter(values)) for values in service_sessions.values()]
    if len(set(representative_sessions)) != len(representative_sessions):
        raise ContractError("provider role sessions are not distinct")
    if any(len(values) != 1 for values in service_sessions.values()):
        raise ContractError("one service role used multiple provider sessions in a Cell")

    route_rows = [
        row for row in events if row.get("event") in {"router_decision", "router_failed"}
    ]
    request_ids = {str(row.get("proxy_request_id")) for row in inbound}
    router_arm = arm_id.startswith("router-")
    if router_arm:
        for request_id in request_ids:
            matches = [row for row in route_rows if row.get("request_id") == request_id]
            if len(matches) != 1:
                raise ContractError(
                    f"Router request {request_id} lacks exactly one decision/failure record"
                )
        for row in route_rows:
            state = row.get("route_state")
            if not isinstance(state, dict) or state.get("semantics") != (
                "deterministic_projection_from_current_request_history_only"
            ):
                raise ContractError("Router decision lacks deterministic route-state projection")

    decisions = [row for row in route_rows if row.get("event") == "router_decision"]
    local_routes = [
        row
        for row in events
        if row.get("event") == "request_routed"
        and str(row.get("route", "")).startswith("local-router-")
    ]
    resolved = [row for row in events if row.get("event") == "fsm_transition_resolved"]
    transition_matches = sum(
        1
        for row in resolved
        if isinstance(row.get("transition_resolution"), dict)
        and row["transition_resolution"].get("ok") is True
        and row["transition_resolution"].get("reason") == "fsm_transition_matched"
    )
    forced_cloud = sum(
        1
        for row in resolved
        if isinstance(row.get("transition_resolution"), dict)
        and row["transition_resolution"].get("ok") is False
    )
    if transition_matches + forced_cloud != len(resolved):
        raise ContractError("FSM transition resolutions are not completely classified")
    admissibility_restrictions = 0
    local_classes = {"OBSERVE_UI_RAW", "QUERY_UI_GROUNDED", "INTERACT_UI_GROUNDED"}
    for row in decisions:
        if "fsm_admissible_route_classes" in row:
            admissible = set(row.get("fsm_admissible_route_classes") or []) & local_classes
            if len(admissible) < len(local_classes):
                admissibility_restrictions += 1

    reclassified = [row for row in events if row.get("event") == "local_route_reclassification_applied"]
    failure_reasons = Counter()
    for row in events:
        if row.get("event") != "local_validation_failed":
            continue
        reason = row.get("validation_reason")
        if not reason and row.get("error_code"):
            reason = f"provider_error:{row['error_code']}"
        if not reason and "upstream_status" in row:
            reason = f"provider_http:{row['upstream_status']}"
        failure_reasons[str(reason or "unknown")] += 1

    return {
        "structurally_healthy": True,
        "validator_version": "phone-native-v1",
        "record_count": len(records),
        "proxy_request_count": len(inbound),
        "model_call_count": len(calls),
        "response_record_count": sum(1 for row in records if "raw_response_base64" in row),
        "call_roles": sorted(set(call_roles)),
        "service_roles": sorted(service_sessions),
        "route_policy_version": next(
            (row.get("route_policy_version") for row in route_rows if row.get("route_policy_version")),
            None,
        ),
        "route_decision_count": len(decisions),
        "route_failure_count": sum(1 for row in route_rows if row.get("event") == "router_failed"),
        "predicted_binary_routes": sorted(
            {str(row["predicted_binary_route"]) for row in decisions if row.get("predicted_binary_route")}
        ),
        "predicted_route_classes": sorted(
            {str(row["predicted_route_class"]) for row in decisions if row.get("predicted_route_class")}
        ),
        "local_backend_selection_count": sum(
            1 for row in decisions if row.get("final_backend") == "local"
        ),
        "local_agent_call_count": call_roles.count("local_agent"),
        "cloud_agent_call_count": call_roles.count("cloud_agent"),
        "accepted_local_call_count": len(local_routes),
        "local_validation_failure_count": _count(events, "local_validation_failed"),
        "invalid_local_candidate_count": _count(events, "local_validation_failed"),
        "local_validation_failure_reason_counts": [
            {"reason": reason, "count": count}
            for reason, count in sorted(failure_reasons.items())
        ],
        "route_reclassification_applied_count": len(reclassified),
        "route_reclassification_rejected_count": _count(
            events, "local_route_reclassification_rejected"
        ),
        "c1_reclassification_execution_count": sum(
            1 for row in reclassified if row.get("route_flex_condition") == "C1"
        ),
        "c2_added_execution_count": sum(
            1 for row in reclassified if row.get("route_flex_condition") == "C2"
        ),
        "fsm_admissibility_restriction_count": admissibility_restrictions,
        "fsm_transition_pending_count": _count(events, "fsm_transition_pending"),
        "fsm_transition_resolved_count": len(resolved),
        "fsm_transition_match_count": transition_matches,
        "fsm_forced_cloud_handoff_count": forced_cloud,
        "repair_attempt_count": _count(events, "local_repair_attempted"),
        "repair_applied_count": _count(events, "local_repair_applied"),
        "repair_rejected_count": _count(events, "local_repair_rejected"),
        "raw_valid_local_call_count": sum(
            1 for row in local_routes if not (isinstance(row.get("repair"), dict) and row["repair"].get("applied"))
        ),
        "repair_assisted_valid_local_call_count": sum(
            1 for row in local_routes if isinstance(row.get("repair"), dict) and row["repair"].get("applied") is True
        ),
        "repair_intercepted_after_revalidation_count": _count(
            events, "local_repair_intercepted_after_revalidation"
        ),
        "cloud_first_gate_trigger_count": _count(
            events, "cloud_first_ui_mutation_gate_triggered"
        ),
        "cloud_first_followup_ui_count": 0,
        "cloud_first_followup_provider_count": 0,
        "cloud_first_followup_shell_count": 0,
        "cloud_first_followup_no_tool_count": 0,
        "cloud_first_followup_mixed_count": 0,
        "effect_aware_transition_count": sum(
            1
            for row in decisions
            if isinstance(row.get("route_state"), dict)
            and row["route_state"].get("ui_effect_policy_version") == "g4-binary-ui-effect-aware-v1"
            and isinstance(row["route_state"].get("last_transition"), dict)
            and row["route_state"]["last_transition"].get("ui_effect")
            in {"UI_NEUTRAL_READ", "NON_UI_STEP"}
        ),
        "strong_path_check_exposure_count": _count(events, "strong_path_check_applied"),
    }
