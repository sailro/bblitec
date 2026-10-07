// ECMAScript BigInt values (`bbl::js::BigInt`, an exact arbitrary-precision
// integer): literals, arithmetic and bitwise operators, `BigInt(...)`,
// `BigInt.asIntN`/`asUintN` and the `toString`/`valueOf` methods. Mixing a
// BigInt with a Number in arithmetic is JavaScript's TypeError, which the
// checker already rejects; it refuses here too.
import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { BIGINT_ARRAY_KINDS } from "./data-types/typed-arrays.js";
import { pinOperand } from "./evaluation-order.js";
import type { LoweringServices } from "./lowering-services.js";
import { expressionMayRunCode, isUpdateExpression } from "./syntax.js";
import { isStringValue, type Value } from "./types.js";

type BigIntContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "bindings"
    | "checker"
    | "compileValue"
    | "cppString"
    | "dataLowerer"
    | "dataTypes"
    | "dataValue"
    | "emit"
    | "evaluationOrder"
    | "fail"
    | "libraryGlobal"
    | "reachJsData"
    | "registerNativeBindingType"
    | "registerNativeConstBinding"
    | "unwrap"
>;

const bigintType = { kind: "bigint" } as const;

/** The C++ operator of a BigInt binary operator, or `pow` for `**`. */
const BIGINT_OPERATORS = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.PlusToken, "+"],
    [ts.SyntaxKind.MinusToken, "-"],
    [ts.SyntaxKind.AsteriskToken, "*"],
    [ts.SyntaxKind.SlashToken, "/"],
    [ts.SyntaxKind.PercentToken, "%"],
    [ts.SyntaxKind.AsteriskAsteriskToken, "pow"],
    [ts.SyntaxKind.AmpersandToken, "&"],
    [ts.SyntaxKind.BarToken, "|"],
    [ts.SyntaxKind.CaretToken, "^"],
    [ts.SyntaxKind.LessThanLessThanToken, "<<"],
    [ts.SyntaxKind.GreaterThanGreaterThanToken, ">>"],
]);

/** The compound assignments a BigInt target takes, by their binary operator. */
export const BIGINT_COMPOUND_OPERATORS = new Map<ts.SyntaxKind, ts.SyntaxKind>([
    [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
    [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
    [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
    [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
    [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
    [
        ts.SyntaxKind.AsteriskAsteriskEqualsToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
    ],
    [ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
    [ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
    [ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
    [
        ts.SyntaxKind.LessThanLessThanEqualsToken,
        ts.SyntaxKind.LessThanLessThanToken,
    ],
    [
        ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
    ],
]);

/** Whether an expression's value is a BigInt (and only a BigInt). */
export function isBigIntTyped(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const type = checker.getTypeAtLocation(expression);
    return (
        (type.isUnion() ? type.types : [type]).every(
            (member) => (member.flags & ts.TypeFlags.BigIntLike) !== 0,
        ) && (type.flags & ts.TypeFlags.Never) === 0
    );
}

/** A literal's value as C++: an int64 when it fits, else its decimal digits. */
export function bigintLiteralCpp(
    context: Pick<LoweringServices, "cppString">,
    value: bigint,
): string {
    return value >= -(2n ** 63n) + 1n && value < 2n ** 63n
        ? `bbl::js::BigInt(std::int64_t{${value.toString()}})`
        : value < 0n
          ? `(-bbl::js::BigInt::from_digits(${context.cppString((-value).toString())}, 10))`
          : `bbl::js::BigInt::from_digits(${context.cppString(value.toString())}, 10)`;
}

/** A BigInt literal's value. */
function literalValue(literal: ts.BigIntLiteral): bigint {
    return BigInt(literal.text.slice(0, -1).replace(/_/g, ""));
}

/** One operand of a BigInt operator, refusing a Number one. */
function operandCpp(
    context: BigIntContext,
    value: Value,
    node: ts.Expression,
): string {
    if (value.dataType?.kind !== "bigint")
        context.fail(
            node,
            "A BigInt operator's operands are both BigInts; mixing in a Number throws a TypeError.",
        );
    return value.cpp;
}

/** `left <op> right` over two BigInt values. */
export function bigintBinaryCpp(
    operator: ts.SyntaxKind,
    left: string,
    right: string,
): string | undefined {
    const cpp = BIGINT_OPERATORS.get(operator);
    if (cpp === undefined) return undefined;
    return cpp === "pow"
        ? `bbl::js::BigInt::pow(${left}, ${right})`
        : `(${left} ${cpp} ${right})`;
}

/**
 * A BigInt-valued literal, operator or call; undefined for an expression of
 * another type or shape.
 */
export function compileBigIntValue(
    context: BigIntContext,
    expression: ts.Expression,
): Value | undefined {
    if (ts.isBigIntLiteral(expression)) {
        context.reachJsData();
        return context.dataValue(
            bigintLiteralCpp(context, literalValue(expression)),
            bigintType,
        );
    }
    if (ts.isCallExpression(expression))
        return compileBigIntCall(context, expression);
    if (!isBigIntTyped(context.checker, expression)) return undefined;
    if (ts.isPrefixUnaryExpression(expression)) {
        if (
            expression.operator !== ts.SyntaxKind.MinusToken &&
            expression.operator !== ts.SyntaxKind.TildeToken
        )
            return undefined;
        const operand = context.compileValue(expression.operand);
        return context.dataValue(
            `(${expression.operator === ts.SyntaxKind.MinusToken ? "-" : "~"}${operandCpp(context, operand, expression.operand)})`,
            bigintType,
        );
    }
    if (
        ts.isBinaryExpression(expression) &&
        BIGINT_OPERATORS.has(expression.operatorToken.kind)
    ) {
        // The left operand is read before the right one runs: the
        // operands of a C++ operator call are unsequenced.
        let left = context.compileValue(expression.left);
        if (
            expressionMayRunCode(expression.right) ||
            context.evaluationOrder.operandsToPin([
                expression.left,
                expression.right,
            ])[0]
        )
            left = pinOperand(context, left, expression.left, "bigint_left");
        const right = context.compileValue(expression.right);
        return context.dataValue(
            bigintBinaryCpp(
                expression.operatorToken.kind,
                operandCpp(context, left, expression.left),
                operandCpp(context, right, expression.right),
            )!,
            bigintType,
        );
    }
    return undefined;
}

/** `BigInt(value)`, `BigInt.asIntN(bits, value)` and `BigInt.asUintN(bits, value)`. */
function compileBigIntCall(
    context: BigIntContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    const method =
        ts.isPropertyAccessExpression(callee) &&
        context.libraryGlobal(callee.expression) === "BigInt"
            ? callee.name.text
            : undefined;
    if (context.libraryGlobal(callee) !== "BigInt" && method === undefined)
        return undefined;
    context.reachJsData();
    if (call.arguments.some(ts.isSpreadElement))
        return context.fail(
            call,
            "BigInt functions take their arguments directly.",
        );
    if (method === "asIntN" || method === "asUintN") {
        if (call.arguments.length !== 2)
            return context.fail(
                call,
                `BigInt.${method} takes a bit width and a BigInt.`,
            );
        const bits = context.dataLowerer.compileForSink(call.arguments[0]!, {
            kind: "number",
        });
        const value = context.compileValue(call.arguments[1]!);
        return context.dataValue(
            `bbl::js::BigInt::${method === "asIntN" ? "as_int_n" : "as_uint_n"}(${bits}, ${operandCpp(context, value, call.arguments[1]!)})`,
            bigintType,
        );
    }
    if (method !== undefined)
        return context.fail(
            call.expression,
            `BigInt.${method} has no native implementation.`,
        );
    if (call.arguments.length !== 1)
        return context.fail(call, "BigInt takes one value.");
    const argument = call.arguments[0]!;
    const value = context.compileValue(argument);
    if (value.dataType?.kind === "bigint") return value;
    if (value.kind === "number" || value.dataType?.kind === "number")
        return context.dataValue(
            `bbl::js::BigInt::from_number(${value.cpp})`,
            bigintType,
        );
    if (value.kind === "boolean" || value.dataType?.kind === "boolean")
        return context.dataValue(
            `bbl::js::BigInt(std::int64_t{(${value.cpp}) ? 1 : 0})`,
            bigintType,
        );
    if (isStringValue(value))
        return context.dataValue(
            `bbl::js::BigInt::from_string(${value.cpp})`,
            bigintType,
        );
    return context.fail(
        argument,
        "BigInt converts a number, string, boolean or BigInt; other values throw.",
    );
}

/** The BigInt storage a compound assignment or update writes. */
function bigintPlace(context: BigIntContext, target: ts.Expression): Value {
    const place = context.dataLowerer.compileDataPath(target, "write");
    if (place?.dataType?.kind !== "bigint" || !place.cpp)
        return context.fail(
            target,
            "A BigInt compound assignment or update writes a BigInt local, field or element.",
        );
    return place;
}

/**
 * `target op= value` on a BigInt place: the old value is read before the
 * right side runs, then the place takes the result.
 */
export function emitBigIntCompoundAssignment(
    context: BigIntContext,
    expression: ts.BinaryExpression,
): boolean {
    const operator = BIGINT_COMPOUND_OPERATORS.get(
        expression.operatorToken.kind,
    );
    if (
        operator === undefined ||
        !isBigIntTyped(context.checker, expression.left)
    )
        return false;
    const place = bigintPlace(context, context.unwrap(expression.left));
    const previous = expressionMayRunCode(expression.right)
        ? context.bindings.pinValueToTemporary(
              place,
              "bigint_previous",
              expression.left,
          ).cpp
        : place.cpp;
    const right = context.compileValue(expression.right);
    context.emit({
        kind: "expression",
        code: `${place.cpp} = ${bigintBinaryCpp(operator, previous, operandCpp(context, right, expression.right))!};`,
    });
    return true;
}

/** `x++`, `--x` on a BigInt place: the old (postfix) or new (prefix) value. */
export function compileBigIntUpdate(
    context: BigIntContext,
    expression: ts.Expression,
): Value | undefined {
    if (
        !isUpdateExpression(expression) ||
        !isBigIntTyped(context.checker, expression.operand)
    )
        return undefined;
    const place = bigintPlace(context, context.unwrap(expression.operand));
    const step =
        expression.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
    const next = `${place.cpp} = ${place.cpp} ${step} bbl::js::BigInt(std::int64_t{1})`;
    return {
        ...context.dataValue(
            ts.isPostfixUnaryExpression(expression)
                ? `[&]() { bbl::js::BigInt previous = ${place.cpp}; ${next}; return previous; }()`
                : `(${next})`,
            bigintType,
        ),
        impure: true,
    };
}

function bigintArrayElement(kind: "i64array" | "u64array"): string {
    return kind === "i64array" ? "std::int64_t" : "std::uint64_t";
}

/**
 * `new BigInt64Array(...)`: a length, an array of BigInts, another BigInt
 * typed array (copied), or a view of an ArrayBuffer.
 */
export function compileBigIntArrayNew(
    lowerer: DataLowerer,
    expression: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    const constructor = context.libraryGlobal(expression.expression);
    const kind = constructor ? BIGINT_ARRAY_KINDS.get(constructor) : undefined;
    if (!kind) return undefined;
    context.reachJsData();
    const type = { kind } as const;
    const cppType = context.dataTypes.cppType(type);
    const element = bigintArrayElement(kind);
    const arguments_ = expression.arguments ?? [];
    if (arguments_.some(ts.isSpreadElement) || arguments_.length > 3)
        return context.fail(
            expression,
            `${constructor} takes a length, an array, a typed array or a buffer view.`,
        );
    const [source, ...view] = arguments_;
    const fresh = (cpp: string): Value => ({
        ...lowerer.leafValue(cpp, type),
        freshData: true,
    });
    if (!source) return fresh(`${cppType}()`);
    const sourceType = lowerer.dataTypeAt(source);
    if (sourceType?.kind === "arraybuffer") {
        const buffer = lowerer.compileForSink(source, sourceType);
        const offset = view[0]
            ? lowerer.compileForSink(view[0], { kind: "number" })
            : "0.0";
        const length = view[1]
            ? `std::optional<double>(${lowerer.compileForSink(view[1], { kind: "number" })})`
            : "std::nullopt";
        return fresh(`${cppType}(${buffer}, ${offset}, ${length})`);
    }
    if (view.length > 0)
        return context.fail(
            expression,
            `${constructor} takes a byte offset and length only over an ArrayBuffer.`,
        );
    if (sourceType?.kind === "number")
        return fresh(
            `${cppType}(bbl::js::buffer_view_index(${lowerer.compileForSink(source, sourceType)}))`,
        );
    if (sourceType?.kind === "i64array" || sourceType?.kind === "u64array") {
        const copied = lowerer.compileForSink(source, sourceType);
        return fresh(
            `[](const auto& source) { ${cppType} copy(source.size()); for (std::size_t index = 0; index < source.size(); ++index) copy.store(index, static_cast<${element}>(source.load(index))); return copy; }(${copied})`,
        );
    }
    const elements = lowerer.compileForSink(source, {
        kind: "vector",
        element: bigintType,
    });
    return fresh(`bbl::js::bigint_array_from<${element}>(${elements})`);
}

/** `length`, `byteLength`, `byteOffset` and `buffer` of a BigInt typed array. */
export function bigintArrayProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    switch (property) {
        case "length":
            return lowerer.leafValue(
                `static_cast<double>((${owner.cpp}).size())`,
                { kind: "number" },
            );
        case "byteLength":
            return lowerer.leafValue(
                `static_cast<double>((${owner.cpp}).byte_length())`,
                { kind: "number" },
            );
        case "byteOffset":
            return lowerer.leafValue(
                `static_cast<double>((${owner.cpp}).byte_offset())`,
                { kind: "number" },
            );
        case "buffer":
            return lowerer.leafValue(`(${owner.cpp}).buffer()`, {
                kind: "arraybuffer",
            });
        default:
            return undefined;
    }
}

/**
 * `array[index]` of a BigInt typed array: a BigInt read or a store place.
 * An index outside the array refuses at run time, as for the other typed
 * arrays.
 */
export function bigintArrayElementAccess(
    lowerer: DataLowerer,
    owner: Value,
    index: string,
    mode: "read" | "write",
    site: string,
): Value {
    return lowerer.leafValue(
        `bbl::js::bigint_array_${mode === "write" ? "slot" : "load"}(${owner.cpp}, ${index}, ${site})`,
        bigintType,
    );
}

/** `bigint.toString(radix)`, `bigint.valueOf()`. */
export function compileBigIntMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    if (method === "valueOf" && call.arguments.length === 0) return owner;
    if (method === "toString" && call.arguments.length <= 1) {
        const radix = call.arguments[0]
            ? lowerer.compileForSink(call.arguments[0], { kind: "number" })
            : "10";
        return lowerer.leafValue(`(${owner.cpp}).to_string(${radix})`, {
            kind: "string",
        });
    }
    return lowerer.context.fail(
        call.expression,
        `BigInt method '${method}' has no native implementation.`,
    );
}
