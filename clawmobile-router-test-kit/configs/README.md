# Frozen experiment configurations

Each JSON file in this directory is an immutable schema-v4 experiment contract. It fixes the model roles, task/case/repetition plan, Smoke and Formal sizes, concurrency, evidence rules, and infrastructure-failure policy for one study.

The files remain separate because each has its own design ID, SHA-256 identity, and historical evidence binding. Their approved hashes and expected Cell counts are recorded in [`phone/frozen-configs.json`](../phone/frozen-configs.json).

## Core Expanded15 comparison

| Configuration | Result rows |
|---|---|
| `unified-five-group-experiment-v4.json` | G1, G2, G3, and G5 Full/Filter baselines |
| `router-rm-expanded15-experiment-v1.json` | G4-RM |
| `router-r2-fsm-expanded15-paired-experiment-v1.json` | G4-RM-SC and G4-FSM-SC paired study |
| `router-fsm-scoped-repair-expanded15-experiment-v1.json` | G4-FSM-SC-Repair |

## Additional supported studies

| Configuration | Purpose |
|---|---|
| `router-r1-r2-matched5-experiment-v1.json` | R1/R2 Matched5 comparison |
| `router-rm-matched5-experiment-v1.json` | RouteClass Moderate Matched5 |
| `router-r2-fsm-paired-experiment-v1.json` | Smaller paired Scoped/FSM study |
| `router-fsm-scoped-repair-qwen-router-expanded15-experiment-v1.json` | Qwen Router substitution |
| `router-binary-tool-expanded15-experiment-v1.json` | Binary Tool Router |
| `router-explicit-binary-tool-expanded15-experiment-v1.json` | Deterministic Explicit Binary Tool policy |
| `router-route-flex-tiny-preliminary-v1.json` | Route-flex preliminary Smoke study |
| `router-capability-suppression-experiment-v1.json` | Capability-suppression comparison |
| `router-capability-suppression-full-dsv4-comparator-v1.json` | Full-DSV4 comparator for capability suppression |
| `router-binary-efficiency-tiny-experiment-v1.json` | Binary-efficiency tiny study |

## Usage

Pass the repository-relative path to the phone-native controller:

```bash
./phone/run.sh run \
  --stage Formal \
  --config configs/router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --validate-only
```

Do not combine or edit frozen files in place. Create a newly named configuration, design ID, allowlist entry, and campaign identity for a changed experiment.
