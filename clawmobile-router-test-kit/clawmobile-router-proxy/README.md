# ClawMobile Filter/Router Proxy

This directory contains a zero-dependency Node.js 22 service. It exposes an
OpenAI-compatible Chat Completions API to OpenClaw and supports controlled
experiments with Tool filtering, request-level routing, and final Agent models.

The experiments use three logical model roles. One physical model may serve
more than one role, but every service request carries an explicit role:

- **Filter/Router Decision model**: FreeInference `deepseek-v4-flash`. It
  predicts the next Tool responsibility or a bounded routing class.
- **Cloud Agent model**: FreeInference `deepseek-v4-flash`. It produces the
  final assistant response or Tool Call.
- **Local Agent model**: a logical experiment role, not necessarily a physical
  deployment location. `qwen3-8b` may be served by XMU, while
  `qwen3.6-35b` is served by FreeInference in the historical logical-local
  Router arms. Reports must preserve both the physical provider and logical
  role.

A **Tool Schema** is the original function name, description, and parameter
definition from `tools[]`. A **Final** response enters the Agent loop. A
Decision helper predicts only; it neither executes Tools nor writes Tool
arguments.

## Virtual models and strategies

| Virtual model or strategy | Exact behavior |
|---|---|
| `cloud-full` | Sends the unchanged request and full Tool catalog directly to the Cloud Agent. |
| `local-full` | Sends the unchanged request and full Tool catalog directly to the configured Local Agent role. Its physical provider may be XMU or a remote API. |
| `filter` | The Decision model predicts a Tool whitelist. The Proxy selects only matching schemas from the original `tools[]`, then the Cloud Agent produces the Final response. |
| `router` | Historical G4-R0. The Decision model predicts `NO_ARGS`, `SIMPLE_ARGS`, or `COMPLEX_ARGS` independently for each request. Only the first two select Local. |
| `router-r1` | A finite `RouteClass` allows exactly one empty-argument, read-only observation Tool to Local. A contract violation falls back to Cloud before execution. |
| `router-r2` | Extends R1 with one `android_ui_query` bound to a fresh same-Cell `dumpId`. Invalid state, missing dependency, or contract failure falls back to Cloud. |
| `router-rm` | Moderate eight-class Router. Observation, grounded query, grounded tap, and bounded web retrieval may select Local; shell, persistence, verification, and recovery remain Cloud. |
| `router-rm-scoped` | Keeps the eight RouteClasses and post-prediction artifact guard, but the Local Agent receives SC-v1 Scoped Context. Only observation, grounded query, and grounded tap are Local in this arm. |
| `router-fsm-scoped` | Adds pre-prediction FSM admissibility and a deterministic transition/handoff check after an accepted Local Tool Result. |
| `router-fsm-scoped-repair` | Adds Standard Moderate Repair to FSM + Scoped Context. A repaired call must pass the complete schema and finite-state validators again. |
| `router-fsm-scoped-repair-cloud-first` | Experimental Cloud-first variant for the first UI mutation. |
| `router-fsm-scoped-repair-c1` / `router-fsm-scoped-repair-c2` | Historical Route-Flex exposure variants used only by their frozen configurations. |
| `router-binary-tool` | DSV4 predicts `LOCAL_UI_CANDIDATE` or `CLOUD_REQUIRED`; the Local Agent generates one exact Tool and the Proxy derives and validates its RouteClass. |
| `router-binary-tool-effect-aware` | Binary Tool variant with argument-aware UI-effect state maintenance. |
| `router-binary-tool-effect-aware-strong-path-check` | Effect-aware variant with one bounded Cloud Strong-Path checkpoint. |
| `router-explicit-binary-tool` | Uses no model Router. A deterministic FSM × Exact-Tool policy selects Cloud or one exact Local Tool. |
| `experiment` | Formal OpenClaw entry point. The only valid process strategies are exported by `EXPERIMENT_STRATEGIES` in `src/config.js`. |

The process strategy selected for `experiment` must match
`EXPERIMENT_STRATEGIES` exactly. Historical arm and group identifiers are not
rewritten. R1 and R2 make a fresh decision per request; they do not maintain
mutable state across Cells. State is reconstructed deterministically from
messages belonging to the current `result.run_id`.

All formal Cells use `clawmobile-router/experiment`. One Proxy process selects
exactly one strategy through `CLAW_ROUTER_ACTIVE_STRATEGY`. That variable does
not override an explicitly requested diagnostic virtual model. The Proxy
refuses to start `experiment` when the strategy is missing or outside the
exported allowlist.

## Decision helper protocol

The historical Filter and Router helper use the same complete request context,
`temperature=0`, a dynamic JSON Schema, and at most two strict attempts. The
helper input contains:

- `<complete_request_context_json>`: the complete original request except
  `tools`;
- `<available_tools_json>`: the unchanged original `tools[]`;
- `tool_count`: the number of available Tool definitions.

The historical argument-class response must contain only:

```json
{"k":3,"tools":["android_ui_dump","android_tap","android_screenshot"],"args_class":"SIMPLE_ARGS"}
```

`k` must equal `tools.length`; every name must come from the original Tool
Schema. `args_class` is one of:

- `NO_ARGS`: the normalized next Tool arguments are `{}`;
- `SIMPLE_ARGS`: required arguments are available or deterministically
  derivable from the current context without new device state;
- `COMPLEX_ARGS`: the action needs a state-dependent handle, selector,
  coordinate, free-form command, compound operation, or batch operation.

If no Tool is available or `tool_choice` is `none`, the Proxy records a
helper bypass and uses Cloud Full.

### Finite RouteClass protocol

The current eight RouteClasses classify the next immediate responsibility:

| RouteClass | Meaning | FSM/Scoped backend |
|---|---|---|
| `OBSERVE_UI_RAW` | One raw screenshot or UI dump. | Local candidate |
| `QUERY_UI_GROUNDED` | One `android_ui_query` bound to the latest fresh same-Cell dump. | Local only in `GROUND` |
| `INTERACT_UI_GROUNDED` | One exact tap at the fresh selected enabled/clickable center. | Local only in `READY` |
| `RETRIEVE_WEB_BOUNDED` | One bounded web search. | Cloud in current Scoped/FSM arms |
| `PERSIST_OR_SYSTEM_MUTATION` | File, setting, contact, calendar, or other persistent mutation. | Cloud |
| `OPEN_EXEC_OR_COMPOSITE` | Shell, exec, browser action, open command, or compound operation. | Cloud |
| `VERIFY_COMPLETE_RECOVER` | Verification, completion, recovery, or interpretation. | Cloud |
| `NO_TOOL_OR_AMBIGUOUS` | Missing dependency, unclear next action, or no unique class. | Cloud |

The helper returns strict JSON containing `route_class` and `reason_code`.
Static code owns final authorization. Invalid JSON, an unknown class, an
unsatisfied dependency, a Local provider error, or a Tool/schema violation
falls back to Cloud with the original complete request before Tool execution.

## Scoped Context and FSM

SC-v1 changes only the Local Agent request:

1. It replaces the global system affordance with a finite capability contract.
2. It exposes only the exact Tool schemas allowed for the selected class.
3. It preserves the complete dynamic user, assistant, Tool Call, and Tool
   Result history.
4. It leaves the Router input and Cloud fallback request unchanged.

The FSM is a deterministic projection rebuilt from visible messages in the
current Cell. Its phases are:

| Phase | Meaning |
|---|---|
| `PRECHECK` | No resolved Tool Result exists. |
| `OBSERVE` | Prior work exists but no fresh grounding artifact is ready. |
| `GROUND` | A successful fresh UI dump exists at the current state version. |
| `READY` | A successful query selected an enabled, clickable center. |
| `VERIFY_PENDING` | A UI mutation or unknown UI effect invalidated older artifacts and requires re-observation. |

For `router-fsm-scoped`, the Proxy:

1. reconstructs the phase and fresh artifacts before every request and writes
   the admissible RouteClass set into the helper's strict JSON Schema;
2. records an expected transition keyed by `result.run_id + tool_call_id`
   after accepting a Local Tool Call;
3. requires the next request to contain the matching typed Tool Result and
   expected target phase.

A missing, failed, mismatched, or untyped Result consumes the expectation and
forces the next request to Cloud. Pending transitions never cross
`result.run_id`. Restarting the unique Proxy during a formal Cell is therefore
an infrastructure failure rather than a silent recovery.

## Standard Moderate Repair

Repair runs only after one Local candidate fails validation and only when there
is exactly one Tool Call. It may:

- normalize approved argument aliases;
- losslessly coerce bounded boolean or integer values;
- flatten one unambiguous single-query wrapper;
- remove optional observation arguments when the frozen contract requires
  `{}`;
- bind a query to the unique fresh dump;
- compile tap coordinates from the unique fresh enabled/clickable center.

Repair cannot change the RouteClass, Tool name, number of Tool Calls, or
semantic target. Wrong Tools, ambiguous selectors, stale artifacts, shell/exec,
and multi-call responses remain invalid. Every repaired call must pass the full
base schema validator and finite RouteClass/FSM validator before execution.

## Control invariants

The Proxy stores the immutable original request first. A Filter Final may differ
only in the physical model and Tool subset. A Router Final may differ only in
the selected physical model/provider. Decision prompts and responses are never
inserted into the Agent transcript.

A Local Router candidate is buffered as non-streaming JSON and checked against
the OpenAI Tool Call contract. If it is invalid, unavailable, or times out, the
Proxy sends the unchanged request to Cloud. When the client requested
streaming, a validated Local JSON response is converted into standard
Server-Sent Events (SSE).

`parameter_schema_subset_v1` validates:

- one unique non-empty Tool Call ID;
- an allowed function name;
- JSON-object arguments;
- the frozen JSON Schema subset used by the observed Tool corpus, including
  types, required fields, enums, constants, object properties, additional
  properties, `anyOf`, pattern properties, and array/string/numeric bounds.

Unknown schema keywords or any argument violation fail closed to Cloud. This
name does not claim complete JSON Schema support. The historical corpus audit
can be rerun with:

```bash
node scripts/audit-parameter-schema-corpus.mjs <formal-corpus-root>
```

`local-full` does not use the Router adapter. It preserves inbound `stream`
and `stream_options`, relays the upstream response directly, and does not
create a derived `local_agent_downstream` record.

## Durable capture

When `CLAW_ROUTER_CAPTURE_PATH` is set, the Proxy appends every inbound
request, helper attempt, Cloud/Local Final call, fallback, and synthesized
Local JSON-to-SSE response to one JSON Lines file. Records include:

- complete inbound and physical provider requests;
- physical model/provider and logical call role;
- HTTP status and redacted headers;
- raw response text/Base64, byte count, and SHA-256;
- parsed JSON or SSE plus ordered chunk timing;
- request IDs, route, attempt index, total latency, header latency, and first
  response-body-chunk latency;
- hashes of request, messages, Tools, and generation parameters.

`ttft_ms` is a historical alias for response-header latency and is not a true
first-token measurement.

## Sessions, roles, and concurrency

| Field | Scope | Meaning |
|---|---|---|
| `session_id` | Cell | Authoritative logical Cell session. |
| `session_source` | Cell | Source of the session identity, normally `clawbench-run-marker`. |
| `turn_id` / `proxy_request_id` | Agent turn | Joins a helper and its subsequent Agent request. |
| `service_request_id` | Physical request | Unique ID for every helper attempt, Agent call, Local call, or fallback. |
| `attempt_index` | Role within a turn | Contiguous index beginning at one. |
| `service_role` | Physical request | `filter`, `router`, `agent`, or `local-agent`. |
| `call_role` | Physical request | Internal role such as `filter_helper`, `router_helper`, or `cloud_agent`. |
| `upstream_session_id` | Role within a Cell | Role-isolated session marker sent to the physical provider. |

Formal `experiment` requests accept exactly one lowercase
`run:<32-hex-characters>` marker, or one valid explicit
`X-ClawMobile-Session-ID`/`X-Session-ID` header when no run marker exists.
Duplicate, malformed, uppercase, multiple, or conflicting identities return
HTTP 400 before any provider call. `CLAW_ROUTER_SESSION_ID` is never a formal
fallback.

FreeInference receives:

- `X-Session-ID: cm-<session_id>-filter|router|agent|local-agent`;
- `X-Request-ID: cm-<service_role>-<uuid>`.

These headers provide correlation and role isolation; they do not replace
`messages`, create stateful conversation, or prove physical cache isolation.

Two independent FIFO semaphores are fixed at capacity one:

- `freeinference-global` covers every FreeInference helper, Cloud Agent,
  logical-local Agent, and retry;
- `xmu-8080` covers every physical XMU request and retry.

The semaphores may operate independently, but each resource has at most one
in-flight request. A lease is released only after the raw JSON/SSE clone is
fully consumed and its capture is durably flushed. Transport errors, aborted
streams, and client aborts release the lease in `finally`.

Every JSONL record is appended, `fsync`ed, and closed before
`capture.pending` is decremented. Formal evidence requires
`capture.pending=0`, `capture.errors=0`, matching queued/durable counters,
and a copy-only archive whose byte counts and SHA-256 values agree.

Authorization, API keys, and cookies are never written to captures.

## Run and test

The phone-native controller starts the unique shared Proxy for formal
experiments. Do not manually select a strategy for a v4 campaign:

```bash
cd ~/ClawMobile/clawmobile-router-test-kit
./phone/run.sh services start
./phone/run.sh doctor
```

Standalone Proxy development:

```bash
cd ~/ClawMobile/clawmobile-router-test-kit/clawmobile-router-proxy
npm test

CLAW_ROUTER_DECISION_MODEL=deepseek-v4-flash \
CLAW_ROUTER_CLOUD_MODEL=deepseek-v4-flash \
CLAW_ROUTER_ACTIVE_STRATEGY=filter \
CLAW_ROUTER_ARM_ID=dsv4-filter-dsv4-agent \
CLAW_ROUTER_CAPTURE_PATH="$HOME/clawmobile-experiments/model-calls.jsonl" \
npm start
```

Health and no-execution development Smoke:

```bash
curl -fsS http://127.0.0.1:18081/health
curl -fsS http://127.0.0.1:18081/v1/models
node scripts/smoke.js filter
node scripts/smoke.js router
node scripts/smoke.js cloud-full
node scripts/smoke.js local-full
node scripts/smoke.js experiment
```

OpenClaw registration:

```bash
openclaw config patch --file ./deploy/openclaw-router.patch.json5 --dry-run
openclaw config patch --file ./deploy/openclaw-router.patch.json5
openclaw config validate
```

## Configuration

Primary variables:

- `CLAW_ROUTER_DECISION_PROVIDER` / `CLAW_ROUTER_DECISION_MODEL`
- `CLAW_ROUTER_CLOUD_PROVIDER` / `CLAW_ROUTER_CLOUD_MODEL`
- `CLAW_ROUTER_LOCAL_PROVIDER` / `CLAW_ROUTER_LOCAL_MODEL`
- `CLAW_ROUTER_HOST` / `CLAW_ROUTER_PORT`
- `CLAW_ROUTER_LOG_PATH`
- `CLAW_ROUTER_CAPTURE_PATH`
- `CLAW_ROUTER_CAMPAIGN_ID`
- `CLAW_ROUTER_ACTIVE_STRATEGY`
- `CLAW_ROUTER_ARM_ID`
- `CLAW_ROUTER_STRATEGY_TIMEOUT_MS`
- `CLAW_ROUTER_ANSWER_TIMEOUT_MS`

`CLAW_ROUTER_CLIENT_TOKEN` is mandatory and must not equal any upstream API
key or credential-bearing header. Comparison uses the exact secret bytes
without trimming or adding a `Bearer` prefix. A formal token must contain at
least 32 UTF-8 bytes and at least 256 bits of entropy.

`CLAW_ROUTER_SESSION_ID` is prohibited as a session fallback and is ignored by
the Proxy.

`CLAW_ROUTER_ACTIVE_STRATEGY` must be one value exported by
`EXPERIMENT_STRATEGIES`. `CLAW_ROUTER_ARM_ID` is a 1-128 character capture
identifier containing letters, digits, dots, underscores, colons, or hyphens.

`GET /health` exposes the active strategy, arm ID, and per-provider
`configured`, `current`, `queued`, and `max_observed` concurrency
counters. It exposes provider/model identifiers but never API keys,
Authorization values, or cookies.

The provenance manifest records only secret presence and a fingerprint. A
fingerprint is SHA-256 over the exact UTF-8 secret bytes, without trimming,
case normalization, or a prefix. Credential URLs with userinfo, query, or
fragment are rejected. The formal FreeInference base URL is fixed to
`https://freeinference.org/v1`.

The Proxy listens on loopback by default. Non-loopback binding requires
`CLAW_ROUTER_ALLOW_NON_LOOPBACK=1`. Physical endpoints come only from the
OpenClaw provider configuration and cannot be supplied by clients.
