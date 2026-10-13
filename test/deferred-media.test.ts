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
void audio_disconnect(AudioNodeHandle, AudioNodeHandle, js::Nullable<double>, js::Nullable<double>) {
    throw std::runtime_error("Unexpected graph execution after unavailable producer");
}
}
`;

const family = `
let catches = 0;
let argumentsRun = 0;
let callbacksRun = 0;
function text(): string { ++argumentsRun; return 'video/mp4'; }
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
    const audio = new Audio('sound.wav');
    const contexts: AudioContext[] = [];
    contexts[0]!.createMediaElementSource(audio);
} catch (error) {
    if (!error.message.includes('dom:Audio.constructor')) throw error;
    catches++;
}
const missingAudio: Array<HTMLAudioElement | undefined> = [undefined];
missingAudio[0]?.pause();
if (catches !== 2 || argumentsRun !== 1 || callbacksRun !== 0)
    throw new Error('capability completion, optional evaluation or authored callbacks');
setTimeout(() => globalThis.close(), 0);
`;

test("deferred media preserves typed bodies, optional evaluation and explicit failures", () => {
    const result = compileSource(family, { deferredCapabilities });
    const sites = result.manifest.deferredCapabilities ?? [];
    const ids = new Set(sites.map((site) => site.id));
    for (const id of [
        "Audio.constructor",
        "HTMLMediaElement.preload",
        "HTMLMediaElement.loop",
        "HTMLMediaElement.duration",
        "HTMLMediaElement.currentTime",
        "HTMLAudioElement.addEventListener",
        "HTMLMediaElement.pause",
        "HTMLMediaElement.load",
        "HTMLMediaElement.play",
        "AudioContext.createMediaElementSource",
    ])
        assert.ok(ids.has(`dom:${id}`), id);
    assert.equal(
        sites.find((site) => site.id === "dom:HTMLMediaElement.play")?.timing,
        "reject",
    );
    assert.equal(
        sites.find((site) => site.id === "dom:Audio.constructor")?.operation,
        "construct",
    );
    assert.throws(
        () =>
            compileSource(
                family.replace(
                    "callbacksRun++;\n        if (audio.duration",
                    "new FinalizationRegistry(() => {});\n        if (audio.duration",
                ),
                { deferredCapabilities },
            ),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-media/family", result.cpp + runtime, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("media capability registration preserves strict and authored behavior", () => {
    assert.throws(
        () => compileSource("new Audio('sound.wav');"),
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

test("deferred script members retain exact typed sites", () => {
    const result = compileSource(
        `
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
        "HTMLScriptElement.src",
        "HTMLScriptElement.async",
        "HTMLScriptElement.addEventListener",
        "HTMLScriptElement.removeEventListener",
    ])
        assert.ok(ids.has(`dom:${id}`), id);
});
