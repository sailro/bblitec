/**
 * The clustered light field's CPU half, folded from its own pinned bodies.
 *
 * `light/clustered.ts` bins every light into screen-space tiles and depth
 * slices once per frame, against the live camera. None of it is a browser
 * API and none of it is fragile: it is fixed arithmetic over a fixed layout,
 * which is the shape the project folds rather than executes. So each helper
 * is lowered from its own declaration and a pin that moves one fails
 * generation instead of drifting.
 *
 * The functions divide by what they touch. These five are pure scalar
 * arithmetic and lower whole; the two that write the slice and mask arrays
 * are emitted around them.
 */
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const clusteredModule = "src/light/clustered.ts";

/** The pin's own `MAX_DATA_TEXTURE_WIDTH`, `CLUSTER_BATCH_SIZE` and friends. */
export function clusteredConstants(context: LoweringContext): string {
    const file = context.sourceFile(clusteredModule);
    const constant = (name: string): number => {
        const declared = context.moduleScopeConstant(file, name);
        if (!declared) {
            context.contractError(
                file,
                `Expected ${clusteredModule} to declare ${name}.`,
            );
        }
        return context.numericValue(declared, file);
    };
    return `// ${context.provenance(clusteredModule, "constants")}
// The pin's own cluster constants. A batch is one 32-bit mask word, which is
// why the fragment's extractBits window is 32 wide.
inline constexpr std::uint32_t kClusterBatchSize =
    ${constant("CLUSTER_BATCH_SIZE")}u;
inline constexpr std::uint32_t kMaxDataTextureWidth =
    ${constant("MAX_DATA_TEXTURE_WIDTH")}u;
inline constexpr std::uint32_t kEmptySliceFirst =
    ${constant("EMPTY_SLICE_FIRST")}u;`;
}

/**
 * `textureElementCount`, `getSliceIndex`, `clampInt` and
 * `projectedSphereEdge`: the scalar arithmetic the binning is built from.
 *
 * Each is lowered from its own body, so the rounding, the `Math.max(1, …)`
 * clamps and `projectedSphereEdge`'s `0.01` guards are the pin's rather than
 * a transcription of them.
 */
export function clusteredScalarHelpers(context: LoweringContext): string {
    const calls = pinnedNumericMathCalls();
    const textureElementCount = lowerPinnedFunction(
        context,
        clusteredModule,
        "textureElementCount",
        [
            { pinned: "texels", kind: "number", cpp: "texels" },
            { pinned: "components", kind: "number", cpp: "components" },
            {
                pinned: "dataTextureWidth",
                kind: "number",
                cpp: "data_texture_width",
            },
        ],
        {
            cppName: "texture_element_count",
            returns: "double",
            inline: true,
            calls,
        },
    );
    const getSliceIndex = lowerPinnedFunction(
        context,
        clusteredModule,
        "getSliceIndex",
        [
            { pinned: "depth", kind: "number", cpp: "depth" },
            { pinned: "sliceScale", kind: "number", cpp: "slice_scale" },
            { pinned: "sliceBias", kind: "number", cpp: "slice_bias" },
        ],
        {
            cppName: "slice_index",
            returns: "double",
            inline: true,
            calls,
        },
    );
    const clampInt = lowerPinnedFunction(
        context,
        clusteredModule,
        "clampInt",
        [
            { pinned: "v", kind: "number", cpp: "v" },
            { pinned: "min", kind: "number", cpp: "lo" },
            { pinned: "max", kind: "number", cpp: "hi" },
        ],
        {
            cppName: "clamp_int",
            returns: "double",
            inline: true,
            calls,
        },
    );
    const projectedSphereEdge = lowerPinnedFunction(
        context,
        clusteredModule,
        "projectedSphereEdge",
        [
            { pinned: "axis", kind: "number", cpp: "axis" },
            { pinned: "depth", kind: "number", cpp: "depth" },
            { pinned: "rangeSq", kind: "number", cpp: "range_sq" },
            {
                pinned: "projectionScale",
                kind: "number",
                cpp: "projection_scale",
            },
            { pinned: "side", kind: "signChoice", cpp: "side" },
        ],
        {
            cppName: "projected_sphere_edge",
            returns: "double",
            inline: true,
            calls,
        },
    );
    return [
        textureElementCount,
        getSliceIndex,
        clampInt,
        projectedSphereEdge,
    ].join("\n\n");
}
