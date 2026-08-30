/**
 * The clustered light field's CPU half, folded from its own pinned bodies.
 *
 * `light/clustered.ts` bins every light into screen-space tiles and depth
 * slices once per frame, against the live camera. None of it is a browser
 * API and none of it is fragile: it is fixed arithmetic over a fixed layout,
 * which is the shape the project folds rather than executes. So each helper
 * is lowered from its own declaration and a pin that moves one fails
 * generation instead of drifting.
 */
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    lowerTupleComponents,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

export const clusteredModule = "src/light/clustered.ts";
const spotModule = "src/light/clustered-spot-support.ts";

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
 * The pin's own spot stride, read rather than re-typed.
 *
 * `spotSupport._create` returns an object whose `_stride: 3` is what makes a
 * spot container's light payload three texels wide instead of two -- the
 * number the composed fragment's own `li * 3u` reads back. A pin that changed
 * it would move the layout on both sides, so it is anchored rather than
 * assumed.
 */
export function clusteredSpotStride(context: LoweringContext): number {
    const file = context.sourceFile(spotModule);
    const stride = context.namedPropertyInitializer(file, "_stride");
    if (stride === undefined) {
        context.contractError(
            file,
            `Expected ${spotModule} to declare a _stride.`,
        );
    }
    return context.numericValue(stride, file);
}

/**
 * One pinned scalar helper: the name it has, the name it takes here, and its
 * parameters. All five return a double and all five are `inline`, so the
 * table carries only what differs.
 */
interface ClusteredHelper {
    pinned: string;
    cpp: string;
    parameters: readonly PinnedFunctionParameter[];
}

function number(
    pinned: string,
    cpp: string,
    annotation?: string,
): PinnedFunctionParameter {
    return {
        pinned,
        kind: "number",
        cpp,
        ...(annotation ? { annotation } : {}),
    };
}

/**
 * The arithmetic every cluster assignment is built from.
 *
 * Each is lowered from its own body, so the rounding, the `Math.max(1, …)`
 * clamps, `getSliceIndex`'s `-1` sentinel for a light behind the eye and
 * `projectedSphereEdge`'s two `0.01` floors are the pin's rather than a
 * transcription of them.
 */
const SCALAR_HELPERS: readonly ClusteredHelper[] = [
    {
        pinned: "textureElementCount",
        cpp: "texture_element_count",
        parameters: [
            number("texels", "texels"),
            number("components", "components"),
            number("dataTextureWidth", "data_texture_width"),
        ],
    },
    {
        pinned: "getSliceIndex",
        cpp: "slice_index",
        parameters: [
            number("depth", "depth"),
            number("sliceScale", "slice_scale"),
            number("sliceBias", "slice_bias"),
        ],
    },
    {
        pinned: "clampInt",
        cpp: "clamp_int",
        parameters: [
            number("v", "v"),
            number("min", "lo"),
            number("max", "hi"),
        ],
    },
    {
        pinned: "projectedSphereEdge",
        cpp: "projected_sphere_edge",
        parameters: [
            number("axis", "axis"),
            number("depth", "depth"),
            number("rangeSq", "range_sq"),
            number("projectionScale", "projection_scale"),
            // The pin narrows this one for its callers; it is a plain number
            // to the arithmetic, and the annotation is what proves the pin
            // still spells it that way.
            number("side", "side", "-1 | 1"),
        ],
    },
    {
        pinned: "viewZ",
        cpp: "clustered_view_z",
        parameters: [
            {
                pinned: "position",
                kind: "record",
                cpp: "position",
                annotation: "readonly [number, number, number]",
                cppType: "std::array<double, 3>",
                binding: { cpp: "position", type: "f64-buffer" },
            },
            { pinned: "view", kind: "numberArray", cpp: "view" },
        ],
    },
];

/** Each helper's own C++ spelling, so a body may call its siblings. */
function clusteredCalls(): Map<
    string,
    (args: readonly string[]) => string
> {
    return new Map<string, (args: readonly string[]) => string>([
        ...pinnedNumericMathCalls(),
        ...SCALAR_HELPERS.map(
            ({ pinned, cpp }): [
                string,
                (args: readonly string[]) => string,
            ] => [
                pinned,
                (args: readonly string[]) => `${cpp}(${args.join(", ")})`,
            ],
        ),
        [
            "projectedSphereBounds",
            (args: readonly string[]) =>
                `projected_sphere_bounds(${args.join(", ")})`,
        ],
    ]);
}

/** The five scalar helpers, each lowered from its own declaration. */
export function clusteredScalarHelpers(context: LoweringContext): string {
    const calls = clusteredCalls();
    return SCALAR_HELPERS.map(({ pinned, cpp, parameters }) =>
        lowerPinnedFunction(context, clusteredModule, pinned, parameters, {
            cppName: cpp,
            returns: "double",
            inline: true,
            calls,
        })
    ).join("\n\n");
}

/**
 * `projectedSphereBounds`: a light's sphere projected to a tile rectangle.
 *
 * The whole cull is here, and both of its arms are the pin's. Under a
 * perspective projection the silhouette is found by rotating the view vector
 * to the sphere's tangent (`projectedSphereEdge`); under an orthographic one
 * the sphere maps to a box of its own radius, offset by the projection
 * translation. Which arm runs is `proj[11] === 0`, a projection-agnostic
 * discriminator the pin chose so the cull needs no coupling to the camera
 * module -- and it is folded, not restated, so a pin that changes the test
 * changes what is emitted.
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
            number("vx", "vx"),
            number("vy", "vy"),
            number("vz", "vz"),
            number("range", "range"),
            { pinned: "proj", kind: "numberArray", cpp: "proj" },
            number("tileCountX", "tile_count_x"),
            number("tileCountY", "tile_count_y"),
        ],
        {
            cppName: "projected_sphere_bounds",
            inline: true,
            calls: clusteredCalls(),
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
 * from `getSliceIndex`, the early-out for a sphere outside the frustum's
 * depth range, the per-slice running `min`/`max` light range, and the
 * `(x * tileCountY + y) * batchCount + batch` mask index with its
 * `1 << (lightIndex % 32)` bit. Every one of those is a layout the fragment
 * reads back, so a pin that moves one has to move both sides together, and
 * folding is what makes it.
 */
export function clusteredAddLightToClusters(
    context: LoweringContext,
): string {
    return lowerPinnedFunction(
        context,
        clusteredModule,
        "addLightToClusters",
        [
            { pinned: "sliceData", kind: "u32Buffer", cpp: "slice_data" },
            { pinned: "maskData", kind: "u32Buffer", cpp: "mask_data" },
            {
                pinned: "light",
                kind: "record",
                cpp: "light",
                annotation: "ClusteredPointLight",
                cppType: "ClusteredLight",
                binding: { cpp: "light", type: "scalar" },
            },
            number("viewDepth", "view_depth"),
            number("lightIndex", "light_index"),
            { pinned: "view", kind: "numberArray", cpp: "view" },
            { pinned: "proj", kind: "numberArray", cpp: "proj" },
            number("tileCountX", "tile_count_x"),
            number("tileCountY", "tile_count_y"),
            number("zSlices", "z_slices"),
            number("sliceScale", "slice_scale"),
            number("sliceBias", "slice_bias"),
            number("batchCount", "batch_count"),
        ],
        {
            cppName: "add_light_to_clusters",
            returns: "void",
            inline: true,
            // `lastSlice < 0 || firstSlice >= zSlices` is a test, not the
            // value-selecting `||` the translator refuses by default: both
            // sides are comparisons, so the C++ operator is the same answer.
            booleanOr: true,
            calls: clusteredCalls(),
            // Its own sibling returns four tile indices the body then
            // indexes; declaring the arity is what keeps that a fixed array
            // rather than an allocation per light per frame.
            fixedTupleCalls: new Map([["projectedSphereBounds", 4]]),
            // The two members the body reads off the light record, bound by
            // the text it reads them through.
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "light.position",
                    { cpp: "light.position", type: "f64-buffer" },
                ],
                ["light.range", { cpp: "light.range", type: "scalar" }],
            ]),
        },
    );
}
