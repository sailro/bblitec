/**
 * Lowers the pin's own depth convention into a header both backends execute.
 *
 * `src/engine/render-target.ts` names one compare — `REVERSE_DEPTH_COMPARE` —
 * and every pinned family defaults to it, so the value belongs to the pin and
 * not to this port. Typing it into the PALs would agree with the pin only
 * until the next bump; reading it here means a pin that changes it changes
 * what we emit, and a spelling this runtime has no enumerator for fails
 * generation rather than silently picking a neighbour.
 *
 * That is the same contract `pinned-blend-table.ts` holds for the pin's blend
 * factors, and it is what the projection half of this convention already gets
 * from `assertPinnedPerspectiveWriter`.
 */
import type { LoweringContext } from "./context.js";

/**
 * The `GPUCompareFunction` spellings this runtime has an enumerator for. The
 * pin can name any of them; the ones outside the reached slice cost nothing
 * to carry and mean a pin that starts using one still generates.
 */
const compareEnumerators: Readonly<Record<string, string>> = {
    never: "never",
    less: "less",
    equal: "equal",
    "less-equal": "less_equal",
    greater: "greater",
    "not-equal": "not_equal",
    "greater-equal": "greater_equal",
    always: "always",
};

/** A WebGPU compare function as this runtime's own enumerator. */
export function nativeDepthCompare(compare: string): string {
    const mapped = compareEnumerators[compare];
    if (!mapped) {
        throw new Error(
            `Pinned depth uses compare '${compare}', which this runtime ` +
                "has no enumerator for.",
        );
    }
    return mapped;
}

const renderTargetModule = "src/engine/render-target.ts";

/**
 * The pin's reverse-depth compare, read from its own declaration.
 *
 * Emitted for every scene: a sprite-only scene registers no SceneContext and
 * so has no render plan, but its billboard pass still draws under the same
 * convention.
 */
export function pinnedDepthStateHeader(context: LoweringContext): string {
    const file = context.sourceFile(renderTargetModule);
    const compare = context.stringValue(
        context.variableInitializer(file, "REVERSE_DEPTH_COMPARE"),
        file,
    );
    const provenance = context.provenance(
        renderTargetModule,
        "REVERSE_DEPTH_COMPARE",
    );
    return `#pragma once

// ${provenance}

#include <bblite/runtime.hpp>

namespace bbl::upstream {

/**
 * The depth compare every pinned family defaults to.
 *
 * \`createDefaultPipelineDescriptor\` and each family's pipeline builder read
 * \`sig._depthCompare ?? REVERSE_DEPTH_COMPARE\`, so this is the compare a
 * draw carries unless its own signature names another. The pin's shadow
 * targets do name another (\`less-equal\`, standard-Z), which is why this is
 * the reached slice's convention rather than the library's only one.
 *
 * The matching projection is \`mat4PerspectiveLHToRef\`, which maps near to 1
 * and far to 0; \`build_projection\` in the render plan writes those rows and
 * \`assertPinnedPerspectiveWriter\` anchors them term by term.
 */
inline constexpr DepthCompare pinned_depth_compare =
    DepthCompare::${nativeDepthCompare(compare)};

/** The far plane under that convention, which is what a pass clears to. */
inline constexpr float pinned_depth_clear = 0.0f;

} // namespace bbl::upstream
`;
}
