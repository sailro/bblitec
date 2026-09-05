import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

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
            for (const action of actions) action();
        }
        void main();
    `);

    const storage = result.cpp.match(
        /auto (\w+) = bbl::js::make_gc_shared<bbl::pal::AudioNodeHandle>\(bbl::pal::AudioNodeHandle\{\}\);/,
    )?.[1];
    assert.ok(storage, "the mutable engine owns stable main-bus storage");
    assert.equal(
        result.cpp.match(new RegExp(`std::tuple\\{[^}\\n]*\\b${storage}\\b`, "g"))?.length,
        3,
        "all sibling callbacks retain the same main-bus cell",
    );
    assert.doesNotMatch(result.cpp, new RegExp(`std::ref\\(${storage}\\)`));
    assert.match(result.cpp, new RegExp(
        `\\(\\*${storage}\\) = v_bblite_audio_engine_\\d+_main_bus;`,
    ));
    assert.match(result.cpp, new RegExp(
        `bbl::pal::audio_connect\\(\\w+, \\(\\*${storage}\\)\\);`,
    ));
    assert.match(result.cpp, new RegExp(
        `\\(\\*${storage}\\) = bbl::pal::AudioNodeHandle\\{\\};`,
    ));
    assert.doesNotMatch(result.cpp,
        /std::tuple\{[^}\n]*v_bblite_audio_engine_\d+_main_bus/,
        "producer-local main buses never escape into sibling capture environments");
}

test("keeps an assigned audio engine's main bus in its factory closure storage", () => {
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

test("keeps an assigned audio engine's main bus in its class field storage", () => {
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
