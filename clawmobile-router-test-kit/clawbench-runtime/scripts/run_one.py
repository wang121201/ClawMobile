from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.device import Device
from core.registry import discover_tasks
from core.runner import run_one as run_task
from scripts.run_task_set import _require_explicit_results_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one ClawBench task by id.")
    parser.add_argument("task_id")
    parser.add_argument(
        "--device-serial",
        required=True,
        help="Real Android adb serial. Live agent runs never use MockDevice.",
    )
    parser.add_argument(
        "--params-json",
        required=True,
        help='Run one parameter set, for example: \'{"percent":50}\'.',
    )
    args = parser.parse_args()
    _require_explicit_results_dir()

    registry = discover_tasks()
    task_cls = registry.get(args.task_id)
    if task_cls is None:
        known = ", ".join(sorted(registry)) or "(none)"
        raise SystemExit(f"unknown task_id {args.task_id!r}; known tasks: {known}")

    task = task_cls()
    device = Device(args.device_serial)
    batch_id = uuid.uuid4().hex
    started_at = datetime.now(timezone.utc).isoformat()
    for case_index, params in enumerate(_params(args.params_json), start=1):
        record = run_task(
            task,
            params,
            seed=0,
            device=device,
            record_metadata={
                "result_batch_id": batch_id,
                "benchmark_started_at": started_at,
                "case_index": case_index,
            },
        )
        print(_format_run_summary(args.task_id, params, record))


def _params(params_json: str) -> list[dict]:
    parsed = json.loads(params_json)
    if not isinstance(parsed, dict):
        raise SystemExit("--params-json must decode to a JSON object")
    return [parsed]


def _format_run_summary(task_id: str, params: dict, record: dict) -> str:
    summary = f"{task_id} params={params} outcome={record['results']['outcome']}"
    reason = record.get("preflight_failure_reason")
    if reason:
        summary += f" preflight_failure={reason}"
    elif record.get("exception"):
        summary += f" exception={record['exception']}"
    return summary


if __name__ == "__main__":
    main()
