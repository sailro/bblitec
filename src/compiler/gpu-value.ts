import type { Value } from "./types.js";

/** The existing realm GPU owner, including its unbound branded method. */
export function gpuValue(cpp: string): Value {
    return {
        kind: "record",
        nativeGpu: true,
        dataType: { kind: "gpu" },
        cpp,
        objectIdentityCpp: cpp,
        optionalFoundCpp: `(${cpp} != nullptr)`,
        truthinessCpp: `(${cpp} != nullptr)`,
        requiresApplicationRealm: true,
        recordProperties: {
            requestAdapter: {
                kind: "callback",
                cpp: "",
                hostFunction: "gpu-request-adapter",
            },
        },
    };
}
