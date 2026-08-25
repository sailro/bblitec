/**
 * Lowers the pin's default surface MSAA selection into a header every scene
 * emits.
 *
 * `src/engine/surface.ts` `_buildSurface` decides the frame's sample count
 * once (`options?.msaaSamples === 1 ? 1 : 4`), and the reached slice never
 * takes the 1 arm — an explicit `msaaSamples: 1` refuses at compile. The
 * render plan used to define the emitted `preferred_sample_count()`, which
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
 * The pinned default MSAA selection's non-1 arm — the same read and shape
 * assertion the render plan used to make.
 */
function pinnedSampleCount(context: LoweringContext): number {
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
    return context.numericValue(msaaExpression.whenFalse, file);
}

/** The always-emitted header carrying the pinned sample count. */
export function pinnedSurfaceHeader(context: LoweringContext): string {
    const sampleCount = pinnedSampleCount(context);
    const provenance = context.provenance(surfaceModule, "_buildSurface");
    return `#pragma once

// ${provenance}

#include <cstdint>

namespace bbl::upstream {

/**
 * The pinned default MSAA selection
 * (\`options?.msaaSamples === 1 ? 1 : 4\`): its non-1 arm, which is the
 * sample count every reached scene renders at. Emitted for every scene —
 * an effect-only or sprite-only scene compiles no render plan, but its
 * passes size their targets by the same pinned choice.
 */
inline std::uint32_t preferred_sample_count() {
    return ${sampleCount}u;
}

} // namespace bbl::upstream
`;
}
