/**
 * The rectangular area-light extensions and LTC tables, from the pin's own
 * modules.
 *
 * `enableRectAreaLights(scene)` (src/light/enable-rect-area-lights.ts)
 * registers `rectAreaPbrExt` and `rectAreaStdExt`, installs the scene's
 * lighting extension (single/multi light sources, `_pbrFeatures`, the
 * Standard scene context) and decodes the LTC payload. Generation runs the
 * same records: the PBR and Standard compositions take their fragments from
 * them, and the LTC tables are the pin's `decodeAreaLightLtc` output over the
 * payload its `LTC_URL` names.
 *
 * Registration is unconditional, on the argument the clustered and
 * environment extensions already make: `rectAreaPbrExt.frag` returns null
 * without the RECT_AREA_PBR_SCENE scene bit and `rectAreaStdExt._frag` runs
 * only for a word carrying its own material bit, both of which only the
 * scene context sets, so a scene that never enables area lighting composes
 * exactly what it composed before.
 */
import { createHash } from "node:crypto";
import ts from "typescript";
import { PNG } from "pngjs";
import type { Texture2DOptions } from "@babylonjs/lite";
import { downloadCached } from "./asset-download-cache.js";
import {
    assetSourceName,
    basenameWithoutExtension,
} from "./compiler/assets.js";
import { sharedPinnedContext } from "./lowering/context.js";
import {
    pinnedErrorCode,
    pinnedErrorMessage,
} from "./lowering/pinned-error.js";
import { bakeAreaLightTexture } from "./pinned-area-light-texture.js";
import { pinnedTextureSamplerPairs } from "./pinned-material-plugins.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

const pbrFragmentModule = "material/pbr/fragments/rect-area-light-fragment.js";
const standardFragmentModule =
    "material/standard/fragments/rect-area-light-fragment.js";
const ltcModule = "light/area-light-ltc.js";

interface PbrExtRecord {
    readonly id: string;
}

interface StdExtRecord {
    readonly _id: string;
    readonly _feature: number;
    _frag: (
        features: number,
        meshFeatures: number,
        material?: unknown,
    ) => unknown;
}

/** The pin's area single/multi light sources (`SceneLightingExtension`). */
interface PinnedRectAreaPbr {
    rectAreaPbrExt: PbrExtRecord;
    RECT_AREA_PBR_SCENE: number;
    RECT_AREA_PBR_SELECTED: number;
    rectAreaSingleLightSource: (type: string) =>
        | {
              SINGLE_LIGHT_STRUCTS: string;
              getSingleLightBlock: () => string;
          }
        | undefined;
    rectAreaMultiLightSource: () => { _helpers: string; _loop: string };
}

/** The Standard half: the ext and the scene shader context it installs. */
interface PinnedRectAreaStandard {
    rectAreaStdExt: StdExtRecord;
    rectAreaStandardContext: (fog: unknown) => {
        _features: number;
        _fragments: readonly unknown[];
        _materialFeatures: number;
        _lightingFunction: string;
    };
}

/**
 * The textured half, which `area-light-emission-setup.ts` installs over the
 * solid one once a packed light carries a processed image: its own exts,
 * single/multi sources that thread the packed light index, the PBR scene
 * bit and the Standard scene context.
 */
interface PinnedRectAreaEmissionPbr {
    rectAreaEmissionPbrExt: PbrExtRecord;
    RECT_AREA_PBR_EMISSION: number;
    rectAreaEmissionSingle: PinnedRectAreaPbr["rectAreaSingleLightSource"];
    rectAreaEmissionMulti: PinnedRectAreaPbr["rectAreaMultiLightSource"];
}

interface PinnedRectAreaEmissionStandard {
    rectAreaEmissionStdExt: StdExtRecord;
    rectAreaEmissionStandardContext: PinnedRectAreaStandard["rectAreaStandardContext"];
}

/**
 * A scene's area lighting, a per-scene part of every variant key: none
 * without `enableRectAreaLights`, the solid extension it installs, or the
 * textured one its emission seam installs over it once a packed light
 * carries a processed image. The index is the native key
 * (`scene_rect_area_lighting`).
 */
export const rectAreaLightingModes = ["none", "solid", "textured"] as const;

export type RectAreaLightingMode = (typeof rectAreaLightingModes)[number];

/** An installed area lighting extension. */
export type RectAreaLighting = Exclude<RectAreaLightingMode, "none">;

/**
 * The lightings a program's scenes can draw under, each composed and keyed
 * at run time from the scene's own state: none for a scene that never
 * enables area lighting, solid for one whose packed lights carry no
 * processed image, textured once `processAreaLightTexture` is reached.
 * Undefined for a program without `enableRectAreaLights`, whose keys carry
 * no area lane.
 */
export function reachedRectAreaLightings(
    features: readonly string[],
): readonly RectAreaLightingMode[] | undefined {
    if (!features.includes("light:rect-area-lighting")) return undefined;
    return features.includes("light:rect-area-emission")
        ? rectAreaLightingModes
        : ["none", "solid"];
}

/**
 * `scene_rect_area_lighting(scene)`: the mode a scene draws under, as its
 * `rectAreaLightingModes` index -- emitted once, beside the variant tables
 * both families key on it.
 */
export function rectAreaLightingKeyCpp(): string {
    const index = (mode: RectAreaLightingMode): string =>
        `${rectAreaLightingModes.indexOf(mode)}u`;
    return `// The scene's area lighting (src/pinned-rect-area-lights.ts rectAreaLightingModes):
// the textured extension once its snapshot packs a processed image, the
// solid one while enabled, none otherwise.
inline std::uint32_t scene_rect_area_lighting(const Scene& scene) {
    if (!scene.state->rect_area_lighting) return ${index("none")};
    return scene.state->area_light_emission ? ${index("textured")} : ${index("solid")};
}`;
}

export function pinnedRectAreaPbr(): Promise<PinnedRectAreaPbr> {
    return importPinnedModule<PinnedRectAreaPbr>(pbrFragmentModule);
}

export function pinnedRectAreaStandard(): Promise<PinnedRectAreaStandard> {
    return importPinnedModule<PinnedRectAreaStandard>(standardFragmentModule);
}

export function pinnedRectAreaEmissionPbr(): Promise<PinnedRectAreaEmissionPbr> {
    return importPinnedModule<PinnedRectAreaEmissionPbr>(
        "material/pbr/fragments/rect-area-light-emission-fragment.js",
    );
}

export function pinnedRectAreaEmissionStandard(): Promise<PinnedRectAreaEmissionStandard> {
    return importPinnedModule<PinnedRectAreaEmissionStandard>(
        "material/standard/fragments/rect-area-light-emission-fragment.js",
    );
}

/**
 * The scene's PBR lighting extension: `_single`, `_multi` and the scene bits
 * `_pbrFeatures` ORs in (`rectAreaPbrFeatures`'s scene bit, plus
 * RECT_AREA_PBR_EMISSION once the textured seam wraps it), and the selected
 * bit `rectAreaPbrFeatures` adds for a renderable an area light reaches,
 * which only gates the layered-BRDF refusal (`areaSelectedRefusal`).
 */
export async function pinnedAreaPbrLighting(
    lighting: RectAreaLighting,
): Promise<{
    single: PinnedRectAreaPbr["rectAreaSingleLightSource"];
    multi: PinnedRectAreaPbr["rectAreaMultiLightSource"];
    sceneFeatures: number;
    selected: number;
}> {
    const solid = await pinnedRectAreaPbr();
    const selected = solid.RECT_AREA_PBR_SELECTED;
    if (lighting === "solid")
        return {
            single: solid.rectAreaSingleLightSource,
            multi: solid.rectAreaMultiLightSource,
            sceneFeatures: solid.RECT_AREA_PBR_SCENE,
            selected,
        };
    const textured = await pinnedRectAreaEmissionPbr();
    return {
        single: textured.rectAreaEmissionSingle,
        multi: textured.rectAreaEmissionMulti,
        sceneFeatures:
            solid.RECT_AREA_PBR_SCENE | textured.RECT_AREA_PBR_EMISSION,
        selected,
    };
}

/** The scene's Standard shader context (`lighting._standard(fog)`). */
export async function pinnedAreaStandardContext(
    lighting: RectAreaLighting,
    fog: unknown,
): Promise<ReturnType<PinnedRectAreaStandard["rectAreaStandardContext"]>> {
    return lighting === "solid"
        ? (await pinnedRectAreaStandard()).rectAreaStandardContext(fog)
        : (
              await pinnedRectAreaEmissionStandard()
          ).rectAreaEmissionStandardContext(fog);
}

/** The pin's LTC payload URL, read off `area-light-ltc.ts`'s own constant. */
export function pinnedAreaLightLtcUrl(): string {
    const context = sharedPinnedContext();
    const initializer = context.unwrapExpression(
        context.variableInitializer(
            context.sourceFile("src/light/area-light-ltc.ts"),
            "LTC_URL",
        ),
    );
    if (!ts.isStringLiteral(initializer))
        return context.contractError(
            initializer,
            "Expected the pinned LTC_URL to be a string literal.",
        );
    return initializer.text;
}

/**
 * `areaLightBindings()`'s texture/sampler pairs, in its own order: LTC1
 * then LTC2, each a `texture_2d<f32>` followed by its filtering sampler.
 * Read off the pinned declaration so the slot rows name exactly what the
 * composed fragments declare.
 */
export function pinnedAreaLightBindingPairs(): readonly {
    texture: string;
    sampler: string;
}[] {
    const context = sharedPinnedContext();
    const { declaration, entries } = pinnedBindingDeclarations(
        "src/light/area-light-wgsl.ts",
        "areaLightBindings",
    );
    const pairs = pinnedTextureSamplerPairs(
        entries,
        "Pinned areaLightBindings",
    );
    if (pairs.length !== 2 || entries.length !== 2 * pairs.length)
        return context.contractError(
            declaration,
            "Expected areaLightBindings to declare only the LTC1 and LTC2 " +
                "texture/sampler pairs.",
        );
    return pairs;
}

/**
 * `areaLightEmissionBindings()`'s three, in its own order: the emission
 * array, its filtering sampler and the packed-slot layer block.
 */
export function pinnedAreaLightEmissionBindings(): {
    texture: string;
    sampler: string;
    slots: string;
} {
    const context = sharedPinnedContext();
    const { declaration, entries } = pinnedBindingDeclarations(
        "src/light/area-light-emission-wgsl.ts",
        "areaLightEmissionBindings",
    );
    const [texture, sampler, slots] = entries;
    if (
        entries.length !== 3 ||
        texture?.kind !== "texture" ||
        sampler?.kind !== "sampler" ||
        slots?.kind !== "uniform-buffer"
    )
        return context.contractError(
            declaration,
            "Expected areaLightEmissionBindings to declare the emission " +
                "array, its sampler and the slot block.",
        );
    return { texture: texture.name, sampler: sampler.name, slots: slots.name };
}

/**
 * The area extension's layered-BRDF refusal: `rectAreaPbrExt.frag` throws it
 * for a renderable a packed area light reaches (RECT_AREA_PBR_SELECTED)
 * whose material layers a BRDF the polygon integration does not cover.
 */
export function rectAreaLayeredRefusal(): { code: number; message: string } {
    const context = sharedPinnedContext();
    const { declaration } = context.methodDeclaration(
        "src/material/pbr/fragments/rect-area-light-fragment.ts",
        "rectAreaPbrExt.frag",
    );
    const guard = context
        .findNodes(declaration, (node): node is ts.IfStatement =>
            ts.isIfStatement(node),
        )
        .find(
            (statement) =>
                context.findNodes(
                    statement.expression,
                    (node): node is ts.Identifier =>
                        ts.isIdentifier(node) &&
                        node.text === "RECT_AREA_PBR_SELECTED",
                ).length > 0,
        );
    if (!guard)
        return context.contractError(
            declaration,
            "Expected rectAreaPbrExt.frag to refuse layered BRDFs under " +
                "RECT_AREA_PBR_SELECTED.",
        );
    const code = pinnedErrorCode(context, guard);
    return { code, message: pinnedErrorMessage(context, code) };
}

/** One scene-owned area-light texture row: its native source and the pin's names. */
export interface RectAreaTextureRow {
    readonly source: string;
    readonly texture: string;
    readonly sampler: string;
}

/**
 * The scene-owned texture rows the area lightings bind, one builder for
 * every family's table: `bindAreaLightLtc`'s two pairs once area lighting is
 * reached, and `bindAreaLightEmission`'s array once the textured lighting
 * is. The sources are the `MaterialTextureSource` enumerators
 * (`rectAreaSlotDeclarationsCpp`).
 */
export function rectAreaTextureRows(
    lightings: readonly RectAreaLightingMode[] | undefined,
): readonly RectAreaTextureRow[] {
    if (!lightings) return [];
    const rows: RectAreaTextureRow[] = pinnedAreaLightBindingPairs().map(
        (pair, index) => ({
            source: `rect_area_ltc${index + 1}`,
            texture: pair.texture,
            sampler: pair.sampler,
        }),
    );
    if (lightings.includes("textured")) {
        const emission = pinnedAreaLightEmissionBindings();
        rows.push({
            source: "rect_area_emission",
            texture: emission.texture,
            sampler: emission.sampler,
        });
    }
    return rows;
}

/**
 * The slot table's area declarations: the rows' `MaterialTextureSource`
 * enumerators, and the emission slot block's name, which each backend
 * resolves by (`rect_area_emission_slots_block`).
 */
export function rectAreaSlotDeclarationsCpp(
    lightings: readonly RectAreaLightingMode[] | undefined,
): { enumerators: string; constants: string } {
    const rows = rectAreaTextureRows(lightings);
    return {
        enumerators: rows
            .map(
                (row) =>
                    `\n    /** The area lighting's ${row.texture} (scene-owned). */\n    ${row.source},`,
            )
            .join(""),
        constants: lightings?.includes("textured")
            ? `\n\n// area-light-emission-wgsl.ts areaLightEmissionBindings' slot block, which\n// each backend binds from the scene's snapshot by this name.\ninline constexpr std::string_view rect_area_emission_slots_block = "${pinnedAreaLightEmissionBindings().slots}";`
            : "",
    };
}

/** A pinned `BindingDecl[]` factory's `_name` and `_type._kind` pairs. */
function pinnedBindingDeclarations(
    module: string,
    name: string,
): {
    declaration: ts.FunctionDeclaration;
    entries: readonly { name: string; kind: string }[];
} {
    const context = sharedPinnedContext();
    const { declaration } = context.functionDeclaration(module, name);
    const entries = context
        .findNodes(declaration, (node): node is ts.ObjectLiteralExpression =>
            ts.isObjectLiteralExpression(node),
        )
        .filter((node) =>
            node.properties.some(
                (property) =>
                    property.name !== undefined &&
                    context.propertyName(property.name) === "_name",
            ),
        )
        .map((entry) => {
            const field = (name: string): ts.Expression =>
                context.propertyInitializer(entry, name);
            const type = field("_type");
            if (!ts.isObjectLiteralExpression(type))
                return context.contractError(
                    entry,
                    "Expected an area-light binding type literal.",
                );
            return {
                name: context.stringValue(
                    field("_name"),
                    entry.getSourceFile(),
                ),
                kind: context.stringValue(
                    context.propertyInitializer(type, "_kind"),
                    entry.getSourceFile(),
                ),
            };
        });
    return { declaration, entries };
}

/**
 * The two decoded tables, as the bytes `queue.writeTexture` uploads: the
 * pin's `decodeAreaLightLtc` run over the payload `LTC_URL` serves (through
 * the pinned-URL download cache). The decode validates the 65,536-byte
 * length itself, so a changed payload fails generation by the pin's message.
 */
export async function decodedAreaLightLtc(): Promise<
    readonly [Uint8Array, Uint8Array]
> {
    return decodeAreaLightLtcTables(
        await downloadCached(pinnedAreaLightLtcUrl()),
    );
}

/** The pin's `decodeAreaLightLtc` over one payload, as upload bytes. */
export async function decodeAreaLightLtcTables(
    payload: Uint8Array,
): Promise<readonly [Uint8Array, Uint8Array]> {
    const module = await importPinnedModule<{
        decodeAreaLightLtc: (
            payload: ArrayBuffer,
        ) => readonly [Uint16Array, Uint16Array];
    }>(ltcModule);
    // The decode reads a DataView over its own ArrayBuffer, so it gets an
    // exact copy rather than a view into the cache's larger allocation.
    const [ltc1, ltc2] = module
        .decodeAreaLightLtc(payload.slice().buffer)
        .map(
            (table) =>
                new Uint8Array(
                    table.buffer,
                    table.byteOffset,
                    table.byteLength,
                ),
        );
    return [ltc1!, ltc2!];
}

/** The `GPUTextureDescriptor` facts one pinned `createTexture` call states. */
interface PinnedSquareTexture {
    readonly size: number;
    readonly levels: number;
    readonly format: string;
}

/**
 * The square texture `name` creates: its `createTexture` descriptor's
 * extent (two lanes, three for an array), format and level count.
 */
function pinnedSquareTexture(
    module: string,
    name: string,
    layered: boolean,
): PinnedSquareTexture & { declaration: ts.FunctionDeclaration } {
    const context = sharedPinnedContext();
    const { declaration } = context.functionDeclaration(module, name);
    const descriptor = context.callObjectArgument(declaration, "createTexture");
    const file = declaration.getSourceFile();
    const size = context.unwrapExpression(
        context.propertyInitializer(descriptor, "size"),
    );
    const elements = ts.isArrayLiteralExpression(size)
        ? size.elements
        : undefined;
    if (!elements || elements.length !== (layered ? 3 : 2))
        return context.contractError(
            descriptor,
            `Expected ${name} to create a square ${layered ? "array " : ""}texture.`,
        );
    const width = context.numericValue(elements[0]!, file);
    if (context.numericValue(elements[1]!, file) !== width)
        return context.contractError(
            descriptor,
            `Expected ${name}'s texture to be square.`,
        );
    const levels = descriptor.properties.some(
        (property) =>
            property.name !== undefined &&
            context.propertyName(property.name) === "mipLevelCount",
    )
        ? context.numericValue(
              context.propertyInitializer(descriptor, "mipLevelCount"),
              file,
          )
        : 1;
    return {
        declaration,
        size: width,
        levels,
        format: context.stringValue(
            context.propertyInitializer(descriptor, "format"),
            file,
        ),
    };
}

/** The LTC tables' upload: a square rgba16float image of `size` texels. */
export interface AreaLightLtcShape {
    readonly size: number;
    /** `writeTexture`'s `bytesPerRow`. */
    readonly rowBytes: number;
}

/**
 * The LTC upload's shape, read off `area-light-ltc.ts`'s own `upload`: the
 * `createTexture` extent and format, and the `writeTexture` row pitch.
 * Each backend's upload is rgba16float, so another format refuses here.
 */
export function pinnedAreaLightLtcShape(): AreaLightLtcShape {
    const context = sharedPinnedContext();
    const texture = pinnedSquareTexture(
        "src/light/area-light-ltc.ts",
        "upload",
        false,
    );
    if (texture.format !== "rgba16float" || texture.levels !== 1)
        return context.contractError(
            texture.declaration,
            "Expected the LTC tables to be single-level rgba16float textures.",
        );
    const write = context.callExpression(texture.declaration, "writeTexture");
    const layout = write.arguments[2];
    if (!layout || !ts.isObjectLiteralExpression(layout))
        return context.contractError(
            write,
            "Expected the LTC writeTexture to pass a data layout literal.",
        );
    return {
        size: texture.size,
        rowBytes: context.numericValue(
            context.propertyInitializer(layout, "bytesPerRow"),
            texture.declaration.getSourceFile(),
        ),
    };
}

/** What one `processAreaLightTexture` call processes: its source's load. */
export interface AreaLightImageRequest {
    /** The source image's packaged asset source. */
    readonly source: string;
    /** The `loadTexture2D` options the source was loaded with. */
    readonly loaderOptions: Readonly<Texture2DOptions>;
}

/**
 * The generated asset source one processed image packages under: unique to
 * its request, so the registry names one output per distinct load.
 */
export function areaLightImageSource(request: AreaLightImageRequest): string {
    const identity = createHash("sha256")
        .update(JSON.stringify([request.source, request.loaderOptions]))
        .digest("hex")
        .slice(0, 16);
    const stem = basenameWithoutExtension(
        assetSourceName(request.source, "emission"),
    );
    return `generated:pinned-area-light-texture/${identity}/${stem}.png`;
}

/** A processed image's square rgba8unorm extent and mip level count. */
export interface AreaLightImageShape {
    readonly size: number;
    readonly levels: number;
}

/**
 * The processed image's shape, read off `processAreaLightTexture`'s own
 * `createTexture`, and checked against the scene array
 * `prepareAreaLightEmission` copies every level of every image into: both
 * square rgba8unorm with the same extent and level count.
 */
export function pinnedAreaLightImageShape(): AreaLightImageShape {
    const context = sharedPinnedContext();
    const [image, array] = [
        pinnedSquareTexture(
            "src/light/process-area-light-texture.ts",
            "processAreaLightTexture",
            false,
        ),
        pinnedSquareTexture(
            "src/light/area-light-emission.ts",
            "prepareAreaLightEmission",
            true,
        ),
    ];
    for (const texture of [image, array])
        if (texture.format !== "rgba8unorm")
            return context.contractError(
                texture.declaration,
                "Expected the area emission textures to be rgba8unorm.",
            );
    if (image.size !== array.size || image.levels !== array.levels)
        return context.contractError(
            array.declaration,
            "The pinned emission array no longer copies the processed " +
                "image's whole chain level for level.",
        );
    return { size: image.size, levels: image.levels };
}

/**
 * The packaged chain's layout, which the native walker
 * (`for_each_area_light_image_level`) reads back: one PNG `size` texels wide,
 * each level at the left of its own band of rows, level zero first.
 */
function areaLightImageBandRows(shape: AreaLightImageShape): number[] {
    return Array.from({ length: shape.levels }, (_, level) =>
        Math.max(shape.size >> level, 1),
    );
}

/**
 * `processAreaLightTexture(engine, await loadTexture2D(engine, source,
 * options))`, executed on the pin (`bakeAreaLightTexture`), packaged
 * losslessly: every level of the processed texture in its band of one PNG.
 */
export async function packagedAreaLightImage(
    request: AreaLightImageRequest,
    sourceBytes: Uint8Array,
): Promise<Uint8Array> {
    const shape = pinnedAreaLightImageShape();
    const processed = await bakeAreaLightTexture(
        sourceBytes,
        request.loaderOptions,
    );
    if (
        processed.width !== shape.size ||
        processed.height !== shape.size ||
        processed.levels.length !== shape.levels
    )
        throw new Error(
            `processAreaLightTexture returned a ${processed.width}x` +
                `${processed.height} chain of ${processed.levels.length} ` +
                `levels; the pinned image is ${shape.size}x${shape.size} ` +
                `with ${shape.levels}.`,
        );
    const bands = areaLightImageBandRows(shape);
    const atlas = new PNG({
        width: shape.size,
        height: bands.reduce((total, rows) => total + rows, 0),
        colorType: 6,
    });
    atlas.data.fill(0);
    let row = 0;
    processed.levels.forEach((level, index) => {
        const extent = bands[index]!;
        const rowBytes = extent * 4;
        for (let y = 0; y < extent; ++y)
            atlas.data.set(
                level.subarray(y * rowBytes, (y + 1) * rowBytes),
                (row + y) * shape.size * 4,
            );
        row += extent;
    });
    return PNG.sync.write(atlas, { colorType: 6 });
}
