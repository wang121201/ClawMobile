import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createInterface } from "node:readline";

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "description",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "properties",
  "additionalProperties",
  "enum",
  "required",
  "items",
  "anyOf",
  "maxItems",
  "minItems",
  "minLength",
  "maxLength",
  "const",
  "default",
  "patternProperties",
]);

function increment(counter, key) {
  counter.set(key, (counter.get(key) || 0) + 1);
}

function sortedCounter(counter) {
  return [...counter.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => ({ name, count }));
}

async function listCaptureFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile() && entry.name === "model-calls.jsonl") files.push(path);
    }
  }
  await visit(root);
  return files;
}

function inspectSchema(schema, state) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    state.malformedSchemaCount += 1;
    return;
  }
  for (const keyword of Object.keys(schema)) {
    increment(state.keywordCounts, keyword);
    if (!SUPPORTED_KEYWORDS.has(keyword)) state.unsupportedKeywords.add(keyword);
  }
  if (schema.type !== undefined) {
    if (typeof schema.type === "string") increment(state.typeCounts, schema.type);
    else state.malformedSchemaCount += 1;
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const child of Object.values(schema.properties)) inspectSchema(child, state);
  }
  if (schema.patternProperties && typeof schema.patternProperties === "object") {
    for (const child of Object.values(schema.patternProperties)) inspectSchema(child, state);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    inspectSchema(schema.additionalProperties, state);
  }
  if (schema.items && typeof schema.items === "object") inspectSchema(schema.items, state);
  if (Array.isArray(schema.anyOf)) {
    for (const child of schema.anyOf) inspectSchema(child, state);
  }
}

const corpusRoot = resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("usage: node scripts/audit-parameter-schema-corpus.mjs <formal-corpus-root>");
}

const files = await listCaptureFiles(corpusRoot);
const corpusHash = createHash("sha256");
const state = {
  proxyRequestCount: 0,
  toolSchemaCount: 0,
  malformedSchemaCount: 0,
  keywordCounts: new Map(),
  typeCounts: new Map(),
  unsupportedKeywords: new Set(),
};

for (const file of files) {
  const relativePath = relative(corpusRoot, file).replaceAll("\\", "/");
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.event !== "proxy_request") continue;
    if (typeof record.raw_request_text !== "string") {
      throw new Error(`${relativePath}:${lineNumber} has no raw_request_text`);
    }
    corpusHash.update(relativePath);
    corpusHash.update("\0");
    corpusHash.update(String(lineNumber));
    corpusHash.update("\0");
    corpusHash.update(line);
    corpusHash.update("\n");
    const request = JSON.parse(record.raw_request_text);
    state.proxyRequestCount += 1;
    for (const tool of Array.isArray(request.tools) ? request.tools : []) {
      const schema = tool?.function?.parameters;
      if (schema === undefined) continue;
      state.toolSchemaCount += 1;
      inspectSchema(schema, state);
    }
  }
}

const result = {
  schema_version: 1,
  validation_level: "parameter_schema_subset_v1",
  corpus_root: corpusRoot,
  selection_rule:
    "sorted recursive model-calls.jsonl; every event=proxy_request; every tools[].function.parameters",
  capture_file_count: files.length,
  proxy_request_count: state.proxyRequestCount,
  tool_schema_count: state.toolSchemaCount,
  malformed_schema_count: state.malformedSchemaCount,
  unsupported_schema_keywords: [...state.unsupportedKeywords].sort(),
  observed_schema_keywords: sortedCounter(state.keywordCounts),
  observed_schema_types: sortedCounter(state.typeCounts),
  selected_proxy_request_records_sha256: corpusHash.digest("hex"),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
