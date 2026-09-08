/** The text transform object retains its renderable; it is never a copied Vec3. */
import ts from "typescript";
import { pinnedHandleKind } from "./data-types.js";
import type { Value } from "./types.js";
import {
    argumentAt,
    isAssignmentExpression,
    isUpdateExpression,
    stringLiteralText,
    unwrapExpression,
} from "./syntax.js";
import { babylonPackages } from "./symbols.js";

export type TextTransform = "position" | "scaling" | "rotation" | "rotationQuaternion" | "positionPx";
const transforms: readonly string[] = ["position", "scaling", "rotation", "rotationQuaternion"];
const field = (name: string): string => ({rotationQuaternion:"rotation_quaternion",ignoreDepth:"ignore_depth",positionPx:"position_px",rotationRad:"rotation_rad",coverageGamma:"coverage_gamma"}[name] ?? name);
const axes = (name: TextTransform): readonly string[] => name === "rotationQuaternion" ? ["x", "y", "z", "w"] : name === "positionPx" ? ["x","y"] : ["x", "y", "z"];
const textKinds = ["text-data", "text-renderable", "text-layer", "text-renderer", "text-run", "text-vector"];

interface TextSurfaceContext {
    readonly checker: ts.TypeChecker;
    unwrap(expression: ts.Expression): ts.Expression;
    compileValue(expression: ts.Expression): Value;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    probeEmission<T>(probe: () => T, answered: (value: T) => boolean): T;
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    expectKind(value: Value, kind: Value["kind"], node: ts.Node): void;
    fail(node: ts.Node, message: string): never;
    assertTextPipelineMutable(node: ts.Node): void;
    isDefaultLibraryIdentifier(node: ts.Identifier): boolean;
    reachFeature(feature: "text:data" | "text:weight", node: ts.Node): void;
    promoteTextData(node: ts.Node): void;
}

/** The opt-in package export retains a callable identity; loading it does not
 * install the pin's style seams until its setter receives a changed offset. */
export function compileTextModuleValue(context: TextSurfaceContext, expression: ts.PropertyAccessExpression): Value | undefined {
    if (expression.name.text !== "setFontWeightOffset") return undefined;
    const awaited = unwrapExpression(expression.expression);
    if (!ts.isAwaitExpression(awaited)) return undefined;
    const call = context.unwrap(awaited.expression);
    const specifier =
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        call.arguments.length === 1
            ? stringLiteralText(argumentAt(call, 0))
            : undefined;
    if (specifier === undefined || !(babylonPackages as readonly string[]).includes(specifier)) return undefined;
    context.reachFeature("text:weight", expression);
    context.promoteTextData(expression);
    return {kind:"data", cpp:"[](bbl::TextData data, bbl::TextRunRef run, double offset) { bbl::set_font_weight_offset(data, run, offset); }",
        dataType:{kind:"function",parameters:[{kind:"handle",handle:"text-data"},{kind:"handle",handle:"text-run-ref"},{kind:"number"}]}};
}

/** Snapshot a JavaScript reference before evaluating the next argument/RHS. */
export function retainTextValue(context: Pick<TextSurfaceContext, "allocateTemporaryCppName" | "emit">, value: Value): Value {
    const cpp = context.allocateTemporaryCppName("text_owner");
    context.emit(`[[maybe_unused]] const auto ${cpp} = ${value.cpp};`);
    return { ...value, cpp };
}

export function readTextProperty(context: TextSurfaceContext, owner: Value, name: string, site: ts.Node): Value | undefined {
    if (["text-data", "text-renderable", "text-vector"].includes(owner.kind)) context.reachFeature("text:data", site);
    if (owner.kind === "text-data") {
        if (name === "runs") {
            context.promoteTextData(site);
            return { kind:"data", cpp:`bbl::text_data_runs(${owner.cpp})`, dataType:{kind:"vector",element:{kind:"handle",handle:"text-run"}}, freshData:true };
        }
        if (name === "width" || name === "height") return { kind: "number", cpp: `(${owner.cpp})->payload->${name}`, dataType: { kind: "number" }, freshData: true };
        context.fail(site, `Text data property '${name}' is not represented; shaping and internal buffer mutation remain unsupported.`);
    }
    if (owner.kind === "text-layer") {
        if (name === "positionPx") return {kind:"text-vector",cpp:owner.cpp,textTransform:"positionPx"};
        if (name === "data") return {kind:"text-data",cpp:`(${owner.cpp})->data`,dataType:{kind:"handle",handle:"text-data"},freshData:true};
        if (["rotationRad","scale","order","opacity","coverageGamma"].includes(name)) return {kind:"number",cpp:`(${owner.cpp})->${field(name)}`,dataType:{kind:"number"},freshData:true};
        if (name === "visible") return {kind:"boolean",cpp:`(${owner.cpp})->visible`,dataType:{kind:"boolean"},freshData:true};
        context.fail(site, `Text layer property '${name}' is not represented.`);
    }
    if (owner.kind === "text-renderable") {
        if (transforms.includes(name)) return { kind: "text-vector", cpp: owner.cpp, textTransform: name as TextTransform };
        if (name === "_data") return { kind: "text-data", cpp: `(${owner.cpp})->data`, dataType: { kind: "handle", handle: "text-data" }, freshData: true };
        if (name === "opacity" || name === "order" || name === "_version") return { kind: "number", cpp: `(${owner.cpp})->${name === "_version" ? "version" : name}`, dataType: { kind: "number" }, freshData: true };
        if (name === "ignoreDepth" || name === "isTransparent") return { kind: "boolean", cpp: `(${owner.cpp})->${name === "isTransparent" ? "is_transparent" : field(name)}`, dataType: { kind: "boolean" }, freshData: true };
        context.fail(site, `Text renderable property '${name}' is not represented.`);
    }
    if (owner.kind === "text-vector") {
        const transform = owner.textTransform!;
        const axis = axes(transform).indexOf(name);
        if (axis < 0) context.fail(site, `Text ${transform} property '${name}' is not represented.`);
        return { kind: "number", cpp: transform === "rotation"
            ? `bbl::text_read_rotation(*(${owner.cpp}), ${axis})`
            : `(${owner.cpp})->${field(transform)}.${name}`, dataType: { kind: "number" }, freshData: true };
    }
    return undefined;
}

function possibleTextOwner(context: TextSurfaceContext, expression: ts.Expression): boolean {
    const node = context.unwrap(expression);
    // Resolving a record member may execute its getter. Type classification
    // must precede the one admitted owner evaluation below.
    const known = ts.isIdentifier(node) ? context.lookupOptional(node) : undefined;
    if (known && textKinds.includes(known.kind)) return true;
    const type = context.checker.getTypeAtLocation(node);
    if (textKinds.includes(pinnedHandleKind(type) ?? "")) return true;
    // ObservableVec3 is also the pin's mesh, splat and camera surface. Its
    // type alone cannot authorize a text read: several of those owners lower
    // writes directly without exposing a first-class vector value.
    return ts.isPropertyAccessExpression(node) && [...transforms,"positionPx"].includes(node.name.text) &&
        ["text-renderable","text-layer"].includes(pinnedHandleKind(context.checker.getTypeAtLocation(node.expression)) ?? "");
}

function ownerValue(context: TextSurfaceContext, expression: ts.Expression): Value | undefined {
    if (!possibleTextOwner(context, expression)) return undefined;
    return context.probeEmission(() => {
        const value = context.compileValue(expression);
        if (textKinds.includes(value.kind)) context.reachFeature("text:data", expression);
        return textKinds.includes(value.kind) ? value : undefined;
    }, (value) => value !== undefined);
}

/** One entry for value and discarded assignments, increments, and bulk setters. */
export function compileTextMutation(context: TextSurfaceContext, expression: ts.Expression): Value | undefined {
    const node = context.unwrap(expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && context.isDefaultLibraryIdentifier(node.expression.expression) &&
        ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(node.expression.name.text) && node.arguments[0] &&
        ownerValue(context, node.arguments[0])) context.fail(node, "Reflective text property mutation is not represented.");
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "set") {
        const vector = ownerValue(context, node.expression.expression);
        if (!vector || vector.kind !== "text-vector") return undefined;
        const owner = retainTextValue(context, vector);
        const count = axes(owner.textTransform!).length;
        if (node.arguments.length !== count) context.fail(node, `Text ${owner.textTransform}.set requires ${count} numeric arguments.`);
        const args = node.arguments.map((argument) => {
            const value = context.compileValue(argument);
            context.expectKind(value, "number", argument);
            const cpp = context.allocateTemporaryCppName("text_argument");
            context.emit(`const double ${cpp} = ${value.cpp};`);
            return cpp;
        });
        return { kind: "void", cpp: `bbl::text_set_${field(owner.textTransform!)}(*(${owner.cpp}), ${args.join(", ")})` };
    }
    const assignment = isAssignmentExpression(node) ? node : undefined;
    const increment = isUpdateExpression(node) ? node : undefined;
    const target = assignment?.left ?? increment?.operand;
    if (!target) return undefined;
    const left = context.unwrap(target);
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return undefined;
    const value = ownerValue(context, left.expression);
    if (!value) return undefined;
    if (!ts.isPropertyAccessExpression(left)) context.fail(left, "Computed text property writes are not represented.");
    const owner = retainTextValue(context, value);
    const name = left.name.text;
    const transform = owner.textTransform;
    const axis = transform ? axes(transform).indexOf(name) : -1;
    if (["text-data","text-run","text-renderer"].includes(owner.kind) || (owner.kind === "text-vector" && axis < 0) ||
        (owner.kind === "text-layer" && !["rotationRad","scale","order","opacity","coverageGamma","visible"].includes(name)) ||
        (owner.kind === "text-renderable" && !["opacity", "order", "ignoreDepth"].includes(name)))
        context.fail(left, `Text property '${name}' is read-only or requires an unsupported replacement.`);
    if (owner.kind === "text-renderable" && (name === "ignoreDepth" || name === "order")) context.assertTextPipelineMutable(left);
    const boolean = name === "ignoreDepth" || name === "visible";
    const operator = assignment?.operatorToken.getText() ?? (increment!.operator === ts.SyntaxKind.PlusPlusToken ? "+=" : "-=");
    if (boolean && operator !== "=") context.fail(left, "Text ignoreDepth supports simple boolean assignment.");
    if (!["=", "+=", "-=", "*=", "/="].includes(operator)) context.fail(left, `Text property assignment '${operator}' is not represented.`);
    let previous: string | undefined;
    if (operator !== "=") {
        previous = context.allocateTemporaryCppName("text_previous");
        context.emit(`const double ${previous} = ${readTextProperty(context, owner, name, left)!.cpp};`);
    }
    const right = assignment ? context.compileValue(assignment.right) : { kind: "number" as const, cpp: "1.0" };
    context.expectKind(right, boolean ? "boolean" : "number", assignment?.right ?? left);
    const result = context.allocateTemporaryCppName("text_result");
    context.emit(`const ${boolean ? "bool" : "double"} ${result} = ${previous ? `${previous} ${operator[0]} (${right.cpp})` : right.cpp};`);
    context.emit(owner.kind === "text-vector"
        ? `bbl::text_write_${field(transform!)}(*(${owner.cpp}), ${axis}, ${result});`
        : `(${owner.cpp})->${field(name)} = ${result};`);
    return { kind: boolean ? "boolean" : "number", cpp: increment && ts.isPostfixUnaryExpression(increment) ? previous! : result,
        dataType: { kind: boolean ? "boolean" : "number" } };
}
