import { createRouterProxy } from "./proxy.js";

const host = process.env.CLAW_ROUTER_HOST || "127.0.0.1";
const port = Number(process.env.CLAW_ROUTER_PORT || 18081);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

if (!LOOPBACK_HOSTS.has(host) && process.env.CLAW_ROUTER_ALLOW_NON_LOOPBACK !== "1") {
  process.stderr.write(
    `${JSON.stringify({
      event: "router_start_failed",
      error: "Non-loopback bind requires CLAW_ROUTER_ALLOW_NON_LOOPBACK=1",
    })}\n`,
  );
  process.exit(1);
}

try {
  const { server, runtime, logPath, capturePath } = await createRouterProxy();
  server.listen(port, host, () => {
    const summary = {
      event: "router_started",
      address: `http://${host}:${port}`,
      decision_provider: runtime.decision.id,
      decision_model: runtime.decision.model,
      cloud_provider: runtime.cloud.id,
      cloud_model: runtime.cloud.model,
      local_provider: runtime.local.id,
      local_model: runtime.local.model,
      active_strategy: runtime.activeStrategy,
      arm_id: runtime.armId,
      log_path: logPath,
      capture_path: capturePath,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  });
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: "router_start_failed", error: error.message })}\n`,
  );
  process.exitCode = 1;
}
