/** Shared by the sound tests: LabSound programs over the web platform seam. */
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
