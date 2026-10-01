import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { isTypedArrayType } from "./data-types.js";
import type { Value } from "./types.js";

/** The Encoding Standard's labels of UTF-8, the one encoding lowered. */
const UTF8_LABELS: ReadonlySet<string> = new Set([
    "unicode-1-1-utf-8",
    "unicode11utf8",
    "unicode20utf8",
    "utf-8",
    "utf8",
    "x-unicode20utf8",
]);

/**
 * `new TextDecoder(label?, { fatal, ignoreBOM })` and `new TextEncoder()`.
 * A decoder carries its two flags; the label must name UTF-8 at
 * generation, as an encoding label selects the decoder's algorithm.
 */
export function compileTextCodecNew(
    lowerer: DataLowerer,
    expression: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    const name = context.libraryGlobal(expression.expression);
    if (name !== "TextDecoder" && name !== "TextEncoder") return undefined;
    const arguments_ = expression.arguments ?? [];
    context.reachJsData();
    if (name === "TextEncoder") {
        if (arguments_.length !== 0)
            context.fail(expression, "new TextEncoder takes no arguments.");
        return {
            kind: "data",
            cpp: "bbl::js::make_text_encoder()",
            dataType: { kind: "text-encoder" },
            impure: true,
        };
    }
    if (arguments_.length > 2)
        context.fail(
            expression,
            "new TextDecoder takes a label and an options object.",
        );
    const label = arguments_[0];
    if (label) {
        const text = context.compileValue(label).staticString;
        const normalized = text
            ?.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
            .toLowerCase();
        if (normalized === undefined || !UTF8_LABELS.has(normalized))
            context.fail(
                label,
                "TextDecoder lowers the UTF-8 encoding; its label must name UTF-8 at generation.",
            );
    }
    const flags = { fatal: "false", ignoreBOM: "false" };
    const options = arguments_[1] && context.unwrap(arguments_[1]);
    if (options) {
        if (!ts.isObjectLiteralExpression(options))
            return context.fail(
                options,
                "TextDecoder options must be an object literal.",
            );
        for (const property of options.properties) {
            const key =
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name))
                    ? property.name.text
                    : undefined;
            if (
                !ts.isPropertyAssignment(property) ||
                (key !== "fatal" && key !== "ignoreBOM")
            )
                return context.fail(
                    property,
                    "TextDecoder options take the fatal and ignoreBOM properties.",
                );
            // A dictionary boolean member is ToBoolean of its value.
            flags[key] = context.conditions.compileCondition(
                property.initializer,
            );
        }
    }
    return {
        kind: "data",
        cpp: `bbl::js::make_text_decoder(${flags.fatal}, ${flags.ignoreBOM})`,
        dataType: { kind: "text-decoder" },
        impure: true,
    };
}

/**
 * `decoder.decode(bytes?)` over an ArrayBuffer or any view, and
 * `encoder.encode(text?)`. Streaming decodes and `encodeInto` refuse.
 */
export function compileTextCodecMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    const decoder = owner.dataType?.kind === "text-decoder";
    if (method !== (decoder ? "decode" : "encode"))
        context.fail(
            call,
            `${decoder ? "TextDecoder" : "TextEncoder"}.${method} is not lowered.`,
        );
    context.expectArgumentCount(call, 0, 1);
    context.reachJsData();
    const receiver = context.bindings.pinValueToTemporary(
        owner,
        "codec_receiver",
    );
    const argument = call.arguments[0];
    if (!decoder) {
        const text = argument
            ? lowerer.compileKnownValueForSink(
                  context.compileValue(argument),
                  { kind: "string" },
                  argument,
              )
            : "std::string{}";
        return {
            kind: "data",
            cpp: `bbl::js::text_encode(${receiver.cpp}, ${text})`,
            dataType: { kind: "u8array" },
        };
    }
    if (!argument)
        return lowerer.leafValue(`std::string{}`, { kind: "string" });
    const source = context.compileValue(argument);
    const kind = source.dataType?.kind;
    if (
        source.kind !== "data" ||
        !(
            kind === "arraybuffer" ||
            kind === "dataview" ||
            kind === "bufferview" ||
            isTypedArrayType(source.dataType)
        )
    )
        context.fail(
            argument,
            "TextDecoder.decode reads an ArrayBuffer or an ArrayBuffer view.",
        );
    return lowerer.leafValue(
        `bbl::js::text_decode(${receiver.cpp}, ${source.cpp})`,
        { kind: "string" },
    );
}
