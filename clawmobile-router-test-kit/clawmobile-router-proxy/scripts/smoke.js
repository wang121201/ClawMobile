import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const virtualModels = new Set([
  "cloud-full",
  "local-full",
  "filter",
  "router",
  "experiment",
]);

const virtualModel = process.argv[2] || "router";
if (!virtualModels.has(virtualModel)) {
  throw new Error(`model must be one of: ${[...virtualModels].join(", ")}`);
}

const configPath =
  process.env.OPENCLAW_CONFIG_PATH ||
  join(homedir(), ".openclaw", "openclaw.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const provider = config?.models?.providers?.["clawmobile-router"];
if (
  typeof provider?.baseUrl !== "string" ||
  typeof provider?.apiKey !== "string" ||
  provider.apiKey.length === 0
) {
  throw new Error("clawmobile-router provider is not fully configured");
}
const proxyBaseUrl = (
  process.env.CLAW_ROUTER_SMOKE_BASE_URL || provider.baseUrl
).replace(/\/+$/, "");

const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${provider.apiKey}`,
    "content-type": "application/json",
  },
  signal: AbortSignal.timeout(650_000),
  body: JSON.stringify({
    model: virtualModel,
    messages: [{
      role: "user",
      content:
        "Inspect the current Android user interface before taking any action. Return the single next assistant step.",
    }],
    tools: [
      {
        type: "function",
        function: {
          name: "android_ui_dump",
          description: "Return the current UI tree.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "android_tap",
          description: "Tap known screen coordinates.",
          parameters: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" },
            },
            required: ["x", "y"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "auto",
    stream: false,
    temperature: 0,
    max_tokens: 1024,
  }),
});

const responseText = await response.text();
let responseBody = responseText;
try {
  responseBody = JSON.parse(responseText);
} catch {
  // Preserve a non-JSON upstream response for diagnosis; credentials are never included.
}

console.log(JSON.stringify({
  status: response.status,
  route: response.headers.get("x-clawmobile-route"),
  fallback: response.headers.get("x-clawmobile-fallback"),
  request_id: response.headers.get("x-request-id"),
  body: responseBody,
}, null, 2));

if (!response.ok) process.exitCode = 1;
