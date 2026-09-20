const runsByAccount = new Map();
function accountRuns(accountId) {
    let runs = runsByAccount.get(accountId);
    if (!runs) {
        runs = new Map();
        runsByAccount.set(accountId, runs);
    }
    return runs;
}
export function createClawBenchRun(params) {
    const runs = accountRuns(params.accountId);
    const existing = runs.get(params.runId);
    if (existing && existing.status !== "COMPLETED" && existing.status !== "FAILED") {
        throw new Error(`clawbench run already active: ${params.runId}`);
    }
    const now = Date.now();
    const record = {
        accountId: params.accountId,
        runId: params.runId,
        instruction: params.instruction,
        deviceSerial: params.deviceSerial,
        status: "QUEUED",
        createdAt: now,
        updatedAt: now,
    };
    runs.set(params.runId, record);
    return { ...record };
}
export function markClawBenchRunRunning(params) {
    const record = accountRuns(params.accountId).get(params.runId);
    if (!record) {
        return null;
    }
    record.status = "RUNNING";
    record.updatedAt = Date.now();
    return { ...record };
}
export function completeClawBenchRun(params) {
    const record = accountRuns(params.accountId).get(params.runId);
    if (!record) {
        return null;
    }
    const now = Date.now();
    record.status = "COMPLETED";
    record.updatedAt = now;
    record.completedAt = now;
    record.replyText = params.replyText;
    record.error = undefined;
    record.latency = params.latency;
    record.metrics = params.metrics;
    record.trajectory = params.trajectory;
    return { ...record };
}
export function failClawBenchRun(params) {
    const record = accountRuns(params.accountId).get(params.runId);
    if (!record) {
        return null;
    }
    const now = Date.now();
    record.status = "FAILED";
    record.updatedAt = now;
    record.completedAt = now;
    record.error = params.error;
    record.latency = params.latency;
    record.metrics = params.metrics;
    record.trajectory = params.trajectory;
    return { ...record };
}
export function getClawBenchRunSnapshot(params) {
    const accountId = params.accountId ?? "default";
    const record = accountRuns(accountId).get(params.runId);
    return record ? { ...record } : null;
}
//# sourceMappingURL=runs.js.map