/**
 * The pin's audio family lowered from its own declarations, as one
 * `PinnedRecordModel`: the engine (`audio-engine.ts` with its buses, ramped
 * parameters and signals) and, as a program reaches them, `static-sound.ts`
 * with the modules it reaches (the sound buffer and sub-graph) and the mixer
 * buses of `audio-bus.ts`.
 *
 * Web Audio is the application surface's own (`webAudioRecords`). The
 * engine is the native `bbl::AudioEngineHandle` (`bblite/audio_types.hpp`)
 * the pin's own `createAudioEngineAsync` fills: the context its call site
 * opened, the clock and state read from that context, the main output and
 * bus records the pin builds, its master volume and ramp duration, its
 * shared `_sounds` set (every sound is an `AudioEngineSound`, so
 * `disposeAudioEngine` disposes sounds and sources alike) and its format
 * probes. The engine reports no statechange, so subscribing to it -- a
 * looped sound started while the context is not running -- refuses at run
 * time.
 *
 * Spatial audio (`spatial.ts`) and stereo panning (`stereo.ts`) join the
 * model when a program reaches them, as the pin tree-shakes them: a panner or
 * stereo panner sub-node per sound and, for spatial audio, the engine's
 * listener over the context's `AudioListener`. A host is a static sound,
 * the one host this surface lowers; the engine keeps the listener and the
 * attached nodes' updates in its native handle.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    PinnedRecordModel,
    type CallAdapter,
    type MemberSpec,
    type PinnedCallable,
    type RecordShape,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    field,
    functionOf as fn,
    members,
    optionalOf,
    promiseOf,
    reads,
    recordOf as record,
    recordScalars,
    spelled,
} from "./record-shapes.js";
import {
    webAudioClasses,
    webAudioConstructors,
    webAudioRecords,
    webPlatformConstructors,
    webPlatformGlobals,
    webPlatformRecords,
    webPlatformValues,
} from "./web-platform-schema.js";

const STATIC_SOUND = "src/audio/static-sound.ts";
const AUDIO_ENGINE = "src/audio/audio-engine.ts";

/** Every module the static-sound roots reach. */
const STATIC_SOUND_MODULES = [
    STATIC_SOUND,
    AUDIO_ENGINE,
    "src/audio/sound-buffer.ts",
    "src/audio/sound-sub-graph.ts",
    "src/audio/audio-param.ts",
    "src/audio/audio-signal.ts",
    "src/audio/audio-bus.ts",
    "src/audio/bus.ts",
    "src/audio/audio-fetch.ts",
] as const;

/** The modules spatial audio adds, decomposing an attached target's matrix. */
const SPATIAL_MODULES = [
    "src/audio/spatial.ts",
    "src/math/decompose-mat4.ts",
    "src/math/create-quat-from-rotation-mat4.ts",
    "src/math/mat4-determinant3.ts",
] as const;

/** The engine functions a program calls. */
export const ENGINE_ROOTS = [
    "createAudioEngineAsync",
    "setMasterVolume",
    "getMasterVolume",
] as const;

/** The static-sound functions a program calls, sound buffers included. */
export const STATIC_SOUND_ROOTS = [
    "createSoundBufferAsync",
    "createSoundAsync",
    "playSound",
    "stopSound",
    "setSoundVolume",
    "disposeSound",
] as const;

/** The bus functions a program calls. */
const BUS_ROOTS = [
    "createAudioBusAsync",
    "setBusVolume",
    "disposeAudioBus",
] as const;

/** The stereo functions a program calls. */
const STEREO_ROOTS = ["enableStereo", "setStereoPan"] as const;

/** The spatial functions a program calls. */
const SPATIAL_ROOTS = [
    "enableSpatial",
    "setSpatialPosition",
    "setSpatialListenerPosition",
] as const;

/** The media-stream tap a program calls. */
const MEDIA_STREAM_ROOTS = ["createAudioEngineMediaStream"] as const;

/**
 * Every public function of the family a program can call, each lowered
 * with what it reaches; a program's header holds the ones it calls.
 */
export const AUDIO_LIBRARY_ROOTS: readonly string[] = [
    ...ENGINE_ROOTS,
    ...STATIC_SOUND_ROOTS,
    ...BUS_ROOTS,
    ...STEREO_ROOTS,
    ...SPATIAL_ROOTS,
    ...MEDIA_STREAM_ROOTS,
];

/** The roots a program calls (its manifest's record), in the family's order. */
export function audioLibraryRoots(called: readonly string[] = []): string[] {
    return AUDIO_LIBRARY_ROOTS.filter((root) => called.includes(root));
}

const { number, string, void: none } = recordScalars;
const typedF32: RecordShape = { kind: "typed", element: "f32" };
const engineRead = (shape: RecordShape, native: string): MemberSpec =>
    reads(shape, (owner) => `${native}(${owner}.context)`);

/**
 * The engine's spatial state: the listener its slot holds (the lowered
 * listener, type-erased in the native handle).
 */
const engineSpatialMembers: readonly (readonly [string, MemberSpec])[] = [
    [
        "_listener",
        {
            shape: optionalOf(record("SpatialListenerSlot")),
            access: (owner) =>
                `std::static_pointer_cast<bbl::SpatialListenerSlot>(${owner}.listener->listener)`,
            assign: (owner, value) => `${owner}.listener->listener = ${value}`,
        },
    ],
];

/** A bus record the native engine holds type-erased, set through its setter. */
const engineBus = (
    pinned: "MainOut" | "MainBus",
    field: string,
    setter: string,
): MemberSpec => ({
    shape: record(pinned),
    access: (owner) =>
        `std::static_pointer_cast<bbl::${pinned}>(${owner}.${field})`,
    assign: (owner, value) => `${owner}.${setter}(${value})`,
});

/**
 * Members of the pin's engine literal the native record computes or does not
 * keep: its getters (views of the context it holds), the signals only the
 * browser's statechange and click hooks fire, the settled ready promise, the
 * offline flag (a native context renders in real time), the spatial update
 * loop's stop, and the listener until spatial audio is reached.
 */
const engineOmissions = (spatial: boolean): ReadonlyMap<string, string> =>
    new Map([
        ...[
            "state",
            "audioContext",
            "currentTime",
            "_currentTime",
            "onStateChanged",
            "onUserGesture",
        ].map(
            (name) =>
                [
                    name,
                    "the native engine computes it from its context",
                ] as const,
        ),
        ...["_onStateChanged", "_onUserGesture"].map(
            (name) =>
                [
                    name,
                    "the native engine reports no statechange and installs no click hook",
                ] as const,
        ),
        ["_isReady", "the engine is ready when its creation settles"],
        ...["_mainOut", "_mainBus"].map(
            (name) =>
                [
                    name,
                    "the pin assigns it once the engine (its ramp clock) exists",
                ] as const,
        ),
        ["_isOffline", "a native context renders in real time"],
        ["_spatialAutoStop", "no spatial update loop runs on its own"],
        ...(spatial
            ? []
            : [["_listener", "spatial audio is not reached"] as const]),
    ]);

/** The engine record and the views of it the pin's bodies take. */
const engineRecords = (
    parts: readonly (readonly [string, MemberSpec])[],
    spatial: boolean,
): readonly RecordSpec[] => [
    {
        // `RampClock` is the engine seen as a clock (`createRampParam`).
        pinned: ["AudioEngine", "RampClock"],
        cpp: "AudioEngineHandle",
        reference: false,
        native: true,
        omit: engineOmissions(spatial),
        members: members([
            [
                "_ctx",
                reads(
                    record("BaseAudioContext"),
                    (owner) => `${owner}.context`,
                ),
            ],
            [
                "audioContext",
                reads(
                    record("BaseAudioContext"),
                    (owner) => `${owner}.context`,
                ),
            ],
            ["currentTime", engineRead(number, "bbl::pal::audio_current_time")],
            [
                "_currentTime",
                engineRead(number, "bbl::pal::audio_current_time"),
            ],
            ["state", engineRead(string, "bbl::pal::audio_state")],
            ["_rampDuration", field(number, "ramp_duration")],
            [
                "_volume",
                { shape: number, access: (owner) => `(*${owner}.volume)` },
            ],
            [
                "_mainOut",
                engineBus("MainOut", "main_out_record", "set_main_out"),
            ],
            [
                "_mainBus",
                engineBus("MainBus", "main_bus_record", "set_main_bus"),
            ],
            [
                "_sounds",
                field(
                    { kind: "set", element: record("AudioEngineSound") },
                    "sources",
                ),
            ],
            [
                "_buses",
                field(
                    { kind: "set", element: record("AudioEngineSound") },
                    "buses",
                ),
            ],
            [
                "_validFormats",
                field({ kind: "set", element: string }, "valid_formats"),
            ],
            [
                "_invalidFormats",
                field({ kind: "set", element: string }, "invalid_formats"),
            ],
            [
                "onStateChanged",
                reads(record("AudioEngineStateSignal"), (owner) => owner),
            ],
            ["_isOffline", reads(recordScalars.boolean, () => "false")],
            // A held engine's creation has settled: it is ready.
            [
                "_isReady",
                reads(
                    promiseOf(none),
                    () =>
                        "bbl::js::Promise<bbl::js::PromiseVoid>::resolved({})",
                ),
            ],
            [
                "_spatialUpdaters",
                field(
                    { kind: "set", element: fn([], none) },
                    "spatial_updaters",
                ),
            ],
            [
                "_disposers",
                field({ kind: "array", element: fn([], none) }, "disposers"),
            ],
            ...parts,
        ]),
    },
    {
        pinned: ["AudioEngineSound"],
        cpp: "AudioEngineSound",
        reference: true,
        native: true,
        members: members([["_dispose", field(fn([], none), "dispose")]]),
    },
    {
        pinned: ["AudioEngineStateSignal"],
        cpp: "AudioEngineHandle",
        reference: false,
        native: true,
        members: members([
            [
                "add",
                spelled(
                    fn([fn([], none)], fn([], none)),
                    () =>
                        `[]() -> bbl::js::Callback<void()> { throw std::runtime_error("Starting a looped sound while its audio context is not running waits for a statechange, which the native engine does not report."); }()`,
                ),
            ],
        ]),
    },
];

/**
 * The pin's browser hooks a native engine has nothing to install: no
 * statechange event (so no auto-resume timer) and no autoplay gate (so no
 * click unlock), the same early returns the pin takes where a context lacks
 * `addEventListener` or no document exists; and a native context is never
 * an `OfflineAudioContext`.
 */
const ENGINE_ADAPTERS: ReadonlyMap<string, CallAdapter> = new Map([
    [`${AUDIO_ENGINE}#_wireStateAndResume`, { cpp: () => null }],
    [`${AUDIO_ENGINE}#_wireUserGesture`, { cpp: () => null }],
    [`${AUDIO_ENGINE}#isOfflineContext`, { cpp: () => "false" }],
]);

/**
 * `options.audioContext ?? new AudioContext()`: the engine's call site opens
 * the context (a device opening is the PAL's) and always passes it.
 */
const engineContextConstructor: CallAdapter = {
    cpp: () =>
        `[]() -> bbl::pal::AudioContextHandle { throw std::logic_error("createAudioEngineAsync adopts the context its call site opened."); }()`,
};

/**
 * The engine's own records, emitted from the pin's declarations whenever the
 * library is: its options, the ramp options its volume takes, its two buses
 * and the ramped parameter each holds, and the signals it creates.
 */
const engineFamilyRecords: readonly RecordSpec[] = [
    {
        pinned: ["AudioEngineOptions"],
        cpp: "AudioEngineOptions",
        reference: false,
    },
    { pinned: ["RampOptions"], cpp: "RampOptions", reference: false },
    { pinned: ["MainOut"], cpp: "MainOut", reference: true },
    { pinned: ["MainBus"], cpp: "MainBus", reference: true },
    { pinned: ["RampParam"], cpp: "RampParam", reference: true },
    {
        pinned: ["AudioSignalImpl", "AudioSignal"],
        cpp: "AudioSignal",
        reference: true,
    },
    { pinned: ["Entry"], cpp: "AudioSignalEntry", reference: true },
];

/**
 * The static sound's records, emitted from the pin's declarations: the
 * records held by value first, as the structs holding them need them whole.
 */
const soundRecords: readonly RecordSpec[] = [
    {
        pinned: ["SoundInstanceOptions"],
        cpp: "SoundInstanceOptions",
        reference: false,
        typeOf: `${STATIC_SOUND}#SoundInstance._options`,
    },
    {
        pinned: ["StoredOptions"],
        cpp: "StaticSoundStoredOptions",
        reference: false,
    },
    {
        pinned: ["SoundBufferOptions"],
        cpp: "SoundBufferOptions",
        reference: false,
    },
    {
        pinned: ["StaticSoundOptions"],
        cpp: "StaticSoundOptions",
        reference: false,
    },
    {
        pinned: ["StaticSoundPlayOptions"],
        cpp: "StaticSoundPlayOptions",
        reference: false,
    },
    {
        pinned: ["StaticSoundStopOptions"],
        cpp: "StaticSoundStopOptions",
        reference: false,
    },
    {
        // The host a spatial function takes is a static sound: buses,
        // streamed sounds and input sources are not lowered.
        pinned: ["StaticSound", "AudioGraphHost"],
        cpp: "StaticSound",
        reference: true,
        accessors: new Set(["state", "instanceCount", "buffer", "onEnded"]),
        bases: ["AudioEngineSound"],
    },
    { pinned: ["SoundInstance"], cpp: "SoundInstance", reference: true },
    {
        pinned: ["SoundBuffer"],
        cpp: "SoundBuffer",
        reference: true,
        accessors: new Set([
            "duration",
            "sampleRate",
            "channelCount",
            "length",
        ]),
    },
];

/**
 * The mixer records a sound and a bus share: a bus's options, the bus (an
 * engine sound the engine disposes), and the sub-graph each routes through
 * with its optional sub-node slots.
 */
const graphRecords: readonly RecordSpec[] = [
    { pinned: ["AudioBusOptions"], cpp: "AudioBusOptions", reference: false },
    { pinned: ["SoundSubGraph"], cpp: "SoundSubGraph", reference: true },
    { pinned: ["PreVolumeSlot"], cpp: "SoundPreVolumeSlot", reference: true },
    { pinned: ["AnalyzerSlot"], cpp: "SoundAnalyzerSlot", reference: true },
    {
        pinned: ["AudioBus"],
        cpp: "AudioBus",
        reference: true,
        bases: ["AudioEngineSound"],
    },
];

/**
 * Spatial audio's records: the math values it keeps at JavaScript number
 * precision, then its options, target, listener and sub-node. The listener
 * and sub-node are the engine's and the sub-graph's structural slots, which
 * `spatial.ts` asserts back to its own records.
 */
const spatialRecords: readonly RecordSpec[] = [
    {
        pinned: ["Vec3"],
        cpp: "Vec3d",
        reference: false,
        native: true,
        members: members([
            ["x", field(number)],
            ["y", field(number)],
            ["z", field(number)],
        ]),
    },
    {
        pinned: ["Quat"],
        cpp: "Vec4d",
        reference: false,
        native: true,
        members: members([
            ["x", field(number)],
            ["y", field(number)],
            ["z", field(number)],
            ["w", field(number)],
        ]),
    },
    {
        pinned: ["DecomposedTransform"],
        cpp: "DecomposedTransform",
        reference: false,
    },
    {
        pinned: ["SpatialSoundOptions"],
        cpp: "SpatialSoundOptions",
        reference: false,
    },
    { pinned: ["SpatialTarget"], cpp: "SpatialTarget", reference: true },
    {
        pinned: ["SpatialListenerSlot"],
        cpp: "SpatialListenerSlot",
        reference: true,
    },
    {
        pinned: ["SpatialListener"],
        cpp: "SpatialListener",
        reference: true,
        bases: ["SpatialListenerSlot"],
    },
    {
        pinned: ["SpatialSubNode"],
        cpp: "SpatialSubNode",
        reference: true,
        bases: ["PreVolumeSlot"],
    },
];

/** Stereo panning's records: its options and its sub-node, the sub-graph's slot. */
const stereoRecords: readonly RecordSpec[] = [
    {
        pinned: ["StereoSoundOptions"],
        cpp: "StereoSoundOptions",
        reference: false,
    },
    {
        pinned: ["StereoSubNode"],
        cpp: "StereoSubNode",
        reference: true,
        bases: ["PreVolumeSlot"],
    },
];

/** An optional part of the family, lowered when a program reaches one of its roots. */
interface FamilyPart {
    readonly roots: readonly string[];
    readonly modules: readonly string[];
    readonly records: readonly RecordSpec[];
    /** The runtime headers its lowered bodies call into. */
    readonly includes?: readonly string[];
    readonly engineMembers?: readonly (readonly [string, MemberSpec])[];
    readonly values?: readonly (readonly [string, RecordShape])[];
}

const FAMILY_PARTS: readonly FamilyPart[] = [
    {
        // Every sound and bus routes through a sub-graph into a bus.
        roots: [...STATIC_SOUND_ROOTS, ...BUS_ROOTS],
        modules: [],
        records: graphRecords,
    },
    {
        // A sound decodes on native jobs, fetches its URL, and probes a
        // format through `Audio.canPlayType`.
        roots: STATIC_SOUND_ROOTS,
        modules: [],
        records: soundRecords,
        includes: [
            "bblite/pal_audio_async.hpp",
            "bblite/pal_audio_element.hpp",
            "bblite/web_platform.hpp",
        ],
    },
    {
        roots: STEREO_ROOTS,
        modules: ["src/audio/stereo.ts"],
        records: stereoRecords,
    },
    {
        roots: SPATIAL_ROOTS,
        modules: SPATIAL_MODULES,
        records: spatialRecords,
        engineMembers: engineSpatialMembers,
        // A world matrix is single precision, as the engine keeps it.
        values: [["Mat4", typedF32]],
    },
    {
        roots: MEDIA_STREAM_ROOTS,
        modules: ["src/audio/media-stream-output.ts"],
        includes: ["bblite/pal_media_stream.hpp"],
        records: [
            {
                pinned: ["AudioEngineMediaStream"],
                cpp: "AudioEngineMediaStream",
                reference: true,
            },
        ],
    },
];

/** The parts `roots` reach. */
function partsOf(roots: readonly string[]): readonly FamilyPart[] {
    return FAMILY_PARTS.filter((part) =>
        part.roots.some((root) => roots.includes(root)),
    );
}

/** The family's modules, with the reached parts'. */
function familyModules(parts: readonly FamilyPart[]): readonly string[] {
    return [...STATIC_SOUND_MODULES, ...parts.flatMap((part) => part.modules)];
}

/** The records the library header declares, generic instances aside. */
function familyRecords(parts: readonly FamilyPart[]): string[] {
    return [
        ...engineFamilyRecords,
        ...parts.flatMap((part) => part.records),
    ].map((spec) => spec.pinned[0]!);
}

/**
 * The static-sound record model over the pinned audio modules, with the
 * modules and records of the parts `roots` reach.
 */
function staticSoundLibraryModel(
    context: LoweringContext,
    roots: readonly string[],
): PinnedRecordModel {
    const parts = partsOf(roots);
    return new PinnedRecordModel(
        context,
        context.store.program.modules([...familyModules(parts)]),
        {
            records: [
                ...webPlatformRecords,
                ...webAudioRecords,
                ...engineRecords(
                    parts.flatMap((part) => part.engineMembers ?? []),
                    parts.some((part) => part.roots === SPATIAL_ROOTS),
                ),
                ...engineFamilyRecords,
                ...parts.flatMap((part) => part.records),
            ],
            values: new Map([
                ...webPlatformValues,
                ...parts.flatMap((part) => part.values ?? []),
            ]),
            adapters: ENGINE_ADAPTERS,
            constructors: new Map([
                ...webPlatformConstructors,
                ...webAudioConstructors,
                ["AudioContext", engineContextConstructor],
            ]),
            globals: webPlatformGlobals,
            platformClasses: webAudioClasses,
            // A type-only module the bundle does not declare: the host
            // state the spatial functions read off a static sound.
            unresolved: new Map([
                ["AudioGraphHostState", record("StaticSound")],
            ]),
        },
    );
}

/** The declarations of `roots`, each in the first family module declaring it. */
function staticSoundRoots(
    model: PinnedRecordModel,
    roots: readonly string[],
): PinnedCallable[] {
    const modules = familyModules(partsOf(roots));
    return roots.map((name) => {
        const module = modules.find((candidate) =>
            model.typed
                .sourceFile(candidate)
                .statements.some(
                    (statement) =>
                        ts.isFunctionDeclaration(statement) &&
                        statement.name?.text === name,
                ),
        );
        if (!module)
            throw new Error(`No static-sound module declares '${name}'.`);
        return model.functionDeclaration(module, name);
    });
}

/**
 * The library header: the engine's records, every record the reached parts
 * declare, and the lowered functions `roots` reach, in `bbl` (the roots)
 * and the modules' detail namespaces.
 */
export function staticSoundLibraryHeader(
    context: LoweringContext,
    roots: readonly string[],
): string {
    const model = staticSoundLibraryModel(context, roots);
    const { declarations, definitions } = model.lower(
        staticSoundRoots(model, roots),
    );
    const parts = partsOf(roots);
    const records = familyRecords(parts);
    // Every struct's members, so the generic instances they name exist.
    for (const name of records)
        if (!model.isGenericRecord(name)) model.record(name).members();
    const emitted = [
        ...records,
        ...model.instantiatedRecords(),
        ...model.literalRecords(),
    ].filter(
        (name, index, names) =>
            names.indexOf(name) === index &&
            !model.record(name).spec.native &&
            !model.isGenericRecord(name),
    );
    const includes = new Set([
        "bblite/pinned_records.hpp",
        "bblite/audio_types.hpp",
        "bblite/pal_audio.hpp",
        ...parts.flatMap((part) => part.includes ?? []),
        ...model.includes,
    ]);
    return `#pragma once
// ${context.provenance(AUDIO_ENGINE, "createAudioEngineAsync")}
${[...includes].map((header) => `#include <${header}>`).join("\n")}
#include <stdexcept>
#include <string>

namespace bbl {
${model.structs(emitted)}
${declarations}
${definitions}
} // namespace bbl
`;
}
