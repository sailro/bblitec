import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    STATIC_SOUND_ROOTS,
    staticSoundLibraryHeader,
} from "../src/lowering/static-sound-library.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    serveHttpFixture,
} from "./native-fixture.js";

test("the pinned static-sound functions lower whole over the Web Audio records and the engine views", (t) => {
    const header = staticSoundLibraryHeader(
        sharedPinnedContext(),
        STATIC_SOUND_ROOTS,
    );
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
// The lowered sound functions, compiled against the runtime and PAL headers.
bbl::js::Promise<std::shared_ptr<bbl::StaticSound>> create(bbl::AudioEngineHandle engine) {
    bbl::StaticSoundOptions options{};
    options.max_instances = 4.0;
    return bbl::create_sound_async(engine, std::string("sounds/a.ogg"), options);
}
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

test("the pinned format probe runs over its dictionary, the linked decoders and the engine's caches", (t) => {
    // With the static-sound part, whose sounds probe formats.
    const header = staticSoundLibraryHeader(sharedPinnedContext(), [
        ...STATIC_SOUND_ROOTS,
        "isAudioFormatValid",
    ]);
    assert.match(header, /bbl::pal::audio_can_play_type\(/);
    assert.match(header, /get_owned\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    for (const wav of [true, false]) {
        const output = resolve(
            `artifacts/static-sound-format-check-${wav ? "wav" : "none"}`,
        );
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "format.hpp"), header);
        writeFileSync(
            join(output, "check.cpp"),
            `#include "format.hpp"
#include <cstdio>
#include <cstdlib>
static void check(bool condition, const char* what) {
    if (!condition) { std::fputs(what, stderr); std::exit(1); }
}
int main() {
    bbl::AudioEngineHandle engine{};
    const bool wav = ${wav ? "true" : "false"};
    check(bbl::is_audio_format_valid(engine, "wav") == wav, "wav answer");
    check(engine.valid_formats.has("wav") == wav && engine.invalid_formats.has("wav") == !wav, "wav cache");
    check(bbl::is_audio_format_valid(engine, "wav") == wav, "cached answer");
    check(!bbl::is_audio_format_valid(engine, "aac") && engine.invalid_formats.has("aac"), "aac");
    check(!bbl::is_audio_format_valid(engine, "xyz") && !engine.invalid_formats.has("xyz"), "unknown format");
    check(bbl::pal::audio_can_play_type(bbl::pal::audio_create_element(), "AUDIO/WAV; codecs=1") == (wav ? "maybe" : ""), "parameters");
    check(bbl::pal::audio_can_play_type(bbl::pal::audio_create_element(), "audio/wav; codecs=\\"2\\"").empty(), "codec");
    return 0;
}
`,
        );
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_WORKERS=1",
            `/DBBLITE_AUDIO_DECODE_WAV=${wav ? 1 : 0}`,
            "/DBBLITE_AUDIO_DECODE_MP3=0",
            `/I${output}`,
            join(output, "check.cpp"),
            `/Fo${join(output, "check.obj")}`,
            `/Fe${join(output, "check.exe")}`,
        ]);
        execFileSync(join(output, "check.exe"), { stdio: "pipe" });
    }
});

test("the pinned audio fetch reads packaged responses and rejects a failed status with the pin's message", async (t) => {
    // With the static-sound part, whose sounds fetch their URLs.
    const header = staticSoundLibraryHeader(sharedPinnedContext(), [
        ...STATIC_SOUND_ROOTS,
        "loadAudioArrayBuffer",
    ]);
    assert.match(header, /bbl::web_platform::fetch\(/);
    assert.match(header, /response_array_buffer\(/);
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const base = await serveHttpFixture(t, (_request, response) => {
        response.writeHead(404);
        response.end("no");
    });
    const output = resolve("artifacts/static-sound-fetch-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "library.hpp"), header);
    const packaged = join(output, "sound.bin");
    writeFileSync(packaged, Uint8Array.of(82, 73, 70, 70, 1, 2));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        "/DBBLITE_HAS_WEBP_DECODER=1",
        resolve("test/fixtures/static-sound-fetch-check.cpp"),
        "native/src/pal_web_platform.cpp",
        "native/src/pal_http.cpp",
        "native/src/pal_image.cpp",
        "native/src/pal.cpp",
        `/Fo${output}/`,
        `/Fe${executable}`,
        join(nativeFixtureVcpkgRoot, "lib/libwebp.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"),
        "/link",
        "winhttp.lib",
    ]);
    const { stdout } = await promisify(execFile)(executable, [base, packaged], {
        timeout: 60000,
        env: {
            ...process.env,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
        },
    });
    // Each line whole (the empty statusText leaves the message's last space).
    assert.deepEqual(stdout.replaceAll("\r\n", "\n").split("\n").slice(0, -1), [
        "packaged 6 82",
        `missing HTTP 404 loading '${base}/missing.wav': `,
    ]);
});
