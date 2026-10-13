import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureLibrary,
    optionalNativeFixtureTools,
    runLabSoundFixture,
} from "./native-fixture.js";

const native = Boolean(
    optionalNativeFixtureTools() && nativeFixtureLibrary("labsound"),
);

/** The stream nodes' surface, beside the buffer source. */
const streamFlags = [
    "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
    "/DBBLITE_HAS_AUDIO_MEDIA_STREAM=1",
];

/** The application's shapes: a capture mixer over stream destinations, and an MP4 recording boundary. */
const applicationShapes = `
interface CaptureMixer {
    context: AudioContext;
    destination: MediaStreamAudioDestinationNode;
    inputs: Map<MediaStream, MediaStreamAudioSourceNode>;
}
const registeredStreams = new Map<MediaStream, number>();
let mixer: CaptureMixer | null = null;
function attachStream(stream: MediaStream): void {
    if (!mixer || mixer.inputs.has(stream) || stream.getAudioTracks().length === 0) return;
    const input = mixer.context.createMediaStreamSource(stream);
    input.connect(mixer.destination);
    mixer.inputs.set(stream, input);
}
function ensureMixer(): CaptureMixer | null {
    if (mixer) return mixer;
    if (typeof AudioContext === "undefined") return null;
    const context = new AudioContext();
    if (typeof context.createMediaStreamDestination !== "function") return null;
    mixer = { context, destination: context.createMediaStreamDestination(), inputs: new Map() };
    for (const stream of registeredStreams.keys()) attachStream(stream);
    return mixer;
}
function registerStream(stream: MediaStream): () => void {
    registeredStreams.set(stream, (registeredStreams.get(stream) ?? 0) + 1);
    ensureMixer();
    attachStream(stream);
    return (): void => {
        registeredStreams.delete(stream);
        const input = mixer?.inputs.get(stream);
        if (input) { input.disconnect(); mixer?.inputs.delete(stream); }
    };
}
function registerNode(context: AudioContext, output: AudioNode): () => void {
    if (typeof context.createMediaStreamDestination !== "function") return () => {};
    const destination = context.createMediaStreamDestination();
    output.connect(destination);
    const unregister = registerStream(destination.stream);
    return (): void => {
        unregister();
        try { output.disconnect(destination); } catch { }
        for (const track of destination.stream.getTracks()) track.stop();
    };
}
function cloneMixedTrack(): MediaStreamTrack | null {
    const activeMixer = ensureMixer();
    return activeMixer?.destination.stream.getAudioTracks()[0]?.clone() ?? null;
}
const MP4_TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=av01.0.08M.08,opus", "video/mp4"] as const;
function supportedMp4Type(): string | null {
    if (typeof MediaRecorder === "undefined") return null;
    return MP4_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}
function stopOwnedCaptureTracks(stream: MediaStream | null, audioTrack: MediaStreamTrack | null): void {
    const tracks = new Set(stream?.getTracks() ?? []);
    if (audioTrack) tracks.add(audioTrack);
    for (const track of tracks) {
        try { track.stop(); } catch { }
    }
}
function prepareRecording(canvas: HTMLCanvasElement): string {
    const mimeType = supportedMp4Type();
    if (!mimeType || typeof canvas.captureStream !== "function") return "unsupported";
    let stream: MediaStream | null = null;
    let audioTrack: MediaStreamTrack | null = null;
    try {
        stream = canvas.captureStream(60);
        audioTrack = cloneMixedTrack();
        if (audioTrack) stream.addTrack(audioTrack);
        const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 8_000_000,
            ...(audioTrack ? { audioBitsPerSecond: 192_000 } : {}),
        });
        recorder.addEventListener("dataavailable", (event) => {
            const data = (event as BlobEvent).data;
            if (!data || data.size === 0) return;
        });
        recorder.addEventListener("stop", () => { stopOwnedCaptureTracks(stream, audioTrack); });
        recorder.start(1_000);
        if (recorder.state !== "inactive") recorder.stop();
        return "ready";
    } catch {
        stopOwnedCaptureTracks(stream, audioTrack);
        return "error";
    }
}
const context = new AudioContext();
const master = context.createGain();
master.connect(context.destination);
const unregister = registerNode(context, master);
const canvas = document.createElement("canvas");
document.body.append(canvas);
if (prepareRecording(canvas) !== "unsupported") throw new Error("recording");
unregister();
`;

test("the application's capture and recording shapes lower in strict mode with no deferred sites", () => {
    for (const options of [
        {},
        { deferredCapabilities: "runtime-throw" as const },
    ]) {
        const result = compileSource(applicationShapes, options);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        for (const feature of ["platform:media-stream", "audio:media-stream"])
            assert.ok(result.manifest.features.includes(feature), feature);
        for (const call of [
            "audio_create_media_stream_destination",
            "audio_create_media_stream_source",
            "audio_destination_stream",
            "media_stream_tracks",
            "media_stream_track_stop",
            "media_stream_track_clone",
            "media_stream_add_track",
            "canvas_capture_stream",
            "media_recorder_type_supported",
            "media_recorder_unsupported",
            "uninhabited_member",
        ])
            assert.match(result.cpp, new RegExp(`bbl::pal::${call}\\b`), call);
        assert.doesNotMatch(result.cpp, /deferred_capability|Deferred/);
    }
});

test("stream sources refuse other receivers and recorder members stay unreachable", () => {
    assert.throws(
        () =>
            compileSource(
                `const stream = new MediaStream(); const [track] = stream.getTracks(); if (track) track.applyConstraints();`,
            ),
        /MediaStreamTrack\.applyConstraints is not lowered natively/,
    );
    const result = compileSource(`
        function use(recorder: MediaRecorder): void {
            recorder.start(1000);
            if (recorder.state === "recording") recorder.stop();
        }
        const recorders: MediaRecorder[] = [];
        if (Math.random() > 2) use(recorders[0]!);
    `);
    assert.match(
        result.cpp,
        /uninhabited_member<void>\("MediaRecorder\.start"\)/,
    );
    assert.match(
        result.cpp,
        /std::shared_ptr<bbl::pal::UninhabitedMediaRecorder>/,
    );
});

test(
    "stream destinations route audio within and across contexts and tracks follow their lifecycle",
    {
        skip: !native,
    },
    () => {
        const output = resolve("artifacts/media-stream-audio-check");
        mkdirSync(output, { recursive: true });
        assert.match(
            runLabSoundFixture({
                output,
                source: "test/fixtures/media-stream-audio-check.cpp",
                flags: [...streamFlags, "/DBBLITE_AUDIO_CAPTURE=1"],
            }),
            /media-stream-audio-check: ok/,
        );
    },
);

test(
    "lowered streams keep identity, track lifecycle and the encoder-less MediaRecorder natively",
    {
        skip: !native,
    },
    () => {
        const result = compileSource(`
        const fail = (message: string): never => { throw new Error(message); };
        const MP4_TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.4D401F", "video/mp4"] as const;
        function supportedMp4Type(): string | null {
            if (typeof MediaRecorder === "undefined") return null;
            return MP4_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
        }
        if (typeof MediaStream !== "function" || supportedMp4Type() !== null) fail("recording types");
        function record(recorder: MediaRecorder): void {
            recorder.addEventListener("dataavailable", (event) => { if ((event as BlobEvent).data.size === 0) fail("empty"); });
            recorder.start(1000);
            if (recorder.state !== "inactive") recorder.stop();
        }
        const context = new AudioContext();
        if (typeof context.createMediaStreamDestination !== "function") fail("destination factory");
        const destination = context.createMediaStreamDestination();
        const stream = destination.stream;
        if (destination.stream !== stream) fail("stream identity");
        const track = stream.getAudioTracks()[0];
        if (!track || track.kind !== "audio" || track.readyState !== "live" || !track.enabled) fail("track");
        interface Mixer { destination: MediaStreamAudioDestinationNode }
        function cloneMixed(mixer: Mixer | null): MediaStreamTrack | null {
            return mixer?.destination.stream.getAudioTracks()[0]?.clone() ?? null;
        }
        const mixed = cloneMixed({ destination });
        if (cloneMixed(null) !== null || !mixed || mixed === track || mixed.kind !== "audio") fail("mixed clone");
        const silent = context.createMediaStreamDestination();
        silent.stream.removeTrack(silent.stream.getAudioTracks()[0]!);
        if (cloneMixed({ destination: silent }) !== null) fail("trackless mixer");
        const copy = new MediaStream(stream);
        if (copy === stream || copy.getTracks()[0] !== track || copy.id === stream.id) fail("copy");
        const clone = track!.clone();
        if (clone === track || clone.id === track!.id || clone.readyState !== "live") fail("clone");
        copy.addTrack(clone);
        copy.addTrack(clone);
        if (copy.getTracks().length !== 2 || copy.getVideoTracks().length !== 0) fail("track set");
        const tracks = new Set(copy.getTracks());
        if (!tracks.has(track!) || !tracks.has(clone)) fail("track identity");
        const registered = new Map<MediaStream, number>([[stream, 1]]);
        if (registered.get(destination.stream) !== 1 || registered.has(copy)) fail("stream keys");
        clone.enabled = false;
        if (clone.enabled) fail("enabled");
        track!.stop();
        track!.stop();
        if (track!.readyState !== "ended" || clone.readyState !== "live" || !copy.active) fail("stop");
        const source = context.createMediaStreamSource(copy);
        source.connect(context.destination);
        let refusals = "";
        try { context.createMediaStreamSource(new MediaStream()); } catch (error) { refusals += error.name; }
        let constructed = false;
        try { record(new MediaRecorder(stream, { mimeType: "video/mp4" })); constructed = true; }
        catch (error) { refusals += " " + error.name + ":" + error.message.includes("video/mp4"); }
        try { record(new MediaRecorder(copy)); constructed = true; }
        catch (error) { refusals += " " + error.name; }
        if (constructed || refusals !== "InvalidStateError NotSupportedError:true NotSupportedError") fail("refusals " + refusals);
        source.disconnect();
    `);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        const output = resolve("artifacts/media-stream-program");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "program.hpp"), result.cpp);
        writeFileSync(
            join(output, "check.cpp"),
            `#include "pal_audio_labsound.cpp"
#define main generated_main
#include "program.hpp"
#undef main
#include <cstdlib>
#include <string>
namespace bbl::pal {
std::string environment_variable(const char* name) {
    char* value = nullptr;
    std::size_t length = 0;
    _dupenv_s(&value, &length, name);
    const std::string result = value ? value : "";
    std::free(value);
    return result;
}
} // namespace bbl::pal
int main() { return generated_main(); }
`,
        );
        assert.equal(
            runLabSoundFixture({
                output,
                source: join(output, "check.cpp"),
                flags: streamFlags,
            }),
            "",
        );
    },
);
