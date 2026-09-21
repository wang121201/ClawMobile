# ClawMobile Router Test Kit

This directory adds reproducible Filter and Router experiments to ClawMobile. The complete experiment controller runs on the Android phone: it starts local services, executes ClawBench Cells, verifies Android state, and seals evidence.

## Start here

| Goal | Document |
|---|---|
| Understand the experiment and results | [`PROJECT_GUIDE_AND_RESULTS.md`](PROJECT_GUIDE_AND_RESULTS.md) |
| Choose a frozen experiment configuration | [`configs/README.md`](configs/README.md) |
| Install, run, or recover an experiment | [`PHONE_NATIVE_RUNBOOK.md`](PHONE_NATIVE_RUNBOOK.md) |
| Understand Router, RouteClass, Scoped Context, finite-state control, and Repair | [`clawmobile-router-proxy/README.md`](clawmobile-router-proxy/README.md) |
| Review tests and live validation | [`VERIFICATION.md`](VERIFICATION.md) |
| Review dependencies, source provenance, and licenses | [`DEPENDENCIES.md`](DEPENDENCIES.md), [`SOURCE_MAP.md`](SOURCE_MAP.md), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |

## System at a glance

```text
phone/run.sh
  -> phone_controller
  -> ClawBench Channel -> OpenClaw Gateway -> shared Proxy
  -> Filter or Router policy -> selected Agent -> Android Tools
  -> deterministic verifier -> evidence seal
```

One shared Proxy supports every configuration. Full-Agent arms are transparent pass-through paths. Filter and Router components are enabled only by the registered experiment arm.

The recommended mechanism-rich configuration is:

```text
configs/router-fsm-scoped-repair-expanded15-experiment-v1.json
G4-FSM-SC-Repair
```

It uses DeepSeek-V4-Flash as Router and Cloud Agent, Qwen3.6-35B as the Logical-local Agent, finite-state-machine (FSM) constraints, Scoped Context, and bounded deterministic Repair. “Logical-local” is an experimental role; both models are served by FreeInference in this configuration.

## Quick start on a phone

From the ClawMobile repository root:

```bash
cd clawmobile-router-test-kit
chmod +x phone/*.sh
./phone/install.sh
cp phone/phone-site.example.json phone/phone-site.json
./phone/run.sh doctor
./phone/run.sh test
```

Validate the recommended plan without sending model requests:

```bash
./phone/run.sh run \
  --stage Formal \
  --config configs/router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --validate-only
```

Run a fresh Smoke, then use its healthy gate for Formal:

```bash
./phone/run.sh run \
  --stage Smoke \
  --config configs/router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id '<new-smoke-id>'

./phone/run.sh run \
  --stage Formal \
  --config configs/router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id '<new-formal-id>' \
  --smoke-gate "$HOME/clawmobile-experiments/router-campaigns/<new-smoke-id>/smoke-gate.json"
```

Use a new run ID and output root for every live campaign. Credentials belong in the ignored `phone/phone.env`, never in Git.

## Core Expanded15 result

Expanded15 contains 15 tasks across ClawBench Levels L1–L5. Each configuration runs four independent repetitions, for 60 scored Cells. A **Cell** is one complete task/case/repetition execution, including setup, a fresh session, model and Tool work, deterministic verification, teardown, and evidence flush.

| Group | Configuration | SUCCESS | Logical requests | Physical requests |
|---|---|---:|---:|---:|
| G1 | Full DSV4 | 45/60, 75.0% | 703 | 703 |
| G2 | DSV4 Filter + DSV4 Agent | 45/60, 75.0% | 579 | 1,158 |
| G3 | Qwen Filter + DSV4 Agent | 48/60, 80.0% | 653 | 1,306 |
| G4-RM | Moderate RouteClass Router | 45/60, 75.0% | 902 | 2,030 |
| G4-RM-SC | RouteClass Router + Scoped Context | 43/60, 71.7% | 1,049 | 2,322 |
| G4-FSM-SC | FSM Router + Scoped Context | 48/60, 80.0% | 963 | 2,134 |
| G4-FSM-SC-Rep | FSM Router + Scoped Context + Repair | 45/60, 75.0% | 1,017 | 2,147 |
| G5 | Full Qwen Agent | 19/60, 31.7% | 1,513 | 1,513 |

These are complete-system measurements, not model-only rankings. See [`PROJECT_GUIDE_AND_RESULTS.md`](PROJECT_GUIDE_AND_RESULTS.md) for interpretation and exact reproduction mapping.

## Code map

| Path | Role |
|---|---|
| `phone/run.sh` | Canonical command entry point. |
| `phone_controller/` | Planning, service lifecycle, evidence, and gates. |
| `clawmobile-router-proxy/` | Shared Proxy, Filter/Router strategies, FSM, Scoped Context, Repair, and capture. |
| `clawbench-runtime/` | Benchmark tasks, setup, verifier, teardown, and runner. |
| `clawbench-channel/` | ClawBench/OpenClaw transport adapter. |
| `configs/` | Frozen Full, Filter, and Router experiment definitions. |
| `tools/summarize_core_ablation.py` | Fail-closed result aggregation from sealed Cells. |

## Execution rules

- One controller, one active Cell, and one provider request in flight.
- Every Cell receives a fresh `result.run_id`; provider roles use separate sessions bound to it.
- Scored model failure is retained and execution continues.
- Infrastructure failure is retained, excluded from accuracy, and stops the current invocation.
- Raw requests, responses or Server-Sent Events (SSE), role identities, latency, and hashes are sealed before a Cell is final.
- Historical outputs and credentials are intentionally excluded from this source package.

ClawMobile-owned code uses the repository MIT License. The adapted ClawBench Channel retains its upstream notice; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
