// ECMAScript Symbol values (`bbl::js::Symbol`): `Symbol(description)`
// creates a unique identity, `Symbol.for`/`Symbol.keyFor` use the realm's
// registry, and a symbol answers `description` and `toString()`.
import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { stringConcatPart } from "./expressions.js";
import type { LoweringServices } from "./lowering-services.js";
import { isUndefinedDataType } from "./data-types.js";
import type { Value } from "./types.js";

type SymbolContext = Pick<
    LoweringServices,
    | "absenceTags"
    | "checker"
    | "compileValue"
    | "cppString"
    | "dataTypes"
    | "dataValue"
    | "dataLowerer"
    | "emitDiscardedValue"
    | "fail"
    | "libraryGlobal"
    | "reachJsData"
    | "unwrap"
>;

const symbolType = { kind: "symbol" } as const;
const optionalString = {
    kind: "optional",
    undefinedOnly: true,
    inner: { kind: "string" },
} as const;

/** A symbol's description argument: absent, or the text it converts to. */
function descriptionCpp(
    context: SymbolContext,
    argument: ts.Expression | undefined,
): string {
    if (!argument) return "std::nullopt";
    const value = context.compileValue(argument);
    if (
        (value.kind === "json-null" && value.cpp === "std::nullopt") ||
        isUndefinedDataType(value.dataType)
    ) {
        if (value.kind !== "json-null") context.emitDiscardedValue(value);
        return "std::nullopt";
    }
    if (value.kind === "json-null" || value.dataType?.kind === "optional")
        return context.fail(
            argument,
            "A symbol description that may be absent needs a value known to be a string or undefined.",
        );
    return `bbl::js::Nullable<std::string>(bbl::js::concat(${stringConcatPart(context, value, argument)}))`;
}

/** `Symbol(description)`, `Symbol.for(key)` and `Symbol.keyFor(symbol)`. */
export function compileSymbolCall(
    context: SymbolContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    const statics =
        ts.isPropertyAccessExpression(callee) &&
        context.libraryGlobal(callee.expression) === "Symbol"
            ? callee.name.text
            : undefined;
    if (context.libraryGlobal(callee) !== "Symbol" && !statics)
        return undefined;
    context.reachJsData();
    const [argument, ...rest] = call.arguments;
    if (rest.length > 0 || (argument && ts.isSpreadElement(argument)))
        return context.fail(call, "Symbol functions take one argument.");
    if (!statics)
        return context.dataValue(
            `bbl::js::Symbol::create(${descriptionCpp(context, argument)})`,
            symbolType,
        );
    if (statics === "for") {
        if (!argument)
            return context.fail(call, "Symbol.for takes the registry key.");
        const key = context.compileValue(argument);
        return context.dataValue(
            `bbl::js::Symbol::registered(bbl::js::concat(${stringConcatPart(context, key, argument)}))`,
            symbolType,
        );
    }
    if (statics === "keyFor") {
        if (!argument)
            return context.fail(call, "Symbol.keyFor takes a symbol.");
        const symbol = context.dataLowerer.compileForSink(argument, symbolType);
        return context.dataValue(`(${symbol}).registry_key()`, optionalString);
    }
    return context.fail(
        call.expression,
        `Symbol.${statics} has no native implementation.`,
    );
}

/** `symbol.description`. */
export function symbolProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    return property === "description"
        ? lowerer.leafValue(`(${owner.cpp}).description()`, optionalString)
        : undefined;
}

/** `symbol.toString()` and `symbol.valueOf()`. */
export function compileSymbolMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    if (call.arguments.length > 0)
        return lowerer.context.fail(
            call,
            `Symbol ${method} takes no arguments.`,
        );
    if (method === "toString")
        return lowerer.leafValue(`(${owner.cpp}).to_string()`, {
            kind: "string",
        });
    if (method === "valueOf") return owner;
    return lowerer.context.fail(
        call.expression,
        `Symbol method '${method}' has no native implementation.`,
    );
}
