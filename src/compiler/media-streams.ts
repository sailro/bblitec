import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { domAudioHandleKind, type DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { compileBooleanOptions } from "./option-helpers.js";
import { declaredInDomLibrary, resolvedSymbol } from "./symbols.js";
import { optionalPresentCpp, type Value } from "./types.js";
import { MEDIA_STREAM_TRACK_LISTS } from "./web-audio-members.js";
import {
    webAudioMemberAssign,
    webAudioMemberCall,
} from "../lowering/web-platform-schema.js";

/**
 * MediaStream and MediaStreamTrack objects (`bblite/pal_media_stream.hpp`):
 * construction, track sets, track lifecycle, `canvas.captureStream`, and the
 * MediaRecorder no native encoder backs: `isTypeSupported` is false for
 * every type and construction throws NotSupportedError, so a recorder or a
 * recording event never exists and its members are unreachable.
 */

const STREAM: DataType = { kind: "handle", handle: "media-stream" };
const TRACK: DataType = { kind: "handle", handle: "media-stream-track" };
const TRACKS: DataType = { kind: "vector", element: TRACK };

type Context = DataLowerer["context"];

function reachMediaStreams(
    context: Pick<LoweringServices, "reachFeature" | "reachJsData">,
    node: ts.Node,
): void {
    context.reachFeature("platform:media-stream", node);
    context.reachJsData();
}

export function mediaStreamValue(cpp: string): Value {
    return { kind: "media-stream", cpp, dataType: STREAM, impure: true };
}

function trackValue(cpp: string): Value {
    return { kind: "media-stream-track", cpp, dataType: TRACK, impure: true };
}

/** An operand evaluated into a temporary, in source order. */
function pinned(context: Context, cpp: string, label: string): string {
    const name = context.allocateTemporaryCppName(label);
    context.emit({
        kind: "declaration",
        type: "const auto",
        name,
        initializer: cpp,
    });
    return name;
}

/** `new MediaStream(...)` and `new MediaRecorder(stream, options)`. */
export function compileMediaStreamNew(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    const global = context.libraryGlobal(node.expression);
    if (global !== "MediaStream" && global !== "MediaRecorder")
        return undefined;
    reachMediaStreams(context, node);
    const [first, second, ...extra] = node.arguments ?? [];
    if (global === "MediaStream") {
        if (second)
            return context.fail(second, "MediaStream takes one argument.");
        if (!first) return mediaStreamValue("bbl::pal::create_media_stream()");
        const kind = domAudioHandleKind(
            context.checker.getTypeAtLocation(first),
        );
        const source = lowerer.compileForSink(
            first,
            kind === "media-stream" ? STREAM : TRACKS,
        );
        return mediaStreamValue(`bbl::pal::create_media_stream(${source})`);
    }
    if (!first || extra.length)
        return context.fail(
            node,
            "MediaRecorder takes a stream and an optional options record.",
        );
    const stream = pinned(
        context,
        lowerer.compileForSink(first, STREAM),
        "recorder_stream",
    );
    let mimeType = "std::string()";
    if (second)
        compileBooleanOptions(context, lowerer, second, [], {
            subject: "MediaRecorder options",
            member: "MediaRecorder option",
            forms: "a represented options record",
            temporary: "recorder_option",
            consume: {
                mimeType: (value, present) => {
                    const type = {
                        kind: "optional",
                        inner: { kind: "string" },
                    } as const;
                    const converted = lowerer.compileKnownValueForSink(
                        value,
                        type,
                        second,
                    );
                    const cppType = context.dataTypes.cppType(type);
                    const held =
                        context.allocateTemporaryCppName("recorder_mime_type");
                    context.emit({
                        kind: "declaration",
                        type: `const ${cppType}`,
                        name: held,
                        initializer: present
                            ? `${present} ? ${cppType}{${converted}} : ${cppType}{}`
                            : converted,
                    });
                    mimeType = `(${optionalPresentCpp(held)} ? std::string(*${held}) : std::string())`;
                },
            },
        });
    const recorder: DataType = {
        kind: "uninhabited-object",
        name: "MediaRecorder",
    };
    return {
        ...lowerer.leafValue(
            `(static_cast<void>(${stream}), bbl::pal::media_recorder_unsupported<${context.dataTypes.cppType(recorder)}>(${mimeType}))`,
            recorder,
        ),
        impure: true,
    };
}

/** The DOM method a call names on a MediaStream or MediaStreamTrack receiver. */
function mediaReceiverKind(
    context: Pick<LoweringServices, "checker">,
    receiver: ts.Expression,
): "media-stream" | "media-stream-track" | undefined {
    const kind = domAudioHandleKind(
        context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(receiver),
        ),
    );
    return kind === "media-stream" || kind === "media-stream-track"
        ? kind
        : undefined;
}

const TRACK_LISTS: ReadonlySet<string> = new Set(
    MEDIA_STREAM_TRACK_LISTS.map(([name]) => name),
);

function streamMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    receiver: string,
    method: string,
): Value | undefined {
    const context = lowerer.context;
    if (TRACK_LISTS.has(method)) {
        context.expectArgumentCount(call, 0, 0);
        return {
            ...lowerer.leafValue(
                webAudioMemberCall("MediaStream", method)(receiver, []),
                TRACKS,
            ),
            freshData: true,
            impure: true,
        };
    }
    if (method === "addTrack" || method === "removeTrack") {
        context.expectArgumentCount(call, 1, 1);
        const track = lowerer.compileForSink(call.arguments[0]!, TRACK);
        return {
            kind: "void",
            cpp: webAudioMemberCall("MediaStream", method)(receiver, [track]),
        };
    }
    if (method === "getTrackById") {
        context.expectArgumentCount(call, 1, 1);
        const id = lowerer.compileForSink(call.arguments[0]!, {
            kind: "string",
        });
        return {
            ...lowerer.leafValue(
                webAudioMemberCall("MediaStream", method)(receiver, [id]),
                { kind: "optional", inner: TRACK },
            ),
            impure: true,
        };
    }
    if (method === "clone") {
        context.expectArgumentCount(call, 0, 0);
        return mediaStreamValue(
            webAudioMemberCall("MediaStream", method)(receiver, []),
        );
    }
    return undefined;
}

function trackMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    receiver: string,
    method: string,
): Value | undefined {
    const context = lowerer.context;
    if (method === "stop") {
        context.expectArgumentCount(call, 0, 0);
        return {
            kind: "void",
            cpp: webAudioMemberCall("MediaStreamTrack", method)(receiver, []),
        };
    }
    if (method === "clone") {
        context.expectArgumentCount(call, 0, 0);
        return trackValue(
            webAudioMemberCall("MediaStreamTrack", method)(receiver, []),
        );
    }
    return undefined;
}

/** Methods of MediaStream and MediaStreamTrack values, optional receivers included. */
export function compileMediaStreamMethodCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
): Value | undefined {
    const context = lowerer.context;
    const kind = mediaReceiverKind(context, callee.expression);
    if (!kind) return undefined;
    const method = callee.name.text;
    const lower = kind === "media-stream" ? streamMethod : trackMethod;
    reachMediaStreams(context, call);
    const owner = context.compileValue(callee.expression);
    const run = (present: Value): Value | undefined => {
        const receiver = pinned(context, present.cpp, "media_receiver");
        return lower(lowerer, call, receiver, method);
    };
    // `a?.b.stream.getTracks()` continues the chain `?.` started.
    const result =
        callee.questionDotToken ||
        (ts.isOptionalChain(callee) && owner.dataType?.kind === "optional")
            ? lowerer.optionalAccess(owner, call, run)
            : run(lowerer.narrowOptional(owner, callee.expression));
    return (
        result ??
        context.fail(
            callee.name,
            `${kind === "media-stream" ? "MediaStream" : "MediaStreamTrack"}.${method} is not lowered natively.`,
        )
    );
}

/** `track.enabled = value`. */
export function emitMediaStreamAssignment(
    lowerer: DataLowerer,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
): boolean {
    const context = lowerer.context;
    if (mediaReceiverKind(context, left.expression) !== "media-stream-track")
        return false;
    if (
        left.name.text !== "enabled" ||
        expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
        return context.fail(
            expression,
            "Only `track.enabled = value` writes a MediaStreamTrack natively.",
        );
    reachMediaStreams(context, expression);
    const track = pinned(
        context,
        lowerer.compileForSink(left.expression, TRACK),
        "media_track",
    );
    context.emit({
        kind: "expression",
        code: `${webAudioMemberAssign("MediaStreamTrack", "enabled")(track, lowerer.compileForSink(expression.right, { kind: "boolean" }))};`,
    });
    return true;
}

/** `MediaRecorder.isTypeSupported(type)`: false for every type, its argument converted. */
export function compileMediaRecorderStaticCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "isTypeSupported" ||
        context.libraryGlobal(callee.expression) !== "MediaRecorder"
    )
        return undefined;
    context.expectArgumentCount(call, 1, 1);
    reachMediaStreams(context, call);
    const type = lowerer.compileForSink(call.arguments[0]!, { kind: "string" });
    return {
        kind: "boolean",
        cpp: `bbl::pal::media_recorder_type_supported(${type})`,
        impure: true,
    };
}

/** `typeof canvas.captureStream`: a canvas always has it; the receiver is evaluated. */
export function mediaStreamTypeof(
    context: Pick<
        LoweringServices,
        "checker" | "unwrap" | "compileValue" | "emitDiscardedValue"
    >,
    expression: ts.Expression,
): "function" | undefined {
    const property = context.unwrap(expression);
    if (
        !ts.isPropertyAccessExpression(property) ||
        property.name.text !== "captureStream"
    )
        return undefined;
    const symbol = resolvedSymbol(context.checker, property);
    if (
        !symbol ||
        !declaredInDomLibrary(symbol) ||
        !(symbol.declarations ?? []).some(
            (declaration) =>
                ts.isInterfaceDeclaration(declaration.parent) &&
                declaration.parent.name.text === "HTMLCanvasElement",
        )
    )
        return undefined;
    context.emitDiscardedValue(context.compileValue(property.expression));
    return "function";
}

/** `canvas.captureStream(frameRate)` on a retained canvas element. */
export function compileCanvasCaptureStream(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    element: Value,
): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "captureStream"
    )
        return undefined;
    const symbol = resolvedSymbol(context.checker, callee);
    if (!symbol || !declaredInDomLibrary(symbol)) return undefined;
    context.expectArgumentCount(call, 0, 1);
    reachMediaStreams(context, call);
    const canvas = pinned(context, element.cpp, "captured_canvas");
    const rate = call.arguments[0]
        ? lowerer.compileForSink(call.arguments[0], {
              kind: "optional",
              inner: { kind: "number" },
          })
        : "bbl::js::Nullable<double>{}";
    return mediaStreamValue(
        `(static_cast<void>(${canvas}), bbl::pal::canvas_capture_stream(${rate}))`,
    );
}

/**
 * A member of a never-constructed recorder or recording event: the receiver
 * is evaluated, and what follows is unreachable by construction.
 */
function uninhabitedMember(
    lowerer: DataLowerer,
    owner: Value,
    member: string,
    result: DataType | undefined,
    node: ts.Node,
): Value {
    const context = lowerer.context;
    const type = owner.dataType;
    const name = type?.kind === "uninhabited-object" ? type.name : "object";
    reachMediaStreams(context, node);
    const receiver = pinned(context, owner.cpp, "uninhabited_receiver");
    const label = context.cppString(`${name}.${member}`);
    if (!result)
        return {
            kind: "void",
            cpp: `(static_cast<void>(${receiver}), bbl::pal::uninhabited_member<void>(${label}))`,
        };
    return {
        ...lowerer.leafValue(
            `(static_cast<void>(${receiver}), bbl::pal::uninhabited_member<${context.dataTypes.cppType(result)}>(${label}))`,
            result,
        ),
        impure: true,
    };
}

/** A property of a MediaRecorder or BlobEvent, which no native value holds. */
export function uninhabitedProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
    access: ts.Node | undefined,
): Value | undefined {
    if (owner.dataType?.kind !== "uninhabited-object") return undefined;
    const context = lowerer.context;
    const result =
        access && ts.isExpression(access)
            ? context.dataTypes.fromTsType(
                  context.checker.getTypeAtLocation(access),
                  access,
              )
            : undefined;
    if (!result)
        return context.fail(
            access ?? context.sourceFile,
            `${owner.dataType.name}.${property} has no owned native representation.`,
        );
    return uninhabitedMember(lowerer, owner, property, result, access!);
}

/** A method of a MediaRecorder or BlobEvent: its arguments are never evaluated. */
export function compileUninhabitedMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    const context = lowerer.context;
    const returned = context.checker.getTypeAtLocation(call);
    const result =
        (returned.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
            ? undefined
            : context.dataTypes.fromTsType(returned, call);
    if (
        result === undefined &&
        (returned.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) === 0
    )
        return context.fail(
            call,
            `${method} has no owned native representation of its result.`,
        );
    return uninhabitedMember(lowerer, owner, method, result, call);
}
