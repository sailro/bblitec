import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { sharedPinnedContext } from "../src/lowering/context.js";
import { staticSoundLibraryHeader } from "../src/lowering/static-sound-library.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("the pinned sound playback functions lower over the Web Audio records and the engine views", (t) => {
    const header = staticSoundLibraryHeader(sharedPinnedContext(), [
        "playSound",
        "stopSound",
        "setSoundVolume",
        "disposeSound",
    ]);
    // A sound is an engine sound; signals are monomorphized per element.
    assert.match(header, /struct StaticSound : bbl::AudioEngineSound \{/);
    assert.match(header, /struct AudioSignalOfStaticSound\b/);
    assert.match(header, /struct AudioSignalOfSoundInstance\b/);
    // Instances are AudioBufferSourceNodes over the PAL, ramps value curves.
    assert.match(
        header,
        /bbl::pal::audio_create_buffer_source\([^;]*bbl::pal::AudioBufferSourceInit/,
    );
    assert.match(header, /bbl::pal::audio_param_set_value_curve\(/);
    assert.match(header, /bbl::pal::audio_add_ended_listener\(/);
    assert.match(header, /engine\.sources\.erase\(/);
    assert.match(header, /does not report\./);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/static-sound-library-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "static_sound.hpp"), header);
    writeFileSync(
        join(output, "check.cpp"),
        `#include "static_sound.hpp"
// The lowered playback functions, compiled against the runtime and PAL headers.
void use(std::shared_ptr<bbl::StaticSound> sound) {
    bbl::play_sound(sound, bbl::StaticSoundPlayOptions{});
    bbl::set_sound_volume(sound, 0.5);
    bbl::stop_sound(sound);
    bbl::dispose_sound(sound);
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/c",
        `/I${output}`,
        join(output, "check.cpp"),
        `/Fo${join(output, "check.obj")}`,
    ]);
});
