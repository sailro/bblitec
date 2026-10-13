import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
const labsound = resolve("artifacts/tools/labsound");
const native = Boolean(tools && existsSync(join(labsound, "lib/LabSound.lib")));

/** Compile one LabSound fixture translation unit and run it. */
function runLabSoundFixture(
    output: string,
    source: string,
    flags: readonly string[],
    environment: Record<string, string>,
): string {
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/O2",
        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
        "/DBBLITE_HAS_AUDIO_OSCILLATOR=1",
        ...flags,
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        `/external:I${join(labsound, "include")}`,
        source,
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        `/LIBPATH:${join(labsound, "lib")}`,
        "LabSound.lib",
        "libnyquist.lib",
        "SDL3.lib",
    ]);
    return execFileSync(executable, {
        cwd: output,
        encoding: "utf8",
        timeout: 30000,
        env: {
            ...tools!.environment,
            ...environment,
            SDL_AUDIODRIVER: "dummy",
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
        },
    });
}

test(
    "targeted disconnects, value curves, loop points and optional durations reach LabSound",
    { skip: !native },
    () => {
        const output = resolve("artifacts/audio-graph-edits-check");
        mkdirSync(output, { recursive: true });
        assert.match(
            runLabSoundFixture(
                output,
                "test/fixtures/audio-graph-edits-check.cpp",
                ["/DBBLITE_AUDIO_CAPTURE=1"],
                {},
            ),
            /audio-graph-edits-check: ok/,
        );
    },
);

test("application Web Audio lowers targeted disconnects, value curves and loop points onto the PAL", (t) => {
    const result = compileSource(`
        const context = new AudioContext();
        const buffer = context.createBuffer(1, 480, 48000);
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index++) samples[index] = 0.25;
        const source = context.createBufferSource();
        source.buffer = buffer;
        const left = context.createGain();
        const right = context.createGain();
        source.connect(left);
        source.connect(right);
        left.connect(context.destination);
        right.connect(context.destination);
        source.disconnect(left);
        let refused = "";
        try {
            source.disconnect(left);
        } catch (error) {
            refused = (error as DOMException).name;
        }
        try {
            source.disconnect(right, 1);
        } catch (error) {
            refused += " " + (error as DOMException).name;
        }
        source.disconnect(right, 0, 0);
        const curve = new Float32Array([0, 1]);
        left.gain.cancelScheduledValues(0);
        left.gain.setValueCurveAtTime(curve, context.currentTime, 0.01);
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = 0;
        const points = source.loop && source.loopStart === 0 && source.loopEnd === 0;
        source.start(0, 0);
        if (refused !== "InvalidAccessError IndexSizeError" || !points)
            throw new Error("graph edits: " + refused);

    `);
    assert.match(
        result.cpp,
        /bbl::pal::audio_disconnect\(v_bblite_audio_disconnect_source_\d+, v_bblite_audio_disconnect_destination_\d+\)/,
    );
    assert.match(result.cpp, /bbl::pal::audio_param_set_value_curve\(/);
    assert.match(result.cpp, /bbl::pal::audio_set_loop_start\(/);
    assert.match(result.cpp, /bbl::pal::audio_loop_end\(/);
    assert.throws(
        () =>
            compileSource(
                "const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g.gain); o.disconnect(g.gain);",
            ),
        /disconnect\(AudioParam\) is not lowered/,
    );
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const output = resolve("artifacts/audio-graph-edits-program");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    writeFileSync(
        join(output, "check.cpp"),
        `#include "pal_audio_labsound.cpp"
#define main generated_main
#include "program.hpp"
#undef main
#include <cstdlib>
#include <string>
namespace bbl::pal {
std::string environment_variable(const char* name) {
    char* value = nullptr;
    std::size_t length = 0;
    _dupenv_s(&value, &length, name);
    const std::string result = value ? value : "";
    std::free(value);
    return result;
}
} // namespace bbl::pal
int main() { return generated_main(); }
`,
    );
    assert.equal(
        runLabSoundFixture(output, join(output, "check.cpp"), [], {
            BBLITE_AUDIO_CAPTURE: "",
        }),
        "",
    );
});
