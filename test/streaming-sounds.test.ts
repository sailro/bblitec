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
 * Background music: a looped streaming track routed into a music bus,
 * re-volumed with a ramp, paused and resumed around a menu, then stopped and
 * disposed; an ambience from a URL list of candidate files, preloaded twice
 * before it plays.
 */
const APPLICATION = `
import {
    createAudioBusAsync, createAudioEngineAsync, createStreamingSoundAsync, disposeAudioEngine,
    disposeStreamingSound, pauseStreamingSound, playStreamingSound, preloadStreamingInstanceAsync,
    resumeStreamingSound, setStreamingSoundVolume, stopStreamingSound, type StreamingSound,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const engine = await createAudioEngineAsync();
    const music = await createAudioBusAsync(engine, "music", { volume: 0.8 });
    const track: StreamingSound = await createStreamingSoundAsync(engine, "/assets/music/theme.wav", {
        loop: true,
        outBus: music,
        volume: 0.5,
    });
    if (track.preloadCompletedCount !== 1) throw new Error("preload");
    playStreamingSound(track);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    setStreamingSoundVolume(track, 0.25, { duration: 0.05 });
    pauseStreamingSound(track);
    resumeStreamingSound(track, { volume: 0.5 });
    const ambience = await createStreamingSoundAsync(engine, ["/assets/music/rain.wav", "/assets/music/theme.wav"], {
        preloadCount: 0,
    });
    await preloadStreamingInstanceAsync(ambience);
    playStreamingSound(ambience, { loop: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    stopStreamingSound(track);
    disposeStreamingSound(track);
    disposeAudioEngine(engine);
    globalThis.close();
}
void main();
`;

test("streaming sounds compile strictly and run natively over packaged media", (t) => {
    const output = resolve("artifacts/streaming-sounds-application");
    const music = join(output, "public/assets/music");
    mkdirSync(music, { recursive: true });
    writeFileSync(join(music, "theme.wav"), wave(0.5, 0.5));
    writeFileSync(join(music, "rain.wav"), wave(0.5, 0.25));
    const result = compileSource(APPLICATION, {
        fileName: join(output, "entry.ts"),
        publicDir: join(output, "public"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    for (const feature of [
        "audio:streaming-sound",
        "audio:media-element",
        "audio:pinned-engine",
    ])
        assert.ok(result.manifest.features.includes(feature), feature);
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
        "streaming-sounds-application",
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
const char* bbl::pal::bblite_build_stamp() { return "streaming-sounds-application"; }
${FIXTURE_APPLICATION}`,
    );
    assert.equal(
        runAudioProgram(
            output,
            join(output, "check.cpp"),
            ["/DBBLITE_HAS_AUDIO_MEDIA_ELEMENT=1", ...library],
            [],
        ),
        "",
    );
});

test("a streaming sound preloads, plays, pauses, resumes and fails in a LabSound capture", (t) => {
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/streaming-sound-capture");
    mkdirSync(output, { recursive: true });
    writeFileSync(
        join(output, "library.hpp"),
        staticSoundLibraryHeader(sharedPinnedContext(), AUDIO_LIBRARY_ROOTS),
    );
    const wav = join(output, "theme.wav");
    writeFileSync(wav, wave(1, 0.5));
    const broken = join(output, "broken.wav");
    writeFileSync(broken, "not audio");
    const lines = runAudioProgram(
        output,
        "test/fixtures/streaming-sound-capture-check.cpp",
        [
            "/DBBLITE_AUDIO_CAPTURE=1",
            "/DBBLITE_HAS_AUDIO_MEDIA_ELEMENT=1",
            "/DBBLITE_HAS_AUDIO_PANNER=1",
            "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1",
            "/DBBLITE_HAS_AUDIO_ANALYSER=1",
            "/DBBLITE_HAS_AUDIO_MEDIA_STREAM=1",
        ],
        [wav, broken],
    )
        .replaceAll("\r\n", "\n")
        .trimEnd()
        .split("\n");
    // SoundState: Stopped 1, Started 3, Paused 5. A 0.5 mono source, up-mixed.
    assert.deepEqual(lines, [
        "preloaded 1 1",
        "playing 3 0.500 0.500",
        "volume 0.250 0.250",
        "paused 5 0.000 0.000",
        "resumed 3 0.250 0.250",
        "stopped 1 0.000 0.000",
        "disposed 0",
        "listed 0.500 0.500",
        "broken Failed to load streaming sound.",
        "left 0",
    ]);
});

test("a streaming source that is not packaged media refuses", () => {
    assert.throws(
        () =>
            compileSource(`
import { createAudioEngineAsync, createStreamingSoundAsync } from "@babylonjs/lite";
async function main(urls: string[]): Promise<void> {
    const engine = await createAudioEngineAsync();
    await createStreamingSoundAsync(engine, urls);
}
void main([]);
`),
        /takes a packaged URL, an array literal of packaged URLs or an Audio element/,
    );
});
