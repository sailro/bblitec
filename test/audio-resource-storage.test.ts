import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "audio factory temporaries transfer ownership without moving source aliases",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import {createEngine, createAudioEngineAsync} from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const audio = await createAudioEngineAsync();
            const created = audio.audioContext.createGain();
            if (created.gain.value !== 7) throw new Error("created node");
            const alias = created;
            if (alias.gain.value !== 7 || created.gain.value !== 7) throw new Error("aliased node");
            const holder = {node: audio.audioContext.createGain()};
            const first = holder.node;
            const second = holder.node;
            if (first.gain.value !== 7 || second.gain.value !== 7 || holder.node.gain.value !== 7)
                throw new Error("cached temporary was moved");
        }
        void main();
    `);
        assert.match(
            result.cpp,
            /v_(?:fn\d+_)?created = bbl::js::take_temporary\(v_bblite_audio_node_\d+\)/,
        );
        assert.doesNotMatch(
            result.cpp,
            /take_temporary\(v_(?:fn\d+_)?(?:alias|created)\)/,
        );
        const directory = resolve("artifacts/audio-temporary-ownership");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "program.hpp"), result.cpp);
        const source = join(directory, "check.cpp");
        const executable = join(directory, "check.exe");
        writeFileSync(
            source,
            `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned int nodes = 0, reads = 0; }
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
        namespace bbl::pal {
            struct AudioNodeRecord {};
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) { return {1}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle) { return {++nodes, std::make_shared<AudioNodeRecord>()}; }
            AudioNodeHandle audio_destination(AudioContextHandle) { return {100, {}}; }
            void audio_connect(AudioNodeHandle, AudioNodeHandle) {}
            AudioParamHandle audio_node_param(AudioNodeHandle node, AudioParamName name) {
                ++reads;
                assert(node.value == (reads <= 3 ? 3u : 4u));
                // The second node has its factory temporary, stored member, and this parameter.
                assert(node.ownership.use_count() == (reads <= 3 ? 2 : 3));
                return {std::move(node), name};
            }
            float audio_param_value(AudioParamHandle) { return 7; }
        }
        int main() { assert(generated_main() == 0 && reads == 6); }
    `,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

test("unlowered media operations remain explicit refusals", () => {
    assert.throws(
        () =>
            compileSource(`
        const inspect: (stream: MediaStream) => void = stream => { stream.getAudioTracks(); };
    `),
        /not supported|not lowered|Unsupported|unsupported/,
    );
});

test(
    "retained audio nodes and parameters preserve identity across containers",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import {createEngine, createAudioEngineAsync} from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const audio = await createAudioEngineAsync();
            const output = {node: audio.audioContext.createGain()};
            const nodes: AudioNode[] = [output.node];
            const parameters = new Map<AudioParam, number>();
            parameters.set(output.node.gain, 2);
            const gains: AudioParam[] = [output.node.gain];
            nodes[0]!.connect(audio.audioContext.destination);
            gains[0]!.value = 7;
            if (parameters.get(gains[0]!) !== 2 || output.node.gain.value !== 7) throw new Error("audio identity");
            const streams = new Map<MediaStream, number>();
            const tracks = new Set<MediaStreamTrack>();
            if (streams.size !== 0 || tracks.size !== 0) throw new Error("empty media collections");
        }
        void main();
    `);
        const output = resolve("artifacts/audio-resource-storage");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "program.hpp"), result.cpp);
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned int nodes = 0; float gain = 1; }
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
        namespace bbl::pal {
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) { return {1}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle) { return {++nodes, {}}; }
            AudioNodeHandle audio_destination(AudioContextHandle) { return {100, {}}; }
            void audio_connect(AudioNodeHandle, AudioNodeHandle) {}
            AudioParamHandle audio_node_param(AudioNodeHandle node, AudioParamName name) { return {node, name}; }
            void audio_param_set_value(AudioParamHandle param, float value) { assert(param.node.value == 3); gain = value; }
            float audio_param_value(AudioParamHandle param) { assert(param.node.value == 3); return gain; }
        }
        int main() { assert(generated_main() == 0); assert(nodes == 3 && gain == 7); }
    `,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "/I",
            "native/include",
            file,
        ]);
        assert.equal(execFileSync(executable, { encoding: "utf8" }).trim(), "");
    },
);
