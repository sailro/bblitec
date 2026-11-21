import type { Value } from "./types.js";

/** The engine surface's sample count, or undefined when the run selects it. */
export function knownEngineSampleCount(
    value: Pick<Value, "msaaSamples">,
): 1 | 4 | undefined {
    return value.msaaSamples === "runtime"
        ? undefined
        : (value.msaaSamples ?? 4);
}

/** The primary engine surface may select its sample count at runtime. */
export function engineSampleCountCpp(
    value: Pick<Value, "cpp" | "engineCpp" | "msaaSamples">,
): string {
    const count = knownEngineSampleCount(value);
    return count === undefined
        ? `${value.engineCpp ?? value.cpp}.options.msaa_samples`
        : `${count}u`;
}
