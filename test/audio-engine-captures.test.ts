import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

function checkMainBusStorage(declarations: string): void {
    const result = compileSource(`
        import {
            createEngine, createAudioEngineAsync, createSoundSourceAsync,
            type AudioEngine,
        } from "@babylonjs/lite";
        ${declarations}
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const controls = createControls();
            const actions = new Set<() => void>();
            actions.add(() => { void controls.start(); });
            actions.add(() => { controls.connect(); });
            actions.add(() => { controls.reset(); });
            for (let run = 0; run < 2; run++) {
                for (const action of actions) action();
                controls.connect();
            }
        }
        void main();
    `);

    const output = resolve("artifacts/audio-engine-captures-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace {
            unsigned int contexts = 0, nodes = 0;
            std::vector<std::pair<unsigned int, unsigned int>> edges;
        }
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
        namespace bbl::pal {
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) { return {++contexts}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle context) {
                assert(context.value == contexts);
                return {++nodes, {}};
            }
            AudioNodeHandle audio_destination(AudioContextHandle context) { return {100 + context.value, {}}; }
            void audio_connect(AudioNodeHandle source, AudioNodeHandle target) { edges.emplace_back(source.value, target.value); }
        }
        int main() {
            assert(generated_main() == 0);
            const std::vector<std::pair<unsigned int, unsigned int>> expected{
                {1, 101}, {2, 1}, {4, 2}, {3, 4}, {5, 102}, {6, 5}, {8, 6}, {7, 8}};
            assert(contexts == 2 && nodes == 8 && edges == expected);
        }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include", file]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }).trim(), "");
}

test("keeps an assigned audio engine's main bus in its factory closure storage", { skip: !tools }, () => {
    checkMainBusStorage(`
        function createControls() {
            let audio: AudioEngine | null = null;
            async function start(): Promise<void> {
                audio = await createAudioEngineAsync();
            }
            function connect(): void {
                if (!audio) return;
                const output = audio.audioContext.createGain();
                void createSoundSourceAsync(audio, output);
            }
            function reset(): void { audio = null; }
            return { start, connect, reset };
        }
    `);
});

test("keeps an assigned audio engine's main bus in its class field storage", { skip: !tools }, () => {
    checkMainBusStorage(`
        class Controls {
            private audio: AudioEngine | null = null;
            async start(): Promise<void> {
                this.audio = await createAudioEngineAsync();
            }
            connect(): void {
                if (!this.audio) return;
                const output = this.audio.audioContext.createGain();
                void createSoundSourceAsync(this.audio, output);
            }
            reset(): void { this.audio = null; }
        }
        function createControls() { return new Controls(); }
    `);
});
