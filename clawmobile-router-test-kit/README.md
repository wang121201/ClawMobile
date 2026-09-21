# ClawMobile Router Test Kit

This directory is the standalone source package for the ClawMobile Router experiments. The canonical controller now runs entirely inside Android Termux: the phone owns planning, ClawBench execution, local service health, evidence sealing and Smoke/Formal gates. Windows/Codex is optional for read-only observation or copy-only archival. The package intentionally contains no experiment outputs, raw requests/responses, credentials, phone state, or historical campaign evidence.

Start with [`PROJECT_GUIDE_AND_RESULTS.md`](PROJECT_GUIDE_AND_RESULTS.md) for the self-contained project description, current recommended Router configuration, reproducible phone-native commands, existing Expanded15 results, and interpretation boundaries. Future review comments are consolidated into that living document. Use `PHONE_NATIVE_RUNBOOK.md` for detailed installation/recovery and `VERIFICATION.md` for dated evidence.

## Terms and boundaries

- **Cell（实验单元）**: one complete `task × case × repetition` run, including setup, model interaction, deterministic verification, teardown, and evidence flush.
- **Run ID（运行标识）**: the fresh 32-character lowercase hexadecimal `result.run_id` generated for one Cell. It is the authoritative session identity.
- **Proxy（代理）**: the shared OpenAI-compatible observation and routing service in `clawmobile-router-proxy/`.
- **Router（路由器）**: the decision component that selects the Cloud Agent or Logical-local Agent for one logical request.
- **FSM (Finite-State Machine, 有限状态机)**: deterministic per-Cell route state derived from current request history.
- **Scoped Context（作用域上下文）**: the reduced tool/context view supplied to the selected Agent.
- **Repair（修复）**: a bounded deterministic correction of an otherwise invalid Local Tool Call, followed by full revalidation.
- **Scored failure（计分失败）**: model execution completed but the deterministic verifier returned `FAILURE`; it remains valid model evidence.
- **Infrastructure failure（基础设施失败）**: SSH, ADB, service, capture, timeout, or lifecycle failure; the controller preserves evidence and stops the current invocation.

The Qwen3.6 Local Agent in these configurations is a **logical-local role** served by FreeInference. It is not a physical XMU-local model.

## Canonical phone-native execution path

```text
phone/run.sh
  -> phone_controller/campaign.py
    -> local self-ADB + Channel/Gateway/Proxy health
    -> clawbench-runtime/scripts/run_task_set.py
      -> ClawBench Channel -> OpenClaw Gateway
        -> clawmobile-router-proxy/src/cli.js
          -> Router helper -> Cloud or Logical-local Agent
      -> deterministic task verifier + teardown
    -> same-phone copy-only capture + SHA-256 + Cell status/gate
```

The shared Proxy is reused across Router conditions. The experimental configuration selects the strategy and model roles; separate Proxy implementations are not created per condition.

## Directory map

| Path | Responsibility |
|---|---|
| `phone/run.sh` | Canonical phone-native entry point: configure, services, doctor, plan, Smoke and Formal. |
| `phone_controller/` | Python standard-library controller, site validation, local services, exact plans, evidence, gates and fail-fast lifecycle. |
| `phone/phone-site.example.json` | Replaceable phone topology; copied to an ignored private `phone-site.json`. |
| `PHONE_NATIVE_RUNBOOK.md` | End-to-end replacement-phone installation and execution procedure. |
| `PROJECT_GUIDE_AND_RESULTS.md` | Canonical living project overview, reproduction guide, current results, and interpretation boundaries. |
| `clawbench-channel/` | MIT-licensed OpenClaw ClawBench Channel adapted from the pinned upstream commit recorded in `THIRD_PARTY_NOTICES.md`; `node_modules` is excluded. |
| `Run-RouterCampaign.ps1` | Legacy host-reference entry point; no longer canonical and not required by phone execution. |
| `five-group-v4/run_campaign.ps1` | Original production Smoke/Formal controller, serialized Cell scheduling, Smoke gate, fail-fast infrastructure policy. |
| `five-group-v4/ExperimentCore.psm1` | Config contracts, plan generation, per-Cell session registration, ClawBench invocation, result classification. |
| `five-group-v4/PhoneEnvironment.psm1` | Live Phone A, ADB, Channel, Gateway, Proxy, provider, and boot-identity checks. |
| `five-group-v4/Evidence.psm1` | No-overwrite writes, Proxy flush, raw capture copy, SHA-256 and structural validation. |
| `five-group-v4/start_gateway_phone_a.sh` | Exact Phone A Gateway startup helper. |
| `five-group-v4/start_proxy_phone_a.sh` | Exact shared Proxy startup helper. |
| `clawmobile-router-proxy/src/` | Proxy, Router policies, scoped context, FSM state, upstream calls, logging, and capture. |
| `clawmobile-router-proxy/test/` | Node unit and integration-shape tests for routing, capture, sessions, and provider concurrency. |
| `clawbench-runtime/core/` | Benchmark runner, device interface, session trigger/poll, results, and registry. |
| `clawbench-runtime/tasks/` | Deterministic setup/check/teardown implementations for L1-L5 tasks. |
| `clawbench-runtime/scripts/run_task_set.py` | Batch entry point used by the PowerShell controller. |
| `router-*.json` | Frozen Router designs, task/case mappings, model roles, and output/capture contracts. |
| `test_router_release.ps1` | Minimal offline release test: PowerShell parse, all config/plan contracts, Python AST, Proxy tests. |
| `RELEASE-MANIFEST.json`, `SHA256SUMS.txt` | Package inventory and content hashes; regenerate with `tools/New-ReleaseManifest.ps1`. |
| `VERIFICATION.md` | Dated offline checks, Phone 62 live phone-native Smoke proof, and security-scan boundary. |

OpenClaw remains an external runtime dependency. The exact live ClawBench Channel source is vendored copy-only; `node_modules` remains external. See `DEPENDENCIES.md`.

## Frozen Router configurations

The package includes 13 configurations covering:

- R1 evidence-only and R2 grounded-query routing;
- RouteClass moderate routing on Matched5 and Expanded15;
- paired RouteClass versus FSM + Scoped Context studies;
- FSM + Scoped Context + Repair with DSV4 or Qwen Router;
- Binary Tool and Explicit Binary Tool policies;
- route-flex tiny preliminary study;
- capability-suppression study and Full DSV4 comparator;
- binary efficiency tiny study.

The JSON files are research artifacts tied to the frozen Phone A topology and output roots. Preserve them byte-for-byte when reproducing an existing comparison. Create a separately named config and campaign identity when adapting to another device or provider.

## Offline validation

Requirements:

- PowerShell 7 or later;
- Node.js 22 or later (`npm` is optional because the test script can call `node --test` directly);
- Python 3.11 or later; the included ClawBench runtime uses the Python standard library;
- no phone, model request, or network connection is used by this offline command.

```powershell
Set-Location <repo-root>
./test_router_release.ps1 -PythonPath (Get-Command python.exe).Source
```

For a quick config/plan check without Node tests:

```powershell
./test_router_release.ps1 -PythonPath (Get-Command python.exe).Source -SkipNodeTests
```

Validate one frozen plan without touching a phone:

```powershell
./Run-RouterCampaign.ps1 `
  -Stage Formal `
  -ConfigFile router-fsm-scoped-repair-expanded15-experiment-v1.json `
  -GroupId G4-FSM-SC-Repair `
  -ValidateOnly
```

Multi-condition designs reject `-GroupId` and execute their frozen within-study order.

## Live execution

Live execution is intentionally explicit. Before Smoke, the phone must pass self-ADB, ClawBench Channel, Gateway, shared Proxy, run-registration, and provider checks. SSH is not in the execution path. The API key is injected through `phone/phone.env` or another private exported environment and is never stored in this repository.

Example phone-native Smoke:

```bash
./phone/run.sh run \
  --stage Smoke \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id '<new-smoke-id>'
```

Example Formal after a healthy Smoke gate:

```bash
./phone/run.sh run \
  --stage Formal \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id '<new-formal-id>' \
  --smoke-gate "$HOME/clawmobile-experiments/router-campaigns/<new-smoke-id>/smoke-gate.json"
```

Every live run must use a new output root. The source controller refuses overwrite, requires the matching Smoke gate for Formal, and stops on the first infrastructure failure while continuing scored model failures.

## Secrets, evidence, and publication

- Keep `freeinference_api` and all other credentials outside Git. `.env.example` contains only a placeholder.
- Do not commit `.bashrc`, OpenClaw private config, phone captures, raw SSE, result JSONL, logs, or `D:\codexdataspace` outputs.
- `clawmobile-router-proxy/parameter-schema-corpus-manifest.json` is ignored because it names a private local corpus root. Regenerate an aggregate manifest against a publishable corpus if needed.
- The two test strings that resemble authorization/session values are synthetic redaction tests, not credentials.
- `RELEASE-MANIFEST.json` excludes ignored Python bytecode and its own generated outputs.
- ClawMobile-owned code follows the repository's root MIT License. The adapted OpenClaw Channel retains its upstream MIT notice in `clawbench-channel/LICENSE`; exact source and adaptations are recorded in `THIRD_PARTY_NOTICES.md`.
- Review the frozen private-network IPs and absolute experiment roots before making a public repository. They are provenance/configuration values, not credentials, but they are environment-specific.

## Source fidelity

The production controller modules, startup scripts, Proxy source/tests, ClawBench core/tasks, and frozen JSON configs are copy-only exports from the active workspace. The root launcher, release test, documentation, ignore rules, and manifest generator are packaging additions. See `SOURCE_MAP.md` for the exact source locations.
