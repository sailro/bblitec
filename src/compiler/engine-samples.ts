import type { Value } from "./types.js";

/** The primary engine surface may select its sample count at runtime. */
export function engineSampleCountCpp(
    value: Pick<Value, "cpp" | "engineCpp" | "msaaSamples">,
): string {
    return value.msaaSamples === "runtime"
        ? `${value.engineCpp ?? value.cpp}.options.msaa_samples`
        : `${value.msaaSamples ?? 4}u`;
}
