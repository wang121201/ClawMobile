export function buildClawBenchTarget(params) {
    return `run:${params.runId}`;
}
export function parseClawBenchTarget(raw) {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith("run:")) {
        return { runId: trimmed.slice(4) || "default" };
    }
    return { runId: trimmed || "default" };
}
//# sourceMappingURL=target.js.map