import { EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import type { ExpressionContext } from "./expressions.js";
import type { LibraryGlobal } from "./symbols.js";
import {
    booleanValue,
    optionalPresentCpp,
    staticStringValue,
    type Value,
} from "./types.js";

const constants: ReadonlyMap<string, number> = new EmissionMap([
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER],
    ["EPSILON", Number.EPSILON],
    ["MAX_VALUE", Number.MAX_VALUE],
    ["MIN_VALUE", Number.MIN_VALUE],
    ["POSITIVE_INFINITY", Infinity],
    ["NEGATIVE_INFINITY", -Infinity],
    ["NaN", NaN],
]);

export function numberConstant(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
): number | undefined {
    return ts.isPropertyAccessExpression(expression) &&
        libraryGlobal(expression.expression) === "Number"
        ? constants.get(expression.name.text)
        : undefined;
}

const predicates: ReadonlyMap<
    string,
    { cpp: string; fold: (value: number) => boolean }
> = new EmissionMap([
    ["isFinite", { cpp: "std::isfinite", fold: Number.isFinite }],
    ["isNaN", { cpp: "std::isnan", fold: Number.isNaN }],
    [
        "isInteger",
        { cpp: "bbl::js::number_is_integer", fold: Number.isInteger },
    ],
    [
        "isSafeInteger",
        { cpp: "bbl::js::number_is_safe_integer", fold: Number.isSafeInteger },
    ],
]);

/**
 * `Number.isFinite` and its siblings named as values (`list.every(Number.isFinite)`):
 * a function of one number, which ignores the index and array an array
 * method also passes.
 */
export function numberPredicateFunction(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
): Value | undefined {
    if (
        !ts.isPropertyAccessExpression(expression) ||
        libraryGlobal(expression.expression) !== "Number"
    )
        return undefined;
    const predicate = predicates.get(expression.name.text);
    if (!predicate) return undefined;
    return {
        kind: "data",
        cpp: `bbl::js::Callback<bool(double)>([](double value) { return static_cast<bool>(${predicate.cpp}(value)); })`,
        dataType: {
            kind: "function",
            parameters: [{ kind: "number" }],
            result: { kind: "boolean" },
        },
    };
}

export function compileNumberPredicate(
    context: ExpressionContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        context.libraryGlobal(callee.expression) !== "Number"
    )
        return undefined;
    const predicate = predicates.get(callee.name.text);
    if (!predicate) return undefined;
    context.expectArgumentCount(call, 1, 1);
    context.reachJsData();
    const value = context.compileValue(call.arguments[0]!);
    if (value.staticNumber !== undefined) {
        const staticBoolean = predicate.fold(value.staticNumber);
        return {
            kind: "boolean",
            cpp: staticBoolean ? "true" : "false",
            staticBoolean,
            dataType: { kind: "boolean" },
        };
    }
    const numeric =
        value.kind === "number" || value.dataType?.kind === "number";
    const optionalNumeric =
        value.dataType?.kind === "optional" &&
        value.dataType.inner.kind === "number";
    let cpp: string;
    if (value.dataType?.kind === "json" || optionalNumeric) {
        const argument = context.allocateTemporaryCppName(
            "number_predicate_argument",
        );
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: argument,
            initializer: value.cpp,
        });
        cpp = optionalNumeric
            ? `(${optionalPresentCpp(argument)} && ${predicate.cpp}(*${argument}))`
            : `(${argument}.is_number() && ${predicate.cpp}(${argument}.to_number()))`;
    } else if (numeric) cpp = `${predicate.cpp}(${value.cpp})`;
    else {
        context.emitDiscardedValue(value);
        cpp = "false";
    }
    return { kind: "boolean", cpp, dataType: { kind: "boolean" } };
}

/** A scalar generation knows, as its own literal; undefined for any other value. */
export function staticScalarValue(
    value: Value,
    cppString: (text: string) => string,
): Value | undefined {
    if (value.staticNumber !== undefined)
        return numberConstantValue(value.staticNumber);
    if (value.staticBoolean !== undefined)
        return booleanValue(value.staticBoolean ? "true" : "false");
    if (value.staticString !== undefined)
        return staticStringValue(value.staticString, cppString);
    return undefined;
}

export function numberConstantValue(value: number): Value {
    const cpp = Number.isNaN(value)
        ? "std::numeric_limits<double>::quiet_NaN()"
        : !Number.isFinite(value)
          ? `${value < 0 ? "-" : ""}std::numeric_limits<double>::infinity()`
          : doubleLiteral(value);
    return {
        kind: "number",
        cpp,
        staticNumber: value,
        dataType: { kind: "number" },
    };
}
