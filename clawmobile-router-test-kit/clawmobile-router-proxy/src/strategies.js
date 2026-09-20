import { fetchCompletion, readCompletionJson } from "./upstream.js";

// Frozen experiment contract: one initial helper call plus one retry.  Keep the
// retry loop and its shared timeout partition tied to this single constant.
export const DECISION_HELPER_MAX_ATTEMPTS = 2;

const PREDICTED_ARGS_CLASSES = new Set([
  "NO_ARGS",
  "SIMPLE_ARGS",
  "COMPLEX_ARGS",
]);

export const NEXT_TOOL_HELPER_SYSTEM = `You are the ClawMobile next-tool decision helper.
Do not execute a tool and do not generate tool arguments.
Using the complete request context and available tool definitions, predict the tool names that could validly serve the NEXT agent step and classify the expected arguments. tool_count is the number of tool definitions inside <available_tools_json>.
Return exactly one JSON object:
{"k":<integer>,"tools":["tool_name",...],"args_class":"<one of NO_ARGS, SIMPLE_ARGS, COMPLEX_ARGS>"}
Rules:
1. tools is an ordered list from most to least likely, contains no duplicates, and contains only names from the available tool definitions.
2. Tool names must match the definitions exactly.
3. k must equal the length of tools and may be any integer from 1 to tool_count. Choose enough tools to avoid excluding a plausible next action. Use all tools if needed.
4. Use NO_ARGS if the expected next tool call has normalized arguments {}.
5. Use SIMPLE_ARGS if all critical arguments are non-empty and can be copied or deterministically derived from the current request context without fresh UI or device state and without an open-ended command.
6. Use COMPLEX_ARGS otherwise, including state-dependent handles, selectors, coordinates, free-form shell or exec commands, and compound or batch operations.
7. Predict the next agent step, not every tool that may be used for the whole task.
8. Return no explanation, no Markdown, and no extra keys.`;

const ROUTE_REASON_CODES = Object.freeze([
  "FINITE_EVIDENCE_ACQUISITION",
  "FRESH_DUMP_GROUNDED_QUERY",
  "FRESH_QUERY_GROUNDED_INTERACTION",
  "BOUNDED_WEB_RETRIEVAL",
  "NO_AVAILABLE_TOOLS",
  "MUTATION_OR_PERSISTENCE",
  "OPEN_EXEC_OR_COMPOSITE",
  "AUTHORITATIVE_VERIFY_OR_COMPLETE",
  "RECOVERY_OR_AMBIGUOUS",
  "DEPENDENCY_MISSING_OR_STALE",
  "OUTSIDE_FINITE_CONTRACT",
]);

export const BINARY_ROUTE_LABELS = Object.freeze([
  "LOCAL_UI_CANDIDATE",
  "CLOUD_REQUIRED",
]);

const ROUTE_CLASS_HELPER_COMMON = `You are the ClawMobile finite RouteClass decision helper.
Classify only the NEXT Agent responsibility from the complete pre-Agent request context. Do not execute a tool, generate tool arguments, or predict a future verifier outcome.
The static Proxy, not you, owns final Local authorization. When uncertain, return CLOUD.
Return exactly one JSON object with no Markdown or extra keys:
{"route_class":"<allowed class>","reason_code":"<allowed reason>"}`;

export const ROUTER_R1_HELPER_SYSTEM = `${ROUTE_CLASS_HELPER_COMMON}
Allowed route_class values: EVIDENCE_LOCAL, CLOUD.
EVIDENCE_LOCAL is valid only when the next responsibility can be completed by exactly one empty-argument call to android_screenshot, adb_screenshot, android_ui_dump, or adb_ui_dump_xml. It may acquire evidence only; it must not interpret the evidence, modify state, persist data, authoritatively verify a task, recover, or complete the task.
All other responsibilities are CLOUD.`;

export const ROUTER_R2_HELPER_SYSTEM = `${ROUTE_CLASS_HELPER_COMMON}
Allowed route_class values: EVIDENCE_LOCAL, GROUNDED_QUERY_LOCAL, CLOUD.
EVIDENCE_LOCAL has the same exact one-call empty-argument evidence contract as R1.
GROUNDED_QUERY_LOCAL is valid only when the next responsibility is exactly one read-only android_ui_query whose dumpId is the current request's latest fresh same-cell dump dependency. It must not tap, type, mutate, persist, authoritatively verify, recover, or complete.
All other responsibilities are CLOUD.`;

export const ROUTER_RM_HELPER_SYSTEM = `You are the ClawMobile finite RouteClass decision helper for the Moderate Action-Class Router.
Classify only the NEXT Agent output from the complete pre-Agent request context and deterministic route-state projection. Do not execute a tool, generate tool arguments, or predict a future verifier outcome.
Return exactly one JSON object with no Markdown or extra keys:
{"route_class":"<allowed class>","reason_code":"<allowed reason>"}

Allowed route_class values and their exact immediate-action meanings:
1. OBSERVE_UI_RAW: exactly one empty-argument call to android_screenshot, adb_screenshot, android_ui_dump, or adb_ui_dump_xml.
2. QUERY_UI_GROUNDED: exactly one android_ui_query bound to latest_fresh_dump.dump_id with exactly one finite selector.
3. INTERACT_UI_GROUNDED: exactly one android_tap or adb_tap at the exact selected_center from latest_fresh_query, which must be fresh, clickable, and enabled.
4. RETRIEVE_WEB_BOUNDED: exactly one web_search with a non-empty bounded query and only its finite schema fields.
5. PERSIST_OR_SYSTEM_MUTATION: file, contact, calendar, settings, or other persistent/system mutation.
6. OPEN_EXEC_OR_COMPOSITE: android_shell, adb_shell, exec, browser action, an open-ended command, or a multi-Tool/compound next step.
7. VERIFY_COMPLETE_RECOVER: interpretation for authoritative verification, completion, recovery, or error repair rather than one of the four finite Local candidates above.
8. NO_TOOL_OR_AMBIGUOUS: no Tool should be called next, the next action is unclear, a required dependency is absent/stale, or no class is uniquely supported.

Classify the immediate next Tool action, not the whole task and not the later interpretation of its Tool Result. A screenshot/dump used to collect evidence for later Cloud verification is OBSERVE_UI_RAW. android_shell, adb_shell, and exec are always OPEN_EXEC_OR_COMPOSITE even when their command text appears short or read-only. Use INTERACT_UI_GROUNDED only when the deterministic projection contains the exact fresh selected center. When uncertain use NO_TOOL_OR_AMBIGUOUS.`;

export const BINARY_ROUTER_HELPER_SYSTEM = `You are the ClawMobile binary Local/Cloud routing helper.
Classify only the NEXT immediate Agent action, not the whole Task.
Return LOCAL_UI_CANDIDATE only when that next action should be exactly one Tool Call from local_tool_union and every required dependency is present in route_state.
Return CLOUD_REQUIRED for every non-UI action, persistence or system mutation, shell or exec, verification, completion, recovery, missing dependency, ambiguity, or uncertainty.
Do not generate a Tool Call, RouteClass, arguments, explanation, or extra keys.
Return exactly one JSON object: {"route":"LOCAL_UI_CANDIDATE"} or {"route":"CLOUD_REQUIRED"}.`;

function completionText(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
    if (text.trim().length > 0) return text;
  }
  throw new Error("Next-tool helper returned no text content");
}

function availableToolNames(request) {
  if (!Array.isArray(request.tools)) return [];
  const names = request.tools.map((tool) => tool?.function?.name);
  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error("Every available tool definition must have a non-empty function name");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Available tool definition names must be unique");
  }
  return names;
}

function helperInput(request) {
  const { tools: availableTools = [], ...completeRequestContext } = request;
  return `<complete_request_context_json>\n${JSON.stringify(completeRequestContext)}\n</complete_request_context_json>\n<available_tools_json>\n${JSON.stringify(availableTools)}\n</available_tools_json>\ntool_count=${availableTools.length}`;
}

function routeClassHelperInput(request, routeState, admissibleRouteClasses = null) {
  const { tools: availableTools = [], ...completeRequestContext } = request;
  const admissible = admissibleRouteClasses
    ? `\n<fsm_admissible_route_classes_json>\n${JSON.stringify(admissibleRouteClasses)}\n</fsm_admissible_route_classes_json>`
    : "";
  return `<complete_request_context_json>\n${JSON.stringify(completeRequestContext)}\n</complete_request_context_json>\n<available_tools_json>\n${JSON.stringify(availableTools)}\n</available_tools_json>\n<deterministic_route_state_projection_json>\n${JSON.stringify(routeState)}\n</deterministic_route_state_projection_json>${admissible}`;
}

function routeClasses(strategy) {
  if (strategy === "router-r1") return ["EVIDENCE_LOCAL", "CLOUD"];
  if (strategy === "router-r2") {
    return ["EVIDENCE_LOCAL", "GROUNDED_QUERY_LOCAL", "CLOUD"];
  }
  if (
    strategy === "router-rm" ||
    strategy === "router-rm-scoped" ||
    strategy === "router-fsm-scoped" ||
    strategy === "router-fsm-scoped-repair" ||
    strategy === "router-fsm-scoped-repair-cloud-first" ||
    strategy === "router-fsm-scoped-repair-c1" ||
    strategy === "router-fsm-scoped-repair-c2"
  ) {
    return [
      "OBSERVE_UI_RAW",
      "QUERY_UI_GROUNDED",
      "INTERACT_UI_GROUNDED",
      "RETRIEVE_WEB_BOUNDED",
      "PERSIST_OR_SYSTEM_MUTATION",
      "OPEN_EXEC_OR_COMPOSITE",
      "VERIFY_COMPLETE_RECOVER",
      "NO_TOOL_OR_AMBIGUOUS",
    ];
  }
  throw new Error("Finite RouteClass strategy is not approved");
}

function constrainedRouteClasses(strategy, admissibleRouteClasses = null) {
  const base = routeClasses(strategy);
  if (admissibleRouteClasses === null) return base;
  if (
    !Array.isArray(admissibleRouteClasses) ||
    admissibleRouteClasses.length === 0 ||
    new Set(admissibleRouteClasses).size !== admissibleRouteClasses.length ||
    admissibleRouteClasses.some((routeClass) => !base.includes(routeClass))
  ) {
    throw new Error("FSM admissible RouteClasses must be a non-empty unique subset");
  }
  return [...admissibleRouteClasses];
}

export function routeClassResponseFormat(strategy, admissibleRouteClasses = null) {
  const allowedRouteClasses = constrainedRouteClasses(
    strategy,
    admissibleRouteClasses,
  );
  return {
    type: "json_schema",
    json_schema: {
      name: "clawmobile_finite_route_class",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["route_class", "reason_code"],
        properties: {
          route_class: { type: "string", enum: allowedRouteClasses },
          reason_code: { type: "string", enum: [...ROUTE_REASON_CODES] },
        },
      },
    },
  };
}

export function validateRouteClassPrediction(
  output,
  strategy,
  admissibleRouteClasses = null,
) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("RouteClass helper output must be a JSON object");
  }
  const keys = Object.keys(output).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "reason_code" ||
    keys[1] !== "route_class"
  ) {
    throw new Error("RouteClass helper output must contain only route_class and reason_code");
  }
  if (!constrainedRouteClasses(strategy, admissibleRouteClasses).includes(output.route_class)) {
    throw new Error("RouteClass helper route_class is invalid");
  }
  if (!ROUTE_REASON_CODES.includes(output.reason_code)) {
    throw new Error("RouteClass helper reason_code is invalid");
  }
  return Object.freeze({
    route_class: output.route_class,
    reason_code: output.reason_code,
  });
}

function parseExactJsonObject(text) {
  let output;
  try {
    output = JSON.parse(text.trim());
  } catch {
    throw new Error("Next-tool helper must return exactly one valid JSON object");
  }
  return output;
}

export function binaryRouteResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "clawmobile_binary_route",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["route"],
        properties: {
          route: { type: "string", enum: [...BINARY_ROUTE_LABELS] },
        },
      },
    },
  };
}

export function validateBinaryRouterDecision(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Binary Router output must be a JSON object");
  }
  const keys = Object.keys(output);
  if (keys.length !== 1 || keys[0] !== "route") {
    throw new Error("Binary Router output must contain only route");
  }
  if (!BINARY_ROUTE_LABELS.includes(output.route)) {
    throw new Error("Binary Router route is invalid");
  }
  return Object.freeze({ route: output.route });
}

function attemptTelemetry(provider, startedAt, completion) {
  return Object.freeze({
    helper_provider_id: provider.id,
    helper_model: provider.model,
    helper_latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(completion ? helperUsage(completion) : {}),
  });
}

function helperAttemptError(stage, cause, telemetry) {
  const error = new Error(`Next-tool helper ${stage}`, { cause });
  error.name = typeof cause?.name === "string" ? cause.name : "NextToolHelperError";
  if (typeof cause?.code === "string") error.code = cause.code;
  error.helperFailureStage = stage;
  error.helperTelemetry = telemetry;
  return error;
}

function transportFailureStage(error, signal) {
  if (signal?.aborted) return "aborted";
  if (error?.name === "TimeoutError") return "timeout";
  return "upstream_error";
}

export function nextToolResponseFormat(availableNames) {
  if (
    !Array.isArray(availableNames) ||
    availableNames.length === 0 ||
    !availableNames.every((name) => typeof name === "string" && name.length > 0) ||
    new Set(availableNames).size !== availableNames.length
  ) {
    throw new Error("JSON Schema requires a non-empty unique tool-name list");
  }
  return {
    type: "json_schema",
    json_schema: {
      name: "clawmobile_next_tool_prediction",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["k", "tools", "args_class"],
        properties: {
          k: {
            type: "integer",
            minimum: 1,
            maximum: availableNames.length,
          },
          tools: {
            type: "array",
            minItems: 1,
            maxItems: availableNames.length,
            uniqueItems: true,
            items: { type: "string", enum: [...availableNames] },
          },
          args_class: {
            type: "string",
            enum: ["NO_ARGS", "SIMPLE_ARGS", "COMPLEX_ARGS"],
          },
        },
      },
    },
  };
}

export function validateNextToolPrediction(output, request) {
  const names = availableToolNames(request);
  const keys = Object.keys(output).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "args_class" ||
    keys[1] !== "k" ||
    keys[2] !== "tools"
  ) {
    throw new Error("Next-tool helper output must contain only k, tools, and args_class");
  }
  if (!Number.isSafeInteger(output.k)) {
    throw new Error("Next-tool helper k must be an integer");
  }
  if (!Array.isArray(output.tools) || !output.tools.every((name) => typeof name === "string")) {
    throw new Error("Next-tool helper tools must be an array of tool names");
  }
  if (output.k !== output.tools.length) {
    throw new Error("Next-tool helper k must equal tools.length");
  }
  if (output.k < 1 || output.k > names.length) {
    throw new Error("Next-tool helper k must be between 1 and tool_count");
  }
  if (new Set(output.tools).size !== output.tools.length) {
    throw new Error("Next-tool helper tools must not contain duplicates");
  }
  const available = new Set(names);
  if (output.tools.some((name) => !available.has(name))) {
    throw new Error("Next-tool helper returned an unknown tool name");
  }
  if (!PREDICTED_ARGS_CLASSES.has(output.args_class)) {
    throw new Error("Next-tool helper args_class is invalid");
  }
  return Object.freeze({
    k: output.k,
    tools: Object.freeze([...output.tools]),
    args_class: output.args_class,
  });
}

function helperUsage(completion) {
  const usage = completion?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const result = {};
  for (const [source, target] of [
    ["prompt_tokens", "helper_prompt_tokens"],
    ["completion_tokens", "helper_completion_tokens"],
    ["total_tokens", "helper_total_tokens"],
  ]) {
    if (Number.isSafeInteger(usage[source]) && usage[source] >= 0) {
      result[target] = usage[source];
    }
  }
  return result;
}

export function helperMaxTokens(toolCount) {
  if (!Number.isSafeInteger(toolCount) || toolCount < 0) {
    throw new Error("tool_count must be a non-negative integer");
  }
  return Math.min(4096, Math.max(512, 128 + toolCount * 48));
}

export async function getNextToolPrediction(request, provider, fetchImpl, options = {}) {
  const names = availableToolNames(request);
  if (names.length === 0) return null;
  const {
    constrainOutput = false,
    disableThinking = false,
    ...fetchOptions
  } = options;
  const startedAt = performance.now();
  let response;
  try {
    response = await fetchCompletion(
      provider,
      {
        stream: false,
        temperature: 0,
        max_tokens: helperMaxTokens(names.length),
        ...(disableThinking
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
        ...(constrainOutput
          ? { response_format: nextToolResponseFormat(names) }
          : {}),
        messages: [
          { role: "system", content: NEXT_TOOL_HELPER_SYSTEM },
          { role: "user", content: helperInput(request) },
        ],
      },
      fetchImpl,
      fetchOptions,
    );
  } catch (error) {
    throw helperAttemptError(
      transportFailureStage(error, fetchOptions.signal),
      error,
      attemptTelemetry(provider, startedAt),
    );
  }

  let completion;
  try {
    completion = await readCompletionJson(response);
  } catch (error) {
    throw helperAttemptError(
      "upstream_error",
      error,
      attemptTelemetry(provider, startedAt),
    );
  }

  const telemetry = attemptTelemetry(provider, startedAt, completion);
  let text;
  try {
    text = completionText(completion);
  } catch (error) {
    throw helperAttemptError("no_content", error, telemetry);
  }

  let output;
  try {
    output = parseExactJsonObject(text);
  } catch (error) {
    throw helperAttemptError("invalid_json", error, telemetry);
  }

  let prediction;
  try {
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      throw new Error("Next-tool helper output must be a JSON object");
    }
    prediction = validateNextToolPrediction(output, request);
  } catch (error) {
    throw helperAttemptError("invalid_contract", error, telemetry);
  }

  return Object.freeze({
    prediction,
    telemetry,
  });
}

async function getRouteClassPrediction(
  request,
  routeState,
  strategy,
  provider,
  fetchImpl,
  options = {},
) {
  const names = availableToolNames(request);
  if (names.length === 0) return null;
  const {
    admissibleRouteClasses = null,
    ...fetchOptions
  } = options;
  const startedAt = performance.now();
  let response;
  try {
    response = await fetchCompletion(
      provider,
      {
        stream: false,
        temperature: 0,
        max_tokens: 512,
        response_format: routeClassResponseFormat(strategy, admissibleRouteClasses),
        messages: [
          {
            role: "system",
            content:
              strategy === "router-r1"
                ? ROUTER_R1_HELPER_SYSTEM
                : strategy === "router-r2"
                  ? ROUTER_R2_HELPER_SYSTEM
                  : ROUTER_RM_HELPER_SYSTEM,
          },
          {
            role: "user",
            content: routeClassHelperInput(
              request,
              routeState,
              admissibleRouteClasses,
            ),
          },
        ],
      },
      fetchImpl,
      fetchOptions,
    );
  } catch (error) {
    throw helperAttemptError(
      transportFailureStage(error, fetchOptions.signal),
      error,
      attemptTelemetry(provider, startedAt),
    );
  }

  let completion;
  try {
    completion = await readCompletionJson(response);
  } catch (error) {
    throw helperAttemptError(
      "upstream_error",
      error,
      attemptTelemetry(provider, startedAt),
    );
  }
  const telemetry = attemptTelemetry(provider, startedAt, completion);
  try {
    const output = parseExactJsonObject(completionText(completion));
    return Object.freeze({
      prediction: validateRouteClassPrediction(
        output,
        strategy,
        admissibleRouteClasses,
      ),
      telemetry,
    });
  } catch (error) {
    throw helperAttemptError(
      error?.message?.includes("valid JSON") ? "invalid_json" : "invalid_contract",
      error,
      telemetry,
    );
  }
}

async function getBinaryRoutePrediction(
  routerInput,
  provider,
  fetchImpl,
  options = {},
) {
  if (
    !routerInput ||
    !Array.isArray(routerInput.messages) ||
    routerInput.messages.length !== 2
  ) {
    throw new Error("Binary Router input must contain its frozen two-message prompt");
  }
  const startedAt = performance.now();
  let response;
  try {
    response = await fetchCompletion(
      provider,
      {
        stream: false,
        temperature: 0,
        max_tokens: 128,
        response_format: binaryRouteResponseFormat(),
        messages: routerInput.messages,
      },
      fetchImpl,
      options,
    );
  } catch (error) {
    throw helperAttemptError(
      transportFailureStage(error, options.signal),
      error,
      attemptTelemetry(provider, startedAt),
    );
  }

  let completion;
  try {
    completion = await readCompletionJson(response);
  } catch (error) {
    throw helperAttemptError(
      "upstream_error",
      error,
      attemptTelemetry(provider, startedAt),
    );
  }
  const telemetry = attemptTelemetry(provider, startedAt, completion);
  try {
    const output = parseExactJsonObject(completionText(completion));
    return Object.freeze({
      prediction: validateBinaryRouterDecision(output),
      telemetry,
    });
  } catch (error) {
    throw helperAttemptError(
      error?.message?.includes("valid JSON") ? "invalid_json" : "invalid_contract",
      error,
      telemetry,
    );
  }
}

export async function getBinaryRoutePredictionWithRetry(
  routerInput,
  provider,
  fetchImpl,
  options = {},
) {
  const {
    signal,
    timeoutMs = 60_000,
    captureStore,
    captureMetadata = {},
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Binary Router timeout must be positive");
  }
  const deadline = performance.now() + timeoutMs;
  const perAttemptTimeoutMs = Math.max(
    1,
    Math.floor(timeoutMs / DECISION_HELPER_MAX_ATTEMPTS),
  );
  const total = { helper_latency_ms: 0 };
  const failureStages = [];
  let attempts = 0;
  let lastError;

  for (let index = 0; index < DECISION_HELPER_MAX_ATTEMPTS; index += 1) {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) break;
    attempts += 1;
    try {
      const result = await getBinaryRoutePrediction(
        routerInput,
        provider,
        fetchImpl,
        {
          signal,
          timeoutMs: Math.max(1, Math.min(perAttemptTimeoutMs, remainingMs)),
          captureStore,
          captureMetadata: { ...captureMetadata, attempt_index: attempts },
        },
      );
      addAttemptTelemetry(total, result.telemetry);
      return Object.freeze({
        prediction: result.prediction,
        telemetry: routedHelperTelemetry(
          provider,
          attempts,
          failureStages,
          total,
        ),
      });
    } catch (error) {
      lastError = error;
      addAttemptTelemetry(total, error?.helperTelemetry);
      failureStages.push(error?.helperFailureStage || "unknown_error");
      if (signal?.aborted) break;
    }
  }

  const error = new Error("Binary Router helper failed", { cause: lastError });
  error.name = typeof lastError?.name === "string"
    ? lastError.name
    : "BinaryRouterHelperError";
  if (typeof lastError?.code === "string") error.code = lastError.code;
  error.helperTelemetry = routedHelperTelemetry(
    provider,
    attempts,
    failureStages,
    total,
  );
  throw error;
}

export async function getRouteClassPredictionWithRetry(
  request,
  routeState,
  strategy,
  provider,
  fetchImpl,
  options = {},
) {
  const names = availableToolNames(request);
  if (names.length === 0) return null;
  const {
    signal,
    timeoutMs = 60_000,
    captureStore,
    captureMetadata = {},
    admissibleRouteClasses = null,
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("RouteClass helper timeout must be positive");
  }
  const deadline = performance.now() + timeoutMs;
  const perAttemptTimeoutMs = Math.max(
    1,
    Math.floor(timeoutMs / DECISION_HELPER_MAX_ATTEMPTS),
  );
  const total = { helper_latency_ms: 0 };
  const failureStages = [];
  let attempts = 0;
  let lastError;

  for (let index = 0; index < DECISION_HELPER_MAX_ATTEMPTS; index += 1) {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) break;
    attempts += 1;
    try {
      const result = await getRouteClassPrediction(
        request,
        routeState,
        strategy,
        provider,
        fetchImpl,
        {
          signal,
          timeoutMs: Math.max(1, Math.min(perAttemptTimeoutMs, remainingMs)),
          captureStore,
          captureMetadata: { ...captureMetadata, attempt_index: attempts },
          admissibleRouteClasses,
        },
      );
      addAttemptTelemetry(total, result.telemetry);
      return Object.freeze({
        prediction: result.prediction,
        telemetry: routedHelperTelemetry(
          provider,
          attempts,
          failureStages,
          total,
        ),
      });
    } catch (error) {
      lastError = error;
      addAttemptTelemetry(total, error?.helperTelemetry);
      failureStages.push(error?.helperFailureStage || "unknown_error");
      if (signal?.aborted) break;
    }
  }

  const error = new Error("RouteClass helper failed", { cause: lastError });
  error.name = typeof lastError?.name === "string" ? lastError.name : "RouteClassHelperError";
  if (typeof lastError?.code === "string") error.code = lastError.code;
  error.helperTelemetry = routedHelperTelemetry(
    provider,
    attempts,
    failureStages,
    total,
  );
  throw error;
}

function addAttemptTelemetry(total, telemetry) {
  if (!telemetry) return;
  total.helper_latency_ms += telemetry.helper_latency_ms || 0;
  for (const key of [
    "helper_prompt_tokens",
    "helper_completion_tokens",
    "helper_total_tokens",
  ]) {
    if (Number.isSafeInteger(telemetry[key]) && telemetry[key] >= 0) {
      total[key] = (total[key] || 0) + telemetry[key];
    }
  }
}

function routedHelperTelemetry(provider, attempts, failureStages, total) {
  return Object.freeze({
    helper_provider_id: provider.id,
    helper_model: provider.model,
    helper_attempts: attempts,
    helper_latency_ms: total.helper_latency_ms,
    ...Object.fromEntries(
      [
        "helper_prompt_tokens",
        "helper_completion_tokens",
        "helper_total_tokens",
      ]
        .filter((key) => Number.isSafeInteger(total[key]))
        .map((key) => [key, total[key]]),
    ),
    helper_failure_stages: Object.freeze([...failureStages]),
  });
}

export async function getDecisionPredictionWithRetry(
  request,
  provider,
  fetchImpl,
  options = {},
) {
  const names = availableToolNames(request);
  if (names.length === 0) return null;
  const {
    signal,
    timeoutMs = 60_000,
    constrainOutput = true,
    disableThinking = false,
    captureStore,
    captureMetadata = {},
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Decision helper timeout must be positive");
  }

  const deadline = performance.now() + timeoutMs;
  const perAttemptTimeoutMs = Math.max(
    1,
    Math.floor(timeoutMs / DECISION_HELPER_MAX_ATTEMPTS),
  );
  const total = { helper_latency_ms: 0 };
  const failureStages = [];
  let attempts = 0;
  let lastError;

  for (let index = 0; index < DECISION_HELPER_MAX_ATTEMPTS; index += 1) {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) break;
    attempts += 1;
    try {
      const result = await getNextToolPrediction(request, provider, fetchImpl, {
        signal,
        timeoutMs: Math.max(1, Math.min(perAttemptTimeoutMs, remainingMs)),
        constrainOutput,
        disableThinking,
        captureStore,
        captureMetadata: {
          ...captureMetadata,
          attempt_index: attempts,
        },
      });
      addAttemptTelemetry(total, result.telemetry);
      return Object.freeze({
        prediction: result.prediction,
        telemetry: routedHelperTelemetry(
          provider,
          attempts,
          failureStages,
          total,
        ),
      });
    } catch (error) {
      lastError = error;
      addAttemptTelemetry(total, error?.helperTelemetry);
      failureStages.push(error?.helperFailureStage || "unknown_error");
      if (signal?.aborted) break;
    }
  }

  const error = new Error("Decision helper failed", { cause: lastError });
  error.name = typeof lastError?.name === "string" ? lastError.name : "NextToolHelperError";
  if (typeof lastError?.code === "string") error.code = lastError.code;
  error.helperTelemetry = routedHelperTelemetry(
    provider,
    attempts,
    failureStages,
    total,
  );
  throw error;
}

export function applyToolWhitelist(request, selectedTools) {
  const selected = new Set(selectedTools);
  const tools = Array.isArray(request.tools)
    ? request.tools.filter((tool) => selected.has(tool?.function?.name))
    : [];
  const next = { ...request, tools };
  const forcedName =
    next.tool_choice?.type === "function"
      ? next.tool_choice?.function?.name
      : null;
  if (forcedName && !selected.has(forcedName)) {
    throw new Error("Tool filter removed the explicitly required function");
  }
  if (next.tool_choice === "required" && tools.length === 0) {
    throw new Error("Tool filter removed every tool while tool_choice is required");
  }
  if (tools.length === 0) {
    delete next.tools;
    if (next.tool_choice !== "none") delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

export const SCOPED_LOCAL_CONTEXT_VERSION = "scoped-local-static-affordance-v1";

const SCOPED_LOCAL_ROUTE_CLASSES = new Set([
  "OBSERVE_UI_RAW",
  "QUERY_UI_GROUNDED",
  "INTERACT_UI_GROUNDED",
  "RETRIEVE_WEB_BOUNDED",
]);

function scopedStateDependency(routeClass, routeState) {
  const common = {
    source_phase: routeState?.phase ?? null,
    state_version: routeState?.state_version ?? null,
    pending_reobserve: routeState?.pending_reobserve ?? null,
  };
  if (routeClass === "QUERY_UI_GROUNDED") {
    const dumpId = routeState?.latest_fresh_dump?.dump_id;
    if (typeof dumpId !== "string" || routeState?.pending_reobserve !== false) {
      throw new Error("Scoped query context requires a fresh dump dependency");
    }
    return {
      ...common,
      latest_fresh_dump: {
        dump_id: dumpId,
        state_version: routeState.latest_fresh_dump.state_version ?? null,
      },
    };
  }
  if (routeClass === "INTERACT_UI_GROUNDED") {
    const query = routeState?.latest_fresh_query;
    const center = query?.selected_center;
    if (
      routeState?.pending_reobserve !== false ||
      query?.selected_clickable !== true ||
      query?.selected_enabled !== true ||
      !Number.isInteger(center?.x) ||
      !Number.isInteger(center?.y)
    ) {
      throw new Error("Scoped interaction context requires a fresh selected center");
    }
    return {
      ...common,
      latest_fresh_query: {
        dump_id: query.dump_id ?? null,
        state_version: query.state_version ?? null,
        selected_center: { x: center.x, y: center.y },
        selected_clickable: true,
        selected_enabled: true,
      },
    };
  }
  return common;
}

/**
 * Replace only the global static system affordance for a Local candidate.
 * Dynamic user/assistant/tool history remains byte-for-byte equivalent after
 * JSON serialization, while the already-whitelisted Tool schema is preserved.
 */
export function compileScopedLocalRequest(
  request,
  {
    routeClass,
    routeState,
    allowedTools,
    admissibleRouteClasses = null,
    toolsByRouteClass = null,
  },
) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Scoped Local compiler requires a request object");
  }
  if (!SCOPED_LOCAL_ROUTE_CLASSES.has(routeClass)) {
    throw new Error("Scoped Local compiler requires one finite RM Local RouteClass");
  }
  if (
    !Array.isArray(allowedTools) ||
    allowedTools.length === 0 ||
    allowedTools.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(allowedTools).size !== allowedTools.length
  ) {
    throw new Error("Scoped Local compiler requires non-empty unique allowed Tools");
  }
  if (!Array.isArray(request.messages)) {
    throw new Error("Scoped Local compiler requires a messages array");
  }
  const systemIndexes = request.messages
    .map((message, index) => (message?.role === "system" ? index : -1))
    .filter((index) => index >= 0);
  if (systemIndexes.length !== 1) {
    throw new Error("Scoped Local compiler requires exactly one system message");
  }
  const requestToolNames = (Array.isArray(request.tools) ? request.tools : [])
    .map((tool) => tool?.function?.name);
  const requestToolSet = new Set(requestToolNames);
  const allowedToolSet = new Set(allowedTools);
  if (
    requestToolNames.length !== allowedTools.length ||
    requestToolSet.size !== requestToolNames.length ||
    requestToolNames.some((name) => !allowedToolSet.has(name))
  ) {
    throw new Error("Scoped Local Tool schema must exactly match the allowed Tool list");
  }

  let finiteContract;
  if (admissibleRouteClasses === null) {
    finiteContract = {
      schema_version: 1,
      context_version: SCOPED_LOCAL_CONTEXT_VERSION,
      route_class: routeClass,
      allowed_exact_tools: [...requestToolNames],
      state_dependency: scopedStateDependency(routeClass, routeState),
    };
  } else {
    if (
      !Array.isArray(admissibleRouteClasses) ||
      admissibleRouteClasses.length === 0 ||
      new Set(admissibleRouteClasses).size !== admissibleRouteClasses.length ||
      admissibleRouteClasses.some((value) => !SCOPED_LOCAL_ROUTE_CLASSES.has(value)) ||
      !admissibleRouteClasses.includes(routeClass) ||
      !toolsByRouteClass ||
      typeof toolsByRouteClass !== "object" ||
      Array.isArray(toolsByRouteClass)
    ) {
      throw new Error("Scoped Local union context requires exact admissible RouteClasses");
    }
    const normalizedToolMap = {};
    const union = new Set();
    const stateDependencies = {};
    for (const candidateClass of admissibleRouteClasses) {
      const names = toolsByRouteClass[candidateClass];
      if (
        !Array.isArray(names) ||
        names.length === 0 ||
        new Set(names).size !== names.length ||
        names.some((name) => typeof name !== "string" || !allowedToolSet.has(name))
      ) {
        throw new Error("Scoped Local union Tool map is invalid");
      }
      normalizedToolMap[candidateClass] = [...names];
      for (const name of names) union.add(name);
      stateDependencies[candidateClass] = scopedStateDependency(
        candidateClass,
        routeState,
      );
    }
    if (
      union.size !== allowedToolSet.size ||
      [...union].some((name) => !allowedToolSet.has(name))
    ) {
      throw new Error("Scoped Local union Tool map differs from the visible Tool set");
    }
    finiteContract = {
      schema_version: 1,
      context_version: SCOPED_LOCAL_CONTEXT_VERSION,
      predicted_route_class: routeClass,
      admissible_route_classes: [...admissibleRouteClasses],
      allowed_exact_tools: [...requestToolNames],
      tools_by_route_class: normalizedToolMap,
      state_dependencies: stateDependencies,
    };
  }
  const systemContent = [
    "You are the ClawMobile finite Local Agent for exactly one immediate action.",
    "Return exactly one function Tool Call and no prose.",
    "Use exactly one function from allowed_exact_tools and obey its provided JSON Schema.",
    "Do not interpret a future Tool Result, verify or complete the Task, recover, or plan a later action.",
    "Copy every required state-dependent identifier or coordinate exactly from finite_contract_json.",
    `<finite_contract_json>${JSON.stringify(finiteContract)}</finite_contract_json>`,
  ].join("\n");
  const systemIndex = systemIndexes[0];
  const messages = request.messages.map((message, index) =>
    index === systemIndex
      ? { ...message, role: "system", content: systemContent }
      : message,
  );
  return { ...request, messages };
}
