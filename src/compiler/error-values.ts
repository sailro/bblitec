import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

/**
 * The default-library Error constructors a scene throws, holds and
 * catches. Every one of them is `Error` with a different `name`: the
 * native exception carries the message alone, so a caught value answers
 * `instanceof Error` and reads its message, while the constructor that
 * made it is the value's own static `name`.
 */
export const ERROR_CONSTRUCTORS: ReadonlySet<string> = new Set([
    "Error",
    "RangeError",
    "TypeError",
    "SyntaxError",
    "ReferenceError",
    "EvalError",
    "URIError",
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
 * An Error as a value: `nativeError` is what `instanceof Error` and
 * `throw` read, and the record properties answer `.message` and `.name`.
 * `base` carries the representation the value already has (a caught
 * exception is its message string); a constructed Error has none.
 */
export function errorValue(
    message: Value,
    name: string,
    cppString: (text: string) => string,
    base: Extract<Value, { kind: "record" | "data" }> = { kind: "record", cpp: "" },
): Value {
    return {
        ...base,
        nativeError: true,
        truthinessCpp: "true",
        recordProperties: {
            ...base.recordProperties,
            message,
            name: { kind: "string", cpp: cppString(name), staticString: name },
        },
    };
}

/**
 * `new Error(message)` and its subclasses as values a scene holds before
 * throwing or reads the message of. A runtime message is evaluated once,
 * into a temporary the record's `message` names.
 */
export function compileErrorConstruction(
    context: Pick<
        LoweringServices,
        | "compileValue"
        | "dataLowerer"
        | "allocateTemporaryCppName"
        | "emit"
        | "cppString"
        | "fail"
    >,
    expression: ts.NewExpression,
    name: string,
): Value {
    const arguments_ = expression.arguments ?? [];
    if (arguments_.length > 1) {
        context.fail(
            expression,
            `new ${name} takes a message; error options are not represented.`,
        );
    }
    const argument = arguments_[0];
    let message: Value;
    if (!argument) {
        message = { kind: "string", cpp: context.cppString(""), staticString: "" };
    } else {
        const value = context.compileValue(argument);
        if (value.staticString !== undefined) {
            message = {
                kind: "string",
                cpp: context.cppString(value.staticString),
                staticString: value.staticString,
            };
        } else {
            const cpp = context.dataLowerer.compileKnownValueForSink(
                value,
                { kind: "string" },
                argument,
            );
            const temporary = context.allocateTemporaryCppName("error_message");
            context.emit(`const std::string ${temporary} = ${cpp};`);
            message = { kind: "data", cpp: temporary, dataType: { kind: "string" } };
        }
    }
    return errorValue(message, name, context.cppString);
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
