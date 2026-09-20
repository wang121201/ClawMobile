import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET_KEY = /(authorization|api[-_]?key|token|secret|password|cookie)/i;
const SAFE_TOKEN_METRICS = new Set([
  "helper_prompt_tokens",
  "helper_completion_tokens",
  "helper_total_tokens",
]);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    const safeMetric = SAFE_TOKEN_METRICS.has(key) && Number.isSafeInteger(child) && child >= 0;
    clean[key] = SECRET_KEY.test(key) && !safeMetric ? "[REDACTED]" : redact(child);
  }
  return clean;
}

export function createJsonlLogger(path) {
  return async function log(event) {
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    const record = redact({ timestamp: new Date().toISOString(), ...event });
    const handle = await open(path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
}
