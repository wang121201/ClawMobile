from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path
from typing import Any

from .common import (
    ContractError,
    run_checked,
    sha256_file,
    utc_stamp,
    write_bytes_exclusive,
    write_json_exclusive,
)
from .config_plan import PACKAGE_ROOT
from .environment import load_site


def _plugin_id(path: Path) -> str | None:
    root = path.expanduser().resolve()
    manifest = root / "openclaw.plugin.json"
    package = root / "package.json"
    for candidate in (manifest, package):
        try:
            value = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if candidate == manifest and isinstance(value.get("id"), str):
            return value["id"]
        if candidate == package:
            if value.get("name") == "@openclaw/clawbench-channel":
                return "clawbench"
            channel_id = value.get("openclaw", {}).get("channel", {}).get("id")
            if isinstance(channel_id, str):
                return channel_id
    return None


def _canonicalize_clawbench_paths(
    paths: list[Any], channel_root: Path
) -> tuple[list[str], list[str]]:
    canonical = str(channel_root.expanduser().resolve())
    kept = [canonical]
    removed: list[str] = []
    for raw in paths:
        if not isinstance(raw, str):
            raise ContractError("OpenClaw plugins.load.paths entries must be strings")
        resolved = str(Path(raw).expanduser().resolve())
        if resolved == canonical:
            continue
        if _plugin_id(Path(raw)) == "clawbench":
            if raw not in removed:
                removed.append(raw)
            continue
        if raw not in kept:
            kept.append(raw)
    return kept, removed


def _link_clawbench_plugin(openclaw_executable: str, channel_root: Path) -> None:
    """Reconcile OpenClaw's install registry with the canonical Channel path."""
    run_checked(
        [
            openclaw_executable,
            "plugins",
            "install",
            "--link",
            str(channel_root.expanduser().resolve()),
        ],
        timeout=60,
    )


def _models() -> list[dict[str, Any]]:
    return [
        {
            "id": "deepseek-v4-flash",
            "name": "DeepSeek V4 Flash",
            "contextWindow": 128000,
            "maxTokens": 4096,
        },
        {
            "id": "qwen3.6-35b",
            "name": "Qwen3.6 35B",
            "contextWindow": 262144,
            "maxTokens": 8192,
        },
    ]


def _router_models() -> list[dict[str, Any]]:
    return [
        {"id": model, "name": name, "contextWindow": 65536, "maxTokens": 4096}
        for model, name in (
            ("cloud-full", "ClawMobile Cloud Full"),
            ("local-full", "ClawMobile Local Full"),
            ("filter", "ClawMobile API Filter"),
            ("router", "ClawMobile Request Router"),
            ("experiment", "ClawMobile Fixed Experiment Arm"),
        )
    ]


def configure(site_path: Path) -> dict[str, Any]:
    site = load_site(site_path)
    config_path = site.openclaw_config
    try:
        original = config_path.read_bytes()
        config = json.loads(original.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot read existing OpenClaw config: {exc}") from exc
    if not isinstance(config, dict):
        raise ContractError("OpenClaw config root must be an object")
    original_hash = hashlib.sha256(original).hexdigest()
    backup_root = site.state_root / "config-backups"
    backup = backup_root / f"openclaw.{utc_stamp()}.{original_hash[:16]}.json"
    write_bytes_exclusive(backup, original)
    if sha256_file(backup) != original_hash:
        raise ContractError("copy-only OpenClaw backup hash mismatch")

    models = config.setdefault("models", {})
    providers = models.setdefault("providers", {})
    if not isinstance(providers, dict):
        raise ContractError("OpenClaw models.providers must be an object")
    existing_free = providers.get("custom-freeinference-org")
    free_key = (
        existing_free.get("apiKey")
        if isinstance(existing_free, dict) and isinstance(existing_free.get("apiKey"), str)
        else "${freeinference_api}"
    )
    if free_key == "${freeinference_api}" and not os.environ.get("freeinference_api"):
        raise ContractError(
            "freeinference_api is not exported; source phone/phone.env or ~/.bashrc first"
        )
    providers["custom-freeinference-org"] = {
        "baseUrl": "https://freeinference.org/v1",
        "api": "openai-completions",
        "apiKey": free_key,
        "models": _models(),
    }
    existing_router = providers.get("clawmobile-router")
    router_token = (
        existing_router.get("apiKey")
        if isinstance(existing_router, dict)
        and isinstance(existing_router.get("apiKey"), str)
        and len(existing_router["apiKey"].encode("utf-8")) >= 32
        else secrets.token_urlsafe(48)
    )
    if router_token == free_key:
        raise ContractError("Router client token must differ from FreeInference credential")
    providers["clawmobile-router"] = {
        "baseUrl": "http://127.0.0.1:18081/v1",
        "api": "openai-completions",
        "apiKey": router_token,
        "models": _router_models(),
    }

    agents = config.setdefault("agents", {})
    defaults = agents.setdefault("defaults", {})
    old_model = defaults.get("model")
    model = dict(old_model) if isinstance(old_model, dict) else {}
    model["primary"] = "clawmobile-router/experiment"
    defaults["model"] = model
    aliases = defaults.setdefault("models", {})
    aliases.update(
        {
            "clawmobile-router/cloud-full": {"alias": "clawmobile-cloud-full"},
            "clawmobile-router/local-full": {"alias": "clawmobile-local-full"},
            "clawmobile-router/filter": {"alias": "clawmobile-filter"},
            "clawmobile-router/router": {"alias": "clawmobile-router"},
            "clawmobile-router/experiment": {"alias": "clawmobile-experiment"},
        }
    )

    channel_root = (PACKAGE_ROOT / "clawbench-channel").resolve()
    channel_path = str(channel_root)
    plugins = config.setdefault("plugins", {})
    load = plugins.setdefault("load", {})
    paths = load.setdefault("paths", [])
    if not isinstance(paths, list):
        raise ContractError("OpenClaw plugins.load.paths must be a list")
    canonical_paths, removed_channel_paths = _canonicalize_clawbench_paths(
        paths, channel_root
    )
    load["paths"] = canonical_paths
    entries = plugins.setdefault("entries", {})
    entries["clawbench"] = {"enabled": True}
    channels = config.setdefault("channels", {})
    channels["clawbench"] = {
        "enabled": True,
        "host": "127.0.0.1",
        "port": 8765,
        "allowFrom": ["*"],
        "defaultTo": "run:default",
    }

    rendered = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = config_path.with_name(
        f"{config_path.name}.phone-native-{utc_stamp()}-{secrets.token_hex(4)}.tmp"
    )
    write_bytes_exclusive(temporary, rendered, mode=config_path.stat().st_mode & 0o777)
    try:
        reread = json.loads(temporary.read_text(encoding="utf-8"))
        if reread["agents"]["defaults"]["model"]["primary"] != (
            "clawmobile-router/experiment"
        ):
            raise ContractError("temporary OpenClaw config failed primary-model verification")
        os.replace(temporary, config_path)
        directory_fd = os.open(config_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        # The exclusive temporary is intentionally retained when validation fails.
        raise

    # OpenClaw also keeps an install registry outside plugins.load.paths.  Use its
    # supported CLI so a replacement phone cannot silently keep loading a stale
    # ClawBench Channel from an older absolute path.
    _link_clawbench_plugin(site.openclaw_executable, channel_root)

    receipt = {
        "schema_version": 1,
        "record_type": "phone_native_openclaw_configuration",
        "site_id": site.site_id,
        "source_backup": str(backup),
        "source_sha256": original_hash,
        "configured_sha256": sha256_file(config_path),
        "primary_model": "clawmobile-router/experiment",
        "router_base_url": "http://127.0.0.1:18081/v1",
        "channel_path": channel_path,
        "channel_url": "http://127.0.0.1:8765",
        "freeinference_credential_present": True,
        "router_client_token_present": True,
        "router_client_token_utf8_bytes": len(router_token.encode("utf-8")),
        "removed_clawbench_plugin_paths": removed_channel_paths,
    }
    receipt_path = site.state_root / f"configure-openclaw.{utc_stamp()}.json"
    write_json_exclusive(receipt_path, receipt)
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(configure(Path(args.site)), ensure_ascii=False, indent=2))
        return 0
    except ContractError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
