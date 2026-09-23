import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { expressionMayRunCode } from "./syntax.js";

/**
 * The default-library Error constructors a scene throws, holds and
 * catches. Owned exception pointers preserve identity, names and represented
 * error causes through native throws, catches and promise rejections.
 */
export const ERROR_CONSTRUCTORS: ReadonlySet<string> = new Set([
    "Error",
    "RangeError",
    "TypeError",
    "SyntaxError",
    "ReferenceError",
    "EvalError",
    "URIError",
    "AggregateError",
]);

/** The library Error constructor `expression` calls, when it calls one. */
export function errorConstructor(
    expression: ts.NewExpression,
    isLibrary: (identifier: ts.Identifier) => boolean,
): string | undefined {
    const callee = expression.expression;
    return ts.isIdentifier(callee) &&
        ERROR_CONSTRUCTORS.has(callee.text) &&
        isLibrary(callee)
        ? callee.text
        : undefined;
}

/**
 * A native catch retains the original exception after its handler exits.
 */
export function caughtErrorValue(
    context: Pick<
        LoweringServices,
        | "emit"
        | "allocateTemporaryCppName"
        | "cppString"
        | "reachJsData"
        | "registerNativeConstBinding"
    >,
    exceptionCpp: string,
): Value {
    const pinned = context.allocateTemporaryCppName("caught_error");
    context.reachJsData();
    context.emit(`(void)${exceptionCpp};`);
    context.emit(`const bbl::js::Error ${pinned} = std::current_exception();`);
    context.registerNativeConstBinding(pinned);
    const message: Extract<Value, { kind: "data" }> = {
        kind: "data",
        cpp: `bbl::js::error_message(${pinned})`,
        dataType: { kind: "string" },
    };
    return errorValue(message, "Error", context.cppString, {
        kind: "data",
        cpp: pinned,
        dataType: { kind: "error" },
    });
}

/**
 * An Error as a value: `nativeError` is what `instanceof Error` and
 * `throw` read, and the record properties answer `.message` and `.name`.
 * `base` carries an owned exception or a platform event's borrowed error view.
 */
export function errorValue(
    message: Value,
    name: string,
    cppString: (text: string) => string,
    base: Extract<Value, { kind: "record" | "data" }> = {
        kind: "record",
        cpp: "",
    },
): Value {
    return {
        ...base,
        nativeError: true,
        truthinessCpp: "true",
        recordProperties: {
            ...base.recordProperties,
            message,
            name:
                base.dataType?.kind === "error"
                    ? {
                          kind: "string",
                          cpp: `bbl::js::error_name(${base.cpp})`,
                      }
                    : {
                          kind: "string",
                          cpp: cppString(name),
                          staticString: name,
                      },
            // Native exceptions do not carry a JavaScript engine's optional stack string.
            stack: { kind: "json-null", cpp: "std::nullopt" },
        },
    };
}

/**
 * `new Error(message)` and its subclasses as values. A held value reads
 * its message later, possibly after the locals it interpolates have
 * changed, so a runtime message is evaluated once into a temporary the
 * record's `message` names; a thrown one is consumed at once and keeps
 * the expression.
 */
export function compileErrorConstruction(
    context: Pick<
        LoweringServices,
        | "compileValue"
        | "dataLowerer"
        | "allocateTemporaryCppName"
        | "emit"
        | "cppString"
        | "unwrap"
        | "fail"
        | "reachJsData"
    >,
    expression: ts.NewExpression,
    name: string,
    consumer: "held" | "thrown" = "held",
): Value {
    if (name === "AggregateError")
        return compileAggregateError(context, expression);
    const arguments_ = expression.arguments ?? [];
    const [argument, options] = arguments_;
    if (arguments_.length > 2) {
        context.fail(
            expression,
            `new ${name} takes a message and an optional error cause.`,
        );
    }
    let message: Value;
    if (!argument) {
        message = {
            kind: "string",
            cpp: context.cppString(""),
            staticString: "",
        };
    } else {
        const value = context.compileValue(argument);
        if (value.staticString !== undefined) {
            message = {
                kind: "string",
                cpp: context.cppString(value.staticString),
                staticString: value.staticString,
            };
        } else {
            let cpp = context.dataLowerer.compileKnownValueForSink(
                value,
                { kind: "string" },
                argument,
            );
            if (consumer === "held" || options !== undefined) {
                const temporary =
                    context.allocateTemporaryCppName("error_message");
                context.emit(`const std::string ${temporary} = ${cpp};`);
                cpp = temporary;
            }
            message = { kind: "data", cpp, dataType: { kind: "string" } };
        }
    }
    context.reachJsData();
    const cause = compileErrorCause(context, options);
    let cpp = `bbl::js::make_error(${context.cppString(name)}, ${message.cpp}, ${cause})`;
    if (consumer === "held") {
        const temporary = context.allocateTemporaryCppName("error_value");
        context.emit(`const bbl::js::Error ${temporary} = ${cpp};`);
        cpp = temporary;
    }
    return errorValue(message, name, context.cppString, {
        kind: "data",
        cpp,
        dataType: { kind: "error" },
    });
}

function compileAggregateError(
    context: Parameters<typeof compileErrorConstruction>[0],
    expression: ts.NewExpression,
): Value {
    const args = expression.arguments ?? [];
    if (!args.length || args.length > 3)
        return context.fail(
            expression,
            "AggregateError requires an error iterable, optional message and cause.",
        );
    context.reachJsData();
    const errors = context.dataLowerer.compileForSink(args[0]!, {
        kind: "vector",
        element: { kind: "error" },
    });
    const list = context.allocateTemporaryCppName("aggregate_errors");
    const snapshotsErrors = args.slice(1).some(expressionMayRunCode);
    context.emit(
        snapshotsErrors
            ? `const auto ${list} = bbl::js::snapshot_value(${errors});`
            : `const auto& ${list} = ${errors};`,
    );
    const message = args[1]
        ? context.dataLowerer.compileForSink(args[1], { kind: "string" })
        : context.cppString("");
    const text = context.allocateTemporaryCppName("aggregate_message");
    context.emit(`const std::string ${text} = ${message};`);
    const cause = compileErrorCause(context, args[2]);
    const cpp = context.allocateTemporaryCppName("aggregate_error");
    context.emit(
        `const bbl::js::Error ${cpp} = bbl::js::make_aggregate_error(${list}, ${text}, ${cause});`,
    );
    return errorValue(
        { kind: "string", cpp: text },
        "AggregateError",
        context.cppString,
        { kind: "data", cpp, dataType: { kind: "error" } },
    );
}

function compileErrorCause(
    context: Parameters<typeof compileErrorConstruction>[0],
    expression: ts.Expression | undefined,
): string {
    let cause = "std::exception_ptr{}";
    if (expression) {
        const options = context.unwrap(expression);
        if (!ts.isObjectLiteralExpression(options))
            return context.fail(
                options,
                "Error options require a cause record.",
            );
        for (const property of options.properties) {
            const name =
                (ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property)) &&
                ts.isIdentifier(property.name)
                    ? property.name.text
                    : undefined;
            if (
                name !== "cause" ||
                (!ts.isPropertyAssignment(property) &&
                    !ts.isShorthandPropertyAssignment(property))
            )
                return context.fail(
                    property,
                    "Error options only represent an error cause.",
                );
            const value = ts.isPropertyAssignment(property)
                ? property.initializer
                : property.name;
            const compiled = context.dataLowerer.compileForSink(value, {
                kind: "error",
            });
            cause = context.allocateTemporaryCppName("error_cause");
            context.emit(`const std::exception_ptr ${cause} = ${compiled};`);
        }
    }
    return cause;
}

/** The message a thrown value carries, or undefined when it carries none. */
export function thrownMessage(value: Value): Value | undefined {
    if (value.nativeError) {
        return value.recordProperties?.message;
    }
    if (
        value.staticString !== undefined ||
        value.kind === "string" ||
        (value.kind === "data" && value.dataType?.kind === "string")
    ) {
        return value;
    }
    return undefined;
}
