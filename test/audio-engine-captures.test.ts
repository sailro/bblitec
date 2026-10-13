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
import {
    audioLibraryInclude,
    ENGINE_PARAMETER_STUBS,
} from "./static-sound-fixture.js";

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
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(
        file,
        `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace {
            unsigned int contexts = 0, nodes = 0;
            std::vector<std::pair<unsigned int, unsigned int>> edges;
        }
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
        ${ENGINE_PARAMETER_STUBS}
        namespace bbl::pal {
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) { return {++contexts}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle context) {
                assert(context.value == contexts);
                return {++nodes, {}};
            }
            AudioNodeHandle audio_destination(AudioContextHandle context) { return {100 + context.value, {}}; }
            void audio_connect(AudioNodeHandle source, AudioNodeHandle target) { edges.emplace_back(source.value, target.value); }
            void audio_disconnect(AudioNodeHandle) {}
        }
        int main() {
            // The entry realm awaits each lowered engine in place.
            assert(generated_main() == 0);
            const std::vector<std::pair<unsigned int, unsigned int>> expected{
                {1, 101}, {2, 1}, {4, 2}, {3, 4}, {5, 102}, {6, 5}, {8, 6}, {7, 8}};
            assert(contexts == 2 && nodes == 8 && edges == expected);
        }
    `,
    );
    runNativeFixtureCompiler(tools!, [
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        output,
        ...audioLibraryInclude("audio-engine-captures-check", result.manifest),
        file,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }).trim(), "");
}

test(
    "keeps an assigned audio engine's main bus in its factory closure storage",
    { skip: !tools },
    () => {
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
    },
);

test(
    "keeps an assigned audio engine's main bus in its class field storage",
    { skip: !tools },
    () => {
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
    },
);

test("a realm's audio engine opens its device in a native job and runs the pin's engine on the realm", () => {
    const output = resolve("artifacts/audio-engine-realm");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "worker.ts"), "self.close();");
    const result = compileSource(
        'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();' +
            `
        import { createAudioEngineAsync } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const audio = await createAudioEngineAsync();
            audio.audioContext.createGain().connect(audio.audioContext.destination);
        }
        void main();
    `,
        { fileName: join(output, "entry.ts") },
    );
    // The device opens in a native job; once it is open, the pin's own
    // `createAudioEngineAsync` builds the engine on the realm.
    assert.match(
        result.cpp,
        /bbl::pal::audio_create_context_async\(\w+\)\.then\(bbl::js::make_closure\(std::tuple\{\w+\}, \[\]\(auto& captured, const bbl::pal::AudioContextHandle& context\) \{ auto options = std::get<0>\(captured\); options\.audio_context = context; return bbl::create_audio_engine_async\(std::move\(options\)\); \}\)\)/,
    );
    assert.doesNotMatch(result.cpp, /bbl::pal::audio_create_context\(/);
    assert.deepEqual(result.manifest.audioLibraryRoots, [
        "createAudioEngineAsync",
    ]);
});

test("one audio library serves every realm: the functions any realm calls", () => {
    const output = resolve("artifacts/audio-library-realms");
    mkdirSync(output, { recursive: true });
    writeFileSync(
        join(output, "worker.ts"),
        `import { createAudioEngineAsync, getMasterVolume } from "@babylonjs/lite";
        const audio = await createAudioEngineAsync();
        self.postMessage(getMasterVolume(audio));`,
    );
    const result = compileSource(
        `import { createAudioEngineAsync, setMasterVolume } from "@babylonjs/lite";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        worker.terminate();
        async function main(): Promise<void> {
            setMasterVolume(await createAudioEngineAsync(), 0.5);
        }
        void main();`,
        { fileName: join(output, "entry.ts") },
    );
    assert.deepEqual([...(result.manifest.audioLibraryRoots ?? [])].sort(), [
        "createAudioEngineAsync",
        "getMasterVolume",
        "setMasterVolume",
    ]);
});
