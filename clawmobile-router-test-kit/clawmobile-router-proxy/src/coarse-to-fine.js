import {
  FSM_STANDARD_LOCAL_ROUTE_CLASSES,
  allowedToolsForRouteClass,
  compileStandardModerateRepair,
  deriveRouteState,
  fsmAdmissibleRouteClasses,
  routeClassForLocalTool,
  validateFiniteRouteCompletion,
} from "./route-state.js";
import {
  applyToolWhitelist,
  BINARY_ROUTE_LABELS,
  BINARY_ROUTER_HELPER_SYSTEM,
  validateBinaryRouterDecision,
} from "./strategies.js";

export const COARSE_TO_FINE_POLICY_VERSION = "coarse-binary-ui-gate-v1";
export const COARSE_LOCAL_CONTEXT_VERSION = "coarse-local-tool-union-v1";
export const EXPLICIT_BINARY_TOOL_POLICY_VERSION =
  "explicit-fsm-exact-tool-capability-v1";

export { BINARY_ROUTE_LABELS, validateBinaryRouterDecision };

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolNames(request) {
  return (Array.isArray(request?.tools) ? request.tools : [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

function localCapability(request, routeState) {
  const available = new Set(toolNames(request));
  const admissible = fsmAdmissibleRouteClasses(routeState)
    .filter((routeClass) => FSM_STANDARD_LOCAL_ROUTE_CLASSES.includes(routeClass));
  const toolsByRouteClass = {};
  for (const routeClass of admissible) {
    const names = allowedToolsForRouteClass(routeClass, routeState)
      .filter((name) => available.has(name));
    if (names.length > 0) toolsByRouteClass[routeClass] = names;
  }
  const activeClasses = Object.keys(toolsByRouteClass);
  const localToolUnion = [...new Set(activeClasses.flatMap(
    (routeClass) => toolsByRouteClass[routeClass],
  ))];
  return Object.freeze({
    admissibleRouteClasses: Object.freeze(activeClasses),
    toolsByRouteClass: Object.freeze(Object.fromEntries(
      Object.entries(toolsByRouteClass).map(([routeClass, names]) => [
        routeClass,
        Object.freeze([...names]),
      ]),
    )),
    localToolUnion: Object.freeze(localToolUnion),
  });
}

function dynamicMessages(request) {
  return (Array.isArray(request?.messages) ? request.messages : [])
    .filter((message) => message?.role !== "system")
    .map((message) => JSON.parse(JSON.stringify(message)));
}

/**
 * Compile the binary Router input from information already present before the
 * Agent decision.  Static global Tool prose and full JSON Schemas are omitted,
 * while the complete non-system request history is preserved in this first
 * prototype so context compression is not a hidden experimental variable.
 */
export function compileBinaryRouterInput(request, routeState = deriveRouteState(request)) {
  const capability = localCapability(request, routeState);
  const decisionContext = {
    schema_version: 1,
    policy_version: COARSE_TO_FINE_POLICY_VERSION,
    route_state: routeState,
    admissible_local_route_classes: capability.admissibleRouteClasses,
    local_tool_union: capability.localToolUnion,
    pre_agent_dynamic_messages: dynamicMessages(request),
  };
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: "system", content: BINARY_ROUTER_HELPER_SYSTEM }),
      Object.freeze({
        role: "user",
        content: `<binary_route_context_json>${JSON.stringify(decisionContext)}</binary_route_context_json>`,
      }),
    ]),
    response_format: Object.freeze({
      type: "json_schema",
      json_schema: Object.freeze({
        name: "clawmobile_binary_route",
        strict: true,
        schema: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze(["route"]),
          properties: Object.freeze({
            route: Object.freeze({ type: "string", enum: BINARY_ROUTE_LABELS }),
          }),
        }),
      }),
    }),
    decision_context: Object.freeze(decisionContext),
  });
}

function localStateDependency(routeClass, routeState) {
  const common = {
    source_phase: routeState?.phase ?? null,
    state_version: routeState?.state_version ?? null,
    pending_reobserve: routeState?.pending_reobserve ?? null,
  };
  if (routeClass === "OBSERVE_UI_RAW") {
    return { ...common, required_arguments: {} };
  }
  if (routeClass === "QUERY_UI_GROUNDED") {
    return {
      ...common,
      latest_fresh_dump: {
        dump_id: routeState.latest_fresh_dump.dump_id,
        state_version: routeState.latest_fresh_dump.state_version,
      },
      argument_contract: "copy dumpId exactly and generate exactly one finite selector",
    };
  }
  if (routeClass === "INTERACT_UI_GROUNDED") {
    return {
      ...common,
      latest_fresh_query: {
        dump_id: routeState.latest_fresh_query.dump_id,
        state_version: routeState.latest_fresh_query.state_version,
        selected_center: routeState.latest_fresh_query.selected_center,
        selected_clickable: true,
        selected_enabled: true,
      },
      argument_contract: "copy the selected center exactly as x and y",
    };
  }
  throw new Error("Unsupported Local RouteClass");
}

/**
 * Compile the Local Agent request after the coarse gate selects Local.  The
 * Local model sees every currently admissible UI Tool schema and chooses one
 * exact Tool Call.  It does not need to emit a separate RouteClass label.
 */
export function compileCoarseLocalRequest(request, routeState = deriveRouteState(request)) {
  if (!plainObject(request) || !Array.isArray(request.messages)) {
    throw new Error("Coarse Local compiler requires a request with messages");
  }
  const capability = localCapability(request, routeState);
  if (capability.localToolUnion.length === 0) {
    throw new Error("No FSM-admissible Local Tool is available");
  }
  const systemIndexes = request.messages
    .map((message, index) => (message?.role === "system" ? index : -1))
    .filter((index) => index >= 0);
  if (systemIndexes.length !== 1) {
    throw new Error("Coarse Local compiler requires exactly one system message");
  }

  let localRequest = applyToolWhitelist(request, capability.localToolUnion);
  const contract = {
    schema_version: 1,
    context_version: COARSE_LOCAL_CONTEXT_VERSION,
    admissible_route_classes: capability.admissibleRouteClasses,
    allowed_exact_tools: capability.localToolUnion,
    tools_by_route_class: capability.toolsByRouteClass,
    state_dependencies: Object.fromEntries(
      capability.admissibleRouteClasses.map((routeClass) => [
        routeClass,
        localStateDependency(routeClass, routeState),
      ]),
    ),
  };
  const localSystem = [
    "You are the ClawMobile finite Local UI Agent for exactly one immediate action.",
    "Return exactly one function Tool Call and no prose.",
    "Choose exactly one function from allowed_exact_tools and obey its supplied JSON Schema.",
    "The chosen Tool implicitly determines its RouteClass; do not output a separate RouteClass label.",
    "Copy state-dependent identifiers or coordinates exactly from finite_contract_json.",
    "Do not use shell/exec, persist data, interpret a future result, authoritatively verify or complete the Task, recover, or plan later actions.",
    `<finite_contract_json>${JSON.stringify(contract)}</finite_contract_json>`,
  ].join("\n");
  const systemIndex = systemIndexes[0];
  localRequest = {
    ...localRequest,
    parallel_tool_calls: false,
    messages: localRequest.messages.map((message, index) =>
      index === systemIndex
        ? { ...message, role: "system", content: localSystem }
        : message,
    ),
  };
  if (localRequest.tool_choice !== "required" && localRequest.tool_choice?.type !== "function") {
    localRequest.tool_choice = "required";
  }
  return Object.freeze({
    request: localRequest,
    capability,
    contract: Object.freeze(contract),
  });
}

function explicitLocalChoice(request, routeState) {
  const available = new Set(toolNames(request));
  if (routeState?.pending_reobserve === true) {
    return available.has("android_ui_dump")
      ? {
          routeClass: "OBSERVE_UI_RAW",
          exactToolName: "android_ui_dump",
          reason: "pending_reobserve_requires_canonical_ui_dump",
        }
      : { reason: "canonical_ui_dump_unavailable" };
  }
  if (
    routeState?.phase === "GROUND" &&
    typeof routeState?.latest_fresh_dump?.dump_id === "string"
  ) {
    return available.has("android_ui_query")
      ? {
          routeClass: "QUERY_UI_GROUNDED",
          exactToolName: "android_ui_query",
          reason: "ground_has_fresh_dump_query_candidate_requires_unique_selector",
        }
      : { reason: "grounded_query_tool_unavailable" };
  }
  if (
    routeState?.phase === "READY" &&
    routeState?.latest_fresh_query?.selected_clickable === true &&
    routeState?.latest_fresh_query?.selected_enabled === true &&
    Number.isInteger(routeState?.latest_fresh_query?.selected_center?.x) &&
    Number.isInteger(routeState?.latest_fresh_query?.selected_center?.y)
  ) {
    return available.has("android_tap")
      ? {
          routeClass: "INTERACT_UI_GROUNDED",
          exactToolName: "android_tap",
          reason: "ready_has_unique_fresh_clickable_enabled_center",
        }
      : { reason: "canonical_tap_tool_unavailable" };
  }
  return { reason: "no_explicit_local_capability_match" };
}

/**
 * Deterministically choose one exact Local Tool from the frozen FSM state.
 * Semantic ambiguity is never guessed here: query candidates still have to
 * supply exactly one selector and pass the unchanged finite Validator before
 * any Tool executes.
 */
export function deriveExplicitBinaryToolDecision(
  request,
  routeState = deriveRouteState(request),
  options = {},
) {
  const toolCount = Array.isArray(request?.tools) ? request.tools.length : 0;
  let hardReason = toolCount === 0
    ? "no_available_tools"
    : request?.tool_choice === "none"
      ? "tool_choice_none"
      : typeof options.forceCloudReason === "string" &&
          options.forceCloudReason.length > 0
        ? options.forceCloudReason
        : options.forceCloud === true
          ? "failed_fsm_transition"
        : null;
  const choice = hardReason === null
    ? explicitLocalChoice(request, routeState)
    : { reason: hardReason };
  const forcedName = request?.tool_choice?.type === "function"
    ? request.tool_choice?.function?.name
    : null;
  if (
    hardReason === null &&
    forcedName &&
    forcedName !== choice.exactToolName
  ) {
    hardReason = "forced_tool_outside_explicit_local_contract";
  }
  const selectedLocal = hardReason === null &&
    typeof choice.exactToolName === "string";
  return Object.freeze({
    policy_version: EXPLICIT_BINARY_TOOL_POLICY_VERSION,
    route: selectedLocal ? "LOCAL_EXACT_TOOL" : "CLOUD_REQUIRED",
    route_class: selectedLocal ? choice.routeClass : null,
    exact_tool_name: selectedLocal ? choice.exactToolName : null,
    reason: hardReason || choice.reason,
    route_state: routeState,
  });
}

/** Compile the frozen scoped Local context with exactly one visible Tool. */
export function compileExplicitLocalRequest(
  request,
  decision = deriveExplicitBinaryToolDecision(request),
) {
  if (!plainObject(request) || !Array.isArray(request.messages)) {
    throw new Error("Explicit Local compiler requires a request with messages");
  }
  if (
    decision?.route !== "LOCAL_EXACT_TOOL" ||
    typeof decision?.route_class !== "string" ||
    typeof decision?.exact_tool_name !== "string"
  ) {
    throw new Error("Explicit Local compiler requires a Local exact-Tool decision");
  }
  const systemIndexes = request.messages
    .map((message, index) => (message?.role === "system" ? index : -1))
    .filter((index) => index >= 0);
  if (systemIndexes.length !== 1) {
    throw new Error("Explicit Local compiler requires exactly one system message");
  }
  const available = new Set(toolNames(request));
  if (!available.has(decision.exact_tool_name)) {
    throw new Error("Explicit Local exact Tool is unavailable");
  }

  const routeState = decision.route_state;
  const contract = Object.freeze({
    schema_version: 1,
    context_version: COARSE_LOCAL_CONTEXT_VERSION,
    policy_version: EXPLICIT_BINARY_TOOL_POLICY_VERSION,
    route_class: decision.route_class,
    selected_exact_tool: decision.exact_tool_name,
    state_dependency: localStateDependency(decision.route_class, routeState),
  });
  let localRequest = applyToolWhitelist(request, [decision.exact_tool_name]);
  const localSystem = [
    "You are the ClawMobile finite Local UI Agent for exactly one immediate action.",
    `Return exactly one function Tool Call to ${decision.exact_tool_name} and no prose.`,
    "Obey the supplied JSON Schema and copy state-dependent identifiers or coordinates exactly from finite_contract_json.",
    "For android_ui_query, provide exactly one finite selector; never guess multiple or alternative semantic targets.",
    "Do not use shell/exec, persist data, interpret a future result, authoritatively verify or complete the Task, recover, or plan later actions.",
    `<finite_contract_json>${JSON.stringify(contract)}</finite_contract_json>`,
  ].join("\n");
  const systemIndex = systemIndexes[0];
  localRequest = {
    ...localRequest,
    parallel_tool_calls: false,
    tool_choice: {
      type: "function",
      function: { name: decision.exact_tool_name },
    },
    messages: localRequest.messages.map((message, index) =>
      index === systemIndex
        ? { ...message, role: "system", content: localSystem }
        : message,
    ),
  };
  return Object.freeze({
    request: localRequest,
    decision,
    contract,
    capability: Object.freeze({
      admissibleRouteClasses: Object.freeze([decision.route_class]),
      localToolUnion: Object.freeze([decision.exact_tool_name]),
    }),
  });
}

function completionToolName(completion) {
  const calls = completion?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) && calls.length === 1
    ? calls[0]?.function?.name ?? null
    : null;
}

function combinedValidation(base, finite, actualRouteClass, admissible) {
  if (!base.ok) return { ok: false, reason: base.reason };
  if (!actualRouteClass) return { ok: false, reason: "actual_tool_has_no_local_route_class" };
  if (!admissible) return { ok: false, reason: "actual_tool_route_class_not_fsm_admissible" };
  if (!finite?.ok) return { ok: false, reason: finite?.reason ?? "finite_validation_missing" };
  return { ok: true, reason: "local_candidate_valid" };
}

/** Validate, optionally repair, and fully revalidate a Local candidate. */
export function evaluateCoarseLocalCandidate({
  completion,
  localRequest,
  routeState,
  admissibleRouteClasses,
  baseValidator,
  repairEnabled = true,
}) {
  if (typeof baseValidator !== "function") {
    throw new Error("Coarse Local evaluation requires the base Tool validator");
  }
  const toolName = completionToolName(completion);
  const actualRouteClass = routeClassForLocalTool(toolName);
  const admissible = actualRouteClass !== null &&
    admissibleRouteClasses.includes(actualRouteClass);
  let candidate = completion;
  let base = baseValidator(candidate, localRequest);
  let finite = base.ok && admissible
    ? validateFiniteRouteCompletion(candidate, actualRouteClass, routeState)
    : null;
  let validation = combinedValidation(base, finite, actualRouteClass, admissible);
  let repair = null;

  if (!validation.ok && repairEnabled && admissible) {
    const proposal = compileStandardModerateRepair(
      candidate,
      actualRouteClass,
      routeState,
    );
    repair = {
      attempted: true,
      compiled: proposal.ok,
      reason: proposal.reason,
      transformations: proposal.transformations ?? [],
      original_candidate: proposal.original_tool_call ?? null,
      repaired_candidate: proposal.repaired_tool_call ?? null,
    };
    if (proposal.ok) {
      const repairedBase = baseValidator(proposal.completion, localRequest);
      const repairedFinite = repairedBase.ok
        ? validateFiniteRouteCompletion(
            proposal.completion,
            actualRouteClass,
            routeState,
          )
        : null;
      const repairedValidation = combinedValidation(
        repairedBase,
        repairedFinite,
        actualRouteClass,
        admissible,
      );
      repair.revalidation = {
        base_tool_schema: repairedBase,
        finite_route_and_fsm_dependency: repairedFinite,
      };
      if (repairedValidation.ok) {
        candidate = proposal.completion;
        base = repairedBase;
        finite = repairedFinite;
        validation = repairedValidation;
        repair.applied = true;
      } else {
        repair.applied = false;
        repair.revalidation_failure = repairedValidation.reason;
      }
    } else {
      repair.applied = false;
    }
  }

  return Object.freeze({
    ok: validation.ok,
    action: validation.ok ? "EXECUTE_LOCAL" : "FALLBACK_CLOUD",
    reason: validation.reason,
    completion: validation.ok ? candidate : null,
    tool_name: toolName,
    actual_route_class: actualRouteClass,
    base_validation: base,
    finite_validation: finite,
    repair,
  });
}

function hardCloudReason(request, capability) {
  if (!Array.isArray(request?.tools) || request.tools.length === 0) {
    return "no_available_tools";
  }
  if (request.tool_choice === "none") return "tool_choice_none";
  if (capability.localToolUnion.length === 0) {
    return "no_fsm_admissible_local_tool";
  }
  const forcedName = request.tool_choice?.type === "function"
    ? request.tool_choice?.function?.name
    : null;
  if (forcedName && !capability.localToolUnion.includes(forcedName)) {
    return "forced_tool_outside_local_contract";
  }
  return null;
}

/**
 * End-to-end, provider-agnostic workflow.  The injected callbacks can be live
 * providers or offline fixtures; this module itself performs no I/O.
 */
export async function runCoarseToFineWorkflow({
  request,
  binaryRouter,
  localAgent,
  cloudAgent,
  localValidator,
  repairEnabled = true,
}) {
  if (![binaryRouter, localAgent, cloudAgent, localValidator]
    .every((value) => typeof value === "function")) {
    throw new Error(
      "Coarse-to-fine workflow requires Router, Local, Cloud, and Validator callbacks",
    );
  }
  const routeState = deriveRouteState(request);
  const capability = localCapability(request, routeState);
  const hardReason = hardCloudReason(request, capability);
  const audit = {
    policy_version: COARSE_TO_FINE_POLICY_VERSION,
    route_state: routeState,
    admissible_local_route_classes: capability.admissibleRouteClasses,
    local_tool_union: capability.localToolUnion,
    router_invoked: false,
    local_invoked: false,
    cloud_invoked: false,
  };

  async function useCloud(reason, localEvaluation = null) {
    audit.cloud_invoked = true;
    audit.final_backend = "cloud";
    audit.final_reason = reason;
    if (localEvaluation) audit.local_evaluation = localEvaluation;
    const completion = await cloudAgent(request);
    return Object.freeze({ completion, audit: Object.freeze(audit) });
  }

  if (hardReason) return useCloud(`hard_guard:${hardReason}`);

  const routerInput = compileBinaryRouterInput(request, routeState);
  audit.router_invoked = true;
  audit.router_input = routerInput;
  let decision;
  try {
    decision = validateBinaryRouterDecision(await binaryRouter(routerInput));
  } catch (error) {
    audit.router_error = error instanceof Error ? error.message : String(error);
    return useCloud("binary_router_invalid_or_failed");
  }
  audit.binary_route = decision.route;
  if (decision.route === "CLOUD_REQUIRED") {
    return useCloud("binary_router_selected_cloud");
  }

  let compiledLocal;
  try {
    compiledLocal = compileCoarseLocalRequest(request, routeState);
  } catch (error) {
    audit.local_compile_error = error instanceof Error ? error.message : String(error);
    return useCloud("local_context_compile_failed");
  }
  audit.local_invoked = true;
  audit.local_request = compiledLocal.request;
  let localCompletion;
  try {
    localCompletion = await localAgent(compiledLocal.request);
  } catch (error) {
    audit.local_error = error instanceof Error ? error.message : String(error);
    return useCloud("local_provider_failed");
  }
  const evaluated = evaluateCoarseLocalCandidate({
    completion: localCompletion,
    localRequest: compiledLocal.request,
    routeState,
    admissibleRouteClasses: compiledLocal.capability.admissibleRouteClasses,
    baseValidator: localValidator,
    repairEnabled,
  });
  audit.local_evaluation = evaluated;
  if (!evaluated.ok) {
    return useCloud(`local_candidate_rejected:${evaluated.reason}`, evaluated);
  }
  audit.final_backend = "local";
  audit.final_reason = evaluated.repair?.applied
    ? "local_candidate_repaired_and_validated"
    : "local_candidate_validated";
  return Object.freeze({
    completion: evaluated.completion,
    audit: Object.freeze(audit),
  });
}

/** Provider-agnostic deterministic-policy workflow used by focused tests. */
export async function runExplicitBinaryToolWorkflow({
  request,
  localAgent,
  cloudAgent,
  localValidator,
  repairEnabled = true,
}) {
  if (![localAgent, cloudAgent, localValidator]
    .every((value) => typeof value === "function")) {
    throw new Error(
      "Explicit binary Tool workflow requires Local, Cloud, and Validator callbacks",
    );
  }
  const routeState = deriveRouteState(request);
  const decision = deriveExplicitBinaryToolDecision(request, routeState);
  const audit = {
    policy_version: EXPLICIT_BINARY_TOOL_POLICY_VERSION,
    route_state: routeState,
    deterministic_policy_invoked: true,
    router_invoked: false,
    decision,
    local_invoked: false,
    cloud_invoked: false,
  };

  async function useCloud(reason, localEvaluation = null) {
    audit.cloud_invoked = true;
    audit.final_backend = "cloud";
    audit.final_reason = reason;
    if (localEvaluation) audit.local_evaluation = localEvaluation;
    const completion = await cloudAgent(request);
    return Object.freeze({ completion, audit: Object.freeze(audit) });
  }

  if (decision.route !== "LOCAL_EXACT_TOOL") {
    return useCloud(`explicit_policy:${decision.reason}`);
  }
  let compiledLocal;
  try {
    compiledLocal = compileExplicitLocalRequest(request, decision);
  } catch (error) {
    audit.local_compile_error = error instanceof Error ? error.message : String(error);
    return useCloud("local_context_compile_failed");
  }
  audit.local_invoked = true;
  audit.local_request = compiledLocal.request;
  let localCompletion;
  try {
    localCompletion = await localAgent(compiledLocal.request);
  } catch (error) {
    audit.local_error = error instanceof Error ? error.message : String(error);
    return useCloud("local_provider_failed");
  }
  const evaluated = evaluateCoarseLocalCandidate({
    completion: localCompletion,
    localRequest: compiledLocal.request,
    routeState,
    admissibleRouteClasses: [decision.route_class],
    baseValidator: localValidator,
    repairEnabled,
  });
  audit.local_evaluation = evaluated;
  if (!evaluated.ok) {
    return useCloud(`local_candidate_rejected:${evaluated.reason}`, evaluated);
  }
  audit.final_backend = "local";
  audit.final_reason = evaluated.repair?.applied
    ? "local_candidate_repaired_and_validated"
    : "local_candidate_validated";
  return Object.freeze({
    completion: evaluated.completion,
    audit: Object.freeze(audit),
  });
}
