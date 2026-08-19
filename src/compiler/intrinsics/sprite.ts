import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { parseBlendExport } from "../../lowering/pinned-blend-table.js";

export interface SpriteIntrinsicContext
    extends IntrinsicCallContext {
    requireDefaultEngine(node: ts.Node): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    registerSpriteAtlasAsset(
        expression: ts.Expression,
    ): string;
    allocateTemporaryCppName(label: string): string;
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
        // The family the descriptor belongs to, so a call site can refuse a
        // 2D descriptor at a billboard system and the reverse.
        staticString: blend.family,
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
    if (
        blendMode.kind !== "sprite-blend" ||
        blendMode.staticString !== family
    ) {
        context.fail(
            node,
            `blendMode must be one of the pinned ${family}Blend* descriptors.`,
        );
    }
    return blendMode.cpp;
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
    if (
        value.kind === "data" &&
        value.dataType?.kind === "tuple" &&
        value.dataType.arity === arity
    ) {
        const local = context.allocateTemporaryCppName(
            `sprite_${name}`,
        );
        context.emit(
            `const bbl::js::Tuple<${arity}> ${local} = ${value.cpp};`,
        );
        return Array.from(
            { length: arity },
            (_unused, index) =>
                `static_cast<float>(${local}[${index}])`,
        );
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
            if (property(options, "textureOptions")) {
                context.fail(
                    call,
                    "loadSpriteAtlas textureOptions are not lowered.",
                );
            }
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
                    `${premultiplyOnLoad?.cpp ?? "false"}})`,
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
            for (const unreached of [
                "customShader",
                "layerZ",
                "view",
            ]) {
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
            // blending -- so unlike the billboard family's cutout it needs no
            // second depth path and is lowered with the rest.
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
                    }}})`,
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
            // `order` sorts a system against the scene's other transparent
            // renderables upstream. This path draws billboards after the
            // scene's own stages instead, which is the same image only while
            // nothing else is transparent, so an explicit order refuses
            // rather than being silently dropped.
            for (const unreached of [
                "customShader",
                "alphaCutoff",
                "alphaToCoverage",
                "order",
            ]) {
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
                cpp:
                    `bbl::create_billboard_system(${engineCpp}, ` +
                    `${atlas.cpp}, bbl::BillboardOrientation::` +
                    `${locked ? "axis_locked" : "facing"}, ${axisCpp}, ` +
                    `bbl::BillboardSystemOptions{` +
                    `${numberOption(options, "capacity", "16.0f")}, ` +
                    `${blendCpp}, ` +
                    `${numberOption(options, "opacity", "1.0f")}, ` +
                    `${property(options, "visible")?.cpp ?? "true"}})`,
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
            if (
                layers?.kind !== "tuple" ||
                !layers.tupleElements?.length
            ) {
                context.fail(
                    call.arguments[1]!,
                    "createSpriteRenderer requires a non-empty array of layers.",
                );
            }
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
