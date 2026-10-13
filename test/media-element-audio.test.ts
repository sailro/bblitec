import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureLabSoundPresent,
    nativeFixtureLabSoundRoot,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
const labsound = nativeFixtureLabSoundRoot;
const native = Boolean(tools && nativeFixtureLabSoundPresent());

/** A mono 16-bit 48 kHz WAVE file whose sample at `t` seconds is `level(t)`. */
function wave(seconds: number, level: (time: number) => number): Buffer {
    const frames = Math.round(seconds * 48000);
    const data = Buffer.alloc(frames * 2);
    for (let index = 0; index < frames; index++)
        data.writeInt16LE(Math.round(level(index / 48000) * 32767), index * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(96000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/** Compile a LabSound translation unit with the web platform seam, then run it. */
function runAudioProgram(
    output: string,
    source: string,
    flags: readonly string[],
    args: readonly string[],
): string {
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/O2",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
        "/DBBLITE_HAS_AUDIO_DECODE_FILE=1",
        "/DBBLITE_HAS_AUDIO_MEDIA_ELEMENT=1",
        "/DBBLITE_AUDIO_DECODE_WAV=1",
        // An audio program decodes no image through the seam.
        "/DBBLITE_HAS_IMAGE_DECODER=0",
        "/DBBLITE_HAS_WEBP_DECODER=0",
        ...flags,
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        `/external:I${join(labsound, "include")}`,
        source,
        "native/src/pal_web_platform.cpp",
        "native/src/pal_http.cpp",
        "native/src/pal.cpp",
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        `/LIBPATH:${join(labsound, "lib")}`,
        "LabSound.lib",
        "libnyquist.lib",
        "SDL3.lib",
        "winhttp.lib",
    ]);
    return execFileSync(executable, args, {
        cwd: output,
        encoding: "utf8",
        timeout: 60000,
        env: {
            ...tools!.environment,
            SDL_AUDIODRIVER: "dummy",
            BBLITE_AUDIO_CAPTURE: "",
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
        },
    });
}

/**
 * The application's ambient beds: each a rotation of streamed clips from a
 * bank of base-relative URLs, routed element -> source node -> per-clip gain
 * -> master, crossfading to the next clip near the end of the current one
 * (timeupdate reading duration and currentTime) and falling back on ended;
 * a single-clip bank loops. Released clips pause, drop their source and load.
 */
const APPLICATION = `
const BASE = import.meta.env.BASE_URL;
const appUrl = (path: string): string => BASE + path.replace(/^\\/+/, "");

interface BankEntry { url: string; gain: number; }
const ROTATING: BankEntry[] = [
    { url: appUrl("/assets/beds/first.wav"), gain: 0.5 },
    { url: appUrl("/assets/beds/second.wav"), gain: 0.4 },
];
const LOOPED: BankEntry[] = [{ url: appUrl("/assets/beds/wind.wav"), gain: 0.3 }];
const OVERLAP_S = 0.25;

function nearEnd(duration: number, currentTime: number, overlap: number): boolean {
    return Number.isFinite(duration) && Number.isFinite(currentTime) && duration > 0 &&
        currentTime >= 0 && duration - currentTime <= overlap;
}

const ctx = new AudioContext();
const master = ctx.createGain();
master.connect(ctx.destination);

interface Clip { audio: HTMLAudioElement; gain: GainNode; baseGain: number; level: number; fadeId: number; }
interface Bed { start(): void; stop(): void; crossfades(): number; ends(): number; loops(): number; }

function createBed(bank: BankEntry[]): Bed {
    let active = false;
    let next = 0;
    let current: Clip | null = null;
    let crossfading = false;
    let crossfades = 0;
    let ends = 0;
    let loops = 0;
    const live = new Set<Clip>();
    const applyLevel = (track: Clip): void => {
        track.gain.gain.value = track.baseGain * track.level;
    };
    function release(track: Clip): void {
        track.fadeId++;
        if (current === track) current = null;
        if (!live.delete(track)) return;
        try {
            track.audio.pause();
        } catch {
            /* already torn down */
        }
        track.audio.removeAttribute("src");
        track.audio.load();
        try {
            track.gain.disconnect();
        } catch {
            /* never connected */
        }
    }
    function fade(track: Clip, to: number, seconds: number, onDone?: () => void): void {
        const token = ++track.fadeId;
        const from = track.level;
        const start = performance.now();
        const step = (): void => {
            if (token !== track.fadeId) return;
            const t = Math.min(1, (performance.now() - start) / Math.max(1, seconds * 1000));
            track.level = from + (to - from) * t;
            applyLevel(track);
            if (t < 1) setTimeout(step, 16);
            else onDone?.();
        };
        setTimeout(step, 16);
    }
    function makeClip(): Clip {
        const entry = bank[next++ % bank.length]!;
        const audio = new Audio(entry.url);
        audio.preload = "auto";
        if (bank.length === 1) audio.loop = true;
        const gain = ctx.createGain();
        ctx.createMediaElementSource(audio).connect(gain);
        gain.connect(master);
        const track: Clip = { audio, gain, baseGain: entry.gain, level: 0, fadeId: 0 };
        live.add(track);
        applyLevel(track);
        let previous = 0;
        audio.addEventListener("timeupdate", () => {
            if (audio.currentTime < previous) loops++;
            previous = audio.currentTime;
            if (bank.length > 1 && active && !crossfading && current === track &&
                nearEnd(audio.duration, audio.currentTime, OVERLAP_S))
                beginOverlap();
        });
        audio.addEventListener("ended", () => {
            ends++;
            const wasCurrent = current === track;
            release(track);
            if (active && wasCurrent) {
                crossfading = false;
                beginClip();
            }
        });
        return track;
    }
    function beginClip(): void {
        if (!active) return;
        const track = makeClip();
        current = track;
        void track.audio
            .play()
            .then(() => {
                if (!active || current !== track) {
                    release(track);
                    return;
                }
                fade(track, 1, 0.1);
            })
            .catch(() => {
                release(track);
            });
    }
    function beginOverlap(): void {
        if (!active || crossfading || !current) return;
        crossfading = true;
        const outgoing = current;
        const track = makeClip();
        current = track;
        void track.audio
            .play()
            .then(() => {
                crossfades++;
                fade(track, 1, OVERLAP_S, () => {
                    if (current === track) crossfading = false;
                });
                fade(outgoing, 0, OVERLAP_S, () => release(outgoing));
            })
            .catch(() => {
                release(track);
                crossfading = false;
            });
    }
    return {
        start(): void {
            if (active) return;
            active = true;
            beginClip();
        },
        stop(): void {
            active = false;
            current = null;
            for (const track of [...live]) release(track);
        },
        crossfades: (): number => crossfades,
        ends: (): number => ends,
        loops: (): number => loops,
    };
}

const wait = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
    await wait(0);
    const probe = new Audio(appUrl("/assets/beds/first.wav"));
    if (!Number.isNaN(probe.duration) || !probe.paused || probe.preload !== "auto" || probe.loop)
        throw new Error("initial element state");
    // A pause before playback starts interrupts the play.
    let interrupted = "";
    const pending = probe.play().catch((error: Error) => {
        interrupted = error.name;
    });
    probe.pause();
    await pending;
    if (interrupted !== "AbortError") throw new Error("pause before playing: " + interrupted);
    const events: string[] = [];
    probe.addEventListener("play", () => {
        events.push("play");
    });
    probe.addEventListener("pause", () => {
        events.push("pause");
    });
    probe.addEventListener("ended", () => {
        events.push("ended");
    });
    // Unrouted, the element plays to the default output; routing moves it.
    await probe.play();
    if (!(Math.abs(probe.duration - 0.6) < 0.001) || probe.paused)
        throw new Error("playing element: " + probe.duration);
    ctx.createMediaElementSource(probe).connect(master);
    let second = "";
    try {
        ctx.createMediaElementSource(probe);
    } catch (error) {
        second = (error as Error).name;
    }
    if (second !== "InvalidStateError") throw new Error("second source: " + second);
    probe.currentTime = 0.5;
    await wait(400);
    if (!probe.ended || !probe.paused || Math.abs(probe.currentTime - 0.6) > 0.001 ||
        events.join(",") !== "play,pause,ended")
        throw new Error("ended element: " + events.join(","));
    probe.removeAttribute("src");
    probe.load();
    if (!Number.isNaN(probe.duration) || probe.currentTime !== 0) throw new Error("released element");

    const rotating = createBed(ROTATING);
    const looped = createBed(LOOPED);
    rotating.start();
    looped.start();
    await wait(2000);
    if (rotating.crossfades() < 2) throw new Error("crossfades: " + rotating.crossfades());
    if (looped.ends() !== 0 || looped.loops() < 2) throw new Error("loops: " + looped.loops());
    rotating.stop();
    looped.stop();
    globalThis.close();
}
void main();
`;

test("the application's media element beds compile strictly and run natively over LabSound", (t) => {
    const output = resolve("artifacts/media-element-application");
    const beds = join(output, "public/assets/beds");
    mkdirSync(beds, { recursive: true });
    writeFileSync(
        join(beds, "first.wav"),
        wave(0.6, () => 0.5),
    );
    writeFileSync(
        join(beds, "second.wav"),
        wave(0.6, () => 0.25),
    );
    writeFileSync(
        join(beds, "wind.wav"),
        wave(0.5, () => 0.1),
    );
    const result = compileSource(APPLICATION, {
        fileName: join(output, "entry.ts"),
        publicDir: join(output, "public"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    for (const feature of ["audio:media-element", "audio:decode-wav"])
        assert.ok(result.manifest.features.includes(feature), feature);
    const registered = new Set(
        [
            ...result.cpp.matchAll(
                /register_packaged_responses\("http:\/\/localhost\/", \{([^;]+)\}\);/g,
            ),
        ].flatMap((match) =>
            [...match[1]!.matchAll(/\{"([^"]+)"/g)].map((entry) => entry[1]),
        ),
    );
    assert.deepEqual([...registered].sort(), [
        "/assets/beds/first.wav",
        "/assets/beds/second.wav",
        "/assets/beds/wind.wav",
    ]);
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    for (const asset of result.manifest.assets) {
        const destination = join(output, "assets", asset.output);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(resolve(output, asset.source), destination);
    }
    writeFileSync(join(output, "program.hpp"), result.cpp);
    writeFileSync(
        join(output, "check.cpp"),
        `#include "pal_audio_labsound.cpp"
#include <bblite/pal_audio_async.hpp>
#define main generated_main
#include "program.hpp"
#undef main
std::string bbl::asset_path(const std::string& path) { return "assets/" + path; }
const char* bbl::pal::bblite_build_stamp() { return "media-element-application"; }
namespace bbl::pal {
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.on_unhandled_rejection([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal
int main() { return generated_main(); }
`,
    );
    assert.equal(
        runAudioProgram(output, join(output, "check.cpp"), [], []),
        "",
    );
});

test("refused media element forms name their limit", () => {
    const output = resolve("artifacts/media-element-refusals");
    mkdirSync(join(output, "public"), { recursive: true });
    writeFileSync(
        join(output, "public/tone.wav"),
        wave(0.1, () => 0.5),
    );
    const compile = (body: string) =>
        compileSource(body, {
            fileName: join(output, "entry.ts"),
            publicDir: join(output, "public"),
        });
    for (const url of ["String(Math.random())", '"/missing.wav"'])
        assert.throws(
            () => compile(`new Audio(${url});`),
            /An Audio source URL must select packaged audio/,
        );
    // An absent optional receiver skips the call and its arguments.
    const optional = compile(
        'let skipped = 0; const missing: Array<HTMLAudioElement | undefined> = [undefined]; missing[0]?.addEventListener("ended", () => { skipped++; }); missing[0]?.pause(); if (skipped !== 0) throw new Error("optional");',
    );
    assert.equal(optional.manifest.deferredCapabilities, undefined);
    assert.ok(optional.manifest.features.includes("audio:media-element"));
    assert.throws(
        () =>
            compile(
                'const audio = new Audio("/tone.wav"); audio.addEventListener("seeked", () => {});',
            ),
        /Only timeupdate, ended, play, pause listeners are represented/,
    );
    assert.throws(
        () =>
            compile(
                'const audio = new Audio("/tone.wav"); audio.setAttribute("src", "x.wav");',
            ),
        /HTMLAudioElement.setAttribute is not lowered/,
    );
    assert.throws(
        () =>
            compile(
                'const audio = new Audio("/tone.wav"); audio.volume = 0.5;',
            ),
        /HTMLAudioElement.volume writes are not lowered/,
    );
});

test("a media element plays, moves, pauses, seeks, ends, loops and crossfades in a LabSound capture", (t) => {
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/media-element-capture");
    mkdirSync(output, { recursive: true });
    const files = [
        ["ramp.wav", wave(1, (time) => time)],
        ["high.wav", wave(1, () => 0.5)],
        ["low.wav", wave(1, () => 0.25)],
    ] as const;
    for (const [name, bytes] of files) writeFileSync(join(output, name), bytes);
    const lines = runAudioProgram(
        output,
        "test/fixtures/media-element-capture-check.cpp",
        ["/DBBLITE_AUDIO_CAPTURE=1"],
        files.map(([name]) => join(output, name)),
    )
        .replaceAll("\r\n", "\n")
        .trimEnd()
        .split("\n");
    const values = (line: string | undefined, label: string): number[] => {
        assert.ok(line?.startsWith(`${label} `), line);
        return line!.split(" ").slice(1).map(Number);
    };
    const near = (actual: number, expected: number, tolerance: number) =>
        assert.ok(
            Math.abs(actual - expected) <= tolerance,
            `${actual} is not ${expected}`,
        );
    const [
        direct,
        before,
        played,
        playing,
        paused,
        resumed,
        seeked,
        ended,
        looped,
        crossfade,
        shared,
        released,
        events,
    ] = lines;
    // The default output, then nothing there and the same source routed.
    const [heard, left, moved, movedTime] = values(direct, "direct");
    near(heard!, 0.5, 0.002);
    assert.equal(left, 0);
    near(moved!, 0.5, 0.002);
    // Two renders of whole 128-frame quanta: 0.1013 s each.
    near(movedTime!, 0.2027, 0.001);
    assert.equal(before, "before nan");
    assert.equal(played, "played 1.000");
    // The ramp's sample is its position: a quarter second in.
    const [level, time] = values(playing, "playing");
    near(level!, 0.25, 0.003);
    near(time!, 0.25, 0.003);
    const [pausedPeak, pausedTime] = values(paused, "paused");
    assert.equal(pausedPeak, 0);
    near(pausedTime!, 0.25, 0.003);
    near(values(resumed, "resumed")[0]!, 0.25, 0.003);
    const [seekLevel, seekTime] = values(seeked, "seeked");
    near(seekLevel!, 0.75, 0.003);
    near(seekTime!, 0.8, 0.003);
    // Silent after the end; paused, ended, at the duration.
    assert.equal(ended, "ended 0.000 11 1.000");
    // Looping wraps: 1.2 s of playback is 0.2 s into the ramp, never ended.
    const [loopLevel, loopTime, loopEnded] = values(looped, "looped");
    near(loopLevel!, 0.2, 0.003);
    near(loopTime!, 0.2, 0.003);
    assert.equal(loopEnded, 0);
    // High alone, then a linear 0.2 s crossfade to low through the gains.
    const [alone, start, middle, end] = values(crossfade, "crossfade");
    near(alone!, 0.5, 0.002);
    near(start!, 0.5, 0.01);
    near(middle!, 0.375, 0.01);
    near(end!, 0.25, 0.002);
    // Two elements of one source share the session's one decode.
    assert.equal(shared, "shared 1");
    assert.equal(released, "released 0.250 nan 1");
    const counts = Object.fromEntries(
        events!
            .split(" ")
            .slice(1)
            .map((entry) => entry.split("=") as [string, string]),
    );
    assert.equal(counts["ramp.ended"], "1");
    assert.equal(counts["ramp.play"], "3");
    assert.equal(counts["ramp.pause"], "3");
    assert.ok(Number(counts["ramp.timeupdate"]) >= 3, events);
});
