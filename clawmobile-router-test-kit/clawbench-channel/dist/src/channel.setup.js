import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { listClawBenchChannelAccountIds, resolveClawBenchChannelAccount, resolveDefaultClawBenchChannelAccountId, } from "./accounts.js";
import { clawBenchChannelPluginConfigSchema } from "./config-schema.js";
import { applyClawBenchSetup } from "./setup.js";
const CHANNEL_ID = "clawbench";
const meta = { ...getChatChannelMeta(CHANNEL_ID) };
export const clawBenchChannelSetupPlugin = {
    id: CHANNEL_ID,
    meta,
    capabilities: {
        chatTypes: ["direct"],
    },
    reload: { configPrefixes: ["channels.clawbench"] },
    configSchema: clawBenchChannelPluginConfigSchema,
    setup: {
        applyAccountConfig: ({ cfg, accountId, input }) => applyClawBenchSetup({
            cfg,
            accountId,
            input: input,
        }),
    },
    config: {
        listAccountIds: (cfg) => listClawBenchChannelAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveClawBenchChannelAccount({ cfg: cfg, accountId }),
        defaultAccountId: (cfg) => resolveDefaultClawBenchChannelAccountId(cfg),
        isConfigured: (account) => account.configured,
        resolveAllowFrom: ({ cfg, accountId }) => resolveClawBenchChannelAccount({ cfg: cfg, accountId }).config.allowFrom,
        resolveDefaultTo: ({ cfg, accountId }) => resolveClawBenchChannelAccount({ cfg: cfg, accountId }).config.defaultTo,
    },
};
//# sourceMappingURL=channel.setup.js.map