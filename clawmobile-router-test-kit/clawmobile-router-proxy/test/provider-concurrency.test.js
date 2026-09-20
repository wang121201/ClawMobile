import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouterProxy } from "../src/proxy.js";

const PROXY_TOKEN = "provider-gate-client-token-0123456789abcdef";
const TEST_PORT_MIN = 45_001;
const TEST_PORT_MAX = 60_000;
const TEST_PORT_COUNT = TEST_PORT_MAX - TEST_PORT_MIN + 1;
let nextTestPort =
  TEST_PORT_MIN + ((process.pid * 1_009 + Date.now()) % TEST_PORT_COUNT);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function listen(server) {
  for (let attempt = 0; attempt < TEST_PORT_COUNT; attempt += 1) {
    const port = nextTestPort;
    nextTestPort =
      TEST_PORT_MIN + ((nextTestPort - TEST_PORT_MIN + 1) % TEST_PORT_COUNT);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") continue;
      throw error;
    }
  }
  throw new Error("No fetch-safe loopback test port is available");
}

function completion(content, model) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function streamedJson(value, release, onComplete = () => {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    onComplete();
  };
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        await release;
        controller.enqueue(bytes);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        complete();
      }
    },
    cancel() {
      complete();
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, message, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error(message);
}

async function startFixture(fetchImpl, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-provider-gate-test-"));
  const configPath = join(directory, "openclaw.json");
  const capturePath = join(directory, "model-calls.jsonl");
  const logPath = join(directory, "router.jsonl");
  const localUsesFreeInference = options.localUsesFreeInference === true;
  await writeFile(configPath, JSON.stringify({
    models: {
      providers: {
        "custom-freeinference-org": {
          baseUrl: "https://freeinference.org/v1",
          apiKey: "freeinference-secret",
          models: [
            { id: "decision-model" },
            { id: "cloud-model" },
            { id: "logical-local-model" },
          ],
        },
        "custom-127-0-0-1-18080": {
          baseUrl: "http://127.0.0.1:18080/v1",
          apiKey: "xmu-secret",
          models: [{ id: "xmu-model" }],
        },
      },
    },
  }));

  let server;
  let captureStore;
  try {
    ({ server, captureStore } = await createRouterProxy({
      configPath,
      capturePath,
      logPath,
      fetchImpl,
      env: {
        CLAW_ROUTER_CLOUD_PROVIDER: "custom-freeinference-org",
        CLAW_ROUTER_CLOUD_MODEL: "cloud-model",
        CLAW_ROUTER_DECISION_PROVIDER: "custom-freeinference-org",
        CLAW_ROUTER_DECISION_MODEL: "decision-model",
        CLAW_ROUTER_LOCAL_PROVIDER: localUsesFreeInference
          ? "custom-freeinference-org"
          : "custom-127-0-0-1-18080",
        CLAW_ROUTER_LOCAL_MODEL: localUsesFreeInference
          ? "logical-local-model"
          : "xmu-model",
        CLAW_ROUTER_CLIENT_TOKEN: PROXY_TOKEN,
        CLAW_ROUTER_CAMPAIGN_ID: "provider-gate-fixture",
        CLAW_ROUTER_ACTIVE_STRATEGY: "router",
        CLAW_ROUTER_ANSWER_TIMEOUT_MS: "5000",
        CLAW_ROUTER_STRATEGY_TIMEOUT_MS: "5000",
      },
    }));
    const proxyBase = await listen(server);
    return {
      proxyBase,
      async health() {
        return (await fetch(`${proxyBase}/health`)).json();
      },
      async captures() {
        await captureStore.flush();
        return (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      },
      async logs() {
        return (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      },
      async close() {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function requestBody(model) {
  return {
    model,
    messages: [{ role: "user", content: "exercise provider concurrency" }],
    tools: [
      {
        type: "function",
        function: {
          name: "tool_a",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    stream: false,
  };
}

function chatFetch(fixture, model, options = {}) {
  return fetch(`${fixture.proxyBase}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PROXY_TOKEN}`,
      ...(options.headers || {}),
    },
    body: JSON.stringify(requestBody(model)),
    signal: options.signal,
  });
}

async function consume(responsePromise) {
  const response = await responsePromise;
  await response.text();
  return response;
}

test("FreeInference and XMU each serialize at one while remaining independent", async (t) => {
  const releases = { free: deferred(), xmu: deferred() };
  const started = { free: deferred(), xmu: deferred() };
  const state = {
    free: { current: 0, max: 0, calls: 0 },
    xmu: { current: 0, max: 0, calls: 0 },
    combined: 0,
    combinedMax: 0,
  };
  const fetchImpl = async (target, options) => {
    const resource = target.startsWith("https://freeinference.org/") ? "free" : "xmu";
    const item = state[resource];
    item.calls += 1;
    item.current += 1;
    item.max = Math.max(item.max, item.current);
    state.combined += 1;
    state.combinedMax = Math.max(state.combinedMax, state.combined);
    if (item.calls === 1) started[resource].resolve();
    const body = JSON.parse(options.body);
    return streamedJson(
      completion(`${resource}-answer`, body.model),
      item.calls === 1 ? releases[resource].promise : Promise.resolve(),
      () => {
        item.current -= 1;
        state.combined -= 1;
      },
    );
  };
  const fixture = await startFixture(fetchImpl);
  t.after(() => fixture.close());

  const requests = [
    consume(chatFetch(fixture, "cloud-full")),
    consume(chatFetch(fixture, "cloud-full")),
    consume(chatFetch(fixture, "local-full")),
    consume(chatFetch(fixture, "local-full")),
  ];
  await Promise.all([started.free.promise, started.xmu.promise]);
  const queuedHealth = await waitFor(async () => {
    const health = await fixture.health();
    const free = health.provider_concurrency["freeinference-global"];
    const xmu = health.provider_concurrency["xmu-8080"];
    return free.current === 1 && free.queued === 1 && xmu.current === 1 && xmu.queued === 1
      ? health
      : null;
  }, "both provider queues did not expose one active and one FIFO waiter");
  assert.deepEqual(queuedHealth.provider_concurrency["freeinference-global"], {
    configured: 1,
    current: 1,
    queued: 1,
    max_observed: 1,
  });
  assert.deepEqual(queuedHealth.provider_concurrency["xmu-8080"], {
    configured: 1,
    current: 1,
    queued: 1,
    max_observed: 1,
  });
  assert.equal(state.combinedMax, 2, "independent providers must be allowed to overlap");

  // Make the second request's queue wait materially larger than its immediate
  // provider response so the latency-exclusion assertion is non-flaky.
  await delay(75);
  releases.free.resolve();
  releases.xmu.resolve();
  const responses = await Promise.all(requests);
  assert.equal(responses.every((response) => response.status === 200), true);
  assert.deepEqual(
    { free: state.free, xmu: state.xmu },
    {
      free: { current: 0, max: 1, calls: 2 },
      xmu: { current: 0, max: 1, calls: 2 },
    },
  );
  const finalHealth = await waitFor(async () => {
    const health = await fixture.health();
    return Object.values(health.provider_concurrency).every(
      (status) => status.current === 0 && status.queued === 0,
    )
      ? health
      : null;
  }, "provider leases were not released after durable response capture");
  for (const resource of ["freeinference-global", "xmu-8080"]) {
    assert.deepEqual(finalHealth.provider_concurrency[resource], {
      configured: 1,
      current: 0,
      queued: 0,
      max_observed: 1,
    });
  }
  const modelCalls = (await fixture.captures()).filter(
    (record) => record.event === "model_call",
  );
  assert.equal(modelCalls.length, 4);
  assert.deepEqual(
    new Set(modelCalls.map((record) => record.provider_queue_resource)),
    new Set(["freeinference-global", "xmu-8080"]),
  );
  assert.equal(
    modelCalls.every(
      (record) => record.provider_request_dispatched === true &&
        Number.isSafeInteger(record.provider_queue_wait_ms) &&
        record.provider_latency_ms === record.latency_ms,
    ),
    true,
  );
  for (const resource of ["freeinference-global", "xmu-8080"]) {
    const waited = modelCalls.find(
      (record) => record.provider_queue_resource === resource &&
        record.provider_queue_wait_ms >= 50,
    );
    assert.ok(waited, `${resource} did not audit its FIFO wait`);
    assert.ok(waited.latency_ms < waited.provider_queue_wait_ms);
    assert.ok(waited.response_headers_elapsed_ms < waited.provider_queue_wait_ms);
  }
});

test("a FreeInference logical-local provider shares the global FreeInference FIFO", async (t) => {
  const state = { current: 0, max: 0, calls: 0 };
  const fetchImpl = async (_target, options) => {
    state.calls += 1;
    state.current += 1;
    state.max = Math.max(state.max, state.current);
    const body = JSON.parse(options.body);
    return streamedJson(completion("answer", body.model), delay(25), () => {
      state.current -= 1;
    });
  };
  const fixture = await startFixture(fetchImpl, { localUsesFreeInference: true });
  t.after(() => fixture.close());

  const responses = await Promise.all([
    consume(chatFetch(fixture, "cloud-full")),
    consume(chatFetch(fixture, "local-full")),
  ]);
  assert.equal(responses.every((response) => response.status === 200), true);
  assert.deepEqual(state, { current: 0, max: 1, calls: 2 });
  const calls = (await fixture.captures()).filter((record) => record.event === "model_call");
  assert.deepEqual(calls.map((record) => record.provider_queue_resource), [
    "freeinference-global",
    "freeinference-global",
  ]);
});

test("provider errors and client aborts release the FreeInference lease", async (t) => {
  const firstStarted = deferred();
  let calls = 0;
  let mode = "error";
  const fetchImpl = async (_target, options) => {
    calls += 1;
    if (mode === "error") throw new Error("synthetic provider failure");
    if (mode === "abort") {
      firstStarted.resolve();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason || new Error("aborted")),
          { once: true },
        );
      });
    }
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify(completion("recovered", body.model)), {
      headers: { "content-type": "application/json" },
    });
  };
  const fixture = await startFixture(fetchImpl);
  t.after(() => fixture.close());

  let response = await chatFetch(fixture, "cloud-full");
  assert.equal(response.status, 502);
  await response.text();
  mode = "success";
  response = await chatFetch(fixture, "cloud-full");
  assert.equal(response.status, 200);
  await response.text();

  mode = "abort";
  const controller = new AbortController();
  const aborted = chatFetch(fixture, "cloud-full", { signal: controller.signal });
  await firstStarted.promise;
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  await waitFor(async () => {
    const status = (await fixture.health()).provider_concurrency["freeinference-global"];
    return status.current === 0 && status.queued === 0;
  }, "aborted provider request did not release its lease");
  mode = "success";
  response = await chatFetch(fixture, "cloud-full");
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls, 4);

  const modelCalls = (await fixture.captures()).filter(
    (record) => record.event === "model_call",
  );
  assert.equal(modelCalls.filter((record) => record.transport_error).length, 2);
  assert.equal(
    modelCalls.every((record) => record.provider_queue_resource === "freeinference-global"),
    true,
  );
  assert.deepEqual((await fixture.health()).provider_concurrency["freeinference-global"], {
    configured: 1,
    current: 0,
    queued: 0,
    max_observed: 1,
  });
});

test("every helper retry re-enters the same FreeInference FIFO", async (t) => {
  const active = { current: 0, max: 0, calls: 0 };
  const helperAttempts = new Map();
  const fetchImpl = async (_target, options) => {
    active.calls += 1;
    active.current += 1;
    active.max = Math.max(active.max, active.current);
    const body = JSON.parse(options.body);
    const headers = new Headers(options.headers);
    const session = headers.get("x-session-id");
    const isHelper = String(body.messages?.[0]?.content || "").includes(
      "ClawMobile next-tool decision helper",
    );
    let content = "cloud-answer";
    if (isHelper) {
      const attempt = (helperAttempts.get(session) || 0) + 1;
      helperAttempts.set(session, attempt);
      content = attempt === 1
        ? "not-json"
        : '{"k":1,"tools":["tool_a"],"args_class":"COMPLEX_ARGS"}';
    }
    return streamedJson(completion(content, body.model), delay(15), () => {
      active.current -= 1;
    });
  };
  const fixture = await startFixture(fetchImpl);
  t.after(() => fixture.close());

  const responses = await Promise.all([
    consume(chatFetch(fixture, "router", {
      headers: { "x-clawmobile-session-id": "retry-session-a" },
    })),
    consume(chatFetch(fixture, "router", {
      headers: { "x-clawmobile-session-id": "retry-session-b" },
    })),
  ]);
  assert.equal(responses.every((response) => response.status === 200), true);
  assert.deepEqual(active, { current: 0, max: 1, calls: 6 });
  assert.deepEqual([...helperAttempts.values()].sort(), [2, 2]);

  const helperCalls = (await fixture.captures()).filter(
    (record) => record.event === "model_call" && record.call_role === "router_helper",
  );
  assert.equal(helperCalls.length, 4);
  for (const session of ["retry-session-a", "retry-session-b"]) {
    assert.deepEqual(
      helperCalls
        .filter((record) => record.session_id === session)
        .map((record) => record.attempt_index),
      [1, 2],
    );
  }
  assert.equal(
    helperCalls.every(
      (record) => record.provider_queue_resource === "freeinference-global",
    ),
    true,
  );
  const decisions = (await fixture.logs()).filter((record) => record.event === "router_decision");
  assert.equal(decisions.length, 2);
  assert.equal(
    decisions.every(
      (record) => record.helper_queue_resource === "freeinference-global" &&
        Number.isSafeInteger(record.helper_queue_wait_ms) &&
        record.helper_attempts === 2,
    ),
    true,
  );
  assert.equal(
    (await fixture.health()).provider_concurrency["freeinference-global"].max_observed,
    1,
  );
});
