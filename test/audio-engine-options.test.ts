import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import {
    audioLibraryInclude,
    ENGINE_PARAMETER_STUBS,
} from "./static-sound-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "a shared audio engine adopts the context an application routes",
    { skip: !tools },
    () => {
        // The application shape: one lazily created engine on a context
        // the application routed, shared through a module promise, in a
        // realm (the timer yield stands for the rest of the application).
        const result = compileSource(`
            import {createAudioEngineAsync, type AudioEngine} from "@babylonjs/lite";
            function createRoutedContext(): { context: AudioContext; release: () => void } {
                const context = new AudioContext();
                return { context, release: () => {} };
            }
            let enginePromise: Promise<AudioEngine> | null = null;
            let created = 0;
            function sharedEngine(): Promise<AudioEngine> {
                if (!enginePromise) {
                    const { context } = createRoutedContext();
                    enginePromise = createAudioEngineAsync({ audioContext: context }).then((engine) => {
                        if (engine.audioContext !== context) throw new Error("adopted context");
                        ++created;
                        return engine;
                    });
                }
                return enginePromise;
            }
            async function main(): Promise<void> {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                const first = await sharedEngine();
                const second = await sharedEngine();
                if (first !== second || created !== 1) throw new Error("shared engine");
                globalThis.close();
            }
            void main();
        `);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        // The adopted context is already open: the pin's function runs at
        // the call, and no device opens.
        assert.match(result.cpp, /bbl::create_audio_engine_async\(\w+\)/);
        assert.doesNotMatch(result.cpp, /audio_create_context_async/);
        runGeneratedProgram(
            tools!,
            "audio-engine-options/adopted",
            `${result.cpp}
            #include <cassert>
            // One context, the application's; the pin's engine builds its
            // main out and main bus on it: out -> destination, bus -> out.
            ${ENGINE_PARAMETER_STUBS}
            namespace { std::uint32_t contexts = 0, nodes = 0, edges = 0; }
            namespace bbl::pal {
                AudioSession::~AudioSession() = default;
                AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) {
                    assert(contexts == 0);
                    return {++contexts};
                }
                AudioNodeHandle audio_create_gain(AudioContextHandle context) {
                    assert(context.value == 1 && nodes < 2);
                    return {++nodes, {}};
                }
                AudioNodeHandle audio_destination(AudioContextHandle context) { return {100 + context.value, {}}; }
                void audio_connect(AudioNodeHandle from, AudioNodeHandle to) {
                    assert(edges++ == 0 ? from.value == 1 && to.value == 101 : from.value == 2 && to.value == 1);
                }
            }
        `,
            {
                flags: [
                    "/DBBLITE_WORKERS=1",
                    ...audioLibraryInclude(
                        "audio-engine-options/adopted",
                        result.manifest,
                    ),
                ],
                timeoutMs: 10000,
            },
        );
    },
);

test("engine options refuse the members the native engine does not honour", () => {
    const imports = 'import {createAudioEngineAsync} from "@babylonjs/lite";';
    // The pin's engine reads its volume and ramp duration...
    const honoured = compileSource(
        `${imports}void createAudioEngineAsync({audioContext:new AudioContext(),volume:0.5,parameterRampDuration:0});`,
    );
    assert.match(honoured.cpp, /\.volume = /);
    assert.match(honoured.cpp, /\.parameter_ramp_duration = /);
    // ...and the resume switches only in hooks a native engine never installs.
    for (const member of [
        "resumeOnInteraction:false",
        "resumeOnPause:false",
        "resumeOnPauseRetryInterval:10",
    ])
        assert.throws(
            () =>
                compileSource(
                    `${imports}void createAudioEngineAsync({audioContext:new AudioContext(),${member}});`,
                ),
            new RegExp(
                `Audio engine option '${member.split(":")[0]}' is not lowered: the native engine installs no`,
            ),
        );
    const absent = compileSource(
        `${imports}void createAudioEngineAsync({audioContext:undefined});`,
    );
    assert.match(absent.cpp, /audio_create_context\(bbl_audio_session\)/);
});
