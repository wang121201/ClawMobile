from __future__ import annotations

import os
import re
import shutil
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .common import ContractError, expand_path, http_json, load_json, run_checked, utc_now


LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


@dataclass(frozen=True)
class Site:
    source: Path
    site_id: str
    adb_executable: str
    adb_serial: str
    adb_server_socket: str
    python_executable: str
    node_executable: str
    openclaw_executable: str
    channel_url: str
    gateway_url: str
    proxy_url: str
    openclaw_config: Path
    output_root: Path
    capture_root: Path
    state_root: Path
    service_start_seconds: int
    capture_flush_seconds: int
    physical_request_milliseconds: int
    adb_command_seconds: int


def _command(raw: str) -> str:
    value = os.path.expandvars(os.path.expanduser(raw))
    if "/" in value:
        path = Path(value).resolve()
        if not path.is_file():
            raise ContractError(f"executable does not exist: {path}")
        if not os.access(path, os.X_OK):
            raise ContractError(f"executable is not runnable: {path}")
        return str(path)
    resolved = shutil.which(value)
    if resolved is None:
        raise ContractError(f"executable is not on PATH: {value}")
    return resolved


def _loopback_url(raw: str, expected_port: int, label: str) -> str:
    parsed = urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS:
        raise ContractError(f"{label} must be an HTTP loopback URL")
    if parsed.port != expected_port or parsed.path not in {"", "/"}:
        raise ContractError(f"{label} must use loopback port {expected_port} with no path")
    return raw.rstrip("/")


def load_site(path: Path, *, check_executables: bool = True) -> Site:
    source = path.resolve()
    value = load_json(source)
    if value.get("schema_version") != 1:
        raise ContractError("phone site schema_version must be 1")
    if value.get("platform") != "termux-android-phone-native-v1":
        raise ContractError("phone site platform must be termux-android-phone-native-v1")
    forbidden = {"ssh_host", "ssh_user", "ssh_port", "windows", "forwarded_ports"}
    serialized_keys: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            serialized_keys.update(str(key) for key in item)
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    overlap = sorted(forbidden & serialized_keys)
    if overlap:
        raise ContractError(f"phone-native site contains host-only keys: {', '.join(overlap)}")

    try:
        adb = value["adb"]
        executables = value["executables"]
        endpoints = value["endpoints"]
        paths = value["paths"]
        timeouts = value["timeouts"]
    except KeyError as exc:
        raise ContractError(f"phone site is missing section {exc.args[0]}") from exc

    serial = str(adb.get("serial", ""))
    if not re.fullmatch(r"127\.0\.0\.1:\d{2,5}", serial):
        raise ContractError("phone-native ADB serial must be a loopback TCP serial")
    server_socket = str(adb.get("server_socket", ""))
    if server_socket and not re.fullmatch(r"tcp:127\.0\.0\.1:\d{2,5}", server_socket):
        raise ContractError("ADB server_socket must be empty or tcp:127.0.0.1:<port>")

    site = Site(
        source=source,
        site_id=str(value.get("site_id", "")),
        adb_executable=_command(str(adb["executable"])) if check_executables else str(adb["executable"]),
        adb_serial=serial,
        adb_server_socket=server_socket,
        python_executable=_command(str(executables["python"])) if check_executables else str(executables["python"]),
        node_executable=_command(str(executables["node"])) if check_executables else str(executables["node"]),
        openclaw_executable=_command(str(executables["openclaw"])) if check_executables else str(executables["openclaw"]),
        channel_url=_loopback_url(str(endpoints["channel"]), 8765, "Channel"),
        gateway_url=_loopback_url(str(endpoints["gateway"]), 18789, "Gateway"),
        proxy_url=_loopback_url(str(endpoints["proxy"]), 18081, "Proxy"),
        openclaw_config=expand_path(str(paths["openclaw_config"]), base=source.parent),
        output_root=expand_path(str(paths["output_root"]), base=source.parent),
        capture_root=expand_path(str(paths["capture_root"]), base=source.parent),
        state_root=expand_path(str(paths["state_root"]), base=source.parent),
        service_start_seconds=int(timeouts["service_start_seconds"]),
        capture_flush_seconds=int(timeouts["capture_flush_seconds"]),
        physical_request_milliseconds=int(timeouts["physical_request_milliseconds"]),
        adb_command_seconds=int(timeouts["adb_command_seconds"]),
    )
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,64}", site.site_id):
        raise ContractError("site_id must contain 3-64 safe characters")
    home = Path.home().resolve()
    for label, candidate in (
        ("output_root", site.output_root),
        ("capture_root", site.capture_root),
        ("state_root", site.state_root),
    ):
        try:
            candidate.relative_to(home)
        except ValueError as exc:
            raise ContractError(f"{label} must be under the Termux home: {candidate}") from exc
    if site.openclaw_config.name != "openclaw.json":
        raise ContractError("openclaw_config must name openclaw.json")
    if site.physical_request_milliseconds < 1000:
        raise ContractError("physical request timeout is unrealistically small")
    return site


def _adb_env(site: Site) -> dict[str, str]:
    env = os.environ.copy()
    if site.adb_server_socket:
        env["ADB_SERVER_SOCKET"] = site.adb_server_socket
    else:
        env.pop("ADB_SERVER_SOCKET", None)
    return env


def adb_state(site: Site) -> dict[str, Any]:
    env = _adb_env(site)
    state = run_checked(
        [site.adb_executable, "-s", site.adb_serial, "get-state"],
        env=env,
        timeout=site.adb_command_seconds,
    ).stdout.strip()
    if state != "device":
        raise ContractError(f"ADB serial is not in device state: {site.adb_serial}: {state}")
    boot_id = run_checked(
        [
            site.adb_executable,
            "-s",
            site.adb_serial,
            "shell",
            "cat",
            "/proc/sys/kernel/random/boot_id",
        ],
        env=env,
        timeout=site.adb_command_seconds,
    ).stdout.strip()
    if not re.fullmatch(r"[0-9a-f-]{36}", boot_id):
        raise ContractError(f"invalid Android boot ID: {boot_id!r}")
    return {"state": state, "serial": site.adb_serial, "boot_id": boot_id}


def _exact_process_ids(name: str) -> list[int]:
    result = run_checked(["pgrep", "-x", name], timeout=5) if shutil.which("pgrep") else None
    if result is None:
        raise ContractError("pgrep is required for exact Termux worker cleanup")
    return [int(line) for line in result.stdout.splitlines() if line.strip().isdigit()]


def clear_stale_termux_api_workers() -> dict[str, Any]:
    # pgrep exits 1 when there are no matches, so query without run_checked.
    query = subprocess_run(["pgrep", "-x", "termux-api"])
    pids = [int(line) for line in query.stdout.splitlines() if line.strip().isdigit()]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if pids:
        for _ in range(20):
            remaining = subprocess_run(["pgrep", "-x", "termux-api"])
            if not remaining.stdout.strip():
                break
            time.sleep(0.1)
    remaining = subprocess_run(["pgrep", "-x", "termux-api"])
    remaining_ids = [
        int(line) for line in remaining.stdout.splitlines() if line.strip().isdigit()
    ]
    if remaining_ids:
        raise ContractError(f"stale termux-api workers remain: {remaining_ids}")
    return {
        "checked_at": utc_now(),
        "exact_process_name": "termux-api",
        "reclaimed_count": len(pids),
        "remaining_count": 0,
    }


def subprocess_run(arguments: list[str]):
    import subprocess

    try:
        return subprocess.run(
            arguments,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )
    except OSError as exc:
        raise ContractError(f"cannot run {arguments[0]}: {exc}") from exc


def router_client_token(site: Site) -> str:
    config = load_json(site.openclaw_config)
    try:
        token = config["models"]["providers"]["clawmobile-router"]["apiKey"]
    except (KeyError, TypeError) as exc:
        raise ContractError("OpenClaw config lacks clawmobile-router.apiKey") from exc
    if not isinstance(token, str) or len(token.encode("utf-8")) < 32:
        raise ContractError("Router client token is absent or shorter than 32 bytes")
    return token


def assert_environment(site: Site, *, expected_boot_id: str | None = None) -> dict[str, Any]:
    cleanup = clear_stale_termux_api_workers()
    adb = adb_state(site)
    if expected_boot_id is not None and adb["boot_id"] != expected_boot_id:
        raise ContractError(
            f"Android boot ID changed: expected {expected_boot_id}, observed {adb['boot_id']}"
        )
    channel = http_json("GET", f"{site.channel_url}/health")
    if channel.get("ok") is not True:
        raise ContractError("ClawBench Channel health does not report ok=true")
    gateway = http_json("GET", f"{site.gateway_url}/healthz")
    proxy = http_json("GET", f"{site.proxy_url}/health")
    if proxy.get("status") != "ok" or proxy.get("v4_enabled") is not True:
        raise ContractError("shared Proxy is not healthy in v4 mode")
    concurrency = proxy.get("provider_concurrency", {}).get("freeinference-global", {})
    if concurrency.get("configured") != 1:
        raise ContractError("FreeInference concurrency is not fixed at one")
    advertised_root = proxy.get("capture_root")
    if advertised_root is not None and Path(advertised_root).resolve() != site.capture_root:
        raise ContractError(
            f"Proxy capture root differs from site: {advertised_root} != {site.capture_root}"
        )
    return {
        "checked_at": utc_now(),
        "platform": "termux-android-phone-native-v1",
        "site_id": site.site_id,
        "adb": adb,
        "channel": channel,
        "gateway": gateway,
        "proxy": proxy,
        "termux_api_cleanup": cleanup,
    }
