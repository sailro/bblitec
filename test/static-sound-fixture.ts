/** Shared by the static and spatial sound tests: WAVE input and LabSound programs. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
    nativeFixtureLabSoundPresent,
    nativeFixtureLabSoundRoot,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
const labsound = nativeFixtureLabSoundRoot;

/** Whether the native compiler and the pinned LabSound library are present. */
export const native = Boolean(tools && nativeFixtureLabSoundPresent());

/** A mono 16-bit 48 kHz WAVE file holding `level` for `seconds`. */
export function wave(level: number, seconds: number): Buffer {
    const frames = Math.round(seconds * 48000);
    const data = Buffer.alloc(frames * 2);
    for (let index = 0; index < frames; index++)
        data.writeInt16LE(Math.round(level * 32767), index * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(96000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/** Compile a LabSound translation unit with the web platform seam, then run it. */
export function runAudioProgram(
    output: string,
    source: string,
    flags: readonly string[],
    args: readonly string[],
): string {
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/O2",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
        "/DBBLITE_HAS_AUDIO_DECODE_FILE=1",
        "/DBBLITE_AUDIO_DECODE_WAV=1",
        // A sound program decodes no image through the seam.
        "/DBBLITE_HAS_IMAGE_DECODER=0",
        "/DBBLITE_HAS_WEBP_DECODER=0",
        ...flags,
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        `/external:I${join(labsound, "include")}`,
        source,
        "native/src/pal_web_platform.cpp",
        "native/src/pal_http.cpp",
        "native/src/pal.cpp",
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        `/LIBPATH:${join(labsound, "lib")}`,
        "LabSound.lib",
        "libnyquist.lib",
        "SDL3.lib",
        "winhttp.lib",
    ]);
    return execFileSync(executable, args, {
        cwd: output,
        encoding: "utf8",
        timeout: 60000,
        env: {
            ...tools!.environment,
            SDL_AUDIODRIVER: "dummy",
            BBLITE_AUDIO_CAPTURE: "",
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
        },
    });
}

/**
 * The window application a generated program's `main` runs in a fixture:
 * an application realm on one event loop, whose errors fail the run.
 */
export const FIXTURE_APPLICATION = `std::string bbl::asset_path(const std::string& path) { return "assets/" + path; }
namespace bbl::pal {
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.on_unhandled_rejection([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal
int main() { return generated_main(); }
`;
