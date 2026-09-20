from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .common import ContractError, http_json, utc_now, wait_http_json, write_json_exclusive
from .environment import Site, router_client_token


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PROXY_CLI = PACKAGE_ROOT / "clawmobile-router-proxy" / "src" / "cli.js"


def _healthy(url: str, predicate) -> dict[str, Any] | None:
    try:
        value = http_json("GET", url, timeout=3)
    except ContractError:
        return None
    return value if predicate(value) else None


def _open_log(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("ab", buffering=0)


def _proc_start_ticks(pid: int) -> int | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()
        return int(fields[21])
    except (OSError, ValueError, IndexError):
        return None


def _record_process(site: Site, kind: str, process: subprocess.Popen[bytes], command: list[str]) -> None:
    record = {
        "schema_version": 2,
        "record_type": "phone_native_managed_service",
        "kind": kind,
        "pid": process.pid,
        "proc_start_ticks": _proc_start_ticks(process.pid),
        "started_at": utc_now(),
        "command": command,
        "package_root": str(PACKAGE_ROOT),
    }
    write_json_exclusive(site.state_root / f"managed-{kind}-{process.pid}.json", record)


def ensure_gateway(site: Site) -> dict[str, Any]:
    gateway = _healthy(f"{site.gateway_url}/healthz", lambda _: True)
    channel = _healthy(f"{site.channel_url}/health", lambda row: row.get("ok") is True)
    if gateway is not None and channel is not None:
        return {"action": "reused", "gateway": gateway, "channel": channel}
    if gateway is not None or channel is not None:
        raise ContractError(
            "Gateway/Channel are only partially healthy; refusing to start a duplicate"
        )
    site.state_root.mkdir(parents=True, exist_ok=True)
    command = [
        site.openclaw_executable,
        "gateway",
        "--bind",
        "loopback",
        "--port",
        "18789",
        "--verbose",
    ]
    env = os.environ.copy()
    env.update(
        {
            "CLAW_MOBILE_NOTIFY_VIBRATE": "0",
            "CLAW_MOBILE_NOTIFY_TOAST": "0",
            "ANDROID_SERIAL": site.adb_serial,
            "DROIDRUN_SERIAL": site.adb_serial,
            "TMPDIR": os.environ.get("PREFIX", "/data/data/com.termux/files/usr")
            + "/tmp",
        }
    )
    stdout = _open_log(site.state_root / "gateway.stdout.log")
    process = subprocess.Popen(
        command,
        cwd=str(PACKAGE_ROOT),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    stdout.close()
    _record_process(site, "gateway", process, command)
    try:
        gateway = wait_http_json(
            f"{site.gateway_url}/healthz",
            predicate=lambda _: True,
            timeout=site.service_start_seconds,
            interval=1.0,
        )
        channel = wait_http_json(
            f"{site.channel_url}/health",
            predicate=lambda row: row.get("ok") is True,
            timeout=site.service_start_seconds,
            interval=1.0,
        )
    except Exception:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        raise
    return {
        "action": "started",
        "pid": process.pid,
        "gateway": gateway,
        "channel": channel,
    }


def ensure_proxy(site: Site) -> dict[str, Any]:
    proxy = _healthy(
        f"{site.proxy_url}/health",
        lambda row: row.get("status") == "ok" and row.get("v4_enabled") is True,
    )
    if proxy is not None:
        advertised = proxy.get("capture_root")
        if advertised is None:
            raise ContractError(
                "existing Proxy predates phone-native capture-root identity; stop it explicitly "
                "before starting the managed Proxy"
            )
        if Path(str(advertised)).resolve() != site.capture_root:
            raise ContractError(
                f"existing Proxy owns a different capture root: {advertised}"
            )
        return {"action": "reused", "proxy": proxy}
    if not PROXY_CLI.is_file():
        raise ContractError(f"Proxy entry point is missing: {PROXY_CLI}")
    token = router_client_token(site)
    site.capture_root.mkdir(parents=True, exist_ok=True)
    site.state_root.mkdir(parents=True, exist_ok=True)
    command = [site.node_executable, str(PROXY_CLI)]
    env = os.environ.copy()
    env.pop("CLAW_ROUTER_SESSION_ID", None)
    env.update(
        {
            "CLAW_ROUTER_CLIENT_TOKEN": token,
            "CLAW_ROUTER_V4_ENABLED": "1",
            "CLAW_ROUTER_V4_PROFILE_SET": "router-only",
            "CLAW_ROUTER_CAPTURE_ROOT": str(site.capture_root),
            "CLAW_ROUTER_PORT": "18081",
            "CLAW_ROUTER_STRATEGY_TIMEOUT_MS": str(site.physical_request_milliseconds),
            "CLAW_ROUTER_ANSWER_TIMEOUT_MS": str(site.physical_request_milliseconds),
            "OPENCLAW_CONFIG_PATH": str(site.openclaw_config),
        }
    )
    stdout = _open_log(site.state_root / "proxy.stdout.log")
    stderr = _open_log(site.state_root / "proxy.stderr.log")
    process = subprocess.Popen(
        command,
        cwd=str(PACKAGE_ROOT / "clawmobile-router-proxy"),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        start_new_session=True,
    )
    stdout.close()
    stderr.close()
    _record_process(site, "proxy", process, command)
    try:
        proxy = wait_http_json(
            f"{site.proxy_url}/health",
            predicate=lambda row: row.get("status") == "ok"
            and row.get("v4_enabled") is True
            and Path(str(row.get("capture_root", ""))).resolve() == site.capture_root,
            timeout=site.service_start_seconds,
            interval=1.0,
        )
    except Exception:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        raise
    return {"action": "started", "pid": process.pid, "proxy": proxy}


def ensure_services(site: Site) -> dict[str, Any]:
    return {"gateway": ensure_gateway(site), "proxy": ensure_proxy(site)}


def _cmdline(pid: int) -> list[str]:
    path = Path(f"/proc/{pid}/cmdline")
    try:
        raw = path.read_bytes()
    except OSError:
        return []
    return [part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part]


def _matches_managed_identity(
    site: Site,
    kind: str,
    record: dict[str, Any],
    observed: list[str],
    observed_start_ticks: int | None,
) -> bool:
    if record.get("record_type") != "phone_native_managed_service":
        return False
    if record.get("kind") != kind:
        return False
    if Path(str(record.get("package_root", ""))).resolve() != PACKAGE_ROOT:
        return False
    expected = [str(value) for value in record.get("command", [])]
    if not expected or not observed:
        return False
    recorded_ticks = record.get("proc_start_ticks")
    if recorded_ticks is not None:
        try:
            if int(recorded_ticks) != observed_start_ticks:
                return False
        except (TypeError, ValueError):
            return False
    if observed[: len(expected)] == expected:
        return True
    # Termux launchers exec through the glibc loader, so /proc/PID/cmdline no
    # longer matches the wrapper command recorded at Popen time.  Accept only
    # the two pinned post-exec identities owned by this package.  Legacy v1
    # records have no start tick; all other identity fields and the process
    # group check in stop_managed must still match before a signal is sent.
    if kind == "proxy":
        return (
            expected == [site.node_executable, str(PROXY_CLI)]
            and len(observed) >= 2
            and observed[-1] == str(PROXY_CLI)
            and Path(observed[-2]).name in {"node", "node.real"}
        )
    if kind == "gateway":
        return (
            expected
            == [
                site.openclaw_executable,
                "gateway",
                "--bind",
                "loopback",
                "--port",
                "18789",
                "--verbose",
            ]
            and observed[-1].rstrip() == "openclaw"
        )
    return False


def stop_managed(site: Site, kind: str) -> list[dict[str, Any]]:
    if kind not in {"gateway", "proxy"}:
        raise ContractError("service kind must be gateway or proxy")
    stopped: list[dict[str, Any]] = []
    for record_path in sorted(site.state_root.glob(f"managed-{kind}-*.json")):
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            pid = int(record["pid"])
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
        observed = _cmdline(pid)
        if not observed:
            stopped.append({"pid": pid, "state": "already-exited", "record": str(record_path)})
            continue
        try:
            process_group = os.getpgid(pid)
        except OSError:
            process_group = None
        if process_group != pid or not _matches_managed_identity(
            site, kind, record, observed, _proc_start_ticks(pid)
        ):
            raise ContractError(
                f"PID {pid} identity differs from managed {kind} record; refusing to signal"
            )
        os.killpg(pid, signal.SIGTERM)
        for _ in range(50):
            if not _cmdline(pid):
                break
            time.sleep(0.1)
        if _cmdline(pid):
            raise ContractError(f"managed {kind} PID {pid} did not stop after SIGTERM")
        stopped.append({"pid": pid, "state": "stopped", "record": str(record_path)})
    return stopped
