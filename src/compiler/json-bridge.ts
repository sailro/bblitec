// The JSON bridge: `JSON.stringify` over the plain-data model, and
// `JSON.parse` plus the surface a parsed document is interrogated with.
//
// Neither half knows an application. `stringify` takes whatever data type
// its argument already has and registers the records it reaches so their
// codecs are generated beside them; `parse` produces the model's one
// dynamic value, and every read over that value answers the way the
// browser's does -- a missing property is `undefined`, a wrong-typed one
// fails its guard rather than the program.
//
// The dynamic value stays where the parse put it. It is produced by
// `JSON.parse` and by reads that descend into one, and it converts at a
// sink (a number, a string, a condition) exactly where JavaScript coerces.

import ts from "typescript";

import { browserGlobalNamed } from "./browser-erasure.js";
import type { DataType } from "./data-types.js";
import type { Feature, Value } from "./types.js";

/** The narrow slice of the expression context this bridge needs. */
export interface JsonBridgeContext {
    readonly checker: ts.TypeChecker;
    unwrap(expression: ts.Expression): ts.Expression;
    fail(node: ts.Node, message: string): never;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileCondition(expression: ts.Expression): string;
    cppString(value: string): string;
    reachFeature(feature: Feature, site?: ts.Node): void;
    reachJsData(): void;
    reachJson(): void;
    readonly dataLowerer: {
        dataTypeAt(node: ts.Node): DataType | undefined;
        compileForSink(expression: ts.Expression, dataType: DataType): string;
    };
    readonly dataTypes: {
        markJsonSerialized(dataType: DataType, node: ts.Node): void;
    };
}

interface JsonStrictComparisonContext {
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileCondition(expression: ts.Expression): string;
    fail(node: ts.Node, message: string): never;
}

const jsonType: DataType = { kind: "json" };

/** A value carrying a parsed document. */
export function isJsonValue(
    value: Value | undefined,
): value is Value & {
    kind: "data";
    dataType: Extract<DataType, { kind: "json" }>;
} {
    return value?.kind === "data" && value.dataType?.kind === "json";
}

function jsonValue(cpp: string): Value {
    return { kind: "data", cpp, dataType: jsonType };
}

/**
 * `JSON` resolved to the global object rather than to something a scene
 * bound itself.
 */
function isJsonGlobal(
    context: JsonBridgeContext,
    expression: ts.Expression,
): boolean {
    return browserGlobalNamed(context, expression)?.text === "JSON";
}

/**
 * `JSON.stringify(value)` and `JSON.stringify(value, null, n)`.
 *
 * The replacer is the reached subset: `null` and `undefined` are the two
 * spellings of "no replacer", and a function or an allow-list would change
 * what the document holds, so it refuses instead of ignoring one.
 */
function compileStringify(
    context: JsonBridgeContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 3);
    const replacer = call.arguments[1];
    if (replacer !== undefined) {
        const unwrapped = context.unwrap(replacer);
        const isNothing =
            unwrapped.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(unwrapped) &&
                unwrapped.text === "undefined" &&
                !context.lookupOptional(unwrapped));
        if (!isNothing) {
            context.fail(
                replacer,
                "JSON.stringify lowers with no replacer; a replacer " +
                    "function or key list decides the document's shape at " +
                    "run time and is not reached.",
            );
        }
    }
    let indent = 0;
    const spacing = call.arguments[2];
    if (spacing !== undefined) {
        const compiled = context.compileValue(context.unwrap(spacing));
        const staticNumber = compiled.staticNumber;
        if (
            staticNumber === undefined ||
            !Number.isInteger(staticNumber) ||
            staticNumber < 0
        ) {
            context.fail(
                spacing,
                "JSON.stringify indentation must be a generation-known " +
                    "non-negative whole number; the emitted document's " +
                    "shape is decided when it is written.",
            );
        }
        // The specification clamps the indent at ten spaces.
        indent = Math.min(staticNumber, 10);
    }
    const argument = call.arguments[0]!;
    const dataType = context.dataLowerer.dataTypeAt(argument);
    if (!dataType) {
        context.fail(
            argument,
            "JSON.stringify serializes a plain-data value; this argument " +
                "has no data type in the model.",
        );
    }
    context.reachJson();
    context.reachJsData();
    context.dataTypes.markJsonSerialized(dataType, argument);
    const value = context.dataLowerer.compileForSink(argument, dataType);
    return {
        kind: "data",
        cpp:
            indent > 0
                ? `bbl::js::json_stringify(${value}, ${indent})`
                : `bbl::js::json_stringify(${value})`,
        dataType: { kind: "string" },
    };
}

/** `JSON.parse(text)`: the parser owns the grammar and throws on a bad one. */
function compileParse(
    context: JsonBridgeContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 2);
    if (call.arguments[1] !== undefined) {
        context.fail(
            call.arguments[1],
            "JSON.parse lowers with no reviver; a reviver rewrites the " +
                "document as it is read and is not reached.",
        );
    }
    context.reachJson();
    context.reachJsData();
    const text = context.dataLowerer.compileForSink(call.arguments[0]!, {
        kind: "string",
    });
    return jsonValue(`bbl::js::json_parse(${text})`);
}

/** The two `JSON` methods, recognized by the global they are read from. */
export function compileJsonCall(
    context: JsonBridgeContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        !isJsonGlobal(context, context.unwrap(callee.expression))
    ) {
        return undefined;
    }
    if (callee.name.text === "stringify") {
        return compileStringify(context, call);
    }
    if (callee.name.text === "parse") {
        return compileParse(context, call);
    }
    context.fail(
        callee.name,
        `JSON.${callee.name.text} is not lowered; the bridge implements ` +
            "stringify and parse.",
    );
}

/**
 * Whether an expression is a read rooted in a parsed document, decided
 * without compiling it. Callers that must know before they commit to a
 * lowering -- an equality comparison choosing between two operand
 * strategies -- ask this first.
 */
export function isJsonRootedExpression(
    context: Pick<JsonBridgeContext, "unwrap" | "lookupOptional">,
    expression: ts.Expression,
): boolean {
    const unwrapped = context.unwrap(expression);
    if (ts.isIdentifier(unwrapped)) {
        return isJsonValue(context.lookupOptional(unwrapped));
    }
    if (
        ts.isPropertyAccessExpression(unwrapped) ||
        ts.isElementAccessExpression(unwrapped)
    ) {
        return isJsonRootedExpression(context, unwrapped.expression);
    }
    return false;
}

/**
 * The value a chain rooted in a parsed document produces, or `undefined`
 * when the expression is not one.
 *
 * Only descent is handled here, because descent is what has no static type
 * to consult: `file.parts[0].s` is three reads over a document whose shape
 * the source has not proven yet. Everything the chain reaches is another
 * dynamic value, except `length`, which JavaScript answers as a number.
 */
export function compileJsonRead(
    context: JsonBridgeContext,
    expression: ts.Expression,
): Value | undefined {
    const unwrapped = context.unwrap(expression);
    if (ts.isIdentifier(unwrapped)) {
        const bound = context.lookupOptional(unwrapped);
        return isJsonValue(bound) ? bound : undefined;
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
        const owner = compileJsonRead(context, unwrapped.expression);
        if (!isJsonValue(owner)) {
            return undefined;
        }
        if (unwrapped.name.text === "length") {
            return {
                kind: "number",
                cpp: `${owner!.cpp}.length()`,
                dataType: { kind: "number" },
            };
        }
        return jsonValue(
            `${owner!.cpp}.get(${context.cppString(unwrapped.name.text)})`,
        );
    }
    if (ts.isElementAccessExpression(unwrapped)) {
        const owner = compileJsonRead(context, unwrapped.expression);
        if (!isJsonValue(owner)) {
            return undefined;
        }
        const index = context.unwrap(unwrapped.argumentExpression);
        const indexValue = context.compileValue(index);
        if (
            indexValue.kind === "string" ||
            indexValue.dataType?.kind === "string"
        ) {
            return jsonValue(
                `${owner!.cpp}.get(${indexValue.staticString !== undefined ? context.cppString(indexValue.staticString) : indexValue.cpp})`,
            );
        }
        return jsonValue(
            `${owner!.cpp}.at(${context.compileNumber(index, "double")})`,
        );
    }
    if (ts.isCallExpression(unwrapped)) {
        const parsed = compileJsonCall(context, unwrapped);
        return isJsonValue(parsed) ? parsed : undefined;
    }
    return undefined;
}

/**
 * Strict comparison between a parsed document and one scalar/nullish value.
 * JSON owns the dynamic type test; the equality dispatcher owns operand order
 * and negation.
 */
export function compileJsonStrictComparison(
    context: JsonStrictComparisonContext,
    documentCpp: string,
    other: ts.Expression,
    otherIsNullish: boolean,
    compileString: (expression: ts.Expression) => string,
): string | undefined {
    if (otherIsNullish) {
        return other.kind === ts.SyntaxKind.NullKeyword
            ? `${documentCpp}.is_null()`
            : `${documentCpp}.is_undefined()`;
    }
    const value = context.compileValue(other);
    if (value.kind === "number" || value.dataType?.kind === "number") {
        return `${documentCpp}.strict_equals(${context.compileNumber(other, "double")})`;
    }
    if (value.kind === "boolean" || value.dataType?.kind === "boolean") {
        return `${documentCpp}.strict_equals(${context.compileCondition(other)})`;
    }
    if (value.kind === "string" || value.dataType?.kind === "string") {
        return `${documentCpp}.strict_equals(${compileString(other)})`;
    }
    if (isJsonValue(value)) {
        context.fail(
            other,
            "Two parsed documents compare by reference in JavaScript; " +
                "the bridge lowers a document against a scalar, null or " +
                "undefined.",
        );
    }
    return undefined;
}

/**
 * `typeof document`, which is the operator over a value whose type is only
 * known at run time -- exactly the case the operator exists for.
 */
export function compileJsonTypeOf(value: Value): Value | undefined {
    if (!isJsonValue(value)) {
        return undefined;
    }
    return {
        kind: "data",
        cpp: `${value.cpp}.type_of()`,
        dataType: { kind: "string" },
    };
}
