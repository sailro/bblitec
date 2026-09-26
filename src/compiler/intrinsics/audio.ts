import type { LoweringServices } from "../lowering-services.js";
// Babylon's engine/source lifecycle retains the Web Audio context, output
// routing, and sound ownership. The volume-only output graph is checked by
// audio-lowerer; source disposal is lowered from the pinned declarations.
// Unreached sound, bus, and spatial behavior remains an explicit refusal.
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { refuseAudioName } from "../audio-surface.js";
import { EmissionWeakMap } from "../emission-transaction.js";
import { lowerAudioSourceDisposal } from "../../lowering/audio-source-lowerer.js";

export interface AudioIntrinsicContext
    extends
        IntrinsicCallContext,
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
        > {}

const sourceDisposers = new EmissionWeakMap<object, string>();
function sourceDisposer(context: AudioIntrinsicContext): string {
    const existing = sourceDisposers.get(context);
    if (existing) return existing;
    const name = context.allocateTemporaryCppName("dispose_audio_source");
    const lowered = lowerAudioSourceDisposal(name);
    context.nativeEmission.registerNativeFunction(
        lowered.prototype,
        lowered.lines,
    );
    const cpp = `bblscene::${name}`;
    sourceDisposers.set(context, cpp);
    return cpp;
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
    createAudioEngineMediaStream: "the media-stream tap is a browser pipeline",
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
    if (value?.dataType?.kind === "optional") {
        context.emit(
            `if ((${value.cpp}).has_value()) throw std::runtime_error("${name} options are not lowered");`,
        );
        return;
    }
    context.fail(
        argument,
        `${name} options are not lowered; the reached calls pass none.`,
    );
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

    switch (importedName) {
        case "createAudioEngineAsync": {
            // `AudioEngineOptions` carries the context to adopt, the
            // master volume, the ramp duration and three browser
            // auto-resume switches. The reached slice takes none of them:
            // an offline context is generation's choice rather than a
            // scene's, and that option path installs its own document
            // listeners plus polling. Application `setInterval` calls are
            // separate platform input and run on the frame conductor.
            context.expectArgumentCount(call, 0, 1);
            requireAbsentOptions(context, call.arguments[0], importedName);
            context.reachFeature("audio:engine", call);

            const engine = context.allocateTemporaryCppName("audio_engine");
            // The pin's own output graph, from `bus.ts`:
            //   createMainOut  -- a GainNode connected to ctx.destination
            //   createMainBus  -- a GainNode connected to mainOut._gain
            // A sound source connects into `mainBus._in`, which is that
            // second gain. Two nodes, and the shape is the contract.
            context.emit({
                kind: "declaration",
                type: "bbl::pal::AudioContextHandle",
                name: `${engine}_ctx`,
                initializer: `bbl::pal::audio_create_context(${context.audioSessionCpp()})`,
            });
            context.emit({
                kind: "declaration",
                type: "const bbl::pal::AudioNodeHandle",
                name: `${engine}_main_out`,
                initializer: `bbl::pal::audio_create_gain(${engine}_ctx)`,
            });
            context.emit({
                kind: "expression",
                code:
                    `bbl::pal::audio_connect(${engine}_main_out, ` +
                    `bbl::pal::audio_destination(${engine}_ctx));`,
            });
            context.emit({
                kind: "declaration",
                type: "bbl::pal::AudioNodeHandle",
                name: `${engine}_main_bus`,
                initializer: `bbl::pal::audio_create_gain(${engine}_ctx)`,
            });
            context.emit({
                kind: "expression",
                code: `bbl::pal::audio_connect(${engine}_main_bus, ${engine}_main_out);`,
            });
            context.registerNativeTemporary(`${engine}_ctx`);
            context.registerNativeTemporary(`${engine}_main_bus`);
            return {
                kind: "audio-engine",
                cpp: `bbl::AudioEngineHandle{${engine}_ctx, ${engine}_main_bus}`,
                dataType: { kind: "handle", handle: "audio-engine" },
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
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "audio-engine", argumentAt(call, 0));
            const node = context.compileValue(argumentAt(call, 1));
            context.expectKind(node, "audio-node", argumentAt(call, 1));
            requireAbsentOptions(context, call.arguments[2], importedName);
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
                initializer: `bbl::js::make_gc_shared<bbl::AudioSourceState>(bbl::AudioSourceState{${node.cpp}, ${source}, ${engine.cpp}})`,
            });
            context.emit(`(${engine.cpp}).sources.add(${stored});`);
            return {
                kind: "audio-source",
                cpp: stored,
                dataType: { kind: "handle", handle: "audio-source" },
                requiresExplicitDiscard: true,
            };
        }

        default:
            return undefined;
    }
}
