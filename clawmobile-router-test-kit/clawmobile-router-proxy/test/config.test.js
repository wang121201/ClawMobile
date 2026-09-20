import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeConfig } from "../src/config.js";

async function writeConfig(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-router-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "openclaw.json");
  const freeInference = {
    baseUrl: options.freeInferenceBaseUrl || "https://freeinference.org/v1",
    apiKey: options.providerApiKey || "upstream-provider-secret",
    ...(options.providerHeaders ? { headers: options.providerHeaders } : {}),
    models: [{ id: "deepseek-v4-flash" }, { id: "qwen3.6-35b" }],
  };
  await writeFile(
    configPath,
    JSON.stringify({
      models: {
        providers: {
          "custom-freeinference-org": freeInference,
          ...(options.omitXmu
            ? {}
            : {
                "custom-127-0-0-1-18080": {
                  baseUrl: "http://127.0.0.1:18080/v1",
                  models: [{ id: "qwen3-8b" }],
                },
              }),
          "clawmobile-router": {
            baseUrl: "http://127.0.0.1:18081/v1",
            apiKey: options.routerProviderApiKey || "legacy-router-provider-secret",
            models: [{ id: "experiment" }],
          },
        },
      },
    }),
  );
  return configPath;
}

async function writeOpenAiAuthProfiles(t, profiles = {
  "openai:api-key": {
    provider: "openai",
    type: "api_key",
    key: "openai-upstream-secret",
  },
}) {
  const directory = await mkdtemp(join(tmpdir(), "clawmobile-openai-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authProfilesPath = join(directory, "auth-profiles.json");
  await writeFile(authProfilesPath, JSON.stringify({ version: 1, profiles }));
  return authProfilesPath;
}

function runtimeEnv(overrides = {}) {
  return {
    CLAW_ROUTER_CLIENT_TOKEN: "independent-router-client-secret",
    CLAW_ROUTER_CLOUD_MODEL: "deepseek-v4-flash",
    CLAW_ROUTER_LOCAL_MODEL: "qwen3-8b",
    ...overrides,
  };
}

test("requires an explicit CLAW_ROUTER_CLIENT_TOKEN and never falls back to router provider apiKey", async (t) => {
  const configPath = await writeConfig(t, {
    routerProviderApiKey: "legacy-fallback-must-not-be-used",
  });
  await assert.rejects(
    loadRuntimeConfig({ configPath, env: runtimeEnv({ CLAW_ROUTER_CLIENT_TOKEN: undefined }) }),
    /set CLAW_ROUTER_CLIENT_TOKEN explicitly/,
  );
});

test("rejects a router client token equal to an upstream provider apiKey", async (t) => {
  const sharedSecret = "same-exact-utf8-secret-0123456789abcdef";
  const configPath = await writeConfig(t, { providerApiKey: sharedSecret });
  await assert.rejects(
    loadRuntimeConfig({
      configPath,
      env: runtimeEnv({ CLAW_ROUTER_CLIENT_TOKEN: sharedSecret }),
    }),
    /must differ from every upstream provider credential/,
  );
});

test("rejects a router client token equal to a credential-bearing upstream header", async (t) => {
  const sharedSecret = "same-header-secret-0123456789abcdef";
  const configPath = await writeConfig(t, {
    providerHeaders: { authorization: `Bearer ${sharedSecret}` },
  });
  await assert.rejects(
    loadRuntimeConfig({
      configPath,
      env: runtimeEnv({ CLAW_ROUTER_CLIENT_TOKEN: sharedSecret }),
    }),
    /must differ from every upstream provider credential/,
  );
});

test("compares exact secret bytes without trimming or adding a prefix", async (t) => {
  const configPath = await writeConfig(t, { providerApiKey: "exact-secret-0123456789abcdef00" });
  const runtime = await loadRuntimeConfig({
    configPath,
    env: runtimeEnv({ CLAW_ROUTER_CLIENT_TOKEN: " exact-secret-0123456789abcdef00 " }),
  });
  assert.equal(runtime.clientToken, " exact-secret-0123456789abcdef00 ");
});

test("rejects an explicit router client token shorter than 32 UTF-8 bytes", async (t) => {
  const configPath = await writeConfig(t);
  await assert.rejects(
    loadRuntimeConfig({
      configPath,
      env: runtimeEnv({ CLAW_ROUTER_CLIENT_TOKEN: "too-short" }),
    }),
    /at least 32 exact UTF-8 bytes/,
  );
});

for (const [name, freeInferenceBaseUrl] of [
  ["userinfo", "https://credential@freeinference.org/v1"],
  ["query", "https://freeinference.org/v1?api_key=credential"],
  ["fragment", "https://freeinference.org/v1#credential"],
]) {
  test(`rejects a FreeInference base URL containing ${name}`, async (t) => {
    const configPath = await writeConfig(t, { freeInferenceBaseUrl });
    await assert.rejects(
      loadRuntimeConfig({ configPath, env: runtimeEnv() }),
      /must equal https:\/\/freeinference\.org\/v1 and contain no userinfo, query, or fragment/,
    );
  });
}

test("accepts only the frozen formal FreeInference base URL", async (t) => {
  const configPath = await writeConfig(t);
  const runtime = await loadRuntimeConfig({ configPath, env: runtimeEnv() });
  assert.equal(runtime.decision.baseUrl, "https://freeinference.org/v1");
  assert.equal(runtime.cloud.baseUrl, "https://freeinference.org/v1");
});

test("router-only v4 profile set does not require unused GPT or XMU providers", async (t) => {
  const configPath = await writeConfig(t, { omitXmu: true });
  const runtime = await loadRuntimeConfig({
    configPath,
    env: runtimeEnv({
      CLAW_ROUTER_V4_ENABLED: "1",
      CLAW_ROUTER_V4_PROFILE_SET: "router-only",
    }),
  });
  assert.ok(runtime.v4Profiles["router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local"]);
  assert.equal(runtime.v4Profiles["full-openai-gpt55"], undefined);
  assert.equal(runtime.v4Profiles["full-xmu-qwen3-8b"], undefined);
});

test("loads the built-in OpenAI GPT-5.5 provider from one auth profile", async (t) => {
  const configPath = await writeConfig(t);
  const authProfilesPath = await writeOpenAiAuthProfiles(t);
  const runtime = await loadRuntimeConfig({
    configPath,
    authProfilesPath,
    env: runtimeEnv({ CLAW_ROUTER_V4_ENABLED: "1" }),
  });
  const gpt = runtime.v4Profiles["full-openai-gpt55"].cloud;
  assert.equal(gpt.id, "openai");
  assert.equal(gpt.baseUrl, "https://api.openai.com/v1");
  assert.equal(gpt.model, "gpt-5.5");
  assert.equal(gpt.apiKey, "openai-upstream-secret");
});

test("fails closed when built-in OpenAI auth has multiple usable profiles", async (t) => {
  const configPath = await writeConfig(t);
  const authProfilesPath = await writeOpenAiAuthProfiles(t, {
    "openai:first": { provider: "openai", type: "api_key", key: "first-secret" },
    "openai:second": { provider: "openai", type: "api_key", key: "second-secret" },
  });
  await assert.rejects(
    loadRuntimeConfig({
      configPath,
      authProfilesPath,
      env: runtimeEnv({ CLAW_ROUTER_V4_ENABLED: "1" }),
    }),
    /requires exactly one usable openai api_key profile; found 2/,
  );
});
