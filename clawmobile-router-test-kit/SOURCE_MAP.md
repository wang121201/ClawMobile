# Source map

This package was assembled copy-only from the active ClawMobile workspace. Historical outputs and evidence were not moved or changed.

| Export path | Workspace source | Treatment |
|---|---|---|
| `five-group-v4/run_campaign.ps1` | `work/five-group-v4/run_campaign.ps1` | Exact copy |
| `five-group-v4/ExperimentCore.psm1` | `work/five-group-v4/ExperimentCore.psm1` | Exact copy |
| `five-group-v4/PhoneEnvironment.psm1` | `work/five-group-v4/PhoneEnvironment.psm1` | Exact copy |
| `five-group-v4/Evidence.psm1` | `work/five-group-v4/Evidence.psm1` | Exact copy |
| `five-group-v4/start_gateway_phone_a.sh` | `work/five-group-v4/start_gateway_phone_a.sh` | Exact copy |
| `five-group-v4/start_proxy_phone_a.sh` | `work/five-group-v4/start_proxy_phone_a.sh` | Exact copy |
| `clawmobile-router-proxy/` | `work/clawmobile-router-proxy/` | Exact directory copy; private-corpus aggregate manifest is Git-ignored |
| `clawbench-runtime/core/` | `work/clawbench-runtime/core/` | Exact source copy; bytecode ignored |
| `clawbench-runtime/tasks/` | `work/clawbench-runtime/tasks/` | Exact source copy; bytecode ignored |
| `clawbench-runtime/tool_skills/` | `work/clawbench-runtime/tool_skills/` | Exact copy |
| selected `clawbench-runtime/scripts/` files | corresponding `work/clawbench-runtime/scripts/` files | Exact copies of execution helpers only |
| root `router-*.json` | corresponding `work/router-*.json` files | Exact frozen config copies |
| `unified-five-group-experiment-v4.json` | `work/unified-five-group-experiment-v4.json` | Exact frozen four-group Full/Filter baseline config copy |
| `clawbench-channel/` | OpenClaw `10b4342c09de5b7fb22b07a0d7c6ebe797c52001`, `extensions/clawbench/`; live Phone A `~/clawbench-channel-10b4342`, excluding `node_modules` | 25 upstream source files byte-identical; narrow adaptations in `src/inbound.ts` and `openclaw.plugin.json`; local `tsconfig.external-build.json`; 40 derived `dist/` files; live export verified as 68 files, 146,419 bytes, zero SHA mismatch |
| `phone_controller/`, `phone/`, `PHONE_NATIVE_RUNBOOK.md` | Packaging additions | Canonical Termux-native controller and replacement-phone workflow |
| `Run-RouterCampaign.ps1` | Packaging addition | Legacy Windows-host reference launcher |
| `test_router_release.ps1` | Packaging addition | Minimal offline release validation |
| `README.md`, `PROJECT_GUIDE_AND_RESULTS.md`, `VERIFICATION.md`, `.gitignore`, `.env.example`, `THIRD_PARTY_NOTICES.md`, `tools/` | Packaging additions | Publication, maintained project/results overview, dated validation evidence, attribution, and reproducibility support |

Excluded by design:

- all external campaign outputs, reports, captures, and private evidence archives;
- historical campaign outputs, reports, raw request/response/SSE captures, and logs;
- OpenClaw private configuration and credentials;
- old L1, Full, Filter-only, XMU-only, analysis, and recovery runners not required by the Router execution closure;
- generated Python bytecode and Node dependencies.
- `clawmobile-router-proxy/parameter-schema-corpus-manifest.json`, because it records a private local corpus path; the audit script remains included.
