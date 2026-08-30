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
import {
    lowerPinnedFunction,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

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

/**
 * `projectedSphereBounds`: a light's sphere projected to a tile rectangle.
 *
 * The whole cull is here, and both of its arms are the pin's. Under a
 * perspective projection the silhouette is found by rotating the view vector
 * to the sphere's tangent (`projectedSphereEdge` above); under an
 * orthographic one the sphere maps to a box of its own radius, offset by the
 * projection translation. Which arm runs is `proj[11] === 0`, a
 * projection-agnostic discriminator the pin chose so the cull needs no
 * coupling to the camera module -- and it is folded, not restated, so a pin
 * that changes the test changes what is emitted.
 *
 * The returned rectangle is inclusive tile indices, already widened by one
 * tile on each side and clamped, which is why it comes back as four
 * `clamp_int` calls rather than four floats.
 */
export function clusteredProjectedBounds(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        clusteredModule,
        "projectedSphereBounds",
        [
            { pinned: "vx", kind: "number", cpp: "vx" },
            { pinned: "vy", kind: "number", cpp: "vy" },
            { pinned: "vz", kind: "number", cpp: "vz" },
            { pinned: "range", kind: "number", cpp: "range" },
            { pinned: "proj", kind: "numberArray", cpp: "proj" },
            { pinned: "tileCountX", kind: "number", cpp: "tile_count_x" },
            { pinned: "tileCountY", kind: "number", cpp: "tile_count_y" },
        ],
        {
            cppName: "projected_sphere_bounds",
            // Its own sibling, already emitted above.
            calls: new Map([
                ...pinnedNumericMathCalls(),
                [
                    "projectedSphereEdge",
                    (args: readonly string[]) =>
                        `projected_sphere_edge(${args.join(", ")})`,
                ],
                [
                    "clampInt",
                    (args: readonly string[]) =>
                        `clamp_int(${args.join(", ")})`,
                ],
            ]),
            returns: {
                type: "std::array<double, 4>",
                value: (lowerer, expression) => {
                    const [minX, maxX, minY, maxY] = lowerTupleComponents(
                        context,
                        lowerer,
                        expression,
                        {
                            arity: 4,
                            at: context.functionDeclaration(
                                clusteredModule,
                                "projectedSphereBounds",
                            ).declaration,
                        },
                    );
                    return `std::array<double, 4>{${minX}, ${maxX}, ` +
                        `${minY}, ${maxY}}`;
                },
            },
        },
    );
}

/**
 * `addLightToClusters`: one light's sphere written into the slice range and
 * the tile mask.
 *
 * The whole assignment folds -- the view-space centre, the near and far slice
 * from `getSliceIndex`, the early-out for a sphere entirely outside the
 * frustum's depth, the per-slice `min`/`max` running range, and the
 * `(x * tileCountY + y) * batchCount + batch` mask index with its
 * `1 << (lightIndex % 32)` bit. Every one of those is a layout the fragment
 * reads back, so a pin that moves one has to move both sides together, and
 * folding is what makes it.
 *
 * The `light` parameter binds as the native record: the body reads only its
 * `position` and its `range`, which is what `ClusteredLight` carries.
 */
export function clusteredAddLightToClusters(
    context: LoweringContext,
): string {
    return lowerPinnedFunction(
        context,
        clusteredModule,
        "addLightToClusters",
        [
            {
                pinned: "sliceData",
                kind: "u32Buffer",
                cpp: "slice_data",
            },
            { pinned: "maskData", kind: "u32Buffer", cpp: "mask_data" },
            {
                pinned: "light",
                kind: "record",
                cpp: "light",
                annotation: "ClusteredPointLight",
                binding: { cpp: "light", type: "scalar" },
            },
            { pinned: "viewDepth", kind: "number", cpp: "view_depth" },
            { pinned: "lightIndex", kind: "number", cpp: "light_index" },
            { pinned: "view", kind: "numberArray", cpp: "view" },
            { pinned: "proj", kind: "numberArray", cpp: "proj" },
            { pinned: "tileCountX", kind: "number", cpp: "tile_count_x" },
            { pinned: "tileCountY", kind: "number", cpp: "tile_count_y" },
            { pinned: "zSlices", kind: "number", cpp: "z_slices" },
            { pinned: "sliceScale", kind: "number", cpp: "slice_scale" },
            { pinned: "sliceBias", kind: "number", cpp: "slice_bias" },
            { pinned: "batchCount", kind: "number", cpp: "batch_count" },
        ],
        {
            cppName: "add_light_to_clusters",
            returns: "void",
            // The two members the body reads off the light record, bound by
            // the text it reads them through. `ClusteredLight` is the native
            // row, so `position` is three doubles it indexes and `range` is
            // the scalar the sphere is culled at.
            // Its own sibling returns four tile indices the body then
            // indexes; declaring the arity is what keeps that a fixed array
            // rather than an allocation per light per frame.
            fixedTupleCalls: new Map([["projectedSphereBounds", 4]]),
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "light.position",
                    { cpp: "light.position", type: "f64-buffer" },
                ],
                ["light.range", { cpp: "light.range", type: "scalar" }],
            ]),
            calls: new Map([
                ...pinnedNumericMathCalls(),
                [
                    "getSliceIndex",
                    (args: readonly string[]) =>
                        `slice_index(${args.join(", ")})`,
                ],
                [
                    "clampInt",
                    (args: readonly string[]) =>
                        `clamp_int(${args.join(", ")})`,
                ],
                [
                    "projectedSphereBounds",
                    (args: readonly string[]) =>
                        `projected_sphere_bounds(${args.join(", ")})`,
                ],
            ]),
        },
    );
}
