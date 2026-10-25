// Web Audio method calls and writes use native context, node and buffer handles.
import { EmissionSet } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { AUDIO_CODECS, audioCodecForBytes } from "../audio-codecs.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import ts from "typescript";
import { undefinedValue } from "./values/model.js";
import { argumentAt } from "./syntax.js";
import {
    declaredInDomLibrary,
    namedMember,
    resolvedSymbol,
    type NamedMember,
} from "./symbols.js";

import { readProperty, type PropertyContext } from "./properties.js";
import { isStringValue, type Feature, type Value } from "./types.js";
import { domAudioHandleKind } from "./data-types.js";
import {
    declaresListenerSignal,
    listenerAddition,
    listenerOptions,
} from "./dom-listeners.js";
import { pinCpp } from "./evaluation-order.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { packagedUrlAssets, type StaticFetchContext } from "./static-fetch.js";
import { deploymentUrl, packagedResponseUrl } from "./deployment.js";
import {
    webAudioMemberAssign,
    webAudioMemberCall,
} from "../lowering/web-platform-schema.js";
import {
    AUDIO_ELEMENT_EVENTS,
    AUDIO_CONTEXT_TRANSITIONS,
    AUDIO_ELEMENT_PROPERTIES,
    AUDIO_NODE_FACTORIES,
    AUDIO_PARAM_SCHEDULES,
    BIQUAD_FILTER_KINDS,
    OSCILLATOR_WAVES,
    PANNER_MODELS,
    PANNER_PROPERTIES,
    SOURCE_LOOP_MEMBERS,
} from "./web-audio-members.js";
import { presentMembers, callSignatures } from "./type-facts.js";
import { staticTableValue, type TableOption } from "./table-options.js";

/** `oscillator.type` and `filter.type`: the reached Web Audio spellings. */
const audioNodeType: TableOption = {
    table: Object.fromEntries([...OSCILLATOR_WAVES, ...BIQUAD_FILTER_KINDS]),
    refusal: (spelling) =>
        `'${spelling}' is not a reached oscillator or filter type. A custom periodic wave is not lowered.`,
    name: "Web Audio oscillator or filter type",
    label: "node_type",
};

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
            | "evaluationOrder"
            | "cppString"
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
        : AUDIO_NODE_FACTORIES.some(([name]) => name === property.name.text) ||
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
                undefinedValue(),
            ]),
        ),
    };
}

/** What resolving a packaged audio URL needs beyond the static fetch. */
export type PackagedAudioContext = StaticFetchContext &
    Pick<LoweringServices, "emit" | "dataTypes" | "allocateTemporaryCppName">;

/**
 * A URL argument selecting packaged audio a linked decoder reads: each file it
 * may select is packaged and its decoder reached. The candidates are one
 * constant `PackagedFetchEntry` table keyed by the URL a fetch of
 * `spell(url)` requests, resolved at generation; the site registers it with
 * its realm once. Returns the URL, pinned in source order into a `label`
 * temporary, as a C++ `std::string` expression.
 */
export function packagedAudioUrl(
    context: PackagedAudioContext,
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
    const table = context.dataTypes.registerSharedConstantArray(
        "packaged_audio_responses",
        "bbl::pal::PackagedFetchEntry",
        packaged.assets.map(({ logicalSource, output }) => {
            const requested = spell(logicalSource);
            return `bbl::pal::PackagedFetchEntry{${context.cppString(requested)}, ${context.cppString(packagedResponseUrl(context.options, requested))}, ${context.cppString(output)}}`;
        }),
        false,
        site,
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
    const registered = context.allocateTemporaryCppName(
        "packaged_audio_registered",
    );
    context.emit(
        `[[maybe_unused]] static thread_local const bool ${registered} = bbl::pal::register_packaged_responses(${context.cppString(deploymentUrl(context.options).href)}, &bbl::asset_path, ${table});`,
    );
    return `std::string(${url.cpp})`;
}

/** `new Audio([url])`: an element over a packaged source (`pal_audio_element.hpp`). */
function compileAudioElementConstructor(
    context: PackagedAudioContext & Pick<LoweringServices, "audioSessionCpp">,
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
    context: PackagedAudioContext & Pick<LoweringServices, "audioSessionCpp">,
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

/**
 * A call's receiver and arguments in JavaScript's order, for its record's
 * spelling: an operand a later one could change, or see changed, is read
 * into a temporary first (`EvaluationOrder.operandsToPin`). `argument`
 * compiles one argument to the native type the record takes.
 */
function orderedOperands(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: NamedMember,
    receiver: Value,
    argument: (expression: ts.Expression, index: number) => string,
): { owner: string; args: string[] } {
    const pins = context.evaluationOrder.operandsToPin([
        callee.expression,
        ...call.arguments,
    ]);
    const owner = pins[0]
        ? pinCpp(context, receiver.cpp, "audio_receiver")
        : receiver.cpp;
    const args = call.arguments.map((expression, index) => {
        const cpp = argument(expression, index);
        return pins[index + 1] ? pinCpp(context, cpp, "audio_argument") : cpp;
    });
    return { owner, args };
}

export function compileAudioMethodCall(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: NamedMember,
): Value | undefined {
    if (callee.access.questionDotToken) {
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
        namedMember(
            context.checker,
            context.unwrap(receiverExpression.expression),
        )?.name === "connect"
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

/**
 * `add/removeEventListener(type, listener[, options])` on an audio target,
 * whose native registry is a `PlatformEventListeners`: the target and the
 * listener's identity pinned in source order. `event` spells a represented
 * type's native argument (with its trailing comma), or refuses it. `native`
 * spells the registry call from the listener (when adding) and the options;
 * an addition takes a `signal` lease (`listenerAddition`).
 */
function compileAudioListener(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: NamedMember,
    receiver: Value,
    event: (type: string) => string | undefined,
    refusals: { type: string; payload: string },
    native: (
        removing: boolean,
        target: string,
        event: string,
        identity: string,
        rest: string,
    ) => string,
): Value {
    context.expectArgumentCount(call, 2, 3);
    if (!context.options.workers) throw new ApplicationRealmRequired();
    const selected = { ...receiver };
    delete selected.nativeBinding;
    const target = context.bindings.pinValueToTemporary(
        selected,
        "audio_event_target",
        callee.expression,
    );
    const type = event(context.compileStringLiteral(argumentAt(call, 0)));
    if (type === undefined) return context.fail(call, refusals.type);
    const callback = argumentAt(call, 1);
    context.callbacks.hoistForwardCallbackBindings(callback);
    const removing = callee.name === "removeEventListener";
    const callbackType = context.checker.getTypeAtLocation(callback);
    const absent = presentMembers(callbackType).length === 0;
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
                callSignatures(context.checker, callbackType, "exact").some(
                    (signature) => signature.parameters.length > 0,
                )
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
    // A `signal` evaluates after the listener it may remove.
    if (
        !absent &&
        !removing &&
        declaresListenerSignal(context.checker, call.arguments[2])
    )
        listener = pinCpp(context, listener, "event_listener");
    const options = listenerOptions(context, call.arguments[2], removing);
    if (absent) return { kind: "void", cpp: "" };
    if (removing)
        return {
            kind: "void",
            cpp: native(true, target.cpp, type, identity, options.capture),
        };
    return {
        kind: "void",
        cpp: listenerAddition(options.signal, (lease) =>
            native(
                false,
                target.cpp,
                type,
                identity,
                `${listener}, ${options.capture}, ${options.once}${lease}`,
            ),
        ),
    };
}

/** `play`, `pause`, `load`, `removeAttribute("src")` and listeners on an `HTMLAudioElement`. */
function compileAudioElementMethod(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: NamedMember,
    receiver: Value,
): Value | undefined {
    const method = callee.name;
    context.reachFeature("audio:media-element", call);
    if (method === "addEventListener" || method === "removeEventListener")
        return compileAudioListener(
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
            },
            (removing, target, event, identity, rest) =>
                `bbl::pal::audio_element_${removing ? "remove" : "add"}_listener(${target}, ${event}${identity}, ${rest})`,
        );
    if (method === "removeAttribute") {
        context.expectArgumentCount(call, 1, 1);
        if (context.compileStringLiteral(argumentAt(call, 0)) !== "src")
            context.fail(
                call,
                'Only removeAttribute("src") is represented on an Audio element.',
            );
        return {
            kind: "void",
            cpp: webAudioMemberCall("HTMLAudioElement", method)(receiver.cpp, [
                context.cppString("src"),
            ]),
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
    callee: NamedMember,
    receiver: Value,
): Value | undefined {
    const method = callee.name;
    // Stored and deferred-produced handles can reach operations without
    // a context constructor in this translation unit.
    context.reachFeature("audio:engine", call);
    if (
        receiver.kind === "audio-context" &&
        method === "decodeAudioData" &&
        call.arguments.length === 1
    ) {
        const decoded = compileAudioDecode(context, call, receiver);
        if (decoded) return decoded;
    }
    refuseAudioName(context, REFUSED_METHODS, method, call, "Web Audio");

    if (receiver.kind === "audio-element")
        return compileAudioElementMethod(context, call, callee, receiver);
    if (receiver.kind === "audio-context")
        return compileAudioContextMethod(context, call, callee, receiver);

    const number = (expression: ts.Expression): string =>
        context.compileNumber(expression, "double");
    /** A typed-array operand the record's call takes. */
    const samples = (expression: ts.Expression, message: string): string => {
        const value = context.compileValue(expression);
        if (value.dataType?.kind !== "f32array")
            context.fail(expression, message);
        return value.cpp;
    };

    if (receiver.kind === "audio-buffer") {
        if (method === "getChannelData") {
            if (call.arguments.length !== 1)
                context.fail(
                    call,
                    "getChannelData expects exactly one channel index.",
                );
            const { owner, args } = orderedOperands(
                context,
                call,
                callee,
                receiver,
                number,
            );
            return {
                kind: "data",
                cpp: webAudioMemberCall("AudioBuffer", method)(owner, args),
                dataType: { kind: "f32array" },
            };
        }
        if (method === "copyFromChannel" || method === "copyToChannel") {
            context.expectArgumentCount(call, 2, 3);
            context.reachFeature("audio:buffer-source", call);
            const { owner, args } = orderedOperands(
                context,
                call,
                callee,
                receiver,
                (expression, index) =>
                    index === 0
                        ? samples(
                              expression,
                              `${method} requires a Float32Array.`,
                          )
                        : number(expression),
            );
            return {
                kind: "void",
                cpp: webAudioMemberCall("AudioBuffer", method)(owner, args),
            };
        }
        return undefined;
    }

    if (receiver.kind === "audio-node") {
        switch (method) {
            case "addEventListener":
            case "removeEventListener":
                // An observed source retains its completion until a listener removal releases it.
                return compileAudioListener(
                    context,
                    call,
                    callee,
                    receiver,
                    (type) => (type === "ended" ? "" : undefined),
                    {
                        type: "Only scheduled audio source ended listeners are represented.",
                        payload:
                            "Audio ended event payloads are not represented yet.",
                    },
                    (removing, target, _event, identity, rest) =>
                        `bbl::pal::audio_${removing ? "remove" : "add"}_ended_listener(${target}, ${identity}, ${rest})`,
                );
            case "connect": {
                if (call.arguments.length !== 1)
                    context.fail(
                        call,
                        "connect(destination) is the reached form.",
                    );
                let destination: Value | undefined;
                const { owner, args } = orderedOperands(
                    context,
                    call,
                    callee,
                    receiver,
                    (expression) => {
                        destination = context.compileValue(expression);
                        if (
                            destination.kind !== "audio-node" &&
                            destination.kind !== "audio-param"
                        )
                            context.fail(
                                expression,
                                "connect expects an audio node or AudioParam.",
                            );
                        return destination.cpp;
                    },
                );
                const cpp = webAudioMemberCall("AudioNode", method)(
                    owner,
                    args,
                );
                // `connect(param)` returns undefined; `connect(node)` the node.
                return destination!.kind === "audio-param"
                    ? { kind: "void", cpp }
                    : { ...destination!, cpp, impure: true };
            }
            case "disconnect": {
                // `disconnect(destination[, output[, input]])`: the
                // operands in order, then the edge.
                context.expectArgumentCount(call, 0, 3);
                const { owner, args } = orderedOperands(
                    context,
                    call,
                    callee,
                    receiver,
                    (expression, index) => {
                        if (index > 0) return number(expression);
                        const destination = context.compileValue(expression);
                        if (destination.kind !== "audio-node")
                            context.fail(
                                expression,
                                destination.kind === "audio-param"
                                    ? "disconnect(AudioParam) is not lowered; disconnect a node destination."
                                    : "disconnect expects an audio node destination.",
                            );
                        return destination.cpp;
                    },
                );
                return {
                    kind: "void",
                    cpp: webAudioMemberCall("AudioNode", method)(owner, args),
                };
            }
            case "start":
            case "stop": {
                // The spec's own default: `start()` is `start(0)`, which
                // the engine reads as "now".
                const maximum = method === "start" ? 3 : 1;
                if (call.arguments.length > maximum)
                    context.fail(
                        call,
                        `${method} expects at most ${maximum} arguments.`,
                    );
                const { owner, args } = orderedOperands(
                    context,
                    call,
                    callee,
                    receiver,
                    number,
                );
                return {
                    kind: "void",
                    cpp: webAudioMemberCall("AudioNode", method)(owner, args),
                };
            }
            default:
                return undefined;
        }
    }

    if (receiver.kind === "audio-param") {
        const schedule = AUDIO_PARAM_SCHEDULES.some(
            ([name]) => name === method,
        );
        if (schedule && call.arguments.length !== 2)
            context.fail(call, `${method}(value, time) is the reached form.`);
        if (method === "setValueCurveAtTime")
            context.expectArgumentCount(call, 3, 3);
        if (method === "cancelScheduledValues")
            context.expectArgumentCount(call, 0, 1);
        if (
            !schedule &&
            method !== "setValueCurveAtTime" &&
            method !== "cancelScheduledValues"
        )
            return undefined;
        const { owner, args } = orderedOperands(
            context,
            call,
            callee,
            receiver,
            (expression, index) =>
                method === "setValueCurveAtTime" && index === 0
                    ? samples(
                          expression,
                          "setValueCurveAtTime requires a Float32Array.",
                      )
                    : number(expression),
        );
        return {
            kind: "void",
            cpp: webAudioMemberCall("AudioParam", method)(owner, args),
        };
    }

    return undefined;
}

/**
 * `context.decodeAudioData(encoded)` over an ArrayBuffer: the decoders its
 * fetched sources need (all of them for bytes generation cannot trace), then
 * the record's asynchronous decode, or, in a program with no realm to settle
 * a promise on, a decode in place.
 */
function compileAudioDecode(
    context: AudioCallContext,
    call: ts.CallExpression,
    receiver: Value,
): Value | undefined {
    const encoded = context.compileValue(argumentAt(call, 0));
    if (encoded.kind !== "data" || encoded.dataType?.kind !== "arraybuffer")
        return undefined;
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
                      readAssetBytesSync(source, context.options.fileName),
                  );
                  return codec ? [codec] : [];
              }),
          )
        : AUDIO_CODECS;
    for (const codec of codecs)
        context.reachFeature(`audio:decode-${codec}`, call);
    if (context.options.workers)
        return context.dataLowerer.leafValue(
            webAudioMemberCall("AudioContext", "decodeAudioData")(
                receiver.cpp,
                [encoded.cpp],
            ),
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

/** An AudioContext's factories, buffers, media sources and transitions, over its record. */
function compileAudioContextMethod(
    context: AudioCallContext,
    call: ts.CallExpression,
    callee: NamedMember,
    receiver: Value,
): Value | undefined {
    const method = callee.name;
    const spell = webAudioMemberCall;
    const factory = AUDIO_NODE_FACTORIES.find(([name]) => name === method);
    if (factory) {
        if (call.arguments.length !== 0)
            context.fail(
                call,
                `${method} takes no arguments in the reached slice.`,
            );
        if (factory[2]) context.reachFeature(factory[2], call);
        return emitAudioNode(
            context,
            spell("AudioContext", method)(receiver.cpp, []),
        );
    }
    if (AUDIO_CONTEXT_TRANSITIONS.some(([name]) => name === method)) {
        if (call.arguments.length)
            context.fail(call, `AudioContext.${method} takes no arguments.`);
        if (!context.options.workers) throw new ApplicationRealmRequired();
        return {
            ...context.dataLowerer.leafValue(
                spell("AudioContext", method)(receiver.cpp, []),
                { kind: "promise" },
            ),
            impure: true,
        };
    }
    if (method === "createBuffer") {
        if (call.arguments.length !== 3)
            context.fail(
                call,
                "createBuffer expects channel count, frame count, and sample rate.",
            );
        context.reachFeature("audio:buffer-source", call);
        const { owner, args } = orderedOperands(
            context,
            call,
            callee,
            receiver,
            (expression) => context.compileNumber(expression, "double"),
        );
        return {
            kind: "audio-buffer",
            cpp: spell("AudioContext", method)(owner, args),
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
        const { owner, args } = orderedOperands(
            context,
            call,
            callee,
            receiver,
            (expression) =>
                context.dataLowerer.compileForSink(expression, {
                    kind: "handle",
                    handle: "media-stream",
                }),
        );
        return emitAudioNode(
            context,
            spell("AudioContext", method)(owner, args),
        );
    }
    if (method === "createMediaElementSource") {
        context.expectArgumentCount(call, 1, 1);
        const { owner, args } = orderedOperands(
            context,
            call,
            callee,
            receiver,
            (expression) => {
                const element = context.compileValue(expression);
                if (element.kind !== "audio-element")
                    context.fail(
                        expression,
                        "createMediaElementSource takes an Audio element.",
                    );
                return element.cpp;
            },
        );
        context.reachFeature("audio:media-element", call);
        return emitAudioNode(
            context,
            spell("AudioContext", method)(owner, args),
        );
    }
    return undefined;
}

// -- writes --------------------------------------------------------------

/** The Web Audio interface, and record, a lowered value's kind stands for. */
const AUDIO_INTERFACES: Readonly<Record<string, string>> = {
    "audio-buffer": "AudioBuffer",
    "audio-context": "AudioContext",
    "audio-node": "AudioNode",
    "audio-param": "AudioParam",
    "audio-element": "HTMLAudioElement",
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
 * The written value of an application property write the records spell,
 * with the feature it reaches; undefined for a member they do not write.
 */
function audioWriteValue(
    context: AudioWriteContext,
    owner: Value,
    left: ts.PropertyAccessExpression,
    right: ts.Expression,
): { feature?: Feature; value: () => string } | undefined {
    const property = left.name.text;
    if (owner.kind === "audio-param")
        return property === "value"
            ? { value: () => context.compileNumber(right, "double") }
            : undefined;
    if (owner.kind === "audio-element") {
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
        return {
            feature: "audio:media-element",
            value: () => compileAudioScalar(context, member[1], right),
        };
    }
    if (owner.kind !== "audio-node") return undefined;
    if (property === "buffer")
        return {
            feature: "audio:buffer-source",
            value: () => {
                const buffer = context.compileValue(right);
                if (buffer.kind !== "audio-buffer")
                    context.fail(
                        right,
                        "AudioBufferSourceNode.buffer expects an AudioBuffer.",
                    );
                return buffer.cpp;
            },
        };
    const loop = SOURCE_LOOP_MEMBERS.find(([name]) => name === property);
    if (loop)
        return {
            feature: "audio:buffer-source",
            value: () => compileAudioScalar(context, loop[1], right),
        };
    if (PANNER_PROPERTIES.some(([name]) => name === property))
        return {
            feature: "audio:panner",
            value: () => context.compileNumber(right, "double"),
        };
    if (PANNER_MODELS.some(([name]) => name === property))
        return {
            feature: "audio:panner",
            value: () => {
                const model = context.compileValue(right);
                if (!isStringValue(model))
                    context.fail(right, `${property} takes a string.`);
                // A model chosen at run time throws there (`audio_set_panner_model`).
                if (model.staticString === "HRTF")
                    context.fail(
                        right,
                        'panningModel "HRTF" is not lowered: it needs an HRTF database, which this build does not package.',
                    );
                return model.cpp;
            },
        };
    if (property === "type")
        return {
            // The composed set of types is closed at generation.
            value: () =>
                context.cppString(
                    staticTableValue(
                        context,
                        audioNodeType,
                        context.compileValue(right),
                        right,
                    ),
                ),
        };
    return undefined;
}

/**
 * Emits a reached Web Audio property write, in the shape every other hook
 * on the assignment chain takes: it either handles the assignment and
 * says so, or leaves it alone. The write is its record's spelling, its
 * owner read before its value as JavaScript reads them.
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
    if (owner.kind === "audio-engine") return false;
    const record = AUDIO_INTERFACES[owner.kind];

    if (owner.kind === "audio-node" && property === "onended") {
        if (!context.options.workers) throw new ApplicationRealmRequired();
        const selected = { ...owner };
        delete selected.nativeBinding;
        const target = context.bindings.pinValueToTemporary(
            selected,
            "audio_event_target",
            left.expression,
        );
        const callbackType = context.checker.getTypeAtLocation(right);
        const absent = presentMembers(callbackType).length === 0;
        if (
            callSignatures(context.checker, callbackType, "exact").some(
                (signature) => signature.parameters.length > 0,
            )
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
            code: `${webAudioMemberAssign("AudioNode", property)(target.cpp, callback)};`,
        });
        return true;
    }

    // Web Audio objects are DOM types, which the browser-erasure gate later
    // in the chain drops: a write this surface does not lower refuses here.
    const write = audioWriteValue(context, owner, left, right);
    if (!write || !record) return refuseAudioWrite(context, left, owner);
    if (write.feature) context.reachFeature(write.feature, expression);
    const [pinOwner] = context.evaluationOrder.operandsToPin([
        left.expression,
        right,
    ]);
    const target = pinOwner
        ? context.bindings.pinValueToTemporary(
              owner,
              "audio_owner",
              left.expression,
          ).cpp
        : owner.cpp;
    context.emit({
        kind: "expression",
        code: `${webAudioMemberAssign(record, property)(target, write.value())};`,
    });
    return true;
}
