import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouterProxy } from "../src/proxy.js";
import { DECISION_HELPER_MAX_ATTEMPTS } from "../src/strategies.js";

const PROXY_TOKEN = "proxy-client-token-0123456789abcdef";

test("decision helper attempt budget is frozen at two", () => {
  assert.equal(DECISION_HELPER_MAX_ATTEMPTS, 2);
});

// Fetch rejects a standards-defined list of unsafe ports even for loopback
// URLs. Never ask listen(0) for a port that Fetch may subsequently reject;
// allocate only above the highest forbidden port and retry test-process or
// Windows excluded-range collisions.
const TEST_PORT_MIN = 20_000;
const TEST_PORT_MAX = 45_000;
const TEST_PORT_COUNT = TEST_PORT_MAX - TEST_PORT_MIN + 1;
let nextTestPort =
  TEST_PORT_MIN + ((process.pid * 1_009 + Date.now()) % TEST_PORT_COUNT);

function completion(message, model) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function json(response, value, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function startFixture(options = {}) {
  const state = {
    cloudRequests: [],
    localRequests: [],
    cloudHelper: { k: 1, tools: ["tool_a"], args_class: "SIMPLE_ARGS" },
    routeClassHelper: {
      route_class: "EVIDENCE_LOCAL",
      reason_code: "FINITE_EVIDENCE_ACQUISITION",
    },
    binaryRoute: { route: "LOCAL_UI_CANDIDATE" },
    localHelper: { k: 1, tools: ["tool_a"], args_class: "SIMPLE_ARGS" },
    cloudHelperContent: null,
    cloudHelperContents: null,
    cloudHelperDelayMs: 0,
    cloudHelperAttempts: 0,
    localHelperContent: null,
    cloudStatus: 200,
    cloudDelayMs: 0,
    cloudAnswer: completion({ role: "assistant", content: "cloud-answer" }, "cloud-model"),
    localAnswer: completion(
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "local-call",
          type: "function",
          function: { name: "tool_a", arguments: "{\"x\":1}" },
        }],
      },
      "local-model",
    ),
  };

  const cloudServer = createServer(async (request, response) => {
    const body = await readJson(request);
    state.cloudRequests.push({
      body,
      authorization: request.headers.authorization,
      headers: { ...request.headers },
    });
    if (request.headers["x-request-id"]) {
      response.setHeader("x-request-id", request.headers["x-request-id"]);
    }
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("ClawMobile binary Local/Cloud routing helper")) {
      json(
        response,
        completion(
          { role: "assistant", content: JSON.stringify(state.binaryRoute) },
          "cloud-model",
        ),
      );
      return;
    }
    if (system.includes("ClawMobile finite RouteClass decision helper")) {
      json(
        response,
        completion(
          { role: "assistant", content: JSON.stringify(state.routeClassHelper) },
          "cloud-model",
        ),
      );
      return;
    }
    if (system.includes("ClawMobile next-tool decision helper")) {
      const attempt = state.cloudHelperAttempts;
      state.cloudHelperAttempts += 1;
      if (state.cloudHelperDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.cloudHelperDelayMs));
      }
      const content = Array.isArray(state.cloudHelperContents)
        ? state.cloudHelperContents[Math.min(attempt, state.cloudHelperContents.length - 1)]
        : state.cloudHelperContent ?? JSON.stringify(state.cloudHelper);
      json(response, completion({ role: "assistant", content }, "cloud-model"));
      return;
    }
    if (state.cloudDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.cloudDelayMs));
    }
    if (state.cloudStatus === 429) response.setHeader("retry-after", "3");
    json(
      response,
      state.cloudStatus === 200
        ? body.model === "qwen3.6-35b"
          ? state.localAnswer
          : state.cloudAnswer
        : { error: { message: "mock upstream limit", type: "rate_limit_error" } },
      state.cloudStatus,
    );
  });

  const localServer = createServer(async (request, response) => {
    const body = await readJson(request);
    state.localRequests.push({
      body,
      authorization: request.headers.authorization,
      headers: { ...request.headers },
    });
    if (request.headers["x-request-id"]) {
      response.setHeader("x-request-id", request.headers["x-request-id"]);
    }
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("ClawMobile next-tool decision helper")) {
      const content = state.localHelperContent ?? JSON.stringify(state.localHelper);
      json(response, completion({ role: "assistant", content }, "local-model"));
      return;
    }
    if (body.stream) {
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.end('data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]\n\n');
      return;
    }
    json(response, state.localAnswer);
  });

  const cloudBase = await listen(cloudServer);
  const localBase = await listen(localServer);
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-router-test-"));
  const configPath = join(directory, "openclaw.json");
  const logPath = join(directory, "router.jsonl");
  const capturePath = join(directory, "model-calls.jsonl");
  const captureRoot = join(directory, "captures");
  await writeFile(configPath, JSON.stringify({
    models: {
      providers: {
        cloud: {
          baseUrl: `${cloudBase}/v1`,
          apiKey: "cloud-secret",
          models: options.v4
            ? [{ id: "deepseek-v4-flash" }, { id: "qwen3.6-35b" }]
            : [{ id: "cloud-model" }],
        },
        openai: {
          baseUrl: `${cloudBase}/v1`,
          apiKey: "openai-secret",
          models: [{ id: "gpt-5.5" }],
        },
        decision: {
          baseUrl: `${cloudBase}/v1`,
          apiKey: "decision-secret",
          models: [{ id: "decision-model" }],
        },
        local: {
          baseUrl: `${localBase}/v1`,
          apiKey: "local-secret",
          models: options.v4
            ? [
                { id: "qwen3-8b" },
                { id: "qwen2.5-1.5b-instruct" },
                { id: "qwen3.8-27b" },
              ]
            : [{ id: "local-model" }],
        },
        "clawmobile-router": {
          baseUrl: "http://127.0.0.1:18081/v1",
          apiKey: PROXY_TOKEN,
          models: [{ id: "router" }],
        },
      },
    },
  }));

  const proxyEnv = {
    CLAW_ROUTER_CLOUD_PROVIDER: "cloud",
    CLAW_ROUTER_DECISION_PROVIDER: "decision",
    CLAW_ROUTER_DECISION_MODEL: "decision-model",
    CLAW_ROUTER_LOCAL_PROVIDER: "local",
    CLAW_ROUTER_CLIENT_TOKEN: PROXY_TOKEN,
    CLAW_ROUTER_CAMPAIGN_ID: "fixture-campaign",
    CLAW_ROUTER_ANSWER_TIMEOUT_MS: String(options.answerTimeoutMs || 5_000),
    CLAW_ROUTER_STRATEGY_TIMEOUT_MS: String(options.strategyTimeoutMs || 5_000),
  };
  if (!options.omitActiveStrategy) {
    proxyEnv.CLAW_ROUTER_ACTIVE_STRATEGY = options.activeStrategy ?? "filter";
  }
  if (options.v4) {
    delete proxyEnv.CLAW_ROUTER_ACTIVE_STRATEGY;
    proxyEnv.CLAW_ROUTER_V4_ENABLED = "1";
    proxyEnv.CLAW_ROUTER_V4_PROVIDER = "cloud";
    proxyEnv.CLAW_ROUTER_V4_XMU_PROVIDER = "local";
    proxyEnv.CLAW_ROUTER_V4_XMU_ACTIVE_MODEL =
      options.xmuModel || "qwen3-8b";
  }
  if (options.armId !== undefined) {
    proxyEnv.CLAW_ROUTER_ARM_ID = options.armId;
  }
  if (options.sessionId !== undefined) {
    proxyEnv.CLAW_ROUTER_SESSION_ID = options.sessionId;
  }

  let proxyServer;
  let captureStore;
  try {
    ({ server: proxyServer, captureStore } = await createRouterProxy({
      configPath,
      logPath: options.captureLogs ? logPath : null,
      capturePath: options.captureCalls ? capturePath : null,
      captureRoot: options.v4 ? captureRoot : null,
      env: proxyEnv,
    }));
  } catch (error) {
    for (const server of [cloudServer, localServer]) {
      server.closeAllConnections?.();
    }
    await Promise.all([
      new Promise((resolve) => cloudServer.close(resolve)),
      new Promise((resolve) => localServer.close(resolve)),
      rm(directory, { recursive: true, force: true }),
    ]);
    throw error;
  }
  const proxyBase = await listen(proxyServer);

  return {
    state,
    proxyBase,
    async logs() {
      const text = await readFile(logPath, "utf8");
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    async captures() {
      await captureStore.flush();
      const text = await readFile(capturePath, "utf8");
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    async v4Captures(runId) {
      const text = await readFile(join(captureRoot, runId, "model-calls.jsonl"), "utf8");
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    async close() {
      for (const server of [proxyServer, cloudServer, localServer]) {
        server.closeAllConnections?.();
      }
      await Promise.all([
        new Promise((resolve) => proxyServer.close(resolve)),
        new Promise((resolve) => cloudServer.close(resolve)),
        new Promise((resolve) => localServer.close(resolve)),
      ]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function requestBody(model, overrides = {}) {
  return {
    model,
    messages: [{ role: "user", content: "perform the requested action" }],
    tools: [
      { type: "function", function: { name: "tool_a", parameters: { type: "object", properties: { x: { type: "number" } } } } },
      { type: "function", function: { name: "tool_b", parameters: { type: "object", properties: {} } } },
    ],
    stream: false,
    ...overrides,
  };
}

function formalRunId(index) {
  return index.toString(16).padStart(32, "0");
}

function experimentRequestBody(runId, overrides = {}) {
  const { messages, ...rest } = overrides;
  return requestBody("experiment", {
    ...rest,
    messages: messages || [{
      role: "user",
      content: `perform the requested action [run:${runId}]`,
    }],
  });
}

function chatFetch(fixture, body, headers = {}) {
  return fetch(`${fixture.proxyBase}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PROXY_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function registerV4Run(fixture, runId, armId) {
  return fetch(`${fixture.proxyBase}/v1/experiment/runs/${runId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PROXY_TOKEN}`,
    },
    body: JSON.stringify({ arm_id: armId }),
  });
}

test("v4 long-lived proxy selects providers per registered run and partitions capture", async (t) => {
  const fixture = await startFixture({ v4: true });
  t.after(() => fixture.close());

  const filterRun = formalRunId(401);
  let response = await registerV4Run(
    fixture,
    filterRun,
    "filter-qwen36-agent-dsv4",
  );
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(filterRun));
  assert.equal(response.status, 200);
  assert.deepEqual(
    fixture.state.cloudRequests.slice(0, 2).map((row) => row.body.model),
    ["qwen3.6-35b", "deepseek-v4-flash"],
  );
  const filterCapture = await fixture.v4Captures(filterRun);
  assert.ok(filterCapture.every((row) => row.session_id === filterRun));
  assert.ok(filterCapture.every((row) => row.arm_id === "filter-qwen36-agent-dsv4"));
  assert.ok(filterCapture.some((row) => row.call_role === "filter_helper"));
  assert.ok(filterCapture.some((row) => row.call_role === "cloud_agent"));

  const fullRun = formalRunId(402);
  response = await registerV4Run(fixture, fullRun, "full-qwen36");
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(fullRun));
  assert.equal(response.status, 200);
  assert.equal(fixture.state.cloudRequests.at(-1).body.model, "qwen3.6-35b");
  const fullCapture = await fixture.v4Captures(fullRun);
  assert.ok(fullCapture.every((row) => row.session_id === fullRun));
  assert.ok(fullCapture.every((row) => row.arm_id === "full-qwen36"));
  assert.ok(fullCapture.some((row) => row.call_role === "cloud_agent"));
  assert.ok(!fullCapture.some((row) => /_helper$/u.test(row.call_role || "")));

  const gptRun = formalRunId(406);
  response = await registerV4Run(fixture, gptRun, "full-openai-gpt55");
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(gptRun));
  assert.equal(response.status, 200);
  assert.equal(fixture.state.cloudRequests.at(-1).body.model, "gpt-5.5");
  const gptCapture = await fixture.v4Captures(gptRun);
  assert.ok(gptCapture.every((row) => row.arm_id === "full-openai-gpt55"));
  assert.ok(gptCapture.some((row) => row.call_role === "cloud_agent"));
  assert.ok(!gptCapture.some((row) => /_helper$/u.test(row.call_role || "")));

  for (const [index, armId] of [
    [403, "full-xmu-qwen3-8b"],
    [404, "full-xmu-qwen2.5-1.5b"],
    [405, "full-xmu-qwen3.8-27b"],
  ]) {
    const model = "qwen3-8b";
    const runId = formalRunId(index);
    response = await registerV4Run(fixture, runId, armId);
    assert.equal(response.status, 201);
    response = await chatFetch(fixture, experimentRequestBody(runId));
    assert.equal(response.status, 200);
    assert.equal(fixture.state.localRequests.at(-1).body.model, model);
    const capture = await fixture.v4Captures(runId);
    assert.ok(capture.every((row) => row.session_id === runId));
    assert.ok(capture.every((row) => row.arm_id === armId));
    const localCall = capture.find((row) => row.call_role === "local_agent");
    assert.ok(localCall);
    assert.equal(localCall.provider_id, "local");
    assert.equal(localCall.model, model);
    assert.ok(!capture.some((row) => /_helper$/u.test(row.call_role || "")));
  }
});

test("v4 local-full uses the single active XMU model after a group switch", async (t) => {
  const fixture = await startFixture({
    v4: true,
    xmuModel: "qwen2.5-1.5b-instruct",
  });
  t.after(() => fixture.close());
  const runId = formalRunId(405);
  let response = await registerV4Run(
    fixture,
    runId,
    "full-xmu-qwen2.5-1.5b",
  );
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(runId));
  assert.equal(response.status, 200);
  assert.equal(
    fixture.state.localRequests.at(-1).body.model,
    "qwen2.5-1.5b-instruct",
  );
});

test("v4 local-full can bind the Qwen3.8-27B XMU service without helper calls", async (t) => {
  const fixture = await startFixture({
    v4: true,
    xmuModel: "qwen3.8-27b",
  });
  t.after(() => fixture.close());
  const runId = formalRunId(406);
  let response = await registerV4Run(
    fixture,
    runId,
    "full-xmu-qwen3.8-27b",
  );
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(runId));
  assert.equal(response.status, 200);
  assert.equal(fixture.state.localRequests.at(-1).body.model, "qwen3.8-27b");
  const capture = await fixture.v4Captures(runId);
  assert.ok(capture.some((row) => row.call_role === "local_agent"));
  assert.ok(!capture.some((row) => /_helper$/u.test(row.call_role || "")));
});

function finiteTool(name, properties = {}) {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties, additionalProperties: false },
    },
  };
}

test("G4-R1 authorizes only one empty-argument evidence Tool and records state", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const runId = formalRunId(406);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-r1-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "r1-evidence",
      type: "function",
      function: { name: "android_screenshot", arguments: "{}" },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(
    fixture,
    experimentRequestBody(runId, {
      tools: [
        finiteTool("android_screenshot"),
        finiteTool("android_ui_dump", { rawXml: { type: "boolean" } }),
        finiteTool("android_shell", { command: { type: "string" } }),
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-r1");
  const logicalLocalRequest = fixture.state.cloudRequests.find(
    (row) => row.body.model === "qwen3.6-35b" && !String(row.body.messages?.[0]?.content || "").includes("decision helper"),
  );
  assert.deepEqual(
    logicalLocalRequest.body.tools.map((tool) => tool.function.name),
    ["android_screenshot", "android_ui_dump"],
  );
  const decision = (await fixture.logs()).find(
    (event) => event.event === "router_decision",
  );
  assert.equal(decision.route_policy_version, "g4-r1-evidence-v1");
  assert.equal(decision.predicted_route_class, "EVIDENCE_LOCAL");
  assert.equal(decision.static_guard_passed, true);
  assert.equal(decision.route_state.phase, "PRECHECK");
});

test("G4-R1 rejects a Local shell completion before Tool execution and falls back Cloud", async (t) => {
  const fixture = await startFixture({ v4: true });
  t.after(() => fixture.close());
  const runId = formalRunId(407);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-r1-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "r1-shell",
      type: "function",
      function: { name: "android_shell", arguments: '{"command":"id"}' },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(
    fixture,
    experimentRequestBody(runId, {
      tools: [finiteTool("android_screenshot"), finiteTool("android_shell", {
        command: { type: "string" },
      })],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-clawmobile-route"),
    "cloud-router-r1-local-validation-fallback",
  );
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudRequests.length, 3);
});

test("G4-R2 allows a fresh-dump query and rejects the same dependency after mutation", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  fixture.state.routeClassHelper = {
    route_class: "GROUNDED_QUERY_LOCAL",
    reason_code: "FRESH_DUMP_GROUNDED_QUERY",
  };

  const freshRun = formalRunId(408);
  let response = await registerV4Run(
    fixture,
    freshRun,
    "router-r2-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "r2-query",
      type: "function",
      function: {
        name: "android_ui_query",
        arguments: '{"dumpId":"uidump_fresh","text":"Search"}',
      },
    }],
  }, "qwen3.6-35b");
  const dumpCall = {
    id: "dump-call",
    type: "function",
    function: { name: "android_ui_dump", arguments: "{}" },
  };
  const freshMessages = [
    { role: "user", content: `task [run:${freshRun}]` },
    { role: "assistant", content: null, tool_calls: [dumpCall] },
    {
      role: "tool",
      tool_call_id: "dump-call",
      content: '{"ok":true,"dump_id":"uidump_fresh"}',
    },
  ];
  response = await chatFetch(
    fixture,
    experimentRequestBody(freshRun, {
      messages: freshMessages,
      tools: [
        finiteTool("android_ui_query", {
          dumpId: { type: "string" },
          text: { type: "string" },
        }),
        finiteTool("android_tap", { x: { type: "integer" }, y: { type: "integer" } }),
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-r2");

  const staleRun = formalRunId(409);
  response = await registerV4Run(
    fixture,
    staleRun,
    "router-r2-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  const staleMessages = [
    { role: "user", content: `task [run:${staleRun}]` },
    { role: "assistant", content: null, tool_calls: [dumpCall] },
    {
      role: "tool",
      tool_call_id: "dump-call",
      content: '{"ok":true,"dump_id":"uidump_fresh"}',
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "tap-call",
        type: "function",
        function: { name: "android_tap", arguments: '{"x":1,"y":2}' },
      }],
    },
    { role: "tool", tool_call_id: "tap-call", content: '{"ok":true}' },
  ];
  const qwenBefore = fixture.state.cloudRequests.filter(
    (row) => row.body.model === "qwen3.6-35b",
  ).length;
  response = await chatFetch(
    fixture,
    experimentRequestBody(staleRun, {
      messages: staleMessages,
      tools: [finiteTool("android_ui_query", {
        dumpId: { type: "string" },
        text: { type: "string" },
      })],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-r2");
  assert.equal(
    fixture.state.cloudRequests.filter((row) => row.body.model === "qwen3.6-35b").length,
    qwenBefore,
  );
  const staleDecision = (await fixture.logs()).find(
    (event) =>
      event.event === "router_decision" &&
      event.session_id === staleRun,
  );
  assert.equal(staleDecision.route_state.pending_reobserve, true);
  assert.equal(staleDecision.static_guard_passed, false);
});

test("G4-RM routes only a fresh selected-center tap to Local and keeps shell Cloud", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const tapRun = formalRunId(410);
  let response = await registerV4Run(
    fixture,
    tapRun,
    "router-rm-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.routeClassHelper = {
    route_class: "INTERACT_UI_GROUNDED",
    reason_code: "FRESH_QUERY_GROUNDED_INTERACTION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "rm-tap",
      type: "function",
      function: { name: "android_tap", arguments: '{"x":420,"y":900}' },
    }],
  }, "qwen3.6-35b");
  const messages = [
    { role: "user", content: `task [run:${tapRun}]` },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "dump-call",
        type: "function",
        function: { name: "android_ui_dump", arguments: "{}" },
      }],
    },
    { role: "tool", tool_call_id: "dump-call", content: '{"ok":true,"dump_id":"uidump_fresh"}' },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "query-call",
        type: "function",
        function: {
          name: "android_ui_query",
          arguments: '{"dumpId":"uidump_fresh","text":"Save"}',
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "query-call",
      content: JSON.stringify({
        ok: true,
        dump_id: "uidump_fresh",
        best: {
          selected: {
            centerX: 420,
            centerY: 900,
            clickable: true,
            enabled: true,
          },
        },
      }),
    },
  ];
  response = await chatFetch(
    fixture,
    experimentRequestBody(tapRun, {
      messages,
      tools: [
        finiteTool("android_tap", { x: { type: "integer" }, y: { type: "integer" } }),
        finiteTool("adb_tap", { x: { type: "integer" }, y: { type: "integer" } }),
        finiteTool("android_shell", { command: { type: "string" } }),
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-rm");
  const localRequest = fixture.state.cloudRequests.find(
    (row) => row.body.model === "qwen3.6-35b" && !String(row.body.messages?.[0]?.content || "").includes("Router"),
  );
  assert.deepEqual(
    localRequest.body.tools.map((tool) => tool.function.name),
    ["android_tap", "adb_tap"],
  );

  const shellRun = formalRunId(411);
  response = await registerV4Run(
    fixture,
    shellRun,
    "router-rm-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.routeClassHelper = {
    route_class: "OPEN_EXEC_OR_COMPOSITE",
    reason_code: "OPEN_EXEC_OR_COMPOSITE",
  };
  const localRequestCount = fixture.state.cloudRequests.filter(
    (row) => row.body.model === "qwen3.6-35b",
  ).length;
  response = await chatFetch(
    fixture,
    experimentRequestBody(shellRun, {
      tools: [finiteTool("android_shell", { command: { type: "string" } })],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-rm");
  assert.equal(
    fixture.state.cloudRequests.filter((row) => row.body.model === "qwen3.6-35b").length,
    localRequestCount,
  );
});

test("G4-RM scoped baseline uses SC-v1 without changing the finite RouteClass", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const runId = formalRunId(412);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-rm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.routeClassHelper = {
    route_class: "OBSERVE_UI_RAW",
    reason_code: "FINITE_EVIDENCE_ACQUISITION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "scoped-shot",
      type: "function",
      function: { name: "android_screenshot", arguments: "{}" },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(
    fixture,
    experimentRequestBody(runId, {
      messages: [
        { role: "system", content: "Global tools include android_shell, exec, and android_screenshot." },
        { role: "user", content: `inspect the phone [run:${runId}]` },
      ],
      tools: [
        finiteTool("android_screenshot"),
        finiteTool("android_shell", { command: { type: "string" } }),
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-rm-scoped");
  const localRequest = fixture.state.cloudRequests.find(
    (row) => row.body.model === "qwen3.6-35b",
  );
  assert.deepEqual(
    localRequest.body.tools.map((tool) => tool.function.name),
    ["android_screenshot"],
  );
  assert.match(localRequest.body.messages[0].content, /scoped-local-static-affordance-v1/);
  assert.doesNotMatch(localRequest.body.messages[0].content, /android_shell|\bexec\b/);
  assert.equal(localRequest.body.messages[1].content, `inspect the phone [run:${runId}]`);
});

test("G4-FSM scoped constrains prediction and binds a failed Local transition to Cloud handoff", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const runId = formalRunId(413);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.routeClassHelper = {
    route_class: "OBSERVE_UI_RAW",
    reason_code: "FINITE_EVIDENCE_ACQUISITION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "fsm-dump",
      type: "function",
      function: { name: "android_ui_dump", arguments: "{}" },
    }],
  }, "qwen3.6-35b");
  const initialMessages = [
    { role: "system", content: "Global tools include android_shell, exec, and android_ui_dump." },
    { role: "user", content: `inspect the phone [run:${runId}]` },
  ];
  response = await chatFetch(
    fixture,
    experimentRequestBody(runId, {
      messages: initialMessages,
      tools: [
        finiteTool("android_ui_dump"),
        finiteTool("android_shell", { command: { type: "string" } }),
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-fsm-scoped");

  const firstRouterRequest = fixture.state.cloudRequests.find(
    (row) => String(row.body.messages?.[0]?.content || "").includes("finite RouteClass decision helper"),
  );
  assert.deepEqual(
    firstRouterRequest.body.response_format.json_schema.schema.properties.route_class.enum,
    [
      "OBSERVE_UI_RAW",
      "RETRIEVE_WEB_BOUNDED",
      "PERSIST_OR_SYSTEM_MUTATION",
      "OPEN_EXEC_OR_COMPOSITE",
      "VERIFY_COMPLETE_RECOVER",
      "NO_TOOL_OR_AMBIGUOUS",
    ],
  );

  fixture.state.routeClassHelper = {
    route_class: "VERIFY_COMPLETE_RECOVER",
    reason_code: "AUTHORITATIVE_VERIFY_OR_COMPLETE",
  };
  response = await chatFetch(
    fixture,
    experimentRequestBody(runId, {
      messages: [
        ...initialMessages,
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "fsm-dump",
            type: "function",
            function: { name: "android_ui_dump", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "fsm-dump", content: '{"ok":false,"error":"dump_failed"}' },
      ],
      tools: [finiteTool("android_ui_dump")],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-fsm-scoped");
  const logs = await fixture.logs();
  const resolved = logs.find(
    (event) => event.event === "fsm_transition_resolved" && event.session_id === runId,
  );
  assert.equal(resolved.transition_resolution.ok, false);
  assert.equal(
    resolved.transition_resolution.reason,
    "fsm_transition_typed_success_required",
  );
  const secondDecision = logs.filter(
    (event) => event.event === "router_decision" && event.session_id === runId,
  ).at(-1);
  assert.equal(secondDecision.fsm_forced_cloud_handoff, true);
  assert.deepEqual(secondDecision.fsm_admissible_route_classes, [
    "RETRIEVE_WEB_BOUNDED",
    "PERSIST_OR_SYSTEM_MUTATION",
    "OPEN_EXEC_OR_COMPOSITE",
    "VERIFY_COMPLETE_RECOVER",
    "NO_TOOL_OR_AMBIGUOUS",
  ]);
});

test("G4-FSM scoped accepts a matched transition and never shares it across runs", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const firstRun = formalRunId(414);
  let response = await registerV4Run(
    fixture,
    firstRun,
    "router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  const baseMessages = [
    { role: "system", content: "Global tools include android_ui_dump and android_ui_query." },
    { role: "user", content: `inspect and locate [run:${firstRun}]` },
  ];
  fixture.state.routeClassHelper = {
    route_class: "OBSERVE_UI_RAW",
    reason_code: "FINITE_EVIDENCE_ACQUISITION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "matched-dump",
      type: "function",
      function: { name: "android_ui_dump", arguments: "{}" },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(fixture, experimentRequestBody(firstRun, {
    messages: baseMessages,
    tools: [finiteTool("android_ui_dump"), finiteTool("android_ui_query", {
      dumpId: { type: "string" },
      text: { type: "string" },
    })],
  }));
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-fsm-scoped");

  fixture.state.routeClassHelper = {
    route_class: "QUERY_UI_GROUNDED",
    reason_code: "FRESH_DUMP_GROUNDED_QUERY",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "matched-query",
      type: "function",
      function: {
        name: "android_ui_query",
        arguments: '{"dumpId":"uidump_matched","text":"Save"}',
      },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(fixture, experimentRequestBody(firstRun, {
    messages: [
      ...baseMessages,
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "matched-dump",
          type: "function",
          function: { name: "android_ui_dump", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "matched-dump", content: '{"ok":true,"dump_id":"uidump_matched"}' },
    ],
    tools: [finiteTool("android_ui_query", {
      dumpId: { type: "string" },
      text: { type: "string" },
    })],
  }));
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-fsm-scoped");
  let logs = await fixture.logs();
  const matched = logs.find(
    (event) => event.event === "fsm_transition_resolved" && event.session_id === firstRun,
  );
  assert.equal(matched.transition_resolution.ok, true);
  const matchedDecision = logs.filter(
    (event) => event.event === "router_decision" && event.session_id === firstRun,
  ).at(-1);
  assert.equal(matchedDecision.fsm_forced_cloud_handoff, false);
  assert.equal(
    matchedDecision.fsm_admissible_route_classes.includes("QUERY_UI_GROUNDED"),
    true,
  );

  const secondRun = formalRunId(415);
  response = await registerV4Run(
    fixture,
    secondRun,
    "router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.routeClassHelper = {
    route_class: "OBSERVE_UI_RAW",
    reason_code: "FINITE_EVIDENCE_ACQUISITION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "other-shot",
      type: "function",
      function: { name: "android_screenshot", arguments: "{}" },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(fixture, experimentRequestBody(secondRun, {
    messages: [
      { role: "system", content: "Global tools include android_screenshot." },
      { role: "user", content: `inspect [run:${secondRun}]` },
    ],
    tools: [finiteTool("android_screenshot")],
  }));
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-fsm-scoped");
  logs = await fixture.logs();
  assert.equal(
    logs.some(
      (event) => event.event === "fsm_transition_resolved" && event.session_id === secondRun,
    ),
    false,
  );
});

test("G4-FSM scoped Standard Moderate Repair fully revalidates before Local execution", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const runId = formalRunId(416);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.routeClassHelper = {
    route_class: "OBSERVE_UI_RAW",
    reason_code: "FINITE_EVIDENCE_ACQUISITION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "repair-dump",
      type: "function",
      function: {
        name: "android_ui_dump",
        arguments: '{"compressed":false,"rawXml":false}',
      },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(fixture, experimentRequestBody(runId, {
    messages: [
      { role: "system", content: "Global tools include android_ui_dump and android_shell." },
      { role: "user", content: `inspect the phone [run:${runId}]` },
    ],
    tools: [
      finiteTool("android_ui_dump", {
        compressed: { type: "boolean" },
        rawXml: { type: "boolean" },
      }),
      finiteTool("android_shell", { command: { type: "string" } }),
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-clawmobile-route"),
    "local-router-fsm-scoped-repair",
  );
  assert.equal(response.headers.get("x-clawmobile-repair-applied"), "true");
  const payload = await response.json();
  assert.equal(
    payload.choices[0].message.tool_calls[0].function.arguments,
    "{}",
  );
  const logs = await fixture.logs();
  const attempted = logs.filter(
    (event) => event.event === "local_repair_attempted" && event.session_id === runId,
  );
  const applied = logs.filter(
    (event) => event.event === "local_repair_applied" && event.session_id === runId,
  );
  const routed = logs.filter(
    (event) => event.event === "request_routed" && event.session_id === runId,
  ).at(-1);
  assert.equal(attempted.length, 1);
  assert.equal(
    attempted[0].original_candidate.function.arguments,
    '{"compressed":false,"rawXml":false}',
  );
  assert.equal(attempted[0].proposed_candidate.function.arguments, "{}");
  assert.equal(attempted[0].deterministic_transformations.length, 2);
  assert.equal(applied.length, 1);
  assert.equal(
    applied[0].repair.policy_version,
    "g4-fsm-scoped-context-standard-moderate-repair-v1",
  );
  assert.equal(applied[0].repair.revalidation.base_tool_schema.ok, true);
  assert.equal(
    applied[0].repair.revalidation.finite_route_and_fsm_dependency.ok,
    true,
  );
  assert.equal(routed.repair.applied, true);
  assert.equal(routed.repair.repaired_candidate.function.arguments, "{}");

  const qwenRouterRunId = formalRunId(422);
  response = await registerV4Run(
    fixture,
    qwenRouterRunId,
    "router-fsm-scoped-repair-qwen36-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(qwenRouterRunId, {
    messages: [
      { role: "system", content: "Global tools include android_ui_dump and android_shell." },
      { role: "user", content: `inspect the phone [run:${qwenRouterRunId}]` },
    ],
    tools: [
      finiteTool("android_ui_dump", {
        compressed: { type: "boolean" },
        rawXml: { type: "boolean" },
      }),
      finiteTool("android_shell", { command: { type: "string" } }),
    ],
  }));
  assert.equal(response.status, 200);
  const qwenRouterCapture = await fixture.v4Captures(qwenRouterRunId);
  const qwenRouterHelper = qwenRouterCapture.find(
    (event) => event.event === "model_call" && event.call_role === "router_helper",
  );
  assert.ok(qwenRouterHelper);
  assert.equal(qwenRouterHelper.model, "qwen3.6-35b");
  assert.ok(qwenRouterCapture.some(
    (event) => event.event === "model_call" && event.call_role === "local_agent" && event.model === "qwen3.6-35b",
  ));
});

test("binary DSV4 gate exposes the FSM UI Tool union and derives RouteClass from Qwen Tool", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());

  const localRun = formalRunId(423);
  let response = await registerV4Run(
    fixture,
    localRun,
    "router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.binaryRoute = { route: "LOCAL_UI_CANDIDATE" };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "binary-dump",
      type: "function",
      function: { name: "android_ui_dump", arguments: "{}" },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(fixture, experimentRequestBody(localRun, {
    messages: [
      { role: "system", content: "Global tools include android_ui_dump and android_shell." },
      { role: "user", content: `inspect the phone [run:${localRun}]` },
    ],
    tools: [
      finiteTool("android_ui_dump"),
      finiteTool("android_shell", { command: { type: "string" } }),
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-binary-tool");
  const payload = await response.json();
  assert.equal(
    payload.choices[0].message.tool_calls[0].function.name,
    "android_ui_dump",
  );
  const binaryHelper = fixture.state.cloudRequests.find(
    (row) => String(row.body.messages?.[0]?.content || "")
      .includes("binary Local/Cloud routing helper"),
  );
  assert.ok(binaryHelper);
  assert.deepEqual(
    binaryHelper.body.response_format.json_schema.schema.properties.route.enum,
    ["LOCAL_UI_CANDIDATE", "CLOUD_REQUIRED"],
  );
  const localRequest = fixture.state.cloudRequests.find(
    (row) => row.body.model === "qwen3.6-35b",
  );
  assert.deepEqual(
    localRequest.body.tools.map((tool) => tool.function.name),
    ["android_ui_dump"],
  );
  const logs = await fixture.logs();
  const routed = logs.filter(
    (event) => event.event === "request_routed" && event.session_id === localRun,
  ).at(-1);
  assert.equal(routed.predicted_route_class, null);
  assert.equal(routed.effective_route_class, "OBSERVE_UI_RAW");
  assert.equal(routed.route_class_derived_from_tool, true);

  const cloudRun = formalRunId(424);
  response = await registerV4Run(
    fixture,
    cloudRun,
    "router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.binaryRoute = { route: "CLOUD_REQUIRED" };
  const localCallsBefore = fixture.state.cloudRequests.filter(
    (row) => row.body.model === "qwen3.6-35b",
  ).length;
  response = await chatFetch(fixture, experimentRequestBody(cloudRun, {
    messages: [
      { role: "system", content: "Global tools include android_ui_dump and android_shell." },
      { role: "user", content: `change a system setting [run:${cloudRun}]` },
    ],
    tools: [
      finiteTool("android_ui_dump"),
      finiteTool("android_shell", { command: { type: "string" } }),
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-binary-tool");
  assert.equal(
    fixture.state.cloudRequests.filter(
      (row) => row.body.model === "qwen3.6-35b",
    ).length,
    localCallsBefore,
  );
});

test("binary Strong-Path arm adds one bounded Cloud checkpoint before UI entry", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const runId = formalRunId(425);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-binary-tool-effect-aware-strong-path-check-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.binaryRoute = { route: "CLOUD_REQUIRED" };
  response = await chatFetch(fixture, experimentRequestBody(runId, {
    messages: [
      { role: "system", content: "Global Tool catalog." },
      { role: "user", content: `save the requested result [run:${runId}]` },
    ],
    tools: [
      finiteTool("android_ui_dump"),
      finiteTool("web_search", { query: { type: "string" } }, ["query"]),
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-clawmobile-route"),
    "cloud-router-binary-tool-effect-aware-strong-path-check",
  );
  const cloudCall = fixture.state.cloudRequests.find(
    (row) => row.body.model === "deepseek-v4-flash" &&
      row.body.messages?.some((message) => String(message.content || "").includes("Strong-Path") || String(message.content || "").includes("safe provider, web, file, shell")),
  );
  assert.ok(cloudCall);
  assert.deepEqual(cloudCall.body.tools.map((tool) => tool.function.name), [
    "android_ui_dump",
    "web_search",
  ]);
  const logs = await fixture.logs();
  const checks = logs.filter(
    (event) => event.event === "strong_path_check_applied" && event.session_id === runId,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].check.trigger, "cloud_before_first_ui_action");
  assert.equal(checks[0].check.successful_ui_action_count_before, 0);
});

test("explicit binary Tool policy skips the model Router and exposes one exact FSM Tool", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const runId = formalRunId(431);
  let response = await registerV4Run(
    fixture,
    runId,
    "router-explicit-binary-tool-deterministic-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "explicit-query",
      type: "function",
      function: {
        name: "android_ui_query",
        arguments: '{"dumpId":"uidump_explicit","text":"Save"}',
      },
    }],
  }, "qwen3.6-35b");
  response = await chatFetch(fixture, experimentRequestBody(runId, {
    messages: [
      { role: "system", content: "Global Tool catalog includes UI and shell Tools." },
      { role: "user", content: `find Save [run:${runId}]` },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "explicit-dump",
          type: "function",
          function: { name: "android_ui_dump", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "explicit-dump", content: '{"ok":true,"dump_id":"uidump_explicit"}' },
    ],
    tools: [
      finiteTool("android_screenshot"),
      finiteTool("android_ui_dump"),
      finiteTool("android_ui_query", {
        dumpId: { type: "string" },
        text: { type: "string" },
      }),
      finiteTool("android_shell", { command: { type: "string" } }),
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-clawmobile-route"),
    "local-router-explicit-binary-tool",
  );
  const providerRequests = fixture.state.cloudRequests;
  assert.equal(providerRequests.filter(
    (row) => row.body.model === "deepseek-v4-flash").length, 0);
  const localRequest = providerRequests.find(
    (row) => row.body.model === "qwen3.6-35b").body;
  assert.deepEqual(localRequest.tools.map((tool) => tool.function.name), [
    "android_ui_query",
  ]);
  assert.deepEqual(localRequest.tool_choice, {
    type: "function",
    function: { name: "android_ui_query" },
  });
  const logs = await fixture.logs();
  const decision = logs.find(
    (event) => event.event === "router_decision" && event.session_id === runId,
  );
  assert.equal(decision.helper_invoked, false);
  assert.equal(decision.deterministic_policy_invoked, true);
  assert.equal(decision.selected_exact_tool, "android_ui_query");
  assert.equal(decision.predicted_route_class, "QUERY_UI_GROUNDED");
});

test("Route-Flex C0 rejects, C1 reclassifies, and C2 exposes the FSM-admissible Tool union", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const arms = [
    [417, "C0", "router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local"],
    [418, "C1", "router-fsm-scoped-repair-c1-dsv4-agent-dsv4-qwen36-logical-local"],
    [419, "C2", "router-fsm-scoped-repair-c2-dsv4-agent-dsv4-qwen36-logical-local"],
  ];
  for (const [index, condition, armId] of arms) {
    const runId = formalRunId(index);
    let response = await registerV4Run(fixture, runId, armId);
    assert.equal(response.status, 201);
    fixture.state.routeClassHelper = {
      route_class: "OBSERVE_UI_RAW",
      reason_code: "FINITE_EVIDENCE_ACQUISITION",
    };
    fixture.state.localAnswer = completion({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `route-flex-${condition}`,
        type: "function",
        function: {
          name: "android_ui_query",
          arguments: '{"dumpId":"uidump_route_flex","text":"Save"}',
        },
      }],
    }, "qwen3.6-35b");
    response = await chatFetch(fixture, experimentRequestBody(runId, {
      messages: [
        { role: "system", content: "Global Tool catalog includes observation, query, and shell Tools." },
        { role: "user", content: `locate Save [run:${runId}]` },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "route-flex-dump",
            type: "function",
            function: { name: "android_ui_dump", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "route-flex-dump", content: '{"ok":true,"dump_id":"uidump_route_flex"}' },
      ],
      tools: [
        finiteTool("android_screenshot"),
        finiteTool("android_ui_dump"),
        finiteTool("android_ui_query", {
          dumpId: { type: "string" },
          text: { type: "string" },
        }),
        finiteTool("android_shell", { command: { type: "string" } }),
      ],
    }));
    if (response.status !== 200) {
      assert.fail(`Route-Flex ${condition} request failed: ${response.status} ${await response.text()}`);
    }
    const expectedRoute = condition === "C0"
      ? "cloud-router-fsm-scoped-repair-local-validation-fallback"
      : "local-router-fsm-scoped-repair";
    assert.equal(response.headers.get("x-clawmobile-route"), expectedRoute);
    const localTools = fixture.state.cloudRequests.filter(
      (row) => row.body.model === "qwen3.6-35b",
    ).at(-1).body.tools.map(
      (tool) => tool.function.name,
    );
    if (condition === "C2") {
      assert.deepEqual(localTools.sort(), [
        "android_screenshot",
        "android_ui_dump",
        "android_ui_query",
      ]);
    } else {
      assert.deepEqual(localTools.sort(), ["android_screenshot", "android_ui_dump"]);
    }
    const logs = await fixture.logs();
    const applied = logs.filter(
      (event) => event.event === "local_route_reclassification_applied" && event.session_id === runId,
    );
    assert.equal(applied.length, condition === "C0" ? 0 : 1);
    if (condition !== "C0") {
      assert.equal(applied[0].route_flex_condition, condition);
      assert.equal(applied[0].predicted_route_class, "OBSERVE_UI_RAW");
      assert.equal(applied[0].effective_route_class, "QUERY_UI_GROUNDED");
      assert.equal(applied[0].base_tool_schema.ok, true);
      assert.equal(applied[0].finite_route_and_fsm_dependency.ok, true);
    }
  }
});

test("Cloud-first suppresses only the first validated UI mutation and preserves Baseline", async (t) => {
  const fixture = await startFixture({ v4: true, captureLogs: true });
  t.after(() => fixture.close());
  const tools = [
    finiteTool("android_ui_dump"),
    finiteTool("android_ui_query", {
      dumpId: { type: "string" },
      text: { type: "string" },
    }),
    finiteTool("android_tap", {
      x: { type: "integer" },
      y: { type: "integer" },
    }),
    finiteTool("android_shell", { command: { type: "string" } }),
  ];
  const readyMessages = (runId, suffix = "first") => [
    { role: "system", content: "Global Tool catalog includes UI observation, query, interaction, and shell Tools." },
    { role: "user", content: `tap Save [run:${runId}]` },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `dump-${suffix}`,
        type: "function",
        function: { name: "android_ui_dump", arguments: "{}" },
      }],
    },
    { role: "tool", tool_call_id: `dump-${suffix}`, content: `{"ok":true,"dump_id":"uidump-${suffix}"}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `query-${suffix}`,
        type: "function",
        function: {
          name: "android_ui_query",
          arguments: `{"dumpId":"uidump-${suffix}","text":"Save"}`,
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: `query-${suffix}`,
      content: JSON.stringify({
        ok: true,
        dump_id: `uidump-${suffix}`,
        best: { selected: { centerX: 420, centerY: 900, clickable: true, enabled: true } },
      }),
    },
  ];
  fixture.state.routeClassHelper = {
    route_class: "INTERACT_UI_GROUNDED",
    reason_code: "FRESH_QUERY_GROUNDED_INTERACTION",
  };
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "local-tap",
      type: "function",
      function: { name: "android_tap", arguments: '{"x":420,"y":900}' },
    }],
  }, "qwen3.6-35b");

  const baselineRun = formalRunId(420);
  let response = await registerV4Run(
    fixture,
    baselineRun,
    "router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  response = await chatFetch(fixture, experimentRequestBody(baselineRun, {
    messages: readyMessages(baselineRun),
    tools,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-fsm-scoped-repair");

  const cloudFirstRun = formalRunId(421);
  response = await registerV4Run(
    fixture,
    cloudFirstRun,
    "router-fsm-scoped-repair-cloud-first-dsv4-agent-dsv4-qwen36-logical-local",
  );
  assert.equal(response.status, 201);
  fixture.state.cloudAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "cloud-first-cloud-tap",
      type: "function",
      function: { name: "android_tap", arguments: '{"x":420,"y":900}' },
    }],
  }, "deepseek-v4-flash");
  response = await chatFetch(fixture, experimentRequestBody(cloudFirstRun, {
    messages: readyMessages(cloudFirstRun),
    tools,
  }));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-clawmobile-route"),
    "cloud-router-fsm-scoped-repair-cloud-first-first-ui-mutation",
  );
  const firstCloudRequest = fixture.state.cloudRequests.at(-1).body;
  assert.deepEqual(
    firstCloudRequest.tools.map((tool) => tool.function.name),
    tools.map((tool) => tool.function.name),
  );

  const afterFirstMutation = [
    ...readyMessages(cloudFirstRun),
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "cloud-first-cloud-tap",
        type: "function",
        function: { name: "android_tap", arguments: '{"x":420,"y":900}' },
      }],
    },
    { role: "tool", tool_call_id: "cloud-first-cloud-tap", content: '{"ok":true}' },
    ...readyMessages(cloudFirstRun, "second").slice(2),
  ];
  response = await chatFetch(fixture, experimentRequestBody(cloudFirstRun, {
    messages: afterFirstMutation,
    tools,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-router-fsm-scoped-repair");
  const logs = await fixture.logs();
  const gates = logs.filter(
    (event) => event.event === "cloud_first_ui_mutation_gate_triggered" && event.session_id === cloudFirstRun,
  );
  assert.equal(gates.length, 1);
  assert.equal(gates[0].gate.candidate_tool_name, "android_tap");
  assert.equal(gates[0].gate.base_tool_schema_valid, true);
  assert.equal(gates[0].gate.finite_route_and_fsm_dependency_valid, true);
  assert.equal(
    logs.some(
      (event) => event.event === "cloud_first_ui_mutation_gate_triggered" && event.session_id === baselineRun,
    ),
    false,
  );
});

test("health and models expose no provider secrets", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const healthText = await (await fetch(`${fixture.proxyBase}/health`)).text();
  assert.match(healthText, /clawmobile-router-proxy/);
  assert.match(healthText, /"active_strategy":"filter"/);
  assert.match(healthText, /"arm_id":"experiment"/);
  assert.match(healthText, /"local_validation_level":"parameter_schema_subset_v1"/);
  assert.match(healthText, /"capture_root":/);
  assert.doesNotMatch(healthText, /cloud-secret|decision-secret|local-secret/);

  const models = await (await fetch(`${fixture.proxyBase}/v1/models`)).json();
  assert.deepEqual(
    models.data.map((item) => item.id),
    ["cloud-full", "local-full", "filter", "router", "experiment"],
  );
});

test("experiment active strategy accepts the approved formal strategies", async () => {
  const validStrategies = [
    "cloud-full",
    "local-full",
    "filter",
    "router",
    "router-r1",
    "router-r2",
    "router-rm",
    "router-rm-scoped",
    "router-fsm-scoped",
    "router-fsm-scoped-repair",
    "router-fsm-scoped-repair-cloud-first",
    "router-fsm-scoped-repair-c1",
    "router-fsm-scoped-repair-c2",
    "router-binary-tool",
    "router-binary-tool-effect-aware",
    "router-binary-tool-effect-aware-strong-path-check",
    "router-explicit-binary-tool",
  ];
  for (const activeStrategy of validStrategies) {
    const fixture = await startFixture({
      activeStrategy,
      armId: `formal-${activeStrategy}`,
    });
    try {
      const health = await (await fetch(`${fixture.proxyBase}/health`)).json();
      assert.equal(health.active_strategy, activeStrategy);
      assert.equal(health.arm_id, `formal-${activeStrategy}`);
    } finally {
      await fixture.close();
    }
  }

  for (const activeStrategy of ["", "experiment", "cloud", "Cloud-full"]) {
    await assert.rejects(
      startFixture({ activeStrategy }),
      /CLAW_ROUTER_ACTIVE_STRATEGY must be one of:/,
    );
  }
});

test("explicit virtual models start without an experiment strategy", async (t) => {
  const fixture = await startFixture({ omitActiveStrategy: true });
  t.after(() => fixture.close());
  let response = await chatFetch(fixture, requestBody("cloud-full"));
  assert.equal(response.status, 200);
  await response.text();

  const runId = formalRunId(1);
  response = await chatFetch(fixture, experimentRequestBody(runId), {
    "x-clawmobile-session-id": runId,
  });
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error.code,
    "experiment_strategy_not_configured",
  );
  const health = await (await fetch(`${fixture.proxyBase}/health`)).json();
  assert.equal(health.active_strategy, null);
});

test("experiment fails closed before upstream without a valid cell session", async (t) => {
  const fixture = await startFixture({
    activeStrategy: "cloud-full",
    sessionId: "environment-must-not-authorize-formal",
    captureCalls: true,
  });
  t.after(() => fixture.close());

  const runIdA = formalRunId(10);
  const runIdB = formalRunId(11);
  const invalidRequests = [
    { body: requestBody("experiment"), headers: {} },
    {
      body: requestBody("experiment", {
        messages: [{ role: "user", content: "short marker run:tiny" }],
      }),
      headers: {},
    },
    {
      body: requestBody("experiment", {
        messages: [{ role: "user", content: "invalid marker cannot be hidden run:tiny" }],
      }),
      headers: { "x-clawmobile-session-id": runIdA },
    },
    {
      body: requestBody("experiment", {
        messages: [{
          role: "user",
          content: `ambiguous run:${runIdA} run:${runIdB}`,
        }],
      }),
      headers: {},
    },
    {
      body: requestBody("experiment", {
        messages: [{
          role: "user",
          content: `duplicate run:${runIdA} run:${runIdA}`,
        }],
      }),
      headers: {},
    },
    {
      body: requestBody("experiment", {
        messages: [{
          role: "user",
          content: `uppercase run:${"ABCDEF0123456789ABCDEF0123456789"}`,
        }],
      }),
      headers: {},
    },
  ];

  for (const item of invalidRequests) {
    const response = await chatFetch(fixture, item.body, item.headers);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "experiment_session_required");
  }
  assert.equal(fixture.state.cloudRequests.length, 0);
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudHelperAttempts, 0);
  const captures = await fixture.captures();
  assert.equal(captures.length, invalidRequests.length);
  assert.equal(captures.every((record) => record.event === "proxy_request"), true);
  assert.equal(
    captures.every((record) => record.session_source === "experiment-session-invalid"),
    true,
  );
  assert.equal(
    captures.every((record) => record.session_validation_error === "experiment_session_required"),
    true,
  );
  const health = await (await fetch(`${fixture.proxyBase}/health`)).json();
  assert.equal(health.capture.pending, 0);
  assert.equal(health.capture.errors, 0);
  assert.equal(health.capture.record_count, invalidRequests.length);
  assert.equal(health.capture.model_call_count, 0);
  assert.equal(health.capture.durable_record_count, invalidRequests.length);
  assert.equal(health.capture.durable_model_call_count, 0);
});

test("experiment rejects conflicting session headers after inbound capture and before upstream", async (t) => {
  const fixture = await startFixture({
    activeStrategy: "cloud-full",
    captureCalls: true,
  });
  t.after(() => fixture.close());

  const runId = formalRunId(20);
  const otherRunId = formalRunId(21);
  const conflictingHeaders = [
    { "x-clawmobile-session-id": otherRunId },
    { "x-session-id": otherRunId },
    {
      "x-clawmobile-session-id": runId,
      "x-session-id": otherRunId,
    },
    { "x-clawmobile-session-id": `${runId}-invalid` },
  ];

  for (const headers of conflictingHeaders) {
    const response = await chatFetch(
      fixture,
      experimentRequestBody(runId),
      headers,
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "experiment_session_conflict");
  }
  assert.equal(fixture.state.cloudRequests.length, 0);
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudHelperAttempts, 0);
  const captures = await fixture.captures();
  assert.equal(captures.length, conflictingHeaders.length);
  assert.equal(captures.every((record) => record.event === "proxy_request"), true);
  assert.equal(captures.every((record) => record.session_id === runId), true);
  assert.equal(
    captures.every((record) => record.session_source === "clawbench-run-marker"),
    true,
  );
  assert.equal(
    captures.every((record) => record.session_validation_error === "experiment_session_conflict"),
    true,
  );
});

test("experiment records the authoritative run marker with matching Channel headers", async () => {
  const runId = formalRunId(30);
  const cases = [
    {
      headers: {},
    },
    {
      headers: { "x-clawmobile-session-id": runId },
    },
    {
      headers: { "x-session-id": runId },
    },
    {
      headers: {
        "x-clawmobile-session-id": runId,
        "x-session-id": runId,
      },
    },
  ];

  for (const item of cases) {
    const fixture = await startFixture({
      activeStrategy: "cloud-full",
      captureCalls: true,
    });
    try {
      const response = await chatFetch(
        fixture,
        experimentRequestBody(runId),
        item.headers,
      );
      assert.equal(response.status, 200);
      await response.text();

      const records = await fixture.captures();
      const scopedRecords = records.filter(
        (record) => record.event === "proxy_request" || record.event === "model_call",
      );
      assert.equal(scopedRecords.length, 2);
      assert.equal(scopedRecords.every((record) => record.session_id === runId), true);
      assert.equal(
        scopedRecords.every((record) => record.session_source === "clawbench-run-marker"),
        true,
      );
      const call = scopedRecords.find((record) => record.event === "model_call");
      assert.equal(call.upstream_session_id, `cm-${runId}-agent`);
    } finally {
      await fixture.close();
    }
  }
});

test("experiment accepts one valid explicit session header when no run marker exists", async () => {
  const runId = formalRunId(31);
  const cases = [
    {
      headers: { "x-clawmobile-session-id": runId },
      source: "x-clawmobile-session-id",
    },
    {
      headers: { "x-session-id": runId },
      source: "x-session-id",
    },
    {
      headers: {
        "x-clawmobile-session-id": runId,
        "x-session-id": runId,
      },
      source: "x-clawmobile-session-id",
    },
  ];

  for (const item of cases) {
    const fixture = await startFixture({
      activeStrategy: "cloud-full",
      sessionId: "environment-must-be-ignored",
      captureCalls: true,
    });
    try {
      const response = await chatFetch(
        fixture,
        requestBody("experiment"),
        item.headers,
      );
      assert.equal(response.status, 200);
      await response.text();
      const records = (await fixture.captures()).filter(
        (record) => record.event === "proxy_request" || record.event === "model_call",
      );
      assert.equal(records.length, 2);
      assert.equal(records.every((record) => record.session_id === runId), true);
      assert.equal(records.every((record) => record.session_source === item.source), true);
    } finally {
      await fixture.close();
    }
  }
});

test("experiment rejects invalid or mismatched explicit headers before upstream", async (t) => {
  const fixture = await startFixture({ activeStrategy: "cloud-full", captureCalls: true });
  t.after(() => fixture.close());
  const runId = formalRunId(32);
  const otherRunId = formalRunId(33);
  const alphabeticRunId = "abcdefabcdefabcdefabcdefabcdefab";
  const cases = [
    { "x-clawmobile-session-id": "short" },
    { "x-session-id": alphabeticRunId.toUpperCase() },
    { "x-clawmobile-session-id": `0${runId}` },
    { "x-clawmobile-session-id": runId, "x-session-id": otherRunId },
  ];
  for (const headers of cases) {
    const response = await chatFetch(fixture, requestBody("experiment"), headers);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "experiment_session_conflict");
  }
  assert.equal(fixture.state.cloudRequests.length, 0);
  assert.equal(fixture.state.localRequests.length, 0);
  const records = await fixture.captures();
  assert.equal(records.length, cases.length);
  assert.equal(records.every((record) => record.event === "proxy_request"), true);
});

test("explicit models ignore CLAW_ROUTER_SESSION_ID and retain campaign fallback", async () => {
  const cases = [
    {
      options: { omitActiveStrategy: true, sessionId: "explicit-env-session" },
      expectedId: "fixture-campaign",
      expectedSource: "campaign",
    },
    {
      options: { omitActiveStrategy: true },
      expectedId: "fixture-campaign",
      expectedSource: "campaign",
    },
  ];

  for (const item of cases) {
    const fixture = await startFixture({ ...item.options, captureCalls: true });
    try {
      const response = await chatFetch(fixture, requestBody("cloud-full"));
      assert.equal(response.status, 200);
      await response.text();
      const call = (await fixture.captures()).find(
        (record) => record.event === "model_call",
      );
      assert.equal(call.session_id, item.expectedId);
      assert.equal(call.session_source, item.expectedSource);
    } finally {
      await fixture.close();
    }
  }
});

test("experiment full arms make one direct final call and preserve Local streaming", async () => {
  const cases = [
    {
      activeStrategy: "cloud-full",
      armId: "dsv4-cloud-full",
      route: "cloud",
      callRole: "cloud_agent",
      serviceRole: "agent",
      stream: false,
      expectedCloudRequests: 1,
      expectedLocalRequests: 0,
    },
    {
      activeStrategy: "local-full",
      armId: "qwen-local-full",
      route: "local-only",
      callRole: "local_agent",
      serviceRole: "local-agent",
      stream: true,
      expectedCloudRequests: 0,
      expectedLocalRequests: 1,
    },
  ];

  for (const item of cases) {
    const fixture = await startFixture({
      activeStrategy: item.activeStrategy,
      armId: item.armId,
      captureCalls: true,
    });
    try {
      const sessionId = formalRunId(item.activeStrategy === "cloud-full" ? 40 : 41);
      const body = experimentRequestBody(sessionId, {
        stream: item.stream,
        ...(item.stream ? { stream_options: { include_usage: true } } : {}),
      });
      const response = await chatFetch(fixture, body, {
        "x-clawmobile-session-id": sessionId,
        "x-request-id": `turn-${item.activeStrategy}`,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-clawmobile-route"), item.route);
      const responseText = await response.text();

      assert.equal(fixture.state.cloudRequests.length, item.expectedCloudRequests);
      assert.equal(fixture.state.localRequests.length, item.expectedLocalRequests);
      assert.equal(fixture.state.cloudHelperAttempts, 0);
      const physicalRequests = [
        ...fixture.state.cloudRequests,
        ...fixture.state.localRequests,
      ];
      assert.equal(physicalRequests.length, 1);
      assert.doesNotMatch(
        String(physicalRequests[0].body.messages?.[0]?.content || ""),
        /ClawMobile next-tool decision helper/,
      );

      if (item.activeStrategy === "local-full") {
        assert.equal(physicalRequests[0].body.stream, true);
        assert.deepEqual(physicalRequests[0].body.stream_options, {
          include_usage: true,
        });
        assert.equal(
          responseText,
          'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]\n\n',
        );
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
      }

      const records = await fixture.captures();
      const modelCalls = records.filter((record) => record.event === "model_call");
      assert.equal(modelCalls.length, 1);
      assert.equal(modelCalls[0].call_role, item.callRole);
      assert.equal(modelCalls[0].service_role, item.serviceRole);
      assert.equal(modelCalls[0].virtual_model, "experiment");
      assert.equal(modelCalls[0].arm_id, item.armId);
      assert.equal(
        records.some((record) => record.call_role === "local_agent_downstream"),
        false,
      );

      const health = await (await fetch(`${fixture.proxyBase}/health`)).json();
      assert.equal(health.active_strategy, item.activeStrategy);
      assert.equal(health.arm_id, item.armId);
    } finally {
      await fixture.close();
    }
  }
});

test("explicit virtual models are never replaced by the active experiment strategy", async () => {
  const cases = [
    { activeStrategy: "router", model: "cloud-full", route: "cloud" },
    { activeStrategy: "filter", model: "local-full", route: "local-only" },
    { activeStrategy: "local-full", model: "filter", route: "filter" },
    { activeStrategy: "cloud-full", model: "router", route: "local" },
  ];

  for (const item of cases) {
    const fixture = await startFixture({ activeStrategy: item.activeStrategy });
    try {
      const response = await chatFetch(fixture, requestBody(item.model));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-clawmobile-route"), item.route);
      await response.text();
    } finally {
      await fixture.close();
    }
  }
});

test("one experiment model selects mutually exclusive Filter and Router process configs", async (t) => {
  const filterFixture = await startFixture({
    activeStrategy: "filter",
    armId: "dsv4-filter-dsv4-agent",
    captureCalls: true,
  });
  const routerFixture = await startFixture({
    activeStrategy: "router",
    armId: "dsv4-router-qwen3-8b-local",
    captureCalls: true,
  });
  t.after(async () => {
    await Promise.all([filterFixture.close(), routerFixture.close()]);
  });

  const sessionId = formalRunId(50);
  let response = await chatFetch(filterFixture, experimentRequestBody(sessionId), {
    "x-clawmobile-session-id": sessionId,
    "x-request-id": "filter-turn-01",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "filter");
  await response.text();

  response = await chatFetch(routerFixture, experimentRequestBody(sessionId), {
    "x-clawmobile-session-id": sessionId,
    "x-request-id": "router-turn-01",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  await response.text();

  assert.equal(filterFixture.state.cloudRequests.length, 2);
  assert.equal(filterFixture.state.localRequests.length, 0);
  assert.equal(routerFixture.state.cloudRequests.length, 1);
  assert.equal(routerFixture.state.localRequests.length, 1);

  const filterCalls = (await filterFixture.captures()).filter(
    (item) => item.event === "model_call",
  );
  assert.deepEqual(
    filterCalls.map((item) => item.service_role),
    ["filter", "agent"],
  );
  assert.deepEqual(
    filterCalls.map((item) => item.upstream_session_id),
    [`cm-${sessionId}-filter`, `cm-${sessionId}-agent`],
  );
  assert.equal(
    filterCalls.every((item) => item.virtual_model === "experiment"),
    true,
  );
  assert.equal(
    filterCalls.every((item) => item.arm_id === "dsv4-filter-dsv4-agent"),
    true,
  );

  const routerCalls = (await routerFixture.captures()).filter(
    (item) => item.event === "model_call",
  );
  assert.deepEqual(
    routerCalls.map((item) => item.service_role),
    ["router", "local-agent"],
  );
  assert.deepEqual(
    routerCalls.map((item) => item.upstream_session_id),
    [`cm-${sessionId}-router`, `cm-${sessionId}-local-agent`],
  );
  assert.equal(
    routerCalls.every((item) => item.virtual_model === "experiment"),
    true,
  );
  assert.equal(
    routerCalls.every(
      (item) => item.arm_id === "dsv4-router-qwen3-8b-local",
    ),
    true,
  );

  const filterHealth = await (await fetch(`${filterFixture.proxyBase}/health`)).json();
  const routerHealth = await (await fetch(`${routerFixture.proxyBase}/health`)).json();
  assert.equal(filterHealth.active_strategy, "filter");
  assert.equal(filterHealth.arm_id, "dsv4-filter-dsv4-agent");
  assert.equal(routerHealth.active_strategy, "router");
  assert.equal(routerHealth.arm_id, "dsv4-router-qwen3-8b-local");
  assert.doesNotMatch(
    JSON.stringify([filterHealth, routerHealth]),
    /cloud-secret|decision-secret|local-secret/,
  );
});

test("one formal cell keeps Filter, Router, Cloud, and Local sessions isolated", async () => {
  const sessionId = formalRunId(60);
  const cases = [
    { activeStrategy: "filter", expectedRoles: ["filter", "agent"] },
    { activeStrategy: "router", expectedRoles: ["router", "local-agent"] },
    { activeStrategy: "cloud-full", expectedRoles: ["agent"] },
    { activeStrategy: "local-full", expectedRoles: ["local-agent"] },
  ];
  const allCalls = [];

  for (const item of cases) {
    const fixture = await startFixture({
      activeStrategy: item.activeStrategy,
      armId: `formal-${item.activeStrategy}`,
      captureCalls: true,
    });
    try {
      const response = await chatFetch(fixture, experimentRequestBody(sessionId), {
        "x-clawmobile-session-id": sessionId,
        "x-request-id": `turn-${item.activeStrategy}`,
      });
      assert.equal(response.status, 200);
      await response.text();
      const calls = (await fixture.captures()).filter(
        (record) => record.event === "model_call",
      );
      assert.deepEqual(calls.map((call) => call.service_role), item.expectedRoles);
      allCalls.push(...calls);
    } finally {
      await fixture.close();
    }
  }

  assert.equal(
    allCalls.every((call) => call.session_id === sessionId),
    true,
  );
  assert.equal(
    allCalls.every((call) => call.session_source === "clawbench-run-marker"),
    true,
  );
  for (const call of allCalls) {
    assert.equal(
      call.upstream_session_id,
      `cm-${sessionId}-${call.service_role}`,
    );
    assert.equal(call.attempt_index, 1);
  }
  assert.deepEqual(
    new Set(allCalls.map((call) => call.upstream_session_id)),
    new Set([
      `cm-${sessionId}-filter`,
      `cm-${sessionId}-router`,
      `cm-${sessionId}-agent`,
      `cm-${sessionId}-local-agent`,
    ]),
  );
  const serviceRequestIds = allCalls.map((call) => call.service_request_id);
  assert.equal(new Set(serviceRequestIds).size, serviceRequestIds.length);
});

test("different formal cells receive different role-specific upstream sessions", async (t) => {
  const fixture = await startFixture({
    activeStrategy: "filter",
    captureCalls: true,
  });
  t.after(() => fixture.close());
  const cellIds = [formalRunId(70), formalRunId(71)];

  for (const cellId of cellIds) {
    const response = await chatFetch(fixture, experimentRequestBody(cellId), {
      "x-clawmobile-session-id": cellId,
      "x-request-id": `turn-${cellId}`,
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  const calls = (await fixture.captures()).filter(
    (record) => record.event === "model_call",
  );
  assert.equal(calls.length, 4);
  for (const cellId of cellIds) {
    const cellCalls = calls.filter((call) => call.session_id === cellId);
    assert.deepEqual(
      cellCalls.map((call) => call.upstream_session_id),
      [`cm-${cellId}-filter`, `cm-${cellId}-agent`],
    );
  }
  assert.equal(new Set(calls.map((call) => call.upstream_session_id)).size, 4);
  assert.equal(new Set(calls.map((call) => call.service_request_id)).size, 4);
});

test("compatible explicit-model session IDs cannot collide after upstream normalization", async (t) => {
  const fixture = await startFixture({
    activeStrategy: "cloud-full",
    captureCalls: true,
  });
  t.after(() => fixture.close());
  const cellIds = ["formal:normalization-cell-0001", "formal-normalization-cell-0001"];

  for (const cellId of cellIds) {
    const response = await chatFetch(fixture, requestBody("cloud-full"), {
      "x-clawmobile-session-id": cellId,
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  const calls = (await fixture.captures()).filter(
    (record) => record.event === "model_call",
  );
  assert.deepEqual(calls.map((call) => call.session_id), cellIds);
  assert.equal(new Set(calls.map((call) => call.upstream_session_id)).size, 2);
  assert.equal(
    calls.every((call) => call.upstream_session_id.endsWith("-agent")),
    true,
  );
});

test("chat completions rejects missing or wrong bearer tokens before upstream", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  let response = await fetch(`${fixture.proxyBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody("local-full")),
  });
  assert.equal(response.status, 401);
  response = await chatFetch(fixture, requestBody("local-full"), {
    authorization: "Bearer wrong-token",
  });
  assert.equal(response.status, 401);
  assert.equal(fixture.state.cloudRequests.length, 0);
  assert.equal(fixture.state.localRequests.length, 0);
});

test("cloud-full and local-full are mutually exclusive and keep credentials isolated", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  let response = await chatFetch(fixture, requestBody("cloud-full"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud");
  assert.equal(fixture.state.cloudRequests[0].authorization, "Bearer cloud-secret");
  assert.equal(fixture.state.localRequests.length, 0);

  response = await chatFetch(fixture, requestBody("local-full", { stream: true }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local-only");
  assert.match(await response.text(), /data: \[DONE\]/);
  assert.equal(fixture.state.localRequests.at(-1).authorization, "Bearer local-secret");
  assert.equal(fixture.state.cloudRequests.length, 1);
});

test("direct upstream status and retry metadata stay OpenAI-compatible", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.cloudStatus = 429;

  const response = await chatFetch(fixture, requestBody("cloud-full"));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  const body = await response.json();
  assert.equal(body.error.type, "rate_limit_error");
});

test("answer timeout bounds a hanging upstream", async (t) => {
  const fixture = await startFixture({ answerTimeoutMs: 50 });
  t.after(() => fixture.close());
  fixture.state.cloudDelayMs = 200;

  const response = await chatFetch(fixture, requestBody("cloud-full"));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.type, "upstream_error");
});

test("filter only forwards an original tool-schema subset", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const response = await chatFetch(fixture, requestBody("filter"));
  assert.equal(response.status, 200);
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudRequests.length, 2);
  const helperRequest = fixture.state.cloudRequests[0].body;
  assert.match(helperRequest.messages[0].content, /Return no explanation, no Markdown, and no extra keys/);
  assert.match(helperRequest.messages[1].content, /<complete_request_context_json>/);
  assert.match(helperRequest.messages[1].content, /<available_tools_json>/);
  assert.match(helperRequest.messages[1].content, /tool_count=2/);
  assert.equal(helperRequest.chat_template_kwargs, undefined);
  assert.equal(helperRequest.model, "decision-model");
  assert.equal(fixture.state.cloudRequests[0].authorization, "Bearer decision-secret");
  assert.equal(helperRequest.response_format.type, "json_schema");
  assert.deepEqual(
    helperRequest.response_format.json_schema.schema.properties.tools.items.enum,
    ["tool_a", "tool_b"],
  );
  const answerRequest = fixture.state.cloudRequests.at(-1).body;
  assert.deepEqual(answerRequest.tools.map((tool) => tool.function.name), ["tool_a"]);
});

test("filter helper failure explicitly marks the full-schema cloud fallback", async (t) => {
  const fixture = await startFixture({ captureLogs: true, captureCalls: true });
  t.after(() => fixture.close());
  fixture.state.cloudHelperContents = ["not-json", "still-not-json"];

  const response = await chatFetch(fixture, requestBody("filter"));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-clawmobile-route"),
    "filter-full-schema-fallback",
  );
  assert.equal(response.headers.get("x-clawmobile-fallback"), "true");
  assert.equal(fixture.state.cloudRequests.length, 3);
  assert.deepEqual(
    fixture.state.cloudRequests.at(-1).body.tools.map((tool) => tool.function.name),
    ["tool_a", "tool_b"],
  );

  const logs = await fixture.logs();
  const decision = logs.find((record) => record.event === "tool_filter_decision");
  assert.equal(decision.filter_succeeded, false);
  assert.equal(decision.fallback, true);
  assert.equal(decision.fallback_schema, "full_tool_schema");
  const routed = logs.find((record) => record.event === "request_routed");
  assert.equal(routed.route, "filter-full-schema-fallback");
  assert.equal(routed.fallback, true);
  assert.equal(routed.fallback_schema, "full_tool_schema");

  const captures = await fixture.captures();
  const answerCall = captures.find(
    (record) => record.event === "model_call" && record.call_role === "cloud_agent",
  );
  assert.equal(answerCall.route, "filter-full-schema-fallback");
  assert.equal(answerCall.fallback, true);
});

test("tool filtering never downgrades an explicitly required function", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.cloudHelper = { k: 1, tools: ["tool_a"], args_class: "SIMPLE_ARGS" };

  const response = await chatFetch(
    fixture,
    requestBody("filter", {
      tool_choice: { type: "function", function: { name: "tool_b" } },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    fixture.state.cloudRequests.at(-1).body.tools.map((tool) => tool.function.name),
    ["tool_a", "tool_b"],
  );
  assert.equal(fixture.state.cloudRequests.at(-1).body.tool_choice.function.name, "tool_b");
});

test("router uses a Decision SIMPLE_ARGS prediction and forwards full tools to Local", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  assert.equal(response.headers.get("x-clawmobile-argument-shape"), "simple_arguments");
  assert.equal(fixture.state.cloudRequests.length, 1, "only the decision helper should run");
  assert.equal(fixture.state.cloudRequests[0].body.model, "decision-model");
  assert.equal(fixture.state.cloudRequests[0].authorization, "Bearer decision-secret");
  assert.equal(fixture.state.cloudRequests[0].body.response_format.type, "json_schema");
  assert.equal(fixture.state.cloudRequests[0].body.chat_template_kwargs, undefined);
  assert.equal(fixture.state.localRequests.length, 1);
  assert.deepEqual(
    fixture.state.localRequests[0].body.tools.map((tool) => tool.function.name),
    ["tool_a", "tool_b"],
  );
});

test("router sends COMPLEX_ARGS to Cloud with the original full tool catalog", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.cloudHelper = { k: 1, tools: ["tool_a"], args_class: "COMPLEX_ARGS" };

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-complex");
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudRequests.length, 2);
  assert.deepEqual(
    fixture.state.cloudRequests.at(-1).body.tools.map((tool) => tool.function.name),
    ["tool_a", "tool_b"],
  );
});

test("router accepts a valid no-tool Local answer without semantic-shape equality", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.localAnswer = completion(
    { role: "assistant", content: "No tool is needed for this turn." },
    "local-model",
  );

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  assert.equal(response.headers.get("x-clawmobile-argument-shape"), "no_tool_call");
  assert.equal(
    response.headers.get("x-clawmobile-validation-level"),
    "parameter_schema_subset_v1",
  );
  assert.equal(
    response.headers.get("x-clawmobile-parameter-schema-applied"),
    "false",
  );
  assert.equal(fixture.state.cloudRequests.length, 1);
});

test("adaptive modes bypass the helper for zero tools and tool_choice none", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  let response = await chatFetch(
    fixture,
    requestBody("filter", { tools: undefined }),
  );
  assert.equal(response.headers.get("x-clawmobile-route"), "filter-bypass");
  response = await chatFetch(
    fixture,
    requestBody("router", { tool_choice: "none" }),
  );
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-bypass");
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudRequests.length, 2, "only the two final Cloud calls run");
});

test("router retries once after invalid JSON and accepts the second strict result", async (t) => {
  const fixture = await startFixture({ captureLogs: true });
  t.after(() => fixture.close());
  fixture.state.cloudHelperContents = [
    '```json\n{"k":1,"tools":["tool_a"],"args_class":"SIMPLE_ARGS"}\n```',
    '{"k":1,"tools":["tool_a"],"args_class":"SIMPLE_ARGS"}',
  ];

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  assert.equal(fixture.state.cloudRequests.length, 2);
  assert.equal(fixture.state.localRequests.length, 1);
  assert.deepEqual(fixture.state.cloudRequests[0].body, fixture.state.cloudRequests[1].body);
  assert.equal(fixture.state.cloudRequests[0].body.temperature, 0);
  assert.equal(fixture.state.cloudRequests[0].body.response_format.type, "json_schema");
  const decision = (await fixture.logs()).find((item) => item.event === "router_decision");
  assert.equal(decision.helper_attempts, DECISION_HELPER_MAX_ATTEMPTS);
  assert.deepEqual(decision.helper_failure_stages, ["invalid_json"]);
  assert.equal(decision.helper_prompt_tokens, 20);
  assert.equal(decision.helper_completion_tokens, 4);
  assert.equal(decision.helper_total_tokens, 24);
});

test("router also retries empty content and invalid contracts", async (t) => {
  for (const scenario of [
    { name: "no content", first: null, stage: "no_content" },
    {
      name: "invalid contract",
      first: '{"k":2,"tools":["tool_a"],"args_class":"SIMPLE_ARGS"}',
      stage: "invalid_contract",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await startFixture({ captureLogs: true });
      try {
        fixture.state.cloudHelperContents = [
          scenario.first,
          '{"k":1,"tools":["tool_a"],"args_class":"SIMPLE_ARGS"}',
        ];
        const response = await chatFetch(fixture, requestBody("router"));
        assert.equal(response.headers.get("x-clawmobile-route"), "local");
        assert.equal(fixture.state.cloudHelperAttempts, 2);
        const decision = (await fixture.logs()).find(
          (item) => item.event === "router_decision",
        );
        assert.equal(decision.helper_attempts, DECISION_HELPER_MAX_ATTEMPTS);
        assert.deepEqual(decision.helper_failure_stages, [scenario.stage]);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("router falls back to Cloud full only after two invalid helper results", async (t) => {
  const fixture = await startFixture({ captureLogs: true });
  t.after(() => fixture.close());
  fixture.state.cloudHelperContent =
    '```json\n{"k":1,"tools":["tool_a"],"args_class":"SIMPLE_ARGS"}\n```';

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-fallback");
  assert.equal(fixture.state.localRequests.length, 0);
  assert.equal(fixture.state.cloudRequests.length, 3);
  assert.deepEqual(
    fixture.state.cloudRequests.at(-1).body.tools.map((tool) => tool.function.name),
    ["tool_a", "tool_b"],
  );
  const failure = (await fixture.logs()).find((item) => item.event === "router_failed");
  assert.equal(failure.helper_attempts, DECISION_HELPER_MAX_ATTEMPTS);
  assert.deepEqual(failure.helper_failure_stages, ["invalid_json", "invalid_json"]);
  assert.equal(failure.helper_prompt_tokens, 20);
  assert.equal(failure.helper_completion_tokens, 4);
  assert.equal(failure.helper_total_tokens, 24);
  assert.doesNotMatch(JSON.stringify(failure), /perform the requested action|parameters/);
});

test("router helper retries share one timeout budget", async (t) => {
  const fixture = await startFixture({ captureLogs: true, strategyTimeoutMs: 80 });
  t.after(() => fixture.close());
  fixture.state.cloudHelperDelayMs = 200;

  const startedAt = performance.now();
  const response = await chatFetch(fixture, requestBody("router"));
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-router-fallback");
  assert.equal(fixture.state.cloudHelperAttempts, 2);
  assert.ok(elapsedMs >= 50, `expected two bounded attempts, got ${elapsedMs} ms`);
  assert.ok(elapsedMs < 180, `shared timeout budget was exceeded: ${elapsedMs} ms`);
  const failure = (await fixture.logs()).find((item) => item.event === "router_failed");
  assert.equal(failure.helper_attempts, DECISION_HELPER_MAX_ATTEMPTS);
  assert.deepEqual(failure.helper_failure_stages, ["timeout", "timeout"]);
  assert.ok(failure.helper_latency_ms >= 50);
  assert.ok(failure.helper_latency_ms < 180);
  assert.equal(failure.helper_prompt_tokens, undefined);
});

test("helper observability logs provider latency usage and no request context", async (t) => {
  const fixture = await startFixture({ captureLogs: true });
  t.after(() => fixture.close());

  await chatFetch(fixture, requestBody("filter"));
  await chatFetch(fixture, requestBody("router"));
  const records = await fixture.logs();
  for (const eventName of ["tool_filter_decision", "router_decision"]) {
    const record = records.find((item) => item.event === eventName);
    assert.ok(record);
    assert.equal(record.helper_provider_id, "decision");
    assert.equal(record.helper_model, "decision-model");
    assert.equal(Number.isSafeInteger(record.helper_latency_ms), true);
    assert.equal(record.helper_prompt_tokens, 10);
    assert.equal(record.helper_completion_tokens, 2);
    assert.equal(record.helper_total_tokens, 12);
    assert.equal(record.k, 1);
    assert.equal(record.predicted_tool_count, 1);
    assert.equal(record.predicted_args_class, "SIMPLE_ARGS");
    assert.equal(record.helper_attempts, 1);
    assert.deepEqual(record.helper_failure_stages, []);
  }
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /perform the requested action|parameters/);
});

test("captures every Decision, Cloud, Local, retry-ready, and synthesized response", async (t) => {
  const fixture = await startFixture({ captureCalls: true });
  t.after(() => fixture.close());

  let response = await chatFetch(fixture, requestBody("filter"));
  assert.equal(response.status, 200);
  await response.text();
  response = await chatFetch(fixture, requestBody("router", { stream: true }));
  assert.equal(response.status, 200);
  await response.text();

  const records = await fixture.captures();
  const modelCalls = records.filter((item) => item.event === "model_call");
  assert.deepEqual(
    modelCalls.map((item) => item.call_role),
    ["filter_helper", "cloud_agent", "router_helper", "local_agent"],
  );
  assert.deepEqual(
    modelCalls.map((item) => item.model),
    ["decision-model", "cloud-model", "decision-model", "local-model"],
  );
  assert.equal(records.filter((item) => item.event === "proxy_request").length, 2);
  assert.equal(
    records.some(
      (item) => item.event === "proxy_response" && item.call_role === "local_agent_downstream",
    ),
    true,
  );
  for (const call of modelCalls) {
    assert.equal(typeof call.raw_request_text, "string");
    assert.equal(typeof call.raw_response_text, "string");
    assert.equal(typeof call.raw_response_base64, "string");
    assert.equal(call.capture_complete, true);
    assert.equal(call.transport_error, undefined);
    assert.match(call.raw_request_sha256, /^[a-f0-9]{64}$/);
    assert.match(call.raw_response_sha256, /^[a-f0-9]{64}$/);
    assert.equal(Array.isArray(call.response_chunks), true);
  }
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /cloud-secret|decision-secret|local-secret/);
  assert.match(serialized, /perform the requested action/);
});

test("marks Filter, Router, and Agent calls with role-separated provider sessions", async (t) => {
  const fixture = await startFixture({ captureCalls: true });
  t.after(() => fixture.close());

  const sessionId = "run-4c785e13f97c4e61a35f21215553ac99";
  const turnId = "turn-0001";
  const response = await chatFetch(fixture, requestBody("filter"), {
    "x-clawmobile-session-id": sessionId,
    "x-request-id": turnId,
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(fixture.state.cloudRequests.length, 2);
  const [helper, agent] = fixture.state.cloudRequests;
  assert.equal(helper.headers["x-session-id"], `cm-${sessionId}-filter`);
  assert.equal(agent.headers["x-session-id"], `cm-${sessionId}-agent`);
  assert.match(helper.headers["x-request-id"], /^cm-filter-[0-9a-f-]{36}$/);
  assert.match(agent.headers["x-request-id"], /^cm-agent-[0-9a-f-]{36}$/);
  assert.notEqual(helper.headers["x-request-id"], agent.headers["x-request-id"]);
  assert.equal(helper.body.user, undefined);
  assert.equal(helper.body.metadata, undefined);
  assert.equal(agent.body.user, undefined);
  assert.equal(agent.body.metadata, undefined);

  const calls = (await fixture.captures()).filter((item) => item.event === "model_call");
  assert.deepEqual(calls.map((item) => item.service_role), ["filter", "agent"]);
  assert.deepEqual(calls.map((item) => item.session_id), [sessionId, sessionId]);
  assert.deepEqual(calls.map((item) => item.turn_id), [turnId, turnId]);
  for (const call of calls) {
    assert.equal(call.service_request_id, call.request_headers["x-request-id"]);
    assert.equal(call.upstream_session_id, call.request_headers["x-session-id"]);
    assert.equal(call.response_headers["x-request-id"], call.service_request_id);
  }
});

test("uses separate Router and Agent provider sessions with the same logical task session", async (t) => {
  const fixture = await startFixture({ captureCalls: true });
  t.after(() => fixture.close());
  fixture.state.cloudHelper = {
    k: 1,
    tools: ["tool_a"],
    args_class: "COMPLEX_ARGS",
  };

  const sessionId = "task-session-router-01";
  const response = await chatFetch(fixture, requestBody("router"), {
    "x-clawmobile-session-id": sessionId,
    "x-request-id": "turn-router-01",
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(fixture.state.cloudRequests.length, 2);
  assert.equal(
    fixture.state.cloudRequests[0].headers["x-session-id"],
    `cm-${sessionId}-router`,
  );
  assert.equal(
    fixture.state.cloudRequests[1].headers["x-session-id"],
    `cm-${sessionId}-agent`,
  );
  const calls = (await fixture.captures()).filter((item) => item.event === "model_call");
  assert.deepEqual(calls.map((item) => item.service_role), ["router", "agent"]);
});

test("derives a repetition-level session from the ClawBench run marker", async (t) => {
  const fixture = await startFixture({ captureCalls: true });
  t.after(() => fixture.close());
  const runId = "b3cbdde640754ed5b6b1895c5140fd58";
  const body = requestBody("filter", {
    messages: [{
      role: "user",
      content: `execute the task [run:${runId}]`,
    }],
  });

  const response = await chatFetch(fixture, body);
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(
    fixture.state.cloudRequests[0].headers["x-session-id"],
    `cm-${runId}-filter`,
  );
  assert.equal(
    fixture.state.cloudRequests[1].headers["x-session-id"],
    `cm-${runId}-agent`,
  );
  const calls = (await fixture.captures()).filter((item) => item.event === "model_call");
  assert.deepEqual(calls.map((item) => item.session_id), [runId, runId]);
});

test("captures every helper retry and non-2xx provider response", async (t) => {
  const fixture = await startFixture({ captureCalls: true });
  t.after(() => fixture.close());
  fixture.state.cloudHelperContents = [
    "not-json",
    '{"k":1,"tools":["tool_a"],"args_class":"COMPLEX_ARGS"}',
  ];

  let response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.status, 200);
  await response.text();
  fixture.state.cloudStatus = 429;
  response = await chatFetch(fixture, requestBody("cloud-full"));
  assert.equal(response.status, 429);
  await response.text();

  const calls = (await fixture.captures()).filter((item) => item.event === "model_call");
  const helperAttempts = calls.filter((item) => item.call_role === "router_helper");
  assert.deepEqual(
    helperAttempts.map((item) => item.attempt_index),
    Array.from({ length: DECISION_HELPER_MAX_ATTEMPTS }, (_, index) => index + 1),
  );
  assert.match(helperAttempts[0].raw_response_text, /not-json/);
  const serviceRequestIds = calls.map((item) => item.service_request_id);
  assert.equal(new Set(serviceRequestIds).size, serviceRequestIds.length);
  for (const call of calls) {
    assert.equal(call.service_request_id, call.request_headers["x-request-id"]);
    assert.equal(Number.isSafeInteger(call.attempt_index), true);
    assert.ok(call.attempt_index >= 1);
  }
  const attemptGroups = new Map();
  for (const call of calls) {
    const key = `${call.turn_id}:${call.call_role}`;
    const group = attemptGroups.get(key) || [];
    group.push(call.attempt_index);
    attemptGroups.set(key, group);
  }
  for (const indexes of attemptGroups.values()) {
    assert.deepEqual(
      indexes,
      Array.from({ length: indexes.length }, (_, index) => index + 1),
    );
  }
  const failedCloud = calls.find(
    (item) => item.call_role === "cloud_agent" && item.response_status === 429,
  );
  assert.ok(failedCloud);
  assert.match(failedCloud.raw_response_text, /rate_limit_error/);
});

test("router local SSE includes OpenAI tool-call indices", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const response = await chatFetch(fixture, requestBody("router", { stream: true }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  const firstData = text.split("\n").find((line) => line.startsWith("data: {")).slice(6);
  const chunk = JSON.parse(firstData);
  assert.equal(chunk.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.name, "tool_a");
  assert.match(text, /data: \[DONE\]/);
});

test("router records observed shape but does not override a SIMPLE_ARGS helper route", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "complex-call",
      type: "function",
      function: { name: "tool_a", arguments: JSON.stringify({ steps: [{ x: 1 }] }) },
    }],
  }, "local-model");

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  assert.equal(response.headers.get("x-clawmobile-argument-shape"), "complex_arguments");
  assert.equal(fixture.state.cloudRequests.length, 1);
});

test("router rejects a local tool hallucinated outside the forwarded catalog", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "unknown-call",
      type: "function",
      function: { name: "unknown_tool", arguments: "{}" },
    }],
  }, "local-model");
  fixture.state.cloudHelper = { k: 1, tools: ["tool_a"], args_class: "NO_ARGS" };

  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-fallback");
  assert.equal(fixture.state.cloudRequests.length, 2);
});

test("router validates the frozen parameter-schema subset and records its level", async (t) => {
  const fixture = await startFixture({ captureLogs: true });
  t.after(() => fixture.close());
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "schema-valid-call",
      type: "function",
      function: {
        name: "tool_a",
        arguments: JSON.stringify({
          action: "go",
          payload: 3,
          tags: ["one"],
          meta: { x_label: "ok" },
          enabled: true,
        }),
      },
    }],
  }, "local-model");
  const body = requestBody("router", {
    tools: [{
      type: "function",
      function: {
        name: "tool_a",
        parameters: {
          type: "object",
          required: ["action", "payload", "tags", "meta", "enabled"],
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["go"], minLength: 1, maxLength: 4 },
            payload: {
              anyOf: [
                { type: "integer", minimum: 1, maximum: 5, exclusiveMinimum: 0 },
                { type: "null" },
              ],
            },
            tags: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: { type: "string" },
            },
            meta: {
              type: "object",
              patternProperties: { "^x_": { type: "string" } },
              additionalProperties: false,
            },
            enabled: { const: true },
          },
        },
      },
    }],
  });
  fixture.state.cloudHelper = {
    k: 1,
    tools: ["tool_a"],
    args_class: "SIMPLE_ARGS",
  };

  const response = await chatFetch(fixture, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  assert.equal(
    response.headers.get("x-clawmobile-validation-level"),
    "parameter_schema_subset_v1",
  );
  const routed = (await fixture.logs()).find(
    (event) => event.event === "request_routed" && event.route === "local",
  );
  assert.equal(routed.validation_level, "parameter_schema_subset_v1");
});

test("router fails closed for parameter-schema violations and duplicate tool-call ids", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.cloudHelper = {
    k: 1,
    tools: ["tool_a"],
    args_class: "SIMPLE_ARGS",
  };
  const cases = [
    {
      name: "required",
      schema: {
        type: "object",
        required: ["x"],
        properties: { x: { type: "string" } },
      },
      arguments: {},
    },
    {
      name: "type",
      schema: {
        type: "object",
        properties: { x: { type: "string" } },
      },
      arguments: { x: 1 },
    },
    {
      name: "enum",
      schema: {
        type: "object",
        properties: { x: { type: "string", enum: ["a", "b"] } },
      },
      arguments: { x: "c" },
    },
    {
      name: "additionalProperties",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      arguments: { unexpected: true },
    },
    {
      name: "anyOf",
      schema: {
        type: "object",
        properties: {
          x: { anyOf: [{ type: "string" }, { type: "integer" }] },
        },
      },
      arguments: { x: false },
    },
    {
      name: "patternProperties",
      schema: {
        type: "object",
        patternProperties: { "^x_": { type: "string" } },
        additionalProperties: false,
      },
      arguments: { x_value: 3 },
    },
    {
      name: "unsupported keyword",
      schema: { type: "object", minProperties: 1 },
      arguments: { x: 1 },
    },
  ];

  for (const scenario of cases) {
    fixture.state.localAnswer = completion({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `invalid-${scenario.name}`,
        type: "function",
        function: {
          name: "tool_a",
          arguments: JSON.stringify(scenario.arguments),
        },
      }],
    }, "local-model");
    const body = requestBody("router", {
      tools: [{
        type: "function",
        function: { name: "tool_a", parameters: scenario.schema },
      }],
    });
    const response = await chatFetch(fixture, body);
    assert.equal(
      response.headers.get("x-clawmobile-route"),
      "cloud-fallback",
      scenario.name,
    );
  }

  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "duplicate-id",
        type: "function",
        function: { name: "tool_a", arguments: "{}" },
      },
      {
        id: "duplicate-id",
        type: "function",
        function: { name: "tool_a", arguments: "{}" },
      },
    ],
  }, "local-model");
  const duplicateResponse = await chatFetch(
    fixture,
    requestBody("router", {
      tools: [{
        type: "function",
        function: { name: "tool_a", parameters: { type: "object" } },
      }],
    }),
  );
  assert.equal(
    duplicateResponse.headers.get("x-clawmobile-route"),
    "cloud-fallback",
  );
});

test("router has no hidden tool-name policy beyond the helper args_class", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.localAnswer = completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "shell-call",
      type: "function",
      function: { name: "android_shell", arguments: JSON.stringify({ command: "id" }) },
    }],
  }, "local-model");
  const body = requestBody("router", {
    tools: [{
      type: "function",
      function: {
        name: "android_shell",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    }],
  });
  fixture.state.cloudHelper = {
    k: 1,
    tools: ["android_shell"],
    args_class: "SIMPLE_ARGS",
  };

  const response = await chatFetch(fixture, body);
  assert.equal(response.headers.get("x-clawmobile-route"), "local");
  assert.equal(fixture.state.cloudRequests.length, 1);
});

test("router rejects truncated or nonstandard local completion contracts", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.state.localAnswer = completion({ role: "assistant", content: "partial" }, "local-model");
  fixture.state.localAnswer.choices[0].finish_reason = "length";
  const response = await chatFetch(fixture, requestBody("router"));
  assert.equal(response.headers.get("x-clawmobile-route"), "cloud-fallback");
  assert.equal(fixture.state.cloudRequests.length, 2);
});
