import type { LoweringContext } from "./context.js";
import { lowerTextFunctions } from "./text-records.js";

/**
 * The default text layout, lowered whole from the pin's `layoutText`: the
 * whitespace collapse, paragraph batching, wrapping and alignment are the
 * pin's own statements. text-shaper, the library it shapes with, is
 * HarfBuzz (`text_layout.hpp`): its `Font` methods, its shaping buffers and
 * `shapeInto`, the one shaping seam.
 */
export class TextLayoutLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "layout",
            ["records"],
        );
        return `#pragma once
#include <bblite/text_layout.hpp>
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
