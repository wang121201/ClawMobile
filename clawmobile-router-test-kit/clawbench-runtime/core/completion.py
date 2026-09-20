"""Wait for native ClawBench channel run completion."""

from __future__ import annotations

import json
import os
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_AGENT_BASE_URL = "http://127.0.0.1:8765"
DEFAULT_RUN_TIMEOUT_S: float | None = None
TERMINAL_STATUSES = {"COMPLETED", "FAILED"}


def wait_for_completion(
    run_id: str,
    timeout_s: float | None = None,
    poll_interval_s: float | None = None,
    request_timeout_s: float = 10.0,
) -> str:
    """Poll the local agent endpoint until the run reaches a terminal status."""

    run = wait_for_run_completion(
        run_id,
        timeout_s=timeout_s,
        poll_interval_s=poll_interval_s,
        request_timeout_s=request_timeout_s,
    )
    status = run.get("status")
    return str(status) if status else "TIMEOUT"


def wait_for_run_completion(
    run_id: str,
    timeout_s: float | None = None,
    poll_interval_s: float | None = None,
    request_timeout_s: float = 10.0,
) -> dict[str, Any]:
    """Poll the local agent endpoint until terminal status and return the full run."""

    resolved_timeout_s = _resolve_timeout_s(timeout_s)
    deadline = (
        None if resolved_timeout_s is None else time.monotonic() + resolved_timeout_s
    )
    poll_interval = poll_interval_s
    if poll_interval is None:
        poll_interval = float(os.environ.get("CLAWBENCH_POLL_INTERVAL_S", "1.0"))
    last_run: dict[str, Any] | None = None

    while True:
        if deadline is not None and time.monotonic() >= deadline:
            return _timeout_run(run_id, last_run)
        try:
            run = _get_run(run_id, timeout_s=request_timeout_s)
            last_run = run
        except TimeoutError:
            if deadline is not None and time.monotonic() >= deadline:
                return _timeout_run(run_id, last_run)
            time.sleep(_next_sleep_s(poll_interval, deadline))
            continue
        status = run.get("status")
        if status in TERMINAL_STATUSES:
            return run
        if deadline is not None and time.monotonic() >= deadline:
            return _timeout_run(run_id, last_run)
        time.sleep(_next_sleep_s(poll_interval, deadline))


def _resolve_timeout_s(timeout_s: float | None) -> float | None:
    if timeout_s is None:
        raw = os.environ.get("CLAWBENCH_RUN_TIMEOUT_S")
        if raw is None:
            return DEFAULT_RUN_TIMEOUT_S
        timeout_s = float(raw)
    if timeout_s <= 0:
        return None
    return timeout_s


def _next_sleep_s(poll_interval_s: float, deadline: float | None) -> float:
    if deadline is None:
        return poll_interval_s
    return min(poll_interval_s, max(0.0, deadline - time.monotonic()))


def _timeout_run(run_id: str, last_run: dict[str, Any] | None) -> dict[str, Any]:
    run = dict(last_run or {"runId": run_id})
    run["status"] = "TIMEOUT"
    return run


def _get_run(run_id: str, timeout_s: float = 10.0) -> dict[str, Any]:
    path = f"/runs/{quote(run_id, safe='')}"
    response = _request_json("GET", path, timeout_s=timeout_s)
    run = response.get("run")
    if not isinstance(run, dict):
        raise RuntimeError("agent endpoint response does not contain a run object")
    return run


def _request_json(method: str, path: str, timeout_s: float = 10.0) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    token = os.environ.get("CLAWBENCH_AGENT_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = Request(
        f"{_agent_base_url()}{path}",
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
