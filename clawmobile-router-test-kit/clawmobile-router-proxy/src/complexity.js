const CATEGORIES = new Set([
  "no_tool_call",
  "no_arguments",
  "simple_arguments",
  "complex_arguments",
  "invalid_arguments",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const UTF8 = new TextEncoder();
const SIMPLE_MAX_CALLS = 4;
const SIMPLE_MAX_FIELDS = 4;
const SIMPLE_MAX_BYTES = 256;

function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { value: {}, bytes: 2 };
  }
  if (isPlainObject(raw)) {
    return { value: raw, bytes: UTF8.encode(JSON.stringify(raw)).byteLength };
  }
  if (typeof raw !== "string") {
    throw new TypeError("tool arguments must be a JSON object or JSON string");
  }
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new TypeError("tool arguments must decode to a JSON object");
  }
  return { value: parsed, bytes: UTF8.encode(JSON.stringify(parsed)).byteLength };
}

function isSimpleValue(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Classify the arguments in a standard OpenAI tool_calls array.
 *
 * The function is deliberately pure: it does not mutate, stringify, or cache
 * any part of the input.
 */
export function classifyToolCallArguments(toolCalls) {
  if (toolCalls === undefined || toolCalls === null || toolCalls.length === 0) {
    return "no_tool_call";
  }
  if (!Array.isArray(toolCalls)) {
    return "invalid_arguments";
  }

  let sawSimple = false;
  let sawComplex = false;
  let totalFields = 0;
  let totalBytes = 0;

  if (toolCalls.length > SIMPLE_MAX_CALLS) {
    return "complex_arguments";
  }

  for (const toolCall of toolCalls) {
    if (
      !isPlainObject(toolCall) ||
      !isPlainObject(toolCall.function) ||
      typeof toolCall.function.name !== "string" ||
      toolCall.function.name.length === 0
    ) {
      return "invalid_arguments";
    }

    let parsed;
    try {
      parsed = parseArguments(toolCall.function.arguments);
    } catch {
      return "invalid_arguments";
    }

    const values = Object.values(parsed.value);
    totalFields += values.length;
    totalBytes += parsed.bytes;
    if (values.length === 0) {
      continue;
    }
    if (
      values.length <= SIMPLE_MAX_FIELDS &&
      parsed.bytes <= SIMPLE_MAX_BYTES &&
      values.every(isSimpleValue)
    ) {
      sawSimple = true;
    } else {
      sawComplex = true;
    }
  }

  if (totalFields > SIMPLE_MAX_FIELDS || totalBytes > SIMPLE_MAX_BYTES) {
    return "complex_arguments";
  }
  if (sawComplex) return "complex_arguments";
  if (sawSimple) return "simple_arguments";
  return "no_arguments";
}

export function classifyCompletionArguments(completion) {
  const choices = completion?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "invalid_arguments";
  }
  const message = choices[0]?.message;
  if (!message || typeof message !== "object") {
    return "invalid_arguments";
  }
  return classifyToolCallArguments(message.tool_calls);
}

export function isArgumentComplexity(value) {
  return CATEGORIES.has(value);
}

const COMPLEXITY_RANK = new Map([
  ["no_tool_call", -1],
  ["no_arguments", 0],
  ["simple_arguments", 1],
  ["complex_arguments", 2],
]);

export function isWithinLocalComplexity(actual, maximum) {
  if (actual === "invalid_arguments") return false;
  if (!COMPLEXITY_RANK.has(actual) || !COMPLEXITY_RANK.has(maximum)) {
    return false;
  }
  return COMPLEXITY_RANK.get(actual) <= COMPLEXITY_RANK.get(maximum);
}
