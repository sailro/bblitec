import { LoweringContext } from "./context.js";
import { lowerTextFunctions } from "./text-records.js";

/**
 * The opt-in weight setter, lowered whole: its validation, identity map,
 * interned group keys, style seam and rollback are the pin's own bodies.
 * The composed variant pipeline is the backends' (`_installTextVariantResolver`).
 */
export class TextWeightLowerer {
    constructor(private readonly context: LoweringContext) {}
    header(): string {
        // The root is what the pin's lazy loader returns; the compiler
        // binds `loadFontWeightOffset()` to the same function.
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "weight",
            ["records", "layout", "update"],
        );
        return `#pragma once
#include <bblite/upstream_text_update.hpp>
#include <iostream>
namespace bbl {
${declarations}
${definitions}
} // namespace bbl
`;
    }
}
