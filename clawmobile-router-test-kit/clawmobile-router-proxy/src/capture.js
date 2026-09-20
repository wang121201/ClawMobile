import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

// Match credential-bearing header *segments*, not incidental substrings.  In
// particular, quota telemetry such as x-ratelimit-remaining-tokens is safe and
// required experiment evidence; the plural word "tokens" must not be mistaken
// for a singular credential header named "token".
const SECRET_HEADER =
  /(?:^|[-_])(?:authorization|api[-_]?key|token|secret|password|cookie)(?:$|[-_])/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizedHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    output[name] = SECRET_HEADER.test(name) ? "[REDACTED]" : String(value);
  }
  return output;
}

function responseHeaders(headers) {
  const output = {};
  for (const [name, value] of headers.entries()) {
    output[name] = SECRET_HEADER.test(name) ? "[REDACTED]" : value;
  }
  return output;
}

function parseResponse(text, contentType) {
  if (/text\/event-stream/i.test(contentType || "")) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trimStart();
      if (data === "[DONE]") {
        events.push("[DONE]");
        continue;
      }
      try {
        events.push(JSON.parse(data));
      } catch {
        events.push(data);
      }
    }
    return { format: "sse", events };
  }
  try {
    return { format: "json", value: JSON.parse(text) };
  } catch {
    return { format: "text", value: text };
  }
}

function transportError(error, fallbackMessage) {
  const code = error?.code;
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    message: typeof error?.message === "string" ? error.message : fallbackMessage,
  };
}

async function readResponseBytes(response, startedAt) {
  if (!response.body) {
    return {
      bytes: Buffer.alloc(0),
      chunks: [],
      captureComplete: true,
      transportError: null,
    };
  }
  const reader = response.body.getReader();
  const chunks = [];
  const timeline = [];
  let offset = 0;
  let streamError = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      timeline.push({
        offset,
        bytes: chunk.length,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      offset += chunk.length;
    }
  } catch (error) {
    streamError = transportError(error, "response stream failed before completion");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The response record still needs to be written if the errored reader
      // cannot release its lock cleanly.
    }
  }
  return {
    bytes: Buffer.concat(chunks),
    chunks: timeline,
    captureComplete: streamError === null,
    transportError: streamError,
  };
}

function providerTiming(timing) {
  const queued = typeof timing.providerQueueResource === "string";
  const dispatched = Number.isFinite(timing.providerStartedAt);
  const startedAt = dispatched ? timing.providerStartedAt : timing.startedAt;
  const startedAtIso = dispatched ? timing.providerStartedAtIso : timing.startedAtIso;
  const latencyMs = queued && !dispatched
    ? 0
    : Math.max(0, Math.round(performance.now() - startedAt));
  return {
    queued,
    dispatched,
    startedAt,
    startedAtIso,
    latencyMs,
    fields: queued
      ? {
          provider_queue_resource: timing.providerQueueResource,
          provider_queue_entered_at: timing.providerQueueEnteredAtIso,
          provider_queue_wait_ms: Math.max(
            0,
            Math.round(timing.providerQueueWaitMs || 0),
          ),
          provider_queue_wait_semantics:
            "fifo_wait_before_physical_provider_start_excluded_from_provider_latency",
          provider_request_dispatched: dispatched,
          provider_request_started_at: dispatched ? timing.providerStartedAtIso : null,
          provider_latency_ms: latencyMs,
          provider_latency_semantics:
            dispatched
              ? "physical_provider_start_to_raw_response_capture_completion_excludes_queue_wait"
              : "zero_when_no_physical_provider_request_was_dispatched",
        }
      : {},
  };
}

export function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

export function createModelCallCapture(path) {
  if (!path) {
    return Object.freeze({
      enabled: false,
      path: null,
      captureResponse: () => Promise.resolve(),
      captureFailure: () => Promise.resolve(),
      captureInbound: () => Promise.resolve(),
      captureDerivedResponse: () => Promise.resolve(),
      flush: () => Promise.resolve(),
      status: () => ({
        enabled: false,
        pending: 0,
        errors: 0,
        record_count: 0,
        model_call_count: 0,
        durable_record_count: 0,
        durable_model_call_count: 0,
        durability_semantics: "disabled",
      }),
    });
  }

  let writeTail = Promise.resolve();
  let pending = 0;
  let errors = 0;
  let sequence = 0;
  let recordCount = 0;
  let modelCallCount = 0;
  let durableRecordCount = 0;
  let durableModelCallCount = 0;

  function enqueue(record) {
    pending += 1;
    recordCount += 1;
    if (record.event === "model_call") modelCallCount += 1;
    const numbered = { ...record, capture_sequence: ++sequence };
    const operation = writeTail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a");
      try {
        await handle.writeFile(`${JSON.stringify(numbered)}\n`, "utf8");
        // A completed enqueue is evidence only after the file data has crossed
        // the OS durability boundary and the descriptor has been closed.
        await handle.sync();
      } finally {
        await handle.close();
      }
      durableRecordCount += 1;
      if (record.event === "model_call") durableModelCallCount += 1;
    });
    writeTail = operation
      .catch(() => {
        errors += 1;
      })
      .finally(() => {
        pending -= 1;
      });
    return writeTail;
  }

  async function captureResponse(call, response, timing) {
    const provider = providerTiming(timing);
    const {
      bytes,
      chunks,
      captureComplete,
      transportError: responseTransportError,
    } = await readResponseBytes(response, provider.startedAt);
    const text = bytes.toString("utf8");
    const completedAt = new Date();
    const latencyMs = provider.queued
      ? Math.max(0, Math.round(performance.now() - provider.startedAt))
      : Math.max(0, Math.round(performance.now() - timing.startedAt));
    const responseHeadersElapsedMs = provider.queued
      ? timing.providerHeadersElapsedMs
      : timing.headersElapsedMs;
    await enqueue({
      schema_version: 1,
      event: "model_call",
      ...call.metadata,
      provider_id: call.provider.id,
      model: call.provider.model,
      endpoint: call.endpoint,
      request_started_at: provider.startedAtIso,
      response_headers_at: timing.headersAtIso,
      response_completed_at: completedAt.toISOString(),
      response_headers_elapsed_ms: responseHeadersElapsedMs,
      response_headers_elapsed_semantics:
        provider.queued
          ? "physical_provider_start_to_http_response_headers_not_first_token_excludes_queue_wait"
          : "request_start_to_http_response_headers_not_first_token",
      first_response_chunk_elapsed_ms:
        chunks.length > 0 ? chunks[0].elapsed_ms : null,
      first_response_chunk_semantics:
        provider.queued
          ? "physical_provider_start_to_first_response_body_chunk_not_first_token_excludes_queue_wait"
          : "request_start_to_first_response_body_chunk_not_first_token",
      // Backward-compatible alias for preserved historical archives.  This is
      // intentionally accompanied by an explicit semantics field: fetch()
      // resolves when HTTP response headers arrive, so this value is not a
      // measured time-to-first-token (TTFT).
      ttft_ms: responseHeadersElapsedMs,
      ttft_semantics: "legacy_alias_of_response_headers_elapsed_ms_not_first_token",
      latency_ms: latencyMs,
      ...(provider.queued
        ? {
            ...provider.fields,
            provider_latency_ms: latencyMs,
          }
        : {}),
      request_headers: sanitizedHeaders(call.requestHeaders),
      raw_request_text: call.requestText,
      raw_request_sha256: sha256(Buffer.from(call.requestText, "utf8")),
      response_status: response.status,
      response_headers: responseHeaders(response.headers),
      capture_complete: captureComplete,
      ...(responseTransportError ? { transport_error: responseTransportError } : {}),
      raw_response_text: text,
      raw_response_base64: bytes.toString("base64"),
      raw_response_sha256: sha256(bytes),
      raw_response_bytes: bytes.length,
      response_chunks: chunks,
      parsed_response: parseResponse(text, response.headers.get("content-type")),
    });
  }

  async function captureFailure(call, error, timing) {
    const provider = providerTiming(timing);
    await enqueue({
      schema_version: 1,
      event: "model_call",
      ...call.metadata,
      provider_id: call.provider.id,
      model: call.provider.model,
      endpoint: call.endpoint,
      request_started_at: provider.startedAtIso,
      response_completed_at: new Date().toISOString(),
      latency_ms: provider.latencyMs,
      ...provider.fields,
      request_headers: sanitizedHeaders(call.requestHeaders),
      raw_request_text: call.requestText,
      raw_request_sha256: sha256(Buffer.from(call.requestText, "utf8")),
      transport_error: transportError(error, "transport failure"),
    });
  }

  async function captureDerivedResponse(metadata, rawText) {
    const bytes = Buffer.from(rawText, "utf8");
    await enqueue({
      schema_version: 1,
      event: "proxy_response",
      ...metadata,
      captured_at: new Date().toISOString(),
      raw_response_text: rawText,
      raw_response_base64: bytes.toString("base64"),
      raw_response_sha256: sha256(bytes),
      raw_response_bytes: bytes.length,
      parsed_response: parseResponse(rawText, "text/event-stream"),
    });
  }

  async function captureInbound(metadata, rawText) {
    const bytes = Buffer.from(rawText, "utf8");
    await enqueue({
      schema_version: 1,
      event: "proxy_request",
      ...metadata,
      captured_at: new Date().toISOString(),
      raw_request_text: rawText,
      raw_request_sha256: sha256(bytes),
      raw_request_bytes: bytes.length,
    });
  }

  return Object.freeze({
    enabled: true,
    path,
    captureResponse,
    captureFailure,
    captureInbound,
    captureDerivedResponse,
    flush: () => writeTail,
    status: () => ({
      enabled: true,
      path,
      pending,
      errors,
      record_count: recordCount,
      model_call_count: modelCallCount,
      durable_record_count: durableRecordCount,
      durable_model_call_count: durableModelCallCount,
      durability_semantics: "each_jsonl_record_fsync_then_close_before_pending_decrement",
    }),
  });
}

export function createPartitionedModelCallCapture(rootPath) {
  if (!rootPath) {
    return Object.freeze({
      enabled: false,
      rootPath: null,
      forSession: () => createModelCallCapture(null),
      status: () => ({
        enabled: false,
        root_path: null,
        session_count: 0,
        pending: 0,
        errors: 0,
        record_count: 0,
        model_call_count: 0,
        durable_record_count: 0,
        durable_model_call_count: 0,
        durability_semantics: "disabled",
      }),
    });
  }

  const normalizedRoot = resolve(rootPath);
  const stores = new Map();

  function forSession(sessionId) {
    if (typeof sessionId !== "string" || !/^[0-9a-f]{32}$/.test(sessionId)) {
      throw new Error("partitioned capture requires one lowercase 32-hex session id");
    }
    let store = stores.get(sessionId);
    if (!store) {
      const path = resolve(join(normalizedRoot, sessionId, "model-calls.jsonl"));
      if (!path.startsWith(`${normalizedRoot}${sep}`)) {
        throw new Error("partitioned capture path escaped its configured root");
      }
      store = createModelCallCapture(path);
      stores.set(sessionId, store);
    }
    return store;
  }

  function status(sessionId = null) {
    if (sessionId !== null) {
      const store = stores.get(sessionId);
      return store
        ? store.status()
        : {
            enabled: true,
            path: resolve(join(normalizedRoot, sessionId, "model-calls.jsonl")),
            pending: 0,
            errors: 0,
            record_count: 0,
            model_call_count: 0,
            durable_record_count: 0,
            durable_model_call_count: 0,
            durability_semantics:
              "each_jsonl_record_fsync_then_close_before_pending_decrement",
          };
    }
    const rows = [...stores.values()].map((store) => store.status());
    const sum = (field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
    return {
      enabled: true,
      root_path: normalizedRoot,
      session_count: stores.size,
      pending: sum("pending"),
      errors: sum("errors"),
      record_count: sum("record_count"),
      model_call_count: sum("model_call_count"),
      durable_record_count: sum("durable_record_count"),
      durable_model_call_count: sum("durable_model_call_count"),
      durability_semantics:
        "each_jsonl_record_fsync_then_close_before_pending_decrement",
    };
  }

  return Object.freeze({
    enabled: true,
    rootPath: normalizedRoot,
    forSession,
    status,
  });
}
