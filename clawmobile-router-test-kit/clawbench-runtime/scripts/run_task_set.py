from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.device import Device
from core.outcome import INFRA_FAILURE, SUCCESS
from core.registry import discover_tasks
from core.runner import run_one as run_task


def main() -> None:
    args = _parse_args()
    results_dir = _require_explicit_results_dir()
    selected_cases = _selected_cases(args)

    registry = discover_tasks()
    started_at = datetime.now(timezone.utc).isoformat()
    batch_id = uuid.uuid4().hex
    execution_plan = _build_execution_plan(
        args,
        selected_cases,
        registry,
        started_at=started_at,
        batch_id=batch_id,
    )
    execution_plan_path = _write_execution_plan_exclusive(
        results_dir,
        execution_plan,
    )
    print(f"Execution plan: {execution_plan_path}")
    print(json.dumps(execution_plan, ensure_ascii=False, indent=2, sort_keys=True))

    # No Device is constructed, and therefore no task preflight can run,
    # until the complete plan has been durably created without overwriting.
    device = Device(args.device_serial)
    rows = []
    batch_fatal_record = None

    for cell in execution_plan["cells"]:
        task = registry[cell["task_id"]]()
        record = run_task(
            task,
            dict(cell["params"]),
            seed=args.seed,
            device=device,
            record_metadata={
                "result_batch_id": batch_id,
                "case_index": cell["case_index"],
                "repetition_index": cell["repetition_index"],
                "run_index": cell["run_index"],
                "model_label": args.model_label,
                "run_label": args.run_label,
                "benchmark_started_at": started_at,
                "execution_plan_file": execution_plan_path.name,
                "planned_instruction_sha256": cell["instruction_sha256"],
            },
        )
        rows.append(record)
        print(_format_row(record))
        if record.get("batch_fatal") is True:
            batch_fatal_record = record
            break

    summary = _summary(args, rows, started_at)
    print()
    print(json.dumps(summary["scores"], indent=2, sort_keys=True))
    if batch_fatal_record is not None:
        reasons = ", ".join(batch_fatal_record.get("batch_fatal_reasons", []))
        print(
            f"Batch stopped after run_index={batch_fatal_record['run_index']}: "
            f"{reasons or 'batch_fatal'}",
            file=sys.stderr,
        )
        raise SystemExit(2)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a selected ClawBench task set on a real Android device."
    )
    parser.add_argument("--device-serial", required=True)
    parser.add_argument(
        "--model-label",
        required=True,
        help="Metadata label only; this does not change the phone OpenClaw model.",
    )
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--layers",
        help="Explicit comma-separated layer prefixes to run.",
    )
    selection.add_argument(
        "--task-id",
        action="append",
        dest="task_ids",
        help="Explicit task id to run. May be supplied for multiple distinct tasks.",
    )
    selection.add_argument(
        "--task-case",
        action="append",
        dest="task_cases",
        metavar="TASK_ID:CASE_INDEX",
        help=(
            "Run one exact 1-based param_pool case. May be supplied multiple times "
            "for distinct cases and preserves CLI order."
        ),
    )
    parser.add_argument(
        "--repeat",
        type=_positive_int,
        default=1,
        help="Repeat the complete selected case sequence, default: 1.",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--run-label",
        default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        help="Run-scoped metadata and execution-plan filename label.",
    )
    return parser.parse_args()


def _positive_int(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return value


def _require_explicit_results_dir() -> Path:
    raw = os.environ.get("CLAWBENCH_RESULTS_DIR", "").strip()
    if not raw:
        raise SystemExit(
            "CLAWBENCH_RESULTS_DIR must be explicitly set for a task-set run"
        )
    results_dir = Path(raw)
    if not results_dir.is_absolute():
        raise SystemExit("CLAWBENCH_RESULTS_DIR must be an absolute path")
    results_dir = results_dir.resolve()
    if os.name == "nt":
        data_root = Path(r"D:\codexdataspace").resolve()
        try:
            results_dir.relative_to(data_root)
        except ValueError as exc:
            raise SystemExit(
                "on Windows, CLAWBENCH_RESULTS_DIR must be under "
                r"D:\codexdataspace"
            ) from exc
    if results_dir.exists() and not results_dir.is_dir():
        raise SystemExit("CLAWBENCH_RESULTS_DIR points to a non-directory path")
    return results_dir


def _selection_mode(args: argparse.Namespace) -> str:
    modes = []
    if getattr(args, "task_cases", None):
        modes.append("task-case")
    if getattr(args, "task_ids", None):
        modes.append("task-id")
    layers = getattr(args, "layers", None)
    if isinstance(layers, str) and layers.strip():
        modes.append("layers")
    if len(modes) != 1:
        raise SystemExit(
            "select exactly one explicit mode: --task-case, --task-id, or --layers"
        )
    return modes[0]


def _selected_cases(args: argparse.Namespace) -> list[tuple[str, int, dict]]:
    registry = discover_tasks()
    selection_mode = _selection_mode(args)
    if selection_mode == "task-case":
        selected = []
        selected_keys: set[tuple[str, int]] = set()
        for specification in args.task_cases:
            try:
                task_id, raw_case_index = specification.rsplit(":", 1)
                case_index = int(raw_case_index)
            except (ValueError, AttributeError) as exc:
                raise SystemExit(
                    f"invalid --task-case {specification!r}; expected TASK_ID:CASE_INDEX"
                ) from exc
            if task_id not in registry:
                raise SystemExit(f"unknown task id: {task_id}")
            params_pool = registry[task_id]().param_pool()
            if case_index < 1 or case_index > len(params_pool):
                raise SystemExit(
                    f"case index for {task_id} must be between 1 and {len(params_pool)}"
                )
            selected_key = (task_id, case_index)
            if selected_key in selected_keys:
                raise SystemExit(
                    f"duplicate --task-case selector: {task_id}:{case_index}"
                )
            selected_keys.add(selected_key)
            selected.append((task_id, case_index, params_pool[case_index - 1]))
        return selected

    selected = []
    for task_id in _selected_task_ids(args):
        for case_index, params in enumerate(registry[task_id]().param_pool(), start=1):
            selected.append((task_id, case_index, params))
    return selected


def _selected_task_ids(args: argparse.Namespace) -> list[str]:
    registry = discover_tasks()
    selection_mode = _selection_mode(args)
    if selection_mode == "task-id":
        unknown = [task_id for task_id in args.task_ids if task_id not in registry]
        if unknown:
            raise SystemExit(f"unknown task id(s): {', '.join(unknown)}")
        if len(set(args.task_ids)) != len(args.task_ids):
            raise SystemExit("duplicate --task-id values are ambiguous; use --repeat")
        return list(args.task_ids)

    layers = tuple(layer.strip() for layer in args.layers.split(",") if layer.strip())
    selected = [
        task_id
        for task_id in sorted(registry)
        if any(task_id.startswith(f"{layer}-") for layer in layers)
    ]
    if not selected:
        raise SystemExit("explicit --layers selection matched no tasks")
    return selected


def _build_execution_plan(
    args: argparse.Namespace,
    selected_cases: list[tuple[str, int, dict]],
    registry: dict,
    *,
    started_at: str,
    batch_id: str,
) -> dict:
    cells = []
    run_index = 0
    for repetition_index in range(1, args.repeat + 1):
        for task_id, case_index, params in selected_cases:
            task = registry[task_id]()
            instruction = task.get_instruction(dict(params))
            instruction_bytes = instruction.encode("utf-8")
            run_index += 1
            cells.append(
                {
                    "run_index": run_index,
                    "repetition_index": repetition_index,
                    "task_id": task_id,
                    "case_index": case_index,
                    "layer": task.layer,
                    "params": dict(params),
                    "instruction": instruction,
                    "instruction_utf8_bytes": len(instruction_bytes),
                    "instruction_sha256": hashlib.sha256(instruction_bytes).hexdigest(),
                }
            )
    return {
        "schema_version": 1,
        "result_batch_id": batch_id,
        "run_label": args.run_label,
        "model_label": args.model_label,
        "device_serial": args.device_serial,
        "seed": args.seed,
        "started_at": started_at,
        "selection_mode": _selection_mode(args),
        "ordering": "repetition-major",
        "repetition_count": args.repeat,
        "selected_case_count": len(selected_cases),
        "cell_count": len(cells),
        "cells": cells,
    }


def _write_execution_plan_exclusive(results_dir: Path, execution_plan: dict) -> Path:
    run_label = str(execution_plan.get("run_label", ""))
    if not run_label or not re.fullmatch(r"[A-Za-z0-9_.-]+", run_label):
        raise SystemExit(
            "--run-label must contain only letters, digits, dot, underscore, or hyphen"
        )
    if run_label in {".", ".."}:
        raise SystemExit("--run-label cannot be '.' or '..'")
    results_dir.mkdir(parents=True, exist_ok=True)
    plan_path = results_dir / f"execution-plan.{run_label}.json"
    payload = (
        json.dumps(execution_plan, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    try:
        descriptor = os.open(plan_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SystemExit(
            f"execution plan already exists: {plan_path}; use a new --run-label "
            "or an empty results directory"
        ) from exc
    except OSError as exc:
        raise SystemExit(
            f"cannot create execution plan in CLAWBENCH_RESULTS_DIR: {exc}"
        ) from exc

    try:
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise OSError("execution plan write made no progress")
            offset += written
        os.fsync(descriptor)
    except OSError as exc:
        raise SystemExit(
            f"execution plan write failed; partial plan was retained at {plan_path}: {exc}"
        ) from exc
    finally:
        os.close(descriptor)
    return plan_path


def _summary(args: argparse.Namespace, rows: list[dict], started_at: str) -> dict:
    counts = Counter(row["results"]["outcome"] for row in rows)
    by_layer: dict[str, list[dict]] = {}
    for row in rows:
        by_layer.setdefault(row["layer"], []).append(row)

    return {
        "device_serial": args.device_serial,
        "model_label": args.model_label,
        "run_label": args.run_label,
        "seed": args.seed,
        "repeat": args.repeat,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "case_count": len(rows),
        "scores": _score_rows(rows),
        "outcomes": dict(sorted(counts.items())),
        "layers": {
            layer: {
                "case_count": len(layer_rows),
                "scores": _score_rows(layer_rows),
                "outcomes": dict(
                    sorted(Counter(row["results"]["outcome"] for row in layer_rows).items())
                ),
            }
            for layer, layer_rows in sorted(by_layer.items())
        },
    }


def _score_rows(rows: list[dict]) -> dict:
    scored = [row for row in rows if row["results"]["outcome"] != INFRA_FAILURE]
    success_count = sum(1 for row in scored if row["results"]["outcome"] == SUCCESS)
    return {
        "success_count": success_count,
        "scored_count": len(scored),
        "infra_failure_count": len(rows) - len(scored),
        "total_count": len(rows),
        "success_rate": success_count / len(scored) if scored else None,
    }


def _format_row(record: dict) -> str:
    return (
        f"{record['run_index']:03d} {record['model_label']} "
        f"{record['task_id']} case={record['case_index']} "
        f"repeat={record['repetition_index']} "
        f"outcome={record['results']['outcome']}"
    )


if __name__ == "__main__":
    main()
