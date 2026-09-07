/** Static shaping executes the pin; native text entities retain the resulting bytes. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localAssetPath } from "../../asset-source.js";
import { materializePinnedText, textSha256, type CompiledTextData, type StaticTextLayout, type TextBlob } from "../../pinned-text-data.js";
import { readAssetBytesSync } from "../asset-bytes-sync.js";
import { compileStaticNumber, type PositiveIntegerContext } from "../option-helpers.js";
import type { CompileAsset, ResolvedCompileOptions, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { pinnedHandleKind } from "../data-types.js";
import { retainTextValue } from "../text-surface.js";

export interface TextIntrinsicContext extends IntrinsicCallContext, PositiveIntegerContext {
    readonly reachedTextData: CompiledTextData[];
    readonly options: ResolvedCompileOptions;
    readonly assetPayloads: Map<string, string>;
    registerAsset(source: string, kind: CompileAsset["kind"], faceSize?: number): CompileAsset;
    compileStaticString(expression: ts.Expression): string;
    expectStaticArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression;
    unwrap(expression: ts.Expression): ts.Expression;
    emit(line: string): void;
    allocateTemporaryCppName(label: string): string;
    pinValueToTemporary(value: Value, label: string, node?: ts.Expression): Value;
    compileNumber(expression: ts.Expression, precision?: "float" | "double"): string;
    compileBoolean(expression: ts.Expression): string;
    readonly checker: ts.TypeChecker;
    assertTextPipelineMutable(node: ts.Node): void;
    recordTextAttachment(node: ts.Node): void;
    assertTextDisposal(node: ts.Node): void;
    noteTextSceneLifecycle(node: ts.Node, message?: string): void;
}

export function compileTextIntrinsic(context: TextIntrinsicContext, name: string, call: ts.CallExpression): Value | undefined {
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
        return { kind: "void", cpp: `bbl::set_text_alpha_to_coverage(*${owner.cpp}, ${context.compileBoolean(call.arguments[1]!)})` };
    }
    if (name === "createTextRenderable") {
        context.expectArgumentCount(call, 1, 2);
        const value = context.compileValue(call.arguments[0]!);
        context.expectKind(value, "text-data", call.arguments[0]!);
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
        const originalScene = context.compileValue(call.arguments[0]!);
        context.expectKind(originalScene, "scene", call.arguments[0]!);
        const scene = { ...originalScene, cpp: context.allocateTemporaryCppName("text_scene") };
        context.emit(`auto ${scene.cpp} = ${originalScene.cpp};`);
        const renderable = context.compileValue(call.arguments[1]!);
        context.expectKind(renderable, "text-renderable", call.arguments[1]!);
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
        const value = context.compileValue(call.arguments[0]!);
        context.expectKind(value, kind, call.arguments[0]!);
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
        const source = context.compileStaticString(call.arguments[0]!);
        const asset = context.registerAsset(source, "binary");
        const payload = context.assetPayloads.get(asset.source) ?? asset.source;
        const local = localAssetPath(payload, resolve(context.options.fileName));
        // A local font edit must invalidate both provenance and the bake in this process.
        const bytes = local ? new Uint8Array(readFileSync(local)) : readAssetBytesSync(payload, context.options.fileName);
        try { materializePinnedText(bytes); }
        catch (error) { context.fail(call, `Pinned font materialization failed: ${String(error)}`); }
        return { kind: "text-font", cpp: "", textFont: {
            source: { source: asset.source, assetOutput: asset.output, sha256: textSha256(bytes) }, bytes,
        } };
    }
    context.expectArgumentCount(call, 3, 5);
    const font = context.compileValue(call.arguments[0]!);
    context.expectKind(font, "text-font", call.arguments[0]!);
    const fontSizePx = finiteNumber(context, call.arguments[1]!, "Text font size");
    const text = context.compileStaticString(call.arguments[2]!);
    const layout: StaticTextLayout = { fontSizePx, text };
    const color = call.arguments[3];
    if (color && !omitted(context, color)) {
        const node = context.resolveStaticExpression(color);
        const retained = ts.isIdentifier(node) ? context.lookupOptional(node) : undefined;
        if (retained) {
            const elements = retained.staticElements ?? retained.tupleElements;
            if (!elements || elements.length !== 4 || elements.some((value) => value.staticNumber === undefined || !Number.isFinite(value.staticNumber) || Object.is(value.staticNumber, -0))) {
                context.fail(color, "Static text color requires four known numeric components; mutated or dynamic arrays are not materialized.");
            }
            layout.color = elements.map((value) => value.staticNumber!);
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
    let baked;
    try { baked = materializePinnedText(font.textFont!.bytes, layout)!; }
    catch (error) { context.fail(call, `Pinned text materialization failed: ${String(error)}`); }
    const blob = (base64: string): TextBlob => {
        const bytes = Buffer.from(base64, "base64");
        const asset = context.registerAsset(`data:application/octet-stream;base64,${base64}`, "binary");
        return { assetOutput: asset.output, sha256: textSha256(bytes), byteLength: bytes.byteLength };
    };
    const row: CompiledTextData = {
        ...baked,
        id: context.reachedTextData.length,
        font: font.textFont!.source,
        layout,
        instances: { ...baked.instances, bytes: blob(baked.instances.bytes) },
        styles: { ...baked.styles, bytes: blob(baked.styles.bytes) },
        atlases: baked.atlases.map((atlas) => ({ ...atlas,
            curves: { ...atlas.curves, bytes: blob(atlas.curves.bytes) },
            bands: { ...atlas.bands, bytes: blob(atlas.bands.bytes) },
            metadata: { ...atlas.metadata, bytes: blob(atlas.metadata.bytes) },
        })),
    };
    context.reachedTextData.push(row);
    context.reachFeature("text:data", call);
    return { kind: "text-data", cpp: `bbl::create_compiled_text_data(${row.id})`, textData: row,
        dataType: { kind: "handle", handle: "text-data" } };
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
            const values = new Map<string, string>();
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
