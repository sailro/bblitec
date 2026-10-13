import type { LoweringServices } from "../lowering-services.js";
// Babylon Lite's audio functions: the engine, its master volume, static
// sounds, spatial audio and the engine's media-stream tap call the pin's
// lowered family (static-sound-library.ts); a caller-built source joins the
// engine's main bus and source disposal is lowered from the pinned
// declarations. The rest of the family refuses by name.
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import { pinCpp } from "../evaluation-order.js";
import { presenceCpp, type Feature, type Value } from "../types.js";
import type { DataType } from "../data-types.js";
import type { IntrinsicCallContext } from "./context.js";
import { packagedAudioUrl, refuseAudioName } from "../audio-surface.js";
import { EmissionWeakMap } from "../emission-transaction.js";
import { lowerAudioSourceDisposal } from "../../lowering/audio-source-lowerer.js";
import { isNullable } from "../type-facts.js";
import {
    emitPresentOption,
    emitScalarOption,
    retainedOptionPresent,
    retainedOptions,
    type RetainedOption,
} from "./retained-options.js";
import { rejectedWhenRefused } from "../promises.js";
import { pinnedModuleFunction } from "../../lowering/pinned-shader-builders.js";
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
            | "sceneManifest"
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
 * sounds, buses, stereo, the analyzer, the microphone, the unmute UI and the
 * visualizer refuse by name, because a silent no-op would be a scene that
 * renders without sounding. The engine, its master volume, static sounds,
 * their spatial audio and the engine's media-stream tap run the pin's
 * lowered family (`compileLibraryCall`).
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
};

/** The data type of a lowered `createAudioEngineAsync` result. */
const audioEngineType: DataType = { kind: "handle", handle: "audio-engine" };

/**
 * A call into the pin's lowered family: `root` joins the program's library
 * header, and the call reaches `feature`.
 */
function reachLibraryRoot(
    context: AudioIntrinsicContext,
    root: string,
    feature: Feature,
    call: ts.CallExpression,
): void {
    context.reachFeature(feature, call);
    context.sceneManifest.recordAudioLibraryRoot(root);
}

/** The engine a family function takes, evaluated into a temporary in source order. */
function engineArgument(
    context: AudioIntrinsicContext,
    call: ts.CallExpression,
    label: string,
): string {
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "audio-engine", argumentAt(call, 0));
    return context.bindings.pinValueToTemporary(
        engine,
        label,
        argumentAt(call, 0),
    ).cpp;
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

/** A ramp's options (`setSoundVolume`, `setMasterVolume`). */
const RAMP_OPTIONS: OptionsShape = {
    cppType: "bbl::RampOptions",
    kinds: { duration: "number", shape: "string" },
};

/**
 * `createAudioEngineAsync`'s options. The pin reads the three resume
 * switches only in the browser hooks a native engine has nothing to install
 * (`ENGINE_ADAPTERS` in static-sound-library.ts), so each refuses by name;
 * `audioContext` is adopted (`compileEngineCreation`).
 */
const ENGINE_OPTIONS: OptionsShape = {
    cppType: "bbl::AudioEngineOptions",
    kinds: { volume: "number", parameterRampDuration: "number" },
    refusals: {
        resumeOnInteraction:
            "the native engine installs no document click resume hook",
        resumeOnPause: "the native engine installs no statechange resume timer",
        resumeOnPauseRetryInterval:
            "the native engine installs no statechange resume timer",
    },
    label: "Audio engine",
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
 * Writes an options member a scalar kind does not describe, already
 * selected present; `present` is the run-time condition that selected it,
 * none when it is always present.
 */
type OptionConsumer = (
    member: RetainedOption,
    target: string,
    site: ts.Expression,
    present: string | undefined,
) => void;

/** How a family function's options record lowers. */
interface OptionsShape {
    /** The library's value struct. */
    readonly cppType: string;
    readonly kinds: OptionKinds;
    /** Members that refuse, with the reason. */
    readonly refusals?: Readonly<Record<string, string>>;
    /** Members written by their own consumer, by name. */
    readonly consumers?: Readonly<Record<string, OptionConsumer>>;
    /** The options' owner, in refusals. */
    readonly label?: string;
}

/** A lowered options record and, when a refused member may be present, its error. */
interface LoweredOptions {
    /** The value struct's native name. */
    readonly options: string;
    /**
     * A `std::optional<bbl::js::Error>` holding the refusal of a member
     * present at run time; the caller rejects or throws it.
     */
    readonly refused?: string;
}

/**
 * A family function's options record as the library's value struct, each
 * present member written in source order; an absent argument is the
 * struct's defaults. A refused member present at generation fails there;
 * one whose presence is a run-time fact sets `refused`.
 */
function soundOptions(
    context: AudioIntrinsicContext,
    argument: ts.Expression | undefined,
    shape: OptionsShape,
): LoweredOptions {
    const {
        cppType,
        kinds,
        refusals = SOUND_OPTION_REFUSALS,
        consumers = {},
        label = "Static sound",
    } = shape;
    // Named for its struct (`bbl::AudioEngineOptions` -> `audio_engine_options`).
    const target = context.allocateTemporaryCppName(
        snakeCase(cppType.replace(/^bbl::/, "")),
    );
    context.emit({
        kind: "declaration",
        type: cppType,
        name: target,
        initializer: "{}",
    });
    if (!argument) return { options: target };
    const value = context.compileValue(argument);
    if (value.kind === "json-null" || value.dataType?.kind === "undefined") {
        context.emitDiscardedValue(value);
        return { options: target };
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
            `${label} options that may be absent need represented presence.`,
        );
    // `{ member: undefined }` is the absent member.
    const members = retainedOptions(context, owner, argument).filter(
        (member) =>
            member.value?.kind !== "json-null" &&
            member.type?.kind !== "undefined",
    );
    const refusal = (member: RetainedOption): string =>
        `${label} option '${member.name}' is not lowered: ${refusals[member.name]}.`;
    const refusedMembers = members.filter((member) => refusals[member.name]);
    for (const member of refusedMembers)
        if (!retainedOptionPresent(member))
            context.fail(argument, refusal(member));
    const refused = refusedMembers.length
        ? pinCpp(
              context,
              "{}",
              "options_refused",
              "std::optional<bbl::js::Error>",
          )
        : undefined;
    if (present) context.emit({ kind: "open", code: `if (${present}) {` });
    for (const member of members) {
        if (refusals[member.name]) {
            context.emit(
                `if (${retainedOptionPresent(member)}) ${refused} = bbl::js::make_error("Error", ${context.cppString(refusal(member))});`,
            );
            continue;
        }
        const consume = consumers[member.name];
        if (consume) {
            const selected = [present, retainedOptionPresent(member)].filter(
                (test) => test !== undefined,
            );
            emitPresentOption(context, member, (value) =>
                consume(
                    value,
                    target,
                    argument,
                    selected.length ? selected.join(" && ") : undefined,
                ),
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
    return { options: target, ...(refused ? { refused } : {}) };
}

/** Throw a refused member's error where the call returns no promise to reject. */
function throwWhenRefused(
    context: AudioIntrinsicContext,
    lowered: LoweredOptions,
): void {
    if (lowered.refused)
        context.emit(
            `if (${lowered.refused}) std::rethrow_exception(*${lowered.refused});`,
        );
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
    const name = pinCpp(context, value.cpp, "spatial_vector");
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

/** The pin's own `cleanAudioUrl` (audio-fetch.ts), run at generation: the URL as the library requests it. */
function cleanAudioUrl(url: string): string {
    const cleaned = pinnedModuleFunction(
        "src/audio/audio-fetch.ts",
        "cleanAudioUrl",
    )(url);
    if (typeof cleaned !== "string")
        throw new Error("The pinned cleanAudioUrl returned no string.");
    return cleaned;
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

/**
 * `createAudioEngineAsync`: the call site opens the context (a device
 * opening is the PAL's) unless the options adopt one, and the pin's own
 * function builds the engine on it: its main output and bus, the master
 * volume ramped there, and its ramp duration.
 */
function compileEngineCreation(
    context: AudioIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 0, 1);
    // Whether the options adopt a context: always, or where a run-time
    // condition holds.
    const adoption: { adopts?: "always" | "maybe" } = {};
    const lowered = soundOptions(context, call.arguments[0], {
        ...ENGINE_OPTIONS,
        consumers: {
            audioContext: (member, target, site, present) => {
                if (
                    member.type?.kind !== "handle" ||
                    member.type.handle !== "audio-context"
                )
                    context.fail(
                        site,
                        "createAudioEngineAsync option 'audioContext' is not an AudioContext the engine adopts.",
                    );
                adoption.adopts = present ? "maybe" : "always";
                context.emit(`${target}.audio_context = ${member.cpp};`);
            },
        },
    });
    reachLibraryRoot(
        context,
        "createAudioEngineAsync",
        "audio:pinned-engine",
        call,
    );
    const { options, refused } = lowered;
    const { adopts } = adoption;
    const session = context.audioSessionCpp();
    const created = `bbl::create_audio_engine_async(${options})`;
    if (context.options.workers) {
        // A realm's own context opens its device in a native job, and the
        // engine promise settles after that device transition (the audio
        // contract); on an adopted context, already open, the pin's
        // function runs at the call. The engine is built on the realm.
        const opened =
            `bbl::pal::audio_create_context_async(${session}).then(bbl::js::make_closure(std::tuple{${options}}, [](auto& captured, const bbl::pal::AudioContextHandle& context) { ` +
            `auto options = std::get<0>(captured); options.audio_context = context; ` +
            `return bbl::create_audio_engine_async(std::move(options)); }))`;
        return {
            kind: "promise",
            cpp: rejectedWhenRefused(
                refused,
                "bbl::AudioEngineHandle",
                adopts === "always"
                    ? created
                    : adopts === "maybe"
                      ? `(${options}.audio_context ? ${created} : ${opened})`
                      : opened,
            ),
            promiseType: "bbl::AudioEngineHandle",
            promiseResult: {
                kind: "audio-engine",
                cpp: "",
                dataType: audioEngineType,
            },
        };
    }
    // The entry realm reads the settlement in place: a refused member
    // throws, and the pin's coroutine settles on a private loop.
    throwWhenRefused(context, lowered);
    const opened = `bbl::pal::audio_create_context(${session})`;
    if (adopts === "maybe")
        context.emit(
            `if (!${options}.audio_context) ${options}.audio_context = ${opened};`,
        );
    else if (!adopts) context.emit(`${options}.audio_context = ${opened};`);
    return context.bindings.pinValueToTemporary(
        {
            kind: "audio-engine",
            cpp: `bbl::js::settle_in_place<bbl::AudioEngineHandle>([&] { return ${created}; })`,
            dataType: audioEngineType,
        },
        "audio_engine",
        call,
    );
}

/** A call into the pin's lowered family, or undefined for any other name. */
function compileLibraryCall(
    context: AudioIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createAudioEngineAsync":
            return compileEngineCreation(context, call);
        case "setMasterVolume": {
            context.expectArgumentCount(call, 2, 3);
            reachLibraryRoot(
                context,
                importedName,
                "audio:pinned-engine",
                call,
            );
            const engine = engineArgument(context, call, "master_engine");
            const volume = pinCpp(
                context,
                context.compileNumber(argumentAt(call, 1), "double"),
                "master_volume",
                "const double",
            );
            const ramp = call.arguments[2]
                ? soundOptions(context, call.arguments[2], RAMP_OPTIONS)
                : undefined;
            return {
                kind: "void",
                cpp: `bbl::set_master_volume(${engine}, ${volume}${ramp ? `, bbl::js::Nullable<bbl::RampOptions>(${ramp.options})` : ""})`,
            };
        }
        case "getMasterVolume": {
            context.expectArgumentCount(call, 1, 1);
            reachLibraryRoot(
                context,
                importedName,
                "audio:pinned-engine",
                call,
            );
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            // `setMasterVolume` changes it: two reads are two.
            return {
                kind: "number",
                cpp: `bbl::get_master_volume(${engine.cpp})`,
                impure: true,
            };
        }
        case "createSoundAsync": {
            // The library listens for its sources' `ended` and decodes on
            // native jobs: both are an application realm's.
            context.expectArgumentCount(call, 2, 3);
            reachLibraryRoot(context, importedName, "audio:static-sound", call);
            const engine = engineArgument(context, call, "sound_engine");
            const source = soundSource(context, call);
            const { options, refused } = soundOptions(
                context,
                call.arguments[2],
                {
                    cppType: "bbl::StaticSoundOptions",
                    kinds: SOUND_OPTIONS,
                },
            );
            return {
                kind: "promise",
                cpp: rejectedWhenRefused(
                    refused,
                    "std::shared_ptr<bbl::StaticSound>",
                    `bbl::create_sound_async(${engine}, ${source}, ${options})`,
                ),
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
            reachLibraryRoot(context, importedName, "audio:static-sound", call);
            const sound = soundArgument(context, call);
            const lowered = soundOptions(
                context,
                call.arguments[1],
                importedName === "playSound"
                    ? {
                          cppType: "bbl::StaticSoundPlayOptions",
                          kinds: PLAY_OPTIONS,
                      }
                    : {
                          cppType: "bbl::StaticSoundStopOptions",
                          kinds: { waitTime: "number" },
                      },
            );
            throwWhenRefused(context, lowered);
            return {
                kind: "void",
                cpp: `bbl::${importedName === "playSound" ? "play_sound" : "stop_sound"}(${sound}, ${lowered.options})`,
            };
        }
        case "setSoundVolume": {
            context.expectArgumentCount(call, 2, 3);
            reachLibraryRoot(context, importedName, "audio:static-sound", call);
            const sound = soundArgument(context, call);
            const volume = pinCpp(
                context,
                context.compileNumber(argumentAt(call, 1), "double"),
                "sound_volume",
                "const double",
            );
            const ramp = call.arguments[2]
                ? soundOptions(context, call.arguments[2], RAMP_OPTIONS)
                : undefined;
            return {
                kind: "void",
                cpp: `bbl::set_sound_volume(${sound}, ${volume}${ramp ? `, bbl::js::Nullable<bbl::RampOptions>(${ramp.options})` : ""})`,
            };
        }
        case "disposeSound": {
            context.expectArgumentCount(call, 1, 1);
            reachLibraryRoot(context, importedName, "audio:static-sound", call);
            return {
                kind: "void",
                cpp: `bbl::dispose_sound(${soundArgument(context, call)})`,
            };
        }
        case "enableSpatial": {
            context.expectArgumentCount(call, 1, 2);
            reachLibraryRoot(
                context,
                importedName,
                "audio:spatial-sound",
                call,
            );
            const sound = soundArgument(context, call);
            refuseHrtf(context, call.arguments[1]);
            const lowered = soundOptions(context, call.arguments[1], {
                cppType: "bbl::SpatialSoundOptions",
                kinds: SPATIAL_OPTIONS,
                refusals: SPATIAL_OPTION_REFUSALS,
                label: "Spatial",
            });
            throwWhenRefused(context, lowered);
            return {
                kind: "void",
                cpp: `bbl::enable_spatial(${sound}, ${lowered.options})`,
            };
        }
        case "setSpatialPosition": {
            context.expectArgumentCount(call, 2, 2);
            reachLibraryRoot(
                context,
                importedName,
                "audio:spatial-sound",
                call,
            );
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
            reachLibraryRoot(
                context,
                importedName,
                "audio:engine-media-stream",
                call,
            );
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
            reachLibraryRoot(
                context,
                importedName,
                "audio:spatial-sound",
                call,
            );
            const engine = engineArgument(context, call, "listener_engine");
            return {
                kind: "void",
                cpp: `bbl::set_spatial_listener_position(${engine}, ${spatialVector(context, argumentAt(call, 1))})`,
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
    const library = compileLibraryCall(context, importedName, call);
    if (library) return library;

    switch (importedName) {
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
