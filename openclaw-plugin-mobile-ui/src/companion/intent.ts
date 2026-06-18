import crypto from "crypto";
import { getGatewayStatus } from "./openclawGatewayClient";
import { describeOpenClawResult, expectedCompanionSessionKey, normalizeCompanionSessionId, submitToOpenClawAgent } from "./openclawAgentClient";
import { intentCanvas } from "./canvas";
import { markSubmittedRunFailed, rememberSubmittedRun } from "./runs";
import type { OpenClawAgentSubmitResult } from "./openclawAgentClient";
import type { IntentSubmitResponse } from "./types";

export async function submitIntent(text: string, sessionId = "default"): Promise<IntentSubmitResponse> {
  const normalized = text.trim();
  const normalizedSessionId = normalizeCompanionSessionId(sessionId);
  if (!normalized) {
    return {
      success: false,
      runId: "",
      sessionId: normalizedSessionId,
      result: "",
      message: "Intent text is required.",
      canvas: intentCanvas(""),
    };
  }

  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const gateway = await getGatewayStatus();
  if (!gateway.reachable) {
    return {
      success: false,
      runId,
      sessionId: normalizedSessionId,
      result: gateway.message,
      message: gateway.message,
      canvas: intentCanvas(normalized, gateway.message),
    };
  }

  const accepted = acceptedRun(runId, normalizedSessionId);
  await rememberSubmittedRun(normalized, accepted);
  void submitIntentInBackground(normalized, runId, normalizedSessionId);

  const message = describeOpenClawResult(accepted);
  return {
    success: true,
    runId,
    sessionId: normalizedSessionId,
    result: message,
    message,
    canvas: intentCanvas(normalized, message),
    gatewayRun: includeRawIntent() ? accepted : undefined,
  };
}

async function submitIntentInBackground(text: string, runId: string, sessionId: string) {
  try {
    const openclaw = await submitToOpenClawAgent(text, runId, sessionId);
    await rememberSubmittedRun(text, {
      ...openclaw,
      runId,
      sessionId,
    });
  } catch (error: any) {
    await markSubmittedRunFailed(
      runId,
      `OpenClaw gateway accepted the connection but did not run the intent: ${error?.message || error}`,
    );
  }
}

function acceptedRun(runId: string, sessionId: string): OpenClawAgentSubmitResult {
  return {
    runId,
    sessionId,
    sessionKey: expectedCompanionSessionKey(sessionId),
    status: "accepted",
    acceptedAt: Date.now(),
    waitedForFinal: false,
    raw: {
      accepted: true,
      mode: "background",
    },
  };
}

function includeRawIntent() {
  return ["1", "true", "yes"].includes((process.env.CLAWMOBILE_INTENT_INCLUDE_RAW || "").toLowerCase());
}
