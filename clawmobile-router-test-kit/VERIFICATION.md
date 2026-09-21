# Verification record

Date: 2026-09-21

Scope: offline release validation and complete phone-native live Smoke checks on Phone 62 and Phone 132. Campaign planning, self-ADB, ClawBench execution, Gateway, Channel, Proxy, provider calls, verification, teardown, capture sealing, and the Smoke gate all ran inside Android Termux.

## Offline checks

- Every release file listed in `RELEASE-MANIFEST.json` was verified against `SHA256SUMS.txt` before phone deployment.
- 14 frozen experiment configurations—13 Router configurations plus one four-group Full/Filter baseline—passed schema validation and exact Smoke/Formal plan generation.
- Phone-native plan rows matched the legacy production PowerShell plans row-for-row for all frozen configurations and stages.
- 5 PowerShell entry/module files parsed with 0 errors.
- 74 Python files parsed with `ast.parse`; 20 phone-controller and result-summary unit tests passed.
- 130 Node Router Proxy tests passed in release validation and again natively on Phone 62; 0 failed, skipped, or cancelled.
- The new evidence summarizer regenerated the historical G1/G2/G3/G5 rows from the 240 canonical indexed Cells, including G5's experiment-role attribution of 1,513 Local Agent calls and zero Server Agent calls. It regenerated G4-RM directly from 60 sealed Cells as 45/60 SUCCESS, 902 Logical Requests, and 2,030 Physical Requests, then selected the two immutable Repair segments around the preserved stop Cell and reproduced 45/60 SUCCESS, 1,017 Logical Requests, and 2,147 Physical Requests. Every regenerated value exactly matches the frozen core table.
- Release inventory contains 0 JSONL files, 0 log files, and 0 output/report/capture/result directories.
- The documented release contains 210 manifest payload files plus `RELEASE-MANIFEST.json` and `SHA256SUMS.txt`, for 212 tracked release files total; `git diff --cached --check` passed and no symlink is staged.
- The vendored Channel was traced to OpenClaw commit `10b4342c09de5b7fb22b07a0d7c6ebe797c52001`, path `extensions/clawbench/`. Its original MIT notice is preserved in `clawbench-channel/LICENSE`, with exact adaptations recorded in `THIRD_PARTY_NOTICES.md`.

## Phone deployment and service proof

- Deployed package: `$HOME/ClawMobile/clawmobile-router-test-kit`.
- The uploaded release archive is preserved on the phone; the existing OpenClaw configuration was backed up copy-only with byte count and SHA-256 before its atomic phone-local update.
- OpenClaw now loads the repository-owned path `$HOME/ClawMobile/clawmobile-router-test-kit/clawbench-channel/dist/index.js` as the only configured `clawbench` plugin. The configurator removed the byte-identical legacy live-copy path, `openclaw plugins doctor` reported no issues, and `openclaw plugins inspect clawbench` resolved the repository path.
- Site profile: `termux-android-phone-native-v1`, site ID `phone-a-62-pixel9`.
- Self-ADB serial `127.0.0.1:5555` reported `device`; the boot ID remained stable across the live run.
- Phone-local Channel `127.0.0.1:8765`, Gateway `127.0.0.1:18789`, and shared Proxy `127.0.0.1:18081` all passed health checks.
- FreeInference `/v1/models` returned HTTP 200 using the phone-private credential environment.
- The controller started exactly one managed Gateway and one managed shared Proxy. Provider concurrency was fixed at one; maximum observed FreeInference concurrency was one with no queue at completion.

## Live phone-native Smoke

- Configuration: `router-fsm-scoped-repair-expanded15-experiment-v1.json`
- Group: `G4-FSM-SC-Repair`
- Campaign ID: `phone-native-migration-smoke-20260920T1750Z`
- Phone output root: `$HOME/clawmobile-experiments/router-campaigns/phone-native-migration-smoke-20260920T1750Z`

| Schedule | Task case | Classification | Elapsed |
|---:|---|---|---:|
| 1 | L1-03:1 | `primary_scored_success` | 52.607 s |
| 2 | L2-09:2 | `primary_scored_failure` | 56.829 s |
| 3 | L3-01:1 | `primary_scored_success` | 535.363 s |
| 4 | L4-01:1 | `primary_scored_success` | 138.021 s |
| 5 | L5-02:1 | `primary_scored_success` | 227.548 s |

Final integrity state:

- 5/5 planned Cells completed: 4 scored successes, 1 scored model failure, 0 infrastructure failures.
- All five Cells used distinct authoritative `result.run_id` values.
- The L2 scored failure was retained as valid model evidence; it was not retried, overwritten, or relabeled.
- The canonical mechanism-aware Smoke gate passed.
- Campaign evidence contains 53 files and 65,802,581 bytes on the phone.
- Proxy capture ended with `pending=0`, `errors=0`, and no active or queued provider call.
- The campaign controller exited normally; no phone campaign or ClawBench runner remained active.
- The managed-service stop path validated the pinned post-`exec` process identities, stopped only the recorded Proxy and Gateway process groups, and left SSH plus self-ADB healthy with ports 8765, 18789, and 18081 closed.

After canonicalizing the Channel source path, a no-inference live acceptance repeated the native unit tests, started the repository Channel/Gateway and shared Proxy, passed the complete phone-native `doctor` check, observed zero queued or active provider calls and zero capture errors, and stopped the two managed service groups cleanly. This acceptance did not create a benchmark Cell or send a model request.

## Phone 132 live Smoke verification

Phone 132 ran code-validation commit `f6b66cdb3ae2d6dfb5dea9c0e2f9ab39be5f1480`. The phone-specific site and credential files remained ignored. The repository-owned ClawBench Channel was installed through the supported OpenClaw plugin link path, and `openclaw plugins doctor` reported no issue.

- Device: Pixel 9, Android serial `46010DLAQ002H0`.
- Stable self-ADB: `127.0.0.1:5555`, state `device`.
- Site ID: `phone-132-router-migration-20260920`.
- Smoke configuration: `router-fsm-scoped-repair-expanded15-experiment-v1.json`.
- Group: `G4-FSM-SC-Repair`.
- Campaign ID: `migration-smoke-20260920T201600Z`.
- Phone evidence root: `$HOME/clawmobile-experiments/router-campaigns/migration-smoke-20260920T201600Z`.

| Schedule | Task case | Classification | Elapsed |
|---:|---|---|---:|
| 1 | L1-03:1 | `primary_scored_success` | 227.932 s |
| 2 | L2-09:2 | `primary_scored_success` | 96.292 s |
| 3 | L3-01:1 | `primary_scored_success` | 517.967 s |
| 4 | L4-01:1 | `primary_scored_success` | 201.170 s |
| 5 | L5-02:1 | `primary_scored_success` | 128.813 s |

Final integrity state:

- 5/5 planned Cells were structurally healthy and scored SUCCESS; infrastructure failures were zero.
- All five Cells used distinct authoritative `result.run_id` values.
- The mechanism-aware Smoke gate passed.
- The run produced 132 Router decisions, 80 Logical-local Agent calls, 74 Cloud Agent calls, and 286 total model-service calls.
- 58 Local calls passed the complete contract: 49 raw-valid and nine valid after bounded Repair.
- Capture finished with 476 durable records, 286 durable model calls, `pending=0`, and `errors=0`.
- FreeInference maximum observed concurrency was one; current and queued counts were zero at completion.
- A post-run `doctor` passed self-ADB, Channel, Gateway, Proxy, provider-concurrency, and capture checks.
- The exact package-managed Proxy PID was then stopped. Proxy port 18081 closed as expected while Channel and Gateway remained HTTP 200 and self-ADB remained healthy.
- The complete 53-file campaign evidence was mirrored copy-only to an external archive identified as `migration-smoke-20260920T201600Z`. Phone and archive copies both contain 75,012,302 bytes; an independent per-file relative-path, size, and SHA-256 comparison found zero missing files and zero mismatches. Its host-specific storage path is intentionally omitted from public documentation.

The five Cells verify complete live Router execution and evidence integrity on Phone 132. They are a functional Smoke and do not replace or extend the 60-Cell Formal accuracy denominator. Required environment components remain those listed in `PHONE_NATIVE_RUNBOOK.md`.

## Security review boundary

A Git-index-aware scan read all 212 tracked release blobs and found no unapproved private-key block, common-prefix provider key, literal bearer credential, or real `freeinference_api` assignment. Reviewed matches were deliberate placeholders in example files and synthetic Bearer values used by Proxy tests, including the capture-redaction sentinel; none is a live credential. `phone/phone.env`, `phone/phone-site.json`, captures, logs, outputs, and results are not tracked. No `gitleaks` executable was available, so this is a targeted tracked-content scan rather than a full entropy/history scanner.

Frozen private-network/device paths remain only as research provenance inside immutable experiment JSON. Live topology comes from the ignored private site file. The repository root MIT license covers ClawMobile-owned code; the adapted OpenClaw Channel retains its upstream MIT notice separately.
