import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
const labsound = resolve("artifacts/tools/labsound");

test("discarded one-shot graphs reclaim nodes and PCM while retained handles stay valid", {
    skip: !tools || !existsSync(join(labsound, "lib/LabSound.lib")),
}, () => {
    const output = resolve("artifacts/audio-lifetime-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "audio-lifetime-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1", "/DBBLITE_HAS_AUDIO_OSCILLATOR=1",
        "/DBBLITE_HAS_AUDIO_BIQUAD_FILTER=1", "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1", "/DBBLITE_HAS_AUDIO_CAPTURE=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, `/external:I${join(labsound, "include")}`, "/external:W0",
        "test/fixtures/audio-lifetime-check.cpp", "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, `/LIBPATH:${join(labsound, "lib")}`,
        "LabSound.lib", "libnyquist.lib", "SDL3.lib",
    ]);
    for (const realtime of [false, true]) {
        assert.match(execFileSync(executable, {
            encoding: "utf8", timeout: 30000,
            env: { ...tools!.environment,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
                BBLITE_TEST_REALTIME: realtime ? "1" : "",
                SDL_AUDIODRIVER: "dummy",
            },
        }), /audio-lifetime-check: ok/);
    }
});
