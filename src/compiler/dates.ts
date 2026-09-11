import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/** The default Intl formatter captures its host time zone at construction. */
export function compileDateTimeFormat(lowerer: DataLowerer, expression: ts.CallExpression | ts.NewExpression): Value | undefined {
    const callee = lowerer.context.unwrap(expression.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "DateTimeFormat" ||
        !ts.isIdentifier(callee.expression) || callee.expression.text !== "Intl" ||
        !lowerer.context.isDefaultLibraryIdentifier(callee.expression)) return undefined;
    if (expression.arguments?.length) lowerer.context.fail(expression, "Intl.DateTimeFormat currently supports the default locale and options.");
    lowerer.context.reachJsData();
    return {kind:"data", cpp:"bbl::js::make_date_time_format()", dataType:{kind:"date-time-format"}, impure:true};
}

export function compileDateTimeFormatMethod(lowerer: DataLowerer, call: ts.CallExpression, owner: Value, method: string): Value {
    if (method !== "resolvedOptions") lowerer.context.fail(call, `Intl.DateTimeFormat.${method} is not lowered.`);
    lowerer.context.expectArgumentCount(call, 0, 0);
    const timeZone = lowerer.context.pinValueToTemporary({kind:"string", cpp:`*(${owner.cpp})`}, "resolved_time_zone");
    return {kind:"record", cpp:"", recordProperties:{timeZone}};
}

/** Date instances retain identity and a mutable, clipped millisecond value. */
export function compileDateNew(lowerer: DataLowerer, expression: ts.NewExpression): Value | undefined {
    const context = lowerer.context;
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "Date" ||
        !context.isDefaultLibraryIdentifier(expression.expression)) return undefined;
    const args = expression.arguments ?? [];
    if (args.length > 1) context.fail(expression, "Date construction supports the current time or one numeric timestamp or Date value.");
    context.reachJsData();
    const value = args[0] ? context.compileValue(args[0]) : undefined;
    const timestamp = !value ? "bbl::js::epoch_milliseconds()" : value.dataType?.kind === "date"
        ? `*(${value.cpp})` : value.kind === "number" ? context.castNumber(value, "double") :
        context.fail(args[0]!, "Date construction requires a numeric timestamp or a Date value.");
    return {kind:"data", cpp:`bbl::js::make_date(${timestamp})`, dataType:{kind:"date"}, impure:true};
}

export function compileDateMethod(lowerer: DataLowerer, call: ts.CallExpression, owner: Value, method: string): Value {
    const context = lowerer.context;
    context.reachJsData();
    switch (method) {
        case "toISOString":
            context.expectArgumentCount(call, 0, 0);
            return {kind:"string", cpp:`bbl::js::date_iso_string(${owner.cpp})`};
        case "getTime":
        case "valueOf":
            context.expectArgumentCount(call, 0, 0);
            return {kind:"number", cpp:`*(${owner.cpp})`};
        case "setTime": {
            context.expectArgumentCount(call, 1, 1);
            const receiver = context.pinValueToTemporary(owner, "date_receiver");
            const timestamp = context.compileNumber(call.arguments[0]!, "double");
            return {kind:"number", cpp:`(*(${receiver.cpp}) = bbl::js::date_time_clip(${timestamp}))`, impure:true};
        }
        default: return context.fail(call, `Date.${method} is not lowered.`);
    }
}
