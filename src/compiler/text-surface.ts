/** The text transform object retains its renderable; it is never a copied Vec3. */
import ts from "typescript";
import { pinnedHandleKind } from "./data-types.js";
import type { Value } from "./types.js";

export type TextTransform = "position" | "scaling" | "rotation" | "rotationQuaternion";
const transforms: readonly string[] = ["position", "scaling", "rotation", "rotationQuaternion"];
const field = (name: string): string => name === "rotationQuaternion" ? "rotation_quaternion" : name === "ignoreDepth" ? "ignore_depth" : name;
const axes = (name: TextTransform): readonly string[] => name === "rotationQuaternion" ? ["x", "y", "z", "w"] : ["x", "y", "z"];

export interface TextSurfaceContext {
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
    reachFeature(feature: "text:data", node: ts.Node): void;
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
        if (name === "width" || name === "height") return { kind: "number", cpp: `(${owner.cpp})->payload->${name}`, dataType: { kind: "number" }, freshData: true };
        context.fail(site, `Text data property '${name}' is not represented; shaping and internal buffer mutation remain unsupported.`);
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
    if (known && ["text-renderable", "text-vector", "text-data"].includes(known.kind)) return true;
    const type = context.checker.getTypeAtLocation(node);
    if (["text-renderable", "text-data"].includes(pinnedHandleKind(type) ?? "")) return true;
    // ObservableVec3 is also the pin's mesh, splat and camera surface. Its
    // type alone cannot authorize a text read: several of those owners lower
    // writes directly without exposing a first-class vector value.
    return ts.isPropertyAccessExpression(node) && transforms.includes(node.name.text) &&
        pinnedHandleKind(context.checker.getTypeAtLocation(node.expression)) === "text-renderable";
}

function ownerValue(context: TextSurfaceContext, expression: ts.Expression): Value | undefined {
    if (!possibleTextOwner(context, expression)) return undefined;
    return context.probeEmission(() => {
        const value = context.compileValue(expression);
        if (["text-renderable", "text-vector", "text-data"].includes(value.kind)) context.reachFeature("text:data", expression);
        return ["text-renderable", "text-vector", "text-data"].includes(value.kind) ? value : undefined;
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
    const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node : undefined;
    const increment = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node : undefined;
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
    if (owner.kind === "text-data" || (owner.kind === "text-vector" && axis < 0) ||
        (owner.kind === "text-renderable" && !["opacity", "order", "ignoreDepth"].includes(name)))
        context.fail(left, `Text property '${name}' is read-only or requires an unsupported replacement.`);
    if (name === "ignoreDepth" || name === "order") context.assertTextPipelineMutable(left);
    const boolean = name === "ignoreDepth";
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
