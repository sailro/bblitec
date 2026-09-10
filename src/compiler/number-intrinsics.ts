import { EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import type { ExpressionContext } from "./expressions.js";
import type { Value } from "./types.js";

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
    isLibrary: (identifier: ts.Identifier) => boolean,
): number | undefined {
    return ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Number" && isLibrary(expression.expression)
        ? constants.get(expression.name.text) : undefined;
}

const predicates: ReadonlyMap<string, { cpp: string; fold: (value: number) => boolean }> = new EmissionMap([
    ["isFinite", { cpp: "std::isfinite", fold: Number.isFinite }],
    ["isNaN", { cpp: "std::isnan", fold: Number.isNaN }],
    ["isInteger", { cpp: "bbl::js::number_is_integer", fold: Number.isInteger }],
    ["isSafeInteger", { cpp: "bbl::js::number_is_safe_integer", fold: Number.isSafeInteger }],
]);

export function compileNumberPredicate(context: ExpressionContext, call: ts.CallExpression): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) ||
        callee.expression.text !== "Number" || !context.isDefaultLibraryIdentifier(callee.expression)) return undefined;
    const predicate = predicates.get(callee.name.text);
    if (!predicate) return undefined;
    context.expectArgumentCount(call, 1, 1);
    context.reachJsData();
    const value = context.compileValue(call.arguments[0]!);
    if (value.staticNumber !== undefined) {
        const staticBoolean = predicate.fold(value.staticNumber);
        return { kind: "boolean", cpp: staticBoolean ? "true" : "false", staticBoolean, dataType: { kind: "boolean" } };
    }
    const numeric = value.kind === "number" || value.dataType?.kind === "number";
    const optionalNumeric = value.dataType?.kind === "optional" && value.dataType.inner.kind === "number";
    let cpp: string;
    if (value.dataType?.kind === "json" || optionalNumeric) {
        const argument = context.allocateTemporaryCppName("number_predicate_argument");
        context.emit({ kind: "declaration", type: "const auto", name: argument, initializer: value.cpp });
        cpp = optionalNumeric
            ? `(${argument}.has_value() && ${predicate.cpp}(*${argument}))`
            : `(${argument}.is_number() && ${predicate.cpp}(${argument}.to_number()))`;
    } else if (numeric) cpp = `${predicate.cpp}(${value.cpp})`;
    else {
        context.emitDiscardedValue(value);
        cpp = "false";
    }
    return { kind: "boolean", cpp, dataType: { kind: "boolean" } };
}

export function numberConstantValue(value: number): Value {
    const cpp = Number.isNaN(value) ? "std::numeric_limits<double>::quiet_NaN()"
        : !Number.isFinite(value) ? `${value < 0 ? "-" : ""}std::numeric_limits<double>::infinity()`
        : doubleLiteral(value);
    return { kind: "number", cpp, staticNumber: value, dataType: { kind: "number" } };
}
