export const ROUTER_R1_POLICY_VERSION = "g4-r1-evidence-v1";
export const ROUTER_R2_POLICY_VERSION = "g4-r2-grounded-query-v1";
export const ROUTER_RM_POLICY_VERSION = "g4-rm-moderate-action-v1";
export const ROUTER_RM_SCOPED_POLICY_VERSION = "g4-rm-scoped-context-v1";
export const ROUTER_FSM_SCOPED_POLICY_VERSION = "g4-fsm-scoped-context-v1";
export const ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION =
  "g4-fsm-scoped-context-standard-moderate-repair-v1";
export const UI_EFFECT_AWARE_POLICY_VERSION = "g4-binary-ui-effect-aware-v1";

export const R1_EVIDENCE_TOOLS = Object.freeze([
  "android_screenshot",
  "adb_screenshot",
  "android_ui_dump",
  "adb_ui_dump_xml",
]);

export const R2_GROUNDED_QUERY_TOOLS = Object.freeze(["android_ui_query"]);

export const RM_LOCAL_ROUTE_CLASSES = Object.freeze([
  "OBSERVE_UI_RAW",
  "QUERY_UI_GROUNDED",
  "INTERACT_UI_GROUNDED",
  "RETRIEVE_WEB_BOUNDED",
]);

export const FSM_STANDARD_LOCAL_ROUTE_CLASSES = Object.freeze([
  "OBSERVE_UI_RAW",
  "QUERY_UI_GROUNDED",
  "INTERACT_UI_GROUNDED",
]);

export const FSM_STANDARD_CLOUD_ROUTE_CLASSES = Object.freeze([
  "RETRIEVE_WEB_BOUNDED",
  "PERSIST_OR_SYSTEM_MUTATION",
  "OPEN_EXEC_OR_COMPOSITE",
  "VERIFY_COMPLETE_RECOVER",
  "NO_TOOL_OR_AMBIGUOUS",
]);

export const RM_OBSERVE_TOOLS = R1_EVIDENCE_TOOLS;
export const RM_QUERY_TOOLS = R2_GROUNDED_QUERY_TOOLS;
export const RM_INTERACTION_TOOLS = Object.freeze(["android_tap", "adb_tap"]);
export const RM_RETRIEVAL_TOOLS = Object.freeze(["web_search"]);

const DUMP_TOOLS = new Set(["android_ui_dump", "adb_ui_dump_xml"]);
const READ_ONLY_TOOLS = new Set([
  "android_health",
  "adb_health",
  "android_screenshot",
  "adb_screenshot",
  "android_ui_dump",
  "adb_ui_dump_xml",
  "android_ui_query",
  "web_search",
  "read",
]);
const EFFECT_AWARE_UI_NEUTRAL_READ_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  "web_fetch",
  "android_ocr_dump",
  "memory_search",
]);
const EFFECT_AWARE_NON_UI_STEP_TOOLS = new Set([
  "write",
  "android_signal_complete",
]);
const SHELL_LIKE_TOOLS = new Set(["android_shell", "adb_shell", "exec"]);
const DIRECT_UI_MUTATION_TOOLS = new Set([
  "android_tap",
  "adb_tap",
  "android_type",
  "adb_type",
  "android_swipe",
  "adb_swipe",
  "android_keyevent",
  "adb_keyevent",
]);
const UI_SHELL_PATTERN = /(?:^|[;&|]\s*)(?:input\s+(?:tap|swipe|text|keyevent)|am\s+(?:start|start-activity|force-stop)|monkey\b|cmd\s+(?:statusbar|window)\b)/iu;
const UI_NEUTRAL_SHELL_PATTERN = /(?:^|[;&|]\s*)(?:getprop\b|dumpsys\b|pm\s+(?:list|path)\b|settings\s+get\b|content\s+query\b|ls\b|cat\b|stat\b|find\b|pwd\b|readlink\b|test\b|md5sum\b|sha256sum\b|wc\b)/iu;
const NON_UI_FILE_SHELL_PATTERN = /(?:^|[;&|]\s*)(?:mkdir\b|cp\b|mv\b|printf\b|echo\b)|(?:^|[^>])>{1,2}\s*\/[^\s]+/iu;

const GROUNDED_QUERY_SELECTOR_KEYS = new Set([
  "name",
  "nodeId",
  "text",
  "contentDesc",
  "resourceId",
  "className",
]);
const GROUNDED_QUERY_ALLOWED_KEYS = new Set([
  "dumpId",
  ...GROUNDED_QUERY_SELECTOR_KEYS,
  "clickable",
  "enabled",
  "exact",
  "ignoreCase",
  "matchPickStrategy",
  "detail",
  "maxMatches",
]);
const GROUNDED_INTERACTION_KEYS = new Set(["x", "y"]);
const CANONICAL_OBSERVE_ARGUMENTS = Object.freeze({
  android_ui_dump: new Set(["compressed", "rawXml"]),
  adb_ui_dump_xml: new Set(["compressed"]),
});
const QUERY_ARGUMENT_ALIASES = Object.freeze({
  dump_id: "dumpId",
  node_id: "nodeId",
  content_desc: "contentDesc",
  resource_id: "resourceId",
  class_name: "className",
  ignore_case: "ignoreCase",
  match_pick_strategy: "matchPickStrategy",
  max_matches: "maxMatches",
});
const QUERY_BOOLEAN_ARGUMENTS = new Set([
  "clickable",
  "enabled",
  "exact",
  "ignoreCase",
]);
const QUERY_INTEGER_ARGUMENTS = new Set(["nodeId", "maxMatches"]);
const BOUNDED_WEB_KEYS = new Set([
  "query",
  "count",
  "country",
  "language",
  "freshness",
  "date_after",
  "date_before",
  "search_lang",
  "ui_lang",
  "domain_filter",
  "max_tokens",
  "max_tokens_per_page",
]);
const BOUNDED_FRESHNESS = new Set(["day", "week", "month", "year"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text) {
  if (plainObject(text)) return text;
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return plainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function shellCommand(call) {
  if (!SHELL_LIKE_TOOLS.has(call?.name)) return null;
  const value = call?.arguments?.command ?? call?.arguments?.cmd;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Experimental UI-effect projection.  It is deliberately conservative:
 * only high-confidence web/read/file cases observed in preserved traces are
 * allowed to preserve UI evidence.  Unknown shell/exec remains legacy
 * fail-closed and invalidates the UI artifact.
 */
export function classifyUiEffect(call, policy = "legacy") {
  if (policy !== UI_EFFECT_AWARE_POLICY_VERSION) {
    return READ_ONLY_TOOLS.has(call?.name)
      ? "UI_NEUTRAL_READ"
      : "UI_OR_UNKNOWN_EFFECT";
  }
  if (EFFECT_AWARE_UI_NEUTRAL_READ_TOOLS.has(call?.name)) {
    return "UI_NEUTRAL_READ";
  }
  if (EFFECT_AWARE_NON_UI_STEP_TOOLS.has(call?.name)) {
    return "NON_UI_STEP";
  }
  if (DIRECT_UI_MUTATION_TOOLS.has(call?.name)) return "UI_MUTATION";
  const command = shellCommand(call);
  if (command !== null) {
    if (UI_SHELL_PATTERN.test(command)) return "UI_MUTATION";
    if (UI_NEUTRAL_SHELL_PATTERN.test(command)) return "UI_NEUTRAL_READ";
    if (NON_UI_FILE_SHELL_PATTERN.test(command)) return "NON_UI_STEP";
  }
  return "UNKNOWN_EFFECT";
}

function toolCallsFrom(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.filter(
    (call) =>
      typeof call?.id === "string" &&
      call.id.length > 0 &&
      typeof call?.function?.name === "string",
  );
}

function successfulResult(value) {
  return plainObject(value) && value.ok === true;
}

function resultStatus(value) {
  if (successfulResult(value)) return "success";
  if (plainObject(value) && value.ok === false) return "failure";
  return "untyped";
}

function projectedPhase(resolvedToolCount, pendingReobserve, lastResolvedTool) {
  if (resolvedToolCount === 0) return "PRECHECK";
  if (pendingReobserve) return "VERIFY_PENDING";
  if (DUMP_TOOLS.has(lastResolvedTool)) return "GROUND";
  if (lastResolvedTool === "android_ui_query") return "READY";
  return "OBSERVE";
}

function compactTransition(transition) {
  if (!transition) return null;
  return Object.freeze({ ...transition });
}

function normalizedTransitionToolCallId(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/^call_/u, "call");
}

function compactArtifact(artifact) {
  if (!artifact) return null;
  return Object.freeze({
    dump_id: artifact.dumpId,
    producer_tool: artifact.producerTool,
    producer_tool_call_id: artifact.producerToolCallId,
    producer_message_index: artifact.producerMessageIndex,
    state_version: artifact.stateVersion,
  });
}

/**
 * Rebuild a deterministic, read-only routing projection from the request's
 * already-visible message history.  No state is shared across requests and no
 * future Tool Call, Tool Result, or verifier outcome is inspected.
 */
export function deriveRouteState(request, options = {}) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const uiEffectPolicy = options.uiEffectPolicy === UI_EFFECT_AWARE_POLICY_VERSION
    ? UI_EFFECT_AWARE_POLICY_VERSION
    : "legacy";
  const pendingCalls = new Map();
  let stateVersion = 0;
  let latestDump = null;
  let latestQuery = null;
  let pendingReobserve = false;
  let lastResolvedTool = null;
  let resolvedToolCount = 0;
  let lastTransition = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    for (const call of toolCallsFrom(message)) {
      pendingCalls.set(call.id, {
        id: call.id,
        name: call.function.name,
        arguments: parseObject(call.function.arguments),
        messageIndex: index,
      });
    }
    if (message?.role !== "tool" || typeof message.tool_call_id !== "string") {
      continue;
    }
    const call = pendingCalls.get(message.tool_call_id);
    if (!call) continue;
    pendingCalls.delete(message.tool_call_id);
    const sourcePhase = projectedPhase(
      resolvedToolCount,
      pendingReobserve,
      lastResolvedTool,
    );
    resolvedToolCount += 1;
    const result = parseObject(message.content);
    const observedResultStatus = resultStatus(result);

    const uiEffect = classifyUiEffect(call, uiEffectPolicy);
    if (uiEffect === "UI_OR_UNKNOWN_EFFECT" || uiEffect === "UI_MUTATION" || uiEffect === "UNKNOWN_EFFECT") {
      lastResolvedTool = call.name;
      stateVersion += 1;
      latestDump = null;
      latestQuery = null;
      pendingReobserve = true;
      lastTransition = {
        source_phase: sourcePhase,
        target_phase: projectedPhase(
          resolvedToolCount,
          pendingReobserve,
          lastResolvedTool,
        ),
        tool_name: call.name,
        tool_call_id: call.id,
        result_status: observedResultStatus,
        contract_status: observedResultStatus === "success" ? "matched" : observedResultStatus,
        ui_effect: uiEffect,
      };
      continue;
    }

    if (DUMP_TOOLS.has(call.name)) {
      const dumpId = successfulResult(result) && typeof result.dump_id === "string"
        ? result.dump_id
        : null;
      if (dumpId) {
        lastResolvedTool = call.name;
        latestDump = {
          dumpId,
          producerTool: call.name,
          producerToolCallId: call.id,
          producerMessageIndex: index,
          stateVersion,
        };
        latestQuery = null;
        pendingReobserve = false;
      } else {
        // A failed or unparseable observation cannot refresh an older UI
        // dependency.  Fail closed instead of presenting stale evidence as
        // the current GROUND state.
        latestDump = null;
        latestQuery = null;
        lastResolvedTool = "__failed_read__";
      }
      lastTransition = {
        source_phase: sourcePhase,
        target_phase: projectedPhase(
          resolvedToolCount,
          pendingReobserve,
          lastResolvedTool,
        ),
        tool_name: call.name,
        tool_call_id: call.id,
        result_status: observedResultStatus,
        contract_status: dumpId ? "matched" : observedResultStatus,
        artifact_established: Boolean(dumpId),
        ui_effect: uiEffect,
      };
      continue;
    }

    if (call.name === "android_ui_query") {
      const dumpId = successfulResult(result) && typeof result.dump_id === "string"
        ? result.dump_id
        : call.arguments?.dumpId;
      if (latestDump && dumpId === latestDump.dumpId && successfulResult(result)) {
        lastResolvedTool = call.name;
        const selected = plainObject(result?.best?.selected)
          ? result.best.selected
          : plainObject(result?.results?.[0]?.selected)
            ? result.results[0].selected
            : null;
        const centerX = Number.isInteger(selected?.centerX) ? selected.centerX : null;
        const centerY = Number.isInteger(selected?.centerY) ? selected.centerY : null;
        latestQuery = {
          dumpId,
          producerToolCallId: call.id,
          producerMessageIndex: index,
          stateVersion,
          selectedCenter: centerX !== null && centerY !== null
            ? { x: centerX, y: centerY }
            : null,
          selectedClickable: selected?.clickable === true,
          selectedEnabled: selected?.enabled === true,
        };
      } else {
        // A later failed query supersedes any older selected target.  The
        // underlying dump remains usable only when it is still fresh.
        latestQuery = null;
        lastResolvedTool = latestDump?.producerTool || "__failed_read__";
      }
      lastTransition = {
        source_phase: sourcePhase,
        target_phase: projectedPhase(
          resolvedToolCount,
          pendingReobserve,
          lastResolvedTool,
        ),
        tool_name: call.name,
        tool_call_id: call.id,
        result_status: observedResultStatus,
        contract_status: latestQuery ? "matched" : observedResultStatus,
        artifact_established: Boolean(latestQuery),
        ui_effect: uiEffect,
      };
      continue;
    }

    if (uiEffect === "NON_UI_STEP") {
      // Preserve any still-valid UI artifact, but do not pretend the most
      // recent responsibility was an observation/query step.
      lastResolvedTool = "__non_ui_step__";
    } else if (uiEffectPolicy === "legacy" || (!latestDump && !latestQuery)) {
      lastResolvedTool = call.name;
    }
    lastTransition = {
      source_phase: sourcePhase,
      target_phase: projectedPhase(
        resolvedToolCount,
        pendingReobserve,
        lastResolvedTool,
      ),
      tool_name: call.name,
      tool_call_id: call.id,
      result_status: observedResultStatus,
      contract_status: observedResultStatus === "failure" ? "failure" : "not_applicable",
      ui_effect: uiEffect,
    };
  }

  const phase = projectedPhase(
    resolvedToolCount,
    pendingReobserve,
    lastResolvedTool,
  );

  return Object.freeze({
    schema_version: 1,
    semantics: "deterministic_projection_from_current_request_history_only",
    ui_effect_policy_version: uiEffectPolicy,
    request_ordinal: 1 + messages.filter((message) => message?.role === "assistant").length,
    resolved_tool_count: resolvedToolCount,
    phase,
    state_version: stateVersion,
    pending_reobserve: pendingReobserve,
    last_transition: compactTransition(lastTransition),
    latest_fresh_dump: compactArtifact(latestDump),
    latest_fresh_query: latestQuery
      ? Object.freeze({
          dump_id: latestQuery.dumpId,
          producer_tool_call_id: latestQuery.producerToolCallId,
          producer_message_index: latestQuery.producerMessageIndex,
          state_version: latestQuery.stateVersion,
          selected_center: latestQuery.selectedCenter,
          selected_clickable: latestQuery.selectedClickable,
          selected_enabled: latestQuery.selectedEnabled,
        })
      : null,
  });
}

export function fsmAdmissibleRouteClasses(routeState, options = {}) {
  const forceCloud = options.forceCloud === true;
  const allowed = new Set(FSM_STANDARD_CLOUD_ROUTE_CLASSES);
  if (!forceCloud) {
    allowed.add("OBSERVE_UI_RAW");
    if (
      routeState?.phase === "GROUND" &&
      routeState?.pending_reobserve === false &&
      typeof routeState?.latest_fresh_dump?.dump_id === "string"
    ) {
      allowed.add("QUERY_UI_GROUNDED");
    }
    if (
      routeState?.phase === "READY" &&
      routeState?.pending_reobserve === false &&
      routeState?.latest_fresh_query?.selected_clickable === true &&
      routeState?.latest_fresh_query?.selected_enabled === true &&
      Number.isInteger(routeState?.latest_fresh_query?.selected_center?.x) &&
      Number.isInteger(routeState?.latest_fresh_query?.selected_center?.y)
    ) {
      allowed.add("INTERACT_UI_GROUNDED");
    }
  }
  return Object.freeze([
    "OBSERVE_UI_RAW",
    "QUERY_UI_GROUNDED",
    "INTERACT_UI_GROUNDED",
    ...FSM_STANDARD_CLOUD_ROUTE_CLASSES,
  ].filter((routeClass) => allowed.has(routeClass)));
}

export function createFsmTransitionExpectation(
  routeClass,
  toolCall,
  sourceState,
) {
  const toolName = toolCall?.function?.name;
  const toolCallId = toolCall?.id;
  if (
    !FSM_STANDARD_LOCAL_ROUTE_CLASSES.includes(routeClass) ||
    typeof toolName !== "string" ||
    typeof toolCallId !== "string" ||
    toolCallId.length === 0
  ) {
    throw new Error("FSM transition expectation requires one standard Local Tool Call");
  }
  let expectedTargetPhase;
  let requiresTypedSuccess = false;
  if (routeClass === "QUERY_UI_GROUNDED") {
    expectedTargetPhase = "READY";
    requiresTypedSuccess = true;
  } else if (routeClass === "INTERACT_UI_GROUNDED") {
    expectedTargetPhase = "VERIFY_PENDING";
    requiresTypedSuccess = true;
  } else if (toolName === "android_ui_dump") {
    expectedTargetPhase = "GROUND";
    requiresTypedSuccess = true;
  } else if (toolName === "adb_ui_dump_xml") {
    expectedTargetPhase = sourceState?.pending_reobserve === true
      ? "VERIFY_PENDING"
      : "OBSERVE";
    requiresTypedSuccess = true;
  } else {
    expectedTargetPhase = sourceState?.pending_reobserve === true
      ? "VERIFY_PENDING"
      : "OBSERVE";
  }
  return Object.freeze({
    schema_version: 1,
    route_class: routeClass,
    tool_name: toolName,
    tool_call_id: toolCallId,
    tool_call_match_id: normalizedTransitionToolCallId(toolCallId),
    source_phase: sourceState?.phase ?? null,
    source_state_version: sourceState?.state_version ?? null,
    expected_target_phase: expectedTargetPhase,
    requires_typed_success: requiresTypedSuccess,
  });
}

export function validateFsmTransitionExpectation(expectation, targetState) {
  const transition = targetState?.last_transition;
  if (!expectation || !transition) {
    return { ok: false, reason: "fsm_transition_result_missing" };
  }
  if (
    normalizedTransitionToolCallId(transition.tool_call_id) !==
      expectation.tool_call_match_id ||
    transition.tool_name !== expectation.tool_name
  ) {
    return { ok: false, reason: "fsm_transition_tool_result_mismatch" };
  }
  if (
    expectation.requires_typed_success === true &&
    transition.contract_status !== "matched"
  ) {
    return { ok: false, reason: "fsm_transition_typed_success_required" };
  }
  if (transition.result_status === "failure") {
    return { ok: false, reason: "fsm_transition_tool_result_failed" };
  }
  if (targetState.phase !== expectation.expected_target_phase) {
    return { ok: false, reason: "fsm_transition_target_phase_mismatch" };
  }
  return { ok: true, reason: "fsm_transition_matched" };
}

function validBoundedWebArguments(args) {
  const keys = Object.keys(args);
  if (keys.some((key) => !BOUNDED_WEB_KEYS.has(key))) return false;
  if (typeof args.query !== "string" || args.query.trim().length === 0 || args.query.length > 512) {
    return false;
  }
  if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 10)) {
    return false;
  }
  for (const key of ["country", "language", "search_lang", "ui_lang"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].length > 32)) return false;
  }
  if (args.freshness !== undefined && !BOUNDED_FRESHNESS.has(args.freshness)) return false;
  for (const key of ["date_after", "date_before"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args[key]))) {
      return false;
    }
  }
  if (args.domain_filter !== undefined) {
    if (!Array.isArray(args.domain_filter) || args.domain_filter.length > 20) return false;
    if (args.domain_filter.some((value) => typeof value !== "string" || value.length === 0 || value.length > 253)) {
      return false;
    }
  }
  if (args.max_tokens !== undefined && (!Number.isInteger(args.max_tokens) || args.max_tokens < 1 || args.max_tokens > 1_000_000)) {
    return false;
  }
  if (args.max_tokens_per_page !== undefined && (!Number.isInteger(args.max_tokens_per_page) || args.max_tokens_per_page < 1 || args.max_tokens_per_page > 1_000_000)) {
    return false;
  }
  return true;
}

export function isLocalRouteClass(routeClass) {
  return routeClass === "EVIDENCE_LOCAL" ||
    routeClass === "GROUNDED_QUERY_LOCAL" ||
    RM_LOCAL_ROUTE_CLASSES.includes(routeClass);
}

export function routeClassForLocalTool(toolName) {
  if (RM_OBSERVE_TOOLS.includes(toolName)) return "OBSERVE_UI_RAW";
  if (RM_QUERY_TOOLS.includes(toolName)) return "QUERY_UI_GROUNDED";
  if (RM_INTERACTION_TOOLS.includes(toolName)) return "INTERACT_UI_GROUNDED";
  return null;
}

function completionToolCalls(completion) {
  const choices = completion?.choices;
  if (!Array.isArray(choices) || choices.length !== 1) return null;
  const calls = choices[0]?.message?.tool_calls;
  return Array.isArray(calls) ? calls : null;
}

/**
 * Compile one invalid Local candidate through the single Standard Moderate
 * Repair contract.  The compiler is deterministic: it never changes the
 * RouteClass, Tool name, Tool Call count, or semantic target.  It may only
 * canonicalize an equivalent schema representation and bind arguments to the
 * unique fresh FSM artifact already visible in this request.  The caller must
 * rerun the complete base Tool-schema and finite RouteClass validators before
 * the candidate may execute.
 */
export function compileStandardModerateRepair(
  completion,
  routeClass,
  routeState,
) {
  const calls = completionToolCalls(completion);
  if (!calls || calls.length !== 1) {
    return { ok: false, reason: "repair_requires_exactly_one_tool_call" };
  }
  const call = calls[0];
  const toolName = call?.function?.name;
  const args = parseObject(call?.function?.arguments);
  if (!args) {
    return { ok: false, reason: "repair_arguments_not_json_object" };
  }
  const repairedArgs = JSON.parse(JSON.stringify(args));
  const transformations = [];

  function fact(field, operation, basis, before, after) {
    transformations.push({
      field,
      operation,
      basis,
      before_present: before !== undefined,
      before_value: before ?? null,
      after_present: after !== undefined,
      after_value: after ?? null,
    });
  }

  function normalizeAlias(object, alias, canonical) {
    if (!Object.prototype.hasOwnProperty.call(object, alias)) return true;
    if (
      Object.prototype.hasOwnProperty.call(object, canonical) &&
      JSON.stringify(object[canonical]) !== JSON.stringify(object[alias])
    ) {
      return false;
    }
    const before = object[alias];
    object[canonical] = before;
    delete object[alias];
    fact(alias, "rename", `exact_schema_alias:${canonical}`, before, before);
    return true;
  }

  function normalizeBoolean(object, key) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) return;
    const before = object[key];
    if (before === "true" || before === "false") {
      object[key] = before === "true";
      fact(key, "coerce", "unique_lossless_boolean", before, object[key]);
    }
  }

  function normalizeInteger(object, key) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) return;
    const before = object[key];
    if (typeof before !== "string" || !/^(0|[1-9]\d*)$/u.test(before)) return;
    const number = Number(before);
    if (!Number.isSafeInteger(number) || String(number) !== before) return;
    object[key] = number;
    fact(key, "coerce", "unique_lossless_integer", before, number);
  }

  if (routeClass === "OBSERVE_UI_RAW") {
    const allowedKeys = CANONICAL_OBSERVE_ARGUMENTS[toolName];
    if (!allowedKeys) return { ok: false, reason: "repair_tool_not_supported" };
    const keys = Object.keys(repairedArgs);
    if (keys.length === 0 || keys.some((key) => !allowedKeys.has(key))) {
      return { ok: false, reason: "repair_arguments_outside_bounded_contract" };
    }
    for (const key of keys) {
      normalizeBoolean(repairedArgs, key);
      if (typeof repairedArgs[key] !== "boolean") {
        return { ok: false, reason: "repair_arguments_outside_bounded_contract" };
      }
      const before = repairedArgs[key];
      delete repairedArgs[key];
      fact(
        key,
        "remove",
        "frozen_observe_contract_uses_default_representation",
        before,
        undefined,
      );
    }
  } else if (routeClass === "QUERY_UI_GROUNDED") {
    if (toolName !== "android_ui_query") {
      return { ok: false, reason: "repair_tool_not_supported" };
    }
    for (const [alias, canonical] of Object.entries(QUERY_ARGUMENT_ALIASES)) {
      if (!normalizeAlias(repairedArgs, alias, canonical)) {
        return { ok: false, reason: "repair_conflicting_schema_alias" };
      }
    }
    if (Object.prototype.hasOwnProperty.call(repairedArgs, "queries")) {
      const queries = repairedArgs.queries;
      if (!Array.isArray(queries) || queries.length !== 1 || !plainObject(queries[0])) {
        return { ok: false, reason: "repair_query_collection_not_unique" };
      }
      const nested = { ...queries[0] };
      delete repairedArgs.queries;
      for (const [alias, canonical] of Object.entries(QUERY_ARGUMENT_ALIASES)) {
        if (!normalizeAlias(nested, alias, canonical)) {
          return { ok: false, reason: "repair_conflicting_schema_alias" };
        }
      }
      for (const [key, value] of Object.entries(nested)) {
        if (
          Object.prototype.hasOwnProperty.call(repairedArgs, key) &&
          JSON.stringify(repairedArgs[key]) !== JSON.stringify(value)
        ) {
          return { ok: false, reason: "repair_query_collection_conflict" };
        }
        repairedArgs[key] = value;
      }
      fact(
        "queries",
        "flatten",
        "single_query_collection_is_semantically_identical",
        queries,
        nested,
      );
    }
    for (const key of QUERY_BOOLEAN_ARGUMENTS) normalizeBoolean(repairedArgs, key);
    for (const key of QUERY_INTEGER_ARGUMENTS) normalizeInteger(repairedArgs, key);
    if (plainObject(repairedArgs.region)) {
      for (const key of ["left", "top", "width", "height"]) {
        normalizeInteger(repairedArgs.region, key);
      }
    }
    const keys = Object.keys(repairedArgs);
    if (keys.some((key) => !GROUNDED_QUERY_ALLOWED_KEYS.has(key))) {
      return { ok: false, reason: "repair_query_contains_unapproved_argument" };
    }
    const selectorCount = keys.filter((key) =>
      GROUNDED_QUERY_SELECTOR_KEYS.has(key)).length;
    if (selectorCount !== 1) {
      return { ok: false, reason: "repair_query_requires_exactly_one_selector" };
    }
    const freshDump = routeState?.latest_fresh_dump;
    if (
      routeState?.phase !== "GROUND" ||
      routeState?.pending_reobserve !== false ||
      typeof freshDump?.dump_id !== "string" ||
      freshDump.state_version !== routeState?.state_version
    ) {
      return { ok: false, reason: "repair_query_fresh_dependency_unavailable" };
    }
    if (repairedArgs.dumpId !== freshDump.dump_id) {
      const before = repairedArgs.dumpId;
      repairedArgs.dumpId = freshDump.dump_id;
      fact(
        "dumpId",
        "bind",
        "unique_latest_fresh_dump_same_state_version",
        before,
        freshDump.dump_id,
      );
    }
  } else if (routeClass === "INTERACT_UI_GROUNDED") {
    if (!RM_INTERACTION_TOOLS.includes(toolName)) {
      return { ok: false, reason: "repair_tool_not_supported" };
    }
    if (Object.keys(repairedArgs).some((key) =>
      !GROUNDED_INTERACTION_KEYS.has(key))) {
      return { ok: false, reason: "repair_interaction_contains_unapproved_argument" };
    }
    normalizeInteger(repairedArgs, "x");
    normalizeInteger(repairedArgs, "y");
    const freshQuery = routeState?.latest_fresh_query;
    const center = freshQuery?.selected_center;
    if (
      routeState?.phase !== "READY" ||
      routeState?.pending_reobserve !== false ||
      freshQuery?.state_version !== routeState?.state_version ||
      freshQuery?.selected_clickable !== true ||
      freshQuery?.selected_enabled !== true ||
      !Number.isInteger(center?.x) ||
      !Number.isInteger(center?.y)
    ) {
      return { ok: false, reason: "repair_interaction_fresh_dependency_unavailable" };
    }
    for (const key of ["x", "y"]) {
      if (repairedArgs[key] !== center[key]) {
        const before = repairedArgs[key];
        repairedArgs[key] = center[key];
        fact(
          key,
          "bind",
          "unique_latest_fresh_query_selected_center",
          before,
          center[key],
        );
      }
    }
  } else {
    return { ok: false, reason: "repair_route_class_not_supported" };
  }

  if (transformations.length === 0) {
    return { ok: false, reason: "repair_no_deterministic_change_available" };
  }

  const repairedArguments = JSON.stringify(repairedArgs);

  const repairedToolCall = {
    ...call,
    function: {
      ...call.function,
      arguments: repairedArguments,
    },
  };
  const choice = completion.choices[0];
  const repairedCompletion = {
    ...completion,
    choices: [{
      ...choice,
      message: {
        ...choice.message,
        tool_calls: [repairedToolCall],
      },
    }],
  };
  return {
    ok: true,
    reason: "standard_moderate_repair_compiled",
    tool_name: toolName,
    original_tool_call: call,
    repaired_tool_call: repairedToolCall,
    original_arguments: call.function.arguments,
    repaired_arguments: repairedArguments,
    transformations,
    completion: repairedCompletion,
  };
}

export function validateFiniteRouteCompletion(completion, routeClass, routeState) {
  const calls = completionToolCalls(completion);
  if (!calls || calls.length !== 1) {
    return { ok: false, reason: "finite_route_requires_exactly_one_tool_call" };
  }
  const call = calls[0];
  const name = call?.function?.name;
  const args = parseObject(call?.function?.arguments);
  if (!args) return { ok: false, reason: "finite_route_arguments_must_be_json_object" };

  if (routeClass === "EVIDENCE_LOCAL") {
    if (!R1_EVIDENCE_TOOLS.includes(name)) {
      return { ok: false, reason: "evidence_route_tool_not_allowed" };
    }
    if (Object.keys(args).length !== 0) {
      return { ok: false, reason: "evidence_route_requires_empty_arguments" };
    }
    return { ok: true, reason: "evidence_contract_valid" };
  }

  if (routeClass === "GROUNDED_QUERY_LOCAL") {
    if (name !== "android_ui_query") {
      return { ok: false, reason: "grounded_query_requires_android_ui_query" };
    }
    const dumpId = routeState?.latest_fresh_dump?.dump_id;
    if (typeof dumpId !== "string" || args.dumpId !== dumpId) {
      return { ok: false, reason: "grounded_query_dump_dependency_missing_or_stale" };
    }
    const keys = Object.keys(args);
    if (keys.some((key) => !GROUNDED_QUERY_ALLOWED_KEYS.has(key))) {
      return { ok: false, reason: "grounded_query_contains_unapproved_argument" };
    }
    if (!keys.some((key) => GROUNDED_QUERY_SELECTOR_KEYS.has(key))) {
      return { ok: false, reason: "grounded_query_requires_one_finite_selector" };
    }
    return { ok: true, reason: "grounded_query_contract_valid" };
  }

  if (routeClass === "OBSERVE_UI_RAW") {
    if (!RM_OBSERVE_TOOLS.includes(name)) {
      return { ok: false, reason: "observe_ui_raw_tool_not_allowed" };
    }
    if (Object.keys(args).length !== 0) {
      return { ok: false, reason: "observe_ui_raw_requires_empty_arguments" };
    }
    return { ok: true, reason: "observe_ui_raw_contract_valid" };
  }

  if (routeClass === "QUERY_UI_GROUNDED") {
    if (name !== "android_ui_query") {
      return { ok: false, reason: "query_ui_grounded_requires_android_ui_query" };
    }
    const dumpId = routeState?.latest_fresh_dump?.dump_id;
    if (typeof dumpId !== "string" || args.dumpId !== dumpId || routeState.pending_reobserve !== false) {
      return { ok: false, reason: "query_ui_grounded_dependency_missing_or_stale" };
    }
    const keys = Object.keys(args);
    if (keys.some((key) => !GROUNDED_QUERY_ALLOWED_KEYS.has(key))) {
      return { ok: false, reason: "query_ui_grounded_contains_unapproved_argument" };
    }
    const selectorCount = keys.filter((key) => GROUNDED_QUERY_SELECTOR_KEYS.has(key)).length;
    if (selectorCount !== 1) {
      return { ok: false, reason: "query_ui_grounded_requires_exactly_one_selector" };
    }
    return { ok: true, reason: "query_ui_grounded_contract_valid" };
  }

  if (routeClass === "INTERACT_UI_GROUNDED") {
    if (!RM_INTERACTION_TOOLS.includes(name)) {
      return { ok: false, reason: "interact_ui_grounded_tool_not_allowed" };
    }
    const keys = Object.keys(args);
    if (keys.length !== 2 || keys.some((key) => !GROUNDED_INTERACTION_KEYS.has(key))) {
      return { ok: false, reason: "interact_ui_grounded_requires_only_xy" };
    }
    const center = routeState?.latest_fresh_query?.selected_center;
    if (
      routeState?.pending_reobserve !== false ||
      routeState?.latest_fresh_query?.selected_clickable !== true ||
      routeState?.latest_fresh_query?.selected_enabled !== true ||
      !Number.isInteger(center?.x) ||
      !Number.isInteger(center?.y)
    ) {
      return { ok: false, reason: "interact_ui_grounded_query_dependency_missing_or_stale" };
    }
    if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x !== center.x || args.y !== center.y) {
      return { ok: false, reason: "interact_ui_grounded_coordinates_not_selected_center" };
    }
    return { ok: true, reason: "interact_ui_grounded_contract_valid" };
  }

  if (routeClass === "RETRIEVE_WEB_BOUNDED") {
    if (name !== "web_search") {
      return { ok: false, reason: "retrieve_web_bounded_requires_web_search" };
    }
    if (!validBoundedWebArguments(args)) {
      return { ok: false, reason: "retrieve_web_bounded_arguments_invalid" };
    }
    return { ok: true, reason: "retrieve_web_bounded_contract_valid" };
  }

  return { ok: false, reason: "unknown_finite_route_class" };
}

export function allowedToolsForRouteClass(routeClass, routeState) {
  if (routeClass === "EVIDENCE_LOCAL") return [...R1_EVIDENCE_TOOLS];
  if (
    routeClass === "GROUNDED_QUERY_LOCAL" &&
    typeof routeState?.latest_fresh_dump?.dump_id === "string" &&
    routeState.pending_reobserve === false
  ) {
    return [...R2_GROUNDED_QUERY_TOOLS];
  }
  if (routeClass === "OBSERVE_UI_RAW") return [...RM_OBSERVE_TOOLS];
  if (
    routeClass === "QUERY_UI_GROUNDED" &&
    typeof routeState?.latest_fresh_dump?.dump_id === "string" &&
    routeState.pending_reobserve === false
  ) {
    return [...RM_QUERY_TOOLS];
  }
  if (
    routeClass === "INTERACT_UI_GROUNDED" &&
    routeState?.latest_fresh_query?.selected_clickable === true &&
    routeState?.latest_fresh_query?.selected_enabled === true &&
    Number.isInteger(routeState?.latest_fresh_query?.selected_center?.x) &&
    Number.isInteger(routeState?.latest_fresh_query?.selected_center?.y) &&
    routeState.pending_reobserve === false
  ) {
    return [...RM_INTERACTION_TOOLS];
  }
  if (routeClass === "RETRIEVE_WEB_BOUNDED") return [...RM_RETRIEVAL_TOOLS];
  return [];
}
