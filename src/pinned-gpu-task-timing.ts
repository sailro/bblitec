import { importPinnedModule } from "./pinned-shader-composer.js";
import { runGenerationChild } from "./compiler/generation-child.js";

interface TimingCapabilityEngine {
    _device: { features: ReadonlySet<string> };
}

/** Native device creation does not enable timestamp-query on either backend. */
export async function executeNativeTaskTiming(): Promise<unknown> {
    const source = await importPinnedModule<{
        isRenderTaskGpuTimingSupported(engine: TimingCapabilityEngine): boolean;
        getRenderTaskGpuTimings(engine: TimingCapabilityEngine): unknown;
        setRenderTaskGpuTimingEnabled(
            engine: TimingCapabilityEngine,
            enabled: boolean,
        ): Promise<unknown>;
    }>("engine/gpu-task-timing.js");
    const engine: TimingCapabilityEngine = { _device: { features: new Set() } };
    const supported = source.isRenderTaskGpuTimingSupported(engine);
    const snapshot = source.getRenderTaskGpuTimings(engine);
    const enabled = await source.setRenderTaskGpuTimingEnabled(engine, true);
    const disabled = await source.setRenderTaskGpuTimingEnabled(engine, false);
    if (
        supported ||
        JSON.stringify(snapshot) !== JSON.stringify(enabled) ||
        JSON.stringify(snapshot) !== JSON.stringify(disabled)
    )
        throw new Error(
            "Pinned task timing no longer has one unsupported capability result.",
        );
    return snapshot;
}

export type TimingConstant = string | number | boolean | readonly never[];
let cachedSnapshot: ReadonlyMap<string, TimingConstant> | undefined;

/** Execute the pinned unsupported branch; all snapshot values remain source-owned. */
export function nativeTaskTimingSnapshot(): ReadonlyMap<
    string,
    TimingConstant
> {
    if (cachedSnapshot) return cachedSnapshot;
    const json: unknown = JSON.parse(
        runGenerationChild({
            label: "Pinned task timing capability",
            script: `import {executeNativeTaskTiming} from ${JSON.stringify(import.meta.url)};
process.stdout.write(JSON.stringify(await executeNativeTaskTiming()));`,
        }),
    );
    if (!json || typeof json !== "object" || Array.isArray(json))
        throw new Error("Invalid pinned task timing snapshot.");
    const fields = new Map<string, TimingConstant>();
    for (const [key, value] of Object.entries(json)) {
        if (
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value))
        )
            fields.set(key, value);
        else if (Array.isArray(value) && value.length === 0)
            fields.set(key, []);
        else
            throw new Error(`Unrepresented pinned task timing field '${key}'.`);
    }
    if (
        fields.get("status") !== "unsupported" ||
        fields.get("supported") !== false
    )
        throw new Error(
            "Native task timing requires the unsupported capability branch.",
        );
    cachedSnapshot = fields;
    return fields;
}
