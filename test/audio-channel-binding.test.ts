import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("audio channel locals and aliases own shared typed-array views", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        const audio = await createAudioEngineAsync();
        const context = audio.audioContext;
        const buffer = context.createBuffer(1, 4, 48000);
        const channel = buffer.getChannelData(0);
        const alias = channel;
        const second = buffer.getChannelData(0);
        alias[0] = 0.5;
        second[1] = channel[0];
    `);

    const channelBindings = result.cpp.split("\n").filter((line) =>
        line.includes(" = bbl::pal::audio_buffer_channel("),
    );
    assert.equal(channelBindings.length, 2);
    for (const binding of channelBindings) {
        // The PAL returns a shared view by value; a native reference cannot
        // bind the temporary, and copying the view retains its PCM storage.
        assert.match(binding, /\bbbl::js::F32Array\s+\w+\s*=/);
    }
    assert.match(
        result.cpp,
        /\bbbl::js::F32Array\s+\w+_alias\s*=\s*\w+_channel;/,
    );
});
