import { DEFAULT_ACCOUNT_ID, DEFAULT_HOST, DEFAULT_PORT } from "./accounts.js";
function normalizeHost(value) {
    return typeof value === "string" ? value.trim() || undefined : undefined;
}
function normalizePort(value) {
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const parsedPort = Number.parseInt(value, 10);
    return Number.isInteger(parsedPort) ? parsedPort : undefined;
}
export function applyClawBenchSetup(params) {
    const nextCfg = structuredClone(params.cfg);
    const section = nextCfg.channels?.clawbench ?? {};
    const accounts = { ...section.accounts };
    const target = params.accountId === DEFAULT_ACCOUNT_ID ? { ...section } : { ...accounts[params.accountId] };
    const inheritedHost = params.accountId === DEFAULT_ACCOUNT_ID ? undefined : normalizeHost(section.host);
    const inheritedPort = params.accountId === DEFAULT_ACCOUNT_ID ? undefined : normalizePort(section.port);
    target.enabled = true;
    target.host =
        normalizeHost(params.input.httpHost) ??
            normalizeHost(target.host) ??
            inheritedHost ??
            DEFAULT_HOST;
    target.port =
        normalizePort(params.input.httpPort) ??
            normalizePort(target.port) ??
            inheritedPort ??
            DEFAULT_PORT;
    if (typeof params.input.token === "string") {
        target.token = params.input.token;
    }
    nextCfg.channels ??= {};
    if (params.accountId === DEFAULT_ACCOUNT_ID) {
        nextCfg.channels.clawbench = {
            ...section,
            ...target,
        };
    }
    else {
        accounts[params.accountId] = target;
        nextCfg.channels.clawbench = {
            ...section,
            accounts,
        };
    }
    return nextCfg;
}
//# sourceMappingURL=setup.js.map