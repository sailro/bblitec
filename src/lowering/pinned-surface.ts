/**
 * Lowers the pin's default surface MSAA selection into a header every scene
 * emits.
 *
 * `src/engine/surface.ts` `_buildSurface` decides the frame's sample count
 * once (`options?.msaaSamples === 1 ? 1 : 4`). The compiler folds the scene's
 * engine option and selects one of those two pinned arms. The render plan
 * used to define the emitted `preferred_sample_count()`, which
 * left an effect-only or sprite-only scene — one that compiles no render
 * plan — with nothing generated carrying the value, and the effect drivers
 * re-typing the 4 per backend. The one derivation lives here now, in the
 * always-present generated set beside the depth convention, as an inline
 * definition so every scene shape gets exactly one.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";

const surfaceModule = "src/engine/surface.ts";

/**
 * Both arms of the pinned MSAA selection, with the same read and shape
 * assertion the render plan used to make.
 */
function pinnedSampleCounts(context: LoweringContext): readonly [number, number] {
    const { file, declaration } = context.functionDeclaration(
        surfaceModule,
        "_buildSurface",
    );
    const msaaExpression = context.unwrapExpression(
        context.variableInitializer(declaration, "msaaSamples"),
    );
    context.assertExpressionShape(
        msaaExpression,
        "options?.msaaSamples === 1 ? 1 : 4",
        "Default MSAA selection",
    );
    if (!ts.isConditionalExpression(msaaExpression)) {
        context.contractError(
            msaaExpression,
            "Expected conditional MSAA selection.",
        );
    }
    return [
        context.numericValue(msaaExpression.whenTrue, file),
        context.numericValue(msaaExpression.whenFalse, file),
    ];
}

/** The always-emitted header carrying the selected pinned sample count. */
export function pinnedSurfaceHeader(
    context: LoweringContext,
    sampleCount: 1 | 4 = 4,
): string {
    const [singleSampleCount, defaultSampleCount] =
        pinnedSampleCounts(context);
    if (
        sampleCount !== singleSampleCount &&
        sampleCount !== defaultSampleCount
    ) {
        context.contractError(
            context.sourceFile(surfaceModule),
            `Surface sample count ${sampleCount} is not one of the pinned selections ${singleSampleCount} or ${defaultSampleCount}.`,
        );
    }
    const provenance = context.provenance(surfaceModule, "_buildSurface");
    return `#pragma once

// ${provenance}

#include <cstdint>

namespace bbl::upstream {

/**
 * The pinned MSAA selection
 * (\`options?.msaaSamples === 1 ? 1 : 4\`): the statically selected arm,
 * which is the sample count every reached scene renders at. Emitted for every scene —
 * an effect-only or sprite-only scene compiles no render plan, but its
 * passes size their targets by the same pinned choice.
 */
inline std::uint32_t preferred_sample_count() {
    return ${sampleCount}u;
}

} // namespace bbl::upstream
`;
}
