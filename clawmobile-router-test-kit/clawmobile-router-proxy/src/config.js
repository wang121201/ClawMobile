import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const VIRTUAL_MODELS = Object.freeze([
  "cloud-full",
  "local-full",
  "filter",
  "router",
  "experiment",
]);

export const EXPERIMENT_STRATEGIES = Object.freeze([
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
]);

export const V4_ARM_IDS = Object.freeze([
  "full-dsv4",
  "filter-dsv4-agent-dsv4",
  "filter-qwen36-agent-dsv4",
  "router-dsv4-agent-dsv4-qwen36-logical-local",
  "router-r1-dsv4-agent-dsv4-qwen36-logical-local",
  "router-r2-dsv4-agent-dsv4-qwen36-logical-local",
  "router-rm-dsv4-agent-dsv4-qwen36-logical-local",
  "router-rm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
  "router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
  "router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local",
  "router-fsm-scoped-repair-qwen36-agent-dsv4-qwen36-logical-local",
  "router-fsm-scoped-repair-cloud-first-dsv4-agent-dsv4-qwen36-logical-local",
  "router-fsm-scoped-repair-c1-dsv4-agent-dsv4-qwen36-logical-local",
  "router-fsm-scoped-repair-c2-dsv4-agent-dsv4-qwen36-logical-local",
  "router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local",
  "router-binary-tool-effect-aware-dsv4-agent-dsv4-qwen36-logical-local",
  "router-binary-tool-effect-aware-strong-path-check-dsv4-agent-dsv4-qwen36-logical-local",
  "router-explicit-binary-tool-deterministic-dsv4-qwen36-logical-local",
  "full-openai-gpt55",
  "full-qwen36",
  "full-xmu-qwen3-8b",
  "full-xmu-qwen2.5-1.5b",
  "full-xmu-qwen3.8-27b",
]);

const DEFAULT_PROVIDER_IDS = Object.freeze({
  decision: "custom-freeinference-org",
  cloud: "custom-freeinference-org",
  local: "custom-127-0-0-1-18080",
});

const FORMAL_FREEINFERENCE_BASE_URL = "https://freeinference.org/v1";
const CREDENTIAL_HEADER_NAME =
  /^(authorization|proxy-authorization|.*api[-_]?key.*|.*token.*|.*secret.*|cookie|set-cookie)$/i;

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function activeExperimentStrategy(value) {
  if (value === undefined) return null;
  if (!EXPERIMENT_STRATEGIES.includes(value)) {
    throw new Error(
      `CLAW_ROUTER_ACTIVE_STRATEGY must be one of: ${EXPERIMENT_STRATEGIES.join(", ")}`,
    );
  }
  return value;
}

function experimentArmId(value) {
  if (value === undefined) return "experiment";
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error(
      "CLAW_ROUTER_ARM_ID must contain 1-128 letters, digits, dots, underscores, colons, or hyphens",
    );
  }
  return value;
}

function resolveSecret(value, env) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const interpolation = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (interpolation) return env[interpolation[1]];
  if (value.startsWith("env:") && value.length > 4) return env[value.slice(4)];
  return value;
}

function selectModel(provider, explicitModel, providerId) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const ids = models
    .map((model) => (typeof model === "string" ? model : model?.id))
    .filter((id) => typeof id === "string" && id.length > 0);
  const selected = explicitModel || ids[0];
  if (!selected) {
    throw new Error(`Provider ${providerId} has no model id`);
  }
  if (explicitModel && ids.length > 0 && !ids.includes(explicitModel)) {
    throw new Error(`Model ${explicitModel} is not configured under provider ${providerId}`);
  }
  return selected;
}

function normalizeHeaders(headers, env) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = resolveSecret(value, env) ?? "";
  }
  return result;
}

function providerBaseUrl(providerId, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provider ${providerId} has no baseUrl`);
  }
  const normalized = value.replace(/\/+$/, "");
  if (providerId !== "custom-freeinference-org") return normalized;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Provider ${providerId} baseUrl must equal ${FORMAL_FREEINFERENCE_BASE_URL}`,
    );
  }
  if (
    normalized !== FORMAL_FREEINFERENCE_BASE_URL ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `Provider ${providerId} baseUrl must equal ${FORMAL_FREEINFERENCE_BASE_URL} and contain no userinfo, query, or fragment`,
    );
  }
  return normalized;
}

function loadProvider(providers, providerId, explicitModel, env) {
  const provider = providers[providerId];
  if (!provider || typeof provider !== "object") {
    throw new Error(`Provider ${providerId} was not found in OpenClaw config`);
  }
  return Object.freeze({
    id: providerId,
    baseUrl: providerBaseUrl(providerId, provider.baseUrl),
    model: selectModel(provider, explicitModel, providerId),
    apiKey: resolveSecret(provider.apiKey, env),
    headers: Object.freeze(normalizeHeaders(provider.headers, env)),
  });
}

function uniqueProviderForModel(providers, modelId, explicitProviderId) {
  if (explicitProviderId) return explicitProviderId;
  const matches = Object.entries(providers)
    .filter(([, provider]) =>
      Array.isArray(provider?.models) &&
      provider.models.some((model) =>
        (typeof model === "string" ? model : model?.id) === modelId,
      ),
    )
    .map(([providerId]) => providerId);
  if (matches.length !== 1) {
    throw new Error(
      `Model ${modelId} must resolve to exactly one configured provider; found ${matches.length}`,
    );
  }
  return matches[0];
}

function upstreamCredentialValues(provider) {
  const values = [];
  if (typeof provider.apiKey === "string" && provider.apiKey.length > 0) {
    values.push(provider.apiKey);
  }
  for (const [name, value] of Object.entries(provider.headers)) {
    if (!CREDENTIAL_HEADER_NAME.test(name) || typeof value !== "string") continue;
    const bearer = value.match(/^Bearer (.*)$/i);
    values.push(bearer ? bearer[1] : value);
  }
  return values;
}

function assertDistinctClientToken(clientToken, upstreamProviders) {
  for (const provider of upstreamProviders) {
    for (const credential of upstreamCredentialValues(provider)) {
      if (clientToken === credential) {
        throw new Error(
          "CLAW_ROUTER_CLIENT_TOKEN must differ from every upstream provider credential",
        );
      }
    }
  }
}

export function defaultConfigPath(env = process.env) {
  return env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");
}

export function defaultAuthProfilesPath(env = process.env) {
  return env.OPENCLAW_AUTH_PROFILES_PATH ||
    join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
}

async function loadBuiltinOpenAiProvider(path, modelId) {
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read OpenAI auth profiles at ${path}: ${error.message}`);
  }
  const matches = Object.entries(document?.profiles || {})
    .filter(([, profile]) =>
      profile?.provider === "openai" &&
      profile?.type === "api_key" &&
      typeof profile?.key === "string" &&
      profile.key.length > 0,
    );
  if (matches.length !== 1) {
    throw new Error(
      `OpenAI model ${modelId} requires exactly one usable openai api_key profile; found ${matches.length}`,
    );
  }
  return Object.freeze({
    baseUrl: "https://api.openai.com/v1",
    apiKey: matches[0][1].key,
    models: Object.freeze([{ id: modelId }]),
  });
}

export async function loadRuntimeConfig(options = {}) {
  const env = options.env || process.env;
  const path = options.configPath || defaultConfigPath(env);
  const document = JSON.parse(await readFile(path, "utf8"));
  const configuredProviders = document?.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    throw new Error("OpenClaw config does not contain models.providers");
  }
  const providers = { ...configuredProviders };

  const cloudProviderId =
    env.CLAW_ROUTER_CLOUD_PROVIDER || DEFAULT_PROVIDER_IDS.cloud;
  const decisionProviderId =
    env.CLAW_ROUTER_DECISION_PROVIDER || DEFAULT_PROVIDER_IDS.decision;
  const localProviderId =
    env.CLAW_ROUTER_LOCAL_PROVIDER || DEFAULT_PROVIDER_IDS.local;
  const explicitClientToken = env.CLAW_ROUTER_CLIENT_TOKEN;
  const clientToken = resolveSecret(explicitClientToken, env);
  if (!clientToken) {
    throw new Error(
      "Router client token is missing; set CLAW_ROUTER_CLIENT_TOKEN explicitly",
    );
  }
  if (Buffer.byteLength(clientToken, "utf8") < 32) {
    throw new Error(
      "CLAW_ROUTER_CLIENT_TOKEN must contain at least 32 exact UTF-8 bytes",
    );
  }

  const v4Enabled = env.CLAW_ROUTER_V4_ENABLED === "1";
  let decision;
  let cloud;
  let local;
  let v4Profiles = null;
  if (v4Enabled) {
    const profileSet = env.CLAW_ROUTER_V4_PROFILE_SET || "all";
    if (!["all", "router-only"].includes(profileSet)) {
      throw new Error("CLAW_ROUTER_V4_PROFILE_SET must be all or router-only");
    }
    const providerId = env.CLAW_ROUTER_V4_PROVIDER || DEFAULT_PROVIDER_IDS.cloud;
    const xmuProviderId =
      env.CLAW_ROUTER_V4_XMU_PROVIDER || DEFAULT_PROVIDER_IDS.local;
    const dsv4 = loadProvider(
      providers,
      providerId,
      env.CLAW_ROUTER_V4_DSV4_MODEL || "deepseek-v4-flash",
      env,
    );
    const qwen36 = loadProvider(
      providers,
      providerId,
      env.CLAW_ROUTER_V4_QWEN36_MODEL || "qwen3.6-35b",
      env,
    );
    let gpt55 = null;
    let xmuActive = null;
    if (profileSet === "all") {
      const gpt55Model = env.CLAW_ROUTER_V4_GPT55_MODEL || "gpt-5.5";
      const explicitGpt55ProviderId = env.CLAW_ROUTER_V4_GPT55_PROVIDER;
      const configuredGpt55Matches = Object.entries(providers)
        .filter(([, provider]) =>
          Array.isArray(provider?.models) &&
          provider.models.some((model) =>
            (typeof model === "string" ? model : model?.id) === gpt55Model,
          ),
        )
        .map(([configuredProviderId]) => configuredProviderId);
      if (
        configuredGpt55Matches.length === 0 &&
        (!explicitGpt55ProviderId || explicitGpt55ProviderId === "openai")
      ) {
        if (providers.openai) {
          throw new Error(
            `Configured provider openai does not declare model ${gpt55Model}; refusing to replace it with the built-in auth profile`,
          );
        }
        providers.openai = await loadBuiltinOpenAiProvider(
          options.authProfilesPath || defaultAuthProfilesPath(env),
          gpt55Model,
        );
      }
      const gpt55ProviderId = uniqueProviderForModel(
        providers,
        gpt55Model,
        explicitGpt55ProviderId,
      );
      gpt55 = loadProvider(providers, gpt55ProviderId, gpt55Model, env);
      const xmuModel = env.CLAW_ROUTER_V4_XMU_ACTIVE_MODEL || "qwen3-8b";
      if (!["qwen3-8b", "qwen2.5-1.5b-instruct", "qwen3.8-27b"].includes(xmuModel)) {
        throw new Error(
          "CLAW_ROUTER_V4_XMU_ACTIVE_MODEL must be qwen3-8b, qwen2.5-1.5b-instruct, or qwen3.8-27b",
        );
      }
      xmuActive = loadProvider(providers, xmuProviderId, xmuModel, env);
    }
    decision = dsv4;
    cloud = dsv4;
    local = qwen36;
    v4Profiles = Object.freeze({
      "full-dsv4": Object.freeze({
        armId: "full-dsv4",
        strategy: "cloud-full",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "filter-dsv4-agent-dsv4": Object.freeze({
        armId: "filter-dsv4-agent-dsv4",
        strategy: "filter",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "filter-qwen36-agent-dsv4": Object.freeze({
        armId: "filter-qwen36-agent-dsv4",
        strategy: "filter",
        decision: qwen36,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-r1-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-r1-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-r1",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-r2-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-r2-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-r2",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-rm-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-rm-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-rm",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-rm-scoped-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-rm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-rm-scoped",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-fsm-scoped",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-fsm-scoped-repair",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-fsm-scoped-repair-qwen36-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-fsm-scoped-repair-qwen36-agent-dsv4-qwen36-logical-local",
        strategy: "router-fsm-scoped-repair",
        decision: qwen36,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-fsm-scoped-repair-cloud-first-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-fsm-scoped-repair-cloud-first-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-fsm-scoped-repair-cloud-first",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-fsm-scoped-repair-c1-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-fsm-scoped-repair-c1-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-fsm-scoped-repair-c1",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-fsm-scoped-repair-c2-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-fsm-scoped-repair-c2-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-fsm-scoped-repair-c2",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-binary-tool",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-binary-tool-effect-aware-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-binary-tool-effect-aware-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-binary-tool-effect-aware",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-binary-tool-effect-aware-strong-path-check-dsv4-agent-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-binary-tool-effect-aware-strong-path-check-dsv4-agent-dsv4-qwen36-logical-local",
        strategy: "router-binary-tool-effect-aware-strong-path-check",
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "router-explicit-binary-tool-deterministic-dsv4-qwen36-logical-local": Object.freeze({
        armId: "router-explicit-binary-tool-deterministic-dsv4-qwen36-logical-local",
        strategy: "router-explicit-binary-tool",
        // The deterministic policy never invokes the decision provider.  Keep
        // the slot populated so the shared provider/session contract remains
        // structurally unchanged for this single-arm comparison.
        decision: dsv4,
        cloud: dsv4,
        local: qwen36,
      }),
      "full-qwen36": Object.freeze({
        armId: "full-qwen36",
        strategy: "cloud-full",
        decision: dsv4,
        cloud: qwen36,
        local: qwen36,
      }),
      ...(profileSet === "all"
        ? {
            "full-openai-gpt55": Object.freeze({
              armId: "full-openai-gpt55",
              strategy: "cloud-full",
              decision: gpt55,
              cloud: gpt55,
              local: qwen36,
            }),
            "full-xmu-qwen3-8b": Object.freeze({
              armId: "full-xmu-qwen3-8b",
              strategy: "local-full",
              decision: dsv4,
              cloud: dsv4,
              local: xmuActive,
            }),
            "full-xmu-qwen2.5-1.5b": Object.freeze({
              armId: "full-xmu-qwen2.5-1.5b",
              strategy: "local-full",
              decision: dsv4,
              cloud: dsv4,
              local: xmuActive,
            }),
            "full-xmu-qwen3.8-27b": Object.freeze({
              armId: "full-xmu-qwen3.8-27b",
              strategy: "local-full",
              decision: dsv4,
              cloud: dsv4,
              local: xmuActive,
            }),
          }
        : {}),
    });
  } else {
    decision = loadProvider(
      providers,
      decisionProviderId,
      env.CLAW_ROUTER_DECISION_MODEL || "deepseek-v4-flash",
      env,
    );
    cloud = loadProvider(
      providers,
      cloudProviderId,
      env.CLAW_ROUTER_CLOUD_MODEL,
      env,
    );
    local = loadProvider(
      providers,
      localProviderId,
      env.CLAW_ROUTER_LOCAL_MODEL,
      env,
    );
  }
  assertDistinctClientToken(
    clientToken,
    v4Profiles
      ? [
          ...new Set(
            Object.values(v4Profiles).flatMap((profile) => [
              profile.decision,
              profile.cloud,
              profile.local,
            ]),
          ),
        ]
      : [decision, cloud, local],
  );

  return Object.freeze({
    configPath: path,
    activeStrategy: activeExperimentStrategy(
      env.CLAW_ROUTER_ACTIVE_STRATEGY,
    ),
    armId: experimentArmId(env.CLAW_ROUTER_ARM_ID),
    v4Enabled,
    v4Profiles,
    decision,
    cloud,
    local,
    clientToken,
    requestBodyLimitBytes: positiveInteger(
      env.CLAW_ROUTER_BODY_LIMIT_BYTES,
      10 * 1024 * 1024,
      "CLAW_ROUTER_BODY_LIMIT_BYTES",
    ),
    strategyTimeoutMs: positiveInteger(
      env.CLAW_ROUTER_STRATEGY_TIMEOUT_MS,
      60_000,
      "CLAW_ROUTER_STRATEGY_TIMEOUT_MS",
    ),
    answerTimeoutMs: positiveInteger(
      env.CLAW_ROUTER_ANSWER_TIMEOUT_MS,
      300_000,
      "CLAW_ROUTER_ANSWER_TIMEOUT_MS",
    ),
  });
}

export function publicConfig(runtime) {
  const result = {
    decision: { id: runtime.decision.id, model: runtime.decision.model },
    cloud: { id: runtime.cloud.id, model: runtime.cloud.model },
    local: { id: runtime.local.id, model: runtime.local.model },
  };
  if (runtime.v4Profiles) {
    result.v4_arms = Object.fromEntries(
      Object.entries(runtime.v4Profiles).map(([armId, profile]) => [
        armId,
        {
          strategy: profile.strategy,
          decision: { id: profile.decision.id, model: profile.decision.model },
          cloud: { id: profile.cloud.id, model: profile.cloud.model },
          local: { id: profile.local.id, model: profile.local.model },
        },
      ]),
    );
  }
  return result;
}
