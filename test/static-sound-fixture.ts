/**
 * Shared by the audio tests: LabSound programs over the web platform seam,
 * and the audio library header and PAL stubs a compiled program's fixture
 * needs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    audioLibraryRoots,
    staticSoundLibraryHeader,
} from "../src/lowering/static-sound-library.js";
import {
    nativeFixtureLibrary,
    optionalNativeFixtureTools,
    runLabSoundFixture,
    windowApplicationHost,
} from "./native-fixture.js";

/** Whether the native compiler and the pinned LabSound library are present. */
export const native = Boolean(
    optionalNativeFixtureTools() && nativeFixtureLibrary("labsound"),
);

/** Compile a LabSound translation unit with the web platform seam, then run it. */
export function runAudioProgram(
    output: string,
    source: string,
    flags: readonly string[],
    args: readonly string[],
): string {
    return runLabSoundFixture({
        output,
        source,
        webPlatform: true,
        args,
        flags: [
            "/DBBLITE_WORKERS=1",
            "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
            "/DBBLITE_HAS_AUDIO_DECODE_FILE=1",
            "/DBBLITE_AUDIO_DECODE_WAV=1",
            // A sound program decodes no image through the seam.
            "/DBBLITE_HAS_IMAGE_DECODER=0",
            "/DBBLITE_HAS_WEBP_DECODER=0",
            ...flags,
        ],
    });
}

/**
 * The window application a generated program's `main` runs in a fixture:
 * an application realm on one event loop, whose errors fail the run.
 */
export const FIXTURE_APPLICATION = `std::string bbl::asset_path(const std::string& path) { return "assets/" + path; }
${windowApplicationHost()}
int main() { return generated_main(); }
`;

/**
 * The audio library header a compiled program includes
 * (`<bblite/upstream_static_sound.hpp>`, holding the roots its manifest
 * records), written under `artifacts/<name>/include`; returns the include
 * flags its fixture compiles with.
 */
export function audioLibraryInclude(
    name: string,
    manifest: { audioLibraryRoots?: string[] },
): string[] {
    const include = resolve("artifacts", name, "include");
    const header = join(include, "bblite/upstream_static_sound.hpp");
    mkdirSync(dirname(header), { recursive: true });
    writeFileSync(
        header,
        staticSoundLibraryHeader(
            sharedPinnedContext(),
            audioLibraryRoots(manifest.audioLibraryRoots),
        ),
    );
    return ["/I", include];
}

/**
 * The schedule the lowered engine's master-volume ramp writes, for a
 * fixture that stubs the PAL: nothing is scheduled.
 */
export const ENGINE_RAMP_STUBS = `
namespace bbl::pal {
void audio_param_cancel_scheduled_values(AudioParamHandle, double) {}
double audio_current_time(AudioContextHandle) { return 0.0; }
void audio_param_set_value_at_time(AudioParamHandle, float, double) {}
void audio_param_set_value_curve(AudioParamHandle, const bbl::js::F32Array&, double, double) {}
}
`;

/**
 * The whole parameter surface the lowered engine reaches, for a fixture
 * that stubs the PAL: a parameter reads its default and schedules nothing.
 */
export const ENGINE_PARAMETER_STUBS = `${ENGINE_RAMP_STUBS}
namespace bbl::pal {
AudioParamHandle audio_node_param(AudioNodeHandle node, AudioParamName name) { return {node, name}; }
float audio_param_value(AudioParamHandle) { return 1.0f; }
void audio_param_set_value(AudioParamHandle, float) {}
}
`;
