import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createModelCallCapture,
  createPartitionedModelCallCapture,
  hashJson,
} from "./capture.js";
import { classifyCompletionArguments } from "./complexity.js";
import {
  loadRuntimeConfig,
  publicConfig,
  V4_ARM_IDS,
  VIRTUAL_MODELS,
} from "./config.js";
import { createJsonlLogger } from "./logger.js";
import {
  applyToolWhitelist,
  compileScopedLocalRequest,
  getBinaryRoutePredictionWithRetry,
  getDecisionPredictionWithRetry,
  getRouteClassPredictionWithRetry,
  SCOPED_LOCAL_CONTEXT_VERSION,
} from "./strategies.js";
import {
  COARSE_LOCAL_CONTEXT_VERSION,
  COARSE_TO_FINE_POLICY_VERSION,
  EXPLICIT_BINARY_TOOL_POLICY_VERSION,
  compileBinaryRouterInput,
  compileCoarseLocalRequest,
  compileExplicitLocalRequest,
  deriveExplicitBinaryToolDecision,
} from "./coarse-to-fine.js";
import {
  FSM_STANDARD_LOCAL_ROUTE_CLASSES,
  ROUTER_FSM_SCOPED_POLICY_VERSION,
  ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION,
  ROUTER_R1_POLICY_VERSION,
  ROUTER_R2_POLICY_VERSION,
  ROUTER_RM_POLICY_VERSION,
  ROUTER_RM_SCOPED_POLICY_VERSION,
  allowedToolsForRouteClass,
  classifyUiEffect,
  createFsmTransitionExpectation,
  deriveRouteState,
  fsmAdmissibleRouteClasses,
  isLocalRouteClass,
  routeClassForLocalTool,
  UI_EFFECT_AWARE_POLICY_VERSION,
  compileStandardModerateRepair,
  validateFiniteRouteCompletion,
  validateFsmTransitionExpectation,
} from "./route-state.js";
import {
  fetchCompletion,
  readCompletionJson,
  relayResponse,
} from "./upstream.js";

class HttpError extends Error {
  constructor(status, message, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const CLOUD_FIRST_UI_MUTATION_GATE_VERSION =
  "g4-fsm-scoped-repair-cloud-first-ui-mutation-v1";
const UI_MUTATION_TOOL_NAMES = new Set([
  "android_tap",
  "adb_tap",
  "android_type",
  "adb_type",
  "android_swipe",
  "adb_swipe",
  "android_keyevent",
  "adb_keyevent",
]);
const UI_ACTION_TOOL_NAMES = new Set([
  "android_screenshot",
  "adb_screenshot",
  "android_ui_dump",
  "adb_ui_dump_xml",
  "android_ui_query",
  "android_ocr_dump",
  ...UI_MUTATION_TOOL_NAMES,
]);
const STRONG_PATH_CHECK_VERSION = "g4-binary-strong-path-check-v1";
const STRONG_PATH_CHECK_SYSTEM = `Experimental next-action policy for this Cloud call only:
Before entering or continuing fine-grained phone UI navigation, assess whether an already available safe provider, web, file, shell, intent, or other authoritative Tool can satisfy the current subgoal with fewer operations.
Use such a path only when it is compatible with the explicit Task wording and can be verified in the same state domain. Otherwise use the normal UI path.
Do not force a shortcut, do not infer hidden verifier requirements, and do not skip application interaction that the Task explicitly requires.`;

function strongPathCheckRequest(request) {
  const messages = Array.isArray(request?.messages) ? [...request.messages] : [];
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt]?.role === "system") {
    insertAt += 1;
  }
  messages.splice(insertAt, 0, {
    role: "system",
    content: STRONG_PATH_CHECK_SYSTEM,
  });
  return { ...request, messages };
}

function parsedCallArguments(call) {
  try {
    const value = typeof call?.function?.arguments === "string"
      ? JSON.parse(call.function.arguments)
      : call?.function?.arguments;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function successfulResolvedUiMutations(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const pending = new Map();
  const resolved = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = call?.id;
        const name = call?.function?.name;
        if (
          typeof id === "string" &&
          id.length > 0 &&
          typeof name === "string" &&
          UI_MUTATION_TOOL_NAMES.has(name)
        ) {
          pending.set(id, name);
        }
      }
    }
    if (message?.role !== "tool" || typeof message.tool_call_id !== "string") {
      continue;
    }
    const name = pending.get(message.tool_call_id);
    if (!name) continue;
    pending.delete(message.tool_call_id);
    let result = null;
    try {
      result = typeof message.content === "string"
        ? JSON.parse(message.content)
        : message.content;
    } catch {
      result = null;
    }
    if (result !== null && typeof result === "object" && result.ok === true) {
      resolved.push(Object.freeze({
        tool_call_id: message.tool_call_id,
        tool_name: name,
      }));
    }
  }
  return Object.freeze(resolved);
}

function successfulResolvedUiActions(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const pending = new Map();
  const resolved = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = call?.id;
        const name = call?.function?.name;
        const uiEffect = classifyUiEffect({
          name,
          arguments: parsedCallArguments(call),
        }, UI_EFFECT_AWARE_POLICY_VERSION);
        if (
          typeof id === "string" &&
          id.length > 0 &&
          typeof name === "string" &&
          (UI_ACTION_TOOL_NAMES.has(name) || uiEffect === "UI_MUTATION")
        ) {
          pending.set(id, name);
        }
      }
    }
    if (message?.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    const name = pending.get(message.tool_call_id);
    if (!name) continue;
    pending.delete(message.tool_call_id);
    let result = null;
    try {
      result = typeof message.content === "string"
        ? JSON.parse(message.content)
        : message.content;
    } catch {
      result = null;
    }
    if (result !== null && typeof result === "object" && result.ok === true) {
      resolved.push(Object.freeze({ tool_call_id: message.tool_call_id, tool_name: name }));
    }
  }
  return Object.freeze(resolved);
}

const PROVIDER_QUEUE_WAIT_SEMANTICS =
  "fifo_wait_before_physical_provider_start_excluded_from_provider_latency";

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function createFifoSemaphore(configured = 1) {
  let current = 0;
  let maxObserved = 0;
  const waiters = [];

  const dispatch = () => {
    while (current < configured && waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.cleanup();
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      waiter.cleanup();
      current += 1;
      maxObserved = Math.max(maxObserved, current);
      let released = false;
      waiter.resolve({
        release() {
          if (released) return;
          released = true;
          current -= 1;
          dispatch();
        },
      });
    }
  };

  return Object.freeze({
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      return new Promise((resolve, reject) => {
        const waiter = {
          signal,
          resolve,
          reject,
          cleanup: () => {},
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          waiter.cleanup();
          reject(abortError(signal));
        };
        waiter.cleanup = () => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
        dispatch();
      });
    },
    status: () => ({
      configured,
      current,
      queued: waiters.length,
      max_observed: maxObserved,
    }),
  });
}

// These gates are intentionally module-scoped: every Router instance in one
// Node process shares the same physical-provider capacity while the two
// physical resources remain independent from one another.
const PHYSICAL_PROVIDER_GATES = Object.freeze({
  "freeinference-global": createFifoSemaphore(1),
  "openai-global": createFifoSemaphore(1),
  "xmu-8080": createFifoSemaphore(1),
});

function physicalProviderResource(provider) {
  if (provider?.id === "custom-freeinference-org") return "freeinference-global";
  let parsed;
  try {
    parsed = new URL(provider?.baseUrl);
  } catch {
    parsed = null;
  }
  if (parsed?.hostname.toLowerCase() === "freeinference.org") {
    return "freeinference-global";
  }
  if (
    provider?.id === "openai" ||
    parsed?.hostname.toLowerCase() === "api.openai.com"
  ) {
    return "openai-global";
  }
  if (
    provider?.id === "custom-127-0-0-1-18080" ||
    /^custom-.*xmu(?:-|$)/i.test(provider?.id || "") ||
    parsed?.port === "8080" ||
    (
      parsed?.port === "18080" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
    )
  ) {
    return "xmu-8080";
  }
  return null;
}

function providerConcurrencyStatus() {
  return Object.fromEntries(
    Object.entries(PHYSICAL_PROVIDER_GATES).map(([resource, gate]) => [
      resource,
      gate.status(),
    ]),
  );
}

function requestIdFromFetchOptions(options) {
  return new Headers(options?.headers).get("x-request-id");
}

function createPhysicalRequestScope(provider, baseFetch, captureStore) {
  const resource = physicalProviderResource(provider);
  if (!resource) {
    return Object.freeze({ fetchImpl: baseFetch, captureStore, audit: null });
  }

  const gate = PHYSICAL_PROVIDER_GATES[resource];
  const attempts = new Map();
  const audit = {
    resource,
    totalQueueWaitMs: 0,
  };

  const fetchImpl = async (target, options = {}) => {
    const requestId = requestIdFromFetchOptions(options);
    const queueEnteredAt = performance.now();
    const queueEnteredAtIso = new Date().toISOString();
    let lease;
    try {
      lease = await gate.acquire(options.signal);
    } catch (error) {
      const queueWaitMs = Math.max(0, performance.now() - queueEnteredAt);
      audit.totalQueueWaitMs += queueWaitMs;
      if (requestId) {
        attempts.set(requestId, {
          resource,
          queueEnteredAtIso,
          queueWaitMs,
          providerStartedAt: null,
          providerStartedAtIso: null,
          lease: null,
        });
      }
      throw error;
    }

    const queueWaitMs = Math.max(0, performance.now() - queueEnteredAt);
    const attempt = {
      resource,
      queueEnteredAtIso,
      queueWaitMs,
      providerStartedAt: performance.now(),
      providerStartedAtIso: new Date().toISOString(),
      lease,
    };
    audit.totalQueueWaitMs += queueWaitMs;
    if (requestId) attempts.set(requestId, attempt);
    return baseFetch(target, options);
  };

  const takeAttempt = (call) => {
    const requestId = call?.metadata?.service_request_id;
    if (!requestId) return null;
    const attempt = attempts.get(requestId) || null;
    attempts.delete(requestId);
    return attempt;
  };

  const timingWithAttempt = (timing, attempt, responseHeadersObserved) => ({
    ...timing,
    providerQueueResource: attempt?.resource || resource,
    providerQueueEnteredAtIso: attempt?.queueEnteredAtIso || timing.startedAtIso,
    providerQueueWaitMs: attempt?.queueWaitMs ?? Math.max(
      0,
      performance.now() - timing.startedAt,
    ),
    providerStartedAt: attempt?.providerStartedAt ?? null,
    providerStartedAtIso: attempt?.providerStartedAtIso ?? null,
    ...(responseHeadersObserved && Number.isFinite(attempt?.providerStartedAt)
      ? {
          providerHeadersElapsedMs: Math.max(
            0,
            Math.round(performance.now() - attempt.providerStartedAt),
          ),
        }
      : {}),
  });

  const scopedCaptureStore = Object.freeze({
    // Force upstream.js to clone and drain every raw response even when JSONL
    // persistence is disabled; the physical lease must span the response body.
    enabled: true,
    path: captureStore.path,
    async captureResponse(call, response, timing) {
      const attempt = takeAttempt(call);
      try {
        if (captureStore.enabled) {
          await captureStore.captureResponse(
            call,
            response,
            timingWithAttempt(timing, attempt, true),
          );
        } else {
          try {
            await response.arrayBuffer();
          } catch {
            // A failed raw stream still reaches the release path below.
          }
        }
      } finally {
        attempt?.lease?.release();
      }
    },
    async captureFailure(call, error, timing) {
      const attempt = takeAttempt(call);
      try {
        await captureStore.captureFailure(
          call,
          error,
          timingWithAttempt(timing, attempt, false),
        );
      } finally {
        attempt?.lease?.release();
      }
    },
    captureInbound: (...args) => captureStore.captureInbound(...args),
    captureDerivedResponse: (...args) => captureStore.captureDerivedResponse(...args),
    flush: () => captureStore.flush(),
    status: () => captureStore.status(),
  });

  return Object.freeze({ fetchImpl, captureStore: scopedCaptureStore, audit });
}

function queueAdjustedTelemetry(telemetry, audit) {
  if (!audit) return telemetry;
  const queueWaitMs = Math.max(0, Math.round(audit.totalQueueWaitMs));
  return Object.freeze({
    ...(telemetry || {}),
    ...(Number.isSafeInteger(telemetry?.helper_latency_ms)
      ? { helper_latency_ms: Math.max(0, telemetry.helper_latency_ms - queueWaitMs) }
      : {}),
    helper_queue_resource: audit.resource,
    helper_queue_wait_ms: queueWaitMs,
    helper_queue_wait_semantics: PROVIDER_QUEUE_WAIT_SEMANTICS,
    helper_latency_semantics:
      "helper_elapsed_excluding_physical_provider_fifo_queue_wait",
  });
}

function queueAdjustedHelperRun(helperRun, audit) {
  if (!helperRun || !audit) return helperRun;
  return Object.freeze({
    ...helperRun,
    telemetry: queueAdjustedTelemetry(helperRun.telemetry, audit),
  });
}

function queueAdjustedHelperError(error, audit) {
  if (error && audit) {
    error.helperTelemetry = queueAdjustedTelemetry(error.helperTelemetry, audit);
  }
  return error;
}

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, headerValue] of Object.entries(headers)) {
    response.setHeader(name, String(headerValue));
  }
  response.end(JSON.stringify(value));
}

function sendError(response, status, message, type = "router_error", requestId) {
  const headers = requestId ? { "x-request-id": requestId } : {};
  sendJson(
    response,
    status,
    { error: { message, type, code: type } },
    headers,
  );
}

async function readJsonBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new HttpError(413, "Request body is too large", "request_too_large");
    }
    chunks.push(chunk);
  }
  const rawText = Buffer.concat(chunks).toString("utf8");
  let value;
  try {
    value = JSON.parse(rawText);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return { value, rawText };
}

function validateChatRequest(body) {
  if (!VIRTUAL_MODELS.includes(body.model)) {
    throw new HttpError(
      400,
      `model must be one of: ${VIRTUAL_MODELS.join(", ")}`,
      "unknown_virtual_model",
    );
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "messages must be an array");
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new HttpError(400, "tools must be an array when provided");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new HttpError(400, "stream must be a boolean when provided");
  }
}

function requestIdFrom(request) {
  const supplied = request.headers["x-request-id"];
  if (typeof supplied === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(supplied)) {
    return supplied;
  }
  return randomUUID();
}

function safeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function runSessionIdFromMessages(messages) {
  let serialized;
  try {
    serialized = JSON.stringify(messages);
  } catch {
    return null;
  }
  const ids = new Set();
  const pattern =
    /(?:^|[^A-Za-z0-9_.-])run:([A-Za-z0-9_.-]{8,128})(?![A-Za-z0-9_.-])/gi;
  for (const match of serialized.matchAll(pattern)) {
    const id = safeSessionId(match[1]);
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function experimentRunMarkerCandidates(messages) {
  let serialized;
  try {
    serialized = JSON.stringify(messages);
  } catch {
    return [];
  }
  const candidates = [];
  const pattern =
    /(?:^|[^A-Za-z0-9_.-])run:([A-Za-z0-9_.-]+)(?![A-Za-z0-9_.-])/g;
  for (const match of serialized.matchAll(pattern)) candidates.push(match[1]);
  return candidates;
}

function compatibleSessionIdentityFrom(request, body, env, proxySessionId) {
  const clawmobileHeader = safeSessionId(
    request.headers["x-clawmobile-session-id"],
  );
  if (clawmobileHeader) {
    return Object.freeze({
      id: clawmobileHeader,
      source: "x-clawmobile-session-id",
    });
  }

  const genericHeader = safeSessionId(request.headers["x-session-id"]);
  if (genericHeader) {
    return Object.freeze({ id: genericHeader, source: "x-session-id" });
  }

  const runMarker = runSessionIdFromMessages(body.messages);
  if (runMarker) {
    return Object.freeze({ id: runMarker, source: "clawbench-run-marker" });
  }
  const campaignSession = safeSessionId(env.CLAW_ROUTER_CAMPAIGN_ID);
  if (campaignSession) {
    return Object.freeze({ id: campaignSession, source: "campaign" });
  }
  return Object.freeze({ id: proxySessionId, source: "proxy" });
}

function sessionIdentityInspectionFrom(request, body, env, proxySessionId, requestId) {
  if (body.model !== "experiment") {
    return Object.freeze({
      identity: compatibleSessionIdentityFrom(request, body, env, proxySessionId),
      error: null,
    });
  }

  const candidates = experimentRunMarkerCandidates(body.messages);
  const marker = candidates.length === 1 && /^[0-9a-f]{32}$/.test(candidates[0])
    ? candidates[0]
    : null;
  const headerNames = ["x-clawmobile-session-id", "x-session-id"];
  const presentHeaders = headerNames
    .filter((name) => request.headers[name] !== undefined)
    .map((name) => ({ name, value: request.headers[name] }));
  const validHeaders = presentHeaders.filter(
    ({ value }) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value),
  );
  const headersAreValidAndConsistent =
    validHeaders.length === presentHeaders.length &&
    new Set(validHeaders.map(({ value }) => value)).size <= 1;
  const headerIdentity = headersAreValidAndConsistent && validHeaders.length > 0
    ? Object.freeze({
      id: validHeaders[0].value,
      source: validHeaders.some(({ name }) => name === "x-clawmobile-session-id")
        ? "x-clawmobile-session-id"
        : "x-session-id",
    })
    : null;

  // Any marker-like token is authoritative evidence.  A malformed or duplicate
  // marker must never be silently ignored in favour of a header.
  if (candidates.length !== 0 && !marker) {
    return Object.freeze({
      identity: Object.freeze({
        id: `invalid-experiment-${requestId}`,
        source: "experiment-session-invalid",
      }),
      error: new HttpError(
        400,
        "model experiment run markers must contain exactly one lowercase run:<32hex> value",
        "experiment_session_required",
      ),
    });
  }

  const markerIdentity = marker
    ? Object.freeze({ id: marker, source: "clawbench-run-marker" })
    : null;
  const identity = markerIdentity || headerIdentity;
  if (!identity) {
    return Object.freeze({
      identity: Object.freeze({
        id: `invalid-experiment-${requestId}`,
        source: "experiment-session-invalid",
      }),
      error: new HttpError(
        400,
        presentHeaders.length > 0
          ? "model experiment session headers must be one identical lowercase 32-hex value"
          : "model experiment requires one lowercase run:<32hex> marker or explicit session header",
        presentHeaders.length > 0
          ? "experiment_session_conflict"
          : "experiment_session_required",
      ),
    });
  }

  if (
    !headersAreValidAndConsistent ||
    (markerIdentity && headerIdentity && markerIdentity.id !== headerIdentity.id)
  ) {
    return Object.freeze({
      identity,
      error: new HttpError(
        400,
        "model experiment session headers must be lowercase 32-hex values and exactly match each other and any run marker",
        "experiment_session_conflict",
      ),
    });
  }
  return Object.freeze({ identity, error: null });
}

function serviceRole(callRole) {
  switch (callRole) {
    case "filter_helper":
      return "filter";
    case "router_helper":
      return "router";
    case "cloud_agent":
      return "agent";
    case "local_agent":
    case "local_agent_downstream":
      return "local-agent";
    case "proxy_inbound":
      return "proxy";
    default:
      return "model";
  }
}

function upstreamSessionId(sessionId, role) {
  const normalized = sessionId.replace(/[^A-Za-z0-9_.-]+/g, "-");
  const compact = normalized === sessionId && normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 56)}-${hashJson(sessionId).slice(0, 16)}`;
  return `cm-${compact}-${role}`;
}

function routeHeaders(requestId, route, extras = {}) {
  return {
    "x-request-id": requestId,
    "x-clawmobile-route": route,
    ...extras,
  };
}

function safeErrorCode(error) {
  if (error instanceof HttpError) return error.type;
  if (typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)) {
    return error.code;
  }
  if (error?.name === "TimeoutError") return "strategy_timeout";
  if (error?.name === "AbortError") return "request_aborted";
  return error?.name === "TypeError" ? "network_error" : "strategy_error";
}

function authorized(request, expectedToken) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function discard(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // A failed or already-consumed upstream body needs no further action.
  }
}

function synthesizeCompletionSse(response, completion, headers) {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, String(value));

  const chunk = {
    id: completion.id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: completion.created || Math.floor(Date.now() / 1000),
    model: completion.model,
    choices: (completion.choices || []).map((choice, index) => {
      const message = choice.message || {};
      const delta = {
        ...(message.role !== undefined ? { role: message.role } : {}),
        ...(message.content !== undefined ? { content: message.content } : {}),
        ...(Array.isArray(message.tool_calls)
          ? {
              tool_calls: message.tool_calls.map((toolCall, toolIndex) => ({
                ...toolCall,
                index: toolCall.index ?? toolIndex,
              })),
            }
          : {}),
        ...(message.refusal !== undefined ? { refusal: message.refusal } : {}),
      };
      return {
        index: choice.index ?? index,
        delta,
        finish_reason: choice.finish_reason ?? null,
        ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
      };
    }),
    ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
    ...(completion.system_fingerprint !== undefined
      ? { system_fingerprint: completion.system_fingerprint }
      : {}),
  };
  const rawSse = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  response.end(rawSse);
  return rawSse;
}

const LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL = "parameter_schema_subset_v1";
const SUPPORTED_PARAMETER_SCHEMA_KEYWORDS = new Set([
  "type",
  "description",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "properties",
  "additionalProperties",
  "enum",
  "required",
  "items",
  "anyOf",
  "maxItems",
  "minItems",
  "minLength",
  "maxLength",
  "const",
  "default",
  "patternProperties",
]);
const SUPPORTED_PARAMETER_SCHEMA_TYPES = new Set([
  "string",
  "integer",
  "object",
  "boolean",
  "number",
  "array",
  "null",
]);

function isPlainJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (isPlainJsonObject(left) || isPlainJsonObject(right)) {
    if (!isPlainJsonObject(left) || !isPlainJsonObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && jsonValuesEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function inspectParameterSchema(schema, path = "parameters") {
  if (!isPlainJsonObject(schema)) {
    return { ok: false, reason: `${path}:schema_not_object` };
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_PARAMETER_SCHEMA_KEYWORDS.has(keyword)) {
      return { ok: false, reason: `${path}:unsupported_keyword:${keyword}` };
    }
  }
  if (
    schema.type !== undefined &&
    (typeof schema.type !== "string" ||
      !SUPPORTED_PARAMETER_SCHEMA_TYPES.has(schema.type))
  ) {
    return { ok: false, reason: `${path}:unsupported_type` };
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0)
  ) {
    return { ok: false, reason: `${path}:invalid_enum` };
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== "string") ||
      new Set(schema.required).size !== schema.required.length
    ) {
      return { ok: false, reason: `${path}:invalid_required` };
    }
  }
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum"]) {
    if (
      schema[keyword] !== undefined &&
      (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))
    ) {
      return { ok: false, reason: `${path}:invalid_${keyword}` };
    }
  }
  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"]) {
    if (
      schema[keyword] !== undefined &&
      (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)
    ) {
      return { ok: false, reason: `${path}:invalid_${keyword}` };
    }
  }
  if (
    schema.minItems !== undefined &&
    schema.maxItems !== undefined &&
    schema.minItems > schema.maxItems
  ) {
    return { ok: false, reason: `${path}:invalid_item_bounds` };
  }
  if (
    schema.minLength !== undefined &&
    schema.maxLength !== undefined &&
    schema.minLength > schema.maxLength
  ) {
    return { ok: false, reason: `${path}:invalid_length_bounds` };
  }
  if (schema.properties !== undefined && !isPlainJsonObject(schema.properties)) {
    return { ok: false, reason: `${path}:invalid_properties` };
  }
  for (const [name, child] of Object.entries(schema.properties || {})) {
    const inspected = inspectParameterSchema(child, `${path}.properties.${name}`);
    if (!inspected.ok) return inspected;
  }
  if (
    schema.patternProperties !== undefined &&
    !isPlainJsonObject(schema.patternProperties)
  ) {
    return { ok: false, reason: `${path}:invalid_patternProperties` };
  }
  for (const [pattern, child] of Object.entries(schema.patternProperties || {})) {
    try {
      new RegExp(pattern);
    } catch {
      return { ok: false, reason: `${path}:invalid_pattern:${pattern}` };
    }
    const inspected = inspectParameterSchema(
      child,
      `${path}.patternProperties.${pattern}`,
    );
    if (!inspected.ok) return inspected;
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    !isPlainJsonObject(schema.additionalProperties)
  ) {
    return { ok: false, reason: `${path}:invalid_additionalProperties` };
  }
  if (isPlainJsonObject(schema.additionalProperties)) {
    const inspected = inspectParameterSchema(
      schema.additionalProperties,
      `${path}.additionalProperties`,
    );
    if (!inspected.ok) return inspected;
  }
  if (schema.items !== undefined) {
    const inspected = inspectParameterSchema(schema.items, `${path}.items`);
    if (!inspected.ok) return inspected;
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      return { ok: false, reason: `${path}:invalid_anyOf` };
    }
    for (let index = 0; index < schema.anyOf.length; index += 1) {
      const inspected = inspectParameterSchema(
        schema.anyOf[index],
        `${path}.anyOf[${index}]`,
      );
      if (!inspected.ok) return inspected;
    }
  }
  return { ok: true };
}

function valueMatchesSchemaType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function validateParameterValue(value, schema, path = "arguments") {
  if (schema.type !== undefined && !valueMatchesSchemaType(value, schema.type)) {
    return { ok: false, reason: `${path}:type` };
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => jsonValuesEqual(value, candidate))
  ) {
    return { ok: false, reason: `${path}:enum` };
  }
  if (schema.const !== undefined && !jsonValuesEqual(value, schema.const)) {
    return { ok: false, reason: `${path}:const` };
  }
  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.some(
      (candidate) => validateParameterValue(value, candidate, path).ok,
    );
    if (!matches) return { ok: false, reason: `${path}:anyOf` };
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { ok: false, reason: `${path}:minimum` };
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { ok: false, reason: `${path}:maximum` };
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      return { ok: false, reason: `${path}:exclusiveMinimum` };
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return { ok: false, reason: `${path}:minLength` };
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return { ok: false, reason: `${path}:maxLength` };
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return { ok: false, reason: `${path}:minItems` };
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return { ok: false, reason: `${path}:maxItems` };
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const validated = validateParameterValue(
          value[index],
          schema.items,
          `${path}[${index}]`,
        );
        if (!validated.ok) return validated;
      }
    }
  }
  if (isPlainJsonObject(value)) {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        return { ok: false, reason: `${path}:required:${required}` };
      }
    }
    const properties = schema.properties || {};
    const patterns = Object.entries(schema.patternProperties || {}).map(
      ([pattern, child]) => [new RegExp(pattern), child],
    );
    for (const [name, childValue] of Object.entries(value)) {
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        matched = true;
        const validated = validateParameterValue(
          childValue,
          properties[name],
          `${path}.${name}`,
        );
        if (!validated.ok) return validated;
      }
      for (const [pattern, patternSchema] of patterns) {
        if (!pattern.test(name)) continue;
        matched = true;
        const validated = validateParameterValue(
          childValue,
          patternSchema,
          `${path}.${name}`,
        );
        if (!validated.ok) return validated;
      }
      if (!matched && schema.additionalProperties === false) {
        return { ok: false, reason: `${path}:additionalProperties:${name}` };
      }
      if (!matched && isPlainJsonObject(schema.additionalProperties)) {
        const validated = validateParameterValue(
          childValue,
          schema.additionalProperties,
          `${path}.${name}`,
        );
        if (!validated.ok) return validated;
      }
    }
  }
  return { ok: true };
}

export function validateLocalCompletion(completion, request) {
  const choices = completion?.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return { ok: false, reason: "invalid_choice_count" };
  }
  const choice = choices[0];
  const message = choice?.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return { ok: false, reason: "invalid_assistant_message" };
  }
  const toolCalls = message.tool_calls;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (toolCalls !== undefined && toolCalls !== null && !Array.isArray(toolCalls)) {
    return { ok: false, reason: "invalid_tool_calls" };
  }
  if (!hasToolCalls) {
    if (request.tool_choice === "required" || request.tool_choice?.type === "function") {
      return { ok: false, reason: "required_tool_missing" };
    }
    if (choice.finish_reason !== "stop") {
      return { ok: false, reason: "incomplete_text_completion" };
    }
    const content = message.content;
    if (typeof content !== "string" && !Array.isArray(content)) {
      return { ok: false, reason: "empty_text_completion" };
    }
    return {
      ok: true,
      reason: "valid_text",
      validationLevel: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
      parameterSchemaApplied: false,
    };
  }

  if (request.tool_choice === "none") {
    return { ok: false, reason: "tool_choice_none_violated" };
  }
  if (request.parallel_tool_calls === false && toolCalls.length > 1) {
    return { ok: false, reason: "parallel_tools_violated" };
  }
  if (choice.finish_reason !== "tool_calls") {
    return { ok: false, reason: "incomplete_tool_completion" };
  }
  const allowed = new Set(
    (Array.isArray(request.tools) ? request.tools : [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );
  const requiredName =
    request.tool_choice?.type === "function"
      ? request.tool_choice?.function?.name
      : null;
  const toolCallIds = new Set();
  for (const toolCall of toolCalls) {
    const name = toolCall?.function?.name;
    if (
      typeof toolCall?.id !== "string" ||
      toolCall.id.length === 0 ||
      toolCall.type !== "function" ||
      typeof name !== "string" ||
      !allowed.has(name) ||
      (requiredName && name !== requiredName)
    ) {
      return { ok: false, reason: "tool_contract_violation" };
    }
    if (toolCallIds.has(toolCall.id)) {
      return { ok: false, reason: "duplicate_tool_call_id" };
    }
    toolCallIds.add(toolCall.id);
    const rawArguments = toolCall.function.arguments;
    if (typeof rawArguments !== "string") {
      return { ok: false, reason: "invalid_argument_encoding" };
    }
    try {
      const parsed = JSON.parse(rawArguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid_argument_object" };
      }
      const tool = request.tools.find(
        (candidate) => candidate?.function?.name === name,
      );
      const schema = tool?.function?.parameters;
      const inspected = inspectParameterSchema(schema, `tool:${name}`);
      if (!inspected.ok) {
        return { ok: false, reason: `unsupported_parameter_schema:${inspected.reason}` };
      }
      const validated = validateParameterValue(parsed, schema);
      if (!validated.ok) {
        return { ok: false, reason: `parameter_schema_violation:${validated.reason}` };
      }
    } catch {
      return { ok: false, reason: "invalid_argument_json" };
    }
  }
  return {
    ok: true,
    reason: "valid_tools",
    validationLevel: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
    parameterSchemaApplied: true,
  };
}

export async function createRouterProxy(options = {}) {
  const env = options.env || process.env;
  const runtime = await loadRuntimeConfig({
    configPath: options.configPath,
    env,
  });
  const fetchImpl = options.fetchImpl || fetch;
  const logPath =
    options.logPath === null
      ? null
      : options.logPath ||
        env.CLAW_ROUTER_LOG_PATH ||
        join(homedir(), ".openclaw", "logs", "clawmobile-router.jsonl");
  const writeLog = createJsonlLogger(logPath);
  const captureRoot = options.captureRoot || env.CLAW_ROUTER_CAPTURE_ROOT || null;
  const capturePath =
    captureRoot
      ? null
      : options.capturePath === null
      ? null
      : options.capturePath || env.CLAW_ROUTER_CAPTURE_PATH || null;
  const captureStore = createModelCallCapture(capturePath);
  const partitionedCapture = createPartitionedModelCallCapture(captureRoot);
  if (runtime.v4Enabled && !partitionedCapture.enabled) {
    throw new Error("CLAW_ROUTER_CAPTURE_ROOT is required when CLAW_ROUTER_V4_ENABLED=1");
  }
  const runRegistrations = new Map();
  const pendingFsmTransitions = new Map();
  const requestContexts = new Map();
  const partitionLoggers = new Map();
  const proxySessionId = `proxy-${randomUUID()}`;
  const safeLog = async (event) => {
    const requestContext = requestContexts.get(event?.request_id) || null;
    const enriched = requestContext
      ? {
          session_id: requestContext.sessionId,
          arm_id: requestContext.armId,
          ...event,
        }
      : event;
    try {
      await writeLog(enriched);
      if (captureRoot && requestContext?.sessionId) {
        let logger = partitionLoggers.get(requestContext.sessionId);
        if (!logger) {
          logger = createJsonlLogger(
            join(captureRoot, requestContext.sessionId, "proxy-events.jsonl"),
          );
          partitionLoggers.set(requestContext.sessionId, logger);
        }
        await logger(enriched);
      }
    } catch {
      // Observability must never make inference unavailable.
    }
  };

  const physicalRequestScope = (provider, context) =>
    createPhysicalRequestScope(
      provider,
      fetchImpl,
      context?.captureStore || captureStore,
    );

  function callMetadata(context, callRole, extras = {}) {
    const role = serviceRole(callRole);
    return {
      campaign_id: env.CLAW_ROUTER_CAMPAIGN_ID || null,
      arm_id:
        context.virtualModel === "experiment"
          ? context.armId
          : context.virtualModel,
      session_id: context.sessionId,
      session_source: context.sessionSource,
      turn_id: context.requestId,
      proxy_request_id: context.requestId,
      virtual_model: context.virtualModel,
      call_role: callRole,
      service_role: role,
      upstream_session_id: upstreamSessionId(context.sessionId, role),
      original_request_sha256: context.originalRequestSha256,
      original_messages_sha256: context.originalMessagesSha256,
      original_tools_sha256: context.originalToolsSha256,
      original_generation_params_sha256: context.originalGenerationParamsSha256,
      ...(context.sessionValidationError
        ? { session_validation_error: context.sessionValidationError }
        : {}),
      ...extras,
    };
  }

  async function forwardCloud(body, nodeResponse, context, route, extras = {}) {
    const provider = context.providers.cloud;
    const physical = physicalRequestScope(provider, context);
    let upstream;
    try {
      upstream = await fetchCompletion(provider, body, physical.fetchImpl, {
        signal: context.signal,
        timeoutMs: runtime.answerTimeoutMs,
        captureStore: physical.captureStore,
        captureMetadata: callMetadata(context, "cloud_agent", {
          route,
          attempt_index: extras.attemptIndex || 1,
          fallback: Boolean(extras.fallback),
          ...(extras.captureMetadata || {}),
        }),
      });
    } catch (error) {
      await safeLog({
        event: "request_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route,
        provider_id: provider.id,
        model: provider.model,
        error_code: safeErrorCode(error),
      });
      sendError(nodeResponse, 502, "Cloud provider is unavailable", "upstream_error", context.requestId);
      return;
    }
    if (!upstream.ok) {
      await safeLog({
        event: "request_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route,
        provider_id: provider.id,
        upstream_status: upstream.status,
      });
      await relayResponse(upstream, nodeResponse, routeHeaders(context.requestId, route));
      return;
    }
    await safeLog({
      event: "request_routed",
      request_id: context.requestId,
      virtual_model: context.virtualModel,
      route,
      provider_id: provider.id,
      model: provider.model,
      tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      fallback: Boolean(extras.fallback),
      fallback_schema: extras.fallbackSchema,
    });
    await relayResponse(
      upstream,
      nodeResponse,
      routeHeaders(context.requestId, route, {
        "x-clawmobile-fallback": Boolean(extras.fallback),
      }),
    );
  }

  async function forwardLocalOnly(body, nodeResponse, context) {
    const provider = context.providers.local;
    const physical = physicalRequestScope(provider, context);
    let upstream;
    try {
      upstream = await fetchCompletion(provider, body, physical.fetchImpl, {
        signal: context.signal,
        timeoutMs: runtime.answerTimeoutMs,
        captureStore: physical.captureStore,
        captureMetadata: callMetadata(context, "local_agent", {
          route: "local-only",
          attempt_index: 1,
          fallback: false,
        }),
      });
    } catch (error) {
      await safeLog({
        event: "request_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route: "local-only",
        provider_id: provider.id,
        model: provider.model,
        error_code: safeErrorCode(error),
      });
      sendError(nodeResponse, 502, "Local provider is unavailable", "upstream_error", context.requestId);
      return;
    }
    if (!upstream.ok) {
      await safeLog({
        event: "request_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route: "local-only",
        provider_id: provider.id,
        upstream_status: upstream.status,
      });
      await relayResponse(
        upstream,
        nodeResponse,
        routeHeaders(context.requestId, "local-only"),
      );
      return;
    }
    await safeLog({
      event: "request_routed",
      request_id: context.requestId,
      virtual_model: context.virtualModel,
      route: "local-only",
      provider_id: provider.id,
      model: provider.model,
      tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      fallback: false,
    });
    await relayResponse(
      upstream,
      nodeResponse,
      routeHeaders(context.requestId, "local-only", {
        "x-clawmobile-fallback": false,
      }),
    );
  }

  async function forwardLocalCandidate(
    body,
    nodeResponse,
    context,
    prediction,
    fallbackBody,
    finiteContract = null,
  ) {
    const routeFlexCondition = finiteContract?.routeFlexCondition || "C0";
    const localBody = { ...body, stream: false };
    delete localBody.stream_options;
    const provider = context.providers.local;
    const physical = physicalRequestScope(provider, context);
    let upstream;
    try {
      upstream = await fetchCompletion(provider, localBody, physical.fetchImpl, {
        signal: context.signal,
        timeoutMs: runtime.answerTimeoutMs,
        captureStore: physical.captureStore,
        captureMetadata: callMetadata(context, "local_agent", {
          route: finiteContract?.localRoute || "local",
          attempt_index: 1,
          fallback: false,
          ...(finiteContract?.captureMetadata || {}),
        }),
      });
    } catch (error) {
      await safeLog({
        event: "local_validation_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        validation_level: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
        error_code: safeErrorCode(error),
        fallback: true,
      });
      if (context.signal.aborted) return;
      return forwardCloud(fallbackBody, nodeResponse, context, finiteContract?.fallbackRoute || "cloud-fallback", {
        fallback: true,
        fallbackSchema: "full",
        captureMetadata: finiteContract?.captureMetadata,
      });
    }

    if (!upstream.ok) {
      const status = upstream.status;
      await discard(upstream);
      await safeLog({
        event: "local_validation_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        validation_level: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
        upstream_status: status,
        fallback: true,
      });
      if (context.signal.aborted) return;
      return forwardCloud(fallbackBody, nodeResponse, context, finiteContract?.fallbackRoute || "cloud-fallback", {
        fallback: true,
        fallbackSchema: "full",
        captureMetadata: finiteContract?.captureMetadata,
      });
    }

    let completion;
    try {
      completion = await readCompletionJson(upstream);
    } catch (error) {
      await safeLog({
        event: "local_validation_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        validation_level: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
        error_code: safeErrorCode(error),
        fallback: true,
      });
      if (context.signal.aborted) return;
      return forwardCloud(fallbackBody, nodeResponse, context, finiteContract?.fallbackRoute || "cloud-fallback", {
        fallback: true,
        fallbackSchema: "full",
        captureMetadata: finiteContract?.captureMetadata,
      });
    }

    let observedArgumentShape = classifyCompletionArguments(completion);
    const toolCalls = completion?.choices?.[0]?.message?.tool_calls;
    const actualToolName = Array.isArray(toolCalls) && toolCalls.length === 1
      ? toolCalls[0]?.function?.name ?? null
      : null;
    const actualRouteClass = routeClassForLocalTool(actualToolName);
    let effectiveRouteClass = finiteContract?.routeClass ?? null;
    let validationRequest = body;
    let reclassification = null;
    let derivedRouteClassAdmissible = null;
    if (finiteContract?.deriveRouteClassFromTool === true) {
      effectiveRouteClass = actualRouteClass;
      derivedRouteClassAdmissible =
        actualRouteClass !== null &&
        FSM_STANDARD_LOCAL_ROUTE_CLASSES.includes(actualRouteClass) &&
        finiteContract.admissibleLocalRouteClasses?.includes(actualRouteClass);
    } else if (
      finiteContract &&
      (routeFlexCondition === "C1" || routeFlexCondition === "C2") &&
      actualRouteClass &&
      actualRouteClass !== finiteContract.routeClass
    ) {
      const admissible =
        FSM_STANDARD_LOCAL_ROUTE_CLASSES.includes(actualRouteClass) &&
        finiteContract.fsmAdmissibleRouteClasses?.includes(actualRouteClass);
      reclassification = {
        attempted: true,
        route_flex_condition: routeFlexCondition,
        predicted_route_class: finiteContract.routeClass,
        effective_route_class: actualRouteClass,
        actual_tool_name: actualToolName,
        admissible,
      };
      if (admissible) {
        effectiveRouteClass = actualRouteClass;
        // C1 deliberately exposes only the predicted Tool schema to Local.
        // Reclassification therefore validates against the untouched full
        // request, while C2 would also pass against its visible union.
        validationRequest = fallbackBody;
      }
    }
    let baseContract = validateLocalCompletion(completion, validationRequest);
    let finiteValidation = baseContract.ok && finiteContract
      ? validateFiniteRouteCompletion(
          completion,
          effectiveRouteClass,
          finiteContract.routeState,
        )
      : null;
    let contract = finiteValidation && !finiteValidation.ok
      ? { ...baseContract, ok: false, reason: finiteValidation.reason }
      : baseContract;
    if (reclassification?.admissible === false) {
      contract = {
        ...contract,
        ok: false,
        reason: "actual_tool_route_class_not_fsm_admissible",
      };
    }
    if (finiteContract?.deriveRouteClassFromTool === true && !derivedRouteClassAdmissible) {
      contract = {
        ...contract,
        ok: false,
        reason: actualRouteClass === null
          ? "actual_tool_has_no_local_route_class"
          : "actual_tool_route_class_not_fsm_admissible",
      };
    }
    let repairEvidence = null;
    if (
      !contract.ok &&
      finiteContract?.repairEnabled === true
    ) {
      const proposal = compileStandardModerateRepair(
        completion,
        effectiveRouteClass,
        finiteContract.routeState,
      );
      const originalToolCalls = completion?.choices?.[0]?.message?.tool_calls;
      const originalCandidate = Array.isArray(originalToolCalls) &&
        originalToolCalls.length === 1
        ? originalToolCalls[0]
        : { tool_call_count: Array.isArray(originalToolCalls) ? originalToolCalls.length : null };
      await safeLog({
        event: "local_repair_attempted",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        predicted_route_class: prediction.route_class ?? null,
        effective_route_class: effectiveRouteClass,
        original_validation_reason: contract.reason,
        repair_policy_version: ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION,
        repair_reason: proposal.reason,
        original_candidate: originalCandidate,
        proposed_candidate: proposal.repaired_tool_call ?? null,
        deterministic_transformations: proposal.transformations ?? [],
      });
      if (proposal.ok) {
        const repairedBase = validateLocalCompletion(
          proposal.completion,
          validationRequest,
        );
        const repairedFinite = repairedBase.ok
          ? validateFiniteRouteCompletion(
              proposal.completion,
              effectiveRouteClass,
              finiteContract.routeState,
            )
          : null;
        const repairedContract = repairedFinite && !repairedFinite.ok
          ? { ...repairedBase, ok: false, reason: repairedFinite.reason }
          : repairedBase;
        const revalidation = Object.freeze({
          base_tool_schema: Object.freeze({
            ok: repairedBase.ok,
            reason: repairedBase.reason,
          }),
          finite_route_and_fsm_dependency: Object.freeze({
            ok: repairedFinite?.ok === true,
            reason: repairedFinite?.reason ?? null,
          }),
        });
        if (repairedContract.ok) {
          repairEvidence = Object.freeze({
            applied: true,
            policy_version: ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION,
            reason: proposal.reason,
            tool_name: proposal.tool_name,
            original_validation_reason: contract.reason,
            original_candidate: proposal.original_tool_call,
            repaired_candidate: proposal.repaired_tool_call,
            deterministic_transformations: proposal.transformations,
            revalidation,
          });
          completion = proposal.completion;
          observedArgumentShape = classifyCompletionArguments(completion);
          baseContract = repairedBase;
          finiteValidation = repairedFinite;
          contract = repairedContract;
          await safeLog({
            event: "local_repair_applied",
            request_id: context.requestId,
            virtual_model: context.virtualModel,
            predicted_route_class: prediction.route_class ?? null,
            effective_route_class: effectiveRouteClass,
            repair: repairEvidence,
            revalidation,
          });
        } else {
          await safeLog({
            event: "local_repair_rejected",
            request_id: context.requestId,
            virtual_model: context.virtualModel,
            predicted_route_class: prediction.route_class ?? null,
            effective_route_class: effectiveRouteClass,
            repair_policy_version: ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION,
            repair_reason: proposal.reason,
            original_candidate: proposal.original_tool_call,
            proposed_candidate: proposal.repaired_tool_call,
            deterministic_transformations: proposal.transformations,
            revalidation,
            rejection_reason: repairedContract.reason,
          });
        }
      } else {
        await safeLog({
          event: "local_repair_rejected",
          request_id: context.requestId,
          virtual_model: context.virtualModel,
          predicted_route_class: prediction.route_class ?? null,
          effective_route_class: effectiveRouteClass,
          repair_policy_version: ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION,
          repair_reason: proposal.reason,
          original_candidate: originalCandidate,
          proposed_candidate: null,
          deterministic_transformations: [],
          revalidation: null,
          rejection_reason: proposal.reason,
        });
      }
    }
    if (reclassification?.attempted === true) {
      const reclassificationEvidence = {
        ...reclassification,
        applied: contract.ok,
        base_tool_schema: {
          ok: baseContract.ok,
          reason: baseContract.reason,
        },
        finite_route_and_fsm_dependency: {
          ok: finiteValidation?.ok === true,
          reason: finiteValidation?.reason ?? null,
        },
        repair_applied: repairEvidence?.applied === true,
      };
      await safeLog({
        event: contract.ok
          ? "local_route_reclassification_applied"
          : "local_route_reclassification_rejected",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        ...reclassificationEvidence,
        rejection_reason: contract.ok ? null : contract.reason,
      });
    }
    if (!contract.ok) {
      await safeLog({
        event: "local_validation_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        predicted_args_class: prediction.args_class ?? null,
        predicted_route_class: prediction.route_class ?? null,
        effective_route_class: effectiveRouteClass,
        actual_tool_name: actualToolName,
        route_flex_condition: routeFlexCondition,
        route_class_reclassification: reclassification,
        observed_argument_shape: observedArgumentShape,
        validation_level: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
        validation_reason: contract.reason,
        fallback_schema: "full",
        fallback: true,
      });
      if (context.signal.aborted) return;
      return forwardCloud(fallbackBody, nodeResponse, context, finiteContract?.fallbackRoute || "cloud-fallback", {
        fallback: true,
        fallbackSchema: "full",
        captureMetadata: finiteContract?.captureMetadata,
      });
    }

    const successfulUiActions = finiteContract?.strongPathUiEntranceEnabled === true
      ? successfulResolvedUiActions(fallbackBody)
      : [];
    if (
      finiteContract?.strongPathUiEntranceEnabled === true &&
      UI_ACTION_TOOL_NAMES.has(actualToolName) &&
      successfulUiActions.length === 0
    ) {
      const checkEvidence = Object.freeze({
        check_version: STRONG_PATH_CHECK_VERSION,
        trigger: "first_validated_local_ui_action",
        candidate_tool_name: actualToolName,
        successful_ui_action_count_before: 0,
        route_state: finiteContract.routeState,
        base_tool_schema_valid: baseContract.ok === true,
        finite_route_and_fsm_dependency_valid: finiteValidation?.ok === true,
        repair_applied: repairEvidence?.applied === true,
      });
      await safeLog({
        event: "strong_path_check_applied",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        check: checkEvidence,
      });
      if (context.signal.aborted) return;
      return forwardCloud(
        strongPathCheckRequest(fallbackBody),
        nodeResponse,
        context,
        finiteContract.strongPathFallbackRoute || "cloud-router-binary-strong-path-check",
        {
          fallback: true,
          fallbackSchema: "full",
          captureMetadata: {
            ...(finiteContract.captureMetadata || {}),
            strong_path_check_applied: true,
            strong_path_check_version: STRONG_PATH_CHECK_VERSION,
            strong_path_check_trigger: "first_validated_local_ui_action",
            strong_path_local_candidate_tool: actualToolName,
          },
        },
      );
    }

    const successfulUiMutations = finiteContract?.cloudFirstUiMutationEnabled === true
      ? successfulResolvedUiMutations(fallbackBody)
      : [];
    if (
      finiteContract?.cloudFirstUiMutationEnabled === true &&
      UI_MUTATION_TOOL_NAMES.has(actualToolName) &&
      successfulUiMutations.length === 0
    ) {
      const gateEvidence = Object.freeze({
        gate_version: CLOUD_FIRST_UI_MUTATION_GATE_VERSION,
        candidate_tool_name: actualToolName,
        predicted_route_class: prediction.route_class ?? null,
        effective_route_class: effectiveRouteClass,
        successful_ui_mutation_count_before: 0,
        route_state: finiteContract.routeState,
        base_tool_schema_valid: baseContract.ok === true,
        finite_route_and_fsm_dependency_valid: finiteValidation?.ok === true,
        repair_applied: repairEvidence?.applied === true,
      });
      await safeLog({
        event: "cloud_first_ui_mutation_gate_triggered",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        gate: gateEvidence,
      });
      if (context.signal.aborted) return;
      return forwardCloud(
        fallbackBody,
        nodeResponse,
        context,
        "cloud-router-fsm-scoped-repair-cloud-first-first-ui-mutation",
        {
          fallback: true,
          fallbackSchema: "full",
          captureMetadata: {
            ...(finiteContract.captureMetadata || {}),
            cloud_first_gate_triggered: true,
            cloud_first_gate_version: CLOUD_FIRST_UI_MUTATION_GATE_VERSION,
            cloud_first_local_candidate_tool: actualToolName,
          },
        },
      );
    }

    let fsmTransitionExpectation = null;
    if (finiteContract?.fsmTransitionEnabled === true) {
      if (pendingFsmTransitions.has(context.sessionId)) {
        await safeLog({
          event: "local_validation_failed",
          request_id: context.requestId,
          virtual_model: context.virtualModel,
          predicted_route_class: prediction.route_class ?? null,
          validation_level: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
          validation_reason: "fsm_previous_transition_unresolved",
          fallback_schema: "full",
          fallback: true,
        });
        return forwardCloud(
          fallbackBody,
          nodeResponse,
          context,
          finiteContract.fallbackRoute,
          {
            fallback: true,
            fallbackSchema: "full",
            captureMetadata: finiteContract.captureMetadata,
          },
        );
      }
      const toolCall = completion?.choices?.[0]?.message?.tool_calls?.[0];
      fsmTransitionExpectation = createFsmTransitionExpectation(
        effectiveRouteClass,
        toolCall,
        finiteContract.routeState,
      );
      pendingFsmTransitions.set(context.sessionId, fsmTransitionExpectation);
      await safeLog({
        event: "fsm_transition_pending",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route_policy_version:
          finiteContract.policyVersion || ROUTER_FSM_SCOPED_POLICY_VERSION,
        transition_expectation: fsmTransitionExpectation,
      });
    }

    const localRoute = finiteContract?.localRoute || "local";
    const headers = routeHeaders(context.requestId, localRoute, {
      "x-clawmobile-fallback": false,
      "x-clawmobile-argument-shape": observedArgumentShape,
        "x-clawmobile-validation-level": contract.validationLevel,
        "x-clawmobile-parameter-schema-applied": contract.parameterSchemaApplied,
        "x-clawmobile-repair-applied": repairEvidence?.applied === true,
    });
    await safeLog({
      event: "request_routed",
      request_id: context.requestId,
      virtual_model: context.virtualModel,
      route: localRoute,
      provider_id: provider.id,
      model: provider.model,
      predicted_args_class: prediction.args_class ?? null,
      predicted_route_class: prediction.route_class ?? null,
      effective_route_class: effectiveRouteClass,
      actual_tool_name: actualToolName,
      route_flex_condition: routeFlexCondition,
      route_class_reclassified: reclassification?.attempted === true,
      route_class_derived_from_tool:
        finiteContract?.deriveRouteClassFromTool === true,
      observed_argument_shape: observedArgumentShape,
      validation_level: contract.validationLevel,
      parameter_schema_applied: contract.parameterSchemaApplied,
      tool_count: Array.isArray(localBody.tools) ? localBody.tools.length : 0,
      scoped_context_version:
        finiteContract?.scopedContextVersion || null,
      fsm_transition_expectation: fsmTransitionExpectation,
      repair: repairEvidence,
      fallback: false,
    });
    if (body.stream) {
      const rawSse = synthesizeCompletionSse(nodeResponse, completion, headers);
      await context.captureStore.captureDerivedResponse(
        callMetadata(context, "local_agent_downstream", {
          route: localRoute,
          validation_level: contract.validationLevel,
          parameter_schema_applied: contract.parameterSchemaApplied,
          source_format: "json",
          downstream_format: "sse",
          repair_policy_version: repairEvidence?.policy_version ?? null,
          repair_applied: repairEvidence?.applied === true,
          repair_reason: repairEvidence?.reason ?? null,
          ...(finiteContract?.captureMetadata || {}),
        }),
        rawSse,
      );
    } else {
      sendJson(nodeResponse, 200, completion, headers);
    }
  }

  async function handleBinaryToolRouter(body, nodeResponse, context, options = {}) {
    const uiEffectAware = options.uiEffectAware === true;
    const strongPathCheckEnabled = options.strongPathCheckEnabled === true;
    const routeLabel = options.routeLabel || "binary-tool";
    const routeState = deriveRouteState(body, {
      uiEffectPolicy: uiEffectAware ? UI_EFFECT_AWARE_POLICY_VERSION : "legacy",
    });
    async function forwardBinaryCloud(requestBody, route, extras = {}) {
      const shouldApplyStrongPathCheck = strongPathCheckEnabled &&
        successfulResolvedUiActions(requestBody).length === 0;
      const captureMetadata = {
        ...(extras.captureMetadata || {}),
        ui_effect_policy_version: routeState.ui_effect_policy_version,
        strong_path_check_enabled: strongPathCheckEnabled,
        ...(shouldApplyStrongPathCheck
          ? {
              strong_path_check_applied: true,
              strong_path_check_version: STRONG_PATH_CHECK_VERSION,
              strong_path_check_trigger: "cloud_before_first_ui_action",
            }
          : {}),
      };
      if (shouldApplyStrongPathCheck) {
        await safeLog({
          event: "strong_path_check_applied",
          request_id: context.requestId,
          virtual_model: context.virtualModel,
          check: {
            check_version: STRONG_PATH_CHECK_VERSION,
            trigger: "cloud_before_first_ui_action",
            successful_ui_action_count_before: 0,
            route_state: routeState,
          },
        });
      }
      return forwardCloud(
        shouldApplyStrongPathCheck ? strongPathCheckRequest(requestBody) : requestBody,
        nodeResponse,
        context,
        route,
        { ...extras, captureMetadata },
      );
    }
    let fsmTransitionResolution = null;
    if (pendingFsmTransitions.has(context.sessionId)) {
      const expectation = pendingFsmTransitions.get(context.sessionId);
      const validation = validateFsmTransitionExpectation(
        expectation,
        routeState,
      );
      pendingFsmTransitions.delete(context.sessionId);
      fsmTransitionResolution = Object.freeze({
        expectation,
        observed_transition: routeState.last_transition,
        target_phase: routeState.phase,
        ok: validation.ok,
        reason: validation.reason,
      });
      await safeLog({
        event: "fsm_transition_resolved",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
        transition_resolution: fsmTransitionResolution,
      });
    }

    const fsmForcedCloudHandoff = fsmTransitionResolution?.ok === false;
    const fsmAdmissibleClasses = fsmAdmissibleRouteClasses(routeState, {
      forceCloud: fsmForcedCloudHandoff,
    });
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const hardGuardReason = toolCount === 0
      ? "no_available_tools"
      : body.tool_choice === "none"
        ? "tool_choice_none"
        : fsmForcedCloudHandoff
          ? "failed_fsm_transition"
          : null;
    let routerInput = null;
    if (hardGuardReason === null) {
      try {
        routerInput = compileBinaryRouterInput(body, routeState);
      } catch (error) {
        await safeLog({
          event: "router_failed",
          request_id: context.requestId,
          virtual_model: context.virtualModel,
          route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
          route_state: routeState,
          error_code: `binary_context_compile_failed:${safeErrorCode(error)}`,
          fallback: "cloud-full",
        });
        return forwardBinaryCloud(
          body,
          `cloud-router-${routeLabel}-context-fallback`,
          {
            fallback: true,
            captureMetadata: {
              route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
              route_state: routeState,
              fsm_admissible_route_classes: fsmAdmissibleClasses,
              fsm_transition_resolution: fsmTransitionResolution,
            },
          },
        );
      }
    }
    const admissibleLocalRouteClasses =
      routerInput?.decision_context?.admissible_local_route_classes || [];
    const localToolUnion =
      routerInput?.decision_context?.local_tool_union || [];
    const effectiveHardGuardReason = hardGuardReason ||
      (localToolUnion.length === 0 ? "no_fsm_admissible_local_tool" : null);
    if (effectiveHardGuardReason) {
      const captureMetadata = {
        route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
        predicted_binary_route: "CLOUD_REQUIRED",
        binary_router_invoked: false,
        static_guard_passed: false,
        static_guard_reason: effectiveHardGuardReason,
        route_state: routeState,
        scoped_context_version: COARSE_LOCAL_CONTEXT_VERSION,
        fsm_admissible_route_classes: fsmAdmissibleClasses,
        admissible_local_route_classes: admissibleLocalRouteClasses,
        local_visible_tools: localToolUnion,
        fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
        fsm_transition_resolution: fsmTransitionResolution,
      };
      await safeLog({
        event: "router_decision",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        helper_invoked: false,
        helper_skip_reason: effectiveHardGuardReason,
        ...captureMetadata,
        final_backend: "cloud",
        tool_count_before: toolCount,
        tool_count_after: toolCount,
      });
      return forwardBinaryCloud(
        body,
        `cloud-router-${routeLabel}-hard-guard`,
        { captureMetadata },
      );
    }

    const provider = context.providers.decision;
    const physical = physicalRequestScope(provider, context);
    let helperRun;
    try {
      helperRun = await getBinaryRoutePredictionWithRetry(
        routerInput,
        provider,
        physical.fetchImpl,
        {
          signal: context.signal,
          timeoutMs: runtime.strategyTimeoutMs,
          captureStore: physical.captureStore,
          captureMetadata: callMetadata(context, "router_helper", {
            route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
            route_state: routeState,
            fsm_admissible_route_classes: fsmAdmissibleClasses,
            admissible_local_route_classes: admissibleLocalRouteClasses,
            local_visible_tools: localToolUnion,
            fsm_transition_resolution: fsmTransitionResolution,
          }),
        },
      );
      helperRun = queueAdjustedHelperRun(helperRun, physical.audit);
    } catch (error) {
      queueAdjustedHelperError(error, physical.audit);
      await safeLog({
        event: "router_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
        route_state: routeState,
        ...(error?.helperTelemetry || {}),
        error_code: safeErrorCode(error),
        fallback: "cloud-full",
      });
      if (context.signal.aborted) return;
      return forwardBinaryCloud(
        body,
        `cloud-router-${routeLabel}-helper-fallback`,
        {
          fallback: true,
          captureMetadata: {
            route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
            predicted_binary_route: null,
            binary_router_invoked: true,
            route_state: routeState,
            fsm_admissible_route_classes: fsmAdmissibleClasses,
            admissible_local_route_classes: admissibleLocalRouteClasses,
            local_visible_tools: localToolUnion,
            fsm_transition_resolution: fsmTransitionResolution,
          },
        },
      );
    }

    const prediction = helperRun.prediction;
    const selectedLocal = prediction.route === "LOCAL_UI_CANDIDATE";
    let compiledLocal = null;
    let staticGuardPassed = selectedLocal;
    let staticGuardReason = selectedLocal
      ? "finite_local_tool_union_available"
      : "binary_router_selected_cloud";
    if (selectedLocal) {
      try {
        compiledLocal = compileCoarseLocalRequest(body, routeState);
      } catch (error) {
        staticGuardPassed = false;
        staticGuardReason = `local_context_compile_failed:${safeErrorCode(error)}`;
      }
    }
    const captureMetadata = {
      route_policy_version: COARSE_TO_FINE_POLICY_VERSION,
      predicted_binary_route: prediction.route,
      binary_router_invoked: true,
      static_guard_passed: staticGuardPassed,
      static_guard_reason: staticGuardReason,
      route_state: routeState,
      scoped_context_version: COARSE_LOCAL_CONTEXT_VERSION,
      fsm_admissible_route_classes: fsmAdmissibleClasses,
      admissible_local_route_classes: admissibleLocalRouteClasses,
      local_visible_tools: localToolUnion,
      fsm_forced_cloud_handoff: false,
      fsm_transition_resolution: fsmTransitionResolution,
    };
    await safeLog({
      event: "router_decision",
      request_id: context.requestId,
      virtual_model: context.virtualModel,
      helper_invoked: true,
      ...helperRun.telemetry,
      ...captureMetadata,
      final_backend: staticGuardPassed ? "local" : "cloud",
      tool_count_before: toolCount,
      tool_count_after: staticGuardPassed
        ? compiledLocal.request.tools.length
        : toolCount,
    });
    if (!staticGuardPassed) {
      return forwardBinaryCloud(
        body,
        selectedLocal
          ? `cloud-router-${routeLabel}-static-fallback`
          : `cloud-router-${routeLabel}`,
        {
          fallback: selectedLocal,
          captureMetadata,
        },
      );
    }

    return forwardLocalCandidate(
      compiledLocal.request,
      nodeResponse,
      context,
      { route_class: null, binary_route: prediction.route },
      body,
      {
        routeClass: null,
        routeState,
        localRoute: `local-router-${routeLabel}`,
        fallbackRoute: `cloud-router-${routeLabel}-local-validation-fallback`,
        captureMetadata,
        scopedContextVersion: COARSE_LOCAL_CONTEXT_VERSION,
        fsmTransitionEnabled: true,
        repairEnabled: true,
        deriveRouteClassFromTool: true,
        admissibleLocalRouteClasses,
        policyVersion: COARSE_TO_FINE_POLICY_VERSION,
        strongPathUiEntranceEnabled: strongPathCheckEnabled,
        strongPathFallbackRoute: `cloud-router-${routeLabel}-ui-entrance-check`,
      },
    );
  }

  async function handleExplicitBinaryToolRouter(body, nodeResponse, context) {
    const routeState = deriveRouteState(body);
    let fsmTransitionResolution = null;
    if (pendingFsmTransitions.has(context.sessionId)) {
      const expectation = pendingFsmTransitions.get(context.sessionId);
      const validation = validateFsmTransitionExpectation(
        expectation,
        routeState,
      );
      pendingFsmTransitions.delete(context.sessionId);
      fsmTransitionResolution = Object.freeze({
        expectation,
        observed_transition: routeState.last_transition,
        target_phase: routeState.phase,
        ok: validation.ok,
        reason: validation.reason,
      });
      await safeLog({
        event: "fsm_transition_resolved",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route_policy_version: EXPLICIT_BINARY_TOOL_POLICY_VERSION,
        transition_resolution: fsmTransitionResolution,
      });
    }

    const postMutationReobserveCloudHandoff =
      fsmTransitionResolution?.ok === true &&
      fsmTransitionResolution?.expectation?.route_class === "OBSERVE_UI_RAW" &&
      fsmTransitionResolution?.expectation?.source_phase === "VERIFY_PENDING";
    const fsmForcedCloudHandoff =
      fsmTransitionResolution?.ok === false ||
      postMutationReobserveCloudHandoff;
    const forceCloudReason = fsmTransitionResolution?.ok === false
      ? "failed_fsm_transition"
      : postMutationReobserveCloudHandoff
        ? "post_mutation_reobserve_requires_cloud_interpretation"
        : null;
    const fsmAdmissibleClasses = fsmAdmissibleRouteClasses(routeState, {
      forceCloud: fsmForcedCloudHandoff,
    });
    const decision = deriveExplicitBinaryToolDecision(body, routeState, {
      forceCloud: fsmForcedCloudHandoff,
      forceCloudReason,
    });
    const selectedLocal = decision.route === "LOCAL_EXACT_TOOL";
    let compiledLocal = null;
    let compileError = null;
    if (selectedLocal) {
      try {
        compiledLocal = compileExplicitLocalRequest(body, decision);
      } catch (error) {
        compileError = safeErrorCode(error);
      }
    }
    const finalLocal = selectedLocal && compiledLocal !== null;
    const admissibleLocalRouteClasses = selectedLocal
      ? [decision.route_class]
      : [];
    const localVisibleTools = selectedLocal
      ? [decision.exact_tool_name]
      : [];
    const captureMetadata = {
      route_policy_version: EXPLICIT_BINARY_TOOL_POLICY_VERSION,
      predicted_binary_route: decision.route,
      predicted_route_class: decision.route_class,
      selected_exact_tool: decision.exact_tool_name,
      deterministic_policy_invoked: true,
      binary_router_invoked: false,
      static_guard_passed: finalLocal,
      static_guard_reason: compileError
        ? `local_context_compile_failed:${compileError}`
        : decision.reason,
      route_state: routeState,
      scoped_context_version: COARSE_LOCAL_CONTEXT_VERSION,
      fsm_admissible_route_classes: fsmAdmissibleClasses,
      admissible_local_route_classes: admissibleLocalRouteClasses,
      local_visible_tools: localVisibleTools,
      fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
      post_mutation_reobserve_cloud_handoff: postMutationReobserveCloudHandoff,
      fsm_transition_resolution: fsmTransitionResolution,
    };
    await safeLog({
      event: "router_decision",
      request_id: context.requestId,
      virtual_model: context.virtualModel,
      helper_invoked: false,
      helper_skip_reason: "deterministic_fsm_exact_tool_policy",
      ...captureMetadata,
      final_backend: finalLocal ? "local" : "cloud",
      tool_count_before: Array.isArray(body.tools) ? body.tools.length : 0,
      tool_count_after: finalLocal ? 1 : Array.isArray(body.tools) ? body.tools.length : 0,
    });

    if (!finalLocal) {
      return forwardCloud(
        body,
        nodeResponse,
        context,
        selectedLocal
          ? "cloud-router-explicit-binary-tool-context-fallback"
          : "cloud-router-explicit-binary-tool",
        {
          fallback: selectedLocal,
          captureMetadata,
        },
      );
    }

    return forwardLocalCandidate(
      compiledLocal.request,
      nodeResponse,
      context,
      {
        route_class: decision.route_class,
        binary_route: decision.route,
      },
      body,
      {
        routeClass: decision.route_class,
        routeState,
        localRoute: "local-router-explicit-binary-tool",
        fallbackRoute:
          "cloud-router-explicit-binary-tool-local-validation-fallback",
        captureMetadata,
        scopedContextVersion: COARSE_LOCAL_CONTEXT_VERSION,
        fsmTransitionEnabled: true,
        repairEnabled: true,
        deriveRouteClassFromTool: false,
        admissibleLocalRouteClasses,
        policyVersion: EXPLICIT_BINARY_TOOL_POLICY_VERSION,
      },
    );
  }

  async function handleFiniteRouter(body, nodeResponse, context, strategy) {
    const routeState = deriveRouteState(body);
    const routeFlexCondition = strategy === "router-fsm-scoped-repair-c1"
      ? "C1"
      : strategy === "router-fsm-scoped-repair-c2"
        ? "C2"
        : "C0";
    const scopedContextEnabled =
      strategy === "router-rm-scoped" ||
      strategy === "router-fsm-scoped" ||
      strategy === "router-fsm-scoped-repair" ||
      strategy === "router-fsm-scoped-repair-cloud-first" ||
      strategy === "router-fsm-scoped-repair-c1" ||
      strategy === "router-fsm-scoped-repair-c2";
    const fsmControlEnabled =
      strategy === "router-fsm-scoped" ||
      strategy === "router-fsm-scoped-repair" ||
      strategy === "router-fsm-scoped-repair-cloud-first" ||
      strategy === "router-fsm-scoped-repair-c1" ||
      strategy === "router-fsm-scoped-repair-c2";
    const repairEnabled =
      strategy === "router-fsm-scoped-repair" ||
      strategy === "router-fsm-scoped-repair-cloud-first" ||
      strategy === "router-fsm-scoped-repair-c1" ||
      strategy === "router-fsm-scoped-repair-c2";
    const policyVersion = strategy === "router-r1"
      ? ROUTER_R1_POLICY_VERSION
      : strategy === "router-r2"
        ? ROUTER_R2_POLICY_VERSION
        : strategy === "router-rm-scoped"
          ? ROUTER_RM_SCOPED_POLICY_VERSION
          : strategy === "router-fsm-scoped"
            ? ROUTER_FSM_SCOPED_POLICY_VERSION
            : repairEnabled
              ? ROUTER_FSM_SCOPED_REPAIR_POLICY_VERSION
            : ROUTER_RM_POLICY_VERSION;
    const policyPrefix = strategy === "router-r1"
      ? "r1"
      : strategy === "router-r2"
        ? "r2"
        : strategy === "router-rm-scoped"
          ? "rm-scoped"
          : strategy === "router-fsm-scoped"
            ? "fsm-scoped"
            : repairEnabled
              ? "fsm-scoped-repair"
            : "rm";
    let fsmTransitionResolution = null;
    if (fsmControlEnabled && pendingFsmTransitions.has(context.sessionId)) {
      const expectation = pendingFsmTransitions.get(context.sessionId);
      const validation = validateFsmTransitionExpectation(
        expectation,
        routeState,
      );
      pendingFsmTransitions.delete(context.sessionId);
      fsmTransitionResolution = Object.freeze({
        expectation,
        observed_transition: routeState.last_transition,
        target_phase: routeState.phase,
        ok: validation.ok,
        reason: validation.reason,
      });
      await safeLog({
        event: "fsm_transition_resolved",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route_policy_version: policyVersion,
        transition_resolution: fsmTransitionResolution,
      });
    }
    const fsmForcedCloudHandoff =
      fsmControlEnabled && fsmTransitionResolution?.ok === false;
    const fsmAdmissibleClasses = fsmControlEnabled
      ? fsmAdmissibleRouteClasses(routeState, {
          forceCloud: fsmForcedCloudHandoff,
        })
      : null;
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const bypassReason = toolCount === 0
      ? "no_available_tools"
      : body.tool_choice === "none"
        ? "tool_choice_none"
        : null;
    if (bypassReason) {
      const captureMetadata = {
        route_policy_version: policyVersion,
        predicted_route_class: "CLOUD",
        route_reason_code: "NO_AVAILABLE_TOOLS",
        static_guard_passed: false,
        route_state: routeState,
        scoped_context_version:
          scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
        fsm_admissible_route_classes: fsmAdmissibleClasses,
        fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
        fsm_transition_resolution: fsmTransitionResolution,
      };
      await safeLog({
        event: "router_decision",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        helper_invoked: false,
        helper_skip_reason: bypassReason,
        route_policy_version: policyVersion,
        predicted_route_class: "CLOUD",
        route_reason_code: "NO_AVAILABLE_TOOLS",
        static_guard_passed: false,
        static_guard_reason: bypassReason,
        final_backend: "cloud",
        tool_count_before: toolCount,
        tool_count_after: toolCount,
        route_state: routeState,
        scoped_context_version:
          scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
        fsm_admissible_route_classes: fsmAdmissibleClasses,
        fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
        fsm_transition_resolution: fsmTransitionResolution,
      });
      return forwardCloud(
        body,
        nodeResponse,
        context,
        `cloud-router-${policyPrefix}-bypass`,
        { captureMetadata },
      );
    }

    let helperRun;
    const provider = context.providers.decision;
    const physical = physicalRequestScope(provider, context);
    try {
      helperRun = await getRouteClassPredictionWithRetry(
        body,
        routeState,
        strategy,
        provider,
        physical.fetchImpl,
        {
          signal: context.signal,
          timeoutMs: runtime.strategyTimeoutMs,
          captureStore: physical.captureStore,
          captureMetadata: callMetadata(context, "router_helper", {
            route_policy_version: policyVersion,
            route_state: routeState,
            scoped_context_version:
              scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
            fsm_admissible_route_classes: fsmAdmissibleClasses,
            fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
            fsm_transition_resolution: fsmTransitionResolution,
          }),
          admissibleRouteClasses: fsmAdmissibleClasses,
        },
      );
      helperRun = queueAdjustedHelperRun(helperRun, physical.audit);
    } catch (error) {
      queueAdjustedHelperError(error, physical.audit);
      await safeLog({
        event: "router_failed",
        request_id: context.requestId,
        virtual_model: context.virtualModel,
        route_policy_version: policyVersion,
        route_state: routeState,
        ...(error?.helperTelemetry || {}),
        error_code: safeErrorCode(error),
        fallback: "cloud-full",
      });
      if (context.signal.aborted) return;
      return forwardCloud(
        body,
        nodeResponse,
        context,
        `cloud-router-${policyPrefix}-helper-fallback`,
        {
          fallback: true,
          captureMetadata: {
            route_policy_version: policyVersion,
            predicted_route_class: null,
            route_reason_code: null,
            static_guard_passed: false,
            route_state: routeState,
            scoped_context_version:
              scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
            fsm_admissible_route_classes: fsmAdmissibleClasses,
            fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
            fsm_transition_resolution: fsmTransitionResolution,
          },
        },
      );
    }

    const prediction = helperRun.prediction;
    const requestedLocal = scopedContextEnabled
      ? FSM_STANDARD_LOCAL_ROUTE_CLASSES.includes(prediction.route_class)
      : isLocalRouteClass(prediction.route_class);
    const allowedTools = allowedToolsForRouteClass(
      prediction.route_class,
      routeState,
    );
    const availableNames = new Set(
      (Array.isArray(body.tools) ? body.tools : [])
        .map((tool) => tool?.function?.name)
        .filter((name) => typeof name === "string"),
    );
    const admissibleLocalRouteClasses = fsmControlEnabled
      ? fsmAdmissibleClasses.filter(
          (routeClass) =>
            FSM_STANDARD_LOCAL_ROUTE_CLASSES.includes(routeClass) &&
            allowedToolsForRouteClass(routeClass, routeState).some(
              (name) => availableNames.has(name),
            ),
        )
      : [];
    const toolsByRouteClass = Object.fromEntries(
      admissibleLocalRouteClasses.map((routeClass) => [
        routeClass,
        allowedToolsForRouteClass(routeClass, routeState).filter(
          (name) => availableNames.has(name),
        ),
      ]),
    );
    const localVisibleTools = routeFlexCondition === "C2"
      ? [...new Set(admissibleLocalRouteClasses.flatMap(
          (routeClass) => toolsByRouteClass[routeClass],
        ))]
      : allowedTools;
    let staticGuardPassed =
      requestedLocal &&
      allowedTools.length > 0 &&
      allowedTools.some((name) => availableNames.has(name)) &&
      localVisibleTools.length > 0;
    let staticGuardReason = requestedLocal
      ? staticGuardPassed
        ? "finite_contract_available"
        : "finite_contract_unavailable_or_dependency_stale"
      : "router_selected_cloud";
    let localBody = null;
    if (staticGuardPassed) {
      try {
        localBody = applyToolWhitelist(body, localVisibleTools);
        if (!Array.isArray(localBody.tools) || localBody.tools.length === 0) {
          staticGuardPassed = false;
          staticGuardReason = "finite_tool_not_present";
        } else if (scopedContextEnabled) {
          const exactScopedTools = localBody.tools.map(
            (tool) => tool?.function?.name,
          );
          localBody = compileScopedLocalRequest(localBody, {
            routeClass: prediction.route_class,
            routeState,
            allowedTools: exactScopedTools,
            admissibleRouteClasses:
              routeFlexCondition === "C2"
                ? admissibleLocalRouteClasses
                : null,
            toolsByRouteClass:
              routeFlexCondition === "C2" ? toolsByRouteClass : null,
          });
        }
      } catch (error) {
        staticGuardPassed = false;
        staticGuardReason = scopedContextEnabled
          ? `scoped_context_compile_failed:${safeErrorCode(error)}`
          : "explicit_tool_choice_outside_finite_contract";
      }
    }
    const finalBackend = staticGuardPassed ? "local" : "cloud";
    const captureMetadata = {
      route_policy_version: policyVersion,
      predicted_route_class: prediction.route_class,
      route_reason_code: prediction.reason_code,
      static_guard_passed: staticGuardPassed,
      static_guard_reason: staticGuardReason,
      route_state: routeState,
      scoped_context_version:
        scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
      fsm_admissible_route_classes: fsmAdmissibleClasses,
      fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
      fsm_transition_resolution: fsmTransitionResolution,
      route_flex_condition: routeFlexCondition,
      admissible_local_route_classes: admissibleLocalRouteClasses,
      local_visible_tools: localVisibleTools,
    };
    await safeLog({
      event: "router_decision",
      request_id: context.requestId,
      virtual_model: context.virtualModel,
      helper_invoked: true,
      ...helperRun.telemetry,
      route_policy_version: policyVersion,
      predicted_route_class: prediction.route_class,
      route_reason_code: prediction.reason_code,
      static_guard_passed: staticGuardPassed,
      static_guard_reason: staticGuardReason,
      allowed_local_tools: allowedTools,
      final_backend: finalBackend,
      tool_count_before: toolCount,
      tool_count_after: Array.isArray(localBody?.tools) ? localBody.tools.length : toolCount,
      route_state: routeState,
      scoped_context_version:
        scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
      fsm_admissible_route_classes: fsmAdmissibleClasses,
      fsm_forced_cloud_handoff: fsmForcedCloudHandoff,
      fsm_transition_resolution: fsmTransitionResolution,
      route_flex_condition: routeFlexCondition,
      admissible_local_route_classes: admissibleLocalRouteClasses,
      local_visible_tools: localVisibleTools,
    });
    if (!staticGuardPassed) {
      return forwardCloud(
        body,
        nodeResponse,
        context,
        `cloud-router-${policyPrefix}`,
        { captureMetadata },
      );
    }
    return forwardLocalCandidate(
      localBody,
      nodeResponse,
      context,
      prediction,
      body,
      {
        routeClass: prediction.route_class,
        routeState,
        localRoute: `local-router-${policyPrefix}`,
        fallbackRoute: `cloud-router-${policyPrefix}-local-validation-fallback`,
        captureMetadata,
        scopedContextVersion:
          scopedContextEnabled ? SCOPED_LOCAL_CONTEXT_VERSION : null,
        fsmTransitionEnabled: fsmControlEnabled,
        repairEnabled,
        routeFlexCondition,
        fsmAdmissibleRouteClasses: fsmAdmissibleClasses,
        cloudFirstUiMutationEnabled:
          strategy === "router-fsm-scoped-repair-cloud-first",
      },
    );
  }

  async function handleChat(body, nodeResponse, context) {
    if (
      context.virtualModel === "experiment" &&
      context.strategy === null
    ) {
      throw new HttpError(
        400,
        "model experiment requires an approved experiment strategy",
        "experiment_strategy_not_configured",
      );
    }
    const strategy =
      context.virtualModel === "experiment"
        ? context.strategy
        : context.virtualModel;
    switch (strategy) {
      case "cloud-full":
        return forwardCloud(body, nodeResponse, context, "cloud");

      case "local-full":
        return forwardLocalOnly(body, nodeResponse, context);

      case "filter": {
        const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
        const bypassReason =
          toolCount === 0
            ? "no_available_tools"
            : body.tool_choice === "none"
              ? "tool_choice_none"
              : null;
        if (bypassReason) {
          await safeLog({
            event: "tool_filter_decision",
            request_id: context.requestId,
            virtual_model: context.virtualModel,
            helper_invoked: false,
            helper_skip_reason: bypassReason,
            tool_count_before: toolCount,
            tool_count_after: toolCount,
            filter_succeeded: true,
          });
          return forwardCloud(body, nodeResponse, context, "filter-bypass");
        }

        let filtered = body;
        let helperRun = null;
        let fullSchemaFallback = false;
        const provider = context.providers.decision;
        const physical = physicalRequestScope(provider, context);
        try {
          helperRun = await getDecisionPredictionWithRetry(
            body,
            provider,
            physical.fetchImpl,
            {
              signal: context.signal,
              timeoutMs: runtime.strategyTimeoutMs,
              constrainOutput: true,
              disableThinking: false,
              captureStore: physical.captureStore,
              captureMetadata: callMetadata(context, "filter_helper"),
            },
          );
          helperRun = queueAdjustedHelperRun(helperRun, physical.audit);
          filtered = applyToolWhitelist(body, helperRun.prediction.tools);
        } catch (error) {
          queueAdjustedHelperError(error, physical.audit);
          helperRun = null;
          fullSchemaFallback = true;
          await safeLog({
            event: "filter_failed",
            request_id: context.requestId,
            virtual_model: context.virtualModel,
            ...(error?.helperTelemetry || {}),
            error_code: safeErrorCode(error),
            fallback: "full_tool_schema",
          });
        }
        await safeLog({
          event: "tool_filter_decision",
          request_id: context.requestId,
          virtual_model: context.virtualModel,
          helper_invoked: true,
          ...(helperRun?.telemetry || {}),
          k: helperRun?.prediction.k ?? null,
          predicted_tools: helperRun?.prediction.tools ?? null,
          predicted_tool_count: helperRun?.prediction.tools.length ?? null,
          predicted_args_class: helperRun?.prediction.args_class ?? null,
          tool_count_before: toolCount,
          tool_count_after: Array.isArray(filtered.tools) ? filtered.tools.length : 0,
          filter_succeeded: helperRun !== null,
          fallback: fullSchemaFallback,
          fallback_schema: fullSchemaFallback ? "full_tool_schema" : null,
        });
        return forwardCloud(
          filtered,
          nodeResponse,
          context,
          fullSchemaFallback ? "filter-full-schema-fallback" : "filter",
          {
            fallback: fullSchemaFallback,
            fallbackSchema: fullSchemaFallback ? "full_tool_schema" : undefined,
          },
        );
      }

      case "router": {
        const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
        const bypassReason =
          toolCount === 0
            ? "no_available_tools"
            : body.tool_choice === "none"
              ? "tool_choice_none"
              : null;
        if (bypassReason) {
          await safeLog({
            event: "router_decision",
            request_id: context.requestId,
            virtual_model: context.virtualModel,
            helper_invoked: false,
            helper_skip_reason: bypassReason,
            final_backend: "cloud",
            tool_count_before: toolCount,
            tool_count_after: toolCount,
          });
          return forwardCloud(body, nodeResponse, context, "cloud-router-bypass");
        }

        let helperRun;
        const provider = context.providers.decision;
        const physical = physicalRequestScope(provider, context);
        try {
          helperRun = await getDecisionPredictionWithRetry(
            body,
            provider,
            physical.fetchImpl,
            {
              signal: context.signal,
              timeoutMs: runtime.strategyTimeoutMs,
              constrainOutput: true,
              disableThinking: false,
              captureStore: physical.captureStore,
              captureMetadata: callMetadata(context, "router_helper"),
            },
          );
          helperRun = queueAdjustedHelperRun(helperRun, physical.audit);
        } catch (error) {
          queueAdjustedHelperError(error, physical.audit);
          await safeLog({
            event: "router_failed",
            request_id: context.requestId,
            virtual_model: context.virtualModel,
            ...(error?.helperTelemetry || {}),
            error_code: safeErrorCode(error),
            fallback: "cloud-full",
          });
          if (context.signal.aborted) return;
          return forwardCloud(body, nodeResponse, context, "cloud-router-fallback", {
            fallback: true,
          });
        }

        const prediction = helperRun.prediction;
        const finalBackend =
          prediction.args_class === "COMPLEX_ARGS" ? "cloud" : "local";
        await safeLog({
          event: "router_decision",
          request_id: context.requestId,
          virtual_model: context.virtualModel,
          helper_invoked: true,
          ...helperRun.telemetry,
          k: prediction.k,
          predicted_tools: prediction.tools,
          predicted_tool_count: prediction.tools.length,
          predicted_args_class: prediction.args_class,
          final_backend: finalBackend,
          tool_count_before: toolCount,
          tool_count_after: toolCount,
        });
        if (finalBackend === "cloud") {
          return forwardCloud(body, nodeResponse, context, "cloud-router-complex");
        }
        return forwardLocalCandidate(
          body,
          nodeResponse,
          context,
          prediction,
          body,
        );
      }

      case "router-r1":
      case "router-r2":
      case "router-rm":
      case "router-rm-scoped":
      case "router-fsm-scoped":
      case "router-fsm-scoped-repair":
      case "router-fsm-scoped-repair-cloud-first":
      case "router-fsm-scoped-repair-c1":
      case "router-fsm-scoped-repair-c2":
        return handleFiniteRouter(body, nodeResponse, context, strategy);

      case "router-binary-tool":
        return handleBinaryToolRouter(body, nodeResponse, context);

      case "router-binary-tool-effect-aware":
        return handleBinaryToolRouter(body, nodeResponse, context, {
          uiEffectAware: true,
          routeLabel: "binary-tool-effect-aware",
        });

      case "router-binary-tool-effect-aware-strong-path-check":
        return handleBinaryToolRouter(body, nodeResponse, context, {
          uiEffectAware: true,
          strongPathCheckEnabled: true,
          routeLabel: "binary-tool-effect-aware-strong-path-check",
        });

      case "router-explicit-binary-tool":
        return handleExplicitBinaryToolRouter(body, nodeResponse, context);

      default:
        throw new HttpError(400, "Unknown virtual model", "unknown_virtual_model");
    }
  }

  function requestProfile(virtualModel, sessionId) {
    if (virtualModel !== "experiment" || !runtime.v4Enabled) {
      return Object.freeze({
        armId: virtualModel === "experiment" ? runtime.armId : virtualModel,
        strategy: virtualModel === "experiment" ? runtime.activeStrategy : virtualModel,
        providers: Object.freeze({
          decision: runtime.decision,
          cloud: runtime.cloud,
          local: runtime.local,
        }),
      });
    }
    const registration = runRegistrations.get(sessionId);
    if (!registration) {
      throw new HttpError(
        409,
        "experiment run must be registered with an approved v4 arm before inference",
        "experiment_run_not_registered",
      );
    }
    const profile = runtime.v4Profiles[registration.armId];
    if (!profile) {
      throw new HttpError(500, "registered v4 arm has no runtime profile", "router_error");
    }
    return Object.freeze({
      armId: profile.armId,
      strategy: profile.strategy,
      providers: Object.freeze({
        decision: profile.decision,
        cloud: profile.cloud,
        local: profile.local,
      }),
    });
  }

  const handler = async (request, response) => {
    const requestId = requestIdFrom(request);
    const url = new URL(request.url || "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const requestedRunId = url.searchParams.get("run_id");
        if (requestedRunId !== null && !/^[0-9a-f]{32}$/.test(requestedRunId)) {
          throw new HttpError(400, "run_id must be lowercase 32-hex", "invalid_run_id");
        }
        sendJson(response, 200, {
          status: "ok",
          service: "clawmobile-router-proxy",
          virtual_models: VIRTUAL_MODELS,
          active_strategy: runtime.activeStrategy,
          arm_id: runtime.armId,
          local_validation_level: LOCAL_PARAMETER_SCHEMA_VALIDATION_LEVEL,
          providers: publicConfig(runtime),
          provider_concurrency: providerConcurrencyStatus(),
          v4_enabled: runtime.v4Enabled,
          capture_root: captureRoot,
          registered_run_count: runRegistrations.size,
          pending_fsm_transition_count: pendingFsmTransitions.size,
          requested_run_has_pending_fsm_transition:
            requestedRunId === null
              ? null
              : pendingFsmTransitions.has(requestedRunId),
          capture: runtime.v4Enabled
            ? partitionedCapture.status(requestedRunId)
            : captureStore.status(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: VIRTUAL_MODELS.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "clawmobile-router",
          })),
        });
        return;
      }
      const registrationMatch = url.pathname.match(
        /^\/v1\/experiment\/runs\/([0-9a-f]{32})$/u,
      );
      if (request.method === "PUT" && registrationMatch) {
        if (!runtime.v4Enabled) {
          throw new HttpError(404, "v4 run registration is disabled", "not_found");
        }
        if (!authorized(request, runtime.clientToken)) {
          response.setHeader("www-authenticate", "Bearer");
          sendError(response, 401, "Invalid Router bearer token", "unauthorized", requestId);
          return;
        }
        const runId = registrationMatch[1];
        const { value } = await readJsonBody(request, runtime.requestBodyLimitBytes);
        const armId = value.arm_id;
        if (typeof armId !== "string" || !V4_ARM_IDS.includes(armId)) {
          throw new HttpError(
            400,
            `arm_id must be one of: ${V4_ARM_IDS.join(", ")}`,
            "invalid_v4_arm",
          );
        }
        const existing = runRegistrations.get(runId);
        if (existing) {
          throw new HttpError(
            409,
            `experiment run is already registered for arm ${existing.armId}`,
            "experiment_run_already_registered",
          );
        }
        const registration = Object.freeze({
          runId,
          armId,
          registeredAt: new Date().toISOString(),
        });
        runRegistrations.set(runId, registration);
        sendJson(response, 201, { registration });
        return;
      }
      if (request.method === "GET" && registrationMatch) {
        if (!authorized(request, runtime.clientToken)) {
          response.setHeader("www-authenticate", "Bearer");
          sendError(response, 401, "Invalid Router bearer token", "unauthorized", requestId);
          return;
        }
        const runId = registrationMatch[1];
        const registration = runRegistrations.get(runId);
        if (!registration) {
          throw new HttpError(404, "experiment run is not registered", "not_found");
        }
        sendJson(response, 200, {
          registration,
          capture: partitionedCapture.status(runId),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!authorized(request, runtime.clientToken)) {
          response.setHeader("www-authenticate", "Bearer");
          sendError(response, 401, "Invalid Router bearer token", "unauthorized", requestId);
          return;
        }
        const { value: body, rawText } = await readJsonBody(
          request,
          runtime.requestBodyLimitBytes,
        );
        validateChatRequest(body);
        const generationParams = { ...body };
        delete generationParams.model;
        delete generationParams.messages;
        delete generationParams.tools;
        const sessionInspection = sessionIdentityInspectionFrom(
          request,
          body,
          env,
          proxySessionId,
          requestId,
        );
        const sessionIdentity = sessionInspection.identity;
        if (runtime.v4Enabled && sessionInspection.error) {
          throw sessionInspection.error;
        }
        const profile = requestProfile(body.model, sessionIdentity.id);
        const requestCaptureStore = runtime.v4Enabled && body.model === "experiment"
          ? partitionedCapture.forSession(sessionIdentity.id)
          : captureStore;
        const context = {
          requestId,
          sessionId: sessionIdentity.id,
          sessionSource: sessionIdentity.source,
          sessionValidationError: sessionInspection.error?.type || null,
          virtualModel: body.model,
          armId: profile.armId,
          strategy: profile.strategy,
          providers: profile.providers,
          captureStore: requestCaptureStore,
          signal: request.routerSignal,
          originalRequestSha256: hashJson(body),
          originalMessagesSha256: hashJson(body.messages),
          originalToolsSha256: hashJson(body.tools || []),
          originalGenerationParamsSha256: hashJson(generationParams),
        };
        requestContexts.set(requestId, context);
        await requestCaptureStore.captureInbound(
          callMetadata(context, "proxy_inbound"),
          rawText,
        );
        if (sessionInspection.error) throw sessionInspection.error;
        await handleChat(body, response, context);
        return;
      }
      sendError(response, 404, "Route not found", "not_found", requestId);
    } catch (error) {
      await safeLog({
        event: "proxy_error",
        request_id: requestId,
        error_code: safeErrorCode(error),
      });
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message, error.type, requestId);
      } else {
        sendError(response, 500, "Router proxy failed", "router_error", requestId);
      }
    } finally {
      requestContexts.delete(requestId);
    }
  };

  const server = createServer((request, response) => {
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    request.routerSignal = controller.signal;
    handler(request, response).catch(() => {
      if (!response.destroyed && !response.writableEnded) {
        sendError(response, 500, "Router proxy failed", "router_error");
      }
    });
  });
  return {
    server,
    runtime,
    logPath,
    capturePath: captureRoot || capturePath,
    captureStore: runtime.v4Enabled ? partitionedCapture : captureStore,
  };
}
