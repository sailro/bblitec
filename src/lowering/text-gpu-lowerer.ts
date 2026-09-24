import { LoweringContext } from "./context.js";
import { lowerTextFunctions } from "./text-records.js";

/**
 * The text renderable's GPU path, lowered whole from the pin: the shared
 * atlas and style-palette uploads, the renderable's GPU record, its
 * per-frame resource and uniform updates and its draw. Every device call is
 * the pin's own over `bblite/text_gpu.hpp` (`text-gpu-schema.ts`).
 */
export class TextGpuLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "gpu",
            ["records"],
        );
        return `#pragma once
#include <bblite/upstream_text_records.hpp>
#include <cmath>
#include <limits>
namespace bbl {
${declarations}
${definitions}
} // namespace bbl
`;
    }
}
