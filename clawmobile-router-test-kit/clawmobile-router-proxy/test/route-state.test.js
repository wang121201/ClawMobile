import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedToolsForRouteClass,
  compileStandardModerateRepair,
  createFsmTransitionExpectation,
  deriveRouteState,
  fsmAdmissibleRouteClasses,
  routeClassForLocalTool,
  UI_EFFECT_AWARE_POLICY_VERSION,
  validateFiniteRouteCompletion,
  validateFsmTransitionExpectation,
} from "../src/route-state.js";

test("finite Local Tool names resolve to one exact RouteClass", () => {
  assert.equal(routeClassForLocalTool("android_ui_dump"), "OBSERVE_UI_RAW");
  assert.equal(routeClassForLocalTool("android_ui_query"), "QUERY_UI_GROUNDED");
  assert.equal(routeClassForLocalTool("adb_tap"), "INTERACT_UI_GROUNDED");
  assert.equal(routeClassForLocalTool("android_shell"), null);
});

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

function completion(name, args) {
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

test("route state reconstructs a fresh same-cell dump dependency", () => {
  const state = deriveRouteState({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
    ],
  });
  assert.equal(state.phase, "GROUND");
  assert.equal(state.pending_reobserve, false);
  assert.equal(state.latest_fresh_dump.dump_id, "uidump_1");
  assert.deepEqual(
    allowedToolsForRouteClass("GROUNDED_QUERY_LOCAL", state),
    ["android_ui_query"],
  );
});

test("unknown or mutating tool result invalidates the prior UI artifact", () => {
  const state = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [call("tap-1", "android_tap", { x: 5, y: 7 })] },
      result("tap-1", { ok: true }),
    ],
  });
  assert.equal(state.phase, "VERIFY_PENDING");
  assert.equal(state.pending_reobserve, true);
  assert.equal(state.latest_fresh_dump, null);
  assert.deepEqual(
    allowedToolsForRouteClass("GROUNDED_QUERY_LOCAL", state),
    [],
  );
});

test("effect-aware policy preserves a fresh dump across high-confidence non-UI reads", () => {
  for (const [toolName, args] of [
    ["web_fetch", { url: "https://example.test" }],
    ["android_shell", { command: "cat /sdcard/Download/result.txt" }],
  ]) {
    const state = deriveRouteState({
      messages: [
        { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
        result("dump-1", { ok: true, dump_id: "uidump_1" }),
        { role: "assistant", tool_calls: [call("read-1", toolName, args)] },
        result("read-1", { ok: true }),
      ],
    }, { uiEffectPolicy: UI_EFFECT_AWARE_POLICY_VERSION });
    assert.equal(state.phase, "GROUND");
    assert.equal(state.pending_reobserve, false);
    assert.equal(state.latest_fresh_dump.dump_id, "uidump_1");
    assert.equal(state.last_transition.ui_effect, "UI_NEUTRAL_READ");
  }
});

test("effect-aware policy does not force UI observation after a file step", () => {
  const state = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("write-1", "write", { path: "/sdcard/Download/x.txt", content: "x" })] },
      result("write-1", { ok: true }),
    ],
  }, { uiEffectPolicy: UI_EFFECT_AWARE_POLICY_VERSION });
  assert.equal(state.phase, "OBSERVE");
  assert.equal(state.pending_reobserve, false);
  assert.equal(state.last_transition.ui_effect, "NON_UI_STEP");
});

test("effect-aware policy distinguishes UI shell from unknown shell and fails closed for both", () => {
  for (const [command, expectedEffect] of [
    ["input tap 10 20", "UI_MUTATION"],
    ["vendor_specific_command --opaque", "UNKNOWN_EFFECT"],
  ]) {
    const state = deriveRouteState({
      messages: [
        { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
        result("dump-1", { ok: true, dump_id: "uidump_1" }),
        { role: "assistant", tool_calls: [call("shell-1", "android_shell", { command })] },
        result("shell-1", { ok: true }),
      ],
    }, { uiEffectPolicy: UI_EFFECT_AWARE_POLICY_VERSION });
    assert.equal(state.phase, "VERIFY_PENDING");
    assert.equal(state.pending_reobserve, true);
    assert.equal(state.latest_fresh_dump, null);
    assert.equal(state.last_transition.ui_effect, expectedEffect);
  }
});

test("failed dump clears stale UI dependencies and never establishes GROUND", () => {
  const state = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [call("query-1", "android_ui_query", {
        dumpId: "uidump_1",
        text: "Save",
      })] },
      result("query-1", {
        ok: true,
        dump_id: "uidump_1",
        best: { selected: { centerX: 1, centerY: 2, clickable: true, enabled: true } },
      }),
      { role: "assistant", tool_calls: [call("dump-2", "android_ui_dump", {})] },
      result("dump-2", { ok: false, error: "uiautomator_failed" }),
    ],
  });
  assert.equal(state.phase, "OBSERVE");
  assert.equal(state.latest_fresh_dump, null);
  assert.equal(state.latest_fresh_query, null);
});

test("failed query clears the old target and falls back to the fresh dump", () => {
  const state = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [call("query-1", "android_ui_query", {
        dumpId: "uidump_1",
        text: "Save",
      })] },
      result("query-1", {
        ok: true,
        dump_id: "uidump_1",
        best: { selected: { centerX: 1, centerY: 2, clickable: true, enabled: true } },
      }),
      { role: "assistant", tool_calls: [call("query-2", "android_ui_query", {
        dumpId: "uidump_1",
        text: "Missing",
      })] },
      result("query-2", { ok: false, dump_id: "uidump_1", error: "not_found" }),
    ],
  });
  assert.equal(state.phase, "GROUND");
  assert.equal(state.latest_fresh_dump.dump_id, "uidump_1");
  assert.equal(state.latest_fresh_query, null);
  assert.deepEqual(
    allowedToolsForRouteClass("INTERACT_UI_GROUNDED", state),
    [],
  );
});

test("FSM admissibility is state-derived and fail-closed for a forced handoff", () => {
  const precheck = deriveRouteState({ messages: [] });
  assert.deepEqual(fsmAdmissibleRouteClasses(precheck), [
    "OBSERVE_UI_RAW",
    "RETRIEVE_WEB_BOUNDED",
    "PERSIST_OR_SYSTEM_MUTATION",
    "OPEN_EXEC_OR_COMPOSITE",
    "VERIFY_COMPLETE_RECOVER",
    "NO_TOOL_OR_AMBIGUOUS",
  ]);

  const ground = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
    ],
  });
  assert.equal(fsmAdmissibleRouteClasses(ground).includes("QUERY_UI_GROUNDED"), true);
  assert.equal(fsmAdmissibleRouteClasses(ground).includes("INTERACT_UI_GROUNDED"), false);

  const ready = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [call("query-1", "android_ui_query", {
        dumpId: "uidump_1",
        text: "Save",
      })] },
      result("query-1", {
        ok: true,
        dump_id: "uidump_1",
        best: { selected: { centerX: 1, centerY: 2, clickable: true, enabled: true } },
      }),
    ],
  });
  assert.equal(fsmAdmissibleRouteClasses(ready).includes("QUERY_UI_GROUNDED"), false);
  assert.equal(fsmAdmissibleRouteClasses(ready).includes("INTERACT_UI_GROUNDED"), true);
  assert.deepEqual(fsmAdmissibleRouteClasses(ready, { forceCloud: true }), [
    "RETRIEVE_WEB_BOUNDED",
    "PERSIST_OR_SYSTEM_MUTATION",
    "OPEN_EXEC_OR_COMPOSITE",
    "VERIFY_COMPLETE_RECOVER",
    "NO_TOOL_OR_AMBIGUOUS",
  ]);
});

test("FSM transition expectation binds the exact Local Tool Result", () => {
  const source = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
    ],
  });
  const queryCall = call("query-1", "android_ui_query", {
    dumpId: "uidump_1",
    text: "Save",
  });
  const expectation = createFsmTransitionExpectation(
    "QUERY_UI_GROUNDED",
    queryCall,
    source,
  );
  const success = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [queryCall] },
      result("query-1", {
        ok: true,
        dump_id: "uidump_1",
        best: { selected: { centerX: 1, centerY: 2, clickable: true, enabled: true } },
      }),
    ],
  });
  assert.deepEqual(validateFsmTransitionExpectation(expectation, success), {
    ok: true,
    reason: "fsm_transition_matched",
  });

  const failed = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [queryCall] },
      result("query-1", { ok: false, dump_id: "uidump_1", error: "not_found" }),
    ],
  });
  assert.equal(validateFsmTransitionExpectation(expectation, failed).ok, false);
  assert.equal(
    validateFsmTransitionExpectation(expectation, failed).reason,
    "fsm_transition_typed_success_required",
  );
});

test("R1 requires one approved empty-argument evidence call", () => {
  assert.deepEqual(
    validateFiniteRouteCompletion(
      completion("android_screenshot", {}),
      "EVIDENCE_LOCAL",
      deriveRouteState({ messages: [] }),
    ),
    { ok: true, reason: "evidence_contract_valid" },
  );
  assert.equal(
    validateFiniteRouteCompletion(
      completion("android_ui_dump", { rawXml: true }),
      "EVIDENCE_LOCAL",
      deriveRouteState({ messages: [] }),
    ).ok,
    false,
  );
});

test("R2 accepts only a finite query bound to the latest fresh dump", () => {
  const state = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
    ],
  });
  assert.equal(
    validateFiniteRouteCompletion(
      completion("android_ui_query", { dumpId: "uidump_1", text: "Search" }),
      "GROUNDED_QUERY_LOCAL",
      state,
    ).ok,
    true,
  );
  for (const invalid of [
    completion("android_ui_query", { dumpId: "uidump_old", text: "Search" }),
    completion("android_ui_query", { dumpId: "uidump_1" }),
    completion("android_tap", { x: 1, y: 2 }),
  ]) {
    assert.equal(
      validateFiniteRouteCompletion(invalid, "GROUNDED_QUERY_LOCAL", state).ok,
      false,
    );
  }
});

test("RM accepts a grounded query and only the selected query center for tap", () => {
  const state = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      {
        role: "assistant",
        tool_calls: [call("query-1", "android_ui_query", {
          dumpId: "uidump_1",
          text: "Save",
        })],
      },
      result("query-1", {
        ok: true,
        dump_id: "uidump_1",
        best: {
          selected: {
            centerX: 420,
            centerY: 900,
            clickable: true,
            enabled: true,
          },
        },
      }),
    ],
  });
  assert.equal(state.phase, "READY");
  assert.deepEqual(state.latest_fresh_query.selected_center, { x: 420, y: 900 });
  assert.deepEqual(
    allowedToolsForRouteClass("INTERACT_UI_GROUNDED", state),
    ["android_tap", "adb_tap"],
  );
  assert.equal(
    validateFiniteRouteCompletion(
      completion("android_tap", { x: 420, y: 900 }),
      "INTERACT_UI_GROUNDED",
      state,
    ).ok,
    true,
  );
  assert.equal(
    validateFiniteRouteCompletion(
      completion("adb_tap", { x: 421, y: 900 }),
      "INTERACT_UI_GROUNDED",
      state,
    ).ok,
    false,
  );
});

test("RM query, observation, and bounded web contracts reject shell and compound parameters", () => {
  const dumpState = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
    ],
  });
  assert.equal(
    validateFiniteRouteCompletion(
      completion("android_ui_query", { dumpId: "uidump_1", text: "Search" }),
      "QUERY_UI_GROUNDED",
      dumpState,
    ).ok,
    true,
  );
  assert.equal(
    validateFiniteRouteCompletion(
      completion("android_ui_query", {
        dumpId: "uidump_1",
        text: "Search",
        resourceId: "search_box",
      }),
      "QUERY_UI_GROUNDED",
      dumpState,
    ).ok,
    false,
  );
  assert.equal(
    validateFiniteRouteCompletion(
      completion("web_search", { query: "benefits of drinking water", count: 5 }),
      "RETRIEVE_WEB_BOUNDED",
      deriveRouteState({ messages: [] }),
    ).ok,
    true,
  );
  for (const invalid of [
    completion("android_shell", { command: "getprop" }),
    completion("adb_shell", { command: "input tap 1 2" }),
  ]) {
    assert.equal(
      validateFiniteRouteCompletion(
        invalid,
        "OBSERVE_UI_RAW",
        deriveRouteState({ messages: [] }),
      ).ok,
      false,
    );
  }
});

test("Standard Moderate Repair canonicalizes bounded observe arguments", () => {
  for (const [toolName, args] of [
    ["android_ui_dump", { compressed: false }],
    ["android_ui_dump", { compressed: true, rawXml: false }],
    ["android_ui_dump", { compressed: "false", rawXml: "true" }],
    ["adb_ui_dump_xml", { compressed: true }],
  ]) {
    const proposal = compileStandardModerateRepair(
      completion(toolName, args),
      "OBSERVE_UI_RAW",
      deriveRouteState({ messages: [] }),
    );
    assert.equal(proposal.ok, true);
    assert.equal(proposal.reason, "standard_moderate_repair_compiled");
    assert.equal(proposal.transformations.length >= 1, true);
    assert.equal(
      proposal.completion.choices[0].message.tool_calls[0].function.arguments,
      "{}",
    );
    assert.deepEqual(
      validateFiniteRouteCompletion(
        proposal.completion,
        "OBSERVE_UI_RAW",
        deriveRouteState({ messages: [] }),
      ),
      { ok: true, reason: "observe_ui_raw_contract_valid" },
    );
  }
});

test("Standard Moderate Repair binds a unique fresh dump without changing the selector", () => {
  const ground = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
    ],
  });
  for (const args of [
    { text: "Search", clickable: "true" },
    { queries: [{ dump_id: "uidump_1", name: "search_view", max_matches: "1" }] },
  ]) {
    const proposal = compileStandardModerateRepair(
      completion("android_ui_query", args),
      "QUERY_UI_GROUNDED",
      ground,
    );
    assert.equal(proposal.ok, true);
    const repaired = JSON.parse(proposal.repaired_arguments);
    assert.equal(repaired.dumpId, "uidump_1");
    assert.equal(
      ["text", "name"].filter((key) => Object.hasOwn(repaired, key)).length,
      1,
    );
    assert.deepEqual(
      validateFiniteRouteCompletion(proposal.completion, "QUERY_UI_GROUNDED", ground),
      { ok: true, reason: "query_ui_grounded_contract_valid" },
    );
  }
});

test("Standard Moderate Repair compiles tap coordinates from one fresh selected center", () => {
  const ready = deriveRouteState({
    messages: [
      { role: "assistant", tool_calls: [call("dump-1", "android_ui_dump", {})] },
      result("dump-1", { ok: true, dump_id: "uidump_1" }),
      { role: "assistant", tool_calls: [call("query-1", "android_ui_query", {
        dumpId: "uidump_1",
        text: "Save",
      })] },
      result("query-1", {
        ok: true,
        dump_id: "uidump_1",
        best: { selected: { centerX: 101, centerY: 202, clickable: true, enabled: true } },
      }),
    ],
  });
  const proposal = compileStandardModerateRepair(
    completion("android_tap", { x: "5", y: 7 }),
    "INTERACT_UI_GROUNDED",
    ready,
  );
  assert.equal(proposal.ok, true);
  assert.deepEqual(JSON.parse(proposal.repaired_arguments), { x: 101, y: 202 });
  assert.deepEqual(
    validateFiniteRouteCompletion(proposal.completion, "INTERACT_UI_GROUNDED", ready),
    { ok: true, reason: "interact_ui_grounded_contract_valid" },
  );
});

test("Standard Moderate Repair rejects semantic, ambiguous, stale, and multi-call changes", () => {
  const precheck = deriveRouteState({ messages: [] });
  for (const [candidate, routeClass, state] of [
    [completion("android_screenshot", { compressed: true }), "OBSERVE_UI_RAW"],
    [completion("android_ui_dump", { unexpected: true }), "OBSERVE_UI_RAW"],
    [completion("android_ui_dump", { compressed: false }), "QUERY_UI_GROUNDED"],
    [completion("android_ui_query", { text: "One", name: "Two" }), "QUERY_UI_GROUNDED"],
    [completion("android_ui_query", { queries: [{ text: "One" }, { text: "Two" }] }), "QUERY_UI_GROUNDED"],
    [completion("android_ui_query", { text: "Search" }), "QUERY_UI_GROUNDED", precheck],
    [completion("android_tap", { x: 1, y: 2 }), "INTERACT_UI_GROUNDED", precheck],
  ]) {
    assert.equal(
      compileStandardModerateRepair(candidate, routeClass, state ?? precheck).ok,
      false,
    );
  }
  const compound = completion("android_ui_dump", { compressed: false });
  compound.choices[0].message.tool_calls.push(
    call("candidate-2", "android_screenshot", {}),
  );
  assert.equal(
    compileStandardModerateRepair(compound, "OBSERVE_UI_RAW", precheck).reason,
    "repair_requires_exactly_one_tool_call",
  );
});
