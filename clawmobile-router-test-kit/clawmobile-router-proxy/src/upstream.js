import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const RESPONSE_CAPTURES = new WeakMap();

function endpoint(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function hasHeader(headers, target) {
  return Object.keys(headers).some((name) => name.toLowerCase() === target);
}

function safeCorrelationValue(value) {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;
}

function serviceRequestId(metadata, supplied) {
  const explicit = safeCorrelationValue(supplied);
  if (explicit) return explicit;
  const role = String(metadata?.service_role || "model")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "model";
  return `cm-${role}-${randomUUID()}`;
}

export function providerHeaders(provider, stream, correlation = {}) {
  const headers = {
    ...provider.headers,
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  if (provider.apiKey && !hasHeader(headers, "authorization")) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  const sessionId = safeCorrelationValue(correlation.sessionId);
  const requestId = safeCorrelationValue(correlation.requestId);
  if (sessionId) headers["x-session-id"] = sessionId;
  if (requestId) headers["x-request-id"] = requestId;
  return headers;
}

function requestSignal(signal, timeoutMs) {
  const signals = [];
  if (signal) signals.push(signal);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export async function fetchCompletion(provider, body, fetchImpl = fetch, options = {}) {
  const target = endpoint(provider.baseUrl);
  const baseMetadata = options.captureMetadata || {};
  const upstreamSessionId = safeCorrelationValue(baseMetadata.upstream_session_id);
  const upstreamRequestId = serviceRequestId(baseMetadata, options.serviceRequestId);
  const requestHeaders = providerHeaders(provider, Boolean(body.stream), {
    sessionId: upstreamSessionId,
    requestId: upstreamRequestId,
  });
  const requestText = JSON.stringify({ ...body, model: provider.model });
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const call = {
    provider,
    endpoint: target,
    requestHeaders,
    requestText,
    metadata: {
      ...baseMetadata,
      upstream_session_id: upstreamSessionId,
      service_request_id: upstreamRequestId,
    },
  };
  let response;
  try {
    response = await fetchImpl(target, {
      method: "POST",
      headers: requestHeaders,
      body: requestText,
      signal: requestSignal(options.signal, options.timeoutMs),
    });
  } catch (error) {
    await options.captureStore?.captureFailure(call, error, {
      startedAt,
      startedAtIso,
    });
    throw error;
  }
  if (options.captureStore?.enabled) {
    const capture = options.captureStore.captureResponse(call, response.clone(), {
      startedAt,
      startedAtIso,
      headersAtIso: new Date().toISOString(),
      headersElapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    RESPONSE_CAPTURES.set(response, capture);
  }
  return response;
}

async function waitForResponseCapture(response) {
  await RESPONSE_CAPTURES.get(response);
}

export class UpstreamError extends Error {
  constructor(status, code = "upstream_error") {
    super(`Upstream request failed with status ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
  }
}

export async function readCompletionJson(response) {
  let text;
  try {
    text = await response.text();
  } finally {
    await waitForResponseCapture(response);
  }
  if (!response.ok) throw new UpstreamError(response.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(502, "invalid_upstream_json");
  }
}

const PASSTHROUGH_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
];

export async function relayResponse(response, nodeResponse, extraHeaders = {}) {
  nodeResponse.statusCode = response.status;
  for (const name of PASSTHROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value) nodeResponse.setHeader(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    nodeResponse.setHeader(name, String(value));
  }
  if (!response.body) {
    nodeResponse.end();
    await waitForResponseCapture(response);
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body), nodeResponse);
  } finally {
    await waitForResponseCapture(response);
  }
}
