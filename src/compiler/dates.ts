import ts from "typescript";
import { EmissionMap } from "./emission-transaction.js";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";
import { compileDateLocaleString } from "./locale.js";

/** The default Intl formatter captures its host time zone at construction. */
export function compileDateTimeFormat(
    lowerer: DataLowerer,
    expression: ts.CallExpression | ts.NewExpression,
): Value | undefined {
    const callee = lowerer.context.unwrap(expression.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "DateTimeFormat" ||
        lowerer.context.libraryGlobal(callee.expression) !== "Intl"
    )
        return undefined;
    if (expression.arguments?.length)
        lowerer.context.fail(
            expression,
            "Intl.DateTimeFormat currently supports the default locale and options.",
        );
    lowerer.context.reachJsData();
    return {
        kind: "data",
        cpp: "bbl::js::make_date_time_format()",
        dataType: { kind: "date-time-format" },
        impure: true,
    };
}

export function compileDateTimeFormatMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    if (method !== "resolvedOptions")
        lowerer.context.fail(
            call,
            `Intl.DateTimeFormat.${method} is not lowered.`,
        );
    lowerer.context.expectArgumentCount(call, 0, 0);
    const timeZone = lowerer.context.bindings.pinValueToTemporary(
        { kind: "string", cpp: `*(${owner.cpp})` },
        "resolved_time_zone",
    );
    return { kind: "record", cpp: "", recordProperties: { timeZone } };
}

/** Date instances retain identity and a mutable, clipped millisecond value. */
export function compileDateNew(
    lowerer: DataLowerer,
    expression: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    if (context.libraryGlobal(expression.expression) !== "Date")
        return undefined;
    const args = expression.arguments ?? [];
    if (args.length > 1)
        context.fail(
            expression,
            "Date construction supports the current time or one numeric timestamp or Date value.",
        );
    context.reachJsData();
    const value = args[0] ? context.compileValue(args[0]) : undefined;
    const timestamp = !value
        ? "bbl::js::epoch_milliseconds()"
        : value.dataType?.kind === "date"
          ? `*(${value.cpp})`
          : value.kind === "number"
            ? context.castNumber(value, "double")
            : context.fail(
                  args[0]!,
                  "Date construction requires a numeric timestamp or a Date value.",
              );
    return {
        kind: "data",
        cpp: `bbl::js::make_date(${timestamp})`,
        dataType: { kind: "date" },
        impure: true,
    };
}

/** The calendar and clock fields the `get<Field>`/`getUTC<Field>` getters read. */
const DATE_FIELDS: ReadonlyMap<string, string> = new EmissionMap([
    ["FullYear", "year"],
    ["Month", "month"],
    ["Date", "date"],
    ["Day", "weekday"],
    ["Hours", "hours"],
    ["Minutes", "minutes"],
    ["Seconds", "seconds"],
    ["Milliseconds", "milliseconds"],
]);

/**
 * A Date field getter: `getUTC<Field>` reads the time value as UTC, `get<Field>`
 * as local time in the host time zone, which the locale PAL resolves.
 */
function compileDateFieldGetter(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    const utc = method.startsWith("getUTC");
    const field = DATE_FIELDS.get(method.slice(utc ? 6 : 3));
    if (!method.startsWith("get") || field === undefined) return undefined;
    const context = lowerer.context;
    context.expectArgumentCount(call, 0, 0);
    if (!utc) context.reachFeature("data:locale", call);
    return {
        kind: "number",
        cpp: `bbl::${utc ? "js::date_utc_field" : "pal::date_local_field"}(${owner.cpp}, bbl::js::DateField::${field})`,
        dataType: { kind: "number" },
    };
}

/**
 * `Date.UTC(year, month?, ...)`: each argument converts to a number in
 * order; an omitted month is 0, an omitted day 1 and an omitted time field 0.
 */
export function compileDateUtc(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value {
    const context = lowerer.context;
    if (call.arguments.length > 7 || call.arguments.some(ts.isSpreadElement))
        context.fail(
            call,
            "Date.UTC takes a year and up to six numeric fields as separate arguments.",
        );
    context.reachJsData();
    const defaults = ["std::numeric_limits<double>::quiet_NaN()", "0.0", "1.0"];
    const fields = Array.from({ length: 7 }, (_, index) => {
        const argument = call.arguments[index];
        return argument
            ? lowerer.compileNumberArgument(argument, "")
            : (defaults[index] ?? "0.0");
    });
    return {
        kind: "number",
        cpp: `bbl::js::date_utc(${fields.join(", ")})`,
        dataType: { kind: "number" },
    };
}

export function compileDateMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    context.reachJsData();
    const getter = compileDateFieldGetter(lowerer, call, owner, method);
    if (getter) return getter;
    switch (method) {
        case "getTimezoneOffset":
            context.expectArgumentCount(call, 0, 0);
            context.reachFeature("data:locale", call);
            return {
                kind: "number",
                cpp: `bbl::pal::date_time_zone_offset(${owner.cpp})`,
                dataType: { kind: "number" },
            };
        case "toISOString":
            context.expectArgumentCount(call, 0, 0);
            return {
                kind: "string",
                cpp: `bbl::js::date_iso_string(${owner.cpp})`,
            };
        case "getTime":
        case "valueOf":
            context.expectArgumentCount(call, 0, 0);
            return { kind: "number", cpp: `*(${owner.cpp})` };
        case "setTime": {
            context.expectArgumentCount(call, 1, 1);
            const receiver = context.bindings.pinValueToTemporary(
                owner,
                "date_receiver",
            );
            const timestamp = context.compileNumber(
                call.arguments[0]!,
                "double",
            );
            return {
                kind: "number",
                cpp: `(*(${receiver.cpp}) = bbl::js::date_time_clip(${timestamp}))`,
                impure: true,
            };
        }
        default:
            return (
                compileDateLocaleString(lowerer, call, owner, method) ??
                context.fail(call, `Date.${method} is not lowered.`)
            );
    }
}
