// Web Audio method calls and writes use native context, node and buffer handles.
import { EmissionSet } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { AUDIO_CODECS, audioCodecForBytes } from "../audio-codecs.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import ts from "typescript";
import { argumentAt } from "./syntax.js";

import { readProperty, type PropertyContext } from "./properties.js";
import type { Feature, Value } from "./types.js";
import { domAudioHandleKind } from "./data-types.js";
import { listenerOptions } from "./dom-listeners.js";

/**
 * What resolving a receiver needs, and nothing more. `PropertyContext`
 * satisfies it, which is what lets a receiver walk run through the same
 * rule table a direct read takes.
 */
interface AudioReceiverContext
    extends PropertyContext,
    Pick<LoweringServices,
        | "lookupOptional"
        | "resolveThisField"
        | "compileValue"
        | "unwrap"
        | "checker"
        | "isDefaultLibraryIdentifier"
        | "emit"
    > {}

/** What a property write needs. `AssignmentContext` satisfies it. */
interface AudioWriteContext
    extends AudioReceiverContext,
    Pick<LoweringServices,
        | "compileNumber"
        | "compileBoolean"
        | "reachFeature"
        | "emit"
    > {}

/** What a method call needs. The expression compiler satisfies it. */
interface AudioCallContext
    extends AudioWriteContext,
    Pick<LoweringServices,
        | "checker"
        | "expectKind"
        | "expectArgumentCount"
        | "allocateTemporaryCppName"
        | "cppString"
        | "registerAsset"
        | "dataLowerer"
        | "options"
        | "compileCondition"
        | "compileStringLiteral"
        | "dataTypes"
        | "hoistForwardCallbackBindings"
        | "compilePlatformCallback"
        | "platformEventCallbackIdentity"
        | "pinValueToTemporary"
    > {}

const AUDIO_KINDS = new EmissionSet<string>([
    "audio-engine",
    "audio-buffer",
    "audio-context",
    "audio-node",
    "audio-param",
]);

/** `oscillator.type`, as the Web Audio strings spell it. */
const OSCILLATOR_WAVES: Readonly<Record<string, string>> = {
    sine: "Sine",
    square: "Square",
    sawtooth: "Sawtooth",
    triangle: "Triangle",
};

/** `filter.type`. */
const FILTER_KINDS: Readonly<Record<string, string>> = {
    lowpass: "Lowpass",
    highpass: "Highpass",
    bandpass: "Bandpass",
    lowshelf: "Lowshelf",
    highshelf: "Highshelf",
    peaking: "Peaking",
    notch: "Notch",
    allpass: "Allpass",
};

/** `ctx.create*()`, mapped to the PAL factory each names. */
const NODE_FACTORIES: Readonly<
    Record<string, { factory: string; feature?: Feature }>
> = {
    createGain: { factory: "audio_create_gain" },
    createOscillator: {
        factory: "audio_create_oscillator",
        feature: "audio:oscillator",
    },
    createBiquadFilter: {
        factory: "audio_create_biquad_filter",
        feature: "audio:biquad-filter",
    },
    createStereoPanner: {
        factory: "audio_create_stereo_panner",
        feature: "audio:stereo-panner",
    },
    createBufferSource: {
        factory: "audio_create_buffer_source",
        feature: "audio:buffer-source",
    },
};

/** Optional host capabilities absent from the native audio platform. Keep
 * their feature-detection answer and unguarded-call diagnostic together. */
const UNAVAILABLE_CONTEXT_METHODS: Readonly<Record<string, string>> = {
    setSinkId: "native output-device selection is unavailable",
    createMediaStreamDestination: "native recording streams are unavailable",
    createMediaStreamSource: "native recording streams are unavailable",
    createMediaElementSource: "an HTMLAudioElement has no native audio producer",
};

/**
 * Browser applications sometimes feature-detect an AudioContext factory
 * before calling it. A factory this native surface implements is present by
 * construction, so its `typeof` result is the same constant as the browser's.
 */
export function audioTypeof(
    context: AudioReceiverContext,
    expression: ts.Expression,
): "function" | "undefined" | undefined {
    const property = context.unwrap(expression);
    if (ts.isIdentifier(property) && property.text === "AudioContext" &&
        context.isDefaultLibraryIdentifier(property)) return "function";
    if (!ts.isPropertyAccessExpression(property)) return undefined;
    const receiver = resolveAudioReceiver(context, property.expression);
    if (receiver?.kind !== "audio-context") return undefined;
    const result = UNAVAILABLE_CONTEXT_METHODS[property.name.text] ? "undefined" :
        NODE_FACTORIES[property.name.text] || ["resume", "suspend", "close"].includes(property.name.text) ? "function" : undefined;
    if (result && receiver.cpp) context.emit(`static_cast<void>(${receiver.cpp});`);
    return result;
}

/** Prototype aliases preserve the same absent optional host capabilities. */
export function audioPrototypeValue(
    context: Pick<LoweringServices, "isDefaultLibraryIdentifier">,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    if (expression.name.text !== "prototype" || !ts.isIdentifier(expression.expression) ||
        expression.expression.text !== "AudioContext" || !context.isDefaultLibraryIdentifier(expression.expression)) return undefined;
    return {kind:"record", cpp:"", recordProperties:Object.fromEntries(
        Object.keys(UNAVAILABLE_CONTEXT_METHODS).map(name => [name, {kind:"json-null" as const, cpp:"std::nullopt"}]))};
}

export function compileAudioConstructor(
    context: Pick<LoweringServices, "isDefaultLibraryIdentifier" | "reachFeature" | "audioSessionCpp" | "fail">,
    expression: ts.NewExpression,
): Value | undefined {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "AudioContext" ||
        !context.isDefaultLibraryIdentifier(expression.expression)) return undefined;
    if (expression.arguments?.length) context.fail(expression, "AudioContext constructor options are not represented.");
    context.reachFeature("audio:engine", expression);
    return {kind:"audio-context", cpp:`bbl::pal::audio_create_context(${context.audioSessionCpp()})`,
        dataType:{kind:"handle", handle:"audio-context"}, impure:true};
}

/** `param.<method>(value, time)`. */
const PARAM_SCHEDULES: Readonly<Record<string, string>> = {
    setValueAtTime: "audio_param_set_value_at_time",
    linearRampToValueAtTime: "audio_param_linear_ramp",
    exponentialRampToValueAtTime: "audio_param_exponential_ramp",
};

/**
 * Web Audio the reached slice does not lower, each refusing by name
 * rather than compiling to something quieter.
 */
const REFUSED_METHODS: Readonly<Record<string, string>> = {
    decodeAudioData:
        "encoded input must be an ArrayBuffer",
    createAnalyser: "the analyzer is not lowered",
    createPanner: "3D panning is not lowered",
    createDelay: "the delay node is not lowered",
    createConvolver: "the convolver is not lowered",
    createDynamicsCompressor: "the compressor is not lowered",
    createWaveShaper: "the wave shaper is not lowered",
    ...UNAVAILABLE_CONTEXT_METHODS,
    setValueCurveAtTime:
        "a value curve needs the array to reach the PAL as a span, and " +
        "the pinned `audio-param.ts` curve component lowered with it",
    setTargetAtTime:
        "setTargetAtTime is unreached by the corpus and unlowered",
};

/**
 * Refuses a name the reached slice does not serve, in one wording.
 * `intrinsics/audio.ts` refuses the Babylon half of the same surface
 * through the same helper, so the two tables cannot drift in shape.
 */
export function refuseAudioName(
    context: { fail(node: ts.Node, message: string): never },
    table: Readonly<Record<string, string>>,
    name: string,
    node: ts.Node,
    subject: string,
): void {
    const reason = table[name];
    if (reason) {
        context.fail(node, `${subject} '${name}' is not lowered: ${reason}.`);
    }
}

/**
 * Resolves a receiver to an audio value without compiling it.
 *
 * This is the whole of the dispatch guard, and it has to be: both hooks
 * sit on paths every property call and every property assignment in the
 * language goes through, so compiling the receiver to find out whether it
 * is audio would evaluate -- and emit for -- every other family first.
 * Each link steps through the same `readProperty` a direct read takes, so
 * the walk cannot disagree with the table it is walking.
 */
function resolveAudioReceiver(
    context: AudioReceiverContext,
    expression: ts.Expression,
): Value | undefined {
    const node = context.unwrap(expression);
    const narrowedAudioData = (
        value: Value | undefined,
    ): Value | undefined => {
        const type = value?.dataType;
        const handle =
            type?.kind === "handle"
                ? type.handle
                : type?.kind === "optional" &&
                    type.inner.kind === "handle"
                  ? type.inner.handle
                  : undefined;
        if (!handle || !AUDIO_KINDS.has(handle)) {
            return undefined;
        }
        const narrowed = context.compileValue(node);
        return AUDIO_KINDS.has(narrowed.kind)
            ? narrowed
            : undefined;
    };
    if (ts.isIdentifier(node)) {
        const bound = context.lookupOptional(node);
        return bound && AUDIO_KINDS.has(bound.kind)
            ? bound
            : narrowedAudioData(bound);
    }
    if (ts.isPropertyAccessExpression(node)) {
        if (
            node.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const field = context.resolveThisField(
                node.name.text,
            );
            return field && AUDIO_KINDS.has(field.kind)
                ? field
                : narrowedAudioData(field);
        }
        const owner = resolveAudioReceiver(context, node.expression);
        if (owner) return readProperty(context, owner, node.name.text, node);
    }
    const handle = domAudioHandleKind(context.checker.getNonNullableType(context.checker.getTypeAtLocation(node)));
    if (handle && AUDIO_KINDS.has(handle)) {
        const value = context.compileValue(node);
        return AUDIO_KINDS.has(value.kind) ? value : undefined;
    }
    return undefined;
}

// -- method calls --------------------------------------------------------

export function compileAudioMethodCall(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
): Value | undefined {
    const receiverExpression = context.unwrap(callee.expression);
    const chainedConnect =
        ts.isCallExpression(receiverExpression) &&
        ts.isPropertyAccessExpression(receiverExpression.expression) &&
        receiverExpression.expression.name.text === "connect"
            ? context.compileValue(receiverExpression)
            : undefined;
    const receiver =
        chainedConnect && AUDIO_KINDS.has(chainedConnect.kind)
            ? chainedConnect
            : resolveAudioReceiver(context, callee.expression);
    if (!receiver) {
        return undefined;
    }
    const method = callee.name.text;
    if (
        receiver.kind === "audio-context" &&
        method === "decodeAudioData" &&
        call.arguments.length === 1
    ) {
        const encoded = context.compileValue(argumentAt(call, 0));
        if (encoded.kind === "data" && encoded.dataType?.kind === "arraybuffer") {
            context.reachFeature("audio:buffer-source", call);
            context.reachFeature("audio:decoded-buffer", call);
            let input = context.unwrap(argumentAt(call, 0));
            while (ts.isAwaitExpression(input)) input = context.unwrap(input.expression);
            const sources = encoded.fetchedBytes?.expression === input ? encoded.fetchedBytes.sources : undefined;
            const codecs = sources ? new Set(sources.flatMap(source => {
                const codec = audioCodecForBytes(readAssetBytesSync(source, context.options.fileName));
                return codec ? [codec] : [];
            })) : AUDIO_CODECS;
            for (const codec of codecs) context.reachFeature(`audio:decode-${codec}`, call);
            if (context.options.workers) return context.dataLowerer.leafValue(
                `bbl::pal::audio_decode_async(${receiver.cpp}, ${encoded.cpp})`,
                {kind:"promise", result:{kind:"handle", handle:"audio-buffer"}});
            const decoded = context.allocateTemporaryCppName(
                "decoded_audio",
            );
            context.emit(
                `const bbl::pal::AudioBufferHandle ${decoded} = ` +
                    `bbl::pal::audio_decode_buffer(${receiver.cpp}, ` +
                    `${encoded.cpp});`,
            );
            return {
                kind: "audio-buffer",
                cpp: decoded,
                dataType: { kind: "handle", handle: "audio-buffer" },
                optionalFoundCpp: `${decoded}.value != 0u`,
            };
        }
    }
    refuseAudioName(context, REFUSED_METHODS, method, call, "Web Audio");

    if (receiver.kind === "audio-context") {
        if (method === "resume" || method === "suspend" || method === "close") {
            if (call.arguments.length) context.fail(call, `AudioContext.${method} takes no arguments.`);
            if (!context.options.workers) context.fail(call, "AudioContext lifecycle promises require an asynchronous application realm.");
            const action = method === "resume" ? "Resume" : method === "suspend" ? "Suspend" : "Close";
            return {...context.dataLowerer.leafValue(
                `bbl::pal::audio_context_transition(${receiver.cpp}, bbl::pal::AudioContextAction::${action})`,
                {kind:"promise"}), impure:true};
        }
        if (method === "createBuffer") {
            if (call.arguments.length !== 3) {
                context.fail(
                    call,
                    "createBuffer expects channel count, frame count, and sample rate.",
                );
            }
            context.reachFeature("audio:buffer-source", call);
            return {
                kind: "audio-buffer",
                cpp:
                    `bbl::pal::audio_create_buffer(${receiver.cpp}, ` +
                    `static_cast<std::uint32_t>(${context.compileNumber(argumentAt(call, 0))}), ` +
                    `static_cast<std::uint32_t>(${context.compileNumber(argumentAt(call, 1))}), ` +
                    `${context.compileNumber(argumentAt(call, 2), "double")})`,
                dataType: { kind: "handle", handle: "audio-buffer" },
            };
        }
        const factory = NODE_FACTORIES[method];
        if (!factory) {
            return undefined;
        }
        if (call.arguments.length !== 0) {
            context.fail(
                call,
                `${method} takes no arguments in the reached slice.`,
            );
        }
        if (factory.feature) {
            context.reachFeature(factory.feature, call);
        }
        const node = context.allocateTemporaryCppName("audio_node");
        context.emit(
            `const bbl::pal::AudioNodeHandle ${node} = ` +
                `bbl::pal::${factory.factory}(${receiver.cpp});`,
        );
        return {
            kind: "audio-node",
            cpp: node,
        };
    }

    if (receiver.kind === "audio-buffer" && method === "getChannelData") {
        if (call.arguments.length !== 1) {
            context.fail(call, "getChannelData expects exactly one channel index.");
        }
        return {
            kind: "data",
            cpp:
                `bbl::pal::audio_buffer_channel(${receiver.cpp}, ` +
                `static_cast<std::uint32_t>(${context.compileNumber(argumentAt(call, 0))}))`,
            dataType: { kind: "f32array" },
        };
    }

    if (receiver.kind === "audio-buffer" && (method === "copyFromChannel" || method === "copyToChannel")) {
        context.expectArgumentCount(call, 2, 3);
        context.reachFeature("audio:buffer-source", call);
        const buffer = context.allocateTemporaryCppName("audio_copy_buffer");
        context.emit(`const auto ${buffer} = ${receiver.cpp};`);
        const samples = context.compileValue(argumentAt(call, 0));
        if (samples.dataType?.kind !== "f32array") context.fail(argumentAt(call, 0), `${method} requires a Float32Array.`);
        const input = context.allocateTemporaryCppName("audio_copy_samples");
        context.emit(`const auto ${input} = ${samples.cpp};`);
        const index = (argument: ts.Expression): string => {
            const cpp = context.compileNumber(argument, "double");
            const name = context.allocateTemporaryCppName("audio_copy_index");
            context.emit(`const auto ${name} = bbl::js::to_uint32(${cpp});`);
            return name;
        };
        const channel = index(argumentAt(call, 1));
        const offset = call.arguments[2] ? index(call.arguments[2]) : "0u";
        const direction = method === "copyToChannel" ? "ToChannel" : "FromChannel";
        return {kind:"void", cpp:`bbl::pal::audio_buffer_copy(${buffer}, ${input}, ${channel}, ${offset}, bbl::pal::AudioBufferCopy::${direction})`};
    }

    if (receiver.kind === "audio-node") {
        switch (method) {
            case "addEventListener":
            case "removeEventListener": {
                context.expectArgumentCount(call, 2, 3);
                if (!context.options.workers) context.fail(call, "Audio event listeners require an asynchronous application realm.");
                const selected = {...receiver};
                delete selected.nativeBinding;
                const target = context.pinValueToTemporary(selected, "audio_event_target", callee.expression);
                const type = context.compileStringLiteral(argumentAt(call, 0));
                if (type !== "ended") context.fail(call, "Only scheduled audio source ended listeners are represented.");
                const callback = argumentAt(call, 1);
                context.hoistForwardCallbackBindings(callback, call.pos);
                const removing = method === "removeEventListener";
                const callbackType = context.checker.getTypeAtLocation(callback);
                const absent = (callbackType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0;
                let identity = "0u", listener = "";
                if (!absent) {
                    if (removing) {
                        const value = {...context.compileValue(callback)};
                        delete value.nativeBinding;
                        const snapshot = value.kind === "data" ? context.pinValueToTemporary(value, "audio_event_callback", callback) : value;
                        identity = context.platformEventCallbackIdentity(snapshot, callback);
                    } else {
                        if (callbackType.getCallSignatures().some(signature => signature.parameters.length > 0))
                            context.fail(callback, "Audio ended event payloads are not represented yet.");
                        const compiled = context.compilePlatformCallback(callback, undefined, []);
                        identity = compiled.identity;
                        listener = compiled.cpp;
                    }
                }
                const options = listenerOptions(context, call.arguments[2], removing);
                return {kind:"void", cpp:absent ? "" :
                    `bbl::pal::audio_${removing ? "remove" : "add"}_ended_listener(${target.cpp}, ${identity}, ` +
                    `${removing ? options.capture : `${listener}, ${options.capture}, ${options.once}`})`};
            }
            case "connect": {
                if (call.arguments.length !== 1) {
                    context.fail(
                        call,
                        "connect(destination) is the reached form.",
                    );
                }
                const destination = context.compileValue(argumentAt(call, 0));
                if (destination.kind === "audio-param") {
                    return {
                        kind: "void",
                        cpp:
                            `bbl::pal::audio_connect_param(${receiver.cpp}, ` +
                            `${destination.cpp})`,
                    };
                }
                if (destination.kind !== "audio-node") {
                    context.fail(
                        argumentAt(call, 0),
                        "connect expects an audio node or AudioParam.",
                    );
                }
                return {
                    ...destination,
                    cpp:
                        `(bbl::pal::audio_connect(${receiver.cpp}, ` +
                        `${destination.cpp}), ${destination.cpp})`,
                    impure: true,
                };
            }
            case "disconnect": {
                if (call.arguments.length !== 0) {
                    context.fail(
                        call,
                        "disconnect() with a target is not lowered; the " +
                            "reached form drops every outgoing edge.",
                    );
                }
                return {
                    kind: "void",
                    cpp: `bbl::pal::audio_disconnect(${receiver.cpp})`,
                };
            }
            case "start":
            case "stop": {
                // The spec's own default: `start()` is `start(0)`, which
                // the engine reads as "now".
                const when =
                    call.arguments.length > 0
                        ? context.compileNumber(argumentAt(call, 0), "double")
                        : "0.0";
                const maximum = method === "start" ? 3 : 1;
                if (call.arguments.length > maximum) {
                    context.fail(
                        call,
                        `${method} expects at most ${maximum} arguments.`,
                    );
                }
                const trailing = call.arguments
                    .slice(1)
                    .map((argument) =>
                        context.compileNumber(argument, "double"),
                    );
                return {
                    kind: "void",
                    cpp:
                        `bbl::pal::audio_node_${method}(` +
                        `${receiver.cpp}, ${[when, ...trailing].join(", ")})`,
                };
            }
            default:
                return undefined;
        }
    }

    if (receiver.kind === "audio-param") {
        const schedule = PARAM_SCHEDULES[method];
        if (schedule) {
            if (call.arguments.length !== 2) {
                context.fail(
                    call,
                    `${method}(value, time) is the reached form.`,
                );
            }
            const value = context.compileNumber(argumentAt(call, 0), "float");
            const time = context.compileNumber(argumentAt(call, 1), "double");
            return {
                kind: "void",
                cpp: `bbl::pal::${schedule}(${receiver.cpp}, ${value}, ${time})`,
            };
        }
        if (method === "cancelScheduledValues") {
            const time =
                call.arguments.length > 0
                    ? context.compileNumber(argumentAt(call, 0), "double")
                    : "0.0";
            return {
                kind: "void",
                cpp:
                    `bbl::pal::audio_param_cancel_scheduled_values(` +
                    `${receiver.cpp}, ${time})`,
            };
        }
        return undefined;
    }

    return undefined;
}

// -- writes --------------------------------------------------------------

/**
 * Emits a reached Web Audio property write, in the shape every other hook
 * on the assignment chain takes: it either handles the assignment and
 * says so, or leaves it alone.
 */
export function emitAudioPropertyAssignment(
    context: AudioWriteContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
): boolean {
    const owner = resolveAudioReceiver(context, left.expression);
    if (!owner) {
        return false;
    }
    const property = left.name.text;
    const right = expression.right;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        context.fail(
            expression.operatorToken,
            "Compound assignment is not supported for a Web Audio property.",
        );
    }

    if (owner.kind === "audio-param" && property === "value") {
        context.emit(
            `bbl::pal::audio_param_set_value(${owner.cpp}, ` +
                `${context.compileNumber(right, "float")});`,
        );
        return true;
    }

    if (owner.kind !== "audio-node") {
        return false;
    }

    if (property === "buffer") {
        const buffer = context.compileValue(right);
        if (buffer.kind !== "audio-buffer") {
            context.fail(right, "AudioBufferSourceNode.buffer expects an AudioBuffer.");
        }
        context.reachFeature("audio:buffer-source", expression);
        context.emit(
            `bbl::pal::audio_set_buffer(${owner.cpp}, ${buffer.cpp});`,
        );
        return true;
    }

    if (property === "loop") {
        context.reachFeature("audio:buffer-source", expression);
        context.emit(
            `bbl::pal::audio_set_loop(${owner.cpp}, ` +
                `${context.compileBoolean(right)});`,
        );
        return true;
    }

    if (property === "onended") {
        const callback = context.unwrap(right);
        const statements =
            (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
            ts.isBlock(callback.body)
                ? callback.body.statements
                : undefined;
        const cleanupOnly =
            statements &&
            statements.every((statement) => {
                if (!ts.isExpressionStatement(statement)) return false;
                const call = context.unwrap(statement.expression);
                if (
                    !ts.isCallExpression(call) ||
                    call.arguments.length !== 0 ||
                    !ts.isPropertyAccessExpression(call.expression) ||
                    call.expression.name.text !== "disconnect"
                ) {
                    return false;
                }
                return resolveAudioReceiver(
                    context,
                    call.expression.expression,
                )?.kind === "audio-node";
            });
        if (cleanupOnly) {
            // LabSound releases a finished source independently. Dropping an
            // onended handler whose only observable work disconnects that
            // finished source and its private one-shot gain preserves audio;
            // no later source retains either node.
            return true;
        }
        context.fail(
            right,
            "onended is an escaping callback, which is not lowered.",
        );
    }
    if (property !== "type") {
        return false;
    }

    const spelling = context.compileValue(right).staticString;
    if (spelling === undefined) {
        context.fail(
            right,
            "An oscillator or filter type must be a static string; the " +
                "pin's own types are string enums and the composed set is " +
                "closed at generation.",
        );
    }
    const wave = OSCILLATOR_WAVES[spelling];
    if (wave) {
        context.emit(
            `bbl::pal::audio_set_oscillator_wave(${owner.cpp}, ` +
                `bbl::pal::OscillatorWave::${wave});`,
        );
        return true;
    }
    const filter = FILTER_KINDS[spelling];
    if (filter) {
        context.emit(
            `bbl::pal::audio_set_filter_kind(${owner.cpp}, ` +
                `bbl::pal::BiquadFilterKind::${filter});`,
        );
        return true;
    }
    context.fail(
        right,
        `'${spelling}' is not a reached oscillator or filter type. A ` +
            "custom periodic wave is not lowered.",
    );
}
