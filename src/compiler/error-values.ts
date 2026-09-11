import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
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
            // Native exceptions do not carry a JavaScript engine's optional stack string.
            stack: { kind: "json-null", cpp: "std::nullopt" },
        },
    };
}

/**
 * `{ cause }` beside the message. JavaScript keeps the cause on the error
 * while the native exception carries the message alone, so the option is
 * accepted when dropping it skips nothing a scene could observe: a cause
 * that is not a call.
 */
function isDroppedCause(options: ts.Expression): boolean {
    return (
        ts.isObjectLiteralExpression(options) &&
        options.properties.every(
            (property) =>
                (ts.isShorthandPropertyAssignment(property) && property.name.text === "cause") ||
                (ts.isPropertyAssignment(property) &&
                    ts.isIdentifier(property.name) &&
                    property.name.text === "cause" &&
                    !someAnalysisNode(
                        property.initializer,
                        (node) => ts.isCallExpression(node) || ts.isNewExpression(node),
                    )),
        )
    );
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
    >,
    expression: ts.NewExpression,
    name: string,
    consumer: "held" | "thrown" = "held",
): Value {
    const arguments_ = expression.arguments ?? [];
    const [argument, options] = arguments_;
    if (arguments_.length > 2 || (options !== undefined && !isDroppedCause(context.unwrap(options)))) {
        context.fail(
            expression,
            `new ${name} takes a message and a { cause } option; the native exception carries the message alone.`,
        );
    }
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
            let cpp = context.dataLowerer.compileKnownValueForSink(
                value,
                { kind: "string" },
                argument,
            );
            if (consumer === "held") {
                const temporary = context.allocateTemporaryCppName("error_message");
                context.emit(`const std::string ${temporary} = ${cpp};`);
                cpp = temporary;
            }
            message = { kind: "data", cpp, dataType: { kind: "string" } };
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
