/** Static font/layout construction executes the pin; live text remains unsupported. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localAssetPath } from "../../asset-source.js";
import { materializePinnedText, textSha256, type CompiledTextData, type StaticTextLayout, type TextBlob } from "../../pinned-text-data.js";
import { readAssetBytesSync } from "../asset-bytes-sync.js";
import { compileStaticNumber, type PositiveIntegerContext } from "../option-helpers.js";
import type { CompileAsset, ResolvedCompileOptions, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface TextIntrinsicContext extends IntrinsicCallContext, PositiveIntegerContext {
    readonly reachedTextData: CompiledTextData[];
    readonly options: ResolvedCompileOptions;
    readonly assetPayloads: Map<string, string>;
    registerAsset(source: string, kind: CompileAsset["kind"], faceSize?: number): CompileAsset;
    compileStaticString(expression: ts.Expression): string;
    expectStaticArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression;
    unwrap(expression: ts.Expression): ts.Expression;
}

export function compileTextIntrinsic(context: TextIntrinsicContext, name: string, call: ts.CallExpression): Value | undefined {
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
    return { kind: "text-data", cpp: "", textData: row };
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
