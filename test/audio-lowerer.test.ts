import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { AudioLowerer } from "../src/lowering/audio-lowerer.js";

/**
 * The focused test `docs/fidelity.md` requires for a high-risk
 * adaptation, plus the two structural contracts the audio slice stands
 * on.
 *
 * `substituted-audio-engine` cannot be gated by a pixel, so what has to
 * be pinned is everything the port DOES take from upstream: the folded
 * engine graph asserts against the pinned declarations, and the refusals
 * that keep an unlowered behaviour from compiling to a plausible
 * substitute.
 */

function source(path: string): string {
    return readFileSync(path, "utf8");
}

test("the folded engine graph asserts against the pinned declarations", () => {
    // The whole point of the lowerer: it emits nothing, and it either
    // agrees with the pin or throws. Running it against the real pinned
    // source is the assertion.
    assert.doesNotThrow(() => {
        new AudioLowerer(new LoweringContext()).assertEngineGraphContract();
    });
});

test("the fold is gated on every statement it restates", () => {
    const lowerer = source("src/lowering/audio-lowerer.ts");
    // The two constructions the intrinsic emits...
    assert.match(lowerer, /engine\._mainOut = createMainOut\(ctx, engine\)/);
    assert.match(lowerer, /engine\._mainBus = createMainBus\("default"/);
    // ...the edges they build...
    assert.match(lowerer, /gain\.connect\(ctx\.destination\)/);
    assert.match(lowerer, /volume\.connect\(mainOut\._gain\)/);
    // ...and the statement the fold OMITS, with the default that is the
    // only reason omitting it is faithful.
    assert.match(
        lowerer,
        /setMainOutVolume\(engine\._mainOut, engine\._volume\)/,
    );
    assert.match(lowerer, /options\.volume \?\? 1/);
});

test("setMasterVolume refuses, because the pin has no un-ramped form", () => {
    // `setMainOutVolume` -> `setRampTarget` defaults to a linear curve
    // over `_rampDuration` (0.01 s), which is above `MinRampDuration` --
    // so even a no-options call schedules a curve. Emitting an
    // instantaneous write would be a substitution, not a subset.
    const intrinsic = source("src/compiler/intrinsics/audio.ts");
    assert.match(intrinsic, /setMasterVolume:/);
    assert.doesNotMatch(intrinsic, /audio_param_set_value\(/);
});

test("the Babylon sound families refuse by name rather than no-op", () => {
    const intrinsic = source("src/compiler/intrinsics/audio.ts");
    for (const name of [
        "createSoundAsync",
        "createSoundBufferAsync",
        "createStreamingSoundAsync",
        "createAudioBusAsync",
        "enableSpatial",
        "enableStereo",
        "enableAnalyzer",
        "createMicrophoneSoundSourceAsync",
        "createUnmuteUI",
        "createAudioVisualizer",
        "createAudioEngineMediaStream",
    ]) {
        assert.match(
            intrinsic,
            new RegExp(`\\b${name}:`),
            `${name} must refuse by name`,
        );
    }
});

test("the PAL header declares only what a generated scene can call", () => {
    // A contract header that carries dead surface reads as live code.
    // Each name below is one the compiler refuses, so the PAL must not
    // offer it.
    const header = source("native/include/bblite/pal_audio.hpp");
    for (const absent of [
        "audio_create_buffer",
        "audio_buffer_channel_data",
        "audio_set_source_buffer",
        "audio_create_buffer_source",
        "audio_param_set_value_curve",
        "audio_flush_connections",
    ]) {
        assert.doesNotMatch(
            header,
            new RegExp(`\\b${absent}\\b`),
            `${absent} is unreachable and must not be declared`,
        );
    }
});

test("an audio parameter handle is a value, not a minted id", () => {
    // Web Audio's contract is identity: `osc.frequency` returns the same
    // object on every read, and the pinned ramp component keeps state on
    // it. A handle minted per call would make two reads two parameters --
    // and would grow a table on every per-frame write.
    const header = source("native/include/bblite/pal_audio.hpp");
    assert.match(
        header,
        /struct AudioParamHandle \{\n    AudioNodeHandle node;\n    AudioParamName name/,
    );
    const pal = source("native/src/pal_audio_labsound.cpp");
    assert.doesNotMatch(pal, /next_param_id/);
    // The lookup is LabSound's own generic one over the Web Audio
    // spellings, not a hand-maintained cast ladder.
    assert.match(pal, /param\(spelling\(handle\.name\)\)/);
});

test("the audio thread allocates nothing", () => {
    // `feed()` runs on SDL's audio thread every few milliseconds. The
    // buses and the scratch are built in the constructor, which SDL
    // guarantees runs before any callback (the device opens paused).
    const device = source("native/src/pal_audio_sdl_device.hpp");
    const callback = device.slice(device.indexOf("SDLCALL AudioDeviceSdl3::feed") >= 0
        ? device.indexOf("SDLCALL AudioDeviceSdl3::feed")
        : device.indexOf("static void SDLCALL feed"));
    assert.doesNotMatch(callback, /scratch_\.resize/);
    assert.doesNotMatch(callback, /new lab::AudioBus/);
    assert.match(device, /scratch_\.assign/);
});
