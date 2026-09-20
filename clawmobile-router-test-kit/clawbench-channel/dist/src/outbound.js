import { resolveClawBenchChannelAccount } from "./accounts.js";
import { completeClawBenchRun } from "./runs.js";
import { parseClawBenchTarget } from "./target.js";
export async function sendClawBenchChannelText(params) {
    const account = resolveClawBenchChannelAccount({ cfg: params.cfg, accountId: params.accountId });
    const parsed = parseClawBenchTarget(params.to);
    completeClawBenchRun({
        accountId: account.accountId,
        runId: parsed.runId,
        replyText: params.text,
    });
    return {
        to: params.to,
        messageId: `${parsed.runId}:reply`,
    };
}
//# sourceMappingURL=outbound.js.map