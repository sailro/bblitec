// Web Audio method calls and writes use native context, node and buffer handles.
import { EmissionSet } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { AUDIO_CODECS, audioCodecForBytes } from "../audio-codecs.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import ts from "typescript";
import { argumentAt } from "./syntax.js";
import { declaredInDomLibrary, resolvedSymbol } from "./symbols.js";

import { readProperty, type PropertyContext } from "./properties.js";
import { isStringValue, type Feature, type Value } from "./types.js";
import { domAudioHandleKind } from "./data-types.js";
import { listenerOptions } from "./dom-listeners.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { packagedUrlAssets, type StaticFetchContext } from "./static-fetch.js";
import { deploymentUrl } from "./deployment.js";
import { webAudioMemberCall } from "../lowering/web-platform-schema.js";
import {
    AUDIO_ELEMENT_PROPERTIES,
    AUDIO_PARAM_SCHEDULES,
    PANNER_MODELS,
    PANNER_PROPERTIES,
    SOURCE_LOOP_MEMBERS,
} from "./web-audio-members.js";

/**
 * What resolving a receiver needs, and nothing more. `PropertyContext`
 * satisfies it, which is what lets a receiver walk run through the same
 * rule table a direct read takes.
 */
interface AudioReceiverContext
    extends
        PropertyContext,
        Pick<
            LoweringServices,
            | "bindings"
            | "resolveThisField"
            | "compileValue"
            | "unwrap"
            | "checker"
            | "libraryGlobal"
            | "emit"
        > {}

/** What a property write needs. `AssignmentContext` satisfies it. */
interface AudioWriteContext
    extends
        AudioReceiverContext,
        Pick<
            LoweringServices,
            | "compileNumber"
            | "compileBoolean"
            | "reachFeature"
            | "emit"
            | "options"
            | "callbacks"
            | "dataLowerer"
        > {}

/** What a method call needs. The expression compiler satisfies it. */
interface AudioCallContext
    extends
        AudioWriteContext,
        Pick<
            LoweringServices,
            | "checker"
            | "expectKind"
            | "expectArgumentCount"
            | "allocateTemporaryCppName"
            | "registerNativeTemporary"
            | "cppString"
            | "assetRegistry"
            | "dataLowerer"
            | "options"
            | "conditions"
            | "compileStringLiteral"
            | "dataTypes"
            | "callbacks"
            | "bindings"
            | "emitDiscardedValue"
            | "captureEmittedLines"
        > {}

const AUDIO_KINDS = new EmissionSet<string>([
    "audio-engine",
    "audio-element",
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

/**
 * Whether `member` is an oscillator's or filter's `type`: a closed string
 * enum the graph composes at generation from a static string.
 */
export function isComposedAudioEnum(
    checker: ts.TypeChecker,
    member: ts.Expression,
): boolean {
    const symbol = ts.isPropertyAccessExpression(member)
        ? resolvedSymbol(checker, member)
        : undefined;
    return (
        symbol !== undefined &&
        symbol.name === "type" &&
        declaredInDomLibrary(symbol) &&
        (symbol.declarations ?? []).some(
            (declaration) =>
                ts.isInterfaceDeclaration(declaration.parent) &&
                ["OscillatorNode", "BiquadFilterNode"].includes(
                    declaration.parent.name.text,
                ),
        )
    );
}

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
    createPanner: {
        factory: "audio_create_panner",
        feature: "audio:panner",
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
    if (context.libraryGlobal(property) === "AudioContext") return "function";
    if (!ts.isPropertyAccessExpression(property)) return undefined;
    const receiver = resolveAudioReceiver(context, property.expression);
    if (receiver?.kind !== "audio-context") return undefined;
    const result = UNAVAILABLE_CONTEXT_METHODS[property.name.text]
        ? "undefined"
        : NODE_FACTORIES[property.name.text] ||
            [
                "resume",
                "suspend",
                "close",
                "createMediaStreamDestination",
                "createMediaStreamSource",
                "createMediaElementSource",
            ].includes(property.name.text)
          ? "function"
          : undefined;
    if (result && receiver.cpp)
        context.emit({
            kind: "expression",
            code: `static_cast<void>(${receiver.cpp});`,
        });
    return result;
}

/** Prototype aliases preserve the same absent optional host capabilities. */
export function audioPrototypeValue(
    context: Pick<LoweringServices, "libraryGlobal">,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    if (
        expression.name.text !== "prototype" ||
        context.libraryGlobal(expression.expression) !== "AudioContext"
    )
        return undefined;
    return {
        kind: "record",
        cpp: "",
        recordProperties: Object.fromEntries(
            Object.keys(UNAVAILABLE_CONTEXT_METHODS).map((name) => [
                name,
                { kind: "json-null" as const, cpp: "std::nullopt" },
            ]),
        ),
    };
}

/**
 * A URL argument selecting packaged audio a linked decoder reads: each file it
 * may select is packaged, registered with `register_packaged_responses` under
 * `spell(url)`, and its decoder reached. Returns the URL, pinned in source
 * order into a `label` temporary, as a C++ `std::string` expression.
 */
export function packagedAudioUrl(
    context: StaticFetchContext & Pick<LoweringServices, "emit">,
    site: ts.Node,
    argument: ts.Expression,
    refusal: string,
    spell: (url: string) => string = (url) => url,
    label = "audio_url",
): string {
    const decodable = (source: string): boolean => {
        try {
            return (
                audioCodecForBytes(
                    readAssetBytesSync(source, context.options.fileName),
                ) !== undefined
            );
        } catch {
            return false;
        }
    };
    const packaged = packagedUrlAssets(context, argument, "binary", decodable);
    if (!packaged || packaged.assets.length === 0)
        return context.fail(argument, refusal);
    for (const asset of packaged.assets) {
        const codec = audioCodecForBytes(
            readAssetBytesSync(asset.file, context.options.fileName),
        )!;
        context.reachFeature(`audio:decode-${codec}`, site);
    }
    const base = deploymentUrl(context.options).href;
    const entries = packaged.assets.map(
        (asset) =>
            `{${context.cppString(spell(asset.logicalSource))}, bbl::asset_path(${context.cppString(asset.output)})}`,
    );
    const url = context.bindings.pinValueToTemporary(
        {
            kind: "string",
            cpp: context.dataLowerer.compileKnownValueForSink(
                packaged.selected,
                { kind: "string" },
                argument,
            ),
        },
        label,
        argument,
    );
    context.emit(
        `bbl::pal::register_packaged_responses(${context.cppString(base)}, {${entries.join(", ")}});`,
    );
    return `std::string(${url.cpp})`;
}

/** `new Audio([url])`: an element over a packaged source (`pal_audio_element.hpp`). */
function compileAudioElementConstructor(
    context: StaticFetchContext &
        Pick<LoweringServices, "audioSessionCpp" | "emit">,
    expression: ts.NewExpression,
): Value {
    if (!context.options.workers) throw new ApplicationRealmRequired();
    const parameters = expression.arguments ?? [];
    if (parameters.length > 1)
        context.fail(expression, "new Audio takes at most a source URL.");
    context.reachFeature("audio:media-element", expression);
    const url = parameters[0]
        ? packagedAudioUrl(
              context,
              expression,
              parameters[0],
              "An Audio source URL must select packaged audio a linked decoder reads: a literal, or a runtime string whose candidates generation can find.",
          )
        : undefined;
    // An unrouted element plays to its audio session's default output.
    const session = context.audioSessionCpp();
    return {
        kind: "audio-element",
        cpp: `bbl::pal::audio_create_element(${url ? `${session}, ${url}` : session})`,
        dataType: { kind: "handle", handle: "audio-element" },
        impure: true,
    };
}

export function compileAudioConstructor(
    context: StaticFetchContext &
        Pick<LoweringServices, "audioSessionCpp" | "emit">,
    expression: ts.NewExpression,
): Value | undefined {
    if (context.libraryGlobal(expression.expression) === "Audio")
        return compileAudioElementConstructor(context, expression);
    if (context.libraryGlobal(expression.expression) !== "AudioContext")
        return undefined;
    if (expression.arguments?.length)
        context.fail(
            expression,
            "AudioContext constructor options are not represented.",
        );
    context.reachFeature("audio:engine", expression);
    return {
        kind: "audio-context",
        cpp: `bbl::pal::audio_create_context(${context.audioSessionCpp()})`,
        dataType: { kind: "handle", handle: "audio-context" },
        impure: true,
    };
}

/** `param.<method>(value, time)`. */
const PARAM_SCHEDULES: ReadonlyMap<string, string> = new Map(
    AUDIO_PARAM_SCHEDULES,
);

/**
 * Web Audio the reached slice does not lower, each refusing by name
 * rather than compiling to something quieter.
 */
const REFUSED_METHODS: Readonly<Record<string, string>> = {
    decodeAudioData: "encoded input must be an ArrayBuffer",
    createAnalyser: "the analyzer is not lowered",
    createDelay: "the delay node is not lowered",
    createConvolver: "the convolver is not lowered",
    createDynamicsCompressor: "the compressor is not lowered",
    createWaveShaper: "the wave shaper is not lowered",
    ...UNAVAILABLE_CONTEXT_METHODS,
    setTargetAtTime: "setTargetAtTime is unreached by the corpus and unlowered",
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
    const narrowedAudioData = (value: Value | undefined): Value | undefined => {
        const type = value?.dataType;
        const handle =
            type?.kind === "handle"
                ? type.handle
                : type?.kind === "optional" && type.inner.kind === "handle"
                  ? type.inner.handle
                  : undefined;
        if (!handle || !AUDIO_KINDS.has(handle)) {
            return undefined;
        }
        const narrowed = context.compileValue(node);
        return AUDIO_KINDS.has(narrowed.kind) ? narrowed : undefined;
    };
    if (ts.isIdentifier(node)) {
        const bound = context.bindings.lookupOptional(node);
        return bound && AUDIO_KINDS.has(bound.kind)
            ? bound
            : narrowedAudioData(bound);
    }
    if (ts.isPropertyAccessExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const field = context.resolveThisField(node.name.text);
            return field && AUDIO_KINDS.has(field.kind)
                ? field
                : narrowedAudioData(field);
        }
        const owner = resolveAudioReceiver(context, node.expression);
        if (owner) return readProperty(context, owner, node.name.text, node);
    }
    const handle = domAudioHandleKind(
        context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(node),
        ),
    );
    if (handle && AUDIO_KINDS.has(handle)) {
        const value = context.compileValue(node);
        return AUDIO_KINDS.has(value.kind) ? value : undefined;
    }
    return undefined;
}

// -- method calls --------------------------------------------------------

/** A node a factory call makes, held in a temporary the call returns. */
function emitAudioNode(context: AudioCallContext, initializer: string): Value {
    const node = context.allocateTemporaryCppName("audio_node");
    context.emit({
        kind: "declaration",
        type: "bbl::pal::AudioNodeHandle",
        name: node,
        initializer,
    });
    context.registerNativeTemporary(node);
    return { kind: "audio-node", cpp: node };
}

/** An audio call's operand, evaluated into a temporary in source order. */
function pinnedAudioOperand(
    context: AudioCallContext,
    value: Value,
    label: string,
): string {
    const name = context.allocateTemporaryCppName(label);
    context.emit({
        kind: "declaration",
        type: "const auto",
        name,
        initializer: value.cpp,
    });
    return name;
}

/** A numeric operand, evaluated into a temporary in source order. */
function numberOperand(
    context: AudioCallContext,
    argument: ts.Expression,
    label: string,
): string {
    const name = context.allocateTemporaryCppName(label);
    context.emit({
        kind: "declaration",
        type: "const double",
        name,
        initializer: context.compileNumber(argument, "double"),
    });
    return name;
}

export function compileAudioMethodCall(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
): Value | undefined {
    if (callee.questionDotToken) {
        const kind = domAudioHandleKind(
            context.checker.getNonNullableType(
                context.checker.getTypeAtLocation(callee.expression),
            ),
        );
        if (!kind || !AUDIO_KINDS.has(kind)) return undefined;
        const value = context.compileValue(callee.expression);
        if (value.kind === "json-null") return value;
        if (value.dataType?.kind === "optional") {
            return context.dataLowerer.optionalAccess(
                value,
                call,
                (receiver) => {
                    const result = compileAudioReceiverMethod(
                        context,
                        call,
                        callee,
                        receiver,
                    );
                    if (result && result.kind !== "void")
                        context.fail(
                            call,
                            "Optional audio calls currently require a void result.",
                        );
                    return result;
                },
            );
        }
        return compileAudioReceiverMethod(context, call, callee, value);
    }
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
    return compileAudioReceiverMethod(context, call, callee, receiver);
}

/** `HTMLAudioElement` event types and their `AudioElementEvent`. */
const AUDIO_ELEMENT_EVENTS: Readonly<Record<string, string>> = {
    timeupdate: "TimeUpdate",
    ended: "Ended",
    play: "Play",
    pause: "Pause",
};

/**
 * `add/removeEventListener(type, listener[, options])` on an audio target:
 * the target and the listener's identity pinned in source order. `event`
 * spells a represented type's native argument (with its trailing comma), or
 * refuses it; `rest` is the listener (when adding) and the options.
 */
function compileAudioListener(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    receiver: Value,
    event: (type: string) => string | undefined,
    refusals: { type: string; payload: string; signal: string },
): {
    target: string;
    event: string;
    identity: string;
    rest: string;
    absent: boolean;
    removing: boolean;
} {
    context.expectArgumentCount(call, 2, 3);
    if (!context.options.workers) throw new ApplicationRealmRequired();
    const selected = { ...receiver };
    delete selected.nativeBinding;
    const target = context.bindings.pinValueToTemporary(
        selected,
        "audio_event_target",
        callee.expression,
    );
    const native = event(context.compileStringLiteral(argumentAt(call, 0)));
    if (native === undefined) return context.fail(call, refusals.type);
    const callback = argumentAt(call, 1);
    context.callbacks.hoistForwardCallbackBindings(callback);
    const removing = callee.name.text === "removeEventListener";
    const callbackType = context.checker.getTypeAtLocation(callback);
    const absent =
        (callbackType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !==
        0;
    let identity = "0u",
        listener = "";
    if (!absent) {
        if (removing) {
            const value = { ...context.compileValue(callback) };
            delete value.nativeBinding;
            const snapshot =
                value.kind === "data"
                    ? context.bindings.pinValueToTemporary(
                          value,
                          "audio_event_callback",
                          callback,
                      )
                    : value;
            identity = context.callbacks.platformEventCallbackIdentity(
                snapshot,
                callback,
            );
        } else {
            if (
                callbackType
                    .getCallSignatures()
                    .some((signature) => signature.parameters.length > 0)
            )
                context.fail(callback, refusals.payload);
            const compiled = context.callbacks.compilePlatformCallback(
                callback,
                undefined,
                [],
            );
            identity = compiled.identity;
            listener = compiled.cpp;
        }
    }
    const options = listenerOptions(context, call.arguments[2], removing);
    if (options.signal) context.fail(call.arguments[2]!, refusals.signal);
    return {
        target: target.cpp,
        event: native,
        identity,
        rest: removing
            ? options.capture
            : `${listener}, ${options.capture}, ${options.once}`,
        absent,
        removing,
    };
}

/** `play`, `pause`, `load`, `removeAttribute("src")` and listeners on an `HTMLAudioElement`. */
function compileAudioElementMethod(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    receiver: Value,
): Value | undefined {
    const method = callee.name.text;
    context.reachFeature("audio:media-element", call);
    if (method === "addEventListener" || method === "removeEventListener") {
        const lowered = compileAudioListener(
            context,
            call,
            callee,
            receiver,
            (type) => {
                const event = AUDIO_ELEMENT_EVENTS[type];
                return event && `bbl::pal::AudioElementEvent::${event}, `;
            },
            {
                type: `Only ${Object.keys(AUDIO_ELEMENT_EVENTS).join(", ")} listeners are represented on an Audio element.`,
                payload:
                    "Audio element event payloads are not represented yet.",
                signal: "Audio element listeners with an AbortSignal are not lowered.",
            },
        );
        return {
            kind: "void",
            cpp: lowered.absent
                ? ""
                : `bbl::pal::audio_element_${lowered.removing ? "remove" : "add"}_listener(${lowered.target}, ${lowered.event}${lowered.identity}, ${lowered.rest})`,
        };
    }
    if (method === "removeAttribute") {
        context.expectArgumentCount(call, 1, 1);
        if (context.compileStringLiteral(argumentAt(call, 0)) !== "src")
            context.fail(
                call,
                'Only removeAttribute("src") is represented on an Audio element.',
            );
        return {
            kind: "void",
            cpp: `bbl::pal::audio_element_remove_source(${receiver.cpp})`,
        };
    }
    if (method === "play" || method === "pause" || method === "load") {
        context.expectArgumentCount(call, 0, 0);
        const cpp = webAudioMemberCall("HTMLAudioElement", method)(
            receiver.cpp,
            [],
        );
        if (method !== "play") return { kind: "void", cpp };
        return {
            ...context.dataLowerer.leafValue(cpp, { kind: "promise" }),
            impure: true,
        };
    }
    return context.fail(
        call,
        `HTMLAudioElement.${method} is not lowered: an Audio element plays, pauses, loads, listens and drops its source.`,
    );
}

function compileAudioReceiverMethod(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    receiver: Value,
): Value | undefined {
    const method = callee.name.text;
    // Stored and deferred-produced handles can reach operations without
    // a context constructor in this translation unit.
    context.reachFeature("audio:engine", call);
    if (
        receiver.kind === "audio-context" &&
        method === "decodeAudioData" &&
        call.arguments.length === 1
    ) {
        const encoded = context.compileValue(argumentAt(call, 0));
        if (
            encoded.kind === "data" &&
            encoded.dataType?.kind === "arraybuffer"
        ) {
            context.reachFeature("audio:buffer-source", call);
            context.reachFeature("audio:decoded-buffer", call);
            let input = context.unwrap(argumentAt(call, 0));
            while (ts.isAwaitExpression(input))
                input = context.unwrap(input.expression);
            const sources =
                encoded.fetchedBytes?.expression === input
                    ? encoded.fetchedBytes.sources
                    : undefined;
            const codecs = sources
                ? new Set(
                      sources.flatMap((source) => {
                          const codec = audioCodecForBytes(
                              readAssetBytesSync(
                                  source,
                                  context.options.fileName,
                              ),
                          );
                          return codec ? [codec] : [];
                      }),
                  )
                : AUDIO_CODECS;
            for (const codec of codecs)
                context.reachFeature(`audio:decode-${codec}`, call);
            if (context.options.workers)
                return context.dataLowerer.leafValue(
                    `bbl::pal::audio_decode_async(${receiver.cpp}, ${encoded.cpp})`,
                    {
                        kind: "promise",
                        result: { kind: "handle", handle: "audio-buffer" },
                    },
                );
            const decoded = context.allocateTemporaryCppName("decoded_audio");
            context.emit({
                kind: "declaration",
                type: "const bbl::pal::AudioBufferHandle",
                name: decoded,
                initializer: `bbl::pal::audio_decode_buffer(${receiver.cpp}, ${encoded.cpp})`,
            });
            return {
                kind: "audio-buffer",
                cpp: decoded,
                dataType: { kind: "handle", handle: "audio-buffer" },
                optionalFoundCpp: `${decoded}.value != 0u`,
            };
        }
    }
    refuseAudioName(context, REFUSED_METHODS, method, call, "Web Audio");

    if (receiver.kind === "audio-element")
        return compileAudioElementMethod(context, call, callee, receiver);

    if (
        receiver.kind === "audio-context" &&
        method === "createMediaElementSource"
    ) {
        context.expectArgumentCount(call, 1, 1);
        const audioContext = pinnedAudioOperand(
            context,
            receiver,
            "media_element_context",
        );
        const element = context.compileValue(argumentAt(call, 0));
        if (element.kind !== "audio-element")
            context.fail(
                argumentAt(call, 0),
                "createMediaElementSource takes an Audio element.",
            );
        context.reachFeature("audio:media-element", call);
        return emitAudioNode(
            context,
            `bbl::pal::audio_create_media_element_source(${audioContext}, ${element.cpp})`,
        );
    }

    if (receiver.kind === "audio-context") {
        if (method === "resume" || method === "suspend" || method === "close") {
            if (call.arguments.length)
                context.fail(
                    call,
                    `AudioContext.${method} takes no arguments.`,
                );
            if (!context.options.workers) throw new ApplicationRealmRequired();
            const action =
                method === "resume"
                    ? "Resume"
                    : method === "suspend"
                      ? "Suspend"
                      : "Close";
            return {
                ...context.dataLowerer.leafValue(
                    `bbl::pal::audio_context_transition(${receiver.cpp}, bbl::pal::AudioContextAction::${action})`,
                    { kind: "promise" },
                ),
                impure: true,
            };
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
        if (
            method === "createMediaStreamDestination" ||
            method === "createMediaStreamSource"
        ) {
            const source = method === "createMediaStreamSource";
            context.expectArgumentCount(call, source ? 1 : 0, source ? 1 : 0);
            context.reachFeature("audio:media-stream", call);
            context.reachFeature("platform:media-stream", call);
            context.reachJsData();
            const owner = pinnedAudioOperand(
                context,
                receiver,
                "audio_stream_context",
            );
            const stream = source
                ? `, ${context.dataLowerer.compileForSink(argumentAt(call, 0), {
                      kind: "handle",
                      handle: "media-stream",
                  })}`
                : "";
            return emitAudioNode(
                context,
                `bbl::pal::audio_create_media_stream_${source ? "source" : "destination"}(${owner}${stream})`,
            );
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
        return emitAudioNode(
            context,
            `bbl::pal::${factory.factory}(${receiver.cpp})`,
        );
    }

    if (receiver.kind === "audio-buffer" && method === "getChannelData") {
        if (call.arguments.length !== 1) {
            context.fail(
                call,
                "getChannelData expects exactly one channel index.",
            );
        }
        return {
            kind: "data",
            cpp:
                `bbl::pal::audio_buffer_channel(${receiver.cpp}, ` +
                `static_cast<std::uint32_t>(${context.compileNumber(argumentAt(call, 0))}))`,
            dataType: { kind: "f32array" },
        };
    }

    if (
        receiver.kind === "audio-buffer" &&
        (method === "copyFromChannel" || method === "copyToChannel")
    ) {
        context.expectArgumentCount(call, 2, 3);
        context.reachFeature("audio:buffer-source", call);
        const buffer = context.allocateTemporaryCppName("audio_copy_buffer");
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: buffer,
            initializer: receiver.cpp,
        });
        const samples = context.compileValue(argumentAt(call, 0));
        if (samples.dataType?.kind !== "f32array")
            context.fail(
                argumentAt(call, 0),
                `${method} requires a Float32Array.`,
            );
        const input = context.allocateTemporaryCppName("audio_copy_samples");
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: input,
            initializer: samples.cpp,
        });
        const index = (argument: ts.Expression): string => {
            const cpp = context.compileNumber(argument, "double");
            const name = context.allocateTemporaryCppName("audio_copy_index");
            context.emit({
                kind: "declaration",
                type: "const auto",
                name: name,
                initializer: `bbl::js::to_uint32(${cpp})`,
            });
            return name;
        };
        const channel = index(argumentAt(call, 1));
        const offset = call.arguments[2] ? index(call.arguments[2]) : "0u";
        const direction =
            method === "copyToChannel" ? "ToChannel" : "FromChannel";
        return {
            kind: "void",
            cpp: `bbl::pal::audio_buffer_copy(${buffer}, ${input}, ${channel}, ${offset}, bbl::pal::AudioBufferCopy::${direction})`,
        };
    }

    if (receiver.kind === "audio-node") {
        switch (method) {
            case "addEventListener":
            case "removeEventListener": {
                // An observed source retains its completion until a listener removal releases it.
                const lowered = compileAudioListener(
                    context,
                    call,
                    callee,
                    receiver,
                    (type) => (type === "ended" ? "" : undefined),
                    {
                        type: "Only scheduled audio source ended listeners are represented.",
                        payload:
                            "Audio ended event payloads are not represented yet.",
                        signal: "Audio ended listeners with an AbortSignal are not lowered.",
                    },
                );
                return {
                    kind: "void",
                    cpp: lowered.absent
                        ? ""
                        : `bbl::pal::audio_${lowered.removing ? "remove" : "add"}_ended_listener(${lowered.target}, ${lowered.identity}, ${lowered.rest})`,
                };
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
                if (call.arguments.length === 0)
                    return {
                        kind: "void",
                        cpp: `bbl::pal::audio_disconnect(${receiver.cpp})`,
                    };
                // `disconnect(destination[, output[, input]])`: the
                // operands in order, then the edge.
                context.expectArgumentCount(call, 1, 3);
                const node = pinnedAudioOperand(
                    context,
                    receiver,
                    "audio_disconnect_source",
                );
                const destination = context.compileValue(argumentAt(call, 0));
                if (destination.kind !== "audio-node")
                    context.fail(
                        argumentAt(call, 0),
                        destination.kind === "audio-param"
                            ? "disconnect(AudioParam) is not lowered; disconnect a node destination."
                            : "disconnect expects an audio node destination.",
                    );
                const target = pinnedAudioOperand(
                    context,
                    destination,
                    "audio_disconnect_destination",
                );
                const indices = call.arguments
                    .slice(1)
                    .map((argument) =>
                        numberOperand(
                            context,
                            argument,
                            "audio_disconnect_index",
                        ),
                    );
                return {
                    kind: "void",
                    cpp: `bbl::pal::audio_disconnect(${[node, target, ...indices].join(", ")})`,
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
                    cpp: webAudioMemberCall("AudioNode", method)(receiver.cpp, [
                        when,
                        ...trailing,
                    ]),
                };
            }
            default:
                return undefined;
        }
    }

    if (receiver.kind === "audio-param") {
        const schedule = PARAM_SCHEDULES.get(method);
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
        if (method === "setValueCurveAtTime") {
            context.expectArgumentCount(call, 3, 3);
            const param = pinnedAudioOperand(
                context,
                receiver,
                "audio_curve_param",
            );
            const values = context.compileValue(argumentAt(call, 0));
            if (values.dataType?.kind !== "f32array")
                context.fail(
                    argumentAt(call, 0),
                    "setValueCurveAtTime requires a Float32Array.",
                );
            const curve = pinnedAudioOperand(
                context,
                values,
                "audio_curve_values",
            );
            const start = numberOperand(
                context,
                argumentAt(call, 1),
                "audio_curve_start",
            );
            const duration = numberOperand(
                context,
                argumentAt(call, 2),
                "audio_curve_duration",
            );
            return {
                kind: "void",
                cpp: webAudioMemberCall("AudioParam", method)(param, [
                    curve,
                    start,
                    duration,
                ]),
            };
        }
        if (method === "cancelScheduledValues") {
            const time =
                call.arguments.length > 0
                    ? context.compileNumber(argumentAt(call, 0), "double")
                    : "0.0";
            return {
                kind: "void",
                cpp: webAudioMemberCall("AudioParam", method)(receiver.cpp, [
                    time,
                ]),
            };
        }
        return undefined;
    }

    return undefined;
}

// -- writes --------------------------------------------------------------

/** The Web Audio interface a lowered value's kind stands for. */
const AUDIO_INTERFACES: Readonly<Record<string, string>> = {
    "audio-buffer": "AudioBuffer",
    "audio-context": "AudioContext",
    "audio-node": "AudioNode",
    "audio-param": "AudioParam",
};

/** A written value, compiled to the native type a member table names. */
function compileAudioScalar(
    context: AudioWriteContext,
    shape: "boolean" | "number" | "string",
    right: ts.Expression,
): string {
    if (shape === "boolean") return context.compileBoolean(right);
    if (shape === "number") return context.compileNumber(right, "double");
    return context.dataLowerer.compileKnownValueForSink(
        context.compileValue(right),
        { kind: "string" },
        right,
    );
}

/** A Web Audio property write this surface does not lower, refused by name. */
function refuseAudioWrite(
    context: AudioWriteContext,
    left: ts.PropertyAccessExpression,
    owner: Value,
): never {
    return context.fail(
        left,
        `${AUDIO_INTERFACES[owner.kind] ?? "Web Audio"}.${left.name.text} is not lowered; writing it would be dropped.`,
    );
}

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
    context.reachFeature("audio:engine", expression);

    if (owner.kind === "audio-param" && property === "value") {
        context.emit({
            kind: "expression",
            code:
                `bbl::pal::audio_param_set_value(${owner.cpp}, ` +
                `${context.compileNumber(right, "float")});`,
        });
        return true;
    }

    if (owner.kind === "audio-element") {
        context.reachFeature("audio:media-element", expression);
        const element = context.bindings.pinValueToTemporary(
            owner,
            "audio_element",
            left.expression,
        ).cpp;
        const member = AUDIO_ELEMENT_PROPERTIES.find(
            ([name, , , writable]) => writable && name === property,
        );
        if (!member)
            return context.fail(
                left.name,
                `HTMLAudioElement.${property} writes are not lowered: an Audio element writes ${AUDIO_ELEMENT_PROPERTIES.filter(
                    ([, , , writable]) => writable,
                )
                    .map(([name]) => name)
                    .join(", ")}.`,
            );
        context.emit({
            kind: "expression",
            code: `bbl::pal::audio_element_set_${member[2]}(${element}, ${compileAudioScalar(context, member[1], right)});`,
        });
        return true;
    }

    // Web Audio objects are DOM types, which the browser-erasure gate later
    // in the chain drops: a write this surface does not lower refuses here.
    if (owner.kind !== "audio-node") {
        if (owner.kind === "audio-engine") return false;
        return refuseAudioWrite(context, left, owner);
    }

    if (property === "buffer") {
        const buffer = context.compileValue(right);
        if (buffer.kind !== "audio-buffer") {
            context.fail(
                right,
                "AudioBufferSourceNode.buffer expects an AudioBuffer.",
            );
        }
        context.reachFeature("audio:buffer-source", expression);
        context.emit({
            kind: "expression",
            code: `bbl::pal::audio_set_buffer(${owner.cpp}, ${buffer.cpp});`,
        });
        return true;
    }

    const loopMember = SOURCE_LOOP_MEMBERS.find(([name]) => name === property);
    if (loopMember) {
        context.reachFeature("audio:buffer-source", expression);
        context.emit({
            kind: "expression",
            code: `bbl::pal::audio_set_${loopMember[2]}(${owner.cpp}, ${compileAudioScalar(context, loopMember[1], right)});`,
        });
        return true;
    }

    const pannerProperty = PANNER_PROPERTIES.find(
        ([name]) => name === property,
    );
    if (pannerProperty) {
        context.reachFeature("audio:panner", expression);
        context.emit({
            kind: "expression",
            code:
                `bbl::pal::audio_set_panner_property(${owner.cpp}, ` +
                `bbl::pal::PannerProperty::${pannerProperty[1]}, ` +
                `${context.compileNumber(right, "double")});`,
        });
        return true;
    }

    const pannerModel = PANNER_MODELS.find(([name]) => name === property);
    if (pannerModel) {
        context.reachFeature("audio:panner", expression);
        const model = context.compileValue(right);
        if (!isStringValue(model))
            context.fail(right, `${property} takes a string.`);
        // A model chosen at run time throws there (`audio_set_panner_model`).
        if (model.staticString === "HRTF")
            context.fail(
                right,
                'panningModel "HRTF" is not lowered: it needs an HRTF database, which this build does not package.',
            );
        context.emit({
            kind: "expression",
            code:
                `bbl::pal::audio_set_panner_model(${owner.cpp}, ` +
                `bbl::pal::PannerModel::${pannerModel[1]}, ${model.cpp});`,
        });
        return true;
    }

    if (property === "onended") {
        if (!context.options.workers) throw new ApplicationRealmRequired();
        const selected = { ...owner };
        delete selected.nativeBinding;
        const target = context.bindings.pinValueToTemporary(
            selected,
            "audio_event_target",
            left.expression,
        );
        const callbackType = context.checker.getTypeAtLocation(right);
        const absent =
            (callbackType.flags &
                (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !==
            0;
        if (
            callbackType
                .getCallSignatures()
                .some((signature) => signature.parameters.length > 0)
        )
            context.fail(
                right,
                "Audio ended event payloads are not represented yet.",
            );
        context.callbacks.hoistForwardCallbackBindings(right);
        const callback = absent
            ? "{}"
            : context.callbacks.compilePlatformCallback(right, undefined, [])
                  .cpp;
        context.emit({
            kind: "expression",
            code: `bbl::pal::audio_set_ended_handler(${target.cpp}, ${callback});`,
        });
        return true;
    }
    if (property !== "type") {
        return refuseAudioWrite(context, left, owner);
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
        context.emit({
            kind: "expression",
            code:
                `bbl::pal::audio_set_oscillator_wave(${owner.cpp}, ` +
                `bbl::pal::OscillatorWave::${wave});`,
        });
        return true;
    }
    const filter = FILTER_KINDS[spelling];
    if (filter) {
        context.emit({
            kind: "expression",
            code:
                `bbl::pal::audio_set_filter_kind(${owner.cpp}, ` +
                `bbl::pal::BiquadFilterKind::${filter});`,
        });
        return true;
    }
    context.fail(
        right,
        `'${spelling}' is not a reached oscillator or filter type. A ` +
            "custom periodic wave is not lowered.",
    );
}
