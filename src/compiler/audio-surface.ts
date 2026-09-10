// Web Audio method calls and writes use native context, node and buffer handles.
import { EmissionSet } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { AUDIO_CODECS, audioCodecForBytes } from "../audio-codecs.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import ts from "typescript";
import { argumentAt } from "./syntax.js";

import { readProperty, type PropertyContext } from "./properties.js";
import type { Feature, Value } from "./types.js";

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
        | "allocateTemporaryCppName"
        | "cppString"
        | "registerAsset"
        | "options"
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

/**
 * Browser applications sometimes feature-detect an AudioContext factory
 * before calling it. A factory this native surface implements is present by
 * construction, so its `typeof` result is the same constant as the browser's.
 */
export function isSupportedAudioMethodProperty(
    context: AudioReceiverContext,
    expression: ts.Expression,
): boolean {
    const property = context.unwrap(expression);
    if (!ts.isPropertyAccessExpression(property)) return false;
    const receiver = resolveAudioReceiver(context, property.expression);
    return Boolean(
        receiver?.kind === "audio-context" &&
        NODE_FACTORIES[property.name.text],
    );
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
    createMediaStreamSource: "a MediaStream has no native equivalent here",
    createMediaElementSource:
        "an HTMLAudioElement has no native equivalent here",
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
        if (!owner) {
            return undefined;
        }
        return readProperty(context, owner, node.name.text, node);
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

    if (receiver.kind === "audio-node") {
        switch (method) {
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
