import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;
const runtime = `
namespace bbl::pal {
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
void audio_connect(AudioNodeHandle, AudioNodeHandle) {
    throw std::runtime_error("Unexpected graph execution after unavailable producer");
}
}
`;

const family = `
let catches = 0;
let argumentsRun = 0;
let callbacksRun = 0;
function text(): string { ++argumentsRun; return 'video/mp4'; }
try { MediaRecorder.isTypeSupported(text()); } catch (error) {
    if (!error.message.includes('dom:MediaRecorder.isTypeSupported')) throw error;
    catches++;
}
try {
    const stream = new MediaStream();
    const tracks = stream.getTracks();
    stream.getAudioTracks();
    for (const track of tracks) { const clone = track.clone(); stream.addTrack(clone); clone.stop(); }
    const recorder = new MediaRecorder(stream, { mimeType: text() });
    recorder.addEventListener('dataavailable', event => {
        callbacksRun++;
        const blob = event.data;
        blob.text().then(value => { if (value === 'bad') throw new Error(value); });
    });
    recorder.addEventListener('error', () => { callbacksRun++; });
    recorder.addEventListener('stop', () => { callbacksRun++; });
    recorder.start(1000);
    if (recorder.state !== 'inactive') recorder.stop();
} catch (error) {
    if (!error.message.includes('dom:MediaStream.constructor')) throw error;
    catches++;
}
try {
    const audio = new Audio(text());
    audio.preload = 'auto'; audio.loop = true;
    audio.addEventListener('timeupdate', () => {
        callbacksRun++;
        if (audio.duration < audio.currentTime) throw new Error('clock');
    });
    audio.pause(); audio.load(); audio.play().catch(() => { callbacksRun++; });
} catch (error) {
    if (!error.message.includes('dom:Audio.constructor')) throw error;
    catches++;
}
try {
    const stream = new MediaStream();
    const contexts: AudioContext[] = [];
    const context = contexts[0]!;
    const source = context.createMediaStreamSource(stream);
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    source.disconnect(destination);
    destination.stream.getTracks();
    const audio = new Audio('sound.wav');
    context.createMediaElementSource(audio);
} catch (error) {
    if (!error.message.includes('dom:MediaStream.constructor')) throw error;
    catches++;
}
const missingStreams: Array<MediaStream | undefined> = [undefined];
const missingRecorders: Array<MediaRecorder | undefined> = [undefined];
const events: BlobEvent[] = [];
missingStreams[0]?.getTracks();
missingRecorders[0]?.start(++argumentsRun);
if (catches !== 4 || argumentsRun !== 2 || callbacksRun !== 0 || events.length !== 0)
    throw new Error('capability completion, optional evaluation or authored callbacks');
setTimeout(() => globalThis.close(), 0);
`;

test("deferred media preserves typed bodies, optional evaluation and explicit failures", () => {
    const result = compileSource(family, { deferredCapabilities });
    const sites = result.manifest.deferredCapabilities ?? [];
    const ids = new Set(sites.map((site) => site.id));
    for (const id of [
        "MediaRecorder.isTypeSupported",
        "MediaStream.constructor",
        "MediaStream.getTracks",
        "MediaStream.getAudioTracks",
        "MediaStreamTrack.clone",
        "MediaStream.addTrack",
        "MediaStreamTrack.stop",
        "MediaRecorder.constructor",
        "MediaRecorder.addEventListener",
        "BlobEvent.data",
        "MediaRecorder.start",
        "MediaRecorder.state",
        "MediaRecorder.stop",
        "Audio.constructor",
        "HTMLMediaElement.preload",
        "HTMLMediaElement.loop",
        "HTMLMediaElement.duration",
        "HTMLMediaElement.currentTime",
        "HTMLAudioElement.addEventListener",
        "HTMLMediaElement.pause",
        "HTMLMediaElement.load",
        "HTMLMediaElement.play",
        "AudioContext.createMediaStreamSource",
        "AudioContext.createMediaStreamDestination",
        "MediaStreamAudioDestinationNode.stream",
        "AudioNode.disconnect",
        "AudioContext.createMediaElementSource",
    ])
        assert.ok(ids.has(`dom:${id}`), id);
    assert.equal(
        sites.find((site) => site.id === "dom:HTMLMediaElement.play")?.timing,
        "reject",
    );
    assert.equal(
        sites.find((site) => site.id === "dom:MediaRecorder.constructor")
            ?.operation,
        "construct",
    );
    assert.throws(
        () =>
            compileSource(
                family.replace(
                    "callbacksRun++;\n        const blob",
                    "new FinalizationRegistry(() => {});\n        const blob",
                ),
                { deferredCapabilities },
            ),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-media/family", result.cpp + runtime, {
        defines: ["BBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("media capability registration preserves strict and authored behavior", () => {
    assert.throws(
        () => compileSource("new MediaStream();"),
        /Unsupported constructor/,
    );
    const authored = compileSource(
        `
        let hits=0;
        const own: Pick<MediaStream, 'getTracks'> = { getTracks: () => { hits++; return []; } };
        if(own.getTracks().length !== 0 || hits !== 1) throw new Error('authored');
    `,
        { deferredCapabilities },
    );
    assert.equal(authored.manifest.deferredCapabilities, undefined);
    const supported = compileSource(
        `const context = new AudioContext();const node = context.createGain();node.disconnect();`,
        { deferredCapabilities },
    );
    assert.equal(supported.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-media/authored", authored.cpp, {
        expectedOutput: "",
    });
});

test("deferred script members and canvas capture retain exact typed sites", () => {
    const result = compileSource(
        `
        const canvas = document.createElement('canvas');
        canvas.captureStream(30);
        const script = document.createElement('script');
        script.src = 'module.js';script.async = true;
        const listener = () => { atob(script.src); };
        script.addEventListener('error', listener);
        script.removeEventListener('error', listener);
    `,
        { deferredCapabilities },
    );
    const ids = new Set(
        result.manifest.deferredCapabilities?.map((site) => site.id),
    );
    for (const id of [
        "HTMLCanvasElement.captureStream",
        "HTMLScriptElement.src",
        "HTMLScriptElement.async",
        "HTMLScriptElement.addEventListener",
        "HTMLScriptElement.removeEventListener",
    ])
        assert.ok(ids.has(`dom:${id}`), id);
});
