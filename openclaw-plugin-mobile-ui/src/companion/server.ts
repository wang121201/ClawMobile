import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { URL } from "url";
import { android_health } from "../tools/android";
import { getGatewayStatus, getRuntimeLog, startRuntime, stopRuntime } from "./openclawGatewayClient";
import { submitIntent } from "./intent";
import { archiveSession, deleteSession, getRunStatus, listRuns } from "./runs";
import type { CompanionHealth, IntentRequest, TerminalCommandRequest, TerminalCommandResponse, TerminalSessionRequest, TerminalSessionResponse } from "./types";

const VERSION = "0.1.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TERMINAL_COMMAND_CHARS = 2000;
const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024;
const TERMINAL_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TERMINAL_SESSION_OUTPUT_CHARS = 128 * 1024;
const CWD_SENTINEL_PREFIX = "__CLAWMOBILE_CWD:";
const CWD_SENTINEL_SUFFIX = "__";

type TerminalShellSession = {
  child: ChildProcessWithoutNullStreams;
  output: string;
  cwd: string;
  running: boolean;
  updatedAt: number;
};

export function startCompanionServer() {
  const configuredHost = (process.env.CLAWMOBILE_COMPANION_HOST || DEFAULT_HOST).trim();
  const host = listenHost(configuredHost);
  const port = parsePort(process.env.CLAWMOBILE_COMPANION_PORT, DEFAULT_PORT);

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error: any) {
      writeJson(res, error?.statusCode || 500, {
        success: false,
        message: error?.message || "Internal server error.",
      });
    }
  });

  const onListening = () => {
    const address = server.address();
    const resolvedHost = typeof address === "object" && address ? address.address : configuredHost || "::";
    console.log(`[companion] ClawMobile companion server listening on ${resolvedHost}:${port}`);
  };
  if (host) {
    server.listen(port, host, onListening);
  } else {
    server.listen(port, onListening);
  }
  server.once("error", (error: any) => {
    console.error(`[companion] unable to start companion server: ${error?.message || error}`);
    process.exit(1);
  });

  const shutdown = () => {
    console.log("[companion] shutting down companion server");
    stopTerminalShellSession();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  startTerminalShellSession();

  return server;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const method = req.method || "GET";
  const requestUrl = new URL(req.url || "/", "http://localhost");

  if (method === "OPTIONS") {
    writeJson(res, 204, {});
    return;
  }

  if (isTerminalRoute(requestUrl.pathname) && !isLoopbackRequest(req) && process.env.CLAWMOBILE_COMPANION_ALLOW_REMOTE_TERMINAL !== "1") {
    writeJson(res, 403, {
      success: false,
      message: "Terminal endpoints are restricted to local companion app requests.",
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/") {
    writeJson(res, 200, {
      name: "ClawMobile Companion Server",
      version: VERSION,
      endpoints: ["/health", "/intent", "/runtime/start", "/runtime/stop", "/runtime/log", "/terminal/command", "/terminal/session", "/terminal/session/input", "/terminal/session/reset", "/skills", "/runs", "/runs/:runId", "/sessions/:sessionId/archive", "/sessions/:sessionId"],
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/health") {
    writeJson(res, 200, await health());
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/intent") {
    const body = await readJsonBody<IntentRequest>(req);
    const result = await submitIntent(String(body?.text || ""), String(body?.sessionId || "default"));
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/runtime/start") {
    writeJson(res, 200, await startRuntime());
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/runtime/stop") {
    const result = await stopRuntime();
    writeJson(res, result.success ? 200 : 501, result);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/runtime/log") {
    const maxBytes = parsePort(requestUrl.searchParams.get("maxBytes") || undefined, 64 * 1024);
    writeJson(res, 200, getRuntimeLog(maxBytes));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/terminal/command") {
    const body = await readJsonBody<TerminalCommandRequest>(req);
    const result = await runTerminalCommand(String(body?.command || ""));
    writeJson(res, result.command ? 200 : 400, result);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/terminal/session") {
    writeJson(res, 200, terminalSessionSnapshot("Shell ready."));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/terminal/session/input") {
    const body = await readJsonBody<TerminalSessionRequest>(req);
    const result = sendTerminalSessionInput(String(body?.text || ""));
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/terminal/session/reset") {
    stopTerminalShellSession();
    const session = startTerminalShellSession();
    appendTerminalShellText(session, "Shell restarted.\n");
    writeJson(res, 200, terminalSessionSnapshot("Shell restarted."));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/skills") {
    writeJson(res, 200, {
      skills: [],
      message: "Skill listing will be backed by the OpenClaw workspace in a later server revision.",
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/runs") {
    writeJson(res, 200, {
      runs: await listRuns(),
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname.startsWith("/runs/")) {
    const runId = decodeURIComponent(requestUrl.pathname.slice("/runs/".length));
    const result = await getRunStatus(runId);
    writeJson(res, result.success || result.state !== "unknown" ? 200 : 404, result);
    return;
  }

  const archiveSessionMatch = requestUrl.pathname.match(/^\/sessions\/([^/]+)\/archive$/);
  if (method === "POST" && archiveSessionMatch) {
    const sessionId = decodeURIComponent(archiveSessionMatch[1]);
    const result = await archiveSession(sessionId);
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  const deleteSessionMatch = requestUrl.pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === "DELETE" && deleteSessionMatch) {
    const sessionId = decodeURIComponent(deleteSessionMatch[1]);
    const result = await deleteSession(sessionId);
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  writeJson(res, 404, {
    success: false,
    message: `No route for ${method} ${requestUrl.pathname}.`,
  });
}

async function health(): Promise<CompanionHealth> {
  const [runtime, gateway] = await Promise.all([
    android_health().catch((error: any) => ({
      ok: false,
      error: error?.message || "android_health failed",
    })),
    getGatewayStatus(),
  ]);

  const runtimeOk = runtime?.ok !== false;
  return {
    status: runtimeOk ? "ok" : "degraded",
    message: runtimeOk ? "ClawMobile companion server is running." : "Companion server is running with degraded runtime health.",
    version: VERSION,
    gateway,
    runtime,
    model: modelKeyHealth(),
  };
}

function runTerminalCommand(command: string): Promise<TerminalCommandResponse> {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return Promise.resolve({
      success: false,
      command: "",
      cwd: terminalCommandCwd(),
      output: "",
      message: "Command is empty.",
    });
  }

  if (trimmedCommand.length > MAX_TERMINAL_COMMAND_CHARS) {
    return Promise.resolve({
      success: false,
      command: trimmedCommand.slice(0, MAX_TERMINAL_COMMAND_CHARS),
      cwd: terminalCommandCwd(),
      output: "",
      message: `Command is too long. Limit is ${MAX_TERMINAL_COMMAND_CHARS} characters.`,
    });
  }

  const cwd = terminalCommandCwd();
  const shell = process.env.SHELL || "bash";
  const startedAt = Date.now();

  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", trimmedCommand],
      {
        cwd,
        env: process.env,
        timeout: TERMINAL_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_TERMINAL_OUTPUT_BYTES,
      },
      (error: any, stdout = "", stderr = "") => {
        const output = [stdout, stderr]
          .filter((text) => text && text.length > 0)
          .join(stdout && stderr ? "\n" : "")
          .trimEnd();
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        const timedOut = Boolean(error?.killed) || error?.signal === "SIGTERM";
        const success = !error;
        const message = timedOut
          ? `Command timed out after ${TERMINAL_COMMAND_TIMEOUT_MS / 1000}s.`
          : success
            ? "Command completed."
            : `Command exited with ${exitCode}.`;

        resolve({
          success,
          command: trimmedCommand,
          cwd,
          output,
          exitCode,
          durationMs: Date.now() - startedAt,
          message,
        });
      },
    );
  });
}

function terminalCommandCwd() {
  const configured = (process.env.CLAWMOBILE_TERMINAL_CWD || "").trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

let terminalShellSession: TerminalShellSession | null = null;

function startTerminalShellSession(): TerminalShellSession {
  if (terminalShellSession?.running) return terminalShellSession;

  const cwd = terminalCommandCwd();
  const shell = process.env.SHELL || "bash";
  const child = spawn(shell, ["--noprofile", "--norc"], {
    cwd,
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
    },
    stdio: "pipe",
  });
  child.stdin.setDefaultEncoding("utf8");

  const session: TerminalShellSession = {
    child,
    output: "",
    cwd,
    running: true,
    updatedAt: Date.now(),
  };
  terminalShellSession = session;
  appendTerminalShellText(session, `ClawMobile shell started in ${cwd}\n`);

  child.stdout.on("data", (chunk) => appendTerminalShellChunk(session, chunk));
  child.stderr.on("data", (chunk) => appendTerminalShellChunk(session, chunk));
  child.once("close", (code, signal) => {
    session.running = false;
    appendTerminalShellText(
      session,
      `\n[shell exited${typeof code === "number" ? ` ${code}` : ""}${signal ? `, ${signal}` : ""}]\n`,
    );
  });
  child.once("error", (error) => {
    session.running = false;
    appendTerminalShellText(session, `\n[shell error] ${error.message}\n`);
  });

  writeTerminalShellInput(session, `printf '${CWD_SENTINEL_PREFIX}%s${CWD_SENTINEL_SUFFIX}\\n' "$PWD"\n`);
  return session;
}

function stopTerminalShellSession() {
  const session = terminalShellSession;
  if (!session) return;
  terminalShellSession = null;
  try {
    session.child.stdin.end("exit\n");
  } catch {
    // ignore shutdown races
  }
  setTimeout(() => {
    if (session.running) {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // ignore shutdown races
      }
    }
  }, 500).unref();
}

function sendTerminalSessionInput(text: string): TerminalSessionResponse {
  const session = startTerminalShellSession();
  if (!session.running || session.child.stdin.destroyed) {
    return terminalSessionSnapshot("Shell is not running.", false);
  }

  const input = text.replace(/\r/g, "").trimEnd();
  if (!input) {
    writeTerminalShellInput(session, "\n");
    return terminalSessionSnapshot("Input sent.");
  }
  if (input.length > MAX_TERMINAL_COMMAND_CHARS) {
    return terminalSessionSnapshot(`Input is too long. Limit is ${MAX_TERMINAL_COMMAND_CHARS} characters.`, false);
  }

  appendTerminalShellText(session, `$ ${input}\n`);
  writeTerminalShellInput(session, `${input}\nprintf '${CWD_SENTINEL_PREFIX}%s${CWD_SENTINEL_SUFFIX}\\n' "$PWD"\n`);
  return terminalSessionSnapshot("Input sent.");
}

function writeTerminalShellInput(session: TerminalShellSession, input: string) {
  session.child.stdin.write(input);
  session.updatedAt = Date.now();
}

function appendTerminalShellChunk(session: TerminalShellSession, chunk: Buffer | string) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  appendTerminalShellText(session, stripCwdSentinels(session, text.replace(/\r/g, "")));
}

function stripCwdSentinels(session: TerminalShellSession, text: string) {
  return text.replace(new RegExp(`${CWD_SENTINEL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\n]*)${CWD_SENTINEL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), (_match, cwd) => {
    const nextCwd = String(cwd || "").trim();
    if (nextCwd) session.cwd = nextCwd;
    return "";
  });
}

function appendTerminalShellText(session: TerminalShellSession, text: string) {
  if (!text) return;
  session.output = (session.output + text).slice(-MAX_TERMINAL_SESSION_OUTPUT_CHARS);
  session.updatedAt = Date.now();
}

function terminalSessionSnapshot(message = "Shell ready.", success = true): TerminalSessionResponse {
  const session = startTerminalShellSession();
  return {
    success,
    message,
    output: session.output,
    cwd: session.cwd,
    running: session.running,
    pid: session.child.pid,
    updatedAt: session.updatedAt,
  };
}

function modelKeyHealth() {
  const envFileValues = readOpenClawEnvFile();
  const providers = [
    { id: "openai", label: "OpenAI", keys: ["OPENAI_API_KEY"] },
    { id: "anthropic", label: "Anthropic", keys: ["ANTHROPIC_API_KEY"] },
    { id: "deepseek", label: "DeepSeek", keys: ["DEEPSEEK_API_KEY"] },
  ];
  const configuredProvider = providers.find((provider) =>
    provider.keys.some((key) => Boolean(process.env[key] || envFileValues[key])),
  );

  if (!configuredProvider) {
    return {
      configured: false,
      message: "No model API key configured.",
    };
  }

  return {
    configured: true,
    provider: configuredProvider.id,
    message: `${configuredProvider.label} key configured.`,
  };
}

function readOpenClawEnvFile(): Record<string, string> {
  const envFile = process.env.OPENCLAW_ENV_FILE || path.join(os.homedir(), ".openclaw", ".env");
  try {
    const raw = fs.readFileSync(envFile, "utf8");
    return raw.split(/\r?\n/).reduce<Record<string, string>>((values, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return values;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) return values;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
      return values;
    }, {});
  } catch {
    return {};
  }
}

function parsePort(value: string | undefined, fallback: number) {
  const port = Number.parseInt(value || "", 10);
  return Number.isFinite(port) && port > 0 ? port : fallback;
}

function listenHost(value: string): string | undefined {
  const host = value.trim() || DEFAULT_HOST;
  if (host === "localhost" || host === "loopback") {
    return "127.0.0.1";
  }
  return host;
}

function isTerminalRoute(pathname: string) {
  return pathname === "/terminal/command" ||
    pathname === "/terminal/session" ||
    pathname === "/terminal/session/input" ||
    pathname === "/terminal/session/reset";
}

function isLoopbackRequest(req: http.IncomingMessage) {
  const address = String(req.socket.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function writeJson(res: http.ServerResponse, statusCode: number, value: any) {
  const body = statusCode === 204 ? "" : JSON.stringify(value, null, 2);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.end(body);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

if (require.main === module) {
  startCompanionServer();
}
