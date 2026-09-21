#!/usr/bin/env python3
"""Fail-closed summary for the frozen Expanded15 core ablation.

The tool reads sealed Formal Cell evidence from one or more campaign roots or
explicit schedule segments, matches every Cell against the frozen config plan,
verifies the copied model capture hash, and derives success and request-role
counts.  It never selects among duplicate attempts: duplicate or missing
planned Cells are errors.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from phone_controller.config_plan import CONFIG_ROOT, build_plan, load_frozen_config  # noqa: E402


CORE_CONFIGS = (
    "unified-five-group-experiment-v4.json",
    "router-rm-expanded15-experiment-v1.json",
    "router-r2-fsm-expanded15-paired-experiment-v1.json",
    "router-fsm-scoped-repair-expanded15-experiment-v1.json",
)
DISPLAY_ORDER = (
    "G1",
    "G2",
    "G3",
    "G4-RM",
    "G4-RM-SC",
    "G4-FSM-SC",
    "G4-FSM-SC-Repair",
    "G5",
)
DISPLAY_LABEL = {
    "G1": "Full DSV4",
    "G2": "DSV4 Filter + DSV4 Agent",
    "G3": "Qwen Filter + DSV4 Agent",
    "G4-RM": "Moderate RouteClass Router",
    "G4-RM-SC": "RouteClass Router + Scoped Context",
    "G4-FSM-SC": "FSM Router + Scoped Context",
    "G4-FSM-SC-Repair": "FSM Router + Scoped Context + Repair",
    "G5": "Full Qwen Agent",
}
ROLE_COLUMN = {
    "filter_helper": "filter",
    "router_helper": "router",
    "local_agent": "local_agent",
    "cloud_agent": "server_agent",
}
RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class SummaryError(RuntimeError):
    """The evidence cannot support an unambiguous summary."""


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SummaryError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SummaryError(f"JSON root is not an object: {path}")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as exc:
        raise SummaryError(f"cannot read capture {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SummaryError(f"invalid JSONL {path}:{number}") from exc
        if not isinstance(value, dict):
            raise SummaryError(f"capture row is not an object {path}:{number}")
        rows.append(value)
    if not rows:
        raise SummaryError(f"capture is empty: {path}")
    return rows


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def expected_rows(config_names: Iterable[str]) -> dict[tuple[str, int], dict[str, Any]]:
    result: dict[tuple[str, int], dict[str, Any]] = {}
    for name in config_names:
        config, config_sha256 = load_frozen_config(CONFIG_ROOT / name)
        for row in build_plan(config, "Formal"):
            key = (str(row["group_id"]), int(row["schedule"]))
            if key in result:
                raise SummaryError(f"frozen plans contain duplicate key {key}")
            result[key] = {**row, "config_file": name, "config_sha256": config_sha256}
    return result


def find_formal_statuses(
    roots: Iterable[Path],
    segments: Iterable[tuple[Path, int, int]] = (),
) -> list[Path]:
    statuses: list[Path] = []
    for root in roots:
        if not root.is_dir():
            raise SummaryError(f"campaign root is not a directory: {root}")
        for path in sorted(root.rglob("cell-status.json")):
            value = _read_json(path)
            if str(value.get("stage", "")).lower() == "formal":
                statuses.append(path)
    for root, start, end in segments:
        if not root.is_dir():
            raise SummaryError(f"campaign segment root is not a directory: {root}")
        if start < 1 or end < start:
            raise SummaryError(f"invalid campaign segment {root}: {start}..{end}")
        selected = 0
        for path in sorted(root.rglob("cell-status.json")):
            value = _read_json(path)
            if str(value.get("stage", "")).lower() != "formal":
                continue
            try:
                schedule = int(value["schedule"])
            except (KeyError, TypeError, ValueError) as exc:
                raise SummaryError(f"Cell has invalid schedule: {path}") from exc
            if start <= schedule <= end:
                statuses.append(path)
                selected += 1
        if selected == 0:
            raise SummaryError(f"campaign segment selected no Formal Cells: {root} {start}..{end}")
    if not statuses:
        raise SummaryError("no Formal cell-status.json files were found")
    return statuses


def _semantic_role(group: str, arm_id: str, capture_role: str) -> str:
    """Map a physical capture role to the experiment table's logical role.

    Historical Full-Qwen captures used ``cloud_agent`` as the Proxy service
    role even though Qwen is the experiment's Local Agent arm.  The table is a
    model-role attribution, so that one frozen arm is assigned to Local Agent.
    """

    if group == "G5" and arm_id == "full-qwen36" and capture_role == "cloud_agent":
        return "local_agent"
    try:
        return ROLE_COLUMN[capture_role]
    except KeyError as exc:
        raise SummaryError(f"unsupported model role {capture_role!r}") from exc


def _capture_manifest_entry(status: dict[str, Any], filename: str) -> dict[str, Any]:
    entries = [
        row
        for row in status.get("capture_files", [])
        if isinstance(row, dict)
        and Path(str(row.get("local_path") or row.get("source_path") or row.get("remote_path") or "")).name
        == filename
    ]
    if len(entries) != 1:
        raise SummaryError(f"Cell does not reference exactly one {filename}")
    return entries[0]


def _verify_capture_file(status_path: Path, status: dict[str, Any]) -> Path:
    path = status_path.parent / "model-calls.jsonl"
    if not path.is_file():
        raise SummaryError(f"model capture is missing beside {status_path}")
    entry = _capture_manifest_entry(status, "model-calls.jsonl")
    if int(entry.get("bytes", -1)) != path.stat().st_size:
        raise SummaryError(f"model capture byte count differs from Cell manifest: {path}")
    if str(entry.get("sha256", "")).lower() != _sha256(path):
        raise SummaryError(f"model capture SHA-256 differs from Cell manifest: {path}")
    return path


def _verify_result_file(status_path: Path, status: dict[str, Any]) -> dict[str, Any]:
    evidence = status.get("result_evidence")
    if not isinstance(evidence, dict):
        raise SummaryError(f"Cell lacks result_evidence: {status_path}")
    recorded = Path(str(evidence.get("path", "")))
    candidates = [recorded, status_path.parent / "json" / recorded.name]
    existing = []
    for candidate in candidates:
        if candidate.is_file() and candidate not in existing:
            existing.append(candidate)
    if len(existing) != 1:
        raise SummaryError(f"Cell result file is missing or ambiguous: {status_path}")
    path = existing[0]
    if str(evidence.get("sha256", "")).lower() != _sha256(path):
        raise SummaryError(f"result SHA-256 differs from Cell evidence: {path}")
    return _read_json(path)


def summarize(
    expected: dict[tuple[str, int], dict[str, Any]],
    status_paths: Iterable[Path],
) -> dict[str, Any]:
    seen_keys: set[tuple[str, int]] = set()
    seen_run_ids: set[str] = set()
    totals: dict[str, dict[str, Any]] = {}

    for status_path in status_paths:
        status = _read_json(status_path)
        group = str(status.get("group_id", ""))
        try:
            schedule = int(status["schedule"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SummaryError(f"Cell has invalid schedule: {status_path}") from exc
        key = (group, schedule)
        plan = expected.get(key)
        if plan is None:
            raise SummaryError(f"Formal Cell is outside the selected frozen plans: {key}")
        if key in seen_keys:
            raise SummaryError(f"duplicate Formal Cell; select one explicit evidence root: {key}")
        seen_keys.add(key)

        for field in ("group_id", "arm_id", "task_case", "repetition"):
            if status.get(field) != plan.get(field):
                raise SummaryError(
                    f"Cell {key} field {field} differs from frozen plan: "
                    f"{status.get(field)!r} != {plan.get(field)!r}"
                )
        if status.get("experiment_infrastructure_failure") is not False:
            raise SummaryError(f"Cell {key} is an infrastructure failure")
        classification = status.get("classification")
        if classification not in {"primary_scored_success", "primary_scored_failure"}:
            raise SummaryError(f"Cell {key} has non-scored classification {classification!r}")
        capture = status.get("capture_validation")
        if not isinstance(capture, dict) or capture.get("structurally_healthy") is not True:
            raise SummaryError(f"Cell {key} lacks structurally healthy capture validation")
        run_id = str(status.get("result_run_id", ""))
        if not RUN_ID_RE.fullmatch(run_id) or status.get("session_id") != run_id:
            raise SummaryError(f"Cell {key} has invalid or mismatched run/session identity")
        if run_id in seen_run_ids:
            raise SummaryError(f"result.run_id is reused across Cells: {run_id}")
        seen_run_ids.add(run_id)

        result = _verify_result_file(status_path, status)
        if result.get("run_id") != run_id:
            raise SummaryError(f"Cell {key} result file has mismatched run_id")
        result_outcome = result.get("results", {}).get("outcome")
        expected_outcome = "SUCCESS" if classification == "primary_scored_success" else "FAILURE"
        if result_outcome != expected_outcome or status.get("result_outcome") != expected_outcome:
            raise SummaryError(
                f"Cell {key} result outcome does not agree with classification: "
                f"{result_outcome!r}/{status.get('result_outcome')!r} != {expected_outcome!r}"
            )

        records = _read_jsonl(_verify_capture_file(status_path, status))
        inbound = [row for row in records if row.get("event") == "proxy_request"]
        calls = [row for row in records if row.get("event") == "model_call"]
        if len(inbound) != int(capture.get("proxy_request_count", -1)):
            raise SummaryError(f"Cell {key} logical-request count differs from capture validation")
        if len(calls) != int(capture.get("model_call_count", -1)):
            raise SummaryError(f"Cell {key} model-call count differs from capture validation")
        roles: Counter[str] = Counter()
        for call in calls:
            if call.get("session_id") != run_id or call.get("arm_id") != status.get("arm_id"):
                raise SummaryError(f"Cell {key} model-call identity mismatch")
            if call.get("capture_complete") is not True:
                raise SummaryError(f"Cell {key} contains an incomplete model response")
            try:
                response_status = int(call.get("response_status", 0))
            except (TypeError, ValueError) as exc:
                raise SummaryError(f"Cell {key} has invalid provider response status") from exc
            if response_status < 200 or response_status >= 300:
                raise SummaryError(f"Cell {key} contains provider HTTP {response_status}")
            capture_role = str(call.get("call_role", ""))
            try:
                semantic_role = _semantic_role(group, str(status.get("arm_id", "")), capture_role)
            except SummaryError as exc:
                raise SummaryError(f"Cell {key} contains {exc}") from exc
            roles[semantic_role] += 1

        group_total = totals.setdefault(
            group,
            {
                "group": "G4-FSM-SC-Rep" if group == "G4-FSM-SC-Repair" else group,
                "group_id": group,
                "configuration": DISPLAY_LABEL[group],
                "cells": 0,
                "success": 0,
                "logical_requests": 0,
                "filter": 0,
                "router": 0,
                "local_agent": 0,
                "server_agent": 0,
                "physical_requests": 0,
                "accepted_local_calls": 0,
                "config_file": plan["config_file"],
                "config_sha256": plan["config_sha256"],
            },
        )
        group_total["cells"] += 1
        group_total["success"] += int(classification == "primary_scored_success")
        group_total["logical_requests"] += len(inbound)
        group_total["physical_requests"] += len(calls)
        group_total["accepted_local_calls"] += int(capture.get("accepted_local_call_count", 0))
        for role, count in roles.items():
            group_total[role] += count

    missing = set(expected) - seen_keys
    if missing:
        preview = ", ".join(f"{group}:{schedule}" for group, schedule in sorted(missing)[:8])
        raise SummaryError(f"missing {len(missing)} frozen Formal Cells; first: {preview}")

    groups = [totals[group] for group in DISPLAY_ORDER if group in totals]
    if sum(row["cells"] for row in groups) != len(expected):
        raise SummaryError("aggregate Cell count does not match the frozen plans")
    for row in groups:
        role_sum = row["filter"] + row["router"] + row["local_agent"] + row["server_agent"]
        if role_sum != row["physical_requests"]:
            raise SummaryError(f"physical role accounting does not close for {row['group_id']}")
    return {
        "schema_version": 1,
        "semantics": "fresh_formal_core_ablation_summary_from_sealed_cell_evidence",
        "cell_count": len(expected),
        "unique_result_run_id_count": len(seen_run_ids),
        "groups": groups,
    }


def markdown(summary: dict[str, Any]) -> str:
    lines = [
        "| Group | Configuration | SUCCESS | Logical Requests | Filter | Router | Local Agent | Server Agent | Physical Requests |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summary["groups"]:
        rate = 100.0 * row["success"] / row["cells"]
        lines.append(
            "| {group} | {configuration} | {success}/{cells}, {rate:.1f}% | "
            "{logical_requests:,} | {filter:,} | {router:,} | {local_agent:,} | "
            "{server_agent:,} | {physical_requests:,} |".format(rate=rate, **row)
        )
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--campaign-root",
        action="append",
        type=Path,
        default=[],
        help="Exact uninterrupted campaign root; repeat for additional non-overlapping roots.",
    )
    parser.add_argument(
        "--segment",
        action="append",
        nargs=3,
        metavar=("ROOT", "START", "END"),
        default=[],
        help=(
            "Explicit inclusive Formal schedule segment for fail-fast/recovery evidence; "
            "repeat as needed, for example --segment ROOT 1 30."
        ),
    )
    parser.add_argument(
        "--config",
        action="append",
        choices=CORE_CONFIGS,
        help="Frozen config to expect; repeat as needed. Defaults to all four core configs.",
    )
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    configs = tuple(args.config or CORE_CONFIGS)
    try:
        if not args.campaign_root and not args.segment:
            raise SummaryError("provide at least one --campaign-root or --segment")
        segments: list[tuple[Path, int, int]] = []
        for raw_root, raw_start, raw_end in args.segment:
            try:
                segments.append((Path(raw_root), int(raw_start), int(raw_end)))
            except ValueError as exc:
                raise SummaryError(
                    f"segment bounds must be integers: {raw_root} {raw_start} {raw_end}"
                ) from exc
        result = summarize(
            expected_rows(configs),
            find_formal_statuses(args.campaign_root, segments),
        )
    except SummaryError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
    else:
        print(markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
