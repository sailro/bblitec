import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("stored audio APIs preserve routing, optional node calls, and source disposal ownership", (t) => {
    const result = compileSource(`
        import {createEngine, createAudioEngineAsync, createSoundSourceAsync,
            disposeSoundSource, disposeAudioEngine} from "@babylonjs/lite";
        interface AudioApi {
            create: typeof createAudioEngineAsync;
            connect: typeof createSoundSourceAsync;
            disposeSource: typeof disposeSoundSource;
            disposeEngine: typeof disposeAudioEngine;
            disconnect: (node: GainNode | null) => void;
        }
        async function main() {
            const renderer = await createEngine({});
            const apis = new Map<number, AudioApi>();
            apis.set(1, {create: createAudioEngineAsync, connect: createSoundSourceAsync,
                disposeSource: disposeSoundSource, disposeEngine: disposeAudioEngine,
                disconnect: node => { node?.disconnect(); }});
            const api = apis.get(1)!;
            const engine = await api.create();
            const input = engine.audioContext.createGain();
            const source = await api.connect(engine, input);
            api.disconnect(null);
            api.disconnect(input);
            api.disposeSource(source);
            api.disposeSource(source);
            const second = await api.connect(engine, engine.audioContext.createGain());
            api.disposeEngine(engine);
            api.disposeSource(second);
        }
        void main();
    `);
    assert.match(result.cpp, /sound-source\.ts.*disposeSoundSource/);
    assert.match(result.cpp, /sound-sub-graph\.ts.*disposeSoundSubGraph/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/audio-source-lifecycle-check");
    mkdirSync(directory, { recursive: true });
    const source = resolve(directory, "check.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(
        source,
        `
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        namespace { unsigned int nodes = 0; bool closed = false;
            std::vector<unsigned int> disconnected;
            std::vector<std::pair<unsigned int, unsigned int>> edges; }
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
        namespace bbl::pal {
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) { return {1}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle context) { assert(context.value == 1); return {++nodes, {}}; }
            AudioNodeHandle audio_destination(AudioContextHandle) { return {100, {}}; }
            void audio_connect(AudioNodeHandle from, AudioNodeHandle to) { edges.emplace_back(from.value, to.value); }
            void audio_disconnect(AudioNodeHandle node) { disconnected.push_back(node.value); }
            void audio_close_context(AudioContextHandle context) {
                assert(context.value == 1 && disconnected.size() == 6); closed = true;
            }
        }
        int main() {
            assert(generated_main() == 0);
            const std::vector<unsigned int> expectedDisconnects{3, 3, 4, 4, 5, 6, 6};
            const std::vector<std::pair<unsigned int, unsigned int>> expectedEdges{{1,100},{2,1},{4,2},{3,4},{6,2},{5,6}};
            assert(nodes == 6 && closed && disconnected == expectedDisconnects && edges == expectedEdges);
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});
