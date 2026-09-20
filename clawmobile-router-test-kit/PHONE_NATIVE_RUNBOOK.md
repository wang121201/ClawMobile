# Phone-native ClawMobile Router runbook

This runbook defines the standalone execution path. The **Android phone is the controller and evidence authority**. Windows, Codex, SSH, SCP, and port forwarding are optional observation or copy-only archival tools; none participates in a Cell execution.

## Runtime topology

```text
Termux Python controller
  -> ClawBench runtime
  -> ClawBench Channel        http://127.0.0.1:8765
  -> OpenClaw Gateway         http://127.0.0.1:18789
  -> shared Router Proxy      http://127.0.0.1:18081
  -> FreeInference DSV4/Qwen3.6
  -> Android tools over self-ADB
  -> deterministic verifier
  -> phone-local immutable Cell evidence
```

**Cell（实验单元）** means one complete `task × case × repetition`, including setup, every model request, deterministic verification, teardown, durable Proxy flush and evidence verification. Each Cell receives a fresh 32-hex `result.run_id`; role-specific upstream sessions are distinct and no session is reused across Cells.

## One-time phone preparation

Use an official, current Termux build and a matching Termux:API application. Install:

```bash
pkg update
pkg upgrade
pkg install bash curl git python android-tools termux-api procps util-linux coreutils
```

Install the OpenClaw Android runtime separately. This release expects:

- `openclaw` on `PATH`;
- Node at `$HOME/.openclaw-android/bin/node`;
- OpenClaw version `>=2026.5.7`;
- a JSON configuration at `$HOME/.openclaw/openclaw.json`.

Clone or copy this repository onto the phone. If ClawMobile itself is not yet installed, first run the repository's supported Termux/OpenClaw setup from `~/ClawMobile`, then enter the Router test kit:

```bash
git clone https://github.com/wang121201/ClawMobile.git "$HOME/ClawMobile"
cd "$HOME/ClawMobile"
./installer/termux-lite/clawmobile setup --quick

cd "$HOME/ClawMobile/clawmobile-router-test-kit"
chmod +x phone/*.sh
./phone/install.sh
```

On a replacement phone, also reproduce the selected panel's application and verifier prerequisites before live Smoke: Maps, YouTube, Amazon, Contacts, Calendar, shared-storage access, account/login state, permissions, locale, and compatible app versions. Repository installation alone does not establish UI equivalence across physical phones.

The installer creates two ignored private files if absent:

- `phone/phone-site.json`: replaceable device/runtime topology;
- `phone/phone.env`: Provider secret environment.

Set a stable `site_id` and export the FreeInference credential in `phone/phone.env`:

```bash
export freeinference_api='...'
```

The credential is never written to an experiment configuration, result or release manifest.

## Self-ADB

Enable Android Developer Options and Wireless Debugging. Pair and connect from the same phone's Termux. Pairing and debugging ports are different and may change after reboot:

```bash
adb pair 127.0.0.1:<pairing-port>
adb connect 127.0.0.1:<debug-port>
adb devices -l
```

The included helper performs those checks and atomically updates the ignored site file:

```bash
./phone/setup-self-adb.sh <pairing-port> <six-digit-code> <debug-port>
```

Set the exact connected loopback serial in `phone/phone-site.json`, for example `127.0.0.1:40853`. Do not assume port 5555 on a replacement phone. The same serial is used by ClawBench, Gateway Android tools and deterministic verifiers.

## Configure OpenClaw and Channel

After sourcing the private Provider environment, run:

```bash
./phone/run.sh configure
```

The command first creates a copy-only, SHA-256-verified backup under the phone state root. It then atomically configures:

- the FreeInference DSV4 and Qwen3.6 models;
- the loopback shared Proxy provider and independent Router client token;
- OpenClaw primary model `clawmobile-router/experiment`;
- the vendored ClawBench Channel plugin on loopback port 8765.

No secret value is printed in the configuration receipt.

## Start and verify local services

```bash
./phone/run.sh services start
./phone/run.sh doctor
```

`services start` reuses a healthy Gateway/Channel. It reuses a healthy Proxy only when the Proxy advertises the exact configured capture root. Otherwise it fails closed instead of stopping an unrelated process. A service started by this controller is recorded with PID and command identity and can be stopped explicitly:

```bash
./phone/run.sh services stop-proxy
./phone/run.sh services stop-gateway
```

The controller signals only a PID whose `/proc/<pid>/cmdline` still matches its own managed-service record.

## Validate a plan without model requests

The frozen research JSON remains byte-identical; the private site file supplies the replacement phone identity and local paths.

```bash
./phone/run.sh run \
  --stage Smoke \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --validate-only
```

The phone-native Python plans are tested for exact row-by-row equality against the original production PowerShell plans for all 13 configs.

## Live Smoke and Formal

Always use a new campaign ID and output root. The default output is `<site.output_root>/<group-run-id>`.

```bash
./phone/run.sh run \
  --stage Smoke \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id repair-smoke-$(date -u +%Y%m%dT%H%M%SZ)
```

Only after `smoke-gate.json` reports `passed: true`:

```bash
./phone/run.sh run \
  --stage Formal \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id repair-formal-$(date -u +%Y%m%dT%H%M%SZ) \
  --smoke-gate "$HOME/clawmobile-experiments/router-campaigns/<smoke-id>/smoke-gate.json"
```

Scored model `FAILURE` is preserved and the next Cell runs. The first infrastructure failure is preserved and stops the invocation; the controller does not manufacture statuses for unrun schedules and never overwrites prior evidence.

## Phone-local evidence

The Proxy writes its authoritative append-only capture partition under:

```text
<capture_root>/<result.run_id>/model-calls.jsonl
<capture_root>/<result.run_id>/proxy-events.jsonl
```

After durable flush, the controller performs a same-phone, copy-only transfer into the Cell directory. It rejects symlinks, requires both paths to remain below the configured capture root, uses exclusive creation, flushes the destination and compares bytes plus SHA-256.

Each Cell preserves:

```text
cell-claim.json
cell-plan.json
execution-plan.*.json
runner.stdout.log
runner.stderr.log
json/<result>.json
model-calls.jsonl
proxy-events.jsonl
cell-status.json
```

## Moving to another phone

Copy or clone the same repository revision, then repeat preparation, self-ADB, site configuration, OpenClaw configuration, doctor and Smoke. Do not copy `phone/phone.env`, `phone/phone-site.json`, live OpenClaw credentials or Android account data between phones without an explicit security decision. A replacement phone creates a new `site_id`; frozen research configs do not change.

Cross-phone equivalence still requires recording Android version, app versions, locale, permissions, account/login state and initial task fixtures. The repository makes the controller and protocol portable; it cannot make two physical phone UIs pixel-identical.
