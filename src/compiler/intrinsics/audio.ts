// The audio family.
//
// **Where the seam is, and why it is here.** Babylon Lite's audio module
// (`packages/babylon-lite/src/audio/`) is a behavioural port of AudioV2
// that touches exactly one platform surface -- the Web Audio API -- and
// nothing else. So the boundary the pin itself draws is `AudioContext` /
// `GainNode` / `AudioParam`, the same shape `createHavokWorld(scene, hknp)`
// draws around `HP_*`, and that is what `bblite/pal_audio.hpp` mirrors.
//
// **What the corpus reaches.** No `sceneNNN` scene uses audio at all. The
// reach is upstream's seven GAME demos -- tetris, quake, doom, minecraft,
// platformer, racer, sandblox -- which use the Lite engine for lifecycle
// only (`createAudioEngineAsync`, `engine.audioContext`,
// `createSoundSourceAsync`, `unlockAudioEngineAsync`) and then synthesise
// their own graph directly on the context. The eighth consumer is
// `audio-demo.ts`, the audio module's own Tier-4 showcase, and it is the
// one place `createSoundAsync`/`playSound`, the microphone, the
// visualizer and the unmute UI are reached at all -- upstream marks it
// manual and non-deterministic, never a gate. So this file lowers the raw
// Web Audio calls beside the engine functions, and refuses the
// sound/bus/spatial half by name: nothing gated reaches it.
//
// **What is still owed.** `createAudioEngineAsync` builds the two-gain
// output graph (`mainBus -> mainOut -> destination`) that the pinned
// `bus.ts` declares. That is Babylon behaviour and belongs in generated
// code lowered from those declarations, exactly as `havok.ts` is; this
// module folds the shape instead, and `src/lowering/audio-lowerer.ts`
// asserts every rule of the fold against the pinned declaration that
// states it, so a moved contract fails generation rather than drifting.
// Everything the fold cannot state faithfully refuses by name --
// `setMasterVolume` above all, because the pin has no un-ramped form of
// it and emitting one would be a substitution wearing a subset's
// clothes.
import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { refuseAudioName } from "../audio-surface.js";

export interface AudioIntrinsicContext extends IntrinsicCallContext {
    fail(node: ts.Node, message: string): never;
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
}

/**
 * The Lite engine functions a reached scene calls. Everything else the
 * barrel exports -- the whole static/streaming sound family, buses,
 * spatial, stereo, the analyzer, the unmute UI, the visualizer and the
 * media-stream tap -- refuses by name, because none of it is lowered and
 * a silent no-op would be a scene that renders without sounding.
 */
const REFUSED_BY_NAME: Readonly<Record<string, string>> = {
    createSoundAsync:
        "the StaticSound family is not lowered: its buffer, instance " +
        "lifecycle and sub-graph are Babylon behaviour with no generated " +
        "form yet. The reached slice is the engine plus a caller-built " +
        "Web Audio graph",
    createSoundBufferAsync:
        "decoding an audio file is an asset question, and no audio asset " +
        "is materialized at generation yet",
    createStreamingSoundAsync:
        "streaming sounds wrap an HTMLAudioElement, which a native build " +
        "has no equivalent for.",
    createAudioBusAsync:
        "buses are Babylon routing behaviour and are not lowered",
    enableSpatial:
        "spatial audio is not lowered; the PannerNode surface exists but " +
        "the pin's attachment and update behaviour does not",
    enableStereo: "stereo panning is not lowered",
    enableAnalyzer: "the analyzer is not lowered",
    createMicrophoneSoundSourceAsync:
        "microphone capture needs a device-permission contract this " +
        "runtime does not have",
    createUnmuteUI: "the unmute UI is a DOM button",
    createAudioVisualizer: "the visualizer draws through canvas2D",
    createAudioEngineMediaStream:
        "the media-stream tap is a browser pipeline",
    setMasterVolume:
        "the pin has no un-ramped form of it. `setMainOutVolume` goes " +
        "through `setRampTarget`, whose shape defaults to `\"linear\"` and " +
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

    switch (importedName) {
        case "createAudioEngineAsync": {
            // `AudioEngineOptions` carries the context to adopt, the
            // master volume, the ramp duration and three browser
            // auto-resume switches. The reached slice takes none of them:
            // an offline context is generation's choice rather than a
            // scene's, and the resume hooks are `document.addEventListener`
            // and `setInterval`, which erase.
            context.expectArgumentCount(call, 0, 1);
            if (call.arguments[0]) {
                context.expectObjectLiteral(call.arguments[0]);
                context.fail(
                    call.arguments[0],
                    "createAudioEngineAsync options are not lowered; the " +
                        "reached calls pass none.",
                );
            }
            context.reachFeature("audio:engine", call);

            const engine =
                context.allocateTemporaryCppName("audio_engine");
            // The pin's own output graph, from `bus.ts`:
            //   createMainOut  -- a GainNode connected to ctx.destination
            //   createMainBus  -- a GainNode connected to mainOut._gain
            // A sound source connects into `mainBus._in`, which is that
            // second gain. Two nodes, and the shape is the contract.
            context.emit(
                `const bbl::pal::AudioContextHandle ${engine}_ctx = ` +
                    `bbl::pal::audio_create_context();`,
            );
            context.emit(
                `const bbl::pal::AudioNodeHandle ${engine}_main_out = ` +
                    `bbl::pal::audio_create_gain(${engine}_ctx);`,
            );
            context.emit(
                `bbl::pal::audio_connect(${engine}_main_out, ` +
                    `bbl::pal::audio_destination(${engine}_ctx));`,
            );
            context.emit(
                `const bbl::pal::AudioNodeHandle ${engine}_main_bus = ` +
                    `bbl::pal::audio_create_gain(${engine}_ctx);`,
            );
            context.emit(
                `bbl::pal::audio_connect(${engine}_main_bus, ${engine}_main_out);`,
            );
            return {
                kind: "audio-engine",
                cpp: `${engine}_ctx`,
                audioContextCpp: `${engine}_ctx`,
                audioMainBusCpp: `${engine}_main_bus`,
            };
        }

        case "unlockAudioEngineAsync": {
            // `ctx.resume()` behind the pin's own `state !== "running"`
            // guard, which the PAL's resume already carries.
            context.expectArgumentCount(call, 1, 1);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "audio-engine", call.arguments[0]!);
            return {
                kind: "void",
                cpp: `bbl::pal::audio_resume(${engine.cpp})`,
            };
        }

        case "disposeAudioEngine": {
            context.expectArgumentCount(call, 1, 1);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "audio-engine", call.arguments[0]!);
            return {
                kind: "void",
                cpp: `bbl::pal::audio_close_context(${engine.cpp})`,
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
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "audio-engine", call.arguments[0]!);
            const node = context.compileValue(call.arguments[1]!);
            context.expectKind(node, "audio-node", call.arguments[1]!);
            if (call.arguments[2]) {
                context.expectObjectLiteral(call.arguments[2]);
                context.fail(
                    call.arguments[2],
                    "createSoundSourceAsync options are not lowered; the " +
                        "reached calls pass none.",
                );
            }
            const mainBus = engine.audioMainBusCpp;
            if (!mainBus) {
                context.fail(
                    call.arguments[0]!,
                    "Audio engine value carries no main bus.",
                );
            }
            const source =
                context.allocateTemporaryCppName("audio_source");
            context.emit(
                `const bbl::pal::AudioNodeHandle ${source} = ` +
                    `bbl::pal::audio_create_gain(${engine.cpp});`,
            );
            context.emit(
                `bbl::pal::audio_connect(${source}, ${mainBus});`,
            );
            context.emit(
                `bbl::pal::audio_connect(${node.cpp}, ${source});`,
            );
            return {
                kind: "audio-node",
                cpp: source,
                audioContextCpp: engine.cpp,
            };
        }

        default:
            return undefined;
    }
}
