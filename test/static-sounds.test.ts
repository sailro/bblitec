import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    ENGINE_ROOTS,
    STATIC_SOUND_ROOTS,
    staticSoundLibraryHeader,
} from "../src/lowering/static-sound-library.js";
import {
    audioLibraryInclude,
    FIXTURE_APPLICATION,
    native,
    runAudioProgram,
    wave,
} from "./static-sound-fixture.js";

/**
 * The application's shapes: one lazily shared engine on its own context;
 * one-shot effects and an environmental loop, each a sound created from a
 * base-relative URL built at run time from a caller's asset path, played
 * with per-play overrides, re-volumed, stopped and disposed from closures.
 */
const APPLICATION = `
import {
    createAudioEngineAsync, createSoundAsync, disposeSound, playSound, setSoundVolume, stopSound,
    type AudioEngine, type StaticSound,
} from "@babylonjs/lite";

const BASE = import.meta.env.BASE_URL;
const appUrl = (path: string): string => BASE + path.replace(/^\\/+/, "");

let enginePromise: Promise<AudioEngine> | null = null;
function sharedEngine(): Promise<AudioEngine> {
    if (!enginePromise) {
        const context = new AudioContext();
        enginePromise = createAudioEngineAsync({ audioContext: context }).then((engine) => engine);
    }
    return enginePromise;
}

interface SfxHandle { play(): void; dispose(): void; }

function createSfx(assetPath: string, opts: { volume?: number; maxInstances?: number; rate?: number }): SfxHandle {
    let engine: AudioEngine | null = null;
    let sound: StaticSound | null = null;
    let disposed = false;
    const baseVolume = opts.volume ?? 1;
    void (async () => {
        const e = await sharedEngine();
        const s = await createSoundAsync(e, appUrl(assetPath), { volume: baseVolume * 1, maxInstances: opts.maxInstances ?? 4 });
        if (disposed) { disposeSound(s); return; }
        engine = e;
        sound = s;
    })();
    return {
        play(): void {
            if (!engine || !sound) return;
            playSound(sound, { playbackRate: opts.rate ?? 1 });
        },
        dispose(): void {
            disposed = true;
            if (sound) { disposeSound(sound); sound = null; }
        },
    };
}

interface LoopHandle { update(on: boolean, level: number): void; dispose(): void; }

function createLoop(assetPath: string): LoopHandle {
    let sound: StaticSound | null = null;
    let playing = false;
    let wanted = false;
    const apply = (): void => {
        if (!sound) return;
        if (!wanted) {
            if (playing) { stopSound(sound); playing = false; }
            return;
        }
        if (!playing) { playSound(sound, { loop: true }); playing = true; }
    };
    void (async () => {
        const e = await sharedEngine();
        const s = await createSoundAsync(e, appUrl(assetPath), { loop: true, maxInstances: 1, volume: 0.5 });
        sound = s;
        apply();
    })();
    return {
        update(on: boolean, level: number): void {
            wanted = on;
            if (sound) setSoundVolume(sound, 0.5 * level);
            apply();
        },
        dispose(): void {
            wanted = false;
            if (sound) { disposeSound(sound); sound = null; }
            playing = false;
        },
    };
}

// The application runs in its realm: a timer yield stands for the rest of it.
async function main(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sfx = createSfx("/assets/sfx/tone.wav", { volume: 0.8, rate: 1.25 });
    const loop = createLoop("/assets/sfx/hum.wav");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    sfx.play();
    loop.update(true, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    loop.update(true, 0.5);
    loop.update(false, 0.5);
    sfx.dispose();
    loop.dispose();
    globalThis.close();
}
void main();
`;

test("the application's static sounds compile strictly and run natively over packaged audio", (t) => {
    const output = resolve("artifacts/static-sounds-application");
    const sounds = join(output, "public/assets/sfx");
    mkdirSync(sounds, { recursive: true });
    writeFileSync(join(sounds, "tone.wav"), wave(0.5, 0.5));
    writeFileSync(join(sounds, "hum.wav"), wave(0.25, 0.5));
    const result = compileSource(APPLICATION, {
        fileName: join(output, "entry.ts"),
        publicDir: join(output, "public"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("audio:static-sound"));
    assert.ok(result.manifest.features.includes("audio:decode-wav"));
    // Each site's candidate is the one file its caller's path selects, in a
    // constant table keyed at generation by the URL the library requests;
    // the site registers the table with its realm once.
    const registered = [
        ...result.cpp.matchAll(
            /PackagedFetchEntry\{"([^"]+)", "http:\/\/localhost([^"]+)"/g,
        ),
    ].map((match) => `${match[1]} ${match[2]}`);
    assert.deepEqual(registered.sort(), [
        "/assets/sfx/hum.wav /assets/sfx/hum.wav",
        "/assets/sfx/tone.wav /assets/sfx/tone.wav",
    ]);
    assert.equal(
        result.cpp.match(
            /static thread_local const bool \w+ = bbl::pal::register_packaged_responses\("http:\/\/localhost\/", &bbl::asset_path, bblscene::packaged_audio_responses\w*\);/g,
        )?.length,
        2,
    );
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    for (const asset of result.manifest.assets) {
        const destination = join(output, "assets", asset.output);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(resolve(output, asset.source), destination);
    }
    // The library header where a build's upstream tree carries it.
    const library = audioLibraryInclude(
        "static-sounds-application",
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
#include <cassert>
const char* bbl::pal::bblite_build_stamp() { return "static-sounds-application"; }
${FIXTURE_APPLICATION}`,
    );
    assert.equal(
        runAudioProgram(output, join(output, "check.cpp"), library, []),
        "",
    );
});

test("a packaged static sound plays, ramps, stops and disposes in a LabSound capture", (t) => {
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/static-sound-capture");
    mkdirSync(output, { recursive: true });
    writeFileSync(
        join(output, "library.hpp"),
        staticSoundLibraryHeader(sharedPinnedContext(), [
            ...ENGINE_ROOTS,
            ...STATIC_SOUND_ROOTS,
        ]),
    );
    const wav = join(output, "tone.wav");
    writeFileSync(wav, wave(0.5, 1));
    const lines = runAudioProgram(
        output,
        "test/fixtures/static-sound-capture-check.cpp",
        ["/DBBLITE_AUDIO_CAPTURE=1"],
        [wav],
    )
        .replaceAll("\r\n", "\n")
        .trimEnd()
        .split("\n");
    const [
        engine,
        created,
        playing,
        ramp,
        restored,
        master,
        unmuted,
        stopped,
        disposed,
    ] = lines;
    // The pin's engine: full master volume, its default 0.01 s ramp.
    assert.equal(engine, "engine 1.000 0.010");
    assert.equal(created, "created 1");
    assert.equal(playing, "playing 0.500");
    // Across the 0.1 s linear ramp to silence: full at its start, half at
    // its middle, under the last window's share at its end.
    const [start, middle, end] = ramp!.split(" ").slice(1).map(Number);
    assert.ok(Math.abs(start! - 0.5) < 0.01, ramp);
    assert.ok(Math.abs(middle! - 0.25 - 0.0125) < 0.015, ramp);
    assert.ok(end! < 0.02, ramp);
    assert.equal(restored, "restored 0.500");
    // The master volume's 0.1 s linear ramp to silence on the main output,
    // measured like the sound's, then restored at once.
    const [masterStart, masterMiddle, masterEnd, masterVolume] = master!
        .split(" ")
        .slice(1)
        .map(Number);
    assert.ok(Math.abs(masterStart! - 0.5) < 0.01, master);
    assert.ok(Math.abs(masterMiddle! - 0.25 - 0.0125) < 0.015, master);
    assert.ok(masterEnd! < 0.02, master);
    assert.equal(masterVolume, 0);
    assert.equal(unmuted, "unmuted 0.500");
    assert.equal(stopped, "stopped 0.000");
    assert.equal(disposed, "disposed 0");
    assert.ok(readFileSync(wav).length > 44);
});
