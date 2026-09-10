import { EmissionSet, EmissionMap } from "../emission-transaction.js";
import type { LoweringServices } from "../lowering-services.js";
/** Static shaping executes the pin; native text entities retain the resulting bytes. */
/** Static shaping executes the pin; native text entities retain the resulting bytes. */
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import {
    materializePinnedText,
    textSha256,
    type CompiledTextData,
    type StaticTextLayout,
    type TextBlob,
} from "../../pinned-text-data.js";
import { readAssetBytesSync } from "../asset-bytes-sync.js";
import { compileStaticNumber, type PositiveIntegerContext } from "../option-helpers.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { pinnedHandleKind } from "../data-types.js";
import { retainTextValue } from "../text-surface.js";

export interface TextIntrinsicContext
    extends IntrinsicCallContext,
    PositiveIntegerContext,
    Pick<LoweringServices,
        | "reachedTextData"
        | "options"
        | "assetPayloads"
        | "registerAsset"
        | "compileStaticString"
        | "expectStaticArrayLiteral"
        | "unwrap"
        | "emit"
        | "allocateTemporaryCppName"
        | "pinValueToTemporary"
        | "compileNumber"
        | "compileBoolean"
        | "compileForDataSink"
        | "compileColor4"
        | "checker"
        | "assertTextPipelineMutable"
        | "recordTextAttachment"
        | "assertTextDisposal"
        | "noteTextSceneLifecycle"
    > {}

export function compileTextIntrinsic(context: TextIntrinsicContext, name: string, call: ts.CallExpression): Value | undefined {
    if (name === "setFontWeightOffset") {
        context.expectArgumentCount(call,3,3);
        const data=context.compileValue(argumentAt(call, 0));
        context.expectKind(data,"text-data",argumentAt(call, 0));
        const owner=retainTextValue(context,data);
        const run=context.allocateTemporaryCppName("text_run_ref");
        context.emit(`const auto ${run}=${context.compileForDataSink(argumentAt(call, 1),{kind:"handle",handle:"text-run-ref"})};`);
        const offset=context.compileNumber(argumentAt(call, 2),"double");
        promoteLiveTextData(context);
        context.reachFeature("text:layout",call);context.reachFeature("text:weight",call);
        return {kind:"void",cpp:`bbl::set_font_weight_offset(${owner.cpp},${run},${offset})`};
    }
    if (name === "updateTextData") {
        context.expectArgumentCount(call,2,2);
        const data = context.compileValue(argumentAt(call, 0));
        context.expectKind(data,"text-data",argumentAt(call, 0));
        const owner = retainTextValue(context,data);
        let operation: string | undefined, previous: Value | undefined, run: string | undefined;
        for (const [name, expression] of textOptionEntries(context,call.arguments[1])) {
            if (name === "update") operation = context.compileStaticString(expression);
            else if (name === "previous") {
                const value=context.compileValue(expression);
                context.expectKind(value,"text-run",expression);
                previous=retainTextValue(context,value);
            } else if (name === "run") {
                const record=context.unwrap(expression);
                if (!ts.isObjectLiteralExpression(record) || record.properties.length !== 2 ||
                    !ts.isSpreadAssignment(record.properties[0]!) || !ts.isPropertyAssignment(record.properties[1]!) ||
                    record.properties[1]!.name.getText() !== "defaultColor")
                    context.fail(expression,"Text run replacement requires a retained run spread followed by defaultColor.");
                const source=context.compileValue(record.properties[0]!.expression);
                context.expectKind(source,"text-run",record.properties[0]!);
                const retained=retainTextValue(context,source);
                const color=context.compileForDataSink(record.properties[1]!.initializer,{kind:"tuple",arity:4});
                const name=context.allocateTemporaryCppName("text_run");
                context.emit(`auto ${name}=bbl::clone_text_run(${retained.cpp}, ${color});`);
                run=name;
            } else context.fail(expression,`Text data update property '${name}' is not represented.`);
        }
        if (operation !== "replaceRun" || !previous || !run) context.fail(call,"Text data updates currently require replaceRun with a retained previous run and color replacement.");
        promoteLiveTextData(context);
        context.reachFeature("text:layout",call);
        return {kind:"void",cpp:`bbl::replace_default_text_run(${owner.cpp}, ${previous.cpp}, ${run})`};
    }
    if (name === "createTextLayer") {
        context.expectArgumentCount(call, 1, 2);
        const data = context.compileValue(argumentAt(call, 0));
        context.expectKind(data, "text-data", argumentAt(call, 0));
        const owner = retainTextValue(context, data);
        const options = context.allocateTemporaryCppName("text_layer_options");
        context.emit(`bbl::TextLayerOptions ${options};`);
        for (const [field, value] of textOptionEntries(context, call.arguments[1])) {
            const native = ({ positionPx: "position_px", rotationRad: "rotation_rad", coverageGamma: "coverage_gamma" } as Record<string,string>)[field] ?? field;
            if (field === "positionPx") {
                const components = textOptionEntries(context, value);
                if (components.length !== 2 || !components.every(([name]) => name === "x" || name === "y") || new EmissionSet(components.map(([name]) => name)).size !== 2)
                    context.fail(value, "Text layer position requires x and y components.");
                for (const [axis, component] of components) context.emit(`${options}.${native}.${axis} = ${context.compileNumber(component, "double")};`);
            } else if (["rotationRad", "scale", "order", "opacity", "coverageGamma", "visible"].includes(field)) {
                context.emit(`${options}.${native} = ${field === "visible" ? context.compileBoolean(value) : context.compileNumber(value, "double")};`);
            } else context.fail(value, `Text layer option '${field}' is not represented.`);
        }
        context.reachFeature("text:data", call);
        context.reachFeature("renderer:text", call);
        return { kind: "text-layer", cpp: `bbl::create_text_layer(${owner.cpp}, ${options})`, dataType: { kind: "handle", handle: "text-layer" } };
    }
    if (name === "createTextRenderer") {
        context.expectArgumentCount(call, 2, 2);
        const engine = context.compileValue(argumentAt(call, 0));
        context.expectKind(engine, "engine", argumentAt(call, 0));
        const options = context.allocateTemporaryCppName("text_renderer_options");
        context.emit(`bbl::TextRendererOptions ${options};`);
        let hasLayers = false;
        for (const [field, value] of textOptionEntries(context, call.arguments[1])) {
            if (field === "layers") {
                context.emit(`${options}.layers = bbl::js::array_to_vector(${context.compileForDataSink(value, {kind:"vector",element:{kind:"handle",handle:"text-layer"}})});`);
                hasLayers = true;
            } else if (field === "clear") context.emit(`${options}.clear = ${context.compileBoolean(value)};`);
            else if (field === "clearValue") context.emit(`${options}.clear_value = ${context.compileColor4(value)};`);
            else context.fail(value, `Text renderer option '${field}' is not represented.`);
        }
        if (!hasLayers) context.fail(call, "Text renderer requires a layer array.");
        context.reachFeature("renderer:text", call);
        return { kind: "text-renderer", cpp: `bbl::create_text_renderer(${engine.cpp}, ${options})`, engineCpp: engine.cpp,
            dataType: { kind: "handle", handle: "text-renderer" } };
    }
    if (name === "registerTextRenderer") {
        context.expectArgumentCount(call,1,1);
        const value = context.compileValue(argumentAt(call, 0));
        context.expectKind(value,"text-renderer",argumentAt(call, 0));
        context.reachFeature("renderer:text",call);
        return { kind:"void", cpp:`bbl::register_text_renderer(${value.cpp})` };
    }
    if (name === "updateDefaultTextData") {
        context.expectArgumentCount(call, 2, 3);
        const owner = context.compileValue(argumentAt(call, 0));
        context.expectKind(owner, "text-data", argumentAt(call, 0));
        const retained = retainTextValue(context, owner);
        const text = context.compileValue(argumentAt(call, 1));
        expectTextString(context, text, argumentAt(call, 1));
        if (call.arguments[2] && !omitted(context, argumentAt(call, 2))) context.fail(argumentAt(call, 2), "Live text color arguments are not yet represented.");
        promoteLiveTextData(context);
        context.reachFeature("text:layout", call);
        return { kind: "void", cpp: `bbl::update_default_text_data(${retained.cpp}, ${text.cpp})` };
    }
    if (["disposeScene", "unregisterScene", "rebuildSceneRenderables"].includes(name)) context.noteTextSceneLifecycle(call);
    if ((name === "setAlphaToCoverage" || name === "getAlphaToCoverage") && call.arguments[0] &&
        pinnedHandleKind(context.checker.getTypeAtLocation(call.arguments[0])) === "text-renderable") {
        context.expectArgumentCount(call, name === "setAlphaToCoverage" ? 2 : 1, name === "setAlphaToCoverage" ? 2 : 1);
        const value = context.compileValue(call.arguments[0]);
        context.expectKind(value, "text-renderable", call.arguments[0]);
        context.reachFeature("text:data", call);
        const owner = retainTextValue(context, value);
        if (name === "getAlphaToCoverage") return { kind: "boolean", cpp: `bbl::get_text_alpha_to_coverage(*${owner.cpp})`, dataType: { kind: "boolean" } };
        context.assertTextPipelineMutable(call);
        return { kind: "void", cpp: `bbl::set_text_alpha_to_coverage(*${owner.cpp}, ${context.compileBoolean(argumentAt(call, 1))})` };
    }
    if (name === "createTextRenderable") {
        context.expectArgumentCount(call, 1, 2);
        const value = context.compileValue(argumentAt(call, 0));
        context.expectKind(value, "text-data", argumentAt(call, 0));
        const data = retainTextValue(context, value);
        const options = compileRenderableOptions(context, call.arguments[1]);
        context.reachFeature("text:data", call);
        context.reachFeature("text:renderable", call);
        context.reachFeature("renderer:scene", call);
        return { kind: "text-renderable", cpp: `bbl::create_text_renderable(${data.cpp}, ${options})`,
            dataType: { kind: "handle", handle: "text-renderable" } };
    }
    if (name === "addTextRenderable") {
        context.expectArgumentCount(call, 2, 2);
        const originalScene = context.compileValue(argumentAt(call, 0));
        context.expectKind(originalScene, "scene", argumentAt(call, 0));
        const scene = { ...originalScene, cpp: context.allocateTemporaryCppName("text_scene") };
        context.emit({ kind: "declaration", type: "auto", name: scene.cpp, initializer: originalScene.cpp });
        const renderable = context.compileValue(argumentAt(call, 1));
        context.expectKind(renderable, "text-renderable", argumentAt(call, 1));
        context.recordTextAttachment(call);
        context.reachFeature("text:data", call);
        context.reachFeature("text:renderable", call);
        context.reachFeature("renderer:scene", call);
        return { kind: "void", cpp: `bbl::add_text_renderable(${scene.cpp}, ${renderable.cpp})` };
    }
    const dispose = { disposeTextRenderable: ["text-renderable", "dispose_text_renderable"],
        disposeTextData: ["text-data", "dispose_text_data"],
        disposeDefaultTextData: ["text-data", "dispose_default_text_data"] } as const;
    if (name in dispose) {
        const [kind, helper] = dispose[name as keyof typeof dispose];
        context.expectArgumentCount(call, 1, 1);
        const value = context.compileValue(argumentAt(call, 0));
        context.expectKind(value, kind, argumentAt(call, 0));
        context.assertTextDisposal(call);
        context.reachFeature("text:data", call);
        return { kind: "void", cpp: `bbl::${helper}(${value.cpp})` };
    }
    if (name !== "loadFont" && name !== "createDefaultTextData") return undefined;
    if (context.isRuntimeResourceConstruction()) {
        context.fail(call, `${name} requires definite initialization; dynamic font/text layouts are not materialized.`);
    }
    if (name === "loadFont") {
        context.expectArgumentCount(call, 1, 1);
        const source = context.compileStaticString(argumentAt(call, 0));
        const asset = context.registerAsset(source, "binary");
        const payload = context.assetPayloads.get(asset.source) ?? asset.source;
        const bytes = readAssetBytesSync(payload, context.options.fileName);
        try { materializePinnedText(bytes); }
        catch (error) { context.fail(call, `Pinned font materialization failed: ${String(error)}`); }
        return { kind: "text-font", cpp: "", textFont: {
            source: { source: asset.source, assetOutput: asset.output, sha256: textSha256(bytes) }, bytes,
        } };
    }
    context.expectArgumentCount(call, 3, 5);
    const font = context.compileValue(argumentAt(call, 0));
    context.expectKind(font, "text-font", argumentAt(call, 0));
    const fontSizePx = finiteNumber(context, argumentAt(call, 1), "Text font size");
    const textInput = context.compileValue(argumentAt(call, 2));
    const textValue = textInput.staticString === undefined
        ? context.pinValueToTemporary(textInput,"text_content",argumentAt(call, 2)) : textInput;
    expectTextString(context, textValue, argumentAt(call, 2));
    // A retained helper can accept any TextData owner, including one created
    // after that helper was lowered. Keep later owners eligible for live input.
    const live = textValue.staticString === undefined || context.reachedTextData.some(row => row.layout.live);
    const layout: StaticTextLayout = { fontSizePx, text: textValue.staticString ?? "", ...(live ? { live: true } : {}) };
    const color = call.arguments[3];
    let liveColor: string | undefined;
    if (color && !omitted(context, color)) {
        const node = context.resolveStaticExpression(color);
        const retained = ts.isIdentifier(node) ? context.lookupOptional(node) : undefined;
        if (retained) {
            const elements = retained.staticElements ?? retained.tupleElements;
            if (!elements || elements.length !== 4 || elements.some((value) => value.staticNumber === undefined || !Number.isFinite(value.staticNumber) || Object.is(value.staticNumber, -0))) {
                context.fail(color, "Static text color requires four known numeric components; mutated or dynamic arrays are not materialized.");
            }
            layout.color = elements.map((value) => value.staticNumber!);
        } else if (ts.isCallExpression(context.unwrap(color))) {
            liveColor = context.compileForDataSink(color, { kind: "tuple", arity: 4 });
            layout.live = true;
        } else {
            const array = context.expectStaticArrayLiteral(color);
            if (array.elements.length !== 4) context.fail(color, "Static text color requires four numeric components.");
            layout.color = array.elements.map((component) => finiteNumber(context, component, "Text color"));
        }
    }
    const options = call.arguments[4];
    if (options && !omitted(context, options)) {
        // A named options object can have changed through another alias. The
        // bounded producer accepts literals; it never recovers stale initializers.
        const object = context.unwrap(options);
        if (!ts.isObjectLiteralExpression(object)) context.fail(options, "Text layout options must be a direct static object literal; retained or dynamic option records are not materialized.");
        layout.options = {};
        for (const property of object.properties) {
            if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
                context.fail(property, "Text layout options require static named properties.");
            }
            const key = property.name.text;
            if (key === "align") {
                const value = context.compileStaticString(property.initializer);
                if (value !== "left" && value !== "center" && value !== "right") context.fail(property, "Unsupported text alignment.");
                layout.options.align = value;
            } else if (key === "maxWidth" || key === "lineHeight" || key === "letterSpacing" || key === "tabSize") {
                layout.options[key] = finiteNumber(context, property.initializer, `Text layout ${key}`);
            } else context.fail(property, `Text layout option '${key}' is not materialized.`);
        }
    }
    let row: CompiledTextData;
    try { row = textRow(context, font.textFont!.bytes, layout, font.textFont!.source, context.reachedTextData.length); }
    catch (error) { context.fail(call, `Pinned text materialization failed: ${String(error)}`); }
    context.reachedTextData.push(row);
    context.reachFeature("text:data", call);
    if (layout.live) context.reachFeature("text:layout", call);
    return { kind: "text-data", cpp: layout.live ? `bbl::create_live_text_data(${row.id}, ${textValue.cpp}${liveColor ? `, ${liveColor}` : ""})` : `bbl::create_compiled_text_data(${row.id})`,
        dataType: { kind: "handle", handle: "text-data" } };
}

function expectTextString(context: TextIntrinsicContext, value: Value, node: ts.Node): void {
    if (value.kind !== "string" && !(value.kind === "data" && value.dataType?.kind === "string")) {
        context.fail(node, `Text content requires a string, received ${value.kind}.`);
    }
}

export function promoteLiveTextData(context: TextIntrinsicContext): void {
    for (const row of context.reachedTextData) {
        if (row.layout.live) continue;
        const payload = context.assetPayloads.get(row.font.source) ?? row.font.source;
        const bytes = readAssetBytesSync(payload, context.options.fileName);
        Object.assign(row, textRow(context, bytes, { ...row.layout, live: true }, row.font, row.id));
    }
}

function textOptionEntries(context: TextIntrinsicContext, expression?: ts.Expression): Array<readonly [string, ts.Expression]> {
    if (!expression || omitted(context, expression)) return [];
    const object = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(object)) context.fail(expression, "Text options require a direct object literal.");
    return object.properties.map(property => {
        if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)))
            context.fail(property, "Text options require named property assignments.");
        return [property.name.text, property.initializer];
    });
}

function textRow(context: TextIntrinsicContext, fontBytes: Uint8Array, layout: StaticTextLayout, font: CompiledTextData["font"], id: number): CompiledTextData {
    const baked = materializePinnedText(fontBytes, layout)!;
    const blob = (base64: string): TextBlob => {
        const bytes = Buffer.from(base64, "base64");
        const asset = context.registerAsset(`data:application/octet-stream;base64,${base64}`, "binary");
        return { assetOutput: asset.output, sha256: textSha256(bytes), byteLength: bytes.byteLength };
    };
    return {
        ...baked,
        id,
        font,
        layout,
        instances: { ...baked.instances, bytes: blob(baked.instances.bytes) },
        styles: { ...baked.styles, bytes: blob(baked.styles.bytes) },
        atlases: baked.atlases.map((atlas) => ({ ...atlas,
            curves: { ...atlas.curves, bytes: blob(atlas.curves.bytes) },
            bands: { ...atlas.bands, bytes: blob(atlas.bands.bytes) },
            metadata: { ...atlas.metadata, bytes: blob(atlas.metadata.bytes) },
        })),
    };
}

/** Literal options snapshot their scalar fields in source order. Retained
 * vector descriptors need reference-valued option storage and remain refused. */
function compileRenderableOptions(context: TextIntrinsicContext, expression?: ts.Expression): string {
    if (!expression || omitted(context, expression)) return "{}";
    const object = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(object)) context.fail(expression, "Text renderable options require a direct object literal.");
    const options = context.allocateTemporaryCppName("text_options");
    context.emit(`bbl::TextRenderableOptions ${options};`);
    for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)))
            context.fail(property, "Text renderable options require named property assignments.");
        const name = property.name.text;
        const field = name === "rotationQuaternion" ? "rotation_quaternion" : name === "ignoreDepth" ? "ignore_depth" : name;
        if (name === "position" || name === "scaling" || name === "rotationQuaternion") {
            const vector = context.unwrap(property.initializer);
            if (!ts.isObjectLiteralExpression(vector)) context.fail(vector, "Text transform options require direct component literals; retained vector options are not represented.");
            const lanes = name === "rotationQuaternion" ? ["x", "y", "z", "w"] : ["x", "y", "z"];
            const values = new EmissionMap<string, string>();
            for (const component of vector.properties) {
                if (!ts.isPropertyAssignment(component) || (!ts.isIdentifier(component.name) && !ts.isStringLiteral(component.name)) || !lanes.includes(component.name.text))
                    context.fail(component, "Text transform options require named numeric components.");
                const value = context.compileValue(component.initializer);
                context.expectKind(value, "number", component.initializer);
                values.set(component.name.text, context.pinValueToTemporary(value, "text_component").cpp);
            }
            if (values.size !== lanes.length) context.fail(vector, "Text transform options require every component.");
            context.emit(`${options}.${field} = bbl::${name === "rotationQuaternion" ? "TextQuaternion" : "Vec3d"}{${lanes.map((lane) => values.get(lane)!).join(", ")}};`);
        } else if (name === "opacity" || name === "order" || name === "ignoreDepth") {
            context.emit(`${options}.${field} = ${name === "ignoreDepth" ? context.compileBoolean(property.initializer) : context.compileNumber(property.initializer, "double")};`);
        } else context.fail(property, `Text renderable option '${name}' is not represented.`);
    }
    return options;
}

function finiteNumber(context: TextIntrinsicContext, expression: ts.Expression, label: string): number {
    const number = compileStaticNumber(context, expression, label);
    if (!Number.isFinite(number) || Object.is(number, -0)) context.fail(expression, `${label} must be finite and not negative zero for static materialization.`);
    return number;
}

function omitted(context: TextIntrinsicContext, expression: ts.Expression): boolean {
    const node = context.resolveStaticExpression(expression);
    return ts.isIdentifier(node) && node.text === "undefined" && !context.lookupOptional(node);
}
