import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    nativeFixtureLabSoundPresent,
    nativeFixtureLabSoundRoot,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
const labsound = nativeFixtureLabSoundRoot;

test(
    "audio playback preserves loops, rates and graph ownership",
    {
        skip: !tools || !nativeFixtureLabSoundPresent(),
    },
    () => {
        const output = resolve("artifacts/audio-lifetime-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "audio-lifetime-check.exe");
        runNativeFixtureCompiler(tools!, [
            "/O2",
            "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
            "/DBBLITE_HAS_AUDIO_OSCILLATOR=1",
            "/DBBLITE_HAS_AUDIO_BIQUAD_FILTER=1",
            "/DBBLITE_HAS_AUDIO_STEREO_PANNER=1",
            "/DBBLITE_AUDIO_CAPTURE=1",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            `/external:I${join(labsound, "include")}`,
            "test/fixtures/audio-lifetime-check.cpp",
            "/link",
            `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
            `/LIBPATH:${join(labsound, "lib")}`,
            "LabSound.lib",
            "libnyquist.lib",
            "SDL3.lib",
        ]);
        for (const realtime of [false, true]) {
            assert.match(
                execFileSync(executable, {
                    encoding: "utf8",
                    timeout: 30000,
                    env: {
                        ...tools!.environment,
                        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
                        BBLITE_TEST_REALTIME: realtime ? "1" : "",
                        SDL_AUDIODRIVER: "dummy",
                    },
                }),
                /audio-lifetime-check: ok/,
            );
        }
    },
);
