import type { LoweringContext } from "./context.js";
import { assertDeferredSceneRenderables } from "./scene-deferred.js";
import { lowerTextFunctions } from "./text-records.js";

/**
 * The pin's text entities, lowered whole: the alpha-to-coverage membership
 * every text scene carries, and the scene renderable -- its factory, its
 * observable transforms, Euler proxy and world-matrix state, its binding
 * and its scene attachment -- as the pin's own closures and classes.
 */
export class TextLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /** `upstream_text.hpp`: alpha-to-coverage membership. */
    public header(): string {
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "coverage",
            ["records"],
        );
        return `#pragma once
#include <bblite/upstream_text_records.hpp>
namespace bbl {
${declarations}
${definitions}
} // namespace bbl
`;
    }

    /** `upstream_text_renderable.hpp`: the scene renderable. */
    public renderableHeader(): string {
        assertDeferredSceneRenderables(this.context);
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "renderable",
            ["records", "gpu"],
        );
        return `#pragma once
#include <bblite/upstream_text_gpu.hpp>
#include <cmath>
namespace bbl {
${declarations}
${definitions}
} // namespace bbl
`;
    }
}
