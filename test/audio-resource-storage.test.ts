import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("unlowered media operations remain explicit refusals", () => {
    assert.throws(() => compileSource(`
        const inspect: (stream: MediaStream) => void = stream => { stream.getAudioTracks(); };
    `), /not supported|not lowered|Unsupported|unsupported/);
});

test("retained audio nodes and parameters preserve identity across containers", { skip: !tools }, () => {
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
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `
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
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }).trim(), "");
});
