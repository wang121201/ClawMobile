import test from "node:test";
import assert from "node:assert/strict";

import {
  binaryRouteResponseFormat,
  compileScopedLocalRequest,
  getNextToolPrediction,
  helperMaxTokens,
  nextToolResponseFormat,
  routeClassResponseFormat,
  validateBinaryRouterDecision,
  validateNextToolPrediction,
  validateRouteClassPrediction,
} from "../src/strategies.js";

const request = {
  messages: [{ role: "user", content: "test" }],
  tools: [
    { type: "function", function: { name: "tool_a", parameters: { type: "object" } } },
    { type: "function", function: { name: "tool_b", parameters: { type: "object" } } },
  ],
};

test("validates the exact next-tool helper contract", () => {
  const value = validateNextToolPrediction(
    { k: 2, tools: ["tool_b", "tool_a"], args_class: "COMPLEX_ARGS" },
    request,
  );
  assert.deepEqual(value, {
    k: 2,
    tools: ["tool_b", "tool_a"],
    args_class: "COMPLEX_ARGS",
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.tools), true);
});

test("rejects extra keys, invalid k, duplicate or unknown tools, and invalid enums", () => {
  const invalid = [
    { k: 1, tools: ["tool_a"], args_class: "SIMPLE_ARGS", reason: "extra" },
    { k: 2, tools: ["tool_a"], args_class: "SIMPLE_ARGS" },
    { k: 0, tools: [], args_class: "NO_ARGS" },
    { k: 2, tools: ["tool_a", "tool_a"], args_class: "SIMPLE_ARGS" },
    { k: 1, tools: ["unknown"], args_class: "SIMPLE_ARGS" },
    { k: 1, tools: ["tool_a"], args_class: "no_arguments" },
  ];
  for (const value of invalid) {
    assert.throws(() => validateNextToolPrediction(value, request));
  }
});

test("zero available tools returns null without calling an upstream helper", async () => {
  let called = false;
  const prediction = await getNextToolPrediction(
    { messages: [], tools: [] },
    { id: "unused", baseUrl: "http://127.0.0.1:1", model: "unused", headers: {} },
    async () => {
      called = true;
      throw new Error("must not be called");
    },
  );
  assert.equal(prediction, null);
  assert.equal(called, false);
});

test("helper token budget grows for a large tool catalog and remains bounded", () => {
  assert.equal(helperMaxTokens(1), 512);
  assert.equal(helperMaxTokens(73), 3632);
  assert.equal(helperMaxTokens(100), 4096);
  assert.equal(helperMaxTokens(10_000), 4096);
  assert.throws(() => helperMaxTokens(-1));
});

test("builds a strict provider JSON Schema from the exact tool catalog", () => {
  const format = nextToolResponseFormat(["tool_a", "tool_b"]);
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  const schema = format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["k", "tools", "args_class"]);
  assert.equal(schema.properties.k.minimum, 1);
  assert.equal(schema.properties.k.maximum, 2);
  assert.equal(schema.properties.tools.uniqueItems, true);
  assert.deepEqual(schema.properties.tools.items.enum, ["tool_a", "tool_b"]);
  assert.deepEqual(schema.properties.args_class.enum, [
    "NO_ARGS",
    "SIMPLE_ARGS",
    "COMPLEX_ARGS",
  ]);
  assert.throws(() => nextToolResponseFormat([]));
  assert.throws(() => nextToolResponseFormat(["tool_a", "tool_a"]));
});

test("binary Router has an exact two-label output contract", () => {
  const format = binaryRouteResponseFormat();
  assert.deepEqual(
    format.json_schema.schema.properties.route.enum,
    ["LOCAL_UI_CANDIDATE", "CLOUD_REQUIRED"],
  );
  assert.deepEqual(
    validateBinaryRouterDecision({ route: "LOCAL_UI_CANDIDATE" }),
    { route: "LOCAL_UI_CANDIDATE" },
  );
  assert.throws(() => validateBinaryRouterDecision({
    route: "LOCAL_UI_CANDIDATE",
    confidence: 1,
  }));
  assert.throws(() => validateBinaryRouterDecision({ route: "OBSERVE_UI_RAW" }));
});

test("finite RouteClass schemas and validators keep historical R1/R2 and expose RM classes", () => {
  assert.deepEqual(
    routeClassResponseFormat("router-r1").json_schema.schema.properties.route_class.enum,
    ["EVIDENCE_LOCAL", "CLOUD"],
  );
  assert.deepEqual(
    routeClassResponseFormat("router-r2").json_schema.schema.properties.route_class.enum,
    ["EVIDENCE_LOCAL", "GROUNDED_QUERY_LOCAL", "CLOUD"],
  );
  assert.deepEqual(
    routeClassResponseFormat("router-rm").json_schema.schema.properties.route_class.enum,
    [
      "OBSERVE_UI_RAW",
      "QUERY_UI_GROUNDED",
      "INTERACT_UI_GROUNDED",
      "RETRIEVE_WEB_BOUNDED",
      "PERSIST_OR_SYSTEM_MUTATION",
      "OPEN_EXEC_OR_COMPOSITE",
      "VERIFY_COMPLETE_RECOVER",
      "NO_TOOL_OR_AMBIGUOUS",
    ],
  );
  const fsmAdmissible = [
    "OBSERVE_UI_RAW",
    "RETRIEVE_WEB_BOUNDED",
    "PERSIST_OR_SYSTEM_MUTATION",
    "OPEN_EXEC_OR_COMPOSITE",
    "VERIFY_COMPLETE_RECOVER",
    "NO_TOOL_OR_AMBIGUOUS",
  ];
  assert.deepEqual(
    routeClassResponseFormat(
      "router-fsm-scoped",
      fsmAdmissible,
    ).json_schema.schema.properties.route_class.enum,
    fsmAdmissible,
  );
  assert.throws(() => routeClassResponseFormat(
    "router-fsm-scoped",
    ["OBSERVE_UI_RAW", "UNKNOWN"],
  ));
  assert.deepEqual(
    validateRouteClassPrediction(
      {
        route_class: "EVIDENCE_LOCAL",
        reason_code: "FINITE_EVIDENCE_ACQUISITION",
      },
      "router-r1",
    ),
    {
      route_class: "EVIDENCE_LOCAL",
      reason_code: "FINITE_EVIDENCE_ACQUISITION",
    },
  );
  assert.throws(() =>
    validateRouteClassPrediction(
      {
        route_class: "GROUNDED_QUERY_LOCAL",
        reason_code: "FRESH_DUMP_GROUNDED_QUERY",
      },
      "router-r1",
    ));
  assert.deepEqual(
    validateRouteClassPrediction(
      {
        route_class: "INTERACT_UI_GROUNDED",
        reason_code: "FRESH_QUERY_GROUNDED_INTERACTION",
      },
      "router-rm",
    ),
    {
      route_class: "INTERACT_UI_GROUNDED",
      reason_code: "FRESH_QUERY_GROUNDED_INTERACTION",
    },
  );
  assert.throws(() => validateRouteClassPrediction(
    {
      route_class: "INTERACT_UI_GROUNDED",
      reason_code: "FRESH_QUERY_GROUNDED_INTERACTION",
    },
    "router-fsm-scoped",
    fsmAdmissible,
  ));
});

test("SC-v1 replaces only the static system affordance and preserves dynamic history", () => {
  const dynamicMessages = [
    { role: "user", content: "Open the requested screen and inspect it." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-old",
        type: "function",
        function: { name: "android_shell", arguments: '{"command":"echo old"}' },
      }],
    },
    { role: "tool", tool_call_id: "call-old", content: '{"ok":false,"error":"old"}' },
  ];
  const input = {
    model: "qwen3.6-35b",
    messages: [
      { role: "system", content: "Global catalog: android_shell exec android_ui_query" },
      ...dynamicMessages,
    ],
    tools: [
      { type: "function", function: { name: "android_screenshot", parameters: { type: "object", additionalProperties: false } } },
      { type: "function", function: { name: "android_ui_dump", parameters: { type: "object", additionalProperties: false } } },
    ],
    tool_choice: "auto",
  };
  const before = structuredClone(input);
  const output = compileScopedLocalRequest(input, {
    routeClass: "OBSERVE_UI_RAW",
    routeState: { phase: "VERIFY_PENDING", state_version: 2, pending_reobserve: true },
    allowedTools: ["android_ui_dump", "android_screenshot"],
  });

  assert.deepEqual(input, before);
  assert.deepEqual(output.messages.slice(1), dynamicMessages);
  assert.deepEqual(output.tools, input.tools);
  assert.match(output.messages[0].content, /OBSERVE_UI_RAW/);
  assert.match(output.messages[0].content, /android_screenshot/);
  assert.doesNotMatch(output.messages[0].content, /android_shell|\bexec\b|android_ui_query/);
});

test("SC-v1 carries exact grounded dependencies and rejects missing state", () => {
  const queryRequest = {
    messages: [
      { role: "system", content: "old" },
      { role: "user", content: "Find the Save control." },
    ],
    tools: [{
      type: "function",
      function: { name: "android_ui_query", parameters: { type: "object" } },
    }],
  };
  const scoped = compileScopedLocalRequest(queryRequest, {
    routeClass: "QUERY_UI_GROUNDED",
    routeState: {
      phase: "GROUND",
      state_version: 4,
      pending_reobserve: false,
      latest_fresh_dump: { dump_id: "dump-exact", state_version: 4 },
    },
    allowedTools: ["android_ui_query"],
  });
  assert.match(scoped.messages[0].content, /dump-exact/);
  assert.throws(() => compileScopedLocalRequest(queryRequest, {
    routeClass: "QUERY_UI_GROUNDED",
    routeState: { phase: "GROUND", state_version: 4, pending_reobserve: false },
    allowedTools: ["android_ui_query"],
  }));
});

test("SC-v1 union context exposes only exact FSM-admissible Local Tools", () => {
  const request = {
    messages: [
      { role: "system", content: "old global Tool catalog" },
      { role: "user", content: "Locate Save" },
    ],
    tools: [
      { type: "function", function: { name: "android_ui_dump", parameters: { type: "object" } } },
      { type: "function", function: { name: "android_ui_query", parameters: { type: "object" } } },
    ],
  };
  const scoped = compileScopedLocalRequest(request, {
    routeClass: "OBSERVE_UI_RAW",
    routeState: {
      phase: "GROUND",
      state_version: 3,
      pending_reobserve: false,
      latest_fresh_dump: { dump_id: "dump-union", state_version: 3 },
    },
    allowedTools: ["android_ui_dump", "android_ui_query"],
    admissibleRouteClasses: ["OBSERVE_UI_RAW", "QUERY_UI_GROUNDED"],
    toolsByRouteClass: {
      OBSERVE_UI_RAW: ["android_ui_dump"],
      QUERY_UI_GROUNDED: ["android_ui_query"],
    },
  });
  assert.match(scoped.messages[0].content, /"predicted_route_class":"OBSERVE_UI_RAW"/);
  assert.match(scoped.messages[0].content, /"QUERY_UI_GROUNDED"/);
  assert.match(scoped.messages[0].content, /dump-union/);
  assert.doesNotMatch(scoped.messages[0].content, /android_shell|web_search/);
});
