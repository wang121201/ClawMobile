import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelCallCapture } from "../src/capture.js";
import { fetchCompletion, readCompletionJson } from "../src/upstream.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function modelCall() {
  return {
    provider: { id: "test-provider", model: "test-model" },
    endpoint: "http://127.0.0.1/v1/chat/completions",
    requestHeaders: {
      authorization: "Bearer must-not-be-recorded",
      "x-auth-token": "request-token-must-not-be-recorded",
      "x-ratelimit-remaining-tokens": "1234",
      "content-type": "application/json",
    },
    requestText: '{"model":"test-model"}',
    metadata: { call_role: "cloud_agent" },
  };
}

function abortingResponse(chunkTexts) {
  const encoder = new TextEncoder();
  const chunks = chunkTexts.map((text) => encoder.encode(text));
  let chunkIndex = 0;
  return {
    chunks,
    response: new Response(
      new ReadableStream({
        pull(controller) {
          if (chunkIndex < chunks.length) {
            controller.enqueue(chunks[chunkIndex]);
            chunkIndex += 1;
            return;
          }
          const error = new Error("mock upstream body aborted");
          error.name = "AbortError";
          error.code = "ECONNRESET";
          return new Promise((resolve) => {
            setTimeout(() => {
              controller.error(error);
              resolve();
            }, 5);
          });
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "partial-response-id",
          "retry-after": "7",
          "x-ratelimit-limit-tokens": "4096",
          "x-ratelimit-remaining-tokens": "2048",
          "x-ratelimit-reset-tokens": "12s",
          "x-auth-token": "response-token-must-not-be-recorded",
        },
      },
    ),
  };
}

test("captureResponse preserves clone bytes and timeline when the body stream aborts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-capture-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capturePath = join(directory, "model-calls.jsonl");
  const captureStore = createModelCallCapture(capturePath);
  const chunkTexts = [
    'data: {"id":"first"}\n\n',
    'data: {"id":"truncated"',
  ];
  const { chunks, response: upstreamResponse } = abortingResponse(chunkTexts);
  const startedAt = performance.now();

  await captureStore.captureResponse(modelCall(), upstreamResponse.clone(), {
    startedAt,
    startedAtIso: new Date().toISOString(),
    headersAtIso: new Date().toISOString(),
    headersElapsedMs: 1,
  });
  await captureStore.flush();

  const records = (await readFile(capturePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  const [record] = records;
  const expectedBytes = Buffer.from(chunkTexts.join(""), "utf8");
  assert.equal(record.event, "model_call");
  assert.equal(record.response_status, 200);
  assert.equal(record.response_headers["x-request-id"], "partial-response-id");
  assert.equal(record.response_headers_elapsed_ms, 1);
  assert.equal(
    record.response_headers_elapsed_semantics,
    "request_start_to_http_response_headers_not_first_token",
  );
  assert.equal(record.ttft_ms, record.response_headers_elapsed_ms);
  assert.equal(
    record.ttft_semantics,
    "legacy_alias_of_response_headers_elapsed_ms_not_first_token",
  );
  assert.equal(
    record.first_response_chunk_elapsed_ms,
    record.response_chunks[0].elapsed_ms,
  );
  assert.equal(
    record.first_response_chunk_semantics,
    "request_start_to_first_response_body_chunk_not_first_token",
  );
  assert.equal(record.response_headers["retry-after"], "7");
  assert.equal(record.response_headers["x-ratelimit-limit-tokens"], "4096");
  assert.equal(record.response_headers["x-ratelimit-remaining-tokens"], "2048");
  assert.equal(record.response_headers["x-ratelimit-reset-tokens"], "12s");
  assert.equal(record.response_headers["x-auth-token"], "[REDACTED]");
  assert.equal(record.capture_complete, false);
  assert.deepEqual(record.transport_error, {
    name: "AbortError",
    code: "ECONNRESET",
    message: "mock upstream body aborted",
  });
  assert.equal(record.raw_response_text, chunkTexts.join(""));
  assert.equal(record.raw_response_base64, expectedBytes.toString("base64"));
  assert.equal(record.raw_response_sha256, sha256(expectedBytes));
  assert.equal(record.raw_response_bytes, expectedBytes.length);
  assert.deepEqual(
    record.response_chunks.map(({ offset, bytes }) => ({ offset, bytes })),
    [
      { offset: 0, bytes: chunks[0].length },
      { offset: chunks[0].length, bytes: chunks[1].length },
    ],
  );
  assert.equal(
    record.response_chunks.every(({ elapsed_ms }) => Number.isSafeInteger(elapsed_ms)),
    true,
  );
  assert.deepEqual(record.parsed_response, {
    format: "sse",
    events: [{ id: "first" }, '{"id":"truncated"'],
  });
  assert.equal(record.request_headers.authorization, "[REDACTED]");
  assert.equal(record.request_headers["x-auth-token"], "[REDACTED]");
  assert.equal(record.request_headers["x-ratelimit-remaining-tokens"], "1234");
  assert.deepEqual(captureStore.status(), {
    enabled: true,
    path: capturePath,
    pending: 0,
    errors: 0,
    record_count: 1,
    model_call_count: 1,
    durable_record_count: 1,
    durable_model_call_count: 1,
    durability_semantics: "each_jsonl_record_fsync_then_close_before_pending_decrement",
  });
});

test("readCompletionJson waits until an aborted cloned response is persisted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-capture-upstream-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capturePath = join(directory, "model-calls.jsonl");
  const captureStore = createModelCallCapture(capturePath);
  const chunkTexts = ['{"partial":'];
  const { response: upstreamResponse } = abortingResponse(chunkTexts);
  const provider = {
    id: "test-provider",
    model: "test-model",
    baseUrl: "http://127.0.0.1/v1",
    apiKey: null,
    headers: {},
  };
  const response = await fetchCompletion(
    provider,
    { messages: [], stream: false },
    async () => upstreamResponse,
    {
      captureStore,
      captureMetadata: { call_role: "cloud_agent" },
    },
  );

  await assert.rejects(
    readCompletionJson(response),
    (error) => error?.name === "AbortError" && error?.message === "mock upstream body aborted",
  );

  const record = JSON.parse((await readFile(capturePath, "utf8")).trim());
  assert.equal(record.capture_complete, false);
  assert.equal(record.raw_response_text, chunkTexts.join(""));
  assert.equal(record.transport_error.name, "AbortError");
  assert.equal(record.transport_error.message, "mock upstream body aborted");
  assert.equal(captureStore.status().pending, 0);
  assert.equal(captureStore.status().errors, 0);
  assert.equal(captureStore.status().record_count, 1);
  assert.equal(captureStore.status().model_call_count, 1);
  assert.equal(captureStore.status().durable_record_count, 1);
  assert.equal(captureStore.status().durable_model_call_count, 1);
});

test("capture status errors counts an actual JSONL write failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-capture-write-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nonDirectory = join(directory, "not-a-directory");
  await writeFile(nonDirectory, "blocks mkdir", "utf8");
  const captureStore = createModelCallCapture(join(nonDirectory, "model-calls.jsonl"));

  await captureStore.captureInbound({ call_role: "test" }, "{}");
  await captureStore.flush();

  assert.equal(captureStore.status().pending, 0);
  assert.equal(captureStore.status().errors, 1);
  assert.equal(captureStore.status().record_count, 1);
  assert.equal(captureStore.status().model_call_count, 0);
  assert.equal(captureStore.status().durable_record_count, 0);
  assert.equal(captureStore.status().durable_model_call_count, 0);
});
