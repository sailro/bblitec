import ts from "typescript";
import type {
    SpriteCustomShaderManifest,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    isDataTuple,
    tupleComponents,
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

export interface SpriteIntrinsicContext
    extends IntrinsicCallContext,
        PositiveIntegerContext {
    requireDefaultEngine(node: ts.Node): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileVec2(expression: ts.Expression): string;
    compileVec4(expression: ts.Expression): string;
    registerSpriteAtlasAsset(
        expression: ts.Expression,
    ): string;
    registerPixelsAsset(
        expression: ts.Expression,
    ): { cpp: string; source: string };
    allocateTemporaryCppName(label: string): string;
    /** One layer or system built without a custom shader, so with the stock program. */
    recordPlainSpriteProgram(family: "sprite" | "billboard"): void;
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
 * The two fields a `customShader` option settles on the record: whether
 * there is a descriptor, and the extra textures it binds.
 *
 * The pin's own hook copies the descriptor onto the layer or system and
 * every later read goes through it, so the program itself is composed once
 * per family and what the record carries is only this pair. The family is
 * checked because a 2D descriptor names a fragment written against a varying
 * struct carrying `uv` and `tint` alone, which a billboard stage would
 * compile against a different contract behind the same names.
 */
function customShaderOption(
    context: SpriteIntrinsicContext,
    options: Value | undefined,
    family: "sprite" | "billboard",
    node: ts.Node,
): { present: string; textures: string } {
    const named = property(options, "customShader");
    if (!named) {
        context.recordPlainSpriteProgram(family);
        return { present: "false", textures: "{}" };
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
    return {
        present: "true",
        textures: `{${named.spriteCustomTextures.join(", ")}}`,
    };
}

/**
 * Reads an options record written as an object literal at the call site.
 * Babylon Lite's sprite entry points all take one, and every reached call
 * writes it inline, so the record is the compile-time thing it looks like.
 */
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

export function compileSpriteIntrinsic(
    context: SpriteIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
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
            const atlas = context.compileValue(
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
                depth.staticString !== "none"
            ) {
                context.fail(
                    call.arguments[1]!,
                    'Only depth: "none" sprite layers are lowered; depth-hosted layers need the scene sprite path.',
                );
            }
            for (const unreached of ["layerZ", "view"]) {
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
                    `bbl::Vec2{${
                        pivot
                            ? `${pivot[0]!}, ${pivot[1]!}`
                            : "0.5f, 0.5f"
                    }}, ` +
                    `${custom.present}, ${custom.textures}})`,
                engineCpp,
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
            const positionPx = tupleOption(
                context,
                props,
                "positionPx",
                call,
                2,
            );
            if (!positionPx) {
                context.fail(
                    call,
                    "addSprite2DIndex: positionPx required.",
                );
            }
            if (property(props, "z")) {
                context.fail(
                    call.arguments[1]!,
                    "Per-sprite z is only stored by depth-hosted layers, which are not lowered.",
                );
            }
            const sizePx = tupleOption(
                context,
                props,
                "sizePx",
                call,
                2,
            );
            const color = tupleOption(
                context,
                props,
                "color",
                call,
                4,
            );
            const frame = property(props, "frame");
            const rotation = property(props, "rotation");
            const flipX = property(props, "flipX");
            const flipY = property(props, "flipY");
            const visible = property(props, "visible");
            const engineCpp =
                layer.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:2d", call);
            return {
                kind: "number",
                cpp:
                    `bbl::add_sprite_2d_index(${engineCpp}, ` +
                    `${layer.cpp}, bbl::Sprite2DProps{` +
                    `bbl::Vec2{${positionPx[0]!}, ${positionPx[1]!}}, ` +
                    `bbl::Vec2{${
                        sizePx
                            ? `${sizePx[0]!}, ${sizePx[1]!}`
                            : "0.0f, 0.0f"
                    }}, ${sizePx ? "true" : "false"}, ` +
                    `${frame ? `static_cast<float>(${frame.cpp})` : "0.0f"}, ` +
                    `${frame ? "true" : "false"}, ` +
                    `${rotation ? `static_cast<float>(${rotation.cpp})` : "0.0f"}, ` +
                    `${rotation ? "true" : "false"}, ` +
                    `bbl::Vec4{${
                        color
                            ? color.join(", ")
                            : "1.0f, 1.0f, 1.0f, 1.0f"
                    }}, ${color ? "true" : "false"}, ` +
                    `${flipX?.cpp ?? "false"}, ${flipX ? "true" : "false"}, ` +
                    `${flipY?.cpp ?? "false"}, ${flipY ? "true" : "false"}, ` +
                    `${visible?.cpp ?? "true"}, ${visible ? "true" : "false"}})`,
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
            const atlas = context.compileValue(
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
                    `.custom_shader = ${custom.present}, ` +
                    `.custom_textures = ${custom.textures}, ` +
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
            const position = tupleOption(
                context,
                props,
                "position",
                call,
                3,
            );
            if (!position) {
                context.fail(
                    call,
                    "addBillboardSpriteIndex: position required.",
                );
            }
            const sizeWorld = tupleOption(
                context,
                props,
                "sizeWorld",
                call,
                2,
            );
            const pivot = tupleOption(
                context,
                props,
                "pivot",
                call,
                2,
            );
            const color = tupleOption(
                context,
                props,
                "color",
                call,
                4,
            );
            const frame = property(props, "frame");
            const rotation = property(props, "rotation");
            const flipX = property(props, "flipX");
            const flipY = property(props, "flipY");
            const visible = property(props, "visible");
            const engineCpp =
                system.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            return {
                kind: "number",
                cpp:
                    `bbl::add_billboard_sprite_index(${engineCpp}, ` +
                    `${system.cpp}, bbl::BillboardSpriteProps{` +
                    `bbl::Vec3{${position.join(", ")}}, ` +
                    `bbl::Vec2{${
                        sizeWorld
                            ? sizeWorld.join(", ")
                            : "0.0f, 0.0f"
                    }}, ${sizeWorld ? "true" : "false"}, ` +
                    `${frame ? `static_cast<float>(${frame.cpp})` : "0.0f"}, ` +
                    `${frame ? "true" : "false"}, ` +
                    `${rotation ? `static_cast<float>(${rotation.cpp})` : "0.0f"}, ` +
                    `${rotation ? "true" : "false"}, ` +
                    `bbl::Vec2{${
                        pivot ? pivot.join(", ") : "0.0f, 0.0f"
                    }}, ${pivot ? "true" : "false"}, ` +
                    `bbl::Vec4{${
                        color
                            ? color.join(", ")
                            : "1.0f, 1.0f, 1.0f, 1.0f"
                    }}, ${color ? "true" : "false"}, ` +
                    `${flipX?.cpp ?? "false"}, ${flipX ? "true" : "false"}, ` +
                    `${flipY?.cpp ?? "false"}, ${flipY ? "true" : "false"}, ` +
                    `${visible?.cpp ?? "true"}, ${visible ? "true" : "false"}})`,
                engineCpp,
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
            // The bytes are a module's own, settled at generation, so they
            // are baked as an asset the way a drawn atlas is.
            const pixels = context.registerPixelsAsset(
                call.arguments[1]!,
            );
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
                cpp:
                    `bbl::create_texture_2d_from_pixels(${engine.cpp}, ` +
                    `bbl::asset_path(${pixels.cpp}), ${width}, ${height}` +
                    `${sampler.cpp})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
                // A node-particle system's texture is assigned in scene
                // code, and the bake driver has to build the same one to
                // see the size the pin partitions its atlas by. A size the
                // source does not settle carries no record at all, so the
                // refusal lands at the assignment that needed one rather
                // than at every pixels texture in the corpus.
                ...(staticSize[0] !== undefined &&
                staticSize[1] !== undefined
                    ? {
                          pixelsTexture: {
                              source: pixels.source,
                              asset: pixels.cpp,
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
            // One program per family is composed, under a fixed name. A
            // second descriptor would need the layer and system records to
            // carry which program they draw with, so it refuses here rather
            // than quietly drawing every layer with the first one.
            if (
                context
                    .spriteCustomShaders()
                    .some((entry) => entry.family === family)
            ) {
                context.fail(
                    call,
                    `A second ${family} custom shader is not lowered; one program per family is composed.`,
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
            context.recordSpriteCustomShader({
                family,
                fragment: fragment.staticString,
                extraTextures: extras.map(({ name }) => name),
            });
            return {
                kind: `${family}-custom-shader`,
                cpp: "",
                spriteCustomTextures: extras.map(
                    ({ cpp }) => cpp,
                ),
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
            // The pin accepts several pipeline owners; only a billboard
            // system is reached, so any other target refuses by name here
            // rather than compiling into a call that cannot exist.
            context.expectKind(
                target,
                "billboard-system",
                call.arguments[0]!,
            );
            const enabled = context.compileBoolean(
                call.arguments[1]!,
            );
            const engineCpp =
                target.engineCpp ??
                context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            context.emit(
                `bbl::set_billboard_alpha_to_coverage(${engineCpp}, ${target.cpp}, ${enabled});`,
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
            context.reachFeature("renderer:pbr", call);
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
            if (layers?.kind !== "tuple" || !layers.tupleElements) {
                context.fail(
                    call.arguments[1]!,
                    "createSpriteRenderer requires an array of layers.",
                );
            }
            // An empty list is the pin's own shape for a renderer whose
            // layers arrive later: a node-particle bridge owns and attaches
            // one per system, so the scene builds the renderer with none.
            for (const layer of layers.tupleElements) {
                context.expectKind(
                    layer,
                    "sprite-layer",
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
            return {
                kind: "sprite-renderer",
                cpp:
                    `bbl::create_sprite_renderer(${surface.cpp}, ` +
                    `bbl::SpriteRendererOptions{{${layers.tupleElements
                        .map((layer) => layer.cpp)
                        .join(", ")}}, ` +
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

        default:
            return undefined;
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
