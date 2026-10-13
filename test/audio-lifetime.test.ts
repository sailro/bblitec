import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    nativeFixtureLibrary,
    optionalNativeFixtureTools,
    runLabSoundFixture,
} from "./native-fixture.js";

test(
    "audio playback preserves loops, rates and graph ownership",
    {
        skip:
            !optionalNativeFixtureTools() || !nativeFixtureLibrary("labsound"),
    },
    () => {
        const output = resolve("artifacts/audio-lifetime-check");
        mkdirSync(output, { recursive: true });
        for (const realtime of [false, true]) {
            assert.match(
                runLabSoundFixture({
                    output,
                    source: "test/fixtures/audio-lifetime-check.cpp",
                    flags: [
                        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
                        "/DBBLITE_HAS_AUDIO_OSCILLATOR=1",
                        "/DBBLITE_HAS_AUDIO_BIQUAD_FILTER=1",
                        "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1",
                        "/DBBLITE_AUDIO_CAPTURE=1",
                    ],
                    env: { BBLITE_TEST_REALTIME: realtime ? "1" : "" },
                }),
                /audio-lifetime-check: ok/,
            );
        }
    },
);
