import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import type { Value } from "./types.js";

/**
 * A response's Headers and byte ReadableStreams (`bblite/pal_fetch_response.hpp`):
 * `headers.get/has`, a body or `blob.stream()`, a program's own source
 * (`new ReadableStream({ pull, cancel })` and its controller's
 * `enqueue/close/error`), `getReader()`, `cancel()`, `locked`, `pipeThrough`
 * a CompressionStream or DecompressionStream (`bblite/pal_compression.hpp`),
 * `new Response(stream, init)`, the reader's `read/cancel/releaseLock()` and
 * the read result's `done`/`value`.
 */

const BYTE_STREAM: DataType = { kind: "byte-stream" };

/** A cancel reason as a program source's cancel algorithm receives it. */
const CANCEL_REASON: DataType = {
    kind: "optional",
    inner: { kind: "error" },
};

/** A program source's algorithms, as the native stream calls them. */
const SOURCE_ALGORITHMS: Readonly<Record<"pull" | "cancel", DataType>> = {
    pull: {
        kind: "function",
        parameters: [{ kind: "byte-stream-controller" }],
        result: { kind: "promise" },
    },
    cancel: {
        kind: "function",
        parameters: [CANCEL_REASON],
        result: { kind: "promise" },
    },
};

/** Storage `pal_fetch_response.hpp` declares; reached even when nothing stores it. */
function responseStorage(lowerer: DataLowerer, type: DataType): DataType {
    lowerer.context.dataTypes.cppType(type);
    return type;
}

/** `stream.locked`, a transform's `readable`, and a read result's `done` and `value`. */
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
    if (kind === "byte-transform-stream") {
        if (property === "readable")
            return lowerer.leafValue(`(${owner.cpp}).readable()`, BYTE_STREAM);
        if (property === "writable")
            return lowerer.context.fail(
                access ?? lowerer.context.sourceFile,
                "A compression transform's writable side is not lowered; pipe a byte stream through the transform.",
            );
        return undefined;
    }
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

/**
 * `new CompressionStream(format)`, `new DecompressionStream(format)` (an
 * unknown format throws TypeError at run time) and `new Response(stream)`
 * over a byte stream.
 */
export function compileBodyStreamNew(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    const name = context.libraryGlobal(node.expression);
    if (
        name !== "CompressionStream" &&
        name !== "DecompressionStream" &&
        name !== "Response" &&
        name !== "ReadableStream"
    )
        return undefined;
    const arguments_ = node.arguments ?? [];
    if (name === "ReadableStream") return pullStream(lowerer, node);
    if (name === "Response") {
        if (arguments_.length < 1 || arguments_.length > 2)
            return context.fail(
                node,
                "new Response lowers one byte ReadableStream body and its init.",
            );
        const body = context.compileValue(arguments_[0]!);
        // The body's declared chunk type must be bytes too, not only its value.
        if (
            body.dataType?.kind !== "byte-stream" ||
            context.dataTypes.fromTsType(
                context.checker.getTypeAtLocation(arguments_[0]!),
                arguments_[0]!,
            )?.kind !== "byte-stream"
        )
            return context.fail(
                arguments_[0]!,
                "new Response lowers a byte ReadableStream body; other bodies are not lowered.",
            );
        // Its body is read on the realm's microtask queue.
        if (!context.options.workers) throw new ApplicationRealmRequired();
        const init = arguments_[1] && responseInit(lowerer, arguments_[1]);
        return {
            ...lowerer.leafValue(
                `bbl::pal::make_stream_response(${body.cpp}${init ? `, ${init}` : ""})`,
                responseStorage(lowerer, { kind: "http-response" }),
            ),
            impure: true,
        };
    }
    if (arguments_.length !== 1)
        return context.fail(node, `new ${name} takes one format.`);
    // Its readable side is read on the realm's microtask queue.
    context.reachFeature("platform:compression", node);
    const format = lowerer.compileForSink(arguments_[0]!, { kind: "string" });
    return {
        ...lowerer.leafValue(
            `bbl::pal::${name === "CompressionStream" ? "compression" : "decompression"}_stream(${format})`,
            responseStorage(lowerer, { kind: "byte-transform-stream" }),
        ),
        impure: true,
    };
}

/** The `ResponseInit` members a Response lowers, in `HttpResponseInit`'s field order. */
const RESPONSE_INIT_FIELDS: readonly (readonly [string, string, DataType])[] = [
    ["status", "status", { kind: "number" }],
    ["statusText", "status_text", { kind: "string" }],
    ["headers", "headers", { kind: "http-headers" }],
];

/**
 * `new Response(body, { status, statusText, headers })`: a closed record
 * of those members (`pal::HttpResponseInit`).
 */
function responseInit(lowerer: DataLowerer, node: ts.Expression): string {
    const context = lowerer.context;
    const init = context.compileValue(node);
    if (
        init.kind !== "record" ||
        Object.keys(init.recordGetters ?? {}).length ||
        Object.keys(init.recordMethods ?? {}).length
    )
        return context.fail(
            node,
            "A Response init is lowered from a record of status, statusText and headers.",
        );
    const properties = init.recordProperties ?? {};
    for (const name of Object.keys(properties))
        if (!RESPONSE_INIT_FIELDS.some(([member]) => member === name))
            return context.fail(
                node,
                `Response init member '${name}' is not lowered.`,
            );
    const fields = RESPONSE_INIT_FIELDS.flatMap(([member, field, sink]) => {
        const value = properties[member];
        return value
            ? [
                  `.${field} = ${lowerer.compileKnownValueForSink(value, sink, node)}`,
              ]
            : [];
    });
    return `bbl::pal::HttpResponseInit{${fields.join(", ")}}`;
}

/**
 * `new ReadableStream({ pull, cancel })` over byte chunks: a program's own
 * underlying source, its algorithms the record's methods (a start
 * algorithm, a strategy or a byte source type is not lowered).
 */
function pullStream(lowerer: DataLowerer, node: ts.NewExpression): Value {
    const context = lowerer.context;
    if (!context.options.workers) throw new ApplicationRealmRequired();
    const arguments_ = node.arguments ?? [];
    const sourceNode = arguments_[0];
    if (arguments_.length !== 1 || !sourceNode)
        return context.fail(
            node,
            "new ReadableStream lowers one underlying source without a strategy.",
        );
    if (
        context.dataTypes.fromTsType(
            context.checker.getTypeAtLocation(node),
            node,
        )?.kind !== "byte-stream"
    )
        return context.fail(
            node,
            "new ReadableStream lowers a stream of Uint8Array chunks.",
        );
    const source = context.compileValue(sourceNode);
    const methods = source.kind === "record" ? source.recordMethods ?? {} : {};
    if (
        source.kind !== "record" ||
        Object.keys(source.recordProperties ?? {}).length ||
        Object.keys(source.recordGetters ?? {}).length ||
        Object.keys(methods).some((name) => name !== "pull" && name !== "cancel")
    )
        return context.fail(
            sourceNode,
            "An underlying source is lowered from a record of pull and cancel methods.",
        );
    const algorithm = (name: "pull" | "cancel"): string => {
        const method = methods[name];
        return method
            ? lowerer.compileKnownValueForSink(
                  {
                      kind: "callback",
                      cpp: "",
                      callbackDeclaration: method,
                      callbackRecordOwner: source,
                  },
                  SOURCE_ALGORITHMS[name],
                  sourceNode,
              )
            : "{}";
    };
    return {
        ...lowerer.leafValue(
            `bbl::pal::make_pull_stream(${algorithm("pull")}, ${algorithm("cancel")})`,
            responseStorage(lowerer, BYTE_STREAM),
        ),
        impure: true,
    };
}

/** `blob.stream()`: the Blob's bytes as one chunk. */
export function compileBlobStream(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
): Value {
    const context = lowerer.context;
    if (!context.options.workers) throw new ApplicationRealmRequired();
    context.expectArgumentCount(call, 0, 0);
    return {
        ...lowerer.leafValue(
            `bbl::pal::whole_body_stream((${owner.cpp}).bytes())`,
            responseStorage(lowerer, BYTE_STREAM),
        ),
        impure: true,
    };
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
        // A program's source receives the reason; a fetched body has none.
        return lowerer.leafValue(
            `(${receiver.cpp}).cancel(${reason ? lowerer.compileForSink(reason, CANCEL_REASON) : ""})`,
            { kind: "promise" },
        );
    };
    if (kind === "byte-stream-controller") {
        if (method === "close") {
            context.expectArgumentCount(call, 0, 0);
            return { kind: "void", cpp: `(${receiver.cpp}).close()` };
        }
        context.expectArgumentCount(call, 1, 1);
        if (method === "enqueue")
            return {
                kind: "void",
                cpp: `(${receiver.cpp}).enqueue(${lowerer.compileForSink(call.arguments[0]!, { kind: "u8array" })})`,
            };
        if (method === "error")
            return {
                kind: "void",
                cpp: `(${receiver.cpp}).error(${lowerer.compileForSink(call.arguments[0]!, { kind: "error" })})`,
            };
        return context.fail(
            call,
            `ReadableStreamDefaultController.${method} is not lowered.`,
        );
    }
    if (kind === "byte-stream") {
        if (method === "cancel") return cancel();
        if (method === "pipeThrough")
            return pipeThrough(lowerer, call, receiver);
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

/** `stream.pipeThrough(transform)`: a CompressionStream or DecompressionStream, without options. */
function pipeThrough(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    receiver: Value,
): Value {
    const context = lowerer.context;
    context.expectArgumentCount(call, 1, 2);
    if (call.arguments[1])
        return context.fail(
            call.arguments[1],
            "ReadableStream.pipeThrough options are not lowered.",
        );
    const transform = context.compileValue(call.arguments[0]!);
    if (transform.dataType?.kind !== "byte-transform-stream")
        return context.fail(
            call.arguments[0]!,
            "ReadableStream.pipeThrough lowers a CompressionStream or DecompressionStream transform.",
        );
    return {
        ...lowerer.leafValue(
            `(${receiver.cpp}).pipe_through(${transform.cpp})`,
            BYTE_STREAM,
        ),
        impure: true,
    };
}
