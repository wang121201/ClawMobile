from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from .common import ContractError, load_json, sha256_file


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
CONFIG_ROOT = PACKAGE_ROOT / "configs"
FROZEN_MANIFEST = PACKAGE_ROOT / "phone" / "frozen-configs.json"

PAIRED_IDS = {
    "phone-a-router-r2-fsm-paired-v1",
    "phone-a-router-r2-fsm-expanded15-paired-v1",
}
MATCHED_IDS = {
    "phone-a-router-r1-r2-matched5-v1",
    "phone-a-router-rm-matched5-v1",
}
SINGLE_GROUP_IDS = {
    "phone-a-router-r1-r2-matched5-v1",
    "phone-a-router-rm-matched5-v1",
    "phone-a-router-rm-expanded15-v1",
    "phone-a-router-fsm-scoped-repair-expanded15-v1",
    "phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1",
    "phone-a-router-binary-tool-expanded15-v1",
    "phone-a-router-explicit-binary-tool-expanded15-v1",
}
MULTI_CONDITION_IDS = PAIRED_IDS | {
    "phone-a-router-route-flex-tiny-preliminary-v1",
    "phone-a-router-capability-suppression-v1",
    "phone-a-router-capability-suppression-full-dsv4-comparator-v1",
    "phone-a-router-binary-efficiency-tiny-v1",
}


def _groups(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = config.get("groups")
    if not isinstance(rows, list) or not rows:
        raise ContractError("config.groups must be a non-empty list")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("group_id"), str):
            raise ContractError("every group must have a string group_id")
        if row["group_id"] in result:
            raise ContractError(f"duplicate group_id: {row['group_id']}")
        result[row["group_id"]] = row
    return result


def _split_task_case(raw: str) -> tuple[str, int]:
    try:
        task_id, case_raw = raw.rsplit(":", 1)
        case_index = int(case_raw)
    except (AttributeError, ValueError) as exc:
        raise ContractError(f"invalid task_case: {raw!r}") from exc
    if not task_id or case_index < 1:
        raise ContractError(f"invalid task_case: {raw!r}")
    return task_id, case_index


def load_frozen_config(config_path: Path) -> tuple[dict[str, Any], str]:
    path = config_path.resolve()
    if path.parent != CONFIG_ROOT.resolve():
        raise ContractError(f"config must be stored under {CONFIG_ROOT}: {path}")
    manifest = load_json(FROZEN_MANIFEST)
    entries = manifest.get("configs")
    if not isinstance(entries, list):
        raise ContractError("frozen config manifest has no configs list")
    match = next((row for row in entries if row.get("file") == path.name), None)
    if not isinstance(match, dict):
        raise ContractError(f"config is not in the frozen allowlist: {path.name}")
    observed_hash = sha256_file(path)
    if observed_hash != match.get("sha256"):
        raise ContractError(
            f"frozen config hash mismatch for {path.name}: {observed_hash}"
        )
    config = load_json(path)
    if config.get("schema_version") != 4:
        raise ContractError("only schema_version=4 configs are supported")
    if config.get("design_id") != match.get("design_id"):
        raise ContractError("config design_id differs from frozen manifest")
    execution = config.get("execution")
    if not isinstance(execution, dict):
        raise ContractError("config.execution is missing")
    required_execution = {
        "maximum_controllers": 1,
        "maximum_active_cells": 1,
        "maximum_request_chains": 1,
        "scored_failure_policy": "preserve_and_continue",
        "infrastructure_failure_policy": "preserve_and_stop_current_group",
    }
    for key, expected in required_execution.items():
        if execution.get(key) != expected:
            raise ContractError(f"frozen execution contract mismatch: {key}")
    _groups(config)
    expected = match.get("expected_cells", {})
    for stage in ("Smoke", "Formal"):
        if stage == "Formal" and expected.get(stage.lower()) == 0:
            continue
        observed = len(build_plan(config, stage))
        if observed != expected.get(stage.lower()):
            raise ContractError(
                f"{stage} plan count {observed} differs from manifest "
                f"{expected.get(stage.lower())}"
            )
    return config, observed_hash


def _cell(
    *,
    stage: str,
    schedule: int,
    group: dict[str, Any],
    task_set: str,
    task_case: str,
    repetition: int,
    **extra: Any,
) -> dict[str, Any]:
    task_id, case_index = _split_task_case(task_case)
    row: dict[str, Any] = {
        "stage": stage.lower(),
        "schedule": int(schedule),
        "group_id": str(group["group_id"]),
        "arm_id": str(group["arm_id"]),
        "task_set": task_set,
        "task_case": task_case,
        "task_id": task_id,
        "case_index": case_index,
        "repetition": int(repetition),
    }
    row.update(extra)
    return row


def _smoke_rows(config: dict[str, Any], task_set: str) -> list[dict[str, Any]]:
    groups = _groups(config)
    rows: list[dict[str, Any]] = []
    cells = config.get("smoke", {}).get("cells")
    if not isinstance(cells, list):
        raise ContractError("config.smoke.cells is missing")
    for source in sorted(cells, key=lambda row: int(row["smoke_schedule"])):
        group_id = str(source["group_id"])
        if group_id not in groups:
            raise ContractError(f"Smoke references unknown group {group_id}")
        extra: dict[str, Any] = {}
        if "pair_id" in source:
            extra["pair_id"] = str(source["pair_id"])
            extra["pair_position"] = 1 if int(source["smoke_schedule"]) % 2 else 2
        rows.append(
            _cell(
                stage="Smoke",
                schedule=int(source["smoke_schedule"]),
                group=groups[group_id],
                task_set=task_set,
                task_case=str(source["task_case"]),
                repetition=int(source["repetition"]),
                **extra,
            )
        )
    return rows


def build_plan(config: dict[str, Any], stage: str) -> list[dict[str, Any]]:
    if stage not in {"Smoke", "Formal"}:
        raise ContractError("stage must be Smoke or Formal")
    design = str(config.get("design_id", ""))
    groups = _groups(config)
    panel = config.get("task_panel")
    if not isinstance(panel, list) or not panel:
        raise ContractError("config.task_panel must be a non-empty list")

    if design == "phone-a-router-binary-efficiency-tiny-v1":
        if stage == "Smoke":
            rows = _smoke_rows(config, "router-binary-efficiency-tiny")
            for row in rows:
                task = next(value for value in panel if value["task_id"] == row["task_id"])
                row["panel"] = "mechanism-smoke"
                row["task_ordinal"] = int(task["ordinal"])
                row["condition_position"] = list(config["execution"]["condition_order"]).index(
                    row["group_id"]
                ) + 1
            return rows
        rows = []
        for group in config["groups"]:
            offset = 0
            for repetition in range(1, 3):
                for task in sorted(panel, key=lambda value: int(value["ordinal"])):
                    case_index = int(task["case_index_by_repetition"][repetition - 1])
                    rows.append(
                        _cell(
                            stage=stage,
                            schedule=int(group["schedule_first"]) + offset,
                            group=group,
                            task_set="router-binary-efficiency-tiny",
                            panel="calendar-maps-efficiency",
                            task_case=f"{task['task_id']}:{case_index}",
                            repetition=repetition,
                            task_ordinal=int(task["ordinal"]),
                            condition_position=list(config["execution"]["condition_order"]).index(
                                group["group_id"]
                            )
                            + 1,
                        )
                    )
                    offset += 1
        return rows

    if design == "phone-a-router-capability-suppression-full-dsv4-comparator-v1":
        group = config["groups"][0]
        if stage == "Smoke":
            source = config["smoke"]["cells"][0]
            return [
                _cell(
                    stage=stage,
                    schedule=1,
                    group=group,
                    task_set="capability-suppression-comparator",
                    panel="recovery-canary",
                    task_case=str(source["task_case"]),
                    repetition=1,
                    task_ordinal=1,
                    condition_position=3,
                )
            ]
        rows = []
        schedule = 0
        for repetition in range(1, 3):
            for task in sorted(panel, key=lambda value: int(value["ordinal"])):
                schedule += 1
                rows.append(
                    _cell(
                        stage=stage,
                        schedule=schedule,
                        group=group,
                        task_set="capability-suppression-comparator",
                        panel="fixed-four",
                        task_case=f"{task['task_id']}:{int(task['case_index'])}",
                        repetition=repetition,
                        task_ordinal=int(task["ordinal"]),
                        condition_position=3,
                    )
                )
        return rows

    if design == "phone-a-router-capability-suppression-v1":
        if stage == "Smoke":
            source = config["smoke"]["cells"][0]
            group = groups[str(source["group_id"])]
            return [
                _cell(
                    stage=stage,
                    schedule=1,
                    group=group,
                    task_set="capability-suppression",
                    panel="recovery-canary",
                    task_case=str(source["task_case"]),
                    repetition=1,
                    task_ordinal=1,
                    condition_position=1,
                )
            ]
        rows = []
        for group in config["groups"]:
            offset = 0
            for repetition in range(1, 3):
                for task in sorted(panel, key=lambda value: int(value["ordinal"])):
                    rows.append(
                        _cell(
                            stage=stage,
                            schedule=int(group["schedule_first"]) + offset,
                            group=group,
                            task_set="capability-suppression",
                            panel="fixed-four",
                            task_case=f"{task['task_id']}:{int(task['case_index'])}",
                            repetition=repetition,
                            task_ordinal=int(task["ordinal"]),
                            condition_position=1 if group["group_id"] == "Baseline" else 2,
                        )
                    )
                    offset += 1
        return rows

    if design == "phone-a-router-route-flex-tiny-preliminary-v1":
        if stage != "Smoke":
            raise ContractError("Route-Flex Tiny has no Formal stage")
        rows = _smoke_rows(config, "route-flex-tiny")
        for row in rows:
            task = next(
                value
                for value in panel
                if value["task_id"] == row["task_id"]
                and int(value["case_index"]) == row["case_index"]
            )
            row["panel"] = "tiny-preliminary"
            row["task_ordinal"] = int(task["ordinal"])
            row["condition_position"] = 1 + ((row["schedule"] - 1) % 3)
        return rows

    if design in PAIRED_IDS:
        expanded = design == "phone-a-router-r2-fsm-expanded15-paired-v1"
        task_set = "expanded15-fsm" if expanded else "tier-a-fsm"
        if stage == "Smoke":
            rows = _smoke_rows(config, task_set)
            for row in rows:
                task = next(
                    value
                    for value in panel
                    if value["task_id"] == row["task_id"]
                    and (
                        expanded
                        or int(value["case_index"]) == row["case_index"]
                    )
                )
                row["panel"] = "expanded15" if expanded else str(task["panel"])
            return rows
        rows = []
        schedule = 0
        repetitions = int(config["formal"]["repetitions_per_task"])
        for repetition in range(1, repetitions + 1):
            if expanded:
                ordered: list[dict[str, Any]] = []
                for level in config["round_level_order"][str(repetition)]:
                    ordered.extend(
                        sorted(
                            (value for value in panel if value["level"] == level),
                            key=lambda value: int(value["ordinal"]),
                        )
                    )
            else:
                ordered = sorted(panel, key=lambda value: int(value["ordinal"]))
            for task in ordered:
                case_index = (
                    int(task["case_index_by_repetition"][repetition - 1])
                    if expanded
                    else int(task["case_index"])
                )
                task_case = f"{task['task_id']}:{case_index}"
                rm_first = (repetition + int(task["ordinal"])) % 2 == 0
                pair_groups = (
                    ["G4-RM-SC", "G4-FSM-SC"]
                    if rm_first
                    else ["G4-FSM-SC", "G4-RM-SC"]
                )
                pair_id = f"formal-r{repetition:02d}-{task_case.replace(':', '-case-')}"
                for pair_position, group_id in enumerate(pair_groups, start=1):
                    schedule += 1
                    rows.append(
                        _cell(
                            stage=stage,
                            schedule=schedule,
                            group=groups[group_id],
                            task_set=task_set,
                            panel="expanded15" if expanded else str(task["panel"]),
                            task_case=task_case,
                            repetition=repetition,
                            task_ordinal=int(task["ordinal"]),
                            pair_id=pair_id,
                            pair_position=pair_position,
                        )
                    )
        return rows

    if design in MATCHED_IDS:
        if stage == "Smoke":
            return _smoke_rows(config, "matched5-router")
        rows = []
        for group_id in config["execution"]["group_order"]:
            group = groups[str(group_id)]
            offset = 0
            for repetition in range(1, 11):
                for task in sorted(panel, key=lambda value: int(value["ordinal"])):
                    rows.append(
                        _cell(
                            stage=stage,
                            schedule=int(group["schedule_first"]) + offset,
                            group=group,
                            task_set="matched5-router",
                            task_case=f"{task['task_id']}:{int(task['case_index'])}",
                            repetition=repetition,
                            task_ordinal=int(task["ordinal"]),
                        )
                    )
                    offset += 1
        return rows

    if stage == "Smoke":
        return _smoke_rows(config, "expanded15")

    rows = []
    for group_id in config["execution"]["group_order"]:
        group = groups[str(group_id)]
        offset = 0
        for repetition in range(1, 5):
            for level in config["round_level_order"][str(repetition)]:
                for task in (value for value in panel if value["level"] == level):
                    case_index = int(task["case_index_by_repetition"][repetition - 1])
                    rows.append(
                        _cell(
                            stage=stage,
                            schedule=int(group["schedule_first"]) + offset,
                            group=group,
                            task_set="expanded15",
                            task_case=f"{task['task_id']}:{case_index}",
                            repetition=repetition,
                            level=str(level),
                        )
                    )
                    offset += 1
    return rows


def select_plan(
    config: dict[str, Any],
    stage: str,
    *,
    group_id: str | None = None,
    start_schedule: int | None = None,
    end_schedule: int | None = None,
) -> list[dict[str, Any]]:
    design = str(config["design_id"])
    if design in SINGLE_GROUP_IDS:
        allowed = [str(value) for value in config["execution"]["group_order"]]
        if group_id not in allowed:
            raise ContractError(f"--group-id must be one of: {', '.join(allowed)}")
    elif design in MULTI_CONDITION_IDS and group_id is not None:
        raise ContractError("multi-condition designs do not accept --group-id")
    elif group_id is not None:
        raise ContractError("this design does not accept --group-id")
    rows = build_plan(config, stage)
    if group_id is not None:
        rows = [row for row in rows if row["group_id"] == group_id]
    if start_schedule is not None or end_schedule is not None:
        if stage != "Formal":
            raise ContractError("schedule slicing is supported only for Formal")
        if start_schedule is not None:
            rows = [row for row in rows if row["schedule"] >= start_schedule]
        if end_schedule is not None:
            rows = [row for row in rows if row["schedule"] <= end_schedule]
    if not rows:
        raise ContractError("selected plan contains no cells")
    return rows


def plan_digest(rows: Iterable[dict[str, Any]]) -> str:
    import hashlib

    payload = json.dumps(list(rows), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
