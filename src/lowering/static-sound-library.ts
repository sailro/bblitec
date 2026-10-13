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

/** The public functions a program calls, each lowered with what it reaches. */
export const STATIC_SOUND_ROOTS = [
    "createSoundAsync",
    "playSound",
    "stopSound",
    "setSoundVolume",
    "disposeSound",
] as const;

const { number, string, void: none } = recordScalars;
const node = record("AudioNode");
const engineRead = (shape: RecordShape, native: string): MemberSpec =>
    reads(shape, (owner) => `${native}(${owner}.context)`);

/** The engine record and the views of it the pin's bodies take. */
const engineRecords: readonly RecordSpec[] = [
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
        pinned: ["StaticSound"],
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

/** The records the library header declares, generic instances aside. */
export const STATIC_SOUND_RECORDS = soundRecords.map((spec) => spec.pinned[0]!);

/** The static-sound record model over the pinned audio modules. */
export function staticSoundLibraryModel(
    context: LoweringContext,
): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([...STATIC_SOUND_MODULES]),
        {
            records: [
                ...webPlatformRecords,
                ...webAudioRecords,
                ...engineRecords,
                ...soundRecords,
            ],
            values: webPlatformValues,
            adapters: new Map(),
            constructors: new Map([
                ...webPlatformConstructors,
                ...webAudioConstructors,
            ]),
            globals: webPlatformGlobals,
            platformClasses: webAudioClasses,
        },
    );
}

/** The declarations of `roots`, each in the first family module declaring it. */
export function staticSoundRoots(
    model: PinnedRecordModel,
    roots: readonly string[] = STATIC_SOUND_ROOTS,
): PinnedCallable[] {
    return roots.map((name) => {
        const module = STATIC_SOUND_MODULES.find((candidate) =>
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
    const model = staticSoundLibraryModel(context);
    const { declarations, definitions } = model.lower(
        staticSoundRoots(model, roots),
    );
    // Every struct's members, so the generic instances they name exist.
    for (const name of STATIC_SOUND_RECORDS)
        if (!model.isGenericRecord(name)) model.record(name).members();
    const emitted = [
        ...STATIC_SOUND_RECORDS,
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
