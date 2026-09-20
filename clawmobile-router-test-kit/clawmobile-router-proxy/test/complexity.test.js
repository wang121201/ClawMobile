import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyToolCallArguments,
  isWithinLocalComplexity,
} from "../src/complexity.js";

function call(argumentsValue, name = "android_test") {
  return {
    id: "call-1",
    type: "function",
    function: { name, arguments: argumentsValue },
  };
}

test("classifies no tool call and empty arguments separately", () => {
  assert.equal(classifyToolCallArguments([]), "no_tool_call");
  assert.equal(classifyToolCallArguments([call("{}")]), "no_arguments");
});

test("classifies bounded top-level scalars as simple", () => {
  assert.equal(
    classifyToolCallArguments([
      call(JSON.stringify({ x: 10, y: 20, enabled: true, label: "ok" })),
    ]),
    "simple_arguments",
  );
});

test("classifies nested, wide, and long arguments as complex", () => {
  assert.equal(
    classifyToolCallArguments([call(JSON.stringify({ steps: [{ x: 1 }] }))]),
    "complex_arguments",
  );
  assert.equal(
    classifyToolCallArguments([
      call(JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 })),
    ]),
    "complex_arguments",
  );
  assert.equal(
    classifyToolCallArguments([call(JSON.stringify({ text: "x".repeat(300) }))]),
    "complex_arguments",
  );
  assert.equal(
    classifyToolCallArguments([
      call('{  "x"  : 1 }'),
      call('{"y":2}'),
      call('{"z":3}'),
      call('{"w":4}'),
      call('{}'),
    ]),
    "complex_arguments",
  );
});

test("canonical JSON whitespace does not change argument complexity", () => {
  assert.equal(
    classifyToolCallArguments([call('{   "x"  :  1, "y" : true }')]),
    "simple_arguments",
  );
});

test("classifies malformed arguments as invalid", () => {
  assert.equal(classifyToolCallArguments([call("not-json")]), "invalid_arguments");
  assert.equal(classifyToolCallArguments([call("[]")]), "invalid_arguments");
  assert.equal(classifyToolCallArguments([{ function: { arguments: "{}" } }]), "invalid_arguments");
});

test("local complexity threshold is monotonic and rejects invalid data", () => {
  assert.equal(isWithinLocalComplexity("no_arguments", "simple_arguments"), true);
  assert.equal(isWithinLocalComplexity("simple_arguments", "simple_arguments"), true);
  assert.equal(isWithinLocalComplexity("complex_arguments", "simple_arguments"), false);
  assert.equal(isWithinLocalComplexity("invalid_arguments", "complex_arguments"), false);
});
