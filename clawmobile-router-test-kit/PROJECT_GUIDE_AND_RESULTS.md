# ClawMobile Router Project Guide and Results

Last updated: 2026-09-21

This is the canonical living overview for the ClawMobile Router project. It explains the system, the current recommended experiment, how to reproduce it on a phone, what has already been measured, and what the results do and do not establish. Future review comments should be resolved in this file instead of creating parallel status documents.

Detailed immutable evidence remains in the campaign directories and in the cumulative results ledger referenced in [Evidence and provenance](#evidence-and-provenance). This document summarizes those sources; it does not replace raw requests, responses, Server-Sent Events (SSE), ClawBench results, or cryptographic manifests.

## 1. Project objective

ClawMobile is an Android Agent runtime built on OpenClaw. The Router project evaluates whether each Agent request can be assigned safely to one of two execution roles:

- a stronger **Cloud Agent（云端代理）**, currently `deepseek-v4-flash`; or
- a lower-cost **Logical-local Agent（逻辑本地代理）**, currently `qwen3.6-35b`.

For the current API-backed Router experiments, both models are physically served by FreeInference. “Logical-local” is an experimental role and routing target; it does not mean that Qwen3.6-35B is running on the phone or on XMU. The separate G6 experiment is the physical-local XMU result.

The project asks four distinct questions:

1. Can a Router expose a useful subset of Android Tool work to the Logical-local Agent without losing end-to-end task correctness?
2. Can deterministic state, scoped Tool context, validation, and bounded repair keep Local Tool Calls structurally safe?
3. What accuracy, request-count, latency, and failure trade-offs appear relative to Full DSV4 and Full Qwen baselines?
4. Can the complete experiment be cloned and executed on another phone without Windows participating in the Cell execution path?

## 2. Terms and measurement boundaries

- **Task（任务）**: one ClawBench benchmark definition, such as creating a contact or saving a researched address.
- **Case（参数案例）**: one frozen parameter assignment for a Task.
- **Repetition（重复轮次）**: an independent execution of one Task Case.
- **Cell（实验单元）**: one complete `Task × Case × Repetition`, including setup, a fresh session, Agent and Tool execution, deterministic verification, teardown, and durable evidence flush.
- **Run ID（运行标识）**: the fresh 32-character lowercase hexadecimal `result.run_id` generated for one Cell. It is the authoritative Cell and session identity.
- **Expanded15**: the frozen benchmark panel containing three Tasks from each of Levels L1 through L5. Each configuration runs 15 Tasks for four Repetitions, giving 60 Cells.
- **Logical Request（逻辑请求）**: one Agent request presented to a Full Agent, Filter, or Router policy.
- **Physical Request（物理请求）**: one actual model-service call. A Router Logical Request normally produces a Router-helper call plus one selected Agent call, so Physical Requests can exceed Logical Requests.
- **Router（路由器）**: the component that chooses Cloud or Logical-local execution for a Logical Request.
- **Filter（过滤器）**: a helper that rewrites or filters context before a single Cloud Agent path; it does not select between Agents.
- **FSM (Finite-State Machine, 有限状态机)**: deterministic per-Cell state derived from prior Tool Calls and Tool Results. It constrains which Local actions are currently admissible.
- **Scoped Context（作用域上下文）**: the reduced Tool and history view supplied to the selected Agent.
- **Repair（修复）**: a bounded deterministic correction to an otherwise invalid Local Tool Call, followed by the complete validator again. Repair does not bypass Tool Schema or FSM checks.
- **Scored SUCCESS / FAILURE（计分成功/失败）**: the ClawBench deterministic verifier accepted or rejected the final Android state. Both are valid model-performance evidence.
- **Infrastructure failure（基础设施失败）**: ADB, service, provider transport, capture, timeout, or lifecycle failure. It is preserved as diagnostic evidence and excluded from the scored accuracy denominator.
- **Smoke（冒烟测试）**: a small live mechanism and lifecycle test. It proves wiring and evidence integrity, not population-level model accuracy.
- **Formal（标准实验）**: the frozen 60-Cell Expanded15 collection used for configuration-level performance analysis.

An accepted Local Tool Call is evidence that a candidate satisfied the current contract. It is not automatically evidence that the call was useful, shortened the trajectory, or caused Task SUCCESS.

## 3. Current recommended configuration

The current migration-tested reference is:

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

Windows and Codex are not part of the Cell execution path. They may be used to review code, observe SSH output, or make a copy-only archive. Planning, service checks, model calls, Android execution, verification, teardown, capture sealing, and gate generation run inside Android Termux.

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
| `PHONE_NATIVE_RUNBOOK.md` | Detailed replacement-phone installation and recovery procedure. |
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

## 7. Replacement-phone installation and use

### 7.1 Prerequisites

The replacement phone needs:

- Android with Termux, OpenSSH, Python, Node.js, Android platform tools, and OpenClaw;
- Wireless Debugging paired once, followed by stable phone-local self-ADB at `127.0.0.1:5555`;
- the Android applications and permissions required by Expanded15, including Contacts, Calendar, Maps, YouTube, Amazon, shared storage, and accessibility/UI automation;
- consistent locale, account/login state, application versions, and permission state;
- a private `freeinference_api` credential exported outside Git;
- no other active experiment controller or conflicting Gateway/Proxy process.

Clone the tested branch:

```bash
git clone --branch codex/phone-native-router-kit --single-branch \
  https://github.com/wang121201/ClawMobile.git "$HOME/ClawMobile"

cd "$HOME/ClawMobile/clawmobile-router-test-kit"
chmod +x phone/*.sh
./phone/install.sh
```

Create ignored private files from the supplied templates and set the real phone topology and provider environment:

```bash
cp phone/phone-site.example.json phone/phone-site.json
cp phone/phone.env.example phone/phone.env
```

Do not commit either private file. Configure and validate the phone:

```bash
./phone/run.sh configure
./phone/run.sh services start
./phone/run.sh doctor
```

Validate the exact plans without sending a model request:

```bash
./phone/run.sh run \
  --stage Smoke \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --validate-only

./phone/run.sh run \
  --stage Formal \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --validate-only
```

Run the canonical live Smoke with a new identity:

```bash
smoke_id="router-smoke-$(date -u +%Y%m%dT%H%M%SZ)"

./phone/run.sh run \
  --stage Smoke \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id "$smoke_id"
```

Only after `smoke_gate.json` reports `passed: true`, run Formal with a different new identity:

```bash
formal_id="router-formal-$(date -u +%Y%m%dT%H%M%SZ)"

./phone/run.sh run \
  --stage Formal \
  --config router-fsm-scoped-repair-expanded15-experiment-v1.json \
  --group-id G4-FSM-SC-Repair \
  --group-run-id "$formal_id" \
  --smoke-gate "$HOME/clawmobile-experiments/router-campaigns/$smoke_id/smoke-gate.json"
```

When no experiment owns the shared Proxy, stop only the package-managed Proxy:

```bash
./phone/run.sh services stop-proxy
```

Do not stop unrelated Termux or Android processes. Use `PHONE_NATIVE_RUNBOOK.md` for recovery and exact process-identity rules.

## 8. Current clean-phone migration acceptance

On 2026-09-20/21, the published branch was cloned on replacement Phone 132. The phone used a fresh private site profile and stable self-ADB. The tracked Git worktree was clean at the validated code commit.

Canonical five-Cell Smoke:

| Schedule | Task Case | Result | Elapsed | Run ID |
|---:|---|---|---:|---|
| 1 | `L1-03:1` | SUCCESS | 227.932 s | `a377037afebb4670b3609e752d0e8434` |
| 2 | `L2-09:2` | SUCCESS | 96.292 s | `598a0a3fb13a4761a7fcb694c4573cff` |
| 3 | `L3-01:1` | SUCCESS | 517.967 s | `2410cba3a6dd469eb806927965216417` |
| 4 | `L4-01:1` | SUCCESS | 201.170 s | `64ce61bfe8424e96bd68ce7f260e3464` |
| 5 | `L5-02:1` | SUCCESS | 128.813 s | `a54561b3db354c6a8c174cca8f4740a5` |

Gate and mechanism summary:

| Metric | Result |
|---|---:|
| Planned / structurally healthy Cells | 5 / 5 |
| Scored SUCCESS | 5 / 5 |
| Infrastructure failures | 0 |
| Logical Proxy Requests / Router decisions | 132 / 132 |
| Router-helper + Agent Physical Requests | 286 |
| Logical-local Agent calls | 80 |
| Cloud Agent calls | 74 |
| Accepted Local calls | 58 |
| Raw-valid / repair-assisted Local calls | 49 / 9 |
| Repair attempts / applied / rejected | 31 / 9 / 22 |
| FSM transitions resolved / matched | 58 / 49 |
| Forced Cloud handoffs | 9 |
| Durable capture records / model calls | 476 / 286 |
| Capture pending / errors at completion | 0 / 0 |
| Maximum observed FreeInference concurrency | 1 |
| Smoke gate | PASS |

Phone evidence root:

```text
$HOME/clawmobile-experiments/router-campaigns/migration-smoke-20260920T201600Z
```

Copy-only evidence mirror:

```text
D:\codexdataspace\remote-sync\phone-132\migration-smoke-20260920T201600Z
```

The phone root and local mirror each contain 53 files and 75,012,302 bytes. An independent relative-path, byte-count, and SHA-256 comparison found zero missing files and zero mismatches.

The post-run doctor passed self-ADB, Channel, Gateway, Proxy, Provider-concurrency, and capture checks. The package-managed Proxy was then stopped exactly; Channel and Gateway remained healthy. This establishes reproducible deployment, end-to-end functionality, and evidence integrity on the replacement phone. Five successful Cells do not establish a 100% expected Formal success rate.

## 9. Existing Expanded15 results

The only cumulative “all configurations” table is `work/expanded15-configuration-results-ledger.md`. That ledger contains every completed 60-Cell configuration, exact request accounting, mechanism diagnostics, immutable evidence roots, and the revision history. It must be updated for future configurations; this overview deliberately does not create a second cumulative table.

The main historical points needed to understand the current project are:

- Full DSV4: 45/60 (75.0%) in the original window and 48/60 (80.0%) in the later aligned retest.
- Full Qwen3.6-35B: 19/60 (31.7%) originally and 24/60 (40.0%) in the later aligned retest.
- the current DSV4 Router + FSM + Scoped Context + Repair family: 45/60 (75.0%) originally and 47/60 (78.3%) in the later aligned retest;
- Qwen Router substitution with the same FSM/Scoped Context/Repair framework: 49/60 (81.7%);
- deterministic Explicit Binary Tool policy: 52/60 (86.7%), the highest current point estimate, but not a statistically proven universal winner;
- physical-local XMU Qwen3.8-27B: 43/60 (71.7%), collected on a different phone/runtime boundary.

These measurements were collected in different windows unless explicitly identified as the aligned September retest. They must not be treated as a randomized concurrent causal ranking.

### 9.1 Later-window aligned retest

The September 2026 aligned retest used the same 60-Cell Expanded15 mapping for three configurations:

| Configuration | SUCCESS | Logical | Physical | Interpretation |
|---|---:|---:|---:|---|
| Full DSV4 direct | 48/60, 80.0% | 771 | 771 | Pure path; no Filter or Router. |
| DSV4 Router + FSM + Scoped Context + Repair | 47/60, 78.3% | 1,035 | 2,208 | Same mechanism family as the current migration-tested configuration. |
| Full Qwen3.6-35B direct | 24/60, 40.0% | 4,047 | 4,047 | Pure path; substantially longer trajectories. |

The Router retest contains 1,036 Router-helper attempts, 603 Logical-local Agent calls, 569 Cloud Agent calls, 466 accepted Local calls, 35 applied Repairs out of 172 attempts, and 400 matched FSM transitions. All three datasets completed their 60 scored Cells with unique run/session identities and verified referenced evidence hashes. Two Qwen pre-Cell infrastructure interruptions were preserved outside the scored denominator.

## 10. What the results currently support

1. **The Router framework is operational and portable.** The same Git branch passed offline tests, Phone 62 execution, and clean replacement-phone execution without Windows controlling Cells.
2. **Hybrid execution can outperform unrestricted Full Qwen3.6.** Every complete Router configuration in the table is above the historical G5 result of 19/60; the later-window Router result is 47/60 versus the later Full-Qwen result of 24/60. This is a system comparison, not a model-only causal estimate.
3. **FSM and validation matter.** FSM + Scoped Context reached 48/60, and the Qwen-Router substitution reached 49/60 while exposing a larger Local workload.
4. **Repair improves contract acceptance but does not guarantee Task improvement.** A repaired Tool Call may be structurally valid yet unnecessary or semantically unhelpful.
5. **The deterministic Explicit Binary Tool policy is the current highest point estimate.** It reached 52/60 with zero Router-model calls and only eight rejected Local candidates. Against Binary Tool, the paired two-sided exact McNemar result was `p = 0.3876953125`; this does not prove universal superiority.
6. **Router quality cannot be judged by task accuracy alone.** The Router arms usually use about two physical calls per Logical Request, so task success, Local acceptance, Cloud demand, trajectory length, latency, and cost must be reported together.
7. **Physical-local and logical-local results must remain separate.** G6 used Qwen3.8-27B on XMU and a different phone/runtime window. It is evidence for local serving feasibility, not a controlled replacement for G5 or the Logical-local role in G4.

## 11. Persistent failure themes

Across configurations, failures concentrate in several end-state boundaries rather than provider transport:

- exact shared-storage paths, filenames, and file contents;
- ZIP structure and folder selection, especially `L2-05`;
- Android settings where visible UI state differs from the authoritative setting read by the verifier;
- Contacts or Calendar actions that appear complete in the UI but are not persisted in the Provider;
- Maps or browser tasks that stop at an intermediate page instead of the required final entity;
- cross-application tasks such as `L5-02`, where researched content must be preserved exactly into a file.

The canonical 60-Cell datasets mostly contain scored model failures rather than missing HTTP responses. A valid Tool Call, a visible UI action, or a final natural-language claim of completion is not enough; the deterministic verifier’s target state is authoritative.

## 12. Evidence and provenance

Canonical local references outside the publishable repository:

- cumulative configuration ledger: `C:\Users\82412\Documents\Codex\2026-08-05\to\work\expanded15-configuration-results-ledger.md`;
- current handoff and experiment registry: `C:\Users\82412\Documents\Codex\2026-08-05\to\work\main-session-current-data-analysis-handoff.md`;
- latest unified G-series report: `D:\codexdataspace\reports\clawmobile-expanded15-g-series\g-series-20260920T114000Z`;
- latest three-group aligned report: `D:\codexdataspace\reports\clawmobile-three-group-expanded15\three-group-20260920T112229Z`;
- replacement-phone Smoke mirror: `D:\codexdataspace\remote-sync\phone-132\migration-smoke-20260920T201600Z` (53 files, 75,012,302 bytes, zero SHA-256 mismatch);
- raw campaign roots and their exact canonical segments are registered in the cumulative ledger rather than duplicated in this repository.

The Git repository intentionally excludes API keys, private site files, raw model captures, SSE, Android state, campaign outputs, and large reports. A result is considered authoritative only when its Cell plan, unique run/session identity, verifier result, capture, and evidence hashes can be joined without ambiguity.

## 13. Current readiness and next steps

Current status:

- release and source-provenance checks: PASS;
- phone-native offline tests: PASS;
- replacement-phone migration: PASS;
- canonical five-Cell live Smoke: PASS, 5/5;
- current managed Proxy after acceptance: intentionally stopped;
- current 60-Cell Formal on the replacement phone: not started.

Reasonable next steps are deliberately separate decisions:

1. Merge or continue reviewing the published branch.
2. If a new performance measurement is required, restart the shared Proxy, rerun `doctor`, create a new five-Cell Smoke identity, and then run a new 60-Cell Formal identity against the unchanged configuration.
3. If the research goal is Router efficiency rather than migration, analyze accepted Local calls for semantic usefulness before broadening the capability policy.
4. Do not interpret a new five-Cell Smoke as a replacement for any historical 60-Cell result.

## 14. Revision and comment log

| Date | Comment or change | Resolution and evidence | Status |
|---|---|---|---|
| 2026-09-21 | Create one maintained Router project description and results overview. | Consolidated architecture, phone-native reproduction, selected Expanded15 results, interpretation boundaries, and the clean Phone 132 migration Smoke; retained the cumulative ledger as the only all-configuration table. | Resolved |

Future comments should identify the section and requested correction. Resolved changes will be applied to this file and recorded in this revision log.
