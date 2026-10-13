import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { isBinaryDataType } from "./data-types.js";
import { compileBooleanOptions } from "./option-helpers.js";
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

/** Whether an encoding label names UTF-8, after ASCII whitespace is trimmed. */
export function isUtf8Label(label: string): boolean {
    return UTF8_LABELS.has(
        label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase(),
    );
}

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
    const flags = {
        fatal: "false",
        ignoreBOM: "false",
        ...compileBooleanOptions(
            context,
            lowerer,
            arguments_[1],
            ["fatal", "ignoreBOM"] as const,
            {
                subject: "TextDecoder options",
                member: "TextDecoder option",
                forms: "a represented options record",
                temporary: "decoder_flag",
            },
        ),
    };
    return {
        kind: "data",
        cpp: `bbl::js::make_text_decoder(${flags.fatal}, ${flags.ignoreBOM})`,
        dataType: { kind: "text-decoder" },
        impure: true,
    };
}

/**
 * `decoder.decode(bytes?, { stream })` over an ArrayBuffer or any view, and
 * `encoder.encode(text?)`. A streaming decode keeps an incomplete sequence
 * for the next call; `encodeInto` refuses.
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
    context.expectArgumentCount(call, 0, decoder ? 2 : 1);
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
    // `decode()` ends a stream, flushing its incomplete sequence.
    if (!argument)
        return {
            ...lowerer.leafValue(`bbl::js::text_decode(${receiver.cpp})`, {
                kind: "string",
            }),
            impure: true,
        };
    const source = context.compileValue(argument);
    const type = source.dataType;
    if (
        source.kind !== "data" ||
        !(
            isBinaryDataType(type) ||
            (type?.kind === "union" && type.members.every(isBinaryDataType))
        )
    )
        context.fail(
            argument,
            "TextDecoder.decode reads an ArrayBuffer or an ArrayBuffer view.",
        );
    const held = context.bindings.pinValueToTemporary(source, "decoded_bytes");
    const { stream } = compileBooleanOptions(
        context,
        lowerer,
        call.arguments[1],
        ["stream"] as const,
        {
            subject: "TextDecoder.decode options",
            member: "decode option",
            forms: "a represented options record",
            temporary: "decode_stream",
        },
    );
    return {
        ...lowerer.leafValue(
            `bbl::js::text_decode(${receiver.cpp}, ${held.cpp}${stream ? `, ${stream}` : ""})`,
            { kind: "string" },
        ),
        impure: true,
    };
}
