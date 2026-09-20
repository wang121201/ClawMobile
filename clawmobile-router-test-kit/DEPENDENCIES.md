# External runtime dependencies

The repository contains the complete Router-specific code and benchmark controller owned by this workspace. A live Android experiment also depends on the following separately installed components.

## OpenClaw Gateway

The Gateway receives the ClawBench run and calls the shared Proxy through the OpenAI-compatible `clawmobile-router/experiment` model alias. The provider/model patch is included at:

```text
clawmobile-router-proxy/deploy/openclaw-router.patch.json5
```

Do not commit the live `~/.openclaw/openclaw.json`: it contains machine-local provider configuration and credential references. The API key is supplied through the private `freeinference_api` environment variable.

## ClawBench Channel

The Channel exposes the HTTP run interface used by `clawbench-runtime`:

- `GET /health`
- `POST /runs`
- `GET /runs/<result.run_id>`

The current Phone A Channel source is included under `clawbench-channel/`. It derives from OpenClaw commit `10b4342c09de5b7fb22b07a0d7c6ebe797c52001`, path `extensions/clawbench/`, with narrow external-plugin compatibility adaptations recorded in `THIRD_PARTY_NOTICES.md`. The live deployment was exported copy-only, excluding `node_modules` and symlinks, and its remote/local inventory was verified as 68 files, 146,419 bytes and zero SHA-256 mismatches. It declares `@openclaw/clawbench-channel` version `2026.5.7` and peer dependency OpenClaw `>=2026.5.7`.

The Channel package uses workspace development dependencies, so a replacement phone must provide its compatible OpenClaw runtime; this repository does not vendor OpenClaw or `node_modules`. The upstream Channel is MIT-licensed; its original notice is preserved in `clawbench-channel/LICENSE`.

## Android phone tools

- Android Debug Bridge (ADB) connected locally from Termux to the phone's Wireless Debugging endpoint;
- Python 3.11+ for ClawBench and the phone-native controller;
- Node.js 22+ for the shared Proxy;
- Bash, curl, procps, util-linux, coreutils and Termux:API;
- required Android applications and verifier permissions for the selected task panel.

The frozen configs retain their original Phone A and Windows values solely as byte-identical research provenance. The phone-native controller never uses those deployment fields; it reads the ignored private `phone/phone-site.json`. No SSH, SCP, Windows PowerShell, D: drive, or port forward is required for execution.
