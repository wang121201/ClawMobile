import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
const { setRuntime: setClawBenchChannelRuntime, getRuntime: getClawBenchChannelRuntime } = createPluginRuntimeStore({
    pluginId: "clawbench",
    errorMessage: "ClawBench channel runtime not initialized",
});
export { getClawBenchChannelRuntime, setClawBenchChannelRuntime };
//# sourceMappingURL=runtime.js.map