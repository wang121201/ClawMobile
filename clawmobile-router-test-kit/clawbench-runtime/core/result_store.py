"""Persistent JSON records and latest-batch task-metrics CSV output."""

from __future__ import annotations

import csv
import json
import os
import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RESULTS_DIR = PROJECT_ROOT / "results"
JSON_DIRECTORY_NAME = "json"
METRICS_CSV_NAME = "openclaw_task_metrics.csv"
LEGACY_BATCH_GAP_SECONDS = 15 * 60
METRICS_HEADER_ROWS = (
    (
        "",
        "",
        "Steps",
        "",
        "",
        "Function Calls",
        "",
        "",
        "E2E Latency",
        "",
        "",
        "Model Latency",
        "",
        "",
        "Tokens",
        "",
        "",
    ),
    (
        "",
        "success rate",
        "min",
        "avg",
        "max",
        "min",
        "avg",
        "max",
        "min",
        "avg",
        "max",
        "min",
        "avg",
        "max",
        "min",
        "avg",
        "max",
    ),
)


def store_result_record(
    record: dict[str, Any],
    results_dir: Path | None = None,
) -> Path:
    """Write one uniquely named JSON record and refresh the latest-batch CSV."""

    root = _resolve_results_dir(results_dir)
    json_dir = root / JSON_DIRECTORY_NAME
    json_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc)
    record.setdefault("record_id", uuid.uuid4().hex)
    record.setdefault("recorded_at", now.isoformat())

    task_id = _safe_filename_part(str(record.get("task_id") or "unknown-task"))
    timestamp = now.strftime("%Y%m%dT%H%M%S%fZ")
    record_id = _safe_filename_part(str(record["record_id"]))[:12]
    output_path = json_dir / f"{timestamp}_{task_id}_{record_id}.json"
    _write_json_atomic(output_path, record)
    refresh_metrics_csv(root)
    return output_path


def refresh_metrics_csv(results_dir: Path | None = None) -> Path:
    """Rebuild the metrics CSV using each task's most recent result batch."""

    root = _resolve_results_dir(results_dir)
    json_dir = root / JSON_DIRECTORY_NAME
    records = load_result_records(json_dir)
    rows = build_metrics_rows(records)

    root.mkdir(parents=True, exist_ok=True)
    output_path = root / METRICS_CSV_NAME
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, delimiter="\t", lineterminator="\n")
        writer.writerows(METRICS_HEADER_ROWS)
        writer.writerows(rows)
    temporary_path.replace(output_path)
    return output_path


def load_result_records(json_dir: Path) -> list[dict[str, Any]]:
    """Load benchmark case records recursively, ignoring unrelated JSON files."""

    if not json_dir.exists():
        return []

    records: list[dict[str, Any]] = []
    for path in sorted(json_dir.rglob("*.json")):
        relative_parts = path.relative_to(json_dir).parts[:-1]
        if any(part.startswith("_") for part in relative_parts):
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            continue
        if not value.get("task_id") or not isinstance(value.get("results"), dict):
            continue
        records.append(value)
    return records


def build_metrics_rows(records: list[dict[str, Any]]) -> list[list[str]]:
    """Summarize each task's latest batch in the 17-column metrics format."""

    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        task_id = str(record.get("task_id") or "").strip()
        if task_id:
            by_task[task_id].append(record)

    rows: list[list[str]] = []
    for task_id in sorted(by_task):
        task_records = _latest_batch_records(by_task[task_id])
        success_count = sum(
            1
            for record in task_records
            if record.get("results", {}).get("outcome") == "SUCCESS"
        )
        row = [task_id, f"={success_count}/{len(task_records)}"]

        metrics = [
            metric
            for record in task_records
            if (metric := _extract_metrics(record)) is not None
        ]
        if not metrics:
            row.extend([""] * 15)
            rows.append(row)
            continue

        row.extend(_count_stats([metric["steps"] for metric in metrics]))
        row.extend(_count_stats([metric["function_calls"] for metric in metrics]))
        row.extend(_latency_stats([metric["e2e_latency_ms"] for metric in metrics]))
        model_latencies = [
            value
            for metric in metrics
            if _is_number(value := metric.get("model_latency_ms"))
        ]
        row.extend(_latency_stats(model_latencies) if model_latencies else [""] * 3)
        row.extend(_token_stats([metric["tokens"] for metric in metrics]))
        rows.append(row)

    return rows


def _latest_batch_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the newest explicit batch, with time-gap grouping for legacy JSON."""

    explicit: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    legacy: list[tuple[int, float | None, dict[str, Any]]] = []
    for position, record in enumerate(records):
        batch_key = _explicit_batch_key(record)
        if batch_key is None:
            legacy.append((position, _record_timestamp_ms(record), record))
        else:
            explicit[batch_key].append((position, record))

    candidates: list[list[tuple[int, dict[str, Any]]]] = list(explicit.values())
    candidates.extend(_legacy_record_batches(legacy))
    if not candidates:
        return []

    latest = max(candidates, key=_batch_recency_key)
    return [record for _, record in latest]


def _explicit_batch_key(record: dict[str, Any]) -> str | None:
    batch_id = str(record.get("result_batch_id") or "").strip()
    if batch_id:
        return f"result:{batch_id}"

    benchmark_started_at = str(record.get("benchmark_started_at") or "").strip()
    if benchmark_started_at:
        return f"benchmark:{benchmark_started_at}"

    run_label = str(record.get("run_label") or "").strip()
    if run_label:
        return f"run-label:{run_label}"
    return None


def _legacy_record_batches(
    records: list[tuple[int, float | None, dict[str, Any]]],
) -> list[list[tuple[int, dict[str, Any]]]]:
    dated = sorted(
        (item for item in records if item[1] is not None),
        key=lambda item: (item[1], item[0]),
    )
    batches: list[list[tuple[int, dict[str, Any]]]] = []
    previous_timestamp: float | None = None
    for position, timestamp, record in dated:
        assert timestamp is not None
        if (
            not batches
            or previous_timestamp is None
            or timestamp - previous_timestamp > LEGACY_BATCH_GAP_SECONDS * 1000
        ):
            batches.append([])
        batches[-1].append((position, record))
        previous_timestamp = timestamp

    # A legacy record without any timestamp cannot be grouped safely. Treat it
    # as a one-record batch instead of accidentally accumulating all history.
    batches.extend(
        [[(position, record)]]
        for position, timestamp, record in records
        if timestamp is None
    )
    return batches


def _batch_recency_key(
    batch: list[tuple[int, dict[str, Any]]],
) -> tuple[int, float, int]:
    timestamps = [
        timestamp
        for _, record in batch
        if (timestamp := _record_timestamp_ms(record)) is not None
    ]
    return (
        1 if timestamps else 0,
        max(timestamps, default=float("-inf")),
        max(position for position, _ in batch),
    )


def _record_timestamp_ms(record: dict[str, Any]) -> float | None:
    for field in ("recorded_at", "benchmark_started_at"):
        if (timestamp := _parse_timestamp_ms(record.get(field))) is not None:
            return timestamp
    return None


def _extract_metrics(record: dict[str, Any]) -> dict[str, int | float] | None:
    runtime = next(
        (
            event
            for event in record.get("agent_trajectory") or []
            if isinstance(event, dict) and event.get("event") == "runtime.trajectory"
        ),
        None,
    )
    if not isinstance(runtime, dict):
        return None

    if (
        runtime.get("fileTruncated") is True
        or runtime.get("stepsTruncated") is True
        or runtime.get("captureTruncated") is True
        or (_is_number(runtime.get("parseErrorCount")) and runtime["parseErrorCount"] > 0)
    ):
        return None

    steps = runtime.get("steps")
    returned_steps = runtime.get("returnedStepCount")
    e2e_latency_ms = record.get("latency", {}).get("openclaw_total_ms")
    if not isinstance(steps, list) or not _is_number(returned_steps):
        return None
    if not _is_number(e2e_latency_ms):
        return None

    tokens = extract_token_total(steps)
    if tokens is None:
        return None

    metrics: dict[str, int | float] = {
        "steps": returned_steps,
        "function_calls": sum(
            1
            for step in steps
            if isinstance(step, dict) and step.get("type") == "tool.call"
        ),
        "e2e_latency_ms": e2e_latency_ms,
        "tokens": tokens,
    }
    model_latency_ms = extract_model_latency_ms(runtime)
    if model_latency_ms is not None:
        metrics["model_latency_ms"] = model_latency_ms
    return metrics


def extract_token_total(steps: list[Any]) -> int | float | None:
    """Return complete cumulative model usage, deriving totals when necessary."""

    model_steps = [
        step
        for step in steps
        if isinstance(step, dict) and step.get("type") == "model.completed"
    ]
    if not model_steps:
        return None

    totals: list[int | float] = []
    for step in model_steps:
        usage = step.get("usage")
        if not isinstance(usage, dict):
            return None
        total = usage.get("total")
        if _is_number(total):
            totals.append(total)
            continue
        components = [
            usage.get(name) for name in ("input", "output", "cacheRead", "cacheWrite")
        ]
        if not any(_is_number(value) for value in components):
            return None
        totals.append(sum(value for value in components if _is_number(value)))

    combined = sum(totals)
    return combined if combined > 0 else None


def extract_model_latency_ms(runtime: dict[str, Any]) -> float | None:
    """Return the union of complete model-call timestamp intervals in milliseconds."""

    events = runtime.get("modelCallEvents")
    if not isinstance(events, list) or not events:
        return None

    starts: dict[str, float] = {}
    ended: set[str] = set()
    intervals: list[tuple[float, float]] = []
    for event in events:
        if not isinstance(event, dict):
            return None
        event_type = event.get("type")
        call_id = event.get("callId")
        timestamp_ms = _parse_timestamp_ms(event.get("ts"))
        if not isinstance(call_id, str) or not call_id or timestamp_ms is None:
            return None
        if event_type == "model.call.started":
            if call_id in starts or call_id in ended:
                return None
            starts[call_id] = timestamp_ms
        elif event_type in {"model.call.completed", "model.call.error"}:
            if call_id not in starts or call_id in ended:
                return None
            started_ms = starts[call_id]
            if timestamp_ms < started_ms:
                return None
            ended.add(call_id)
            intervals.append((started_ms, timestamp_ms))
        else:
            return None

    if not starts or set(starts) != ended:
        return None
    return _interval_union_ms(intervals)


def _parse_timestamp_ms(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp() * 1000


def _interval_union_ms(intervals: list[tuple[float, float]]) -> float:
    total = 0.0
    current_start: float | None = None
    current_end: float | None = None
    for start, end in sorted(intervals):
        if current_start is None or current_end is None:
            current_start, current_end = start, end
        elif start <= current_end:
            current_end = max(current_end, end)
        else:
            total += current_end - current_start
            current_start, current_end = start, end
    if current_start is not None and current_end is not None:
        total += current_end - current_start
    return total


def _count_stats(values: list[int | float]) -> list[str]:
    return [
        _format_count(min(values)),
        _format_count(sum(values) / len(values)),
        _format_count(max(values)),
    ]


def _latency_stats(values_ms: list[int | float]) -> list[str]:
    values_s = [value / 1000 for value in values_ms]
    return [
        _format_decimal(min(values_s), 1, keep_trailing_zero=True),
        _format_decimal(sum(values_s) / len(values_s), 1, keep_trailing_zero=True),
        _format_decimal(max(values_s), 1, keep_trailing_zero=True),
    ]


def _token_stats(values: list[int | float]) -> list[str]:
    return [
        str(int(min(values))),
        str(_round_half_up(sum(values) / len(values))),
        str(int(max(values))),
    ]


def _format_count(value: int | float) -> str:
    return _format_decimal(value, 1, keep_trailing_zero=False)


def _format_decimal(
    value: int | float,
    places: int,
    keep_trailing_zero: bool,
) -> str:
    quantum = Decimal("1").scaleb(-places)
    rounded = Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP)
    if not keep_trailing_zero and rounded == rounded.to_integral_value():
        return str(int(rounded))
    return f"{rounded:.{places}f}"


def _round_half_up(value: int | float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _safe_filename_part(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "record"


def _resolve_results_dir(results_dir: Path | None) -> Path:
    if results_dir is not None:
        return Path(results_dir)
    configured = os.environ.get("CLAWBENCH_RESULTS_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return DEFAULT_RESULTS_DIR


def _write_json_atomic(path: Path, value: object) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
