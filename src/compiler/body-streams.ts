import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import type { Value } from "./types.js";

/**
 * A response's Headers and its body as a byte ReadableStream
 * (`bblite/pal_fetch_response.hpp`): `headers.get/has`, `body.getReader()`,
 * `body.cancel()`, `body.locked`, `reader.read/cancel/releaseLock()` and
 * the read result's `done`/`value`.
 */

/** `stream.locked` and a read result's `done` and `value`. */
export function bodyStreamProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
    access: ts.Node | undefined,
): Value | undefined {
    const kind = owner.dataType?.kind;
    if (kind === "byte-stream" && property === "locked")
        return lowerer.leafValue(`(${owner.cpp}).locked()`, {
            kind: "boolean",
        });
    if (kind === "byte-stream-reader" && property === "closed")
        return lowerer.context.fail(
            access ?? lowerer.context.sourceFile,
            "ReadableStreamDefaultReader.closed is not lowered.",
        );
    if (kind !== "byte-read-result") return undefined;
    if (property === "done")
        return lowerer.leafValue(`(${owner.cpp}).done`, { kind: "boolean" });
    if (property !== "value") return undefined;
    // Narrowed past `done` the value is the chunk; otherwise it may be undefined.
    const type =
        access && ts.isExpression(access)
            ? lowerer.dataTypeAt(access)
            : undefined;
    if (type?.kind === "u8array")
        return lowerer.leafValue(`(${owner.cpp}).value`, type);
    const held = lowerer.context.bindings.pinValueToTemporary(
        owner,
        "read_result",
    );
    return lowerer.leafValue(
        `((${held.cpp}).done ? bbl::js::Nullable<bbl::js::U8Array>() : bbl::js::Nullable<bbl::js::U8Array>((${held.cpp}).value))`,
        { kind: "optional", undefinedOnly: true, inner: { kind: "u8array" } },
    );
}

/** Methods of Headers, a byte stream and its reader. */
export function compileBodyStreamMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    const kind = owner.dataType?.kind;
    const receiver = context.bindings.pinValueToTemporary(
        owner,
        "stream_receiver",
    );
    if (kind === "http-headers") {
        if (method !== "get" && method !== "has")
            return context.fail(call, `Headers.${method} is not lowered.`);
        context.expectArgumentCount(call, 1, 1);
        const name = lowerer.compileForSink(call.arguments[0]!, {
            kind: "string",
        });
        return lowerer.leafValue(
            `(${receiver.cpp}).${method}(${name})`,
            method === "has"
                ? { kind: "boolean" }
                : { kind: "optional", inner: { kind: "string" } },
        );
    }
    // Stream operations settle on the realm's task and microtask queues.
    if (!context.options.workers) throw new ApplicationRealmRequired();
    const cancel = (): Value => {
        context.expectArgumentCount(call, 0, 1);
        const reason = call.arguments[0];
        if (reason) {
            // The reason is evaluated; a byte stream from fetch has no source to receive it.
            context.emitDiscardedValue(context.compileValue(reason));
        }
        return lowerer.leafValue(`(${receiver.cpp}).cancel()`, {
            kind: "promise",
        });
    };
    if (kind === "byte-stream") {
        if (method === "cancel") return cancel();
        if (method !== "getReader")
            return context.fail(
                call,
                `ReadableStream.${method} is not lowered.`,
            );
        context.expectArgumentCount(call, 0, 1);
        if (call.arguments[0])
            return context.fail(
                call.arguments[0],
                "ReadableStream.getReader lowers the default reader; reader options are not lowered.",
            );
        return {
            ...lowerer.leafValue(`(${receiver.cpp}).get_reader()`, {
                kind: "byte-stream-reader",
            }),
            impure: true,
        };
    }
    if (method === "cancel") return cancel();
    if (method === "read") {
        context.expectArgumentCount(call, 0, 0);
        return lowerer.leafValue(`(${receiver.cpp}).read()`, {
            kind: "promise",
            result: { kind: "byte-read-result" },
        });
    }
    if (method === "releaseLock") {
        context.expectArgumentCount(call, 0, 0);
        return { kind: "void", cpp: `(${receiver.cpp}).release_lock()` };
    }
    return context.fail(
        call,
        `ReadableStreamDefaultReader.${method} is not lowered.`,
    );
}
