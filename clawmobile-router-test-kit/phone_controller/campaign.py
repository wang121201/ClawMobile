from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .common import (
    ContractError,
    RUN_ID_RE,
    SAFE_ID_RE,
    ensure_descendant,
    load_json,
    sha256_file,
    utc_now,
    utc_stamp,
    write_json_exclusive,
)
from .config_plan import (
    CONFIG_ROOT,
    MULTI_CONDITION_IDS,
    PAIRED_IDS,
    PACKAGE_ROOT,
    SINGLE_GROUP_IDS,
    load_frozen_config,
    plan_digest,
    select_plan,
)
from .environment import Site, assert_environment, load_site, router_client_token
from .evidence import copy_capture, validate_capture, wait_proxy_capture
from .services import ensure_services, stop_managed


CLAWBENCH_ROOT = PACKAGE_ROOT / "clawbench-runtime"
RUN_TASK_SET = CLAWBENCH_ROOT / "scripts" / "run_task_set.py"
SKILL_RUNNER = CLAWBENCH_ROOT / "scripts" / "run_verifier_skill.py"


def _cell_root(output_root: Path, cell: dict[str, Any]) -> Path:
    case_slug = str(cell["task_case"]).replace(":", "-case-")
    return (
        output_root
        / str(cell["stage"])
        / str(cell["group_id"])
        / f"s{int(cell['schedule']):04d}_r{int(cell['repetition']):02d}_{case_slug}"
    )


def _read_result(cell_root: Path) -> tuple[Path, dict[str, Any]]:
    files = list((cell_root / "json").glob("*.json"))
    if len(files) != 1:
        raise ContractError(
            f"expected exactly one ClawBench result JSON under {cell_root / 'json'}; "
            f"observed {len(files)}"
        )
    return files[0], load_json(files[0])


def _claim(cell_root: Path, cell: dict[str, Any], group_run_id: str) -> None:
    try:
        cell_root.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ContractError(
            f"Cell evidence already exists; refusing before model request: {cell_root}"
        ) from exc
    write_json_exclusive(
        cell_root / "cell-claim.json",
        {
            "schema_version": 4,
            "record_type": "cell_claim",
            "claimed_at": utc_now(),
            "group_run_id": group_run_id,
            "stage": cell["stage"],
            "schedule": int(cell["schedule"]),
            "group_id": cell["group_id"],
            "arm_id": cell["arm_id"],
            "task_case": cell["task_case"],
            "repetition": int(cell["repetition"]),
        },
    )


def _run_cell(
    site: Site,
    config: dict[str, Any],
    cell: dict[str, Any],
    output_root: Path,
    group_run_id: str,
    expected_boot_id: str,
    router_token: str,
) -> dict[str, Any]:
    cell_root = _cell_root(output_root, cell)
    stages: list[dict[str, Any]] = []
    claimed = False
    result_path: Path | None = None
    result: dict[str, Any] | None = None
    run_id: str | None = None
    capture_validation: dict[str, Any] | None = None
    capture_files: list[dict[str, Any]] = []
    runner_exit_code: int | None = None
    error: dict[str, Any] | None = None
    started = time.monotonic()
    try:
        at = utc_now()
        assert_environment(site, expected_boot_id=expected_boot_id)
        stages.append(
            {
                "stage": "PRECHECK",
                "started_at": at,
                "completed_at": utc_now(),
                "semantics": "Local ADB, Channel, Gateway and shared Proxy verified before Cell claim.",
            }
        )
        at = utc_now()
        _claim(cell_root, cell, group_run_id)
        claimed = True
        stages.append({"stage": "CLAIM", "started_at": at, "completed_at": utc_now()})
        write_json_exclusive(
            cell_root / "cell-plan.json",
            {
                "schema_version": 4,
                "group_run_id": group_run_id,
                "stage": cell["stage"],
                "schedule": int(cell["schedule"]),
                "group_id": cell["group_id"],
                "arm_id": cell["arm_id"],
                "task_case": cell["task_case"],
                "repetition": int(cell["repetition"]),
            },
        )

        env = os.environ.copy()
        if site.adb_server_socket:
            env["ADB_SERVER_SOCKET"] = site.adb_server_socket
        else:
            env.pop("ADB_SERVER_SOCKET", None)
        env.update(
            {
                "CLAWBENCH_RESULTS_DIR": str(cell_root),
                "CLAWBENCH_AGENT_BASE_URL": site.channel_url,
                "CLAWBENCH_EXPERIMENT_ARM_ID": str(cell["arm_id"]),
                "CLAWBENCH_PROXY_CONTROL_URL": site.proxy_url,
                "CLAWBENCH_PROXY_CONTROL_TOKEN": router_token,
                "CLAWBENCH_ADB_TIMEOUT_SECONDS": str(site.adb_command_seconds),
                "CLAWBENCH_DEVICE_SERIAL": site.adb_serial,
                "CLAWBENCH_SKILL_RUNNER": f"{site.python_executable} {SKILL_RUNNER}",
                "ANDROID_SERIAL": site.adb_serial,
                "DROIDRUN_SERIAL": site.adb_serial,
            }
        )
        run_label = f"{group_run_id}-{cell['stage']}-s{int(cell['schedule']):04d}"
        arguments = [
            site.python_executable,
            str(RUN_TASK_SET),
            "--device-serial",
            site.adb_serial,
            "--model-label",
            str(cell["group_id"]),
            "--task-case",
            str(cell["task_case"]),
            "--repeat",
            "1",
            "--seed",
            "0",
            "--run-label",
            run_label,
        ]
        at = utc_now()
        stages.append(
            {
                "stage": "SETUP",
                "started_at": at,
                "completed_at": at,
                "semantics": "ClawBench setup executes inside RUN.",
            }
        )
        with (cell_root / "runner.stdout.log").open("wb") as stdout, (
            cell_root / "runner.stderr.log"
        ).open("wb") as stderr:
            process = subprocess.run(
                arguments,
                cwd=str(CLAWBENCH_ROOT),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                check=False,
            )
        runner_exit_code = process.returncode
        stages.append(
            {
                "stage": "RUN",
                "started_at": at,
                "completed_at": utc_now(),
                "runner_exit_code": runner_exit_code,
            }
        )

        result_path, result = _read_result(cell_root)
        candidate = result.get("run_id")
        if not isinstance(candidate, str) or RUN_ID_RE.fullmatch(candidate) is None:
            raise ContractError("ClawBench result lacks lowercase 32-hex result.run_id")
        run_id = candidate
        at = utc_now()
        proxy_health = wait_proxy_capture(site, run_id)
        stages.append(
            {
                "stage": "FLUSH",
                "started_at": at,
                "completed_at": utc_now(),
                "capture": proxy_health["capture"],
            }
        )
        at = utc_now()
        capture_files = copy_capture(site, run_id, cell_root)
        capture_validation = validate_capture(
            cell_root / "model-calls.jsonl",
            cell_root / "proxy-events.jsonl",
            run_id,
            str(cell["arm_id"]),
        )
        outcome = result.get("results", {}).get("outcome")
        if outcome not in {"SUCCESS", "FAILURE", "INFRA_FAILURE", "TIMEOUT"}:
            raise ContractError(f"unknown ClawBench outcome: {outcome}")
        if runner_exit_code != 0 or outcome in {"INFRA_FAILURE", "TIMEOUT"}:
            raise ContractError(
                f"ClawBench infrastructure outcome={outcome}, exit={runner_exit_code}"
            )
        stages.append(
            {
                "stage": "VERIFY",
                "started_at": at,
                "completed_at": utc_now(),
                "capture": capture_validation,
            }
        )
        at = utc_now()
        assert_environment(site, expected_boot_id=expected_boot_id)
        stages.append(
            {
                "stage": "TEARDOWN",
                "started_at": at,
                "completed_at": utc_now(),
                "semantics": "ClawBench teardown completed; same phone boot reverified.",
            }
        )
    except Exception as exc:
        error = {"type": type(exc).__name__, "message": str(exc)}

    outcome = result.get("results", {}).get("outcome") if result else None
    infrastructure_failure = error is not None
    if infrastructure_failure:
        classification = "experiment_infrastructure_failure"
    elif outcome == "SUCCESS":
        classification = "primary_scored_success"
    else:
        classification = "primary_scored_failure"
    elapsed_ms = round((time.monotonic() - started) * 1000)
    status = {
        "schema_version": 4,
        "record_type": "cell_status",
        "written_at": utc_now(),
        "controller_platform": "termux-android-phone-native-v1",
        "site_id": site.site_id,
        "group_run_id": group_run_id,
        "stage": cell["stage"],
        "schedule": int(cell["schedule"]),
        "group_id": cell["group_id"],
        "arm_id": cell["arm_id"],
        "task_case": cell["task_case"],
        "repetition": int(cell["repetition"]),
        "result_run_id": run_id,
        "session_id": run_id,
        "result_outcome": outcome,
        "classification": classification,
        "experiment_infrastructure_failure": infrastructure_failure,
        "runner_exit_code": runner_exit_code,
        "elapsed_ms": elapsed_ms,
        "stages": stages,
        "result_evidence": (
            {"path": str(result_path), "sha256": sha256_file(result_path)}
            if result_path is not None
            else None
        ),
        "capture_files": capture_files,
        "capture_validation": capture_validation,
        "error": error,
    }
    if claimed:
        write_json_exclusive(cell_root / "cell-status.json", status)
    return status


METRIC_KEYS = [
    "route_failure_count",
    "local_backend_selection_count",
    "local_agent_call_count",
    "accepted_local_call_count",
    "fsm_admissibility_restriction_count",
    "fsm_transition_pending_count",
    "fsm_transition_resolved_count",
    "fsm_transition_match_count",
    "fsm_forced_cloud_handoff_count",
    "repair_attempt_count",
    "repair_applied_count",
    "repair_rejected_count",
    "raw_valid_local_call_count",
    "repair_assisted_valid_local_call_count",
    "repair_intercepted_after_revalidation_count",
    "cloud_agent_call_count",
    "proxy_request_count",
    "route_reclassification_applied_count",
    "route_reclassification_rejected_count",
    "c1_reclassification_execution_count",
    "c2_added_execution_count",
    "cloud_first_gate_trigger_count",
    "cloud_first_followup_ui_count",
    "cloud_first_followup_provider_count",
    "cloud_first_followup_shell_count",
    "cloud_first_followup_no_tool_count",
    "cloud_first_followup_mixed_count",
    "effect_aware_transition_count",
    "strong_path_check_exposure_count",
]


def _sum_metrics(statuses: list[dict[str, Any]]) -> dict[str, int]:
    return {
        key: sum(int(status.get("capture_validation", {}).get(key, 0)) for status in statuses)
        for key in METRIC_KEYS
    }


def _smoke_gate(
    config: dict[str, Any],
    config_hash: str,
    group_id: str | None,
    group_run_id: str,
    plan: list[dict[str, Any]],
    statuses: list[dict[str, Any]],
) -> dict[str, Any]:
    design = str(config["design_id"])
    metrics = _sum_metrics(statuses)
    healthy = sum(
        1
        for status in statuses
        if status.get("capture_validation", {}).get("structurally_healthy") is True
    )
    infra = sum(1 for status in statuses if status["experiment_infrastructure_failure"])
    run_ids = [status.get("result_run_id") for status in statuses]
    accepted_tasks = sorted(
        {
            status["task_case"].split(":", 1)[0]
            for status in statuses
            if int(status.get("capture_validation", {}).get("accepted_local_call_count", 0))
            > 0
        }
    )
    c1_tasks = sorted(
        {
            status["task_case"].split(":", 1)[0]
            for status in statuses
            if status["group_id"] == "C1"
            and int(status.get("capture_validation", {}).get("c1_reclassification_execution_count", 0))
            > 0
        }
    )
    c2_tasks = sorted(
        {
            status["task_case"].split(":", 1)[0]
            for status in statuses
            if status["group_id"] == "C2"
            and int(status.get("capture_validation", {}).get("c2_added_execution_count", 0))
            > 0
        }
    )
    requires = design in {
        "phone-a-router-rm-matched5-v1",
        "phone-a-router-rm-expanded15-v1",
        *PAIRED_IDS,
        "phone-a-router-fsm-scoped-repair-expanded15-v1",
        "phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1",
        "phone-a-router-binary-tool-expanded15-v1",
        "phone-a-router-explicit-binary-tool-expanded15-v1",
        "phone-a-router-route-flex-tiny-preliminary-v1",
        "phone-a-router-binary-efficiency-tiny-v1",
    }
    smoke = config["smoke"]
    if design == "phone-a-router-binary-efficiency-tiny-v1":
        mechanism = (
            metrics["route_failure_count"] == 0
            and metrics["effect_aware_transition_count"]
            >= int(smoke["minimum_effect_aware_transitions"])
            and metrics["strong_path_check_exposure_count"]
            >= int(smoke["minimum_strong_path_check_exposures"])
        )
    elif design == "phone-a-router-route-flex-tiny-preliminary-v1":
        mechanism = (
            metrics["route_failure_count"] == 0
            and len(c1_tasks) >= int(smoke["minimum_c1_intervention_tasks"])
            and len(c2_tasks) >= int(smoke["minimum_c2_intervention_tasks"])
        )
    elif design in PAIRED_IDS:
        by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for status in statuses:
            by_group[status["group_id"]].append(status)
        rm = _sum_metrics(by_group["G4-RM-SC"])
        fsm = _sum_metrics(by_group["G4-FSM-SC"])
        mechanism = (
            metrics["route_failure_count"] == 0
            and len(by_group["G4-RM-SC"]) == int(smoke["cell_count_per_group"])
            and len(by_group["G4-FSM-SC"]) == int(smoke["cell_count_per_group"])
            and rm["local_backend_selection_count"]
            >= int(smoke["minimum_local_backend_selections_per_group"])
            and fsm["local_backend_selection_count"]
            >= int(smoke["minimum_local_backend_selections_per_group"])
            and rm["accepted_local_call_count"]
            >= int(smoke["minimum_accepted_local_calls_per_group"])
            and fsm["accepted_local_call_count"]
            >= int(smoke["minimum_accepted_local_calls_per_group"])
            and metrics["fsm_admissibility_restriction_count"]
            >= int(smoke["minimum_fsm_admissibility_restrictions"])
            and metrics["fsm_transition_match_count"]
            >= int(smoke["minimum_fsm_transition_matches"])
        )
    elif design in {
        "phone-a-router-fsm-scoped-repair-expanded15-v1",
        "phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1",
        "phone-a-router-binary-tool-expanded15-v1",
        "phone-a-router-explicit-binary-tool-expanded15-v1",
    }:
        minimum_tasks = int(smoke.get("minimum_distinct_tasks_with_accepted_local", 0))
        mechanism = (
            metrics["route_failure_count"] == 0
            and metrics["local_backend_selection_count"]
            >= int(smoke["minimum_local_backend_selections"])
            and metrics["local_agent_call_count"] >= 1
            and metrics["accepted_local_call_count"]
            >= int(smoke["minimum_accepted_local_calls"])
            and metrics["fsm_admissibility_restriction_count"]
            >= int(smoke["minimum_fsm_admissibility_restrictions"])
            and metrics["fsm_transition_match_count"]
            >= int(smoke["minimum_fsm_transition_matches"])
            and metrics["repair_attempt_count"] >= int(smoke["minimum_repair_attempts"])
            and metrics["repair_applied_count"] >= int(smoke["minimum_repair_applied"])
            and len(accepted_tasks) >= minimum_tasks
        )
    elif requires:
        mechanism = (
            metrics["route_failure_count"] == 0
            and metrics["local_backend_selection_count"]
            >= int(smoke["minimum_local_backend_selections"])
            and metrics["local_agent_call_count"] >= 1
            and metrics["accepted_local_call_count"]
            >= int(smoke["minimum_accepted_local_calls"])
        )
    else:
        mechanism = True
    return {
        "schema_version": 4,
        "record_type": "smoke_gate",
        "written_at": utc_now(),
        "controller_platform": "termux-android-phone-native-v1",
        "design_id": design,
        "config_sha256": config_hash,
        "passed": healthy == len(plan)
        and infra == 0
        and len(statuses) == len(plan)
        and len(set(run_ids)) == len(plan)
        and mechanism,
        "cell_count": len(plan),
        "group_run_id": group_run_id,
        "group_id": group_id,
        "groups": [status["group_id"] for status in statuses],
        "result_run_ids": run_ids,
        "structurally_healthy_count": healthy,
        "infrastructure_failure_count": infra,
        "mechanism_exposure_required": requires,
        "mechanism_exposure_passed": mechanism,
        **metrics,
        "accepted_local_task_ids": accepted_tasks,
        "c1_intervention_task_ids": c1_tasks,
        "c2_intervention_task_ids": c2_tasks,
    }


def _validate_formal_gate(
    gate_path: Path,
    config: dict[str, Any],
    config_hash: str,
    group_id: str | None,
) -> None:
    gate = load_json(gate_path)
    if (
        gate.get("schema_version") != 4
        or gate.get("passed") is not True
        or gate.get("design_id") != config["design_id"]
        or gate.get("config_sha256") != config_hash
    ):
        raise ContractError("Formal requires a healthy Smoke gate for identical config bytes")
    if config["design_id"] in SINGLE_GROUP_IDS and gate.get("group_id") != group_id:
        raise ContractError("Smoke gate belongs to a different Router group")
    if gate.get("mechanism_exposure_required") and not gate.get(
        "mechanism_exposure_passed"
    ):
        raise ContractError("Formal requires real Router mechanism exposure in Smoke")


def _run(args: argparse.Namespace, site: Site) -> int:
    requested_config = Path(args.config).expanduser()
    if requested_config.is_absolute():
        config_path = requested_config.resolve()
    elif requested_config.parent == Path("."):
        config_path = (CONFIG_ROOT / requested_config.name).resolve()
    else:
        config_path = (PACKAGE_ROOT / requested_config).resolve()
    config, config_hash = load_frozen_config(config_path)
    plan = select_plan(
        config,
        args.stage,
        group_id=args.group_id,
        start_schedule=args.start_schedule,
        end_schedule=args.end_schedule,
    )
    if args.validate_only:
        print(
            json.dumps(
                {
                    "validation": "passed",
                    "schema_version": 4,
                    "design_id": config["design_id"],
                    "stage": args.stage,
                    "cell_count": len(plan),
                    "groups": list(dict.fromkeys(row["group_id"] for row in plan)),
                    "first_schedule": plan[0]["schedule"],
                    "last_schedule": plan[-1]["schedule"],
                    "plan_sha256": plan_digest(plan),
                    "controller_platform": "termux-android-phone-native-v1",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    group_run_id = args.group_run_id or f"phone-{args.stage.lower()}-{utc_stamp()}"
    if SAFE_ID_RE.fullmatch(group_run_id) is None:
        raise ContractError("group-run-id must contain 8-128 safe characters")
    output_root = (
        Path(args.output_root).expanduser().resolve()
        if args.output_root
        else (site.output_root / group_run_id).resolve()
    )
    ensure_descendant(output_root, site.output_root, "campaign output")
    if output_root.exists():
        raise ContractError(f"output root already exists; refusing overwrite: {output_root}")
    if args.stage == "Formal":
        if not args.smoke_gate:
            raise ContractError("Formal requires --smoke-gate")
        _validate_formal_gate(Path(args.smoke_gate).expanduser().resolve(), config, config_hash, args.group_id)
    output_root.mkdir(parents=True, exist_ok=False)
    write_json_exclusive(
        output_root / f"campaign-plan.{args.stage.lower()}.json",
        {
            "schema_version": 4,
            "record_type": "campaign_plan",
            "created_at": utc_now(),
            "controller_platform": "termux-android-phone-native-v1",
            "site_id": site.site_id,
            "design_id": config["design_id"],
            "config_path": str(config_path),
            "config_sha256": config_hash,
            "group_run_id": group_run_id,
            "stage": args.stage.lower(),
            "group_id": args.group_id,
            "cell_count": len(plan),
            "start_schedule": plan[0]["schedule"],
            "end_schedule": plan[-1]["schedule"],
            "plan_sha256": plan_digest(plan),
            "cells": plan,
        },
    )
    started_at = utc_now()
    statuses: list[dict[str, Any]] = []
    environment: dict[str, Any] | None = None
    invocation_error: dict[str, Any] | None = None
    try:
        ensure_services(site)
        environment = assert_environment(site)
        router_token = router_client_token(site)
        expected_boot_id = str(environment["adb"]["boot_id"])
        for cell in plan:
            status = _run_cell(
                site,
                config,
                cell,
                output_root,
                group_run_id,
                expected_boot_id,
                router_token,
            )
            statuses.append(status)
            print(
                json.dumps(
                    {
                        "schedule": status["schedule"],
                        "group": status["group_id"],
                        "task": status["task_case"],
                        "repetition": status["repetition"],
                        "classification": status["classification"],
                        "run_id": status["result_run_id"],
                        "elapsed_ms": status["elapsed_ms"],
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )
            if status["experiment_infrastructure_failure"]:
                break
    except Exception as exc:
        invocation_error = {"type": type(exc).__name__, "message": str(exc)}
    infra_statuses = [row for row in statuses if row["experiment_infrastructure_failure"]]
    invocation = {
        "schema_version": 4,
        "record_type": "invocation_status",
        "controller_platform": "termux-android-phone-native-v1",
        "site_id": site.site_id,
        "group_run_id": group_run_id,
        "stage": args.stage.lower(),
        "started_at": started_at,
        "completed_at": utc_now(),
        "planned_cell_count": len(plan),
        "completed_status_count": len(statuses),
        "scored_success_count": sum(
            1 for row in statuses if row["classification"] == "primary_scored_success"
        ),
        "scored_failure_count": sum(
            1 for row in statuses if row["classification"] == "primary_scored_failure"
        ),
        "infrastructure_failure_count": len(infra_statuses)
        + (1 if invocation_error is not None else 0),
        "continued_after_infrastructure_failure": False,
        "stopped_on_first_infrastructure_failure": bool(infra_statuses or invocation_error),
        "stop_schedule": infra_statuses[0]["schedule"] if infra_statuses else None,
        "stop_error": infra_statuses[0]["error"] if infra_statuses else invocation_error,
        "infrastructure_failure_policy": "preserve_and_stop_current_group",
        "environment": environment,
        "invocation_error": invocation_error,
    }
    write_json_exclusive(output_root / f"invocation.{args.stage.lower()}.json", invocation)
    if args.stage == "Smoke" and len(statuses) == len(plan):
        gate = _smoke_gate(config, config_hash, args.group_id, group_run_id, plan, statuses)
        write_json_exclusive(output_root / "smoke-gate.json", gate)
        print(json.dumps({"smoke_gate": gate["passed"]}, separators=(",", ":")))
    if invocation_error or infra_statuses:
        return 2
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run ClawMobile Router campaigns entirely on an Android Termux phone."
    )
    parser.add_argument(
        "--site",
        default=str(PACKAGE_ROOT / "phone" / "phone-site.json"),
        help="Private phone-site.json path.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("doctor", help="Read-only local environment health check.")
    service = subparsers.add_parser("services", help="Start or stop managed local services.")
    service.add_argument("action", choices=["start", "stop-proxy", "stop-gateway"])
    run = subparsers.add_parser("run", help="Validate or execute a frozen campaign plan.")
    run.add_argument("--stage", choices=["Smoke", "Formal"], required=True)
    run.add_argument("--config", required=True)
    run.add_argument("--group-id")
    run.add_argument("--group-run-id")
    run.add_argument("--output-root")
    run.add_argument("--smoke-gate")
    run.add_argument("--start-schedule", type=int)
    run.add_argument("--end-schedule", type=int)
    run.add_argument("--validate-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        site = load_site(Path(args.site), check_executables=not (args.command == "run" and args.validate_only))
        if args.command == "doctor":
            print(json.dumps(assert_environment(site), ensure_ascii=False, indent=2))
            return 0
        if args.command == "services":
            if args.action == "start":
                print(json.dumps(ensure_services(site), ensure_ascii=False, indent=2))
            elif args.action == "stop-proxy":
                print(json.dumps(stop_managed(site, "proxy"), ensure_ascii=False, indent=2))
            else:
                print(json.dumps(stop_managed(site, "gateway"), ensure_ascii=False, indent=2))
            return 0
        return _run(args, site)
    except ContractError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
