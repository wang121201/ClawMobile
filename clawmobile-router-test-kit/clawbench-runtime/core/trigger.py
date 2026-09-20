"""Send task instructions to the native ClawBench channel endpoint."""

from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_AGENT_BASE_URL = "http://127.0.0.1:8765"


def trigger(instruction: str, run_id: str, device, timeout_s: float = 10.0) -> None:
    """Create one benchmark run using the caller-owned run identifier."""

    _register_experiment_run(run_id, timeout_s=timeout_s)
    payload = {
        "run_id": run_id,
        "instruction": instruction,
        "device_serial": getattr(device, "serial", None),
    }
    _request_json("POST", "/runs", payload, timeout_s=timeout_s)


def _register_experiment_run(run_id: str, timeout_s: float) -> None:
    arm_id = os.environ.get("CLAWBENCH_EXPERIMENT_ARM_ID", "").strip()
    if not arm_id:
        return
    if re.fullmatch(r"[0-9a-f]{32}", run_id) is None:
        raise RuntimeError("Proxy registration requires one lowercase 32-hex run_id")
    base_url = os.environ.get("CLAWBENCH_PROXY_CONTROL_URL", "").strip().rstrip("/")
    token = os.environ.get("CLAWBENCH_PROXY_CONTROL_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError(
            "CLAWBENCH_PROXY_CONTROL_URL and CLAWBENCH_PROXY_CONTROL_TOKEN are required "
            "when CLAWBENCH_EXPERIMENT_ARM_ID is set"
        )
    payload = json.dumps({"arm_id": arm_id}).encode("utf-8")
    request = Request(
        f"{base_url}/v1/experiment/runs/{quote(run_id, safe='')}",
        data=payload,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Proxy run registration returned HTTP {exc.code}: {message}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(f"Proxy run registration failed: {exc.reason}") from exc
    parsed = json.loads(raw or "{}")
    registration = parsed.get("registration") if isinstance(parsed, dict) else None
    if not isinstance(registration, dict):
        raise RuntimeError("Proxy run registration returned invalid JSON")
    if registration.get("runId") != run_id or registration.get("armId") != arm_id:
        raise RuntimeError("Proxy run registration identity mismatch")


def _request_json(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    timeout_s: float = 10.0,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    token = os.environ.get("CLAWBENCH_AGENT_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = Request(
        f"{_agent_base_url()}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"agent endpoint returned HTTP {exc.code}: {message}") from exc
    except URLError as exc:
        raise RuntimeError(f"agent endpoint request failed: {exc.reason}") from exc

    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("agent endpoint returned a non-object JSON response")
    return parsed


def _agent_base_url() -> str:
    return os.environ.get("CLAWBENCH_AGENT_BASE_URL", DEFAULT_AGENT_BASE_URL).rstrip("/")
