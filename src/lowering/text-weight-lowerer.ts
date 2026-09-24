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
        // The lazy loader's value is the setter this header lowers; the
        // compiler binds `loadFontWeightOffset()` to it.
        this.context.assertFunctionBodyShape(
            this.context.functionDeclaration(
                "src/text/load-font-weight-offset.ts",
                "loadFontWeightOffset",
            ).declaration,
            '{return (await import("./set-font-weight-offset.js")).setFontWeightOffset;}',
            "Text weight lazy setter export",
        );
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "weight",
            ["records", "update"],
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
