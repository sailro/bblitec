import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    AUDIO_LIBRARY_ROOTS,
    staticSoundLibraryHeader,
} from "../src/lowering/static-sound-library.js";
import {
    audioLibraryInclude,
    FIXTURE_APPLICATION,
    native,
    runAudioProgram,
} from "./static-sound-fixture.js";
import { wave } from "./native-fixture.js";

/**
 * A mixer: buses nested under a music bus, a sound routed into one and
 * panned, sounds over a shared buffer and a URL list, a meter reading a
 * sound, a named source routed into a bus, re-volumed and re-panned with
 * ramps, a bus disposed, then the engine with the rest.
 */
const APPLICATION = `
import {
    createAudioBusAsync, createAudioEngineAsync, createSoundAsync, createSoundBufferAsync, createSoundSourceAsync,
    disposeAudioBus, disposeSoundSource, setSoundSourceVolume,
    disposeAudioEngine, enableAnalyzer, enableStereo, getByteFrequencyData, getFloatTimeDomainData, playSound,
    setBusVolume, setStereoPan, type AudioBus, type AudioBusOptions,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const engine = await createAudioEngineAsync();
    const music = await createAudioBusAsync(engine, "music", { volume: 0.5 });
    const options: AudioBusOptions = { outBus: music, volume: 0.8 };
    const effects: AudioBus = await createAudioBusAsync(engine, "effects", options);
    if (effects.name !== "effects") throw new Error("bus name");
    const sound = await createSoundAsync(engine, "/assets/sfx/tone.wav", { outBus: effects, loop: true });
    enableStereo(sound, { pan: -0.5 });
    playSound(sound);
    // A buffer from a URL list, shared by a sound; a sound from a list.
    const buffer = await createSoundBufferAsync(engine, ["/assets/sfx/hum.wav", "/assets/sfx/tone.wav"]);
    if (buffer.duration !== 0.5 || buffer.channelCount !== 1 || buffer.length !== buffer.sampleRate / 2)
        throw new Error("buffer shape");
    const replay = await createSoundAsync(engine, buffer, { outBus: music });
    const listed = await createSoundAsync(engine, ["/assets/sfx/tone.wav"], { skipCodecCheck: true });
    playSound(replay);
    playSound(listed);
    // The sound's spectrum and waveform, read by a meter.
    enableAnalyzer(sound, { fftSize: 512, smoothing: 0.5 });
    const bins = new Uint8Array(256);
    const waveform = new Float32Array(512);
    getByteFrequencyData(sound, bins);
    getFloatTimeDomainData(sound, waveform);
    if (waveform.some((sample) => Math.abs(sample) > 1)) throw new Error("waveform range");
    // A node the program built, routed as a named source into the music bus.
    const input = await createSoundSourceAsync(engine, engine.audioContext.createGain(), {
        name: "input",
        volume: 0.5,
        outBus: music,
    });
    if (input.name !== "input") throw new Error("source name");
    setSoundSourceVolume(input, 0.25, { duration: 0.05 });
    disposeSoundSource(input);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    setBusVolume(music, 0.25, { duration: 0.05 });
    setStereoPan(sound, 0.5, { duration: 0.05 });
    disposeAudioBus(effects);
    disposeAudioEngine(engine);
    globalThis.close();
}
void main();
`;

test("buses, stereo, sound buffers, analyzers and sound sources compile strictly and run natively", (t) => {
    const output = resolve("artifacts/audio-mixer-application");
    const sounds = join(output, "public/assets/sfx");
    mkdirSync(sounds, { recursive: true });
    writeFileSync(join(sounds, "tone.wav"), wave(0.5, 0.5));
    writeFileSync(join(sounds, "hum.wav"), wave(0.5, 0.25));
    const result = compileSource(APPLICATION, {
        fileName: join(output, "entry.ts"),
        publicDir: join(output, "public"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    for (const feature of [
        "audio:pinned-engine",
        "audio:stereo-panner",
        "audio:analyser",
    ])
        assert.ok(result.manifest.features.includes(feature), feature);
    for (const root of [
        "createAudioBusAsync",
        "setBusVolume",
        "disposeAudioBus",
        "enableStereo",
        "setStereoPan",
        "createSoundBufferAsync",
        "enableAnalyzer",
        "getByteFrequencyData",
        "getFloatTimeDomainData",
        "createSoundSourceAsync",
        "setSoundSourceVolume",
        "disposeSoundSource",
    ])
        assert.ok(result.manifest.audioLibraryRoots?.includes(root), root);
    // The engine's disposal releases its buses as the pin's does.
    assert.match(result.cpp, /engine\.buses\.clear\(\)/);
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    for (const asset of result.manifest.assets) {
        const destination = join(output, "assets", asset.output);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(resolve(output, asset.source), destination);
    }
    const library = audioLibraryInclude(
        "audio-mixer-application",
        result.manifest,
    );
    writeFileSync(join(output, "program.hpp"), result.cpp);
    writeFileSync(
        join(output, "check.cpp"),
        `#include "pal_audio_labsound.cpp"
#include <bblite/pal_audio_async.hpp>
#define main generated_main
#include "program.hpp"
#undef main
const char* bbl::pal::bblite_build_stamp() { return "audio-mixer-application"; }
${FIXTURE_APPLICATION}`,
    );
    assert.equal(
        runAudioProgram(
            output,
            join(output, "check.cpp"),
            [
                "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1",
                "/DBBLITE_HAS_AUDIO_ANALYSER=1",
                ...library,
            ],
            [],
        ),
        "",
    );
});

test("buses, stereo, sound buffers, analysers and sound sources in a LabSound capture", (t) => {
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/audio-mixer-capture");
    mkdirSync(output, { recursive: true });
    writeFileSync(
        join(output, "library.hpp"),
        staticSoundLibraryHeader(sharedPinnedContext(), AUDIO_LIBRARY_ROOTS),
    );
    const wav = join(output, "tone.wav");
    writeFileSync(wav, wave(1, 0.5));
    const broken = join(output, "broken.wav");
    writeFileSync(broken, "not audio");
    const sine = join(output, "sine.wav");
    writeFileSync(
        sine,
        wave(1, (time) => 0.5 * Math.sin(2 * Math.PI * 1500 * time)),
    );
    const lines = runAudioProgram(
        output,
        "test/fixtures/audio-mixer-capture-check.cpp",
        [
            "/DBBLITE_AUDIO_CAPTURE=1",
            "/DBBLITE_HAS_AUDIO_PANNER=1",
            "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1",
            "/DBBLITE_HAS_AUDIO_ANALYSER=1",
            "/DBBLITE_HAS_AUDIO_MEDIA_STREAM=1",
        ],
        [wav, broken, sine],
    )
        .replaceAll("\r\n", "\n")
        .trimEnd()
        .split("\n");
    const levels = new Map(
        lines.map((line) => {
            const [name, ...values] = line.split(" ");
            return [name!, values] as const;
        }),
    );
    const at = (name: string): readonly string[] => {
        const level = levels.get(name);
        assert.ok(level, `${name} missing from ${lines.join(" | ")}`);
        return level;
    };
    const near = (name: string, left: number, right: number): void => {
        const [l, r] = at(name).slice(-2).map(Number);
        assert.ok(
            Math.abs(l! - left) < 0.005 && Math.abs(r! - right) < 0.005,
            lines.join(" | "),
        );
    };
    assert.deepEqual(at("buses"), ["2", "music", "effects"]);
    // A 0.5 mono sound, up-mixed to both channels, through two half-volume
    // buses; the outer bus restored; the inner one faded out and back.
    near("nested", 0.125, 0.125);
    near("music", 0.25, 0.25);
    near("faded", 0, 0);
    near("restored", 0.5, 0.5);
    // A disposed bus carries nothing.
    assert.deepEqual(at("remaining"), ["1"]);
    near("disposed", 0, 0);
    // Equal-power panning: all right, all left, cos 45 degrees each.
    near("pan-right", 0, 0.5);
    near("pan-left", 0.5, 0);
    near("pan-centre", 0.5 * Math.SQRT1_2, 0.5 * Math.SQRT1_2);
    // One second of mono at the context's rate, from the list's WAVE file;
    // the unchecked list records the undecodable format and recovers.
    assert.deepEqual(at("buffer"), ["1.000", "48000", "1", "48000"]);
    assert.deepEqual(at("recovered"), ["1.000", "1"]);
    near("buffered", 0.5, 0.5);
    assert.deepEqual(at("shared"), ["1"]);
    // The pin's analyser defaults, read back from the node.
    assert.deepEqual(at("analyser"), [
        "-100.000",
        "-30.000",
        "0.800",
        "2048.000",
        "1024.000",
    ]);
    // The sine's bin leads both spectra; its waveform peaks at 0.5, 64 to
    // 192 as bytes.
    assert.deepEqual(at("spectrum"), ["64", "64"]);
    const [top, lowest, highest] = at("waveform").map(Number);
    assert.ok(
        Math.abs(top! - 0.5) < 0.005 &&
            Math.abs(lowest! - 64) <= 1 &&
            Math.abs(highest! - 192) <= 1,
        lines.join(" | "),
    );
    assert.deepEqual(at("reconfigured"), [
        "-90.000",
        "-10.000",
        "0.500",
        "1024.000",
        "512.000",
    ]);
    assert.deepEqual(at("refused"), ["IndexSizeError"]);
    // A 0.5 node at its options' half volume, then full; disposal leaves
    // the engine and the output.
    assert.deepEqual(at("source").slice(0, 2), ["input", "1"]);
    near("source", 0.25, 0.25);
    near("source-volume", 0.5, 0.5);
    assert.equal(at("source-disposed")[0], "0");
    assert.deepEqual(at("source-disposed").slice(1).map(Number), [0, 0]);
    near("unrouted", 0, 0);
    assert.deepEqual(at("stream"), ["live"]);
    assert.deepEqual(at("stream-disposed"), ["ended"]);
});

test("a sound source that is not a packaged URL list refuses", () => {
    assert.throws(
        () =>
            compileSource(`
import { createAudioEngineAsync, createSoundBufferAsync } from "@babylonjs/lite";
async function main(urls: string[]): Promise<void> {
    const engine = await createAudioEngineAsync();
    await createSoundBufferAsync(engine, urls);
}
void main([]);
`),
        /createSoundBufferAsync takes a packaged URL, an array literal of packaged URLs/,
    );
});

test("an outBus that is not a created bus refuses", () => {
    assert.throws(
        () =>
            compileSource(`
import { createAudioEngineAsync, createSoundAsync } from "@babylonjs/lite";
async function main(): Promise<void> {
    const engine = await createAudioEngineAsync();
    await createSoundAsync(engine, new ArrayBuffer(8), { outBus: engine as never });
}
void main();
`),
        /'outBus' option must be an AudioBus created by createAudioBusAsync/,
    );
});
