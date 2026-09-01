import ts from "typescript";
import type {
    SpriteCustomShaderManifest,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { validateObjectProperties } from "../option-helpers.js";
import {
    isDataTuple,
    tupleComponents,
    type DataTypeRegistry,
} from "../data-types.js";
import {
    addressModeByPin,
    pixelsTextureOptionsCpp,
} from "../../pinned-address-modes.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import { parseBlendExport } from "../../lowering/pinned-blend-table.js";
import { stringLiteral } from "../../cpp-literals.js";

export interface SpriteIntrinsicContext
    extends IntrinsicCallContext,
        PositiveIntegerContext {
    readonly dataTypes: DataTypeRegistry;
    readonly checker: ts.TypeChecker;
    unwrap(expression: ts.Expression): ts.Expression;
    requireDefaultEngine(node: ts.Node): string;
    requireEngine(value: Value, node: ts.Node): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileCondition(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileVec2(expression: ts.Expression): string;
    compileVec4(expression: ts.Expression): string;
    registerSpriteAtlasAsset(
        expression: ts.Expression,
    ): string;
    probePixelsAsset(
        expression: ts.Expression,
    ): { cpp: string; source: string } | undefined;
    allocateTemporaryCppName(label: string): string;
    compileSpriteAtlas(expression: ts.Expression): Value;
    /** One layer or system built without a custom shader, so with the stock program. */
    recordPlainSpriteProgram(family: "sprite" | "billboard"): void;
    /** A standalone SpriteRenderer needs the pure-2D vertex permutation. */
    recordPureSpriteVertex(): void;
    /** The custom-shader descriptors built so far, in scene order. */
    spriteCustomShaders(): readonly SpriteCustomShaderManifest[];
    /**
     * Records one custom-shader descriptor. Generation composes one program
     * per entry, from the pin's builder around the caller's fragment body.
     */
    recordSpriteCustomShader(
        shader: SpriteCustomShaderManifest,
    ): void;
    emit(line: string): void;
    propertyName(name: ts.PropertyName): string | undefined;
    fail(node: ts.Node, message: string): never;
}

/**
 * The pin's billboard blend descriptors are pure-data exports a scene
 * imports by name, so an identifier naming one compiles to the native
 * factory the billboard lowerer emits for it. Resolving by name rather than
 * by a list of cases means a descriptor the pin adds needs no change here;
 * one it removes fails at the native link, naming the symbol.
 */
export function compileSpriteConstant(
    importedName: string,
): Value | undefined {
    const blend = parseBlendExport(importedName);
    if (!blend) {
        return undefined;
    }
    return {
        kind: "sprite-blend",
        cpp: `bbl::${blend.symbol}()`,
        // The export the scene named. Every question a call site asks about
        // the descriptor -- which family, which mode -- comes from parsing
        // this once, so none of them is spelled twice.
        staticString: importedName,
    };
}

/**
 * The native factory a `blendMode` option names, or the family's default.
 *
 * The family is checked because the two sets are not interchangeable: a 2D
 * descriptor at a billboard system would otherwise compile straight through
 * to a `sprite_blend_*` factory the billboard pipeline cannot mean.
 */
function blendOption(
    context: SpriteIntrinsicContext,
    options: Value | undefined,
    family: "sprite" | "billboard",
    node: ts.Node,
): string {
    const blendMode = property(options, "blendMode");
    if (!blendMode) {
        return `bbl::${family}_blend_alpha()`;
    }
    const named =
        blendMode.kind === "sprite-blend" && blendMode.staticString
            ? parseBlendExport(blendMode.staticString)
            : undefined;
    if (!named || named.family !== family) {
        context.fail(
            node,
            `blendMode must be one of the pinned ${family}Blend* descriptors.`,
        );
    }
    // The cutout mode is the one billboard descriptor with a second
    // pipeline behind it, so naming it reaches that arm's shader.
    if (family === "billboard" && named.mode === "cutout") {
        context.reachFeature("sprite:billboard-cutout", node);
    }
    return blendMode.cpp;
}

/**
 * The extra textures a custom shader binds after the atlas.
 *
 * Each entry names an identifier the caller's WGSL samples through
 * `<name>Tex` / `<name>Samp`, so the name has to be settled here; the
 * texture beside it is an ordinary runtime value the layer or system binds.
 */
function extraTextureOption(
    context: SpriteIntrinsicContext,
    options: Value | undefined,
    label: string,
    node: ts.Node,
): { name: string; cpp: string }[] {
    const named = property(options, "extraTextures");
    if (!named) {
        return [];
    }
    if (named.kind !== "tuple" || !named.tupleElements) {
        context.fail(
            node,
            `${label}: 'extraTextures' must be written as an array literal.`,
        );
    }
    return named.tupleElements.map((entry) => {
        const name = entry.recordProperties?.["name"];
        const texture = entry.recordProperties?.["texture"];
        if (
            entry.kind !== "record" ||
            name?.staticString === undefined ||
            texture?.kind !== "texture"
        ) {
            context.fail(
                node,
                `${label}: each extra texture needs a literal 'name' and a texture.`,
            );
        }
        return { name: name.staticString, cpp: texture.cpp };
    });
}

/**
 * The values a `customShader` option settles on the record: whether there is
 * a descriptor, the extra textures it binds, and their shader identifiers.
 *
 * The pin's own hook copies the descriptor onto the layer or system and
 * every later read goes through it, so the program itself is composed once
 * per family and what the record carries is only this binding metadata. The
 * family is checked because a 2D descriptor names a fragment written against
 * a varying struct carrying `uv` and `tint` alone, which a billboard stage would
 * compile against a different contract behind the same names.
 */
function customShaderOption(
    context: SpriteIntrinsicContext,
    options: Value | undefined,
    family: "sprite" | "billboard",
    node: ts.Node,
): { program: string; textures: string; textureNames: string } {
    const named = property(options, "customShader");
    if (!named) {
        context.recordPlainSpriteProgram(family);
        return { program: "0u", textures: "{}", textureNames: "{}" };
    }
    if (named.kind !== `${family}-custom-shader`) {
        context.fail(
            node,
            `customShader must be a ${
                family === "sprite"
                    ? "createSprite2DCustomShader"
                    : "createBillboardCustomShader"
            } descriptor.`,
        );
    }
    // The descriptor's extra textures travel with the flag: they are what
    // the layer or system binds after its atlas, in the order the WGSL
    // declares them. The factory always sets the list, empty or not, so an
    // absent one is this compiler disagreeing with itself rather than the
    // scene naming something odd.
    if (!named.spriteCustomTextures) {
        context.fail(
            node,
            "A custom-shader descriptor reached a layer without its texture list.",
        );
    }
    if (!named.spriteCustomTextureNames) {
        context.fail(
            node,
            "A custom-shader descriptor reached a layer without its texture names.",
        );
    }
    if (named.spriteCustomShaderIndex === undefined) {
        context.fail(
            node,
            "A custom-shader descriptor reached a layer without its program index.",
        );
    }
    return {
        program: `${named.spriteCustomShaderIndex}u`,
        textures: `{${named.spriteCustomTextures.join(", ")}}`,
        textureNames: `{${named.spriteCustomTextureNames
            .map(stringLiteral)
            .join(", ")}}`,
    };
}

/**
 * Reads an options record written as an object literal at the call site.
 * Babylon Lite's sprite entry points all take one, and every reached call
 * writes it inline, so the record is the compile-time thing it looks like.
 */
/** The object literal an options argument must be, for the shared
 *  property validator to name what a scene wrote. */
function optionsLiteral(
    context: SpriteIntrinsicContext,
    expression: ts.Expression,
): ts.ObjectLiteralExpression {
    const unwrapped = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(unwrapped)) {
        context.fail(
            expression,
            "These options must be written as an object literal.",
        );
    }
    return unwrapped;
}

function optionsRecord(
    context: SpriteIntrinsicContext,
    expression: ts.Expression | undefined,
    label: string,
): Value | undefined {
    if (!expression) {
        return undefined;
    }
    const value = context.compileValue(expression);
    if (value.kind !== "record") {
        context.fail(
            expression,
            `${label} options must be written as an object literal.`,
        );
    }
    return value;
}

function property(
    options: Value | undefined,
    name: string,
): Value | undefined {
    return options?.recordProperties?.[name];
}

/**
 * `PixelsTexture2DOptions`, as the record the generated factory resolves
 * against the pin's own defaults.
 *
 * Only the four sampler fields are lowered, which is what the corpus
 * reaches through both of its routes — `addressMode*` for a tiling data
 * texture (scenes 231, 282) and the `nearest` filters for a procedural
 * sprite (282, 283, 284, 301). `srgb` selects `rgba8unorm-srgb`, which
 * changes how the texel decodes rather than how it is sampled, and no
 * reached call passes it.
 */
function pixelsSamplerOptions(
    context: SpriteIntrinsicContext,
    expression: ts.Expression | undefined,
): { cpp: string; named: Record<string, string> } {
    if (!expression) {
        return { cpp: "", named: {} };
    }
    const options = optionsRecord(
        context,
        expression,
        "createTexture2DFromPixels",
    );
    const named: Record<string, string> = {};
    for (const [field, value] of Object.entries(
        options?.recordProperties ?? {},
    )) {
        if (
            ![
                "addressModeU",
                "addressModeV",
                "minFilter",
                "magFilter",
            ].includes(field)
        ) {
            context.fail(
                expression,
                `createTexture2DFromPixels '${field}' is not lowered; ` +
                    "the reached slice is the four sampler overrides.",
            );
        }
        if (value.staticString === undefined) {
            context.fail(
                expression,
                `createTexture2DFromPixels ${field} is one of the pinned ` +
                    "string literals.",
            );
        }
        named[field] = value.staticString;
    }
    const cpp = pixelsTextureOptionsCpp(named, (message) =>
        context.fail(expression, message),
    );
    return { cpp: cpp ? `, ${cpp}` : "", named };
}

function numberOption(
    options: Value | undefined,
    name: string,
    fallback: string,
): string {
    const value = property(options, name);
    return value ? `static_cast<float>(${value.cpp})` : fallback;
}

/**
 * One `Sprite2DProps`, as the pinned writer reads it.
 *
 * Every field travels as "a value, and whether the caller named it", because
 * that pair is what `writeInstance` branches on: the add arm turns an unnamed
 * field into its documented default and the update arm turns it into the
 * value already in the slot. So the two entry points read the same options
 * here rather than each resolving defaults its own way — which they cannot
 * do, since only the native writer can see the previous instance.
 *
 * `positionPx` is the one field the two disagree about: `addSprite2DIndex`
 * throws without one and `updateSprite2DIndex` preserves the slot's own.
 */
function sprite2DPropsCpp(
    context: SpriteIntrinsicContext,
    props: Value | undefined,
    call: ts.CallExpression,
    importedName: string,
): string {
    const positionPx = tupleOption(
        context,
        props,
        "positionPx",
        call,
        2,
    );
    if (!positionPx && importedName === "addSprite2DIndex") {
        context.fail(call, "addSprite2DIndex: positionPx required.");
    }
    const z = property(props, "z");
    const sizePx = tupleOption(context, props, "sizePx", call, 2);
    const color = tupleOption(context, props, "color", call, 4);
    const frame = property(props, "frame");
    const rotation = property(props, "rotation");
    const flipX = property(props, "flipX");
    const flipY = property(props, "flipY");
    const visible = property(props, "visible");
    return (
        `bbl::Sprite2DProps{` +
        `bbl::Vec2{${
            positionPx
                ? `${positionPx[0]!}, ${positionPx[1]!}`
                : "0.0f, 0.0f"
        }}, ${positionPx ? "true" : "false"}, ` +
        `bbl::Vec2{${
            sizePx ? `${sizePx[0]!}, ${sizePx[1]!}` : "0.0f, 0.0f"
        }}, ${sizePx ? "true" : "false"}, ` +
        `${frame ? `static_cast<float>(${frame.cpp})` : "0.0f"}, ` +
        `${frame ? "true" : "false"}, ` +
        `${rotation ? `static_cast<float>(${rotation.cpp})` : "0.0f"}, ` +
        `${rotation ? "true" : "false"}, ` +
        `bbl::Vec4{${
            color ? color.join(", ") : "1.0f, 1.0f, 1.0f, 1.0f"
        }}, ${color ? "true" : "false"}, ` +
        `${flipX?.cpp ?? "false"}, ${flipX ? "true" : "false"}, ` +
        `${flipY?.cpp ?? "false"}, ${flipY ? "true" : "false"}, ` +
        `${visible?.cpp ?? "true"}, ${visible ? "true" : "false"}, ` +
        `${z ? `static_cast<float>(${z.cpp})` : "0.0f"}, ` +
        `${z ? "true" : "false"}}`
    );
}

/**
 * The `arity` components of a tuple-valued option, as native float
 * expressions.
 *
 * A tuple written in place is already a list of compiled values. One that
 * arrives from the plain-data model — `color: getGridTint(index)` returns a
 * `Tuple<4>` — is a single native expression instead, so it binds to a local
 * first: reading four components must not call the function four times.
 */
function tupleOption(
    context: SpriteIntrinsicContext,
    options: Value | undefined,
    name: string,
    node: ts.Node,
    arity: number,
): string[] | undefined {
    const value = property(options, name);
    if (!value) {
        return undefined;
    }
    if (value.kind === "tuple") {
        const elements = value.tupleElements ?? [];
        if (elements.length !== arity) {
            context.fail(
                node,
                `Sprite option '${name}' expects a ${arity}-element tuple.`,
            );
        }
        return elements.map(
            (element) =>
                `static_cast<float>(${element.cpp})`,
        );
    }
    if (isDataTuple(value, arity)) {
        const local = context.allocateTemporaryCppName(
            `sprite_${name}`,
        );
        context.emit(
            `const bbl::js::Tuple<${arity}> ${local} = ${value.cpp};`,
        );
        return tupleComponents(local, arity);
    }
    return context.fail(
        node,
        `Sprite option '${name}' expects a ${arity}-element tuple.`,
    );
}

/**
 * One billboard instance patch, shared by the index add, the stable-handle
 * add, and the update. `importedName` discriminates the update the way the
 * Sprite2D twin does: only the adds require a position, and only the update
 * narrows to the writer's update-arm fields.
 */
function billboardPropsCpp(
    context: SpriteIntrinsicContext,
    props: Value | undefined,
    call: ts.CallExpression,
    importedName: string,
): string {
    const update = importedName === "updateBillboardSprite";
    for (const name of Object.keys(props?.recordProperties ?? {})) {
        if (
            ![
                "position",
                "sizeWorld",
                "frame",
                "rotation",
                "pivot",
                "color",
                "flipX",
                "flipY",
                "visible",
            ].includes(name)
        ) {
            context.fail(call, `Billboard sprite option '${name}' is not lowered.`);
        }
        if (
            update &&
            !["position", "sizeWorld", "color"].includes(name)
        ) {
            context.fail(
                call,
                `updateBillboardSprite option '${name}' is not lowered.`,
            );
        }
    }
    const position = tupleOption(context, props, "position", call, 3);
    if (!update && !position) {
        context.fail(call, `${importedName}: position required.`);
    }
    const sizeWorld = tupleOption(context, props, "sizeWorld", call, 2);
    const pivot = tupleOption(context, props, "pivot", call, 2);
    const color = tupleOption(context, props, "color", call, 4);
    const frame = property(props, "frame");
    const rotation = property(props, "rotation");
    const flipX = property(props, "flipX");
    const flipY = property(props, "flipY");
    const visible = property(props, "visible");
    return (
        `bbl::BillboardSpriteProps{` +
        `bbl::Vec3{${position ? position.join(", ") : "0.0f, 0.0f, 0.0f"}}, ` +
        `bbl::Vec2{${sizeWorld ? sizeWorld.join(", ") : "0.0f, 0.0f"}}, ` +
        `${sizeWorld ? "true" : "false"}, ` +
        `${frame ? `static_cast<float>(${frame.cpp})` : "0.0f"}, ${frame ? "true" : "false"}, ` +
        `${rotation ? `static_cast<float>(${rotation.cpp})` : "0.0f"}, ${rotation ? "true" : "false"}, ` +
        `bbl::Vec2{${pivot ? pivot.join(", ") : "0.0f, 0.0f"}}, ${pivot ? "true" : "false"}, ` +
        `bbl::Vec4{${color ? color.join(", ") : "1.0f, 1.0f, 1.0f, 1.0f"}}, ${color ? "true" : "false"}, ` +
        `${flipX?.cpp ?? "false"}, ${flipX ? "true" : "false"}, ` +
        `${flipY?.cpp ?? "false"}, ${flipY ? "true" : "false"}, ` +
        `${visible?.cpp ?? "true"}, ${visible ? "true" : "false"}, ` +
        `${position ? "true" : "false"}}`
    );
}

/** Preserve a renderer's native layer vector; materialize only JS arrays. */
function spriteLayerVectorCpp(layers: Value): string {
    return layers.nativeVectorData === true
        ? layers.cpp
        : `bbl::js::array_to_vector(${layers.cpp})`;
}

export function compileSpriteIntrinsic(
    context: SpriteIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "pickSprite2D": {
            context.expectArgumentCount(call, 3, 3);
            const layers = context.compileValue(call.arguments[0]!);
            const tupleLayers =
                layers.kind === "tuple"
                    ? layers.tupleElements
                    : undefined;
            const dataLayers =
                layers.kind === "data" &&
                layers.dataType?.kind === "vector" &&
                layers.dataType.element.kind === "handle" &&
                layers.dataType.element.handle === "sprite-layer";
            if (!tupleLayers && !dataLayers) {
                context.fail(
                    call.arguments[0]!,
                    "pickSprite2D requires an array of sprite layers.",
                );
            }
            for (const layer of tupleLayers ?? []) {
                context.expectKind(
                    layer,
                    "sprite-layer",
                    call.arguments[0]!,
                );
            }
            const firstLayer = tupleLayers?.[0];
            for (const layer of tupleLayers?.slice(1) ?? []) {
                context.expectSameEngine(firstLayer!, layer, call);
            }
            const engineCpp = firstLayer
                ? context.requireEngine(firstLayer, call)
                : layers.engineCpp ?? context.requireDefaultEngine(call);
            const resultType = context.dataTypes.fromTsType(
                context.checker.getTypeAtLocation(call),
                call,
            );
            const resultStruct =
                resultType?.kind === "optional" &&
                resultType.inner.kind === "struct"
                    ? resultType.inner
                    : resultType?.kind === "struct" &&
                        context.dataTypes.isReferenceStruct(
                            resultType.name,
                        )
                      ? resultType
                      : undefined;
            if (!resultType || !resultStruct) {
                context.fail(
                    call,
                    "pickSprite2D must return its pinned nullable hit record.",
                );
            }
            const fields = context.dataTypes.structFields(
                resultStruct.name,
                call,
            );
            const fieldValues: Record<string, string> = {
                layer: "hit->layer",
                spriteIndex: "static_cast<double>(hit->sprite_index)",
                u: "hit->u",
                v: "hit->v",
            };
            if (fields.length !== Object.keys(fieldValues).length) {
                context.fail(
                    call,
                    "pickSprite2D hit record must retain layer, spriteIndex, u, and v.",
                );
            }
            for (const field of fields) {
                if (fieldValues[field.name] === undefined) {
                    context.fail(
                        call,
                        `pickSprite2D hit record has unsupported field '${field.name}'.`,
                    );
                }
                const validType =
                    field.name === "layer"
                        ? field.type.kind === "handle" &&
                          field.type.handle === "sprite-layer"
                        : field.type.kind === "number";
                if (!validType) {
                    context.fail(
                        call,
                        `pickSprite2D hit record field '${field.name}' has an unsupported type.`,
                    );
                }
            }
            const cppType = context.dataTypes.cppType(resultType);
            const hitType = context.dataTypes.cppType(resultStruct);
            const referenceBacked = resultType.kind === "struct";
            const fieldInitializers = fields
                .map((field) => fieldValues[field.name])
                .join(", ");
            const missValue = referenceBacked
                ? `${cppType}{}`
                : `${cppType}{std::nullopt}`;
            const hitValue = referenceBacked
                ? `std::make_shared<${hitType}Data>(${hitType}Data{${fieldInitializers}})`
                : `${cppType}{${hitType}{${fieldInitializers}}}`;
            const layerList = dataLayers
                ? spriteLayerVectorCpp(layers)
                : `std::vector<bbl::Sprite2DLayerHandle>{${(tupleLayers ?? [])
                      .map((layer) => layer.cpp)
                      .join(", ")}}`;
            context.reachFeature("sprite:2d", call);
            return {
                kind: "data",
                cpp:
                    `([&]() -> ${cppType} { ` +
                    `const auto hit = bbl::pick_sprite_2d(${engineCpp}, ${layerList}, ` +
                    `${context.compileNumber(call.arguments[1]!, "double")}, ` +
                    `${context.compileNumber(call.arguments[2]!, "double")}); ` +
                    `if (!hit) return ${missValue}; ` +
                    `return ${hitValue}; }())`,
                dataType: resultType,
            };
        }

        case "createRenderTexture2D": {
            context.expectArgumentCount(call, 3, 4);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            if (call.arguments[3]) {
                const options = optionsRecord(
                    context,
                    call.arguments[3],
                    "createRenderTexture2D",
                );
                if (
                    Object.keys(options?.recordProperties ?? {}).length > 0
                ) {
                    context.fail(
                        call.arguments[3],
                        "createRenderTexture2D options are not reached.",
                    );
                }
            }
            context.reachFeature("sprite:2d", call);
            return {
                kind: "texture",
                textureStorage: "render",
                cpp:
                    `bbl::create_sprite_render_texture(${engine.cpp}, ` +
                    `${context.compileNumber(call.arguments[1]!)}, ` +
                    `${context.compileNumber(call.arguments[2]!)})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createSpriteAtlasFromFrames": {
            context.expectArgumentCount(call, 2, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const sources = context.compileValue(call.arguments[1]!);
            if (
                sources.kind !== "data" ||
                sources.dataType?.kind !== "vector" ||
                sources.dataType.element.kind !== "struct"
            ) {
                context.fail(
                    call.arguments[1]!,
                    "createSpriteAtlasFromFrames expects an array of frame-source records.",
                );
            }
            const sourceType = sources.dataType.element;
            const arrow = context.dataTypes.isReferenceStruct(sourceType.name);
            const source = context.allocateTemporaryCppName("atlas_source");
            const sourceList = context.allocateTemporaryCppName("atlas_sources");
            const normalized = context.allocateTemporaryCppName("atlas_frames");
            const access = (name: string): string => {
                const field = context.dataTypes.structField(
                    sourceType.name,
                    name,
                    call.arguments[1]!,
                );
                return `${source}${arrow ? "->" : "."}${field.name}`;
            };
            const optionalUnsigned = (name: string, fallback: string): string => {
                const value = access(name);
                return `(${value} ? bbl::js::to_uint32(*${value}) : ${fallback})`;
            };
            const pivot = access("pivot");
            const options = optionsRecord(
                context,
                call.arguments[2],
                "createSpriteAtlasFromFrames",
            );
            const numberOption = (name: string, fallback: string): string => {
                const value = property(options, name);
                if (!value) return fallback;
                if (value.kind !== "number") {
                    context.fail(call.arguments[2]!, `${name} must be numeric.`);
                }
                return `bbl::js::to_uint32(${value.cpp})`;
            };
            const sampling = property(options, "sampling");
            if (
                sampling &&
                sampling.staticString !== "nearest" &&
                sampling.staticString !== "linear"
            ) {
                context.fail(
                    call.arguments[2]!,
                    'sampling must be the literal "nearest" or "linear".',
                );
            }
            const srgb = property(options, "srgb");
            if (srgb && srgb.cpp !== "false") {
                context.fail(
                    call.arguments[2]!,
                    "sRGB in-memory sprite atlases are not lowered yet.",
                );
            }
            const premultiplied = property(options, "premultipliedAlpha");
            if (premultiplied && premultiplied.kind !== "boolean") {
                context.fail(
                    call.arguments[2]!,
                    "premultipliedAlpha must be boolean.",
                );
            }
            const capacity = property(options, "capacityPx");
            const capacityLanes = capacity
                ? tupleOption(context, options, "capacityPx", call, 2)
                : undefined;
            context.reachFeature("sprite:2d", call);
            return {
                kind: "sprite-atlas",
                cpp:
                    `([&]() { const auto& ${sourceList} = ${sources.cpp}; ` +
                    `std::vector<bbl::SpriteAtlasFramePixelsView> ${normalized}; ` +
                    `${normalized}.reserve(${sourceList}.size()); ` +
                    `for (const auto& ${source} : ${sourceList}) { ` +
                    `${normalized}.push_back(bbl::SpriteAtlasFramePixelsView{` +
                    `${access("pixels")}.data(), ${access("pixels")}.size(), ` +
                    `bbl::js::to_uint32(${access("width")}), ` +
                    `bbl::js::to_uint32(${access("height")}), ` +
                    `${optionalUnsigned("srcX", "0u")}, ` +
                    `${optionalUnsigned("srcY", "0u")}, ` +
                    `${optionalUnsigned("srcStrideBytes", "0u")}, ` +
                    `(${pivot} ? bbl::Vec2{static_cast<float>((*${pivot})[0]), ` +
                    `static_cast<float>((*${pivot})[1])} : bbl::Vec2{0.5f, 0.5f})}); } ` +
                    `return bbl::create_sprite_atlas_from_frames(${engine.cpp}, ${normalized}, ` +
                    `bbl::SpriteAtlasPackOptions{` +
                    `${numberOption("paddingPx", "1u")}, ` +
                    `${numberOption("maxWidthPx", "1024u")}, ` +
                    `bbl::TextureFilter::${sampling?.staticString === "linear" ? "linear" : "nearest"}, ` +
                    `${premultiplied?.cpp ?? "false"}, ` +
                    `${capacityLanes ? "true" : "false"}, ` +
                    `${capacityLanes ? `bbl::js::to_uint32(${capacityLanes[0]!})` : "0u"}, ` +
                    `${capacityLanes ? `bbl::js::to_uint32(${capacityLanes[1]!})` : "0u"}}); }())`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createGridSpriteAtlas": {
            context.expectArgumentCount(call, 2, 2);
            const texture = context.compileValue(call.arguments[0]!);
            context.expectKind(texture, "texture", call.arguments[0]!);
            if (
                texture.textureStorage !== "file" &&
                texture.textureStorage !== "pixels" &&
                texture.textureStorage !== "render"
            ) {
                context.fail(
                    call.arguments[0]!,
                    "createGridSpriteAtlas currently requires a file, pixels, or render texture.",
                );
            }
            const options = optionsRecord(
                context,
                call.arguments[1],
                "createGridSpriteAtlas",
            );
            const cellWidth = property(options, "cellWidthPx");
            const cellHeight = property(options, "cellHeightPx");
            if (!cellWidth || !cellHeight) {
                context.fail(
                    call.arguments[1]!,
                    "createGridSpriteAtlas requires cellWidthPx and cellHeightPx.",
                );
            }
            const columns = property(options, "columns");
            const rows = property(options, "rows");
            const margin = property(options, "marginPx");
            const spacing = property(options, "spacingPx");
            const pivot = tupleOption(
                context,
                options,
                "pivot",
                call,
                2,
            );
            const premultiplied = property(
                options,
                "premultipliedAlpha",
            );
            const engine =
                texture.engineCpp ?? context.requireDefaultEngine(call);
            const numberValue = (
                value: Value,
                name: string,
            ): string => {
                if (
                    value.kind !== "number" &&
                    !(
                        value.kind === "data" &&
                        value.dataType?.kind === "number"
                    )
                ) {
                    context.fail(
                        call.arguments[1]!,
                        `createGridSpriteAtlas ${name} must be numeric.`,
                    );
                }
                return value.cpp;
            };
            context.reachFeature("sprite:2d", call);
            return {
                kind: "sprite-atlas",
                cpp:
                    `bbl::create_grid_sprite_atlas(${engine}, ${texture.cpp}, ` +
                    `bbl::GridSpriteAtlasOptions{` +
                    `${numberValue(cellWidth, "cellWidthPx")}, ` +
                    `${numberValue(cellHeight, "cellHeightPx")}, ` +
                    `${columns ? "true" : "false"}, ` +
                    `${columns ? numberValue(columns, "columns") : "0.0"}, ` +
                    `${rows ? "true" : "false"}, ` +
                    `${rows ? numberValue(rows, "rows") : "0.0"}, ` +
                    `${margin ? numberValue(margin, "marginPx") : "0.0"}, ` +
                    `${spacing ? numberValue(spacing, "spacingPx") : "0.0"}, ` +
                    `${pivot ? `bbl::Vec2{static_cast<float>(${pivot[0]}), static_cast<float>(${pivot[1]})}` : "bbl::Vec2{0.5f, 0.5f}"}, ` +
                    `${premultiplied ? premultiplied.cpp : "false"}})`,
                engineCpp: engine,
            };
        }

        case "loadSpriteAtlas": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const assetPath =
                context.registerSpriteAtlasAsset(
                    call.arguments[1]!,
                );
            const options = optionsRecord(
                context,
                call.arguments[2],
                "loadSpriteAtlas",
            );
            const gridSize = tupleOption(
                context,
                options,
                "gridSize",
                call,
                2,
            );
            if (!gridSize) {
                context.fail(
                    call,
                    "loadSpriteAtlas: gridSize required.",
                );
            }
            if (property(options, "metadataUrl")) {
                context.fail(
                    call,
                    "loadSpriteAtlas: metadataUrl unsupported.",
                );
            }
            // `...options.textureOptions` spreads over the loader's own
            // defaults. Only the address modes are reached; anything else in
            // that record would silently not survive the spread, so it
            // refuses by name.
            const textureOptions = property(options, "textureOptions");
            if (textureOptions) {
                if (textureOptions.kind !== "record") {
                    context.fail(
                        call.arguments[2]!,
                        "loadSpriteAtlas textureOptions must be written as an object literal.",
                    );
                }
                for (const member of Object.keys(
                    textureOptions.recordProperties ?? {},
                )) {
                    if (
                        member !== "addressModeU" &&
                        member !== "addressModeV"
                    ) {
                        context.fail(
                            call.arguments[2]!,
                            `loadSpriteAtlas textureOptions '${member}' is not lowered.`,
                        );
                    }
                }
            }
            // Each axis is read by name: the loader stamps clamp and the
            // caller's spread replaces it, so an option naming only one axis
            // must not land on the other.
            const addressMode = (
                name: "addressModeU" | "addressModeV",
            ): string => {
                const mode = property(textureOptions, name);
                if (!mode?.staticString) {
                    return "bbl::TextureAddressMode::clamp";
                }
                const mapped = addressModeByPin[mode.staticString];
                if (!mapped) {
                    context.fail(
                        call.arguments[2]!,
                        `loadSpriteAtlas ${name} '${mode.staticString}' is not a pinned address mode.`,
                    );
                }
                return `bbl::${mapped}`;
            };
            const sampling = property(options, "sampling");
            if (
                sampling &&
                sampling.staticString !== "linear" &&
                sampling.staticString !== "nearest"
            ) {
                context.fail(
                    call.arguments[2]!,
                    "loadSpriteAtlas sampling must be the literal \"linear\" or \"nearest\".",
                );
            }
            const premultipliedAlpha = property(
                options,
                "premultipliedAlpha",
            );
            const premultiplyOnLoad = property(
                options,
                "premultiplyOnLoad",
            );
            context.reachFeature("sprite:2d", call);
            return {
                kind: "sprite-atlas",
                cpp:
                    `bbl::load_sprite_atlas(${engine.cpp}, ` +
                    `bbl::asset_path(${assetPath}), ` +
                    `bbl::LoadSpriteAtlasOptions{` +
                    `${gridSize[0]!}, ` +
                    `${gridSize[1]!}, ` +
                    `bbl::TextureFilter::${
                        sampling?.staticString === "nearest"
                            ? "nearest"
                            : "linear"
                    }, ` +
                    `${premultipliedAlpha?.cpp ?? "false"}, ` +
                    `${premultiplyOnLoad?.cpp ?? "false"}, ` +
                    `${addressMode("addressModeU")}, ` +
                    `${addressMode("addressModeV")}})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createSprite2DLayer": {
            context.expectArgumentCount(call, 1, 2);
            const atlas = context.compileSpriteAtlas(
                call.arguments[0]!,
            );
            context.expectKind(
                atlas,
                "sprite-atlas",
                call.arguments[0]!,
            );
            const options = optionsRecord(
                context,
                call.arguments[1],
                "createSprite2DLayer",
            );
            const depth = property(options, "depth");
            if (
                depth &&
                !["none", "test", "test-write"].includes(
                    depth.staticString ?? "",
                )
            ) {
                context.fail(
                    call.arguments[1]!,
                    'createSprite2DLayer depth must be "none", "test", or "test-write".',
                );
            }
            for (const unreached of ["view"]) {
                if (property(options, unreached)) {
                    context.fail(
                        call.arguments[1]!,
                        `createSprite2DLayer option '${unreached}' is not lowered.`,
                    );
                }
            }
            // One of the pin's own exported descriptors, resolved by the
            // name the scene imported. `spriteBlendOpaque` names no colour
            // blend at all, which the 2D pipeline expresses by disabling
            // blending.
            const blendCpp = blendOption(
                context,
                options,
                "sprite",
                call.arguments[1] ?? call,
            );
            const pivot = tupleOption(
                context,
                options,
                "pivot",
                call,
                2,
            );
            const custom = customShaderOption(
                context,
                options,
                "sprite",
                call.arguments[1] ?? call,
            );
            const engineCpp =
                atlas.engineCpp ??
                context.requireDefaultEngine(call);
            const depthMode = (depth?.staticString ?? "none") as NonNullable<
                Value["spriteDepthMode"]
            >;
            context.reachFeature("sprite:2d", call);
            return {
                kind: "sprite-layer",
                cpp:
                    `bbl::create_sprite_2d_layer(${engineCpp}, ` +
                    `${atlas.cpp}, bbl::Sprite2DLayerOptions{` +
                    `${numberOption(options, "capacity", "16.0f")}, ` +
                    `${blendCpp}, ` +
                    `${numberOption(options, "opacity", "1.0f")}, ` +
                    `${property(options, "visible")?.cpp ?? "true"}, ` +
                    `${numberOption(options, "order", "0.0f")}, ` +
                    `bbl::Sprite2DDepthMode::${
                        depthMode === "test-write"
                            ? "test_write"
                            : depthMode
                    }, ` +
                    `${numberOption(options, "layerZ", "0.5f")}, ` +
                    `bbl::Vec2{${
                        pivot
                            ? `${pivot[0]!}, ${pivot[1]!}`
                            : "0.5f, 0.5f"
                    }}, ` +
                    `${custom.program}, ${custom.textures}, ` +
                    `${custom.textureNames}})`,
                engineCpp,
                spriteDepthMode: depthMode,
            };
        }

        case "addSprite2DIndex": {
            context.expectArgumentCount(call, 2, 2);
            const layer = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                layer,
                "sprite-layer",
                call.arguments[0]!,
            );
            const props = optionsRecord(
                context,
                call.arguments[1],
                "addSprite2DIndex",
            );
            const engineCpp =
                layer.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:2d", call);
            return {
                kind: "number",
                cpp:
                    `bbl::add_sprite_2d_index(${engineCpp}, ` +
                    `${layer.cpp}, ${sprite2DPropsCpp(
                        context,
                        props,
                        call,
                        "addSprite2DIndex",
                    )})`,
                engineCpp,
            };
        }

        case "addSprite2D": {
            // The pin's handle is a stable id over a moving index, kept in
            // step with the layer's own swap-remove. That indirection is
            // load-bearing here too: an animation that outlives another
            // sprite's removal would otherwise drive whichever sprite the
            // swap moved into its slot.
            context.expectArgumentCount(call, 2, 2);
            const layer = context.compileValue(call.arguments[0]!);
            context.expectKind(layer, "sprite-layer", call.arguments[0]!);
            const props = optionsRecord(
                context,
                call.arguments[1],
                "addSprite2D",
            );
            const engineCpp =
                layer.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:2d", call);
            return {
                kind: "sprite-2d-handle",
                cpp:
                    "bbl::add_sprite_2d(" +
                    engineCpp +
                    ", " +
                    layer.cpp +
                    ", " +
                    sprite2DPropsCpp(
                        context,
                        props,
                        call,
                        "addSprite2D",
                    ) +
                    ")",
                engineCpp,
                spriteLayerCpp: layer.cpp,
            };
        }

        case "updateSprite2DIndex": {
            // The patch is a `Partial<Sprite2DProps>`: every field the
            // caller omits keeps the value the slot already holds, which is
            // why this arm records which fields were supplied rather than
            // resolving defaults here.
            context.expectArgumentCount(call, 3, 3);
            const layer = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                layer,
                "sprite-layer",
                call.arguments[0]!,
            );
            // `addSprite2DIndex` hands the index back as a JavaScript
            // number and the pin's range check compares it as one, so it
            // travels at that width rather than rounding at the call.
            const index = context.compileNumber(
                call.arguments[1]!,
                "double",
            );
            const engineCpp =
                layer.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:2d", call);
            const options = call.arguments[2]!;
            const updateCpp = (expression: ts.Expression): string => {
                const props = optionsRecord(
                    context,
                    expression,
                    "updateSprite2DIndex",
                );
                return (
                    `bbl::update_sprite_2d_index(${engineCpp}, ` +
                    `${layer.cpp}, ${index}, ${sprite2DPropsCpp(
                        context,
                        props,
                        call,
                        "updateSprite2DIndex",
                    )})`
                );
            };
            const unwrappedOptions = context.unwrap(options);
            if (ts.isConditionalExpression(unwrappedOptions)) {
                const condition = context.compileCondition(
                    unwrappedOptions.condition,
                );
                return {
                    kind: "void",
                    cpp:
                        `(${condition} ? ` +
                        `${updateCpp(unwrappedOptions.whenTrue)} : ` +
                        `${updateCpp(unwrappedOptions.whenFalse)})`,
                    engineCpp,
                };
            }
            return {
                kind: "void",
                cpp: updateCpp(options),
                engineCpp,
            };
        }

        case "createSpriteAnimationManager": {
            context.expectArgumentCount(call, 0, 1);
            if (call.arguments[0]) {
                // `{}` is legal upstream and means the defaults, so the
                // refusal names the FIELDS rather than the argument.
                validateObjectProperties(
                    context,
                    optionsLiteral(context, call.arguments[0]),
                    [],
                    "createSpriteAnimationManager's options are unreached: " +
                        "fixedDeltaMs overrides the caller's own step, and " +
                        "onUpdate is a per-tick callback of the autonomous " +
                        "loop this port does not run.",
                );
            }
            const engineCpp = context.requireDefaultEngine(call);
            context.reachFeature("sprite:animation", call);
            return {
                kind: "sprite-animation-manager",
                cpp:
                    "bbl::upstream::create_sprite_animation_manager(" +
                    engineCpp +
                    ")",
                engineCpp,
            };
        }

        case "playSprite2DAnimation":
        case "playBillboardSpriteAnimation": {
            // The two adapters differ only in which family names the sprite:
            // upstream builds a closure triple over the handle, and the
            // target record here is that same decoupling as data.
            const sprite2d = importedName === "playSprite2DAnimation";
            context.expectArgumentCount(call, 6, 7);
            const manager = context.compileValue(call.arguments[0]!);
            context.expectKind(
                manager,
                "sprite-animation-manager",
                call.arguments[0]!,
            );
            const target = context.compileValue(call.arguments[1]!);
            context.expectKind(
                target,
                sprite2d ? "sprite-2d-handle" : "billboard-sprite",
                call.arguments[1]!,
            );
            const number = (index: number): string =>
                context.compileNumber(call.arguments[index]!, "double");
            const loop = context.compileCondition(call.arguments[4]!);
            const options = optionsRecord(
                context,
                call.arguments[6],
                importedName,
            );
            if (property(options, "onEnd")) {
                context.fail(
                    call.arguments[6]!,
                    importedName +
                        "'s onEnd callback is unreached: a native animation " +
                        "has no place to run scene code as it finishes.",
                );
            }
            const removeWhenFinishedValue = property(
                options,
                "removeWhenFinished",
            );
            const removeWhenFinished = removeWhenFinishedValue
                ? removeWhenFinishedValue.cpp
                : "false";
            if (
                removeWhenFinished !== "true" &&
                removeWhenFinished !== "false"
            ) {
                context.fail(
                    call.arguments[6]!,
                    importedName +
                        "'s removeWhenFinished decides whether the sprite " +
                        "survives its own animation, so it must settle at " +
                        "generation rather than read as false.",
                );
            }
            const engineCpp =
                manager.engineCpp ?? context.requireDefaultEngine(call);
            if (sprite2d && target.spriteLayerCpp === undefined) {
                context.fail(
                    call.arguments[1]!,
                    "A Sprite2D animation target carries the layer it lives " +
                        "in; this handle reached here without one.",
                );
            }
            const targetCpp = sprite2d
                ? "bbl::SpriteAnimationTarget{" +
                  "bbl::SpriteAnimationTargetKind::sprite_2d, " +
                  target.spriteLayerCpp +
                  ", static_cast<std::uint32_t>(" +
                  target.cpp +
                  "), {}}"
                : "bbl::SpriteAnimationTarget{" +
                  "bbl::SpriteAnimationTargetKind::billboard, {}, 0u, " +
                  target.cpp +
                  "}";
            context.reachFeature("sprite:animation", call);
            return {
                kind: "void",
                cpp:
                    "bbl::upstream::play_sprite_frame_animation(" +
                    engineCpp +
                    ", " +
                    manager.cpp +
                    ", " +
                    targetCpp +
                    ", " +
                    number(2) +
                    ", " +
                    number(3) +
                    ", " +
                    loop +
                    ", " +
                    number(5) +
                    ", " +
                    removeWhenFinished +
                    ")",
                engineCpp,
            };
        }

        case "updateSpriteAnimationManager": {
            context.expectArgumentCount(call, 2, 2);
            const manager = context.compileValue(call.arguments[0]!);
            context.expectKind(
                manager,
                "sprite-animation-manager",
                call.arguments[0]!,
            );
            const engineCpp =
                manager.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:animation", call);
            return {
                kind: "void",
                cpp:
                    "bbl::upstream::update_sprite_animation_manager(" +
                    engineCpp +
                    ", " +
                    manager.cpp +
                    ", " +
                    context.compileNumber(call.arguments[1]!, "double") +
                    ")",
                engineCpp,
            };
        }

        case "attachSpriteAnimationsToRenderer":
        case "attachSpriteAnimationsToScene": {
            context.fail(
                call,
                importedName +
                    " installs the stepper on a render loop and hands back " +
                    "a binding that detaches it -- a disposable this port " +
                    "has no owner for. Both corpus scenes write it, in the " +
                    "arm their own `?seekTime=` pose folds away; the arm " +
                    "that survives drives the same stepper from a counted " +
                    "loop, so what is missing is the hook and its binding, " +
                    "not the animation.",
            );
        }

        case "clearSprite2DLayer": {
            context.expectArgumentCount(call, 1, 1);
            const layer = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                layer,
                "sprite-layer",
                call.arguments[0]!,
            );
            const engineCpp =
                layer.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:2d", call);
            return {
                kind: "void",
                cpp: `bbl::clear_sprite_2d_layer(${engineCpp}, ${layer.cpp})`,
                engineCpp,
            };
        }

        case "createFacingBillboardSystem":
        case "createAxisLockedBillboardSystem": {
            // The axis-locked factory takes the lock axis between the atlas
            // and the options.
            const locked =
                importedName === "createAxisLockedBillboardSystem";
            const optionsIndex = locked ? 2 : 1;
            context.expectArgumentCount(
                call,
                optionsIndex,
                optionsIndex + 1,
            );
            const atlas = context.compileSpriteAtlas(
                call.arguments[0]!,
            );
            context.expectKind(
                atlas,
                "sprite-atlas",
                call.arguments[0]!,
            );
            const optionsArg = call.arguments[optionsIndex];
            const options = optionsRecord(
                context,
                optionsArg,
                importedName,
            );
            // Every arm the lowered permutation does not cover refuses
            // here, so a scene reaching one gets a message naming it
            // rather than a plausible wrong image.
            // The blend is one of the pin's own exported descriptors,
            // resolved by the name the scene imported: `billboardBlendAlpha`
            // is `billboard_blend_alpha()`. `cutout` carries no colour blend
            // and drives an alpha-test depth-write path this slice does not
            // render, so it refuses rather than drawing the wrong one.
            const blendCpp = blendOption(
                context,
                options,
                "billboard",
                optionsArg ?? call,
            );
            const custom = customShaderOption(
                context,
                options,
                "billboard",
                optionsArg ?? call,
            );

            // `order` sorts a system against the scene's other transparent
            // renderables upstream. A system here draws in the slot its depth
            // mode gives it, which is the same image only while nothing else
            // is transparent, so an explicit order refuses rather than being
            // silently dropped.
            for (const unreached of ["order"]) {
                if (property(options, unreached)) {
                    context.fail(
                        optionsArg ?? call,
                        `${importedName} option '${unreached}' is not lowered.`,
                    );
                }
            }
            // The raw axis: the pin normalises it inside the factory and
            // rejects a degenerate one there, so that stays lowered rather
            // than recomputed at the call site.
            const axisCpp = locked
                ? context.compileVec3(call.arguments[1]!)
                : "bbl::Vec3{0.0f, 0.0f, 0.0f}";
            const engineCpp =
                atlas.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            if (locked) {
                context.reachFeature(
                    "sprite:billboard-axis-locked",
                    call,
                );
            }
            return {
                kind: "billboard-system",
                // The record is spelled as a full C++20 designated
                // initializer: each value pairs to its field by name (a
                // renamed or reordered header field fails the build
                // instead of silently shifting a positional list), and
                // every member is stated so none rides a header default
                // this call site never wrote. The unnamed options carry
                // the pinned factory defaults; the second-pass blend is
                // the node-particle enabler's arm and stays empty here.
                cpp:
                    `bbl::create_billboard_system(${engineCpp}, ` +
                    `${atlas.cpp}, bbl::BillboardOrientation::` +
                    `${locked ? "axis_locked" : "facing"}, ${axisCpp}, ` +
                    `bbl::BillboardSystemOptions{` +
                    `.capacity = ${numberOption(options, "capacity", "16.0f")}, ` +
                    `.blend = ${blendCpp}, ` +
                    `.opacity = ${numberOption(options, "opacity", "1.0f")}, ` +
                    `.visible = ${property(options, "visible")?.cpp ?? "true"}, ` +
                    // resolveAlphaCutoff and the order default both follow
                    // the descriptor's own depth mode, so they are resolved
                    // beside it rather than from the name at this call site.
                    `.alpha_cutoff = ${numberOption(options, "alphaCutoff", "0.0f")}, ` +
                    `.has_alpha_cutoff = ${property(options, "alphaCutoff") ? "true" : "false"}, ` +
                    `.custom_shader = ${custom.program}, ` +
                    `.custom_textures = ${custom.textures}, ` +
                    `.custom_texture_names = ${custom.textureNames}, ` +
                    `.add_pass_blend = bbl::SpriteBlendDescriptor{}})`,
                engineCpp,
            };
        }

        case "addBillboardSpriteIndex": {
            context.expectArgumentCount(call, 2, 2);
            const system = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                system,
                "billboard-system",
                call.arguments[0]!,
            );
            const props = optionsRecord(
                context,
                call.arguments[1],
                "addBillboardSpriteIndex",
            );
            const engineCpp =
                system.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            return {
                kind: "number",
                cpp:
                    `bbl::add_billboard_sprite_index(${engineCpp}, ` +
                    `${system.cpp}, ` +
                    `${billboardPropsCpp(context, props, call, "addBillboardSpriteIndex")})`,
                engineCpp,
            };
        }

        case "addBillboardSprite": {
            context.expectArgumentCount(call, 2, 2);
            const system = context.compileValue(call.arguments[0]!);
            context.expectKind(system, "billboard-system", call.arguments[0]!);
            const props = optionsRecord(
                context,
                call.arguments[1],
                "addBillboardSprite",
            );
            const engineCpp =
                system.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            return {
                kind: "billboard-sprite",
                cpp:
                    `bbl::add_billboard_sprite(${engineCpp}, ${system.cpp}, ` +
                    `${billboardPropsCpp(context, props, call, "addBillboardSprite")})`,
                engineCpp,
            };
        }

        case "updateBillboardSprite": {
            context.expectArgumentCount(call, 2, 2);
            const handle = context.compileValue(call.arguments[0]!);
            context.expectKind(handle, "billboard-sprite", call.arguments[0]!);
            const props = optionsRecord(
                context,
                call.arguments[1],
                "updateBillboardSprite",
            );
            const engineCpp =
                handle.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            return {
                kind: "void",
                cpp:
                    `bbl::update_billboard_sprite(${engineCpp}, ${handle.cpp}, ` +
                    `${billboardPropsCpp(context, props, call, "updateBillboardSprite")})`,
            };
        }

        case "removeBillboardSprite": {
            context.expectArgumentCount(call, 1, 1);
            const handle = context.compileValue(call.arguments[0]!);
            context.expectKind(handle, "billboard-sprite", call.arguments[0]!);
            const engineCpp =
                handle.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            return {
                kind: "void",
                cpp: `bbl::remove_billboard_sprite(${engineCpp}, ${handle.cpp})`,
            };
        }

        case "clearBillboardSprites": {
            context.expectArgumentCount(call, 1, 1);
            const system = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                system,
                "billboard-system",
                call.arguments[0]!,
            );
            const engineCpp =
                system.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            return {
                kind: "void",
                cpp: `bbl::clear_billboard_sprites(${engineCpp}, ${system.cpp})`,
            };
        }

        case "createTexture2DFromPixels": {
            context.expectArgumentCount(call, 4, 5);
            const engine = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            // A zero-argument module producer remains bakeable. A reached
            // runtime Uint8Array instead travels directly to the native
            // factory, preserving WAD/decoded/generated pixel workflows.
            const bakedPixels = context.probePixelsAsset(
                call.arguments[1]!,
            );
            const runtimePixels = bakedPixels
                ? undefined
                : context.compileValue(call.arguments[1]!);
            if (
                runtimePixels &&
                !(
                    runtimePixels.kind === "data" &&
                    runtimePixels.dataType?.kind === "u8array"
                )
            ) {
                context.fail(
                    call.arguments[1]!,
                    "createTexture2DFromPixels pixels must run at generation through a bakeable module producer or evaluate to a native Uint8Array.",
                );
            }
            const width = context.compileNumber(
                call.arguments[2]!,
                "double",
            );
            const height = context.compileNumber(
                call.arguments[3]!,
                "double",
            );
            // The pin's sampler overrides. Each travels as "named, and this
            // value", because the factory resolves `?? default` where
            // upstream resolves it. `srgb` picks a second texture format and
            // no reached call passes one, so it refuses by name.
            const sampler = pixelsSamplerOptions(
                context,
                call.arguments[4],
            );
            const staticSize = [
                staticNumberValue(context, call.arguments[2]!),
                staticNumberValue(context, call.arguments[3]!),
            ];
            context.reachFeature("texture:pixels", call);
            return {
                kind: "texture",
                textureStorage: "pixels",
                cpp:
                    `bbl::create_texture_2d_from_pixels(${engine.cpp}, ` +
                    `${bakedPixels ? `bbl::asset_path(${bakedPixels.cpp})` : runtimePixels!.cpp}, ${width}, ${height}` +
                    `${sampler.cpp})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
                // A node-particle system's texture is assigned in scene
                // code, and the bake driver has to build the same one to
                // see the size the pin partitions its atlas by. A size the
                // source does not settle carries no record at all, so the
                // refusal lands at the assignment that needed one rather
                // than at every pixels texture in the corpus.
                ...(bakedPixels &&
                staticSize[0] !== undefined &&
                staticSize[1] !== undefined
                    ? {
                          pixelsTexture: {
                               source: bakedPixels.source,
                               asset: bakedPixels.cpp,
                              width: staticSize[0],
                              height: staticSize[1],
                              options: sampler.named,
                          },
                      }
                    : {}),
            };
        }

        case "createSprite2DCustomShader":
        case "createBillboardCustomShader": {
            context.expectArgumentCount(call, 1, 1);
            const options = optionsRecord(
                context,
                call.arguments[0],
                importedName,
            );
            const fragment = property(options, "fragment");
            // The pin takes the body as an opaque string it splices into
            // its own composer, so it has to be settled here: a body built
            // at run time would have no program to compile against.
            if (
                fragment?.kind !== "string" ||
                fragment.staticString === undefined
            ) {
                context.fail(
                    call.arguments[0] ?? call,
                    `${importedName}: 'fragment' must be a WGSL string literal.`,
                );
            }
            if (fragment.staticString.trim().length === 0) {
                context.fail(
                    call.arguments[0] ?? call,
                    `${importedName}: 'fragment' must be a non-empty WGSL string.`,
                );
            }
            // Each extra texture adds the binding pair the pin emits ahead
            // of the fx block: `<name>Tex` and `<name>Samp`, in the order
            // given. The name is compile-time (it is spliced into WGSL) and
            // the texture is a runtime value the layer binds.
            const extras = extraTextureOption(
                context,
                options,
                importedName,
                call.arguments[0] ?? call,
            );
            const family =
                importedName === "createSprite2DCustomShader"
                    ? "sprite"
                    : "billboard";
            const extraNames = extras.map(({ name }) => name);
            const familyShaders = context
                .spriteCustomShaders()
                .filter((entry) => entry.family === family);
            const existingIndex = familyShaders.findIndex(
                (entry) =>
                    entry.fragment === fragment.staticString &&
                    entry.extraTextures.join("\0") === extraNames.join("\0"),
            );
            if (family === "billboard" && familyShaders.length > 0 && existingIndex < 0) {
                context.fail(
                    call,
                    "A second distinct billboard custom shader is not lowered.",
                );
            }
            // Building a descriptor is the pin's own opt-in trigger: the
            // factory is what registers the fx hook the always-loaded path
            // reaches the feature through, so reaching it here is what
            // composes the program and binds the fx block.
            context.reachFeature(
                family === "sprite"
                    ? "sprite:custom-shader"
                    : "sprite:billboard-custom-shader",
                call,
            );
            if (existingIndex < 0) {
                context.recordSpriteCustomShader({
                    family,
                    fragment: fragment.staticString,
                    extraTextures: extraNames,
                });
            }
            return {
                kind: `${family}-custom-shader`,
                cpp: "",
                spriteCustomShaderIndex:
                    existingIndex >= 0
                        ? existingIndex + 1
                        : familyShaders.length + 1,
                spriteCustomTextures: extras.map(
                    ({ cpp }) => cpp,
                ),
                spriteCustomTextureNames: extraNames,
            };
        }

        case "setSprite2DShaderParams":
        case "setBillboardShaderParams": {
            context.expectArgumentCount(call, 2, 2);
            const target = context.compileValue(call.arguments[0]!);
            const sprite =
                importedName === "setSprite2DShaderParams";
            context.expectKind(
                target,
                sprite ? "sprite-layer" : "billboard-system",
                call.arguments[0]!,
            );
            const params = context.compileVec4(call.arguments[1]!);
            const engineCpp =
                target.engineCpp ??
                context.requireDefaultEngine(call);
            context.emit(
                `bbl::${
                    sprite
                        ? "set_sprite_2d_shader_params"
                        : "set_billboard_shader_params"
                }(${engineCpp}, ${target.cpp}, ${params});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "setAlphaToCoverage": {
            context.expectArgumentCount(call, 2, 2);
            const target = context.compileValue(call.arguments[0]!);
            if (
                target.kind !== "billboard-system" &&
                target.kind !== "sprite-layer"
            ) {
                context.fail(
                    call.arguments[0]!,
                    "setAlphaToCoverage supports billboard systems and Sprite2D layers.",
                );
            }
            const enabled = context.compileBoolean(
                call.arguments[1]!,
            );
            const engineCpp =
                target.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature(
                target.kind === "sprite-layer"
                    ? "sprite:2d"
                    : "sprite:billboard",
                call,
            );
            context.emit(
                `bbl::${
                    target.kind === "sprite-layer"
                        ? "set_sprite_2d_alpha_to_coverage"
                        : "set_billboard_alpha_to_coverage"
                }(${engineCpp}, ${target.cpp}, ${enabled});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "addDepthHostedSpriteLayer": {
            context.expectArgumentCount(call, 2, 2);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            const layer = context.compileValue(call.arguments[1]!);
            context.expectKind(layer, "sprite-layer", call.arguments[1]!);
            if (layer.spriteDepthMode === "none") {
                context.fail(
                    call.arguments[1]!,
                    'Depth-hosted sprites require depth != "none".',
                );
            }
            context.expectSameEngine(scene, layer, call);
            context.reachFeature("sprite:2d", call);
            context.reachFeature("sprite:2d-depth-host", call);
            context.reachFeature("renderer:sprite", call);
            context.reachFeature("renderer:scene", call);
            context.emit(
                `bbl::add_depth_hosted_sprite_layer(${scene.cpp}, ${layer.cpp});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "addFacingBillboardSystem":
        case "addAxisLockedBillboardSystem": {
            context.expectArgumentCount(call, 2, 2);
            const scene = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(scene, "scene", call.arguments[0]!);
            const system = context.compileValue(
                call.arguments[1]!,
            );
            context.expectKind(
                system,
                "billboard-system",
                call.arguments[1]!,
            );
            context.reachFeature("sprite:billboard", call);
            // A billboard system is a scene renderable: it draws inside the
            // scene renderer's own pass, against its camera and depth. A
            // scene of nothing but billboards still needs that pass, the way
            // a render target does.
            context.reachFeature("renderer:scene", call);
            context.emit(
                `bbl::add_billboard_system(${scene.cpp}, ${system.cpp});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "setSprite2DUvOffset": {
            context.expectArgumentCount(call, 3, 3);
            const layer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                layer,
                "sprite-layer",
                call.arguments[0]!,
            );
            const index = context.compileNumber(call.arguments[1]!);
            const offset = context.compileVec2(call.arguments[2]!);
            const engineCpp =
                layer.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:2d", call);
            // Importing the setter is the pin's own opt-in trigger for the
            // widened layout, so reaching it here is what selects the
            // widened attribute row and the shader that reads it.
            context.reachFeature("sprite:uv-scroll", call);
            context.emit(
                `bbl::set_sprite_2d_uv_offset(${engineCpp}, ${layer.cpp}, ${index}, ${offset});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "createSpriteRenderer": {
            context.expectArgumentCount(call, 2, 2);
            const surface = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                surface,
                "engine",
                call.arguments[0]!,
            );
            const options = optionsRecord(
                context,
                call.arguments[1],
                "createSpriteRenderer",
            );
            const layers = property(options, "layers");
            const tupleLayers =
                layers?.kind === "tuple"
                    ? layers.tupleElements
                    : undefined;
            const dataLayers =
                layers?.kind === "data" &&
                layers.dataType?.kind === "vector" &&
                layers.dataType.element.kind === "handle" &&
                layers.dataType.element.handle === "sprite-layer";
            if (!tupleLayers && !dataLayers) {
                context.fail(
                    call.arguments[1]!,
                    "createSpriteRenderer requires an array of layers.",
                );
            }
            // An empty list is the pin's own shape for a renderer whose
            // layers arrive later: a node-particle bridge owns and attaches
            // one per system, so the scene builds the renderer with none.
            for (const layer of tupleLayers ?? []) {
                context.expectKind(
                    layer,
                    "sprite-layer",
                    call.arguments[1]!,
                );
                rejectDepthHostedStandaloneLayer(
                    context,
                    layer,
                    call.arguments[1]!,
                );
            }
            const clearValue = tupleClearValue(
                context,
                options,
                call,
            );
            context.reachFeature("sprite:2d", call);
            context.reachFeature("renderer:sprite", call);
            context.recordPureSpriteVertex();
            return {
                kind: "sprite-renderer",
                cpp:
                    `bbl::create_sprite_renderer(${surface.cpp}, ` +
                    `bbl::SpriteRendererOptions{${dataLayers ? spriteLayerVectorCpp(layers!) : `{${(tupleLayers ?? []).map((layer) => layer.cpp).join(", ")}}`}, ` +
                    `${property(options, "clear")?.cpp ?? "true"}, ` +
                    `${clearValue}})`,
                engineCpp:
                    surface.engineCpp ?? surface.cpp,
            };
        }

        case "registerSpriteRenderer": {
            context.expectArgumentCount(call, 1, 1);
            const renderer = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                renderer,
                "sprite-renderer",
                call.arguments[0]!,
            );
            context.reachFeature("renderer:sprite", call);
            return {
                kind: "void",
                cpp: `bbl::register_sprite_renderer(${
                    renderer.engineCpp ??
                    context.requireDefaultEngine(call)
                }, ${renderer.cpp})`,
            };
        }

        case "unregisterSpriteRenderer": {
            context.expectArgumentCount(call, 1, 1);
            const renderer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                renderer,
                "sprite-renderer",
                call.arguments[0]!,
            );
            context.reachFeature("renderer:sprite", call);
            return {
                kind: "void",
                cpp: `bbl::unregister_sprite_renderer(${renderer.engineCpp ?? context.requireDefaultEngine(call)}, ${renderer.cpp})`,
            };
        }

        case "setSpriteRendererTarget": {
            context.expectArgumentCount(call, 2, 2);
            const renderer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                renderer,
                "sprite-renderer",
                call.arguments[0]!,
            );
            const target = context.compileValue(call.arguments[1]!);
            const absent = target.kind === "json-null";
            if (!absent && target.textureStorage !== "render") {
                context.fail(
                    call.arguments[1]!,
                    "setSpriteRendererTarget requires a createRenderTexture2D texture or null.",
                );
            }
            context.reachFeature("renderer:sprite", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_sprite_renderer_target(` +
                    `${renderer.engineCpp ?? context.requireDefaultEngine(call)}, ` +
                    `${renderer.cpp}, ` +
                    `${absent ? "bbl::SpriteRenderTextureHandle{}" : target.cpp}, ` +
                    `${absent ? "false" : "true"})`,
            };
        }

        case "addSpriteRendererLayer":
        case "removeSpriteRendererLayer": {
            // Both take (renderer, layer) and both move the renderer's layer
            // list, which each backend rebuilds its pass from. `remove`
            // returns whether the layer was a member; a scene that reads it
            // gets that boolean, and one that ignores it emits a statement.
            context.expectArgumentCount(call, 2, 2);
            const renderer = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                renderer,
                "sprite-renderer",
                call.arguments[0]!,
            );
            const layer = context.compileValue(
                call.arguments[1]!,
            );
            context.expectKind(
                layer,
                "sprite-layer",
                call.arguments[1]!,
            );
            const engineCpp =
                renderer.engineCpp ??
                layer.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("renderer:sprite", call);
            const removes =
                importedName === "removeSpriteRendererLayer";
            if (!removes) {
                rejectDepthHostedStandaloneLayer(
                    context,
                    layer,
                    call.arguments[1]!,
                );
            }
            const cpp =
                `bbl::${
                    removes
                        ? "remove_sprite_renderer_layer"
                        : "add_sprite_renderer_layer"
                }(${engineCpp}, ${renderer.cpp}, ${layer.cpp})`;
            return {
                kind: removes ? "boolean" : "void",
                cpp,
                engineCpp,
            };
        }

        case "disposeSpriteRenderer": {
            context.expectArgumentCount(call, 1, 1);
            const renderer = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                renderer,
                "sprite-renderer",
                call.arguments[0]!,
            );
            context.reachFeature("renderer:sprite", call);
            return {
                kind: "void",
                cpp: `bbl::dispose_sprite_renderer(${
                    renderer.engineCpp ??
                    context.requireDefaultEngine(call)
                }, ${renderer.cpp})`,
            };
        }

        default:
            return undefined;
    }
}

/**
 * A depth-enabled layer draws inside a scene pass, never in the standalone
 * SpriteRenderer pass that has no scene depth attachment.
 */
function rejectDepthHostedStandaloneLayer(
    context: SpriteIntrinsicContext,
    layer: Value,
    node: ts.Node,
): void {
    if (
        layer.spriteDepthMode &&
        layer.spriteDepthMode !== "none"
    ) {
        context.fail(
            node,
            'SpriteRenderer layers require depth: "none"; attach depth-enabled layers to a scene.',
        );
    }
}

/** `clearValue: { r, g, b, a }`, defaulting to the pinned opaque black. */
function tupleClearValue(
    context: SpriteIntrinsicContext,
    options: Value | undefined,
    call: ts.CallExpression,
): string {
    const value = options?.recordProperties?.clearValue;
    if (!value) {
        return "bbl::Color4{0.0f, 0.0f, 0.0f, 1.0f}";
    }
    if (value.kind !== "record") {
        context.fail(
            call,
            "createSpriteRenderer clearValue must be an object literal.",
        );
    }
    const channel = (name: string, fallback: string): string => {
        const component = value.recordProperties?.[name];
        return component
            ? `static_cast<float>(${component.cpp})`
            : fallback;
    };
    return (
        `bbl::Color4{${channel("r", "0.0f")}, ` +
        `${channel("g", "0.0f")}, ${channel("b", "0.0f")}, ` +
        `${channel("a", "1.0f")}}`
    );
}
