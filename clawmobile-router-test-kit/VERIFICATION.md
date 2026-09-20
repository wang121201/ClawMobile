# Verification record

Date: 2026-09-20

Scope: offline release validation plus one complete phone-native live Smoke on Phone 62. Windows/Codex was used only to deploy the release and observe SSH output; campaign planning, self-ADB, ClawBench execution, Gateway, Channel, Proxy, provider calls, verification, teardown, capture sealing, and the Smoke gate all ran inside Android Termux.

## Offline checks

- Every release file listed in `RELEASE-MANIFEST.json` was verified against `SHA256SUMS.txt` before phone deployment.
- 13 frozen Router configurations passed schema validation and exact Smoke/Formal plan generation.
- Phone-native plan rows matched the legacy production PowerShell plans row-for-row for all frozen configurations and stages.
- 5 PowerShell entry/module files parsed with 0 errors.
- 72 Python files parsed with `ast.parse`; 15 phone-controller unit tests passed.
- 130 Node Router Proxy tests passed on Windows and again natively on Phone 62; 0 failed, skipped, or cancelled.
- Release inventory contains 0 JSONL files, 0 log files, and 0 output/report/capture/result directories.
- The final release contains 206 manifest payload files plus `RELEASE-MANIFEST.json` and `SHA256SUMS.txt`, for 208 staged files total; `git diff --cached --check` passed and no symlink is staged.
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

This run proves that Windows is not in the Cell execution path. It does not remove replacement-phone prerequisites: Termux packages, OpenClaw, Android applications/permissions, self-ADB pairing, and a private provider credential must still be installed or configured as described in `PHONE_NATIVE_RUNBOOK.md`.

## Security review boundary

A Git-index-aware scan read all 208 staged blobs and found no unapproved private-key block, common-prefix provider key, literal bearer credential, or real `freeinference_api` assignment. The two reviewed allowlisted matches are the deliberate placeholder `replace-with-your-private-key` in `.env.example` and synthetic `Bearer must-not-be-recorded` in the capture-redaction test. `phone/phone.env`, `phone/phone-site.json`, captures, logs, outputs, and results are not staged. No `gitleaks` executable was available, so this is a targeted staged-content scan rather than a full entropy/history scanner.

Frozen private-network/device paths remain only as research provenance inside immutable experiment JSON. Replacement-phone execution obtains live topology from the ignored private site file. The repository root MIT license covers ClawMobile-owned code; the adapted OpenClaw Channel retains its upstream MIT notice separately.
