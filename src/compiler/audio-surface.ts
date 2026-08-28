// The Web Audio surface: the method calls and the writes a scene
// performs on the context an audio engine hands back.
//
// Babylon Lite's audio API is standalone functions like the rest of the
// library, and those live in `intrinsics/audio.ts`. This file is the
// other half, and it exists because the seam the pin draws is the
// *browser's* API rather than Babylon's: every reached consumer takes
// `engine.audioContext` and builds an ordinary Web Audio graph on it
// (`ctx.createOscillator()`, `osc.frequency.setValueAtTime(...)`,
// `node.connect(...)`), which is method-shaped where Babylon Lite is
// function-shaped. Those calls resolve here, against the handles
// `bblite/pal_audio.hpp` defines.
//
// The *reads* are deliberately not here: `node.gain`, `ctx.currentTime`
// and their siblings are ordinary declared property reads, and they live
// in `properties.ts`'s own rule table beside every other family's.
//
// Two rules the shape depends on:
//
//   * **A handle carries its context.** Web Audio forbids connecting
//     nodes across contexts and every factory is a method on one, so the
//     context travels on each node rather than being looked up. The
//     table's `carriesAudioContext` is what moves it across a read.
//   * **Times are context times, not frame times.** `osc.start(t)` and
//     `param.setValueAtTime(v, t)` schedule against
//     `AudioContext.currentTime`, which advances on the audio thread.
//     Nothing here is stepped by the renderer, which is also why a
//     capture render is the measurable one.
import ts from "typescript";

import { readProperty, type PropertyContext } from "./properties.js";
import type { Feature, Value } from "./types.js";

/**
 * What resolving a receiver needs, and nothing more. `PropertyContext`
 * satisfies it, which is what lets a receiver walk run through the same
 * rule table a direct read takes.
 */
export interface AudioReceiverContext extends PropertyContext {
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    resolveThisField(name: string): Value | undefined;
    unwrap(expression: ts.Expression): ts.Expression;
}

/** What a property write needs. `AssignmentContext` satisfies it. */
export interface AudioWriteContext extends AudioReceiverContext {
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    reachFeature(feature: Feature, site?: ts.Node): void;
    emit(line: string): void;
}

/** What a method call needs. The expression compiler satisfies it. */
export interface AudioCallContext extends AudioWriteContext {
    allocateTemporaryCppName(label: string): string;
}

const AUDIO_KINDS = new Set<string>([
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
        "an encoded audio file is an asset, and audio assets are not " +
        "materialized at generation yet",
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
    if (ts.isIdentifier(node)) {
        const bound = context.lookupOptional(node);
        return bound && AUDIO_KINDS.has(bound.kind) ? bound : undefined;
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
                : undefined;
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
    const receiver = resolveAudioReceiver(context, callee.expression);
    if (!receiver) {
        return undefined;
    }
    const method = callee.name.text;
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
                    `static_cast<std::uint32_t>(${context.compileNumber(call.arguments[0]!)}), ` +
                    `static_cast<std::uint32_t>(${context.compileNumber(call.arguments[1]!)}), ` +
                    `${context.compileNumber(call.arguments[2]!, "double")})`,
                dataType: { kind: "handle", handle: "audio-buffer" },
                audioContextCpp: receiver.cpp,
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
            audioContextCpp: receiver.cpp,
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
                `static_cast<std::uint32_t>(${context.compileNumber(call.arguments[0]!)}))`,
            dataType: { kind: "f32array" },
            borrowedData: true,
        };
    }

    if (receiver.kind === "audio-node") {
        switch (method) {
            case "connect": {
                if (call.arguments.length !== 1) {
                    context.fail(
                        call,
                        "connect(destination) is the reached form; " +
                            "connecting to an AudioParam is not lowered.",
                    );
                }
                const destination = context.compileValue(call.arguments[0]!);
                if (destination.kind !== "audio-node") {
                    context.fail(
                        call.arguments[0]!,
                        "connect expects an audio node.",
                    );
                }
                return {
                    kind: "void",
                    cpp:
                        `bbl::pal::audio_connect(${receiver.cpp}, ` +
                        `${destination.cpp})`,
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
                        ? context.compileNumber(call.arguments[0]!, "double")
                        : "0.0";
                if (call.arguments.length > 1) {
                    context.fail(
                        call,
                        `${method}'s offset and duration arguments are not ` +
                            "lowered; the reached form passes a time alone.",
                    );
                }
                return {
                    kind: "void",
                    cpp:
                        `bbl::pal::audio_node_${method}(` +
                        `${receiver.cpp}, ${when})`,
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
            const value = context.compileNumber(call.arguments[0]!, "float");
            const time = context.compileNumber(call.arguments[1]!, "double");
            return {
                kind: "void",
                cpp: `bbl::pal::${schedule}(${receiver.cpp}, ${value}, ${time})`,
            };
        }
        if (method === "cancelScheduledValues") {
            const time =
                call.arguments.length > 0
                    ? context.compileNumber(call.arguments[0]!, "double")
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

    if (property === "onended") {
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
