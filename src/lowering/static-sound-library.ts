/**
 * The pin's static-sound family lowered whole: `static-sound.ts` and the
 * modules it reaches (the sound buffer, sub-graph, ramped parameters,
 * signals, buses), as one `PinnedRecordModel`.
 *
 * Web Audio is the application surface's own (`webAudioRecords`); the
 * engine is the native `bbl::AudioEngineHandle` the engine intrinsic
 * builds (`bblite/audio_types.hpp`), read through views of its fields: its
 * context and clock, its main bus (whose `_in`/`_out` are the bus gain),
 * its shared `_sounds` set (every sound is an `AudioEngineSound`, so
 * `disposeAudioEngine` disposes sounds and sources alike), its ramp
 * duration and format probes. The engine reports no statechange, so
 * subscribing to it -- a looped sound started while the context is not
 * running -- refuses at run time.
 *
 * Spatial audio (`spatial.ts`) joins the model when a program reaches it,
 * as the pin tree-shakes it: a panner sub-node per sound and the engine's
 * listener over the context's `AudioListener`. A host is a static sound,
 * the one host this surface lowers; the engine keeps the listener and the
 * attached nodes' updates in its native handle.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    PinnedRecordModel,
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

/** Every module the static-sound roots reach. */
export const STATIC_SOUND_MODULES = [
    STATIC_SOUND,
    "src/audio/sound-buffer.ts",
    "src/audio/sound-sub-graph.ts",
    "src/audio/audio-param.ts",
    "src/audio/audio-signal.ts",
    "src/audio/audio-bus.ts",
    "src/audio/bus.ts",
    "src/audio/audio-fetch.ts",
    "src/audio/audio-engine.ts",
] as const;

/** The modules spatial audio adds, decomposing an attached target's matrix. */
export const SPATIAL_MODULES = [
    "src/audio/spatial.ts",
    "src/math/decompose-mat4.ts",
    "src/math/create-quat-from-rotation-mat4.ts",
    "src/math/mat4-determinant3.ts",
] as const;

/** The public functions a program calls, each lowered with what it reaches. */
export const STATIC_SOUND_ROOTS = [
    "createSoundAsync",
    "playSound",
    "stopSound",
    "setSoundVolume",
    "disposeSound",
] as const;

/** The spatial functions a program calls. */
export const SPATIAL_ROOTS = [
    "enableSpatial",
    "setSpatialPosition",
    "setSpatialListenerPosition",
] as const;

const { number, string, void: none } = recordScalars;
const typedF32: RecordShape = { kind: "typed", element: "f32" };
const node = record("AudioNode");
const engineRead = (shape: RecordShape, native: string): MemberSpec =>
    reads(shape, (owner) => `${native}(${owner}.context)`);

/**
 * The engine's spatial state: the listener its slot holds (the lowered
 * listener, type-erased in the native handle) and the attached nodes'
 * per-frame updates.
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
    [
        "_spatialUpdaters",
        field({ kind: "set", element: fn([], none) }, "spatial_updaters"),
    ],
];

/** The engine record and the views of it the pin's bodies take. */
const engineRecords = (spatial: boolean): readonly RecordSpec[] => [
    {
        // `RampClock` is the engine seen as a clock (`createRampParam`).
        pinned: ["AudioEngine", "RampClock"],
        cpp: "AudioEngineHandle",
        reference: false,
        native: true,
        members: members([
            [
                "_ctx",
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
            ["_mainBus", reads(record("MainBus"), (owner) => owner)],
            [
                "_sounds",
                field(
                    { kind: "set", element: record("AudioEngineSound") },
                    "sources",
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
            ...(spatial ? engineSpatialMembers : []),
        ]),
    },
    {
        // `createMainBus`'s bus: its volume gain is its input and output.
        pinned: ["MainBus"],
        cpp: "AudioEngineHandle",
        reference: false,
        native: true,
        members: members(
            ["_in", "_out", "_volume"].map((name) => [
                name,
                reads(node, (owner) => `${owner}.main_bus`),
            ]),
        ),
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
 * The family's own records, emitted from the pin's declarations: the
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
    { pinned: ["RampOptions"], cpp: "RampOptions", reference: false },
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
    { pinned: ["SoundSubGraph"], cpp: "SoundSubGraph", reference: true },
    { pinned: ["RampParam"], cpp: "RampParam", reference: true },
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
    { pinned: ["PreVolumeSlot"], cpp: "SoundPreVolumeSlot", reference: true },
    { pinned: ["AnalyzerSlot"], cpp: "SoundAnalyzerSlot", reference: true },
    { pinned: ["AudioBus"], cpp: "AudioBus", reference: true },
    {
        pinned: ["AudioSignalImpl", "AudioSignal"],
        cpp: "AudioSignal",
        reference: true,
    },
    { pinned: ["Entry"], cpp: "AudioSignalEntry", reference: true },
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

/** Whether `roots` reach spatial audio. */
function reachesSpatial(roots: readonly string[]): boolean {
    return roots.some((root) =>
        (SPATIAL_ROOTS as readonly string[]).includes(root),
    );
}

/** The family's modules: spatial audio's when it is reached. */
function familyModules(spatial: boolean): readonly string[] {
    return [...STATIC_SOUND_MODULES, ...(spatial ? SPATIAL_MODULES : [])];
}

/** The records the library header declares, generic instances aside. */
function familyRecords(spatial: boolean): string[] {
    return [...soundRecords, ...(spatial ? spatialRecords : [])].map(
        (spec) => spec.pinned[0]!,
    );
}

/** The records the static-sound header declares without spatial audio. */
export const STATIC_SOUND_RECORDS = familyRecords(false);

/**
 * The static-sound record model over the pinned audio modules, with
 * spatial audio's when `spatial`.
 */
export function staticSoundLibraryModel(
    context: LoweringContext,
    spatial = false,
): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([...familyModules(spatial)]),
        {
            records: [
                ...webPlatformRecords,
                ...webAudioRecords,
                ...engineRecords(spatial),
                ...soundRecords,
                ...(spatial ? spatialRecords : []),
            ],
            // A world matrix is single precision, as the engine keeps it.
            values: new Map([
                ...webPlatformValues,
                ...(spatial ? ([["Mat4", typedF32]] as const) : []),
            ]),
            adapters: new Map(),
            constructors: new Map([
                ...webPlatformConstructors,
                ...webAudioConstructors,
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
export function staticSoundRoots(
    model: PinnedRecordModel,
    roots: readonly string[] = STATIC_SOUND_ROOTS,
): PinnedCallable[] {
    const modules = familyModules(reachesSpatial(roots));
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
 * The library header: every record the roots reach and the lowered
 * functions over them, in `bbl` (the roots) and the modules' detail
 * namespaces.
 */
export function staticSoundLibraryHeader(
    context: LoweringContext,
    roots: readonly string[] = STATIC_SOUND_ROOTS,
): string {
    const spatial = reachesSpatial(roots);
    const model = staticSoundLibraryModel(context, spatial);
    const { declarations, definitions } = model.lower(
        staticSoundRoots(model, roots),
    );
    const records = familyRecords(spatial);
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
    const includes = [
        "bblite/pinned_records.hpp",
        "bblite/audio_types.hpp",
        "bblite/pal_audio.hpp",
        "bblite/pal_audio_async.hpp",
        "bblite/pal_audio_element.hpp",
        "bblite/web_platform.hpp",
        ...model.includes,
    ];
    return `#pragma once
// ${context.provenance(STATIC_SOUND, "createSoundAsync")}
${includes.map((header) => `#include <${header}>`).join("\n")}
#include <stdexcept>
#include <string>

namespace bbl {
${model.structs(emitted)}
${declarations}
${definitions}
} // namespace bbl
`;
}
