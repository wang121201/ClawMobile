import { startClawBenchHttpServer } from "./http-server.js";
export async function startClawBenchGatewayAccount(channelId, channelLabel, ctx) {
    const account = ctx.account;
    if (!account.configured) {
        throw new Error(`ClawBench channel is not configured for account "${account.accountId}"`);
    }
    ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        enabled: account.enabled,
        baseUrl: account.baseUrl,
    });
    try {
        await startClawBenchHttpServer({
            channelId,
            channelLabel,
            account,
            config: ctx.cfg,
            signal: ctx.abortSignal,
            log: ctx.log,
        });
    }
    finally {
        ctx.setStatus({
            accountId: account.accountId,
            running: false,
        });
    }
}
//# sourceMappingURL=gateway.js.map