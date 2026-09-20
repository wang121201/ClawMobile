import test from "node:test";
import assert from "node:assert/strict";

import {
  compileBinaryRouterInput,
  compileCoarseLocalRequest,
  compileExplicitLocalRequest,
  deriveExplicitBinaryToolDecision,
  runCoarseToFineWorkflow as runWorkflowWithDependencies,
  runExplicitBinaryToolWorkflow as runExplicitWorkflowWithDependencies,
  validateBinaryRouterDecision,
} from "../src/coarse-to-fine.js";
import { validateLocalCompletion } from "../src/proxy.js";
import { deriveRouteState } from "../src/route-state.js";

function runCoarseToFineWorkflow(options) {
  return runWorkflowWithDependencies({
    ...options,
    localValidator: validateLocalCompletion,
  });
}

function runExplicitBinaryToolWorkflow(options) {
  return runExplicitWorkflowWithDependencies({
    ...options,
    localValidator: validateLocalCompletion,
  });
}

function finiteTool(name, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

function call(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function result(id, value) {
  return { role: "tool", tool_call_id: id, content: JSON.stringify(value) };
}

function toolCompletion(name, args) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [call("candidate", name, args)],
      },
      finish_reason: "tool_calls",
    }],
  };
}

function cloudCompletion(text = "cloud") {
  return {
    choices: [{
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
  };
}

function tools() {
  return [
    finiteTool("android_screenshot"),
    finiteTool("android_ui_dump", {
      compressed: { type: "boolean" },
      rawXml: { type: "boolean" },
    }),
    finiteTool("android_ui_query", {
      dumpId: { type: "string" },
      text: { type: "string" },
      name: { type: "string" },
    }, ["dumpId"]),
    finiteTool("android_tap", {
      x: { type: "integer" },
      y: { type: "integer" },
    }, ["x", "y"]),
    finiteTool("android_shell", { command: { type: "string" } }, ["command"]),
  ];
}

function request(messages = null) {
  return {
    model: "experiment",
    messages: messages || [
      { role: "system", content: "Global catalog includes shell and every UI Tool." },
      { role: "user", content: "Open Contacts and inspect the current screen." },
    ],
    tools: tools(),
    tool_choice: "auto",
  };
}

test("binary Router decision is an exact two-label contract", () => {
  assert.deepEqual(
    validateBinaryRouterDecision({ route: "LOCAL_UI_CANDIDATE" }),
    { route: "LOCAL_UI_CANDIDATE" },
  );
  assert.throws(
    () => validateBinaryRouterDecision({ route: "LOCAL_UI_CANDIDATE", confidence: 1 }),
    /only route/u,
  );
  assert.throws(
    () => validateBinaryRouterDecision({ route: "OBSERVE_UI_RAW" }),
    /invalid/u,
  );
});

test("binary Router input excludes static Tool schemas but preserves all dynamic history", () => {
  const source = request();
  const input = compileBinaryRouterInput(source);
  const serialized = input.messages[1].content;
  assert.doesNotMatch(serialized, /additionalProperties|Global catalog/u);
  assert.match(serialized, /Open Contacts and inspect the current screen/u);
  assert.deepEqual(input.decision_context.local_tool_union, [
    "android_screenshot",
    "android_ui_dump",
  ]);
  assert.deepEqual(input.decision_context.pre_agent_dynamic_messages, [source.messages[1]]);
});

test("CLOUD_REQUIRED bypasses Local and sends the untouched request to Cloud", async () => {
  const source = request();
  let localCalls = 0;
  let cloudRequest = null;
  const output = await runCoarseToFineWorkflow({
    request: source,
    binaryRouter: async () => ({ route: "CLOUD_REQUIRED" }),
    localAgent: async () => {
      localCalls += 1;
      return toolCompletion("android_ui_dump", {});
    },
    cloudAgent: async (value) => {
      cloudRequest = value;
      return cloudCompletion();
    },
  });
  assert.equal(localCalls, 0);
  assert.equal(cloudRequest, source);
  assert.equal(output.audit.final_backend, "cloud");
  assert.equal(output.audit.final_reason, "binary_router_selected_cloud");
});

test("Local predicts an exact observe Tool and RouteClass is derived after generation", async () => {
  const source = request();
  let localRequest = null;
  let cloudCalls = 0;
  const output = await runCoarseToFineWorkflow({
    request: source,
    binaryRouter: async () => ({ route: "LOCAL_UI_CANDIDATE" }),
    localAgent: async (value) => {
      localRequest = value;
      return toolCompletion("android_ui_dump", {});
    },
    cloudAgent: async () => {
      cloudCalls += 1;
      return cloudCompletion();
    },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(output.audit.final_backend, "local");
  assert.equal(output.audit.local_evaluation.actual_route_class, "OBSERVE_UI_RAW");
  assert.deepEqual(
    localRequest.tools.map((tool) => tool.function.name),
    ["android_screenshot", "android_ui_dump"],
  );
  assert.equal(localRequest.tool_choice, "required");
  assert.equal(localRequest.parallel_tool_calls, false);
});

test("deterministic compiler binds a query to the latest fresh dump and revalidates", async () => {
  const messages = [
    { role: "system", content: "Global catalog" },
    { role: "user", content: "Find the Save button." },
    { role: "assistant", content: null, tool_calls: [call("dump-1", "android_ui_dump", {})] },
    result("dump-1", { ok: true, dump_id: "uidump_fresh" }),
  ];
  const source = request(messages);
  const output = await runCoarseToFineWorkflow({
    request: source,
    binaryRouter: async () => ({ route: "LOCAL_UI_CANDIDATE" }),
    localAgent: async () => toolCompletion("android_ui_query", {
      dumpId: "uidump_stale",
      text: "Save",
    }),
    cloudAgent: async () => cloudCompletion(),
  });
  assert.equal(output.audit.final_backend, "local");
  assert.equal(output.audit.local_evaluation.actual_route_class, "QUERY_UI_GROUNDED");
  assert.equal(output.audit.local_evaluation.repair.applied, true);
  const repairedArguments = JSON.parse(
    output.completion.choices[0].message.tool_calls[0].function.arguments,
  );
  assert.deepEqual(repairedArguments, { dumpId: "uidump_fresh", text: "Save" });
});

test("a Tool outside the FSM UI union is rejected and falls back to full Cloud", async () => {
  const source = request();
  let cloudRequest = null;
  const output = await runCoarseToFineWorkflow({
    request: source,
    binaryRouter: async () => ({ route: "LOCAL_UI_CANDIDATE" }),
    localAgent: async () => toolCompletion("android_shell", { command: "id" }),
    cloudAgent: async (value) => {
      cloudRequest = value;
      return cloudCompletion("fallback");
    },
  });
  assert.equal(output.audit.final_backend, "cloud");
  assert.match(output.audit.final_reason, /local_candidate_rejected/u);
  assert.equal(output.audit.local_evaluation.reason, "tool_contract_violation");
  assert.equal(cloudRequest, source);
  assert.equal(cloudRequest.tools.some(
    (tool) => tool.function.name === "android_shell"), true);
});

test("FSM makes query unavailable before a dump and prevents Local from expanding capability", async () => {
  const source = request();
  const compiled = compileCoarseLocalRequest(source, deriveRouteState(source));
  assert.deepEqual(compiled.capability.admissibleRouteClasses, ["OBSERVE_UI_RAW"]);
  assert.equal(compiled.request.tools.some(
    (tool) => tool.function.name === "android_ui_query"), false);
  const output = await runCoarseToFineWorkflow({
    request: source,
    binaryRouter: async () => ({ route: "LOCAL_UI_CANDIDATE" }),
    localAgent: async () => toolCompletion("android_ui_query", {
      dumpId: "guessed",
      text: "Save",
    }),
    cloudAgent: async () => cloudCompletion(),
  });
  assert.equal(output.audit.final_backend, "cloud");
  assert.equal(
    output.audit.local_evaluation.reason,
    "tool_contract_violation",
  );
});

test("invalid binary output fails closed without invoking Local", async () => {
  let localCalls = 0;
  const output = await runCoarseToFineWorkflow({
    request: request(),
    binaryRouter: async () => ({ route: "LOCAL_UI_CANDIDATE", explanation: "extra" }),
    localAgent: async () => {
      localCalls += 1;
      return toolCompletion("android_ui_dump", {});
    },
    cloudAgent: async () => cloudCompletion(),
  });
  assert.equal(localCalls, 0);
  assert.equal(output.audit.final_backend, "cloud");
  assert.equal(output.audit.final_reason, "binary_router_invalid_or_failed");
});

test("Local scoped request changes only the system message and Tool visibility", () => {
  const source = request([
    { role: "system", content: "all static tools" },
    { role: "user", content: "Inspect this screen" },
    { role: "assistant", content: "I will inspect it." },
  ]);
  const compiled = compileCoarseLocalRequest(source).request;
  assert.notEqual(compiled.messages[0].content, source.messages[0].content);
  assert.deepEqual(compiled.messages.slice(1), source.messages.slice(1));
  assert.deepEqual(
    compiled.tools.map((tool) => tool.function.name),
    ["android_screenshot", "android_ui_dump"],
  );
});

test("explicit policy sends PRECHECK and screenshots to Cloud without a model Router", async () => {
  const source = request();
  const decision = deriveExplicitBinaryToolDecision(source);
  assert.equal(decision.route, "CLOUD_REQUIRED");
  assert.equal(decision.reason, "no_explicit_local_capability_match");
  let localCalls = 0;
  const output = await runExplicitBinaryToolWorkflow({
    request: source,
    localAgent: async () => {
      localCalls += 1;
      return toolCompletion("android_screenshot", {});
    },
    cloudAgent: async () => cloudCompletion(),
  });
  assert.equal(localCalls, 0);
  assert.equal(output.audit.router_invoked, false);
  assert.equal(output.audit.final_backend, "cloud");
});

test("pending reobserve selects only canonical android_ui_dump", () => {
  const source = request([
    { role: "system", content: "Global catalog" },
    { role: "user", content: "Continue after the mutation." },
    { role: "assistant", content: null, tool_calls: [call("tap-1", "android_tap", { x: 1, y: 2 })] },
    result("tap-1", { ok: true }),
  ]);
  const decision = deriveExplicitBinaryToolDecision(source);
  assert.equal(decision.route, "LOCAL_EXACT_TOOL");
  assert.equal(decision.route_class, "OBSERVE_UI_RAW");
  assert.equal(decision.exact_tool_name, "android_ui_dump");
  const compiled = compileExplicitLocalRequest(source, decision).request;
  assert.deepEqual(compiled.tools.map((tool) => tool.function.name), ["android_ui_dump"]);
  assert.deepEqual(compiled.tool_choice, {
    type: "function",
    function: { name: "android_ui_dump" },
  });
});

test("resolved post-mutation reobserve hands interpretation back to Cloud", () => {
  const source = request([
    { role: "system", content: "Global catalog" },
    { role: "user", content: "Continue after the mutation." },
    { role: "assistant", content: null, tool_calls: [call("dump-2", "android_ui_dump", {})] },
    result("dump-2", { ok: true, dump_id: "uidump_after_mutation" }),
  ]);
  const decision = deriveExplicitBinaryToolDecision(
    source,
    deriveRouteState(source),
    { forceCloudReason: "post_mutation_reobserve_requires_cloud_interpretation" },
  );
  assert.equal(decision.route, "CLOUD_REQUIRED");
  assert.equal(
    decision.reason,
    "post_mutation_reobserve_requires_cloud_interpretation",
  );
  assert.equal(decision.exact_tool_name, null);
});

test("GROUND with a fresh dump selects query and requires one selector", async () => {
  const source = request([
    { role: "system", content: "Global catalog" },
    { role: "user", content: "Find Save." },
    { role: "assistant", content: null, tool_calls: [call("dump-1", "android_ui_dump", {})] },
    result("dump-1", { ok: true, dump_id: "uidump_fresh" }),
  ]);
  const decision = deriveExplicitBinaryToolDecision(source);
  assert.equal(decision.exact_tool_name, "android_ui_query");
  const output = await runExplicitBinaryToolWorkflow({
    request: source,
    localAgent: async (localRequest) => {
      assert.deepEqual(localRequest.tools.map((tool) => tool.function.name), ["android_ui_query"]);
      return toolCompletion("android_ui_query", {
        dumpId: "uidump_fresh",
        text: "Save",
      });
    },
    cloudAgent: async () => cloudCompletion(),
  });
  assert.equal(output.audit.final_backend, "local");
  assert.equal(output.audit.local_evaluation.actual_route_class, "QUERY_UI_GROUNDED");
});

test("ambiguous query candidate is rejected before execution and falls back to Cloud", async () => {
  const source = request([
    { role: "system", content: "Global catalog" },
    { role: "user", content: "Find the target." },
    { role: "assistant", content: null, tool_calls: [call("dump-1", "android_ui_dump", {})] },
    result("dump-1", { ok: true, dump_id: "uidump_fresh" }),
  ]);
  const output = await runExplicitBinaryToolWorkflow({
    request: source,
    localAgent: async () => toolCompletion("android_ui_query", {
      dumpId: "uidump_fresh",
      text: "Save",
      name: "Save",
    }),
    cloudAgent: async () => cloudCompletion("ambiguity-fallback"),
  });
  assert.equal(output.audit.final_backend, "cloud");
  assert.equal(
    output.audit.local_evaluation.reason,
    "query_ui_grounded_requires_exactly_one_selector",
  );
});

test("READY with a fresh clickable enabled center selects only android_tap", async () => {
  const source = request([
    { role: "system", content: "Global catalog" },
    { role: "user", content: "Tap Save." },
    { role: "assistant", content: null, tool_calls: [call("dump-1", "android_ui_dump", {})] },
    result("dump-1", { ok: true, dump_id: "uidump_fresh" }),
    { role: "assistant", content: null, tool_calls: [call("query-1", "android_ui_query", {
      dumpId: "uidump_fresh",
      text: "Save",
    })] },
    result("query-1", {
      ok: true,
      dump_id: "uidump_fresh",
      best: { selected: { centerX: 420, centerY: 900, clickable: true, enabled: true } },
    }),
  ]);
  const decision = deriveExplicitBinaryToolDecision(source);
  assert.equal(decision.exact_tool_name, "android_tap");
  const output = await runExplicitBinaryToolWorkflow({
    request: source,
    localAgent: async (localRequest) => {
      assert.deepEqual(localRequest.tools.map((tool) => tool.function.name), ["android_tap"]);
      return toolCompletion("android_tap", { x: 420, y: 900 });
    },
    cloudAgent: async () => cloudCompletion(),
  });
  assert.equal(output.audit.final_backend, "local");
  assert.equal(output.audit.local_evaluation.actual_route_class, "INTERACT_UI_GROUNDED");
});
