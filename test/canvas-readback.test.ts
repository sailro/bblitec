import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("canvas readbacks use aliased declarations and each invocation's arguments", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        import { paintPatch as buildSwatch } from "./fixtures/browser-texture/readback.js";
        async function main() {
            const engine = await createEngine({});
            buildSwatch(engine, "red");
            buildSwatch(engine, "blue");
        }
        main();
    `, { fileName: "test/readback-entry.ts" });
    const pixels = [...result.assetPayloads.values()].filter(value => value.startsWith("data:application/octet-stream;base64,"))
        .map(value => [...Buffer.from(value.slice(value.indexOf(",") + 1), "base64")]);
    assert.deepEqual(pixels, [[255, 0, 0, 255, 255, 0, 0, 255], [0, 0, 255, 255, 0, 0, 255, 255]]);
    assert.equal(result.manifest.adaptations.filter(value => value.id === "fetched-canvas-atlas").length, 1);
});

test("canvas readbacks refuse mutable module inputs", () => {
    assert.throws(() => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        import { mutablePatch } from "./fixtures/browser-texture/readback.js";
        async function main() {
            const engine = await createEngine({});
            mutablePatch(engine, "");
        }
        main();
    `, { fileName: "test/readback-mutable-entry.ts" }), /Canvas readback cannot mutate or capture mutable module bindings/);
});

test("audio decode helpers retain their ordinary statements and return value", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        let calls = 0;
        async function decode(context: BaseAudioContext, path: string) {
            calls += 1;
            const response = await fetch(path);
            const sound = await context.decodeAudioData(await response.arrayBuffer());
            calls += 2;
            return sound;
        }
        async function main() {
            const audio = await createAudioEngineAsync();
            await decode(audio.audioContext, "fixtures/compiler-modules/dynamic-audio/tone.wav");
        }
        main();
    `, { fileName: "test/audio-helper-entry.ts" });
    assert.equal(result.manifest.assets.length, 1);
    assert.match(result.cpp, /calls[^\n]*\+= 1\.0/);
    assert.match(result.cpp, /audio_decode_buffer/);
    assert.match(result.cpp, /calls[^\n]*\+= 2\.0/);
});
