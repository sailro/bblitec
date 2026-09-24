/**
 * The pin's text data as native records, and its bodies lowered over them.
 *
 * `text-data.ts`, `default-text-data.ts`, `glyph-storage.ts`'s disposal and
 * `set-font-weight-offset.ts` are lowered whole by the record lowerer: the
 * run records, draw groups, style palette and slot allocator are the pin's
 * own statements over structs emitted from the pin's own declarations.
 *
 * The platform boundaries, each named by the declaration it replaces:
 *
 *  - `layoutText` is `bbl::layout_text`, lowered separately from the pin's
 *    layout body over HarfBuzz shaping (`text-layout-lowerer.ts`);
 *  - glyph outlines are extracted and packed at generation into the
 *    packaged repertoire every live `Font` carries, so the storage a
 *    `DefaultTextData` creates is fresh records over that repertoire's
 *    bytes (which nothing at run time writes) and the runtime
 *    extraction/update calls have nothing left to add;
 *  - `familyCurveSetId` reads the family name the text shaper answered at
 *    generation;
 *  - the weight variant's resolver installs the native composed pipeline;
 *  - the GPU path's WebGPU objects, engine surface and pipeline cache are
 *    `text-gpu-schema.ts`'s.
 */
import type { LoweringContext } from "./context.js";
import {
    type CallAdapter,
    type MemberSpec,
    PinnedRecordModel,
    type RecordShape,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import { pinnedTypedProgram } from "./pinned-typed-program.js";
import {
    textGpuAdapters,
    textGpuConstants,
    textGpuRecords,
    textGpuUnresolved,
    textGpuValues,
} from "./text-gpu-schema.js";

const TEXT_DATA = "src/text/text-data.ts";
const DEFAULT_TEXT_DATA = "src/text/default-text-data.ts";
const GLYPH_STORAGE = "src/text/glyph-storage.ts";
const WEIGHT = "src/text/set-font-weight-offset.ts";
const LAYOUT = "src/text/layout.ts";

const TEXT_ROOTS = [
    TEXT_DATA,
    DEFAULT_TEXT_DATA,
    GLYPH_STORAGE,
    WEIGHT,
    LAYOUT,
    "src/text/font.ts",
    "src/text/_gpu/text-textures.ts",
    "src/text/_gpu/text-style-gpu.ts",
    "src/text/text-renderable.ts",
    "src/text/text-renderer.ts",
    "src/render/alpha-to-coverage.ts",
] as const;

const TEXT_RENDERABLE = "src/text/text-renderable.ts";
const TEXT_RENDERER = "src/text/text-renderer.ts";
const TEXT_TEXTURES = "src/text/_gpu/text-textures.ts";
const TEXT_STYLE_GPU = "src/text/_gpu/text-style-gpu.ts";
const ALPHA_TO_COVERAGE = "src/render/alpha-to-coverage.ts";

const number: RecordShape = { kind: "number" };
const flag: RecordShape = { kind: "boolean" };

const records: readonly RecordSpec[] = [
    ...textGpuRecords,
    {
        pinned: ["DefaultTextData", "TextData"],
        cpp: "TextDataState",
        handle: "TextData",
        reference: true,
    },
    {
        pinned: ["TextDataDrawGroup"],
        cpp: "TextDataDrawGroup",
        reference: true,
    },
    { pinned: ["RunRecord"], cpp: "RunRecord", reference: true },
    {
        pinned: ["GlyphRun"],
        cpp: "GlyphRun",
        handle: "TextRun",
        reference: true,
    },
    { pinned: ["PlacedGlyph"], cpp: "PlacedGlyph", reference: false },
    { pinned: ["TextDataUpdate"], cpp: "TextDataUpdate", reference: false },
    { pinned: ["TextStyleSeam"], cpp: "TextStyleSeam", reference: true },
    { pinned: ["GlyphStorage"], cpp: "GlyphStorage", reference: true },
    {
        pinned: ["GlyphStorageCurveSet"],
        cpp: "GlyphStorageCurveSet",
        reference: true,
        omit: new Map([
            [
                "_curves",
                "glyph outlines are packed into the atlas at generation; the packaged repertoire carries no CPU outline catalog",
            ],
        ]),
    },
    { pinned: ["SharedAtlas"], cpp: "SharedAtlas", reference: true },
    { pinned: ["AtlasSlot"], cpp: "AtlasSlot", reference: false },
    {
        pinned: ["TextRenderable"],
        cpp: "TextRenderableState",
        handle: "TextRenderable",
        reference: true,
        native: true,
        // The members the GPU path reads; the observable transforms stay
        // the renderable's native state.
        members: new Map<string, MemberSpec>([
            [
                "_gpu",
                {
                    shape: {
                        kind: "optional",
                        value: { kind: "record", name: "TextRenderableGpu" },
                    },
                    field: "gpu",
                },
            ],
            [
                "_data",
                {
                    shape: { kind: "record", name: "DefaultTextData" },
                    field: "data",
                },
            ],
            ["_wmDirty", { shape: flag, field: "wm_dirty" }],
            ["opacity", { shape: number }],
            ["ignoreDepth", { shape: flag, field: "ignore_depth" }],
            [
                "_worldMatrix",
                {
                    shape: {
                        kind: "function",
                        parameters: [],
                        result: { kind: "typed", element: "f32" },
                    },
                    call: (owner) => `bbl::text_world_matrix(*${owner})`,
                },
            ],
        ]),
    },
    {
        pinned: ["TextLayer"],
        cpp: "TextLayerState",
        handle: "TextLayer",
        reference: true,
        native: true,
        omit: new Map([["_kind", "the renderer knows its layers by type"]]),
        members: new Map<string, MemberSpec>([
            ["data", { shape: { kind: "record", name: "DefaultTextData" } }],
            [
                "positionPx",
                { shape: { kind: "record", name: "TextLayerPositionPx" } },
            ],
            ["rotationRad", { shape: number }],
            ["scale", { shape: number }],
            ["order", { shape: number }],
            ["opacity", { shape: number }],
            ["coverageGamma", { shape: number }],
            ["visible", { shape: { kind: "boolean" } }],
            ["_version", { shape: number }],
        ]),
    },
    {
        // A layer's pixel origin, the pin's anonymous `{ x, y }`.
        pinned: ["TextLayerPositionPx"],
        cpp: "Vec2d",
        reference: false,
        native: true,
        members: new Map([
            ["x", { shape: number }],
            ["y", { shape: number }],
        ]),
    },
    {
        pinned: ["TextLayerOptions"],
        cpp: "TextLayerOptions",
        reference: false,
        members: new Map([
            [
                "positionPx",
                {
                    shape: {
                        kind: "optional",
                        value: { kind: "record", name: "TextLayerPositionPx" },
                    },
                },
            ],
        ]),
    },
    {
        pinned: ["TextLayoutOptions"],
        cpp: "TextLayoutOptions",
        reference: false,
    },
    {
        pinned: ["TextLayoutResult"],
        cpp: "TextLayoutResult",
        reference: false,
        returnOf: `${LAYOUT}#layoutText`,
        // The shaper's scale is a number the unresolved library types as any.
        members: new Map([["_pixelsPerFontUnit", { shape: number }]]),
    },
    {
        pinned: ["Font"],
        cpp: "TextLayoutFont",
        reference: true,
        native: true,
        members: new Map([
            [
                "_font",
                {
                    shape: { kind: "record", name: "TextShaperFont" },
                    access: (owner: string) => owner,
                },
            ],
        ]),
    },
    {
        // The text shaper's font: HarfBuzz's face stands in for it.
        pinned: ["TextShaperFont"],
        cpp: "TextLayoutFont",
        reference: true,
        native: true,
        members: new Map([
            [
                "numGlyphs",
                {
                    shape: number,
                    access: (owner: string) => `${owner}->num_glyphs`,
                },
            ],
        ]),
    },
];

const adapters = new Map<string, CallAdapter>([
    [
        `${LAYOUT}#layoutText`,
        {
            cpp: (argument, call) =>
                `bbl::layout_text(*${argument(0)}, ${argument(1)}, ${argument(2)}${call.arguments.length > 3 ? `, ${argument(3)}` : ""})`,
        },
    ],
    ["src/text/glyph-extraction.ts#extractGlyphCurves", { cpp: () => null }],
    [`${GLYPH_STORAGE}#updateGlyphStorage`, { cpp: () => null }],
    [
        `${GLYPH_STORAGE}#createGlyphStorage`,
        {
            cpp: (_argument, _call, local) =>
                `${local("font")}->packaged_storage()`,
        },
    ],
    [
        `${DEFAULT_TEXT_DATA}#familyCurveSetId`,
        { cpp: (argument) => `${argument(0)}->curve_set_id` },
    ],
    [
        "src/text/_gpu/text-pipeline.ts#_installTextVariantResolver",
        { cpp: () => "bbl::text_weight_installed = true" },
    ],
]);

/**
 * The functions generated native code names: the compiler's text
 * intrinsics call these. Every other lowered function, the ones backends
 * call included, lives in its module's detail namespace.
 */
const EXPORTED: ReadonlySet<string> = new Set(
    [
        [TEXT_DATA, "updateTextData"],
        [TEXT_DATA, "disposeTextData"],
        [DEFAULT_TEXT_DATA, "createDefaultTextData"],
        [DEFAULT_TEXT_DATA, "updateDefaultTextData"],
        [DEFAULT_TEXT_DATA, "disposeDefaultTextData"],
        [WEIGHT, "setFontWeightOffset"],
        [TEXT_RENDERABLE, "disposeTextRenderable"],
        [TEXT_RENDERER, "createTextLayer"],
        [TEXT_RENDERER, "setTextLayerPosition"],
        [TEXT_RENDERER, "createTextRenderer"],
        [TEXT_RENDERER, "registerTextRenderer"],
        [ALPHA_TO_COVERAGE, "setAlphaToCoverage"],
        [ALPHA_TO_COVERAGE, "getAlphaToCoverage"],
    ].map(([module, name]) => `${module}#${name}`),
);

/** The text record model over the pinned text modules. */
export function textRecordModel(context: LoweringContext): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        pinnedTypedProgram(context.store, TEXT_ROOTS),
        {
            records,
            values: new Map<string, RecordShape>([
                ...textGpuValues,
                [
                    "TextGroupKey",
                    // A generated group's key is its curve-set id; an
                    // interned styling key exists only at run time.
                    {
                        kind: "native",
                        cpp: "bbl::TextGroupKey",
                        fromString: true,
                    },
                ],
            ]),
            adapters: new Map([...adapters, ...textGpuAdapters]),
            constants: textGpuConstants,
            exported: EXPORTED,
            unresolved: new Map(textGpuUnresolved),
            omittedLocals: new Map([
                [
                    `${DEFAULT_TEXT_DATA}#createDefaultTextData#innerCurves`,
                    "the packaged repertoire already holds every outline",
                ],
                [
                    `${DEFAULT_TEXT_DATA}#updateDefaultTextData#innerCurves`,
                    "the packaged repertoire already holds every outline",
                ],
            ]),
        },
    );
}

/** The records a generated text header declares, in emission order. */
export const TEXT_RECORDS = [
    "SharedAtlasGpu",
    "SharedAtlasGpuResult",
    "TextStyleGpu",
    "TextRenderableGpu",
    "LayerGpu",
    "BindGroupCacheEntry",
    "TextRenderer",
    "TextRendererOptions",
    "TextLayerOptions",
    "TextLayoutOptions",
    "PlacedGlyph",
    "TextLayoutResult",
    "GlyphRun",
    "RunRecord",
    "AtlasSlot",
    "SharedAtlas",
    "GlyphStorageCurveSet",
    "GlyphStorage",
    "TextDataDrawGroup",
    "TextStyleSeam",
    "DefaultTextData",
    "TextDataUpdate",
] as const;

export interface TextFunction {
    module: string;
    name: string;
}

/** The pinned text functions each generated header owns. */
export const TEXT_HEADER_ROOTS: Readonly<
    Record<
        "records" | "update" | "weight" | "gpu" | "renderer" | "coverage",
        readonly TextFunction[]
    >
> = {
    records: [
        { module: TEXT_DATA, name: "disposeTextData" },
        { module: DEFAULT_TEXT_DATA, name: "disposeDefaultTextData" },
        {
            module: "src/text/text-renderable.ts",
            name: "disposeTextRenderable",
        },
    ],
    update: [
        { module: TEXT_DATA, name: "createTextData" },
        { module: TEXT_DATA, name: "updateTextData" },
        { module: DEFAULT_TEXT_DATA, name: "createDefaultTextData" },
        { module: DEFAULT_TEXT_DATA, name: "updateDefaultTextData" },
    ],
    weight: [{ module: WEIGHT, name: "setFontWeightOffset" }],
    gpu: [
        { module: TEXT_TEXTURES, name: "ensureSharedAtlasGpu" },
        { module: TEXT_STYLE_GPU, name: "ensureStyleGpu" },
        { module: TEXT_RENDERABLE, name: "ensureGpu" },
        { module: TEXT_RENDERABLE, name: "updateTextRenderable" },
        { module: TEXT_RENDERABLE, name: "drawTextRenderable" },
    ],
    renderer: [
        { module: TEXT_RENDERER, name: "createTextLayer" },
        { module: TEXT_RENDERER, name: "setTextLayerPosition" },
        { module: TEXT_RENDERER, name: "createTextRenderer" },
        { module: TEXT_RENDERER, name: "registerTextRenderer" },
        { module: TEXT_RENDERER, name: "textRendererUpdate" },
        { module: TEXT_RENDERER, name: "textRendererRecord" },
    ],
    coverage: [
        { module: ALPHA_TO_COVERAGE, name: "setAlphaToCoverage" },
        { module: ALPHA_TO_COVERAGE, name: "getAlphaToCoverage" },
    ],
};

/**
 * One header's lowered text functions: those its roots reach that an
 * earlier header (`after`) has not already emitted.
 */
export function lowerTextFunctions(
    context: LoweringContext,
    header: keyof typeof TEXT_HEADER_ROOTS,
    after: readonly (keyof typeof TEXT_HEADER_ROOTS)[],
): { declarations: string; definitions: string } {
    const earlier = new Set<string>();
    for (const previous of after) {
        const model = textRecordModel(context);
        model.lower(
            TEXT_HEADER_ROOTS[previous].map((root) =>
                model.functionDeclaration(root.module, root.name),
            ),
        );
        for (const key of model.emittedKeys()) earlier.add(key);
    }
    const model = textRecordModel(context);
    return model.lower(
        TEXT_HEADER_ROOTS[header].map((root) =>
            model.functionDeclaration(root.module, root.name),
        ),
        (entry) => !earlier.has(`${entry.module}#${entry.name}`),
    );
}
