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

/** The whole family's header, which the fixtures call into. */
const spatialHeader = (): string =>
    staticSoundLibraryHeader(sharedPinnedContext(), AUDIO_LIBRARY_ROOTS);

/**
 * The application's shapes: one-shot world effects positioned per play,
 * the listener moved to a camera a caller's function returns, and an
 * environmental loop whose source and listener records are rewritten
 * before each placement; every sound made spatial with linear roll-off.
 */
const APPLICATION = `
import {
    createAudioEngineAsync, createAudioEngineMediaStream, createSoundAsync, disposeSound, enableSpatial,
    playSound, setSpatialListenerPosition, setSpatialPosition, stopSound,
    type AudioEngine, type StaticSound,
} from "@babylonjs/lite";

const BASE = import.meta.env.BASE_URL;
const appUrl = (path: string): string => BASE + path.replace(/^\\/+/, "");

// The game's capture pipeline keeps the engine's master mix as a stream.
let captureStream: MediaStream | null = null;
function registerGameAudioCaptureStream(stream: MediaStream): void {
    captureStream = stream;
}

let enginePromise: Promise<AudioEngine> | null = null;
function sharedEngine(): Promise<AudioEngine> {
    if (!enginePromise) {
        const context = new AudioContext();
        enginePromise = createAudioEngineAsync({ audioContext: context }).then((engine) => {
            const output = createAudioEngineMediaStream(engine);
            registerGameAudioCaptureStream(output.stream);
            return engine;
        });
    }
    return enginePromise;
}

interface Point { x: number; y: number; z: number; }
interface SfxOptions { minDistance?: number; maxDistance?: number; listenerPosition: () => Point; }
interface SfxHandle { playAt(x: number, y: number, z: number): void; dispose(): void; }

function createSpatialSfx(assetPath: string, opts: SfxOptions): SfxHandle {
    let engine: AudioEngine | null = null;
    let sound: StaticSound | null = null;
    let disposed = false;
    void (async () => {
        const e = await sharedEngine();
        const s = await createSoundAsync(e, appUrl(assetPath), { volume: 1, maxInstances: 4 });
        if (disposed) { disposeSound(s); return; }
        enableSpatial(s, { distanceModel: "linear", minDistance: opts.minDistance ?? 6, maxDistance: opts.maxDistance ?? 42 });
        engine = e;
        sound = s;
    })();
    return {
        playAt(x: number, y: number, z: number): void {
            if (!engine || !sound) return;
            setSpatialListenerPosition(engine, opts.listenerPosition());
            setSpatialPosition(sound, { x, y, z });
            playSound(sound, { playbackRate: 1 });
        },
        dispose(): void {
            disposed = true;
            if (sound) { disposeSound(sound); sound = null; }
        },
    };
}

interface LoopHandle {
    update(sourceX: number | null, sourceY: number, sourceZ: number, listenerX: number, listenerY: number, listenerZ: number): void;
    dispose(): void;
}

function createSpatialLoop(assetPath: string, opts: { minDistance?: number; maxDistance?: number } = {}): LoopHandle {
    let engine: AudioEngine | null = null;
    let sound: StaticSound | null = null;
    let disposed = false;
    let wanted = false;
    let playing = false;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let lx = 0;
    let ly = 0;
    let lz = 0;
    const source = { x: 0, y: 0, z: 0 };
    const listener = { x: 0, y: 0, z: 0 };
    const apply = (): void => {
        if (!engine || !sound) return;
        if (!wanted) {
            if (playing) { stopSound(sound); playing = false; }
            return;
        }
        source.x = sx;
        source.y = sy;
        source.z = sz;
        listener.x = lx;
        listener.y = ly;
        listener.z = lz;
        setSpatialListenerPosition(engine, listener);
        setSpatialPosition(sound, source);
        if (!playing) { playSound(sound, { loop: true }); playing = true; }
    };
    void (async () => {
        const e = await sharedEngine();
        const s = await createSoundAsync(e, appUrl(assetPath), { loop: true, maxInstances: 1, volume: 0.5 });
        if (disposed) { disposeSound(s); return; }
        enableSpatial(s, {
            distanceModel: "linear",
            minDistance: opts.minDistance ?? 6,
            maxDistance: opts.maxDistance ?? 42,
        });
        engine = e;
        sound = s;
        apply();
    })();
    return {
        update(sourceX, sourceY, sourceZ, listenerX, listenerY, listenerZ): void {
            wanted = sourceX !== null;
            if (sourceX !== null) {
                sx = sourceX;
                sy = sourceY;
                sz = sourceZ;
            }
            lx = listenerX;
            ly = listenerY;
            lz = listenerZ;
            apply();
        },
        dispose(): void {
            disposed = true;
            wanted = false;
            if (sound) { disposeSound(sound); sound = null; }
            playing = false;
        },
    };
}

// The application runs in its realm: a timer yield stands for the rest of it.
async function main(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const camera = { x: 0, y: 2, z: 5 };
    const sfx = createSpatialSfx("/assets/sfx/splash.wav", { listenerPosition: () => camera });
    const loop = createSpatialLoop("/assets/sfx/brook.wav", { maxDistance: 30 });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    sfx.playAt(3, 0, -2);
    loop.update(4, 0, 1, 0, 2, 5);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    camera.x = 1;
    sfx.playAt(-3, 0, -2);
    loop.update(-4, 0, 1, 1, 2, 5);
    loop.update(null, 0, 0, 1, 2, 5);
    sfx.dispose();
    loop.dispose();
    if (!captureStream || captureStream.getAudioTracks().length !== 1) throw new Error("no master-mix stream");
    globalThis.close();
}
void main();
`;

test("the application's spatial sounds compile strictly and run natively", (t) => {
    const output = resolve("artifacts/spatial-sounds-application");
    const sounds = join(output, "public/assets/sfx");
    mkdirSync(sounds, { recursive: true });
    writeFileSync(join(sounds, "splash.wav"), wave(0.5, 0.5));
    writeFileSync(join(sounds, "brook.wav"), wave(0.5, 0.25));
    const result = compileSource(APPLICATION, {
        fileName: join(output, "entry.ts"),
        publicDir: join(output, "public"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    for (const feature of [
        "audio:spatial-sound",
        "audio:static-sound",
        "audio:panner",
        "audio:engine-media-stream",
    ])
        assert.ok(result.manifest.features.includes(feature), feature);
    // The loop's records are read where it places, not folded from their
    // initializers.
    assert.match(result.cpp, /set_spatial_position\(/);
    assert.match(result.cpp, /set_spatial_listener_position\(/);
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
        "spatial-sounds-application",
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
const char* bbl::pal::bblite_build_stamp() { return "spatial-sounds-application"; }
${FIXTURE_APPLICATION}`,
    );
    assert.equal(
        runAudioProgram(
            output,
            join(output, "check.cpp"),
            [
                "/DBBLITE_HAS_AUDIO_PANNER=1",
                "/DBBLITE_HAS_AUDIO_MEDIA_STREAM=1",
                ...library,
            ],
            [],
        ),
        "",
    );
});

test("a spatial sound pans and attenuates with its place around the listener in a LabSound capture", (t) => {
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/spatial-sound-capture");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "library.hpp"), spatialHeader());
    const wav = join(output, "tone.wav");
    writeFileSync(wav, wave(1, 0.5));
    const lines = runAudioProgram(
        output,
        "test/fixtures/spatial-sound-capture-check.cpp",
        ["/DBBLITE_AUDIO_CAPTURE=1", "/DBBLITE_HAS_AUDIO_PANNER=1"],
        [wav],
    )
        .replaceAll("\r\n", "\n")
        .trimEnd()
        .split("\n");
    const levels = new Map(
        lines.map((line) => {
            const [name, left, right] = line.split(" ");
            return [name!, [Number(left), Number(right)] as const];
        }),
    );
    const near = (actual: number, expected: number): boolean =>
        Math.abs(actual - expected) < 0.01;
    const at = (name: string): readonly [number, number] => {
        const level = levels.get(name);
        assert.ok(level, `${name} missing from ${lines.join(" | ")}`);
        return level;
    };
    // Equal-power panning of a 0.5 source inside the reference distance:
    // all right, all left, then centred (cos 45 degrees each).
    const [rightL, rightR] = at("right");
    assert.ok(near(rightL, 0) && near(rightR, 0.5), lines.join(" | "));
    const [leftL, leftR] = at("left");
    assert.ok(near(leftL, 0.5) && near(leftR, 0), lines.join(" | "));
    const centred = 0.5 * Math.SQRT1_2;
    const [frontL, frontR] = at("front");
    assert.ok(
        near(frontL, centred) && near(frontR, centred),
        lines.join(" | "),
    );
    // Linear roll-off from 6 to 42: half the gain at 24, none from 42.
    const [halfL, halfR] = at("half");
    assert.ok(
        near(halfL, centred / 2) && near(halfR, centred / 2),
        lines.join(" | "),
    );
    const [beyondL, beyondR] = at("beyond");
    assert.ok(near(beyondL, 0) && near(beyondR, 0), lines.join(" | "));
    // The balance follows the source relative to the listener.
    const [movedL, movedR] = at("moved");
    assert.ok(near(movedL, 0) && near(movedR, 0.5), lines.join(" | "));
});

test("spatial audio refuses what it does not lower, by name", () => {
    const program = (options: string): string => `
import { createAudioEngineAsync, createSoundAsync, enableSpatial } from "@babylonjs/lite";
async function main(): Promise<void> {
    const engine = await createAudioEngineAsync();
    const sound = await createSoundAsync(engine, new ArrayBuffer(8));
    enableSpatial(sound, ${options});
}
void main();
`;
    assert.throws(
        () => compileSource(program(`{ panningModel: "HRTF" }`)),
        /panningModel "HRTF" is not lowered: it needs an HRTF database/,
    );
    assert.throws(
        () => compileSource(program(`{ position: { x: 1, y: 0, z: 0 } }`)),
        /Spatial option 'position' is not lowered: place the sound with setSpatialPosition/,
    );
});

test("the engine media-stream tap carries the master mix to another context", (t) => {
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/engine-media-stream-capture");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "library.hpp"), spatialHeader());
    const wav = join(output, "tone.wav");
    writeFileSync(wav, wave(1, 0.5));
    const lines = runAudioProgram(
        output,
        "test/fixtures/engine-media-stream-check.cpp",
        [
            "/DBBLITE_AUDIO_CAPTURE=1",
            "/DBBLITE_HAS_AUDIO_PANNER=1",
            "/DBBLITE_HAS_AUDIO_MEDIA_STREAM=1",
        ],
        [wav],
    )
        .replaceAll("\r\n", "\n")
        .trimEnd()
        .split("\n");
    // One audio track, its release registered with the engine; the tap is
    // post-master (0.5 at half volume) and the stream carries the same mix.
    assert.deepEqual(lines, [
        "tracks 1 disposers 1",
        "engine 0.250",
        "stream 0.250",
        "disposed 0 ended",
    ]);
});
