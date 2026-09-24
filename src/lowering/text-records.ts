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
 *  - text-shaper, the library `layoutText` shapes with, is HarfBuzz: its
 *    `Font` methods, its `UnicodeBuffer` and `GlyphBuffer` and its
 *    `shapeInto` are native (`text_layout.hpp`);
 *  - glyph outlines are extracted and packed at generation into the
 *    packaged repertoire every live `Font` carries, so the storage a
 *    `DefaultTextData` creates is fresh records over that repertoire's
 *    bytes (which nothing at run time writes) and the runtime
 *    extraction/update calls have nothing left to add;
 *  - `familyCurveSetId` reads the family name the text shaper answered at
 *    generation;
 *  - the weight variant's resolver installs the native composed pipeline;
 *  - the GPU path's WebGPU objects, engine surface and pipeline cache are
 *    `text-gpu-schema.ts`'s;
 *  - the scene is the native runtime's: `addDeferredSceneRenderables` is its
 *    deferred-builder queue;
 *  - types from type-only modules the source maps do not carry (`Vec3`,
 *    `IWorldMatrixProvider`, `DrawBinding`, `Renderable`'s members) are
 *    typed here.
 *
 * The text renderable is the pin's own: its factory, its observable
 * transforms (`ObservableVec3`/`ObservableQuat`), Euler proxy, world-matrix
 * state, binding and attachment are lowered as the pin's classes and
 * closures.
 */
import ts from "typescript";
import { type LoweringContext, sharedPinnedContext } from "./context.js";
import {
    type CallAdapter,
    type MemberSpec,
    type PinnedCallable,
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
const LOAD_WEIGHT = "src/text/load-font-weight-offset.ts";

const TEXT_ROOTS = [
    TEXT_DATA,
    DEFAULT_TEXT_DATA,
    GLYPH_STORAGE,
    WEIGHT,
    LAYOUT,
    LOAD_WEIGHT,
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

const OBSERVABLE_VEC3 = "src/math/observable-vec3.ts";
const OBSERVABLE_QUAT = "src/math/observable-quat.ts";
const SCENE_CORE = "src/scene/scene-core.ts";

const number: RecordShape = { kind: "number" };
const flag: RecordShape = { kind: "boolean" };
const optionalVec3: RecordShape = {
    kind: "optional",
    value: { kind: "record", name: "Vec3" },
};

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
        omit: new Map([
            [
                "_entityType",
                "a literal tag; the native scene keeps text renderables in their own list",
            ],
        ]),
        // `Renderable` (render/renderable.ts) is type-only.
        erased: new Map<string, MemberSpec>([
            ["isTransparent", { shape: flag }],
            [
                "bind",
                {
                    shape: {
                        kind: "function",
                        parameters: [
                            { kind: "record", name: "EngineContext" },
                            { kind: "record", name: "RenderTargetSignature" },
                        ],
                        result: { kind: "record", name: "DrawBinding" },
                    },
                },
            ],
        ]),
    },
    {
        pinned: ["ObservableVec3"],
        cpp: "ObservableVec3",
        reference: true,
    },
    {
        pinned: ["ObservableQuat"],
        cpp: "ObservableQuat",
        reference: true,
    },
    {
        pinned: ["EulerProxy"],
        cpp: "EulerProxy",
        reference: true,
        accessors: new Set(["x", "y", "z"]),
    },
    {
        pinned: ["WorldMatrixAccessors"],
        cpp: "WorldMatrixAccessors",
        reference: true,
        omit: new Map([
            [
                "parent",
                "a text renderable's world state is never parented; its setter tags hosts through a symbol-keyed property",
            ],
        ]),
    },
    {
        // `parentable.ts` is type-only; a text renderable's world state
        // never parents, so nothing the lowered program runs builds one.
        pinned: ["IWorldMatrixProvider"],
        cpp: "WorldMatrixProvider",
        reference: true,
        native: true,
        members: new Map([
            ["worldMatrix", { shape: { kind: "typed", element: "f32" } }],
            ["worldMatrixVersion", { shape: number }],
        ]),
    },
    {
        // `render/renderable.ts` is type-only: the binding `bind` returns.
        pinned: ["DrawBinding"],
        cpp: "TextDrawBinding",
        handle: "TextDrawBindingHandle",
        reference: true,
        native: true,
        members: new Map<string, MemberSpec>([
            [
                "renderable",
                { shape: { kind: "record", name: "TextRenderable" } },
            ],
            [
                "pipeline",
                {
                    shape: {
                        kind: "native",
                        cpp: "bbl::TextGpuHandle",
                        nullable: true,
                    },
                },
            ],
            [
                "draw",
                {
                    shape: {
                        kind: "function",
                        parameters: [
                            { kind: "record", name: "GPURenderPassEncoder" },
                            { kind: "record", name: "EngineContext" },
                        ],
                        result: number,
                    },
                },
            ],
            [
                "update",
                {
                    shape: {
                        kind: "function",
                        parameters: [
                            { kind: "record", name: "DrawUpdateContext" },
                        ],
                        result: { kind: "void" },
                    },
                },
            ],
        ]),
    },
    {
        pinned: ["TextRenderableOptions"],
        cpp: "TextRenderableOptions",
        reference: false,
        // `Readonly<Vec3>`: `math/types.ts` is type-only.
        members: new Map([
            ["position", { shape: optionalVec3 }],
            ["scaling", { shape: optionalVec3 }],
        ]),
    },
    {
        pinned: ["TextQuaternion"],
        cpp: "TextQuaternion",
        reference: false,
        typeOf: `${TEXT_RENDERABLE}#TextRenderableOptions.rotationQuaternion`,
    },
    {
        // `math/types.ts` is type-only; its `Vec3` is three numbers.
        pinned: ["Vec3"],
        cpp: "Vec3d",
        reference: false,
        native: true,
        members: new Map([
            ["x", { shape: number }],
            ["y", { shape: number }],
            ["z", { shape: number }],
        ]),
    },
    {
        pinned: ["DeferredSceneRenderables"],
        cpp: "DeferredSceneRenderables",
        reference: false,
        // `Renderable` is type-only; the ones text builds are text renderables.
        members: new Map([
            [
                "renderables",
                {
                    shape: {
                        kind: "array",
                        element: { kind: "record", name: "TextRenderable" },
                    },
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
        members: new Map<string, MemberSpec>([
            [
                "numGlyphs",
                {
                    shape: number,
                    access: (owner: string) => `${owner}->num_glyphs`,
                },
            ],
            [
                "scaleForSize",
                {
                    shape: {
                        kind: "function",
                        parameters: [number],
                        result: number,
                    },
                    call: (owner, [size]) =>
                        `bbl::text_scale_for_size(*${owner}, ${size})`,
                },
            ],
            [
                "glyphId",
                {
                    shape: {
                        kind: "function",
                        parameters: [number],
                        result: number,
                    },
                    call: (owner, [codepoint]) =>
                        `bbl::pal::text_glyph_id(*${owner}, ${codepoint})`,
                },
            ],
        ]),
    },
    { pinned: ["LayoutGlyph"], cpp: "LayoutGlyph", reference: false },
    {
        // text-shaper's `UnicodeBuffer`: the codepoints `shapeInto` shapes.
        pinned: ["TextShapeInput"],
        cpp: "TextShapeInput",
        reference: true,
        native: true,
        members: new Map<string, MemberSpec>([
            [
                "length",
                {
                    shape: number,
                    access: (owner: string) =>
                        `static_cast<double>(${owner}->codepoints.size())`,
                },
            ],
            [
                "clear",
                {
                    shape: {
                        kind: "function",
                        parameters: [],
                        result: { kind: "void" },
                    },
                    call: (owner) => `${owner}->clear()`,
                },
            ],
            [
                "addStr",
                {
                    shape: {
                        kind: "function",
                        parameters: [{ kind: "string" }, number],
                        result: { kind: "void" },
                    },
                    call: (owner, [text, cluster]) =>
                        `${owner}->add_str(${text}, ${cluster})`,
                },
            ],
        ]),
    },
    {
        // text-shaper's `GlyphBuffer`: the glyphs `shapeInto` wrote.
        pinned: ["TextShapeOutput"],
        cpp: "TextShapeOutput",
        reference: true,
        native: true,
        members: new Map([
            [
                "infos",
                {
                    shape: {
                        kind: "array",
                        element: { kind: "record", name: "TextShapeInfo" },
                    },
                },
            ],
            [
                "positions",
                {
                    shape: {
                        kind: "array",
                        element: { kind: "record", name: "TextShapePosition" },
                    },
                },
            ],
        ]),
    },
    {
        pinned: ["TextShapeInfo"],
        cpp: "TextShapeInfo",
        reference: false,
        native: true,
        members: new Map([
            ["glyphId", { shape: number }],
            ["codepoint", { shape: number }],
            ["cluster", { shape: number }],
        ]),
    },
    {
        pinned: ["TextShapePosition"],
        cpp: "TextShapePosition",
        reference: false,
        native: true,
        members: new Map([
            ["xAdvance", { shape: number }],
            ["xOffset", { shape: number }],
            ["yOffset", { shape: number }],
        ]),
    },
];

const adapters = new Map<string, CallAdapter>([
    [
        // The one shaping seam: text-shaper's shaping pass is HarfBuzz's.
        "text-shaper#shapeInto",
        {
            cpp: (argument) =>
                `bbl::pal::text_shape(*${argument(0)}, *${argument(1)}, *${argument(2)})`,
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
    [
        // The scene is the native runtime's: its deferred-builder queue
        // runs the pin's builder after construction, publishes the text
        // renderables it built and adopts its disposer
        // (`assertDeferredSceneRenderables` holds the queue to the pin).
        `${SCENE_CORE}#addDeferredSceneRenderables`,
        {
            cpp: (argument) =>
                `bbl::add_deferred_text_renderables(${argument(0)}, ${argument(1)})`,
            // The native queue calls the builder without the engine and
            // scene the pin passes; a builder that declares them refuses.
            parameters: [
                undefined,
                {
                    kind: "function",
                    parameters: [],
                    result: {
                        kind: "record",
                        name: "DeferredSceneRenderables",
                    },
                },
            ],
        },
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
        [LAYOUT, "layoutText"],
        [TEXT_RENDERABLE, "disposeTextRenderable"],
        [TEXT_RENDERABLE, "createTextRenderable"],
        [TEXT_RENDERABLE, "addTextRenderable"],
        // The compiler spells a text renderable's transform writes as the
        // pin's own accessors and setters.
        [OBSERVABLE_VEC3, "ObservableVec3.x"],
        [OBSERVABLE_VEC3, "ObservableVec3.y"],
        [OBSERVABLE_VEC3, "ObservableVec3.z"],
        [OBSERVABLE_VEC3, "ObservableVec3.set"],
        [OBSERVABLE_QUAT, "ObservableQuat.x"],
        [OBSERVABLE_QUAT, "ObservableQuat.y"],
        [OBSERVABLE_QUAT, "ObservableQuat.z"],
        [OBSERVABLE_QUAT, "ObservableQuat.w"],
        [OBSERVABLE_QUAT, "ObservableQuat.set"],
        [TEXT_RENDERER, "createTextLayer"],
        [TEXT_RENDERER, "setTextLayerPosition"],
        [TEXT_RENDERER, "createTextRenderer"],
        [TEXT_RENDERER, "registerTextRenderer"],
        [ALPHA_TO_COVERAGE, "setAlphaToCoverage"],
        [ALPHA_TO_COVERAGE, "getAlphaToCoverage"],
    ].map(([module, name]) => `${module}#${name}`),
);

let sharedModel: PinnedRecordModel | undefined;

/**
 * The text record model over the shared pinned store: the compiler spells
 * a text entity's member reads, writes and calls through it, so they are
 * the lowered records' own (a transform lane is its pinned accessor).
 */
export function sharedTextRecordModel(): PinnedRecordModel {
    return (sharedModel ??= textRecordModel(sharedPinnedContext()));
}

/** The text record model over the pinned text modules. */
export function textRecordModel(context: LoweringContext): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        pinnedTypedProgram(context.store, TEXT_ROOTS),
        {
            records,
            values: new Map<string, RecordShape>([
                ...textGpuValues,
                // The scene is the native runtime's, passed by reference.
                ["SceneContext", { kind: "native", cpp: "bbl::Scene&" }],
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
            unresolved: new Map([
                ...textGpuUnresolved,
                [
                    "IWorldMatrixProvider",
                    { kind: "record", name: "IWorldMatrixProvider" },
                ],
                ["DrawBinding", { kind: "record", name: "DrawBinding" }],
                // text-shaper is bundled, so its types are erased.
                ["UnicodeBuffer", { kind: "record", name: "TextShapeInput" }],
                ["GlyphBuffer", { kind: "record", name: "TextShapeOutput" }],
            ]),
            moduleValues: new Map([
                [
                    // The weight variant's resolver is installed natively
                    // (`_installTextVariantResolver`); its presence is the flag.
                    "src/text/_gpu/text-pipeline.ts#_textVariantResolver",
                    { shape: flag, cpp: "bbl::text_weight_installed" },
                ],
            ]),
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
    "TextRenderable",
    "ObservableVec3",
    "ObservableQuat",
    "EulerProxy",
    "WorldMatrixAccessors",
    "TextQuaternion",
    "TextRenderableOptions",
    "DeferredSceneRenderables",
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
    "LayoutGlyph",
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
    /** A class member of `name`, the class. */
    member?: { name: string; kind: "method" | "get" | "set" };
    /** `name` is a lazy loader: the root is the export it returns. */
    lazy?: true;
}

/** The accessors and bulk setter the compiler's transform writes call. */
const transformRoots = (
    module: string,
    name: string,
    lanes: readonly string[],
): TextFunction[] => [
    ...lanes.flatMap((lane) =>
        (["get", "set"] as const).map((kind) => ({
            module,
            name,
            member: { name: lane, kind },
        })),
    ),
    { module, name, member: { name: "set", kind: "method" } },
];

/** The pinned text functions each generated header owns. */
export const TEXT_HEADER_ROOTS: Readonly<
    Record<
        | "records"
        | "update"
        | "weight"
        | "gpu"
        | "renderer"
        | "coverage"
        | "renderable"
        | "layout",
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
    // The opt-in setter is what the pin's lazy loader returns.
    weight: [{ module: LOAD_WEIGHT, name: "loadFontWeightOffset", lazy: true }],
    layout: [{ module: LAYOUT, name: "layoutText" }],
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
    ],
    coverage: [
        { module: ALPHA_TO_COVERAGE, name: "setAlphaToCoverage" },
        { module: ALPHA_TO_COVERAGE, name: "getAlphaToCoverage" },
    ],
    renderable: [
        { module: TEXT_RENDERABLE, name: "createTextRenderable" },
        { module: TEXT_RENDERABLE, name: "addTextRenderable" },
        ...transformRoots(OBSERVABLE_VEC3, "ObservableVec3", ["x", "y", "z"]),
        ...transformRoots(OBSERVABLE_QUAT, "ObservableQuat", [
            "x",
            "y",
            "z",
            "w",
        ]),
    ],
};

/** The declaration one header root names. */
function rootDeclaration(
    model: PinnedRecordModel,
    root: TextFunction,
): PinnedCallable {
    if (root.lazy) return lazyExport(model, root.module, root.name);
    return root.member
        ? model.classMember(
              root.module,
              root.name,
              root.member.name,
              root.member.kind,
          )
        : model.functionDeclaration(root.module, root.name);
}

/**
 * The module function a lazy loader returns, read from its return
 * statement: `(await import(specifier)).name`. Any other loader refuses.
 */
function lazyExport(
    model: PinnedRecordModel,
    module: string,
    name: string,
): ts.FunctionDeclaration {
    const loader = model.functionDeclaration(module, name);
    const unwrap = (node: ts.Expression): ts.Expression =>
        ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
    const statements = loader.body?.statements ?? [];
    const returned =
        statements.length === 1 && ts.isReturnStatement(statements[0]!)
            ? statements[0].expression
            : undefined;
    const access = returned ? unwrap(returned) : undefined;
    const loaded =
        access && ts.isPropertyAccessExpression(access)
            ? unwrap(access.expression)
            : undefined;
    const imported =
        loaded && ts.isAwaitExpression(loaded)
            ? unwrap(loaded.expression)
            : undefined;
    const declaration =
        access &&
        ts.isPropertyAccessExpression(access) &&
        imported &&
        ts.isCallExpression(imported) &&
        imported.expression.kind === ts.SyntaxKind.ImportKeyword
            ? model.declarationOf(access.name)
            : undefined;
    if (
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        !ts.isSourceFile(declaration.parent)
    )
        return model.fail(
            loader,
            "A pinned lazy loader returns one module function of a dynamic import.",
        );
    return declaration;
}

/**
 * The native function the pin's lazy weight loader resolves to: scene code
 * holding `await loadFontWeightOffset()` calls it.
 */
export function lazyWeightSetterCpp(): string {
    const model = sharedTextRecordModel();
    return model.qualified(
        model.lowered(lazyExport(model, LOAD_WEIGHT, "loadFontWeightOffset")),
    );
}

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
                rootDeclaration(model, root),
            ),
        );
        for (const key of model.emittedKeys()) earlier.add(key);
    }
    const model = textRecordModel(context);
    return model.lower(
        TEXT_HEADER_ROOTS[header].map((root) => rootDeclaration(model, root)),
        (entry) => !earlier.has(`${entry.module}#${entry.name}`),
    );
}
