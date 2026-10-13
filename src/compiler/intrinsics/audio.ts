import type { LoweringServices } from "../lowering-services.js";
// Babylon's engine/source lifecycle retains the Web Audio context, output
// routing, and sound ownership. The volume-only output graph is checked by
// audio-lowerer; source disposal is lowered from the pinned declarations.
// Unreached sound, bus, and spatial behavior remains an explicit refusal.
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import {
    optionalPresentCpp,
    optionalValueCpp,
    presenceCpp,
    type Value,
} from "../types.js";
import type { DataType } from "../data-types.js";
import type { IntrinsicCallContext } from "./context.js";
import { packagedAudioUrl, refuseAudioName } from "../audio-surface.js";
import { EmissionWeakMap } from "../emission-transaction.js";
import {
    nativeStatementCode,
    type NativeStatement,
} from "../native-statements.js";
import { lowerAudioSourceDisposal } from "../../lowering/audio-source-lowerer.js";
import { isNullable } from "../type-facts.js";
import {
    emitPresentOption,
    emitScalarOption,
    retainedOptions,
} from "./retained-options.js";
import type { StaticFetchContext } from "../static-fetch.js";
import { AUDIO_CODECS } from "../../audio-codecs.js";
import { cppIdentifier, snakeCase } from "../../cpp-literals.js";
import { mediaStreamValue } from "../media-streams.js";

export interface AudioIntrinsicContext
    extends
        IntrinsicCallContext,
        StaticFetchContext,
        Pick<
            LoweringServices,
            | "fail"
            | "allocateTemporaryCppName"
            | "emit"
            | "registerNativeBinding"
            | "registerNativeTemporary"
            | "audioSessionCpp"
            | "expectObjectLiteral"
            | "nativeEmission"
            | "options"
            | "bindings"
            | "deferredCapabilities"
            | "checker"
            | "cppString"
            | "dataTypes"
            | "emitDiscardedValue"
            | "compileNumber"
            | "compileVec3"
            | "vec3FromRecord"
        > {}

const sourceDisposers = new EmissionWeakMap<object, string>();
function sourceDisposer(context: AudioIntrinsicContext): string {
    const existing = sourceDisposers.get(context);
    if (existing) return existing;
    const name = context.allocateTemporaryCppName("dispose_audio_source");
    for (const lowered of lowerAudioSourceDisposal(name))
        context.nativeEmission.registerNativeFunction(
            lowered.prototype,
            lowered.lines,
        );
    const cpp = `bblscene::${name}`;
    sourceDisposers.set(context, cpp);
    return cpp;
}

/**
 * The Lite audio functions that are not lowered: sound buffers, streaming
 * sounds, buses, stereo, the analyzer, the unmute UI, the visualizer and
 * the media-stream tap refuse by name, because a silent no-op would be a
 * scene that renders without sounding. Static sounds and their spatial
 * audio (`compileStaticSound`) run the pin's lowered family.
 */
const REFUSED_BY_NAME: Readonly<Record<string, string>> = {
    createSoundBufferAsync:
        "decoding an audio file is an asset question, and no audio asset " +
        "is materialized at generation yet",
    createStreamingSoundAsync:
        "streaming sounds wrap an HTMLAudioElement, which a native build " +
        "has no equivalent for.",
    createAudioBusAsync:
        "buses are Babylon routing behaviour and are not lowered",
    enableStereo: "stereo panning is not lowered",
    enableAnalyzer: "the analyzer is not lowered",
    createMicrophoneSoundSourceAsync:
        "microphone capture needs a device-permission contract this " +
        "runtime does not have",
    createUnmuteUI: "the unmute UI is a DOM button",
    createAudioVisualizer: "the visualizer draws through canvas2D",
    setMasterVolume:
        "the pin has no un-ramped form of it. `setMainOutVolume` goes " +
        'through `setRampTarget`, whose shape defaults to `"linear"` and ' +
        "whose duration defaults to the engine's `_rampDuration` (0.01 s) " +
        "-- above `MinRampDuration`, so even a call with no options " +
        "schedules `cancelScheduledValues(0)` then a two-point " +
        "`setValueCurveAtTime`. Emitting an instantaneous write would be " +
        "a substituted behaviour wearing a subset's clothes. Lowering " +
        "`audio-param.ts`'s curve component is what this needs",
    getMasterVolume:
        "the master volume is state the generated engine record does not " +
        "hold yet; it arrives with the lowered `bus.ts`",
};

/** The data type of a lowered `createAudioEngineAsync` result. */
const audioEngineType: DataType = { kind: "handle", handle: "audio-engine" };

/**
 * The pin's own output graph, from `bus.ts`, on the context `ctx` names:
 *   createMainOut  -- a GainNode connected to ctx.destination
 *   createMainBus  -- a GainNode connected to mainOut._gain
 * A sound source connects into `mainBus._in`, which is that second gain.
 * Two nodes, and the shape is the contract. The nodes are the locals
 * `<engine>_main_out` and `<engine>_main_bus`.
 */
function mainOutputGraph(engine: string, ctx: string): NativeStatement[] {
    return [
        {
            kind: "declaration",
            type: "const bbl::pal::AudioNodeHandle",
            name: `${engine}_main_out`,
            initializer: `bbl::pal::audio_create_gain(${ctx})`,
        },
        {
            kind: "expression",
            code: `bbl::pal::audio_connect(${engine}_main_out, bbl::pal::audio_destination(${ctx}));`,
        },
        {
            kind: "declaration",
            type: "bbl::pal::AudioNodeHandle",
            name: `${engine}_main_bus`,
            initializer: `bbl::pal::audio_create_gain(${ctx})`,
        },
        {
            kind: "expression",
            code: `bbl::pal::audio_connect(${engine}_main_bus, ${engine}_main_out);`,
        },
    ];
}

/**
 * `AudioEngineOptions` members the native engine does not honour, each
 * refused by name; `audioContext` is adopted (`engineOptions`).
 */
const ENGINE_OPTION_REFUSALS: Readonly<Record<string, string>> = {
    volume:
        "the master volume is applied through `setMainOutVolume`'s ramp, " +
        "and the pinned `audio-param.ts` ramp is not lowered",
    parameterRampDuration:
        "no lowered parameter ramp reads the engine's ramp duration",
    resumeOnInteraction:
        "the native engine installs no document click resume hook",
    resumeOnPause: "the native engine installs no statechange resume timer",
    resumeOnPauseRetryInterval:
        "the native engine installs no statechange resume timer",
};

/** What `createAudioEngineAsync`'s options decide. */
interface EngineOptions {
    /** `options.audioContext`, selected where `present` holds. */
    adopted?: { cpp: string; present?: string };
    /** A `const char*` naming a present refused member, null otherwise. */
    refusal?: string;
}

/**
 * The context `createAudioEngineAsync` builds its graph on is
 * `options.audioContext ?? new AudioContext()` (audio-engine.ts). A present
 * refused member fails generation, or refuses at run time where its
 * presence is a run-time fact.
 */
function engineOptions(
    context: AudioIntrinsicContext,
    call: ts.CallExpression,
): EngineOptions {
    const argument = call.arguments[0];
    if (!argument) return {};
    const value = context.compileValue(argument);
    if (value.kind === "json-null" || value.dataType?.kind === "undefined") {
        context.emitDiscardedValue(value);
        return {};
    }
    const nullable = isNullable(context.checker.getTypeAtLocation(argument));
    const owner = context.bindings.pinValueToTemporary(
        value,
        "audio_engine_options",
        argument,
    );
    const ownerPresent = nullable ? presenceCpp(owner) : undefined;
    if (nullable && !ownerPresent)
        context.fail(
            argument,
            "createAudioEngineAsync options that may be absent need represented presence.",
        );
    const when = (...tests: (string | undefined)[]): string | undefined => {
        const present = tests.filter((test) => test !== undefined);
        return present.length ? present.join(" && ") : undefined;
    };
    const options: EngineOptions = {};
    const refusals: string[] = [];
    for (const member of retainedOptions(context, owner, argument)) {
        // `{ audioContext: undefined }` is the absent option.
        if (
            member.value?.kind === "json-null" ||
            member.type?.kind === "undefined"
        )
            continue;
        const type = member.type;
        const optional = type?.kind === "optional";
        const present = when(
            ownerPresent,
            member.present ??
                (optional ? optionalPresentCpp(member.cpp) : undefined),
        );
        const reason = ENGINE_OPTION_REFUSALS[member.name];
        if (reason) {
            const message = `createAudioEngineAsync options are not lowered: '${member.name}' (${reason}).`;
            if (!present) context.fail(argument, message);
            refusals.push(`(${present}) ? ${context.cppString(message)} : `);
            continue;
        }
        const handle = type?.kind === "optional" ? type.inner : type;
        if (
            member.name !== "audioContext" ||
            handle?.kind !== "handle" ||
            handle.handle !== "audio-context"
        )
            context.fail(
                argument,
                `createAudioEngineAsync option '${member.name}' is not an AudioContext the engine adopts.`,
            );
        options.adopted = {
            cpp: optional ? optionalValueCpp(member.cpp) : member.cpp,
            ...(present ? { present } : {}),
        };
    }
    if (refusals.length)
        options.refusal = `(${refusals.join("")}static_cast<const char*>(nullptr))`;
    return options;
}

function requireAbsentOptions(
    context: AudioIntrinsicContext,
    argument: ts.Expression | undefined,
    name: string,
): void {
    if (!argument) return;
    const value = ts.isIdentifier(argument)
        ? context.compileValue(argument)
        : undefined;
    if (value?.kind === "json-null") return;
    const present = value && presenceCpp(value);
    if (present && isNullable(context.checker.getTypeAtLocation(argument))) {
        context.emit(
            `if (${present}) throw std::runtime_error("${name} options are not lowered");`,
        );
        return;
    }
    context.fail(
        argument,
        `${name} options are not lowered; the reached calls pass none.`,
    );
}

// -- static sounds -------------------------------------------------------

/** The static-sound handle a sound function receives. */
const staticSoundType: DataType = { kind: "handle", handle: "static-sound" };

/** The value kind each option member of a sound function's options takes. */
type OptionKinds = Readonly<Record<string, "number" | "boolean" | "string">>;

const PLAY_OPTIONS: OptionKinds = {
    duration: "number",
    loop: "boolean",
    loopEnd: "number",
    loopStart: "number",
    pitch: "number",
    playbackRate: "number",
    startOffset: "number",
    volume: "number",
    waitTime: "number",
};

const SOUND_OPTIONS: OptionKinds = {
    autoplay: "boolean",
    duration: "number",
    loop: "boolean",
    loopEnd: "number",
    loopStart: "number",
    maxInstances: "number",
    pitch: "number",
    playbackRate: "number",
    startOffset: "number",
    volume: "number",
    skipCodecCheck: "boolean",
};

/** Options members that refuse, with the reason. */
const SOUND_OPTION_REFUSALS: Readonly<Record<string, string>> = {
    outBus: "audio buses are not lowered, so no bus can be passed",
};

/** `enableSpatial`'s scalar options: the panner's attributes and models. */
const SPATIAL_OPTIONS: OptionKinds = {
    coneInnerAngle: "number",
    coneOuterAngle: "number",
    coneOuterVolume: "number",
    distanceModel: "string",
    maxDistance: "number",
    minDistance: "number",
    panningEnabled: "boolean",
    panningModel: "string",
    rolloffFactor: "number",
};

const SPATIAL_OPTION_REFUSALS: Readonly<Record<string, string>> = {
    position: "place the sound with setSpatialPosition",
    orientation: "orientation is not lowered",
    rotationQuaternion: "orientation is not lowered",
    attachedTo: "attaching a sound to a world transform is not lowered",
    attachmentType: "attaching a sound to a world transform is not lowered",
};

/**
 * A sound function's options record as the library's value struct, each
 * present member written in source order; an absent argument is the
 * struct's defaults. Returns the struct's native name.
 */
function soundOptions(
    context: AudioIntrinsicContext,
    argument: ts.Expression | undefined,
    cppType: string,
    kinds: OptionKinds,
    refused?: string,
    refusals: Readonly<Record<string, string>> = SOUND_OPTION_REFUSALS,
    label = "Static sound",
): string {
    const target = context.allocateTemporaryCppName("sound_options");
    context.emit({
        kind: "declaration",
        type: cppType,
        name: target,
        initializer: "{}",
    });
    if (!argument) return target;
    const value = context.compileValue(argument);
    if (value.kind === "json-null" || value.dataType?.kind === "undefined") {
        context.emitDiscardedValue(value);
        return target;
    }
    const owner = context.bindings.pinValueToTemporary(
        value,
        "sound_options_owner",
        argument,
    );
    const nullable = isNullable(context.checker.getTypeAtLocation(argument));
    const present = nullable ? presenceCpp(owner) : undefined;
    if (nullable && !present)
        context.fail(
            argument,
            "Sound options that may be absent need represented presence.",
        );
    if (present) context.emit({ kind: "open", code: `if (${present}) {` });
    for (const member of retainedOptions(context, owner, argument)) {
        if (
            member.value?.kind === "json-null" ||
            member.type?.kind === "undefined"
        )
            continue;
        const refusal = refusals[member.name];
        if (refusal) {
            // Present at generation, it fails there; a typed record's
            // member present at run time rejects the call (`refused`).
            const message = `${label} option '${member.name}' is not lowered: ${refusal}.`;
            const memberPresent =
                member.present ??
                (member.type?.kind === "optional"
                    ? optionalPresentCpp(member.cpp)
                    : undefined);
            if (!memberPresent || !refused) context.fail(argument, message);
            context.emit(
                `if (${memberPresent}) ${refused} = ${context.cppString(message)};`,
            );
            continue;
        }
        const kind = kinds[member.name];
        if (!kind)
            context.fail(
                argument,
                `'${member.name}' is not a ${label.toLowerCase()} option.`,
            );
        emitPresentOption(context, member, (selected) =>
            emitScalarOption(
                context,
                selected,
                kind,
                `${target}.${cppIdentifier(snakeCase(member.name))}`,
                argument,
            ),
        );
    }
    if (present) context.emit({ kind: "close", code: "}" });
    return target;
}

/**
 * A spatial position, `{ x, y, z }` at JavaScript number precision. A
 * computed one (`opts.listenerPosition()`) is evaluated once, into a
 * temporary, before its lanes are read.
 */
function spatialVector(
    context: AudioIntrinsicContext,
    expression: ts.Expression,
): string {
    if (!ts.isCallExpression(expression))
        return context.compileVec3(expression, "double");
    const value = context.compileValue(expression);
    if (value.kind !== "data" || value.dataType?.kind !== "struct")
        context.fail(expression, "Expected a Vec3 record { x, y, z }.");
    const name = context.allocateTemporaryCppName("spatial_vector");
    context.emit({
        kind: "declaration",
        type: "const auto",
        name,
        initializer: value.cpp,
    });
    return context.vec3FromRecord(
        { ...value, cpp: name },
        expression,
        "double",
    );
}

/**
 * `panningModel: "HRTF"` written as such: HRTF panning needs an HRTF
 * database this build does not package, and equal-power panning is not it.
 * A model chosen at run time throws there (`audio_set_panner_model`).
 */
function refuseHrtf(
    context: AudioIntrinsicContext,
    argument: ts.Expression | undefined,
): void {
    if (!argument) return;
    const model = context.checker
        .getTypeAtLocation(argument)
        .getProperty("panningModel");
    if (!model) return;
    const type = context.checker.getNonNullableType(
        context.checker.getTypeOfSymbolAtLocation(model, argument),
    );
    if (type.isStringLiteral() && type.value === "HRTF")
        context.fail(
            argument,
            'Spatial panningModel "HRTF" is not lowered: it needs an HRTF database, which this build does not package.',
        );
}

/** A sound function's sound, evaluated into a temporary in source order. */
function soundArgument(
    context: AudioIntrinsicContext,
    call: ts.CallExpression,
): string {
    const sound = context.compileValue(argumentAt(call, 0));
    context.expectKind(sound, "static-sound", argumentAt(call, 0));
    return context.bindings.pinValueToTemporary(
        sound,
        "static_sound",
        argumentAt(call, 0),
    ).cpp;
}

/** `cleanAudioUrl` (audio-fetch.ts): the URL as the library requests it. */
function cleanAudioUrl(url: string): string {
    return url.replaceAll("#", "%23");
}

/**
 * `createSoundAsync`'s source: a URL selecting packaged audio (each file it
 * may select packaged, registered as the library requests it, its decoder
 * linked), an `ArrayBuffer` or an `AudioBuffer`.
 */
function soundSource(
    context: AudioIntrinsicContext,
    call: ts.CallExpression,
): string {
    const argument = argumentAt(call, 1);
    const type = context.checker.getTypeAtLocation(argument);
    if (type.flags & ts.TypeFlags.StringLike)
        return packagedAudioUrl(
            context,
            call,
            argument,
            "A createSoundAsync URL must select packaged audio a linked decoder reads: a literal, or a runtime string whose candidates generation can find.",
            cleanAudioUrl,
            "sound_url",
        );
    const value = context.compileValue(argument);
    if (value.kind === "audio-buffer")
        return context.bindings.pinValueToTemporary(
            value,
            "sound_buffer",
            argument,
        ).cpp;
    if (value.kind === "data" && value.dataType?.kind === "arraybuffer") {
        for (const codec of AUDIO_CODECS)
            context.reachFeature(`audio:decode-${codec}`, call);
        return context.bindings.pinValueToTemporary(
            value,
            "sound_bytes",
            argument,
        ).cpp;
    }
    return context.fail(
        argument,
        "createSoundAsync takes a packaged URL, an ArrayBuffer or an AudioBuffer; URL lists and SoundBuffers are not lowered.",
    );
}

function compileStaticSound(
    context: AudioIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createSoundAsync": {
            // The library listens for its sources' `ended` and decodes on
            // native jobs: both are an application realm's.
            context.reachFeature("audio:static-sound", call);
            context.expectArgumentCount(call, 2, 3);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            const owner = context.bindings.pinValueToTemporary(
                engine,
                "sound_engine",
                argumentAt(call, 0),
            );
            const source = soundSource(context, call);
            const refused = context.allocateTemporaryCppName("sound_refused");
            context.emit({
                kind: "declaration",
                type: "const char*",
                name: refused,
                initializer: "nullptr",
            });
            const options = soundOptions(
                context,
                call.arguments[2],
                "bbl::StaticSoundOptions",
                SOUND_OPTIONS,
                refused,
            );
            return {
                kind: "promise",
                cpp: `(${refused} ? bbl::js::Promise<std::shared_ptr<bbl::StaticSound>>::rejected(std::make_exception_ptr(std::runtime_error(${refused}))) : bbl::create_sound_async(${owner.cpp}, ${source}, ${options}))`,
                promiseType: "std::shared_ptr<bbl::StaticSound>",
                promiseResult: {
                    kind: "static-sound",
                    cpp: "",
                    dataType: staticSoundType,
                },
            };
        }
        case "playSound":
        case "stopSound": {
            context.expectArgumentCount(call, 1, 2);
            context.reachFeature("audio:static-sound", call);
            const sound = soundArgument(context, call);
            const options =
                importedName === "playSound"
                    ? soundOptions(
                          context,
                          call.arguments[1],
                          "bbl::StaticSoundPlayOptions",
                          PLAY_OPTIONS,
                      )
                    : soundOptions(
                          context,
                          call.arguments[1],
                          "bbl::StaticSoundStopOptions",
                          { waitTime: "number" },
                      );
            return {
                kind: "void",
                cpp: `bbl::${importedName === "playSound" ? "play_sound" : "stop_sound"}(${sound}, ${options})`,
            };
        }
        case "setSoundVolume": {
            context.expectArgumentCount(call, 2, 3);
            context.reachFeature("audio:static-sound", call);
            const sound = soundArgument(context, call);
            const volume = context.allocateTemporaryCppName("sound_volume");
            context.emit({
                kind: "declaration",
                type: "const double",
                name: volume,
                initializer: context.compileNumber(
                    argumentAt(call, 1),
                    "double",
                ),
            });
            const ramp = call.arguments[2]
                ? soundOptions(context, call.arguments[2], "bbl::RampOptions", {
                      duration: "number",
                      shape: "string",
                  })
                : undefined;
            return {
                kind: "void",
                cpp: `bbl::set_sound_volume(${sound}, ${volume}${ramp ? `, bbl::js::Nullable<bbl::RampOptions>(${ramp})` : ""})`,
            };
        }
        case "disposeSound": {
            context.expectArgumentCount(call, 1, 1);
            context.reachFeature("audio:static-sound", call);
            return {
                kind: "void",
                cpp: `bbl::dispose_sound(${soundArgument(context, call)})`,
            };
        }
        case "enableSpatial": {
            context.expectArgumentCount(call, 1, 2);
            context.reachFeature("audio:spatial-sound", call);
            const sound = soundArgument(context, call);
            refuseHrtf(context, call.arguments[1]);
            const refused = context.allocateTemporaryCppName("spatial_refused");
            context.emit({
                kind: "declaration",
                type: "const char*",
                name: refused,
                initializer: "nullptr",
            });
            const options = soundOptions(
                context,
                call.arguments[1],
                "bbl::SpatialSoundOptions",
                SPATIAL_OPTIONS,
                refused,
                SPATIAL_OPTION_REFUSALS,
                "Spatial",
            );
            context.emit(
                `if (${refused}) throw std::runtime_error(${refused});`,
            );
            return {
                kind: "void",
                cpp: `bbl::enable_spatial(${sound}, ${options})`,
            };
        }
        case "setSpatialPosition": {
            context.expectArgumentCount(call, 2, 2);
            context.reachFeature("audio:spatial-sound", call);
            const sound = soundArgument(context, call);
            return {
                kind: "void",
                cpp: `bbl::set_spatial_position(${sound}, ${spatialVector(context, argumentAt(call, 1))})`,
            };
        }
        case "createAudioEngineMediaStream": {
            // The pin's tap over the engine's main output: a stream
            // destination whose stream the program reads as `stream`.
            context.expectArgumentCount(call, 1, 1);
            context.reachFeature("audio:engine-media-stream", call);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            const output = context.allocateTemporaryCppName(
                "engine_media_stream",
            );
            context.emit({
                kind: "declaration",
                type: "const std::shared_ptr<bbl::AudioEngineMediaStream>",
                name: output,
                initializer: `bbl::create_audio_engine_media_stream(${engine.cpp})`,
            });
            return {
                kind: "record",
                cpp: output,
                recordProperties: {
                    stream: mediaStreamValue(`${output}->stream`),
                },
            };
        }
        case "setSpatialListenerPosition": {
            context.expectArgumentCount(call, 2, 2);
            context.reachFeature("audio:spatial-sound", call);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            const owner = context.bindings.pinValueToTemporary(
                engine,
                "listener_engine",
                argumentAt(call, 0),
            );
            return {
                kind: "void",
                cpp: `bbl::set_spatial_listener_position(${owner.cpp}, ${spatialVector(context, argumentAt(call, 1))})`,
            };
        }
        default:
            return undefined;
    }
}

export function compileAudioIntrinsic(
    context: AudioIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    refuseAudioName(
        context,
        REFUSED_BY_NAME,
        importedName,
        call,
        "Babylon Lite audio",
    );
    const sound = compileStaticSound(context, importedName, call);
    if (sound) return sound;

    switch (importedName) {
        case "createAudioEngineAsync": {
            // `AudioEngineOptions.audioContext` is adopted; the master
            // volume, ramp duration and browser auto-resume switches refuse
            // (`ENGINE_OPTION_REFUSALS`). Application `setInterval` calls are
            // separate platform input and run on the frame conductor.
            context.expectArgumentCount(call, 0, 1);
            const options = engineOptions(context, call);
            context.reachFeature("audio:engine", call);
            const engine = context.allocateTemporaryCppName("audio_engine");
            const graph = mainOutputGraph(engine, `${engine}_ctx`);
            const refused = options.refusal && `${engine}_refused`;
            if (options.refusal)
                context.emit({
                    kind: "declaration",
                    type: "const char* const",
                    name: refused!,
                    initializer: options.refusal,
                });
            const adopted = options.adopted;
            if (context.options.workers) {
                // A realm's own context opens its device in a native job,
                // and the engine promise settles after that device
                // transition (the audio contract); an adopted context is
                // already open. The graph is built on the realm.
                const created = `bbl::pal::audio_create_context_async(${context.audioSessionCpp()})`;
                const resolved = (cpp: string): string =>
                    `bbl::js::Promise<bbl::pal::AudioContextHandle>::resolved(${cpp})`;
                const contextPromise = !adopted
                    ? created
                    : adopted.present
                      ? `((${adopted.present}) ? ${resolved(adopted.cpp)} : ${created})`
                      : resolved(adopted.cpp);
                const built =
                    `${contextPromise}.then([](const bbl::pal::AudioContextHandle& ${engine}_ctx) { ` +
                    `${graph.map(nativeStatementCode).join(" ")} ` +
                    `return bbl::AudioEngineHandle{${engine}_ctx, ${engine}_main_bus, ${engine}_main_out}; })`;
                return {
                    kind: "promise",
                    cpp: refused
                        ? `(${refused} ? bbl::js::Promise<bbl::AudioEngineHandle>::rejected(std::make_exception_ptr(std::runtime_error(${refused}))) : ${built})`
                        : built,
                    promiseType: "bbl::AudioEngineHandle",
                    promiseResult: {
                        kind: "audio-engine",
                        cpp: "",
                        dataType: audioEngineType,
                    },
                };
            }
            if (refused)
                context.emit(
                    `if (${refused}) throw std::runtime_error(${refused});`,
                );
            const created = `bbl::pal::audio_create_context(${context.audioSessionCpp()})`;
            context.emit({
                kind: "declaration",
                type: "bbl::pal::AudioContextHandle",
                name: `${engine}_ctx`,
                initializer: !adopted
                    ? created
                    : adopted.present
                      ? `(${adopted.present}) ? ${adopted.cpp} : ${created}`
                      : adopted.cpp,
            });
            for (const statement of graph) context.emit(statement);
            context.registerNativeTemporary(`${engine}_ctx`);
            context.registerNativeTemporary(`${engine}_main_bus`);
            return {
                kind: "audio-engine",
                cpp: `bbl::AudioEngineHandle{${engine}_ctx, ${engine}_main_bus, ${engine}_main_out}`,
                dataType: audioEngineType,
            };
        }

        case "unlockAudioEngineAsync": {
            // `ctx.resume()` behind the pin's own `state !== "running"`
            // guard, which the PAL's resume already carries.
            context.expectArgumentCount(call, 1, 1);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            return {
                kind: "void",
                cpp: `bbl::pal::audio_resume((${engine.cpp}).context)`,
            };
        }

        case "disposeAudioEngine": {
            context.expectArgumentCount(call, 1, 1);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            context.emit(
                `${sourceDisposer(context)}_engine_sources(${engine.cpp});`,
            );
            return {
                kind: "void",
                cpp: `bbl::pal::audio_close_context((${engine.cpp}).context)`,
            };
        }

        case "disposeSoundSource": {
            context.expectArgumentCount(call, 1, 1);
            const source = context.compileValue(argumentAt(call, 0));
            context.expectKind(source, "audio-source", argumentAt(call, 0));
            return {
                kind: "void",
                cpp: `${sourceDisposer(context)}(${source.cpp})`,
            };
        }

        case "createSoundSourceAsync": {
            // The one sound-family entry point the demos reach, and the
            // reason they reach it: it routes a node the CALLER built into
            // the engine's main bus, so a hand-made graph shares the
            // engine's master volume and unlock handling rather than
            // opening a second context. The pin wraps it in a
            // `SoundSubGraph` whose only reached node is the volume gain;
            // with no spatial, stereo or analyzer sub-node the graph's
            // head and tail are that one gain, which is what this emits.
            context.expectArgumentCount(call, 2, 3);
            let engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            const deferredOptions =
                context.options.deferredCapabilities && call.arguments[2];
            if (deferredOptions)
                engine = context.bindings.pinValueToTemporary(
                    engine,
                    "audio_engine_argument",
                    argumentAt(call, 0),
                );
            let node = context.compileValue(argumentAt(call, 1));
            context.expectKind(node, "audio-node", argumentAt(call, 1));
            if (deferredOptions)
                node = context.bindings.pinValueToTemporary(
                    node,
                    "audio_node_argument",
                    argumentAt(call, 1),
                );
            const supported = (): Value => {
                const mainBus = `(${engine.cpp}).main_bus`;
                const source = context.allocateTemporaryCppName("audio_source");
                context.emit({
                    kind: "declaration",
                    type: "const bbl::pal::AudioNodeHandle",
                    name: source,
                    initializer: `bbl::pal::audio_create_gain((${engine.cpp}).context)`,
                });
                context.emit({
                    kind: "expression",
                    code: `bbl::pal::audio_connect(${source}, ${mainBus});`,
                });
                context.emit({
                    kind: "expression",
                    code: `bbl::pal::audio_connect(${node.cpp}, ${source});`,
                });
                const stored =
                    context.allocateTemporaryCppName("audio_source_state");
                context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: stored,
                    initializer: `bbl::js::make_gc_shared<bbl::AudioSourceState>(bbl::AudioSourceState{{}, ${node.cpp}, ${source}, ${engine.cpp}})`,
                });
                // `_dispose: () => disposeSoundSource(source)`, which the
                // engine's own disposal calls for every sound it holds.
                context.emit(
                    `${stored}->dispose = bbl::js::Callback<void()>(bbl::js::make_closure(std::tuple{${stored}}, [](auto& captured) -> void { ${sourceDisposer(context)}(std::get<0>(captured)); }));`,
                );
                context.emit(`(${engine.cpp}).sources.add(${stored});`);
                return {
                    kind: "audio-source",
                    cpp: stored,
                    dataType: { kind: "handle", handle: "audio-source" },
                    requiresExplicitDiscard: true,
                };
            };
            const deferred = context.deferredCapabilities.compileOptions(
                call,
                2,
                supported,
            );
            if (deferred) return deferred;
            requireAbsentOptions(context, call.arguments[2], importedName);
            return supported();
        }

        default:
            return undefined;
    }
}
