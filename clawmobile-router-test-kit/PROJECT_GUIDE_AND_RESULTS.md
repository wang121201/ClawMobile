# ClawMobile Router Experiment and Results

Last updated: 2026-09-21

This document defines the core experiment, reports the frozen Expanded15 comparison, and states what the measurements support. Component internals, operational steps, and validation evidence live in their dedicated references:

- Router mechanisms: [`clawmobile-router-proxy/README.md`](clawmobile-router-proxy/README.md)
- Phone execution: [`PHONE_NATIVE_RUNBOOK.md`](PHONE_NATIVE_RUNBOOK.md)
- Validation record: [`VERIFICATION.md`](VERIFICATION.md)

## 1. Research question

ClawMobile is an Android Agent runtime built on OpenClaw. This project tests whether each Agent request can be assigned safely to:

- a **Cloud Agent**, currently FreeInference `deepseek-v4-flash`; or
- a **Logical-local Agent**, currently FreeInference `qwen3.6-35b`.

“Logical-local” names the routing role. It does not mean that Qwen3.6-35B runs on the phone or on XMU. The separate G6 study evaluates a physically local XMU model.

The primary outcomes are end-to-end task SUCCESS, model-request count, Local acceptance and rejection, latency, and failure type.

## 2. Experiment unit and benchmark

- **Task**: one ClawBench benchmark definition.
- **Case**: one frozen Task parameter assignment.
- **Repetition**: one independent execution of a Task Case.
- **Cell**: setup, one fresh session, Agent and Tool execution, deterministic verification, teardown, and durable evidence flush for one `Task × Case × Repetition`.
- **Expanded15**: three Tasks from each ClawBench Level L1–L5, each run for four Repetitions; one configuration therefore contains 60 Cells.
- **Logical Request**: one request presented to a Full Agent, Filter, or Router policy.
- **Physical Request**: one actual provider call. Filter and Router paths may make multiple Physical Requests for one Logical Request.
- **Scored FAILURE**: the model trajectory completed but the deterministic verifier rejected the final Android state. It remains valid model evidence.
- **Infrastructure failure**: a service, device, provider-transport, timeout, capture, or lifecycle fault. It is retained but excluded from the accuracy denominator.

The verifier, not the Agent’s completion statement, determines SUCCESS.

## 3. Components

| Component | Definition | Detailed reference |
|---|---|---|
| Filter | A helper that filters or rewrites context before one Cloud-Agent path; it does not select an Agent. | [Proxy strategies](clawmobile-router-proxy/README.md#virtual-models-and-strategies) |
| RouteClass Router | A helper that classifies the next immediate responsibility, then selects Cloud or Logical-local execution. | [Finite RouteClass protocol](clawmobile-router-proxy/README.md#finite-routeclass-protocol) |
| Scoped Context | A finite Local system contract and reduced Tool-schema set. Complete dynamic user, assistant, Tool-Call, and Tool-Result history is preserved. | [Scoped Context and FSM](clawmobile-router-proxy/README.md#scoped-context-and-fsm) |
| FSM | A deterministic finite-state-machine projection rebuilt from visible same-Cell Tool Calls and Tool Results. It admits Local actions only when their dependencies are fresh. | [Scoped Context and FSM](clawmobile-router-proxy/README.md#scoped-context-and-fsm) |
| Repair | A bounded deterministic correction of a near-valid Local Tool Call, followed by the complete validator again. It cannot change the intended Tool or semantic target. | [Standard Moderate Repair](clawmobile-router-proxy/README.md#standard-moderate-repair) |
| Shared Proxy | One OpenAI-compatible observation and routing layer reused by all arms. Full-Agent arms are transparent pass-through paths. | [Proxy control invariants](clawmobile-router-proxy/README.md#control-invariants) |
| ClawBench | The Task setup, execution, deterministic verifier, and teardown framework. | [Phone runbook](PHONE_NATIVE_RUNBOOK.md) |

The current reference configuration is `configs/router-fsm-scoped-repair-expanded15-experiment-v1.json`, group `G4-FSM-SC-Repair`. It uses one phone-native controller, one active Cell, and at most one FreeInference request in flight.

## 4. Core Expanded15 comparison

| Group | Configuration | SUCCESS | Logical Requests | Filter | Router | Local Agent | Server Agent | Physical Requests |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| G1 | Full DSV4 | **45/60, 75.0%** | **703** | 0 | 0 | 0 | 703 | 703 |
| G2 | DSV4 Filter + DSV4 Agent | 45/60, 75.0% | 579 | 579 | 0 | 0 | 579 | 1,158 |
| G3 | Qwen Filter + DSV4 Agent | **48/60, 80.0%** | 653 | 653 | 0 | 0 | 653 | 1,306 |
| G4-RM | Moderate RouteClass Router | 45/60, 75.0% | **902** | 0 | 902 | 460 | 668 | 2,030 |
| G4-RM-SC | RouteClass Router + Scoped Context | 43/60, 71.7% | 1,049 | 0 | 1,049 | 573 | 700 | 2,322 |
| G4-FSM-SC | FSM Router + Scoped Context | **48/60, 80.0%** | **963** | 0 | 963 | 564 | 607 | 2,134 |
| G4-FSM-SC-Rep | FSM Router + Scoped Context + Repair | 45/60, 75.0% | 1,017 | 0 | 1,017 | 575 | 555 | 2,147 |
| G5 | Full Qwen Agent | **19/60, 31.7%** | **1,513** | 0 | 0 | 1,513 | 0 | 1,513 |

`G4-FSM-SC-Rep` is the display label for the exact group ID `G4-FSM-SC-Repair`.

For every row:

```text
Physical Requests = Filter + Router + Local Agent + Server Agent
```

A rejected Local candidate is counted as one Local Agent call and its fallback as one Server Agent call. Therefore Local plus Server calls can exceed Logical Requests.

### Router mechanism counts

| Group | Accepted Local | Rejected Local | Accepted / Logical | Candidate acceptance |
|---|---:|---:|---:|---:|
| G4-RM | 234 | 226 | 25.94% | 50.87% |
| G4-RM-SC | 349 | 224 | 33.27% | 60.91% |
| G4-FSM-SC | 356 | 208 | 36.97% | 63.12% |
| G4-FSM-SC-Rep | 462 | 113 | 45.43% | 80.35% |

Repair recovered 35 otherwise rejected Local candidates. This is a contract-acceptance result, not proof that those calls caused Task SUCCESS.

## 5. Interpretation

- G2 matched G1 accuracy but used 455 more Physical Requests. This Filter path did not show an accuracy gain.
- G3 reached 48/60, the highest Filter result in this table, but used two model calls per Logical Request.
- G4-RM matched G1 at 45/60 while exposing finite work to the Logical-local Agent. It did not reduce Physical Requests.
- G4-RM-SC and G4-FSM-SC form the designed fresh paired comparison. FSM improved the point estimate by 5/60 and reduced Physical Requests by 188. The two-sided exact McNemar result was `p = 0.2265625`, so the difference is not statistically conclusive.
- G4-FSM-SC-Rep increased Local candidate acceptance but did not improve the later cross-window Task score. Repair and task accuracy measure different properties.
- Every Router row substantially exceeded Full Qwen at 19/60. This supports the complete hybrid system, not a claim about model capability in isolation.
- The best point estimate among these eight rows is 48/60, shared by G3 and G4-FSM-SC. Accuracy must be considered with request count, latency, Local acceptance, and Cloud demand.

Persistent failures concentrate in exact shared-storage paths, ZIP structure, Android settings, Provider persistence, intermediate Maps/browser states, and cross-application content transfer. Most are scored end-state failures rather than missing HTTP responses.

### Later aligned retest

The later 60-Cell aligned collection reported:

| Configuration | SUCCESS | Logical | Physical |
|---|---:|---:|---:|
| Full DSV4 direct | 48/60, 80.0% | 771 | 771 |
| DSV4 Router + FSM + Scoped Context + Repair | 47/60, 78.3% | 1,035 | 2,208 |
| Full Qwen3.6-35B direct | 24/60, 40.0% | 4,047 | 4,047 |

These later measurements support the same broad system conclusion but do not replace the frozen core snapshot above.

## 6. Exact experiment map

| Rows | Frozen configuration | Smoke / Formal | Invocation rule |
|---|---|---:|---|
| G1, G2, G3, G5 | `configs/unified-five-group-experiment-v4.json` | 4 / 240 | Do not pass `--group-id`; the four groups execute in frozen order. |
| G4-RM | `configs/router-rm-expanded15-experiment-v1.json` | 5 / 60 | Pass `--group-id G4-RM`. |
| G4-RM-SC, G4-FSM-SC | `configs/router-r2-fsm-expanded15-paired-experiment-v1.json` | 10 / 120 | Do not pass `--group-id`; this is a paired design. |
| G4-FSM-SC-Rep | `configs/router-fsm-scoped-repair-expanded15-experiment-v1.json` | 5 / 60 | Pass `--group-id G4-FSM-SC-Repair`. |

Validate the plans without model requests:

```bash
./phone/run.sh run --stage Formal \
  --config configs/unified-five-group-experiment-v4.json --validate-only

./phone/run.sh run --stage Formal \
  --config configs/router-rm-expanded15-experiment-v1.json \
  --group-id G4-RM --validate-only

./phone/run.sh run --stage Formal \
  --config configs/router-r2-fsm-expanded15-paired-experiment-v1.json --validate-only

./phone/run.sh run --stage Formal \
  --config configs/router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair --validate-only
```

For a live campaign, run the matching Smoke under a fresh identity and pass its healthy `smoke-gate.json` to Formal. The complete installation and recovery procedure is in [`PHONE_NATIVE_RUNBOOK.md`](PHONE_NATIVE_RUNBOOK.md).

Regenerate the core table from sealed Formal Cell evidence:

```bash
python tools/summarize_core_ablation.py \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<baseline-formal-id>" \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<rm-formal-id>" \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<paired-formal-id>" \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<repair-formal-id>" \
  --format markdown
```

If fail-fast recovery split a plan, use explicit `--segment ROOT START END` arguments. The summarizer rejects missing or duplicate Cells, reused Run IDs, infrastructure failures, incomplete responses, identity mismatches, and hash mismatches.

## 7. Evidence boundary

Every Cell uses a fresh 32-character lowercase hexadecimal `result.run_id`. Router, Cloud-Agent, and Logical-local-Agent provider sessions are distinct but bound to that Run ID. Requests execute serially. Raw request, response or Server-Sent Events (SSE), role, request ID, session ID, latency, verifier result, and hashes are sealed before finalization.

The source repository excludes credentials and large historical captures. It contains the frozen protocols and fail-closed summarizer required for a fresh collection. Verification of previously published values additionally requires the private canonical evidence archive and its recorded schedule segments.

See [`VERIFICATION.md`](VERIFICATION.md) for the release test record and [`SOURCE_MAP.md`](SOURCE_MAP.md) for source fidelity.
