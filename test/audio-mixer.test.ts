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
 * panned, re-volumed and re-panned with ramps, a bus disposed, then the
 * engine with the rest.
 */
const APPLICATION = `
import {
    createAudioBusAsync, createAudioEngineAsync, createSoundAsync, disposeAudioBus, disposeAudioEngine,
    enableStereo, playSound, setBusVolume, setStereoPan, type AudioBus, type AudioBusOptions,
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
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    setBusVolume(music, 0.25, { duration: 0.05 });
    setStereoPan(sound, 0.5, { duration: 0.05 });
    disposeAudioBus(effects);
    disposeAudioEngine(engine);
    globalThis.close();
}
void main();
`;

test("buses and stereo panning compile strictly and run natively", (t) => {
    const output = resolve("artifacts/audio-mixer-application");
    const sounds = join(output, "public/assets/sfx");
    mkdirSync(sounds, { recursive: true });
    writeFileSync(join(sounds, "tone.wav"), wave(0.5, 0.5));
    const result = compileSource(APPLICATION, {
        fileName: join(output, "entry.ts"),
        publicDir: join(output, "public"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    for (const feature of ["audio:pinned-engine", "audio:stereo-panner"])
        assert.ok(result.manifest.features.includes(feature), feature);
    for (const root of [
        "createAudioBusAsync",
        "setBusVolume",
        "disposeAudioBus",
        "enableStereo",
        "setStereoPan",
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
            ["/DBBLITE_HAS_AUDIO_STEREO_PANNER=1", ...library],
            [],
        ),
        "",
    );
});

test("buses mix, ramp and release and stereo pans in a LabSound capture", (t) => {
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
    const lines = runAudioProgram(
        output,
        "test/fixtures/audio-mixer-capture-check.cpp",
        [
            "/DBBLITE_AUDIO_CAPTURE=1",
            "/DBBLITE_HAS_AUDIO_PANNER=1",
            "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1",
        ],
        [wav],
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
        const [l, r] = at(name).map(Number);
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
