import ts from "typescript";

import {
    dataTypesEqual,
    isTypedArrayType,
    sharesStorageKind,
    type DataType,
    type TypedArrayKind,
} from "../data-types.js";
import { convertsToSceneNode } from "../data-types/handles.js";
import {
    isStringValue,
    representedStorage,
    withNativeMetadata,
    type Value,
} from "../types.js";

import { isJsonValue } from "../json-bridge.js";
import { pickedMeshHandle } from "../properties.js";
import { resolvedSymbol } from "../symbols.js";
import type { DataSinkHost, DataSinkOperations } from "./contracts.js";
import type { LoweringServices } from "../lowering-services.js";
import { variableKind } from "../syntax.js";

/**
 * Whether Texture2D data storage (`bbl::StoredTexture`) represents the value:
 * file, pixels and solid textures, render-target textures and values already
 * stored. A sprite render texture (`createRenderTexture2D`) has no arm.
 */
export function storesAsTexture2D(value: Value): boolean {
    if (value.kind === "render-texture")
        return (
            value.renderTextureSource === undefined ||
            value.renderTextureSource === "render-target"
        );
    return (
        value.kind === "texture" &&
        (value.textureStorage === "solid" ||
            value.textureStorage === "pixels" ||
            value.textureStorage === "file" ||
            (value.dataType?.kind === "handle" &&
                value.dataType.handle === "texture"))
    );
}

/**
 * A `Texture2D` record made of GPU parts -- exactly the interface's
 * required `{ texture, view, sampler, width, height }` -- as the stored
 * texture the pin's bindings sample: its view through its sampler. The
 * native constructor refuses a view of another texture or a size other
 * than the texture's, the fields the bindings do not read.
 */
export function texture2DFromParts(
    context: Pick<LoweringServices, "requireEngine">,
    value: Value,
    node: ts.Node,
): Value | undefined {
    const parts = value.kind === "record" ? value.recordProperties : undefined;
    if (
        !parts ||
        Object.keys(parts).sort().join() !== "height,sampler,texture,view,width"
    )
        return undefined;
    const { texture, view, sampler, width, height } = parts;
    if (
        texture?.kind !== "gpu-texture" ||
        view?.kind !== "gpu-texture-view" ||
        sampler?.kind !== "gpu-sampler" ||
        width?.kind !== "number" ||
        height?.kind !== "number"
    )
        return undefined;
    const engine = context.requireEngine(view, node);
    return {
        kind: "texture",
        cpp: `bbl::StoredTexture{bbl::gpu_parts_texture(${engine}, ${texture.cpp}, ${view.cpp}, ${sampler.cpp}, ${width.cpp}, ${height.cpp})}`,
        engineCpp: engine,
        textureStorage: "stored",
        dataType: { kind: "handle", handle: "texture" },
    };
}

/**
 * The receiver of a getter whose whole body is `return x.<member>` (behind
 * `!`, parentheses or casts) and whose `x` is a plain name; undefined for
 * any other getter.
 */
function memberGetterReceiver(
    context: Pick<LoweringServices, "unwrap">,
    accessor: ts.GetAccessorDeclaration,
    member: string,
): ts.Identifier | undefined {
    const statements = accessor.body?.statements;
    const only = statements?.length === 1 ? statements[0] : undefined;
    if (!only || !ts.isReturnStatement(only) || !only.expression)
        return undefined;
    const read = context.unwrap(only.expression);
    if (
        !ts.isPropertyAccessExpression(read) ||
        read.questionDotToken ||
        read.name.text !== member
    )
        return undefined;
    const receiver = context.unwrap(read.expression);
    return ts.isIdentifier(receiver) ? receiver : undefined;
}

/**
 * Whether a record states a `view` getter: the record
 * `renderTargetColorViewTexture` reads as a render target's colour view,
 * which a conditional selects as stored Texture2D.
 */
export function statesViewGetter(value: Value): boolean {
    return value.kind === "record" && value.recordGetters?.view !== undefined;
}

type Texture2DRecordServices = Pick<
    LoweringServices,
    | "compileValue"
    | "withRecordScopes"
    | "unwrap"
    | "requireEngine"
    | "expectSameEngine"
    | "fail"
>;

/** A record with no code of its own beyond the getters it may state. */
function plainTexture2DRecord(value: Value): boolean {
    return (
        value.kind === "record" &&
        !value.cpp &&
        !value.classDeclaration &&
        Object.keys(value.recordMethods ?? {}).length === 0 &&
        Object.keys(value.recordSetters ?? {}).length === 0
    );
}

/**
 * The sampler and run-time `_sampleType` a Texture2D record over a render
 * target's colour binds with: its own GPU sampler, and at most
 * `_sampleType: "float"`. An escaping record holds `_sampleType` as a
 * run-time string, which the native constructor checks instead.
 */
function colorViewSampling(
    context: Pick<LoweringServices, "fail">,
    properties: Readonly<Record<string, Value>>,
    node: ts.Node,
): { sampler: Value; sampleTypeArgument: string } {
    const { sampler, _sampleType: sampleType } = properties;
    if (sampler?.kind !== "gpu-sampler")
        context.fail(
            node,
            "A Texture2D record over a render target's colour view binds " +
                "through its own GPU sampler.",
        );
    const runtimeSampleType =
        sampleType?.staticString === undefined ? sampleType : undefined;
    if (
        sampleType &&
        (runtimeSampleType
            ? !isStringValue(runtimeSampleType)
            : sampleType.staticString !== "float")
    )
        context.fail(
            node,
            "A render target's colour view samples as float; this record " +
                "states another `_sampleType`.",
        );
    return {
        sampler,
        sampleTypeArgument: runtimeSampleType
            ? `, ${runtimeSampleType.cpp}`
            : "",
    };
}

/**
 * A `Texture2D` record over a render target's live colour attachment --
 * a `view` getter returning one render target's `_colorView`, an optional
 * `texture` getter returning the same target's `_colorTexture`, a GPU
 * `sampler`, and at most `_sampleType: "float"` -- as that target's colour
 * sampled through the record's sampler. The pin's bindings read `view` and
 * `sampler` when they build a bind group; the native binding resolves the
 * target's current colour at that point. Undefined for any other record.
 */
export function renderTargetColorViewTexture(
    context: Texture2DRecordServices,
    value: Value,
    node: ts.Node,
): Value | undefined {
    if (!statesViewGetter(value) || !plainTexture2DRecord(value))
        return undefined;
    const getters = value.recordGetters!;
    const viewReceiver = memberGetterReceiver(
        context,
        getters.view!,
        "_colorView",
    );
    if (!viewReceiver) return undefined;
    const target = context.withRecordScopes(value, () =>
        context.compileValue(viewReceiver),
    );
    if (target.kind !== "render-target") return undefined;
    const properties = value.recordProperties ?? {};
    const stated = [...Object.keys(getters), ...Object.keys(properties)];
    const texture = getters.texture;
    const textureReceiver = texture
        ? memberGetterReceiver(context, texture, "_colorTexture")
        : undefined;
    if (
        Object.keys(getters).some(
            (name) => !["view", "texture"].includes(name),
        ) ||
        Object.keys(properties).some(
            (name) => !["sampler", "_sampleType"].includes(name),
        ) ||
        (texture &&
            (!textureReceiver ||
                context.withRecordScopes(value, () =>
                    context.compileValue(textureReceiver),
                ).cpp !== target.cpp))
    )
        context.fail(
            node,
            "A Texture2D record over a render target's colour view states " +
                "getters `view` (its `_colorView`) and optionally `texture` " +
                "(the same target's `_colorTexture`), a `sampler` and at most " +
                `\`_sampleType: "float"\`; this one states ${stated.join(", ")}.`,
        );
    const { sampler, sampleTypeArgument } = colorViewSampling(
        context,
        properties,
        node,
    );
    const signature = target.renderTargetSignature;
    // A count the run decides is checked where the view is made
    // (`bbl::render_target_color_view`).
    if (signature && (!signature.hasColor || signature.samples === 4))
        context.fail(
            node,
            "A Texture2D record binds a render target's colour view only " +
                "when the target has single-sample colour: the pin's view is " +
                "that colour texture's default view.",
        );
    context.expectSameEngine(target, sampler, node);
    const engine = context.requireEngine(target, node);
    return {
        kind: "render-texture",
        cpp: `bbl::render_target_color_view(${engine}, ${target.cpp}, ${sampler.cpp}${sampleTypeArgument})`,
        engineCpp: engine,
    };
}

/** Whether a value holds one GPU handle, present or optional. */
function holdsGpuHandle(
    value: Value | undefined,
    handle: "gpu-texture" | "gpu-texture-view",
): boolean {
    const type =
        value?.dataType?.kind === "optional"
            ? value.dataType.inner
            : value?.dataType;
    return type?.kind === "handle" && type.handle === handle;
}

/**
 * A `Texture2D` record holding a render target's colour as read once --
 * a `view` read off `_colorView`, an optional `texture` read off the same
 * allocation's `_colorTexture`, a GPU `sampler` and at most
 * `_sampleType: "float"`, without the size GPU parts state
 * (`texture2DFromParts`) -- as that target's colour sampled through the
 * record's sampler. The pin's bindings read `view` and `sampler`; the
 * native constructor finds the target whose colour the view is, refuses a
 * view of none, and binds it only where that colour is the target's until
 * disposal (`render_target_color_snapshot`). Undefined for any other
 * record.
 */
function renderTargetColorSnapshotTexture(
    context: Texture2DRecordServices,
    value: Value,
    node: ts.Node,
): Value | undefined {
    const properties = value.recordProperties ?? {};
    if (
        !plainTexture2DRecord(value) ||
        Object.keys(value.recordGetters ?? {}).length > 0 ||
        !holdsGpuHandle(properties.view, "gpu-texture-view") ||
        "width" in properties ||
        "height" in properties
    )
        return undefined;
    const stated = Object.keys(properties);
    const { texture } = properties;
    if (
        stated.some(
            (name) =>
                !["texture", "view", "sampler", "_sampleType"].includes(name),
        ) ||
        (texture && !holdsGpuHandle(texture, "gpu-texture"))
    )
        context.fail(
            node,
            "A Texture2D record holding a render target's colour states its " +
                "`view` (the target's `_colorView`), optionally its `texture` " +
                "(the same target's `_colorTexture`), a `sampler` and at most " +
                `\`_sampleType: "float"\`; this one states ${stated.join(", ")}.`,
        );
    const { sampler, sampleTypeArgument } = colorViewSampling(
        context,
        properties,
        node,
    );
    const engine = context.requireEngine(sampler, node);
    return {
        kind: "render-texture",
        cpp: `bbl::render_target_color_snapshot(${engine}, ${texture ? texture.cpp : "std::nullopt"}, ${properties.view!.cpp}, ${sampler.cpp}${sampleTypeArgument})`,
        engineCpp: engine,
    };
}

/**
 * A `Texture2D` record as the texture the pin's reads of it give: its GPU
 * parts (`texture2DFromParts`), or a render target's colour read live
 * (`renderTargetColorViewTexture`) or once
 * (`renderTargetColorSnapshotTexture`). Undefined for any other value.
 */
export function texture2DFromRecord(
    context: Texture2DRecordServices,
    value: Value,
    node: ts.Node,
): Value | undefined {
    return (
        texture2DFromParts(context, value, node) ??
        renderTargetColorViewTexture(context, value, node) ??
        renderTargetColorSnapshotTexture(context, value, node)
    );
}

/** A singleton cloned-root container shares the clone's mesh-only asset record. */
export function projectAssetContainer(
    context: Pick<LoweringServices, "requireEngine" | "dataLowerer">,
    value: Value,
    node: ts.Node,
): Value | undefined {
    if (value.kind === "asset") return value;
    if (value.kind !== "record") return undefined;
    const properties = value.recordProperties ?? {};
    const entities = properties.entities;
    const root =
        Object.keys(properties).length === 1 &&
        entities?.kind === "tuple" &&
        entities.tupleElements?.length === 1
            ? entities.tupleElements[0]
            : undefined;
    if (root?.kind === "asset-root" && root.assetRootClone)
        return { ...root, kind: "asset" };
    if (root?.kind === "scene-node" && root.sceneNodeClone) {
        const projected: Value = {
            kind: "asset",
            cpp: `bbl::cloned_asset_container(${root.cpp})`,
            engineCpp: context.requireEngine(root, node),
            assetKind: "gltf",
            assetRootClone: true,
            assetRootState: { reparented: false },
            ...(root.nativeCaptures
                ? { nativeCaptures: root.nativeCaptures }
                : {}),
            ...(root.nativeCompanionCaptures?.engineCpp
                ? {
                      nativeCompanionCaptures: {
                          engineCpp: root.nativeCompanionCaptures.engineCpp,
                      },
                  }
                : {}),
        };
        const storage: DataType<"handle"> = {
            kind: "handle",
            handle: "asset",
            ownedEngine: true,
        };
        return withNativeMetadata(
            context.dataLowerer.leafValue(
                context.dataLowerer.compileKnownValueForSink(
                    projected,
                    storage,
                    node,
                ),
                storage,
            ),
            projected,
        );
    }
    return undefined;
}

function expressionHandle(
    dataType: DataType<"handle">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    // Storing a resource into plain data: the sink takes
    // the handle value produced by the intrinsic that
    // created it (or read back out of another container).
    let rawValue = lowerer.context.compileValue(unwrapped);
    if (
        dataType.handle === "dom-event" ||
        dataType.handle === "dom-event-identity"
    )
        return lowerer.compileKnownValueForSink(rawValue, dataType, unwrapped);
    if (
        dataType.handle === "text-run-ref" &&
        (rawValue.kind === "number" || rawValue.kind === "text-run")
    )
        return lowerer.compileKnownValueForSink(rawValue, dataType, unwrapped);
    if (dataType.handle === "mesh" && rawValue.kind === "picked-node") {
        return lowerer.compileKnownValueForSink(rawValue, dataType, unwrapped);
    }
    if (
        dataType.handle === "scene-node" &&
        convertsToSceneNode(rawValue.kind)
    ) {
        return lowerer.compileKnownValueForSink(rawValue, dataType, unwrapped);
    }
    if (
        dataType.handle === "property-animation-group" &&
        rawValue.kind === "animation-group" &&
        rawValue.animationGroupSource === "property"
    ) {
        return rawValue.cpp;
    }
    if (dataType.handle === "sprite-atlas" && rawValue.kind !== "record") {
        const staticExpression =
            lowerer.context.resolveStaticExpression(unwrapped);
        const constInitializer = ts.isIdentifier(unwrapped)
            ? resolvedSymbol(lowerer.context.checker, unwrapped)
                  ?.valueDeclaration
            : undefined;
        const atlasExpression =
            staticExpression !== unwrapped
                ? staticExpression
                : constInitializer &&
                    ts.isVariableDeclaration(constInitializer) &&
                    constInitializer.initializer &&
                    ts.isVariableDeclarationList(constInitializer.parent) &&
                    variableKind(constInitializer.parent) === "const"
                  ? constInitializer.initializer
                  : undefined;
        if (atlasExpression) {
            rawValue = lowerer.context.compileValue(atlasExpression);
        }
    }
    const value =
        rawValue.kind === "data"
            ? lowerer.narrowOptional(rawValue, unwrapped)
            : rawValue;
    if (
        dataType.handle === "ui-element" &&
        value.dataType?.kind === "event-target"
    )
        return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
    if (dataType.handle === "sprite-atlas" && value.kind === "record") {
        const atlas = lowerer.context.compileSpriteAtlasRecord(
            value,
            unwrapped,
        );
        if (atlas) return atlas;
    }
    if (value.kind !== dataType.handle) {
        if (
            dataType.handle === "texture" &&
            (value.kind === "render-texture" || value.kind === "record")
        ) {
            return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
        }
        // An erased field a present handle settled widens to the optional
        // one this write stores.
        if (
            rawValue.dataType?.kind === "optional" &&
            rawValue.dataType.inner.kind === "handle" &&
            rawValue.dataType.inner.handle === dataType.handle
        )
            lowerer.requireErasedHandleField(unwrapped, rawValue.dataType);
        lowerer.context.fail(
            unwrapped,
            `Expected a ${dataType.handle} value, received ${value.kind}.`,
        );
    }
    return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
}

function expressionArraybufferOrDataview(
    dataType: DataType<"arraybuffer" | "dataview">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    const value = lowerer.requireDataValue(unwrapped, dataType, expression);
    lowerer.markEscaped(value);
    return value.cpp;
}

function bufferViewValue(
    _type: DataType<"bufferview">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.dataType?.kind === "bufferview") return value.cpp;
    if (
        value.dataType?.kind === "dataview" ||
        (value.dataType && isTypedArrayType(value.dataType))
    ) {
        if (value.borrowedData || value.nativeVectorData) {
            lowerer.context.fail(
                node,
                "ArrayBufferView storage requires a retained typed array or DataView.",
            );
        }
        lowerer.markEscaped(value);
        return `bbl::js::ArrayBufferView(${value.cpp})`;
    }
    return undefined;
}

function expressionView(
    type: DataType<"bufferview" | "numberindex">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    // A literal is a fresh number array the view holds.
    if (type.kind === "numberindex" && ts.isArrayLiteralExpression(unwrapped))
        return `bbl::js::NumericArrayView(${lowerer.compileForSink(unwrapped, {
            kind: "vector",
            element: { kind: "number" },
        })})`;
    return lowerer.compileKnownValueForSink(
        lowerer.narrowOptional(
            lowerer.context.compileValue(unwrapped),
            unwrapped,
        ),
        type,
        unwrapped,
    );
}

function numericViewValue(
    _type: DataType<"numberindex">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    const source = value.dataType;
    if (source?.kind === "numberindex") return value.cpp;
    if (
        source &&
        (isTypedArrayType(source) ||
            source.kind === "tuple" ||
            (source.kind === "vector" && source.element.kind === "number"))
    ) {
        // A borrowed lvalue of a shared array (a stored class field) is
        // copied into the view as that array; an engine-owned vector is not
        // one.
        if (
            value.nativeVectorData ||
            (value.borrowedData && !sharesStorageKind(source))
        ) {
            lowerer.context.fail(
                node,
                "Numeric index storage requires a retained array.",
            );
        }
        lowerer.invalidateEscapingCollection(value);
        lowerer.markEscaped(value);
        return `bbl::js::NumericArrayView(${value.cpp})`;
    }
    return undefined;
}

function expressionTypedArray(
    dataType: DataType<TypedArrayKind>,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    if (ts.isNewExpression(unwrapped)) {
        const value = lowerer.compileTypedArrayNew(unwrapped);
        if (value?.dataType && dataTypesEqual(value.dataType, dataType)) {
            return value.cpp;
        }
    }
    const value = lowerer.requireDataValue(unwrapped, dataType, expression);
    lowerer.markEscaped(value);
    return value.cpp;
}

function valueResource(
    dataType: DataType<"arraybuffer" | "dataview" | TypedArrayKind | "handle">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (dataType.kind === "handle" && dataType.ownedEngine) {
        if (value.dataType && dataTypesEqual(value.dataType, dataType)) {
            const storage = representedStorage(value);
            if (!storage)
                return lowerer.context.fail(
                    node,
                    "An owned resource requires its represented storage.",
                );
            return storage.cpp;
        }
        const rawType = { kind: "handle", handle: dataType.handle } as const;
        const raw = lowerer.compileKnownValueForSink(value, rawType, node);
        // A SpriteAtlas without an engine is a record, which materializes
        // into the entry point's engine (compileSpriteAtlasRecord), which
        // therefore owns the pair.
        const owner = lowerer.context.storedResourceEngine(
            !value.engineCpp && dataType.handle === "sprite-atlas"
                ? {
                      ...value,
                      engineCpp: lowerer.context.requireDefaultEngine(node),
                  }
                : value,
            node,
        );
        return `${lowerer.context.dataTypes.cppType(dataType)}{${owner}, ${raw}}`;
    }
    // A typed array a document holds is the array itself, boxed: read back
    // as an assertion of its class reads it (another value throws).
    if (isTypedArrayType(dataType) && isJsonValue(value)) {
        lowerer.context.reachJson();
        return `${value.cpp}.asserted_instance<${lowerer.context.dataTypes.cppType(dataType)}>()`;
    }
    if (
        dataType.kind === "handle" &&
        dataType.handle === "dom-event-identity"
    ) {
        if (
            [
                "dom-event",
                "custom-event",
                "platform-mouse-event",
                "platform-keyboard-event",
            ].includes(value.kind)
        ) {
            lowerer.context.reachFeature("input:dom", node);
            lowerer.context.reachFeature("data:json", node);
            return `bbl::dom_event_identity(${value.cpp})`;
        }
    }
    if (
        dataType.kind === "handle" &&
        dataType.handle === "dom-event" &&
        value.kind === "platform-mouse-event"
    ) {
        lowerer.context.reachFeature("input:dom", node);
        lowerer.context.reachFeature("data:json", node);
        return `bbl::OwnedDomEvent(${value.cpp}${value.platformEventBase ? ".payload<bbl::PlatformMouseEvent>()" : ""})`;
    }
    if (
        dataType.kind === "handle" &&
        dataType.handle === "ui-element" &&
        value.dataType?.kind === "event-target"
    ) {
        lowerer.context.reachFeature("input:dom", node);
        return `bbl::dom_target_element(${value.cpp})`;
    }
    if (
        dataType.kind === "handle" &&
        dataType.handle === "mesh" &&
        value.kind === "picked-node"
    ) {
        return pickedMeshHandle(lowerer.context, value, node).cpp;
    }
    if (
        dataType.kind === "handle" &&
        dataType.handle === "text-run-ref" &&
        (value.kind === "number" || value.kind === "text-run")
    )
        return `bbl::TextRunRef{${value.cpp}}`;
    if (
        dataType.kind === "handle" &&
        dataType.handle === "scene-node" &&
        convertsToSceneNode(value.kind)
    ) {
        return `bbl::SceneNodeHandle{${value.cpp}}`;
    }
    if (
        dataType.kind === "handle" &&
        dataType.handle === "property-animation-group" &&
        value.kind === "animation-group" &&
        value.animationGroupSource === "property"
    ) {
        return value.cpp;
    }
    const fromRecord =
        dataType.kind === "handle" && dataType.handle === "texture"
            ? texture2DFromRecord(lowerer.context, value, node)
            : undefined;
    if (fromRecord?.kind === "texture") return fromRecord.cpp;
    if (
        !fromRecord &&
        dataType.kind === "handle" &&
        dataType.handle === "texture" &&
        value.kind === "record" &&
        !value.cpp
    ) {
        const stated = [
            ...Object.keys(value.recordProperties ?? {}),
            ...Object.keys(value.recordGetters ?? {}),
        ];
        lowerer.context.fail(
            node,
            `A Texture2D record states texture, view, sampler, width and height as GPU parts; this one states ${stated.join(", ") || "none"}.`,
        );
    }
    const renderTexture = fromRecord ?? value;
    if (
        dataType.kind === "handle" &&
        dataType.handle === "texture" &&
        renderTexture.kind === "render-texture"
    ) {
        if (
            renderTexture.renderTextureSource !== undefined &&
            renderTexture.renderTextureSource !== "render-target"
        ) {
            lowerer.context.fail(
                node,
                "Stored render textures require a createRenderTargetTexture owner.",
            );
        }
        return `bbl::StoredTexture{bbl::retained_render_texture(${lowerer.context.requireEngine(renderTexture, node)}, ${renderTexture.cpp})}`;
    }
    if (dataType.kind === "handle" && value.kind === dataType.handle) {
        if (dataType.handle === "texture") {
            if (value.textureStorage === "solid") {
                return `bbl::StoredTexture{bbl::solid_texture_file(${value.cpp})}`;
            }
            if (
                value.textureStorage === "pixels" ||
                value.textureStorage === "file"
            ) {
                return `bbl::StoredTexture{${value.cpp}}`;
            }
            if (!storesAsTexture2D(value)) {
                lowerer.context.fail(
                    node,
                    "Texture2D data storage supports file, pixel, and solid textures.",
                );
            }
        }
        return value.cpp;
    }
    if (value.dataType && dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

export const resourcesSinks: DataSinkOperations<
    | "handle"
    | "arraybuffer"
    | "dataview"
    | "bufferview"
    | "numberindex"
    | TypedArrayKind
> = {
    bufferview: { expression: expressionView, value: bufferViewValue },
    numberindex: { expression: expressionView, value: numericViewValue },
    handle: { expression: expressionHandle, value: valueResource },
    arraybuffer: {
        expression: expressionArraybufferOrDataview,
        value: valueResource,
    },
    dataview: {
        expression: expressionArraybufferOrDataview,
        value: valueResource,
    },
    i8array: { expression: expressionTypedArray, value: valueResource },
    u8array: { expression: expressionTypedArray, value: valueResource },
    f64array: { expression: expressionTypedArray, value: valueResource },
    f32array: { expression: expressionTypedArray, value: valueResource },
    u16array: { expression: expressionTypedArray, value: valueResource },
    i16array: { expression: expressionTypedArray, value: valueResource },
    u32array: { expression: expressionTypedArray, value: valueResource },
    i32array: { expression: expressionTypedArray, value: valueResource },
    u8clampedarray: {
        expression: expressionTypedArray,
        value: valueResource,
    },
};
