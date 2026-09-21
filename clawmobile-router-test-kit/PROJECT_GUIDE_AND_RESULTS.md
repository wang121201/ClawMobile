# ClawMobile Router Project Guide and Results

Last updated: 2026-09-21

This is the canonical living overview for the ClawMobile Router project. It explains the system, the current recommended experiment, how to reproduce it on a phone, what has already been measured, and what the results do and do not establish. Future review comments should be resolved in this file instead of creating parallel status documents.

Detailed immutable evidence remains in the campaign directories and in the cumulative results ledger referenced in [Evidence and provenance](#evidence-and-provenance). This document summarizes those sources; it does not replace raw requests, responses, Server-Sent Events (SSE), ClawBench results, or cryptographic manifests.

## 1. Project objective

ClawMobile is an Android Agent runtime built on OpenClaw. The Router project evaluates whether each Agent request can be assigned safely to one of two execution roles:

- a stronger **Cloud Agent**, currently `deepseek-v4-flash`; or
- a lower-cost **Logical-local Agent**, currently `qwen3.6-35b`.

For the current API-backed Router experiments, both models are physically served by FreeInference. “Logical-local” is an experimental role and routing target; it does not mean that Qwen3.6-35B is running on the phone or on XMU. The separate G6 experiment is the physical-local XMU result.

The project asks three distinct questions:

1. Can a Router expose a useful subset of Android Tool work to the Logical-local Agent without losing end-to-end task correctness?
2. Can deterministic state, scoped Tool context, validation, and bounded repair keep Local Tool Calls structurally safe?
3. What accuracy, request-count, latency, and failure trade-offs appear relative to Full DSV4 and Full Qwen baselines?

## 2. Terms and measurement boundaries

- **Task**: one ClawBench benchmark definition, such as creating a contact or saving a researched address.
- **Case**: one frozen parameter assignment for a Task.
- **Repetition**: an independent execution of one Task Case.
- **Cell**: one complete `Task × Case × Repetition`, including setup, a fresh session, Agent and Tool execution, deterministic verification, teardown, and durable evidence flush.
- **Run ID**: the fresh 32-character lowercase hexadecimal `result.run_id` generated for one Cell. It is the authoritative Cell and session identity.
- **Expanded15**: the frozen benchmark panel containing three Tasks from each of Levels L1 through L5. Each configuration runs 15 Tasks for four Repetitions, giving 60 Cells.
- **Logical Request**: one Agent request presented to a Full Agent, Filter, or Router policy.
- **Physical Request**: one actual model-service call. A Router Logical Request normally produces a Router-helper call plus one selected Agent call, so Physical Requests can exceed Logical Requests.
- **Router**: the component that chooses Cloud or Logical-local execution for a Logical Request.
- **Filter**: a helper that rewrites or filters context before a single Cloud Agent path; it does not select between Agents.
- **Tool Call**: one assistant-produced function invocation containing one exact Tool name and a JSON argument object. The Tool Result is the later observation returned for that invocation; neither a valid Tool Call nor a successful Tool Result alone establishes end-to-end Task SUCCESS.
- **RouteClass**: a finite label for the next immediate Agent responsibility. It classifies what must happen next; it does not generate Tool arguments or classify the whole remaining Task.
- **FSM (Finite-State Machine)**: a deterministic per-Cell projection rebuilt from already-visible Tool Calls and Tool Results in the current request. It constrains which Local actions are currently admissible and never inspects a future Tool Result or verifier outcome.
- **Scoped Context**: a Local-Agent request in which the global system affordance and visible Tool schemas are narrowed to the selected finite capability. Dynamic user, assistant, and Tool history is preserved; it is not summarized or truncated.
- **Repair**: a bounded deterministic correction to an otherwise invalid Local Tool Call, followed by the complete validator again. Repair does not bypass Tool Schema or FSM checks.
- **Scored SUCCESS / FAILURE**: the ClawBench deterministic verifier accepted or rejected the final Android state. Both are valid model-performance evidence.
- **Infrastructure failure**: ADB, service, provider transport, capture, timeout, or lifecycle failure. It is preserved as diagnostic evidence and excluded from the scored accuracy denominator.
- **Smoke**: a small live mechanism and lifecycle test. It proves wiring and evidence integrity, not population-level model accuracy.
- **Formal**: the frozen 60-Cell Expanded15 collection used for configuration-level performance analysis.

An accepted Local Tool Call is evidence that a candidate satisfied the current contract. It is not automatically evidence that the call was useful, shortened the trajectory, or caused Task SUCCESS.

## 3. Current recommended configuration

The current reference is:

| Field | Value |
|---|---|
| Configuration | `router-fsm-scoped-repair-expanded15-experiment-v1.json` |
| Group | `G4-FSM-SC-Repair` |
| Arm ID | `router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local` |
| Strategy | Router + FSM + Scoped Context + Standard Moderate Repair |
| Router model | FreeInference `deepseek-v4-flash` |
| Cloud Agent | FreeInference `deepseek-v4-flash` |
| Logical-local Agent | FreeInference `qwen3.6-35b` |
| Controller | one phone-native controller |
| Concurrency | one active Cell and at most one FreeInference request in flight |
| Smoke | five Cells, one from each benchmark Level |
| Formal | 60 Expanded15 Cells, group-major and round-major |

This configuration is the standard mechanism-rich reference, not a claim that it has the highest observed score. The Explicit Binary Tool configuration currently has the highest Expanded15 point estimate, but it is a different deterministic policy and has separate interpretation limits.

### 3.1 Tool-call classification

The RouteClass helper returns exactly `{"route_class": ..., "reason_code": ...}` under a strict JSON schema. It classifies only the next immediate responsibility. A static Proxy guard then decides whether that class has an executable finite Local contract; the helper itself neither executes a Tool nor authors arguments.

| RouteClass | Exact next-step meaning | G4-RM backend | FSM/Scoped backend |
|---|---|---|---|
| `OBSERVE_UI_RAW` | One raw screenshot or UI-dump call with the frozen empty/default argument contract. | Local candidate | Local candidate; always admissible unless a prior failed transition forces Cloud. |
| `QUERY_UI_GROUNDED` | One `android_ui_query` bound to the latest fresh same-Cell `dumpId`, with exactly one finite selector. | Local candidate when the dependency exists | Local only in `GROUND` with a fresh dump. |
| `INTERACT_UI_GROUNDED` | One `android_tap` or `adb_tap` at the exact fresh, clickable, enabled selected center. | Local candidate when the dependency exists | Local only in `READY` with the exact fresh query result. |
| `RETRIEVE_WEB_BOUNDED` | One bounded `web_search` with only approved finite fields. | Local candidate | Cloud. The current FSM family intentionally exposes only the three UI classes above to Local. |
| `PERSIST_OR_SYSTEM_MUTATION` | File, contact, calendar, setting, or other persistent/system mutation. | Cloud | Cloud |
| `OPEN_EXEC_OR_COMPOSITE` | Shell/exec, browser action, open-ended command, or compound/multi-Tool next step. | Cloud | Cloud |
| `VERIFY_COMPLETE_RECOVER` | Authoritative verification, completion, recovery, or interpretation rather than one finite action. | Cloud | Cloud |
| `NO_TOOL_OR_AMBIGUOUS` | No Tool, missing/stale dependency, unclear next action, or no uniquely supported class. | Cloud | Cloud |

This separation is important: **classification** chooses a responsibility class; **generation** asks the selected Agent for one Tool Call; **validation** checks its schema, class, and dependencies; only then may **execution** occur. A rejected Local candidate falls back to the Cloud Agent before Tool execution and is counted once under Local and once under Server Agent.

The eight semantic RouteClasses are distinct from the legacy argument-shape labels in `complexity.js` (`no_tool_call`, `no_arguments`, `simple_arguments`, `complex_arguments`, and `invalid_arguments`). The G4 mechanism comparison uses RouteClass/FSM contracts; argument-shape classification is not its routing target.

### 3.2 Scoped Context

Scoped Context is an affordance restriction, not conversation compression:

```text
original request: one global system message + complete dynamic history + all Tools
        |
        v
RouteClass + static dependency guard
        |
        v
Local request: finite system contract + unchanged dynamic history + whitelisted Tools
        |
        v
schema/RouteClass/FSM validation -> execute one Tool or fall back to Cloud
```

The compiler requires exactly one system message, replaces that global system instruction with a finite contract, preserves every dynamic user/assistant/Tool message after JSON serialization, and exposes only the Tool schemas allowed for the current class. The finite contract carries the allowed exact Tool names and state dependency, such as a fresh `dumpId` or selected `(x, y)` center. This reduces irrelevant affordances while keeping the trajectory evidence needed for the next decision.

### 3.3 FSM definition and transitions

The FSM is not a learned model and not mutable global state. For each request, the Proxy deterministically replays the current Cell’s visible Tool Call/Tool Result history and projects:

| Phase | Meaning | Principal Local capability |
|---|---|---|
| `PRECHECK` | No resolved Tool result yet. | Raw observation only. |
| `OBSERVE` | Prior work exists, but no current grounded selector is ready. | Raw observation only. |
| `GROUND` | A successful fresh UI dump exists at the current state version. | Raw observation or one grounded query. |
| `READY` | A successful fresh query selected an enabled, clickable center. | Raw observation or one exact grounded interaction. |
| `VERIFY_PENDING` | A UI mutation or unknown UI effect invalidated earlier artifacts; re-observation is required. | Raw observation only. |

UI mutations and unknown effects increment `state_version`, invalidate stale dump/query artifacts, and set `pending_reobserve`. A Local query is admissible only in `GROUND`; a Local interaction is admissible only in `READY`. When a Local Tool is authorized, the Proxy records an expected transition scoped by `result.run_id` and tied to the exact `tool_call_id`. On the next request in that Cell, a mismatched Tool Result, failed typed result, or wrong target phase forces a Cloud handoff. This prevents a Local model from reusing stale coordinates or silently skipping the observe-query-interact dependency chain.

### 3.4 Standard Moderate Repair

Repair runs only after a Local candidate fails validation and only when there is exactly one Tool Call. It is a deterministic compiler, not another model request. It cannot change the RouteClass, Tool name, Tool Call count, or semantic target. The approved transformations are deliberately narrow:

- normalize known argument aliases to the canonical schema key;
- losslessly coerce string booleans or integers;
- flatten one unambiguous single-query wrapper;
- remove optional observation arguments when the frozen contract requires the default representation;
- bind `dumpId` to the unique fresh dump or bind `(x, y)` to the unique fresh selected center.

After compilation, the complete base Tool-schema validator and finite RouteClass/FSM validator run again. The repaired call executes only if both pass; otherwise it is rejected and the request falls back to Cloud. Repair therefore raises contract acceptance for some near-valid calls but cannot fix a wrong Tool, wrong semantic target, flawed plan, or incorrect final Android state.

### 3.5 Mechanism ladder

| Configuration | Classifier | Scoped Context | FSM admissibility and transition check | Repair |
|---|---|---:|---:|---:|
| G4-RM | Eight-class DSV4 RouteClass helper | No | No | No |
| G4-RM-SC | Eight-class DSV4 RouteClass helper | Yes | No | No |
| G4-FSM-SC | Eight-class DSV4 RouteClass helper constrained by the projected state | Yes | Yes | No |
| G4-FSM-SC-Rep | Same FSM-constrained helper | Yes | Yes | Yes |

This is a mechanism-family ladder, not a universal causal ladder. G4-RM-SC versus G4-FSM-SC is the designed fresh paired comparison that changes FSM control while holding the panel and paired order fixed. G4-RM versus G4-RM-SC also changes the Local eligibility boundary for bounded web retrieval and was collected in a different window. The Repair arm is a later follow-up rather than a fresh pair with G4-FSM-SC. No row implies that each added mechanism must monotonically improve task accuracy.

## 4. Runtime architecture

```text
phone/run.sh
  -> phone_controller/campaign.py
    -> self-ADB + Channel/Gateway/Proxy/provider preflight
    -> clawbench-runtime/scripts/run_task_set.py
      -> Task setup
      -> fresh result.run_id and Proxy arm registration
      -> ClawBench Channel :8765
        -> OpenClaw Gateway :18789
          -> shared Router Proxy :18081
            -> Router helper
            -> Cloud Agent or Logical-local Agent
          -> Android Tool execution through self-ADB
      -> deterministic ClawBench verifier
      -> Task teardown
    -> durable raw capture flush
    -> copy-only evidence sealing and SHA-256 verification
    -> Cell status and Smoke/Formal gate
```

Planning, service checks, model calls, Android execution, verification, teardown, capture sealing, and gate generation all run inside Android Termux on the target phone.

The deployment uses one shared Proxy. It is not necessary to deploy a different Proxy for each arm. The Proxy selects the frozen strategy and provider roles from the Cell’s registered `result.run_id` and `arm_id`.

## 5. Source layout

| Path | Purpose |
|---|---|
| `phone/run.sh` | Canonical phone-native command entry point. |
| `phone/install.sh` | Phone installation and native offline tests. |
| `phone/phone-site.example.json` | Template for ignored phone-specific topology. |
| `phone_controller/` | Plan generation, service lifecycle, preflight, evidence sealing, and gates. |
| `clawmobile-router-proxy/src/` | Router, Filter, FSM, Scoped Context, Repair, provider calls, session validation, and capture. |
| `clawmobile-router-proxy/test/` | Proxy unit and integration-shape tests. |
| `clawbench-runtime/` | Benchmark registry, Tasks, device integration, verifier, and batch runner. |
| `clawbench-channel/` | OpenClaw ClawBench Channel derived from the pinned upstream MIT source recorded in `THIRD_PARTY_NOTICES.md`. |
| `router-*.json` | Frozen experiment definitions and Task/Case/Repetition mappings. |
| `unified-five-group-experiment-v4.json` | Frozen G1/G2/G3/G5 Full/Filter baseline plan used by the core table. |
| `tools/summarize_core_ablation.py` | Fail-closed regeneration of the core success/request table from sealed fresh Formal evidence. |
| `PHONE_NATIVE_RUNBOOK.md` | Detailed phone-native installation and recovery procedure. |
| `VERIFICATION.md` | Dated release, phone, Smoke, capture, and security validation record. |
| `RELEASE-MANIFEST.json` and `SHA256SUMS.txt` | Publishable package inventory and file hashes. |

Published development branch:

- Repository: <https://github.com/wang121201/ClawMobile.git>
- Branch: `codex/phone-native-router-kit`
- Code-validation commit: `f6b66cdb3ae2d6dfb5dea9c0e2f9ab39be5f1480`

The documentation commits after that code-validation commit do not change Router, Proxy, ClawBench, controller, or configuration behavior.

## 6. Cell isolation and evidence contract

For every Cell:

1. The controller verifies self-ADB, boot identity, Channel, Gateway, Proxy, run registration, and the required Provider.
2. ClawBench creates the Task’s deterministic initial state.
3. A new `result.run_id` is generated. Different Tasks and Repetitions never reuse it.
4. Router-helper, Cloud-Agent, and Logical-local-Agent provider sessions are role-isolated while remaining bound to the same `result.run_id`.
5. Model requests execute serially. Provider concurrency is capped at one.
6. ClawBench evaluates the final Android state using a deterministic verifier rather than model self-report.
7. Teardown completes and the same phone boot is reverified.
8. Raw request, response or SSE, role, request ID, session ID, latency, and decision evidence are flushed durably before the Cell is finalized.
9. Evidence is copied without overwriting and checked against recorded size and SHA-256.

Formal execution stops on the first infrastructure failure. A scored model FAILURE is preserved and the next scheduled Cell continues. Existing scored results are never silently rerun, relabeled, or overwritten.

## 7. Existing Expanded15 results

The only cumulative “all configurations” registry remains `work/expanded15-configuration-results-ledger.md`. That ledger contains every completed 60-Cell configuration, exact request accounting, mechanism diagnostics, immutable evidence roots, and revision history. The table below is a **frozen core ablation snapshot** reproduced here so that this repository can explain and reproduce the eight configurations requested for the main comparison. It is not a second cumulative registry and must not be extended independently of the ledger.

### 7.1 Frozen core ablation snapshot

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

The display label `G4-FSM-SC-Rep` maps to the exact configuration group ID `G4-FSM-SC-Repair`. For every row:

```text
Physical Requests = Filter + Router + Local Agent + Server Agent
```

A rejected Local candidate is counted as a Local Agent call and its fallback as a Server Agent call. Therefore `Local Agent + Server Agent` can exceed Logical Requests. For Full arms, one Logical Request maps to one selected Agent call. For Filter arms, each Logical Request produces one Filter call and one DSV4 Agent call. `Local Agent` and `Server Agent` are **experiment-model roles**, not literal `call_role` strings from older captures: historical G5 records used the transport label `cloud_agent`, but the frozen Full-Qwen arm is attributed to the Local Agent column by its `group_id=G5` and `arm_id=full-qwen36` identity.

### 7.2 Performance of the concepts

| Step | SUCCESS change | Physical-request change | What the observation supports |
|---|---:|---:|---|
| G1 → G2: add DSV4 Filter | 0 Cells, 0.0 percentage points | +455 | This Filter path matched G1 accuracy but nearly doubled physical service work; it did not demonstrate an accuracy gain in this panel. |
| G1 → G3: use Qwen Filter | +3 Cells, +5.0 points | +603 | The highest Filter point estimate in the snapshot, with two model calls per Logical Request. The result is a system observation, not proof that the Filter model alone caused the gain. |
| G1 → G4-RM: add RouteClass hybrid routing | 0 Cells, 0.0 points | +1,327 | Hybrid execution matched the Full-DSV4 score while invoking a Router for every Logical Request and sometimes both Local and Server Agents after Local rejection. |
| G4-RM → G4-RM-SC: mechanism-family difference, not isolated | -2 Cells, -3.3 points | +292 | This contrast changes Scoped Context, the bounded-web Local eligibility boundary, policy version, and collection window. It must not be interpreted as the causal effect of Scoped Context alone. |
| G4-RM-SC → G4-FSM-SC: fresh paired FSM treatment | +5 Cells, +8.3 points | -188 | The paired categories were 40 both-success, 8 FSM-only, 3 RM-only, and 9 both-failure. The two-sided exact McNemar value was `p = 0.2265625`, so the favorable point estimate and lower request count are not statistically conclusive. |
| G4-FSM-SC → G4-FSM-SC-Rep: Repair follow-up, not paired | -3 Cells, -5.0 points | +13 | Repair directly recovered 35 otherwise rejected Local candidates, but the cross-window SUCCESS delta is not attributable to Repair. Contract acceptance and end-state task accuracy are different outcomes. |
| G4-FSM-SC versus G5 Full Qwen | +29 Cells, +48.3 points | +621 | Constraining Qwen to finite Local UI responsibilities and retaining DSV4 for Cloud work was far stronger than unrestricted Full Qwen in this system. This compares complete systems, not only model capability. |

The strongest point estimate among these eight rows is 48/60, shared by G3 and G4-FSM-SC. The mechanisms differ materially: G3 keeps DSV4 as the sole Tool-call Agent after a Qwen Filter, while G4-FSM-SC routes individual responsibilities between DSV4 and Qwen under finite state constraints. Accuracy must therefore be reported together with request counts, Local acceptance/rejection, latency, and failure type.

The Router mechanism diagnostics make that distinction visible:

| Group | Accepted Local | Rejected Local | Accepted / Logical | Candidate acceptance |
|---|---:|---:|---:|---:|
| G4-RM | 234 | 226 | 25.94% | 50.87% |
| G4-RM-SC | 349 | 224 | 33.27% | 60.91% |
| G4-FSM-SC | 356 | 208 | 36.97% | 63.12% |
| G4-FSM-SC-Rep | 462 | 113 | 45.43% | 80.35% |

For G4-FSM-SC, 356 accepted Local transitions closed as 336 matches plus 20 safe Cloud handoffs, with no pending transition leakage. For the Repair arm, 427 calls were raw-valid, 148 repair opportunities were observed, 35 became repair-assisted valid calls, and 113 remained rejected. These are contract/mechanism measurements; they do not turn an accepted Local call into a claim of semantic usefulness.

### 7.3 Exact reproduction map

| Rows reproduced | Frozen config in this repository | Smoke / Formal | Selection rule |
|---|---|---:|---|
| G1, G2, G3, G5 | `unified-five-group-experiment-v4.json` | 4 / 240 | Multi-group frozen order; do not pass `--group-id`. Each result row is the corresponding 60-Cell group segment. |
| G4-RM | `router-rm-expanded15-experiment-v1.json` | 5 / 60 | Pass `--group-id G4-RM`. |
| G4-RM-SC, G4-FSM-SC | `router-r2-fsm-expanded15-paired-experiment-v1.json` | 10 / 120 | Paired design; do not pass `--group-id`. Each row is one 60-Cell group segment. |
| G4-FSM-SC-Rep | `router-fsm-scoped-repair-expanded15-experiment-v1.json` | 5 / 60 | Pass `--group-id G4-FSM-SC-Repair`. |

Validate every exact plan without starting services or sending a model request:

```bash
./phone/run.sh run --stage Smoke --config unified-five-group-experiment-v4.json --validate-only
./phone/run.sh run --stage Formal --config unified-five-group-experiment-v4.json --validate-only

./phone/run.sh run --stage Formal --config router-rm-expanded15-experiment-v1.json \
  --group-id G4-RM --validate-only

./phone/run.sh run --stage Formal \
  --config router-r2-fsm-expanded15-paired-experiment-v1.json --validate-only

./phone/run.sh run --stage Formal \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair --validate-only
```

For a live reproduction, first run the matching Smoke under a fresh `--group-run-id`. Run Formal under another fresh ID only after its `smoke-gate.json` passes, and supply that file with `--smoke-gate`. The controller refuses overwrite, enforces a fresh `result.run_id` per Cell, serializes all model calls, and stops the current invocation on the first infrastructure failure.

After all selected Formal plans complete, regenerate the table directly from sealed evidence. Use `--campaign-root` only for an uninterrupted campaign root. For a fail-fast/recovery run, use repeatable `--segment ROOT START END` arguments to select explicit inclusive schedule ranges and exclude the preserved failed stop Cell. Duplicate or missing planned Cells, reused run IDs, infrastructure failures, incomplete responses, identity mismatches, or capture hash mismatches make the tool fail closed:

```bash
python tools/summarize_core_ablation.py \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<baseline-formal-id>" \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<rm-formal-id>" \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<paired-formal-id>" \
  --campaign-root "$HOME/clawmobile-experiments/router-campaigns/<repair-formal-id>" \
  --format markdown
```

For example, the historical Repair row is selected without deleting or relabeling the preserved schedule-31 infrastructure failure:

```bash
python tools/summarize_core_ablation.py \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --segment "/path/to/repair-part-1-root" 1 30 \
  --segment "/path/to/repair-part-2-root" 31 60 \
  --format markdown
```

Use one or more `--config <frozen-config.json>` options when summarizing only a subset; with no `--config`, the tool requires all four core configs and all 480 planned Cells. It derives role counts from raw `model-calls.jsonl`, not from the published table.

The repository deliberately excludes the large historical raw captures. Fresh runs use the frozen protocol and result summarizer. Independent regeneration of already published historical rows additionally requires the canonical external evidence roots and, where recovery occurred, the exact segments listed below and in the cumulative ledger.

Canonical evidence for the displayed values remains outside Git in the private research archive. The stable archive identifiers are:

- G1/G2/G3/G5: `expanded15-v4-final-20260814T050046Z`;
- G4-RM: `g4-rm-expanded15-formal-20260817T204529Z`;
- G4-RM-SC/G4-FSM-SC: `expanded15-final-120cells-20260820` with `paired-summary.json`;
- G4-FSM-SC-Rep: `formal-20260820T142016Z` for schedules 1–30 and `formal-recovery-20260821T0020Z` for schedules 31–60.

Immutable report anchors for that historical snapshot are:

| Artifact | SHA-256 |
|---|---|
| Baseline `campaign-metrics.json` | `338038a018dc7160161a655aba4fb62dc03f130c8b74adec305d6af02a3cfc40` |
| Baseline `cell-index.csv` | `d481bf4e8a33d3937361e057d762097bae91525b0735aee305ca44cda32e09c8` |
| G4-RM `g4-rm-analysis.json` | `ccfdd039fd9256840747bca110f4d43626c2ed1cddbe27100a86c566cae5e0a6` |
| Paired RM-SC/FSM-SC `paired-summary.json` | `d48b076a7791a0f3aab82de4d13599faf38b200cbbc2ce6a9e7e7fec3f9f5875` |
| Repair `standard-moderate-repair-data-book.xlsx` | `e868c9479e66d178465abddb27ded179dd00d8a1df5a7c334f2b3444af4beb21` |

The main historical points needed to understand the current project are:

- Full DSV4: 45/60 (75.0%) in the original window and 48/60 (80.0%) in the later aligned retest.
- Full Qwen3.6-35B: 19/60 (31.7%) originally and 24/60 (40.0%) in the later aligned retest.
- the current DSV4 Router + FSM + Scoped Context + Repair family: 45/60 (75.0%) originally and 47/60 (78.3%) in the later aligned retest;
- Qwen Router substitution with the same FSM/Scoped Context/Repair framework: 49/60 (81.7%);
- deterministic Explicit Binary Tool policy: 52/60 (86.7%), the highest current point estimate, but not a statistically proven universal winner;
- physical-local XMU Qwen3.8-27B: 43/60 (71.7%), collected on a different phone/runtime boundary.

These measurements were collected in different collection periods unless explicitly identified as the aligned September retest. They must not be treated as a randomized concurrent causal ranking.

### 7.4 Later-period aligned retest

The September 2026 aligned retest used the same 60-Cell Expanded15 mapping for three configurations:

| Configuration | SUCCESS | Logical | Physical | Interpretation |
|---|---:|---:|---:|---|
| Full DSV4 direct | 48/60, 80.0% | 771 | 771 | Pure path; no Filter or Router. |
| DSV4 Router + FSM + Scoped Context + Repair | 47/60, 78.3% | 1,035 | 2,208 | Same mechanism family as the current reference configuration. |
| Full Qwen3.6-35B direct | 24/60, 40.0% | 4,047 | 4,047 | Pure path; substantially longer trajectories. |

The Router retest contains 1,036 Router-helper attempts, 603 Logical-local Agent calls, 569 Cloud Agent calls, 466 accepted Local calls, 35 applied Repairs out of 172 attempts, and 400 matched FSM transitions. All three datasets completed their 60 scored Cells with unique run/session identities and verified referenced evidence hashes. Two Qwen pre-Cell infrastructure interruptions were preserved outside the scored denominator.

## 8. What the results currently support

1. **Hybrid execution can outperform unrestricted Full Qwen3.6.** Every complete Router configuration in the table is above the historical G5 result of 19/60; the later-period Router result is 47/60 versus the later Full-Qwen result of 24/60. This is a system comparison, not a model-only causal estimate.
2. **FSM and validation matter.** FSM + Scoped Context reached 48/60, and the Qwen-Router substitution reached 49/60 while exposing a larger Local workload.
3. **Repair improves contract acceptance but does not guarantee Task improvement.** A repaired Tool Call may be structurally valid yet unnecessary or semantically unhelpful.
4. **The deterministic Explicit Binary Tool policy is the current highest point estimate.** It reached 52/60 with zero Router-model calls and only eight rejected Local candidates. Against Binary Tool, the paired two-sided exact McNemar result was `p = 0.3876953125`; this does not prove universal superiority.
5. **Router quality cannot be judged by task accuracy alone.** The Router arms usually use about two physical calls per Logical Request, so task success, Local acceptance, Cloud demand, trajectory length, latency, and cost must be reported together.
6. **Physical-local and logical-local results must remain separate.** G6 used Qwen3.8-27B on XMU and a different phone/runtime period. It is evidence for local serving feasibility, not a controlled replacement for G5 or the Logical-local role in G4.

## 9. Persistent failure themes

Across configurations, failures concentrate in several end-state boundaries rather than provider transport:

- exact shared-storage paths, filenames, and file contents;
- ZIP structure and folder selection, especially `L2-05`;
- Android settings where visible UI state differs from the authoritative setting read by the verifier;
- Contacts or Calendar actions that appear complete in the UI but are not persisted in the Provider;
- Maps or browser tasks that stop at an intermediate page instead of the required final entity;
- cross-application tasks such as `L5-02`, where researched content must be preserved exactly into a file.

The canonical 60-Cell datasets mostly contain scored model failures rather than missing HTTP responses. A valid Tool Call, a visible UI action, or a final natural-language claim of completion is not enough; the deterministic verifier’s target state is authoritative.

## 10. Evidence and provenance

Canonical references outside the publishable repository:

- cumulative configuration ledger: `expanded15-configuration-results-ledger.md` in the private research archive;
- current handoff and experiment registry: `main-session-current-data-analysis-handoff.md` in the private research archive;
- latest unified G-series report: archive ID `g-series-20260920T114000Z`;
- latest three-group aligned report: archive ID `three-group-20260920T112229Z`;
- raw campaign roots and their exact canonical segments are registered in the cumulative ledger rather than duplicated in this repository.

The Git repository intentionally excludes API keys, private site files, raw model captures, SSE, Android state, campaign outputs, and large reports. A result is considered authoritative only when its Cell plan, unique run/session identity, verifier result, capture, and evidence hashes can be joined without ambiguity.

## 11. Current readiness and next steps

Current status:

- release and source-provenance checks: PASS;
- phone-native offline tests: PASS;
- no live experiment is currently implied by this documentation state.

Reasonable next steps are deliberately separate decisions:

1. Merge or continue reviewing the published branch.
2. If a new performance measurement is required, restart the shared Proxy, rerun `doctor`, create a new five-Cell Smoke identity, and then run a new 60-Cell Formal identity against the unchanged configuration.
3. For Router-efficiency research, analyze accepted Local calls for semantic usefulness before broadening the capability policy.
4. Do not interpret a new five-Cell Smoke as a replacement for any historical 60-Cell result.

## 12. Revision and comment log

| Date | Comment or change | Resolution and evidence | Status |
|---|---|---|---|
| 2026-09-21 | Make public documentation English-only and describe only the phone-native experiment environment. | Replaced local storage paths with stable archive identifiers or generic placeholders, removed external-host comparison language, and translated the Proxy reference into English without changing runtime code or frozen experiment data. | Resolved |
| 2026-09-21 | Make the eight-row core comparison reproducible and define Tool classification, Scoped Context, FSM, and Repair. | Added the exact four-group baseline config, frozen-plan parity coverage, source-truth mechanism definitions, the core result/reproduction map, and a fail-closed evidence summarizer; preserved the cumulative ledger as the sole all-configuration registry. | Resolved |
| 2026-09-21 | Create one maintained Router project description and results overview. | Consolidated architecture, phone-native execution, selected Expanded15 results, and interpretation boundaries; retained the cumulative ledger as the only all-configuration table. | Resolved |

Future comments should identify the section and requested correction. Resolved changes will be applied to this file and recorded in this revision log.
