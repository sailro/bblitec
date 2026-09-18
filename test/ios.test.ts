import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { iosCaptureEnvironment, selectIosSimulator, verifyIosNativeExit } from "../src/ios-simulator.js";
import { resolveScene } from "../src/scene-registry.js";
import { measuredRunEnvironment, nativeCaptureFrameBudget } from "../src/tooling/native-run.js";
import { cppFunction, cppSection, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-16-2";
const first = { udid: "11111111-1111-1111-1111-111111111111", name: "iPhone", state: "Booted", isAvailable: true };
const second = { ...first, udid: "22222222-2222-2222-2222-222222222222", state: "Shutdown" };
const inventory = (devices: unknown[]) => JSON.stringify({ devices: {
    [runtime]: devices,
    "com.apple.CoreSimulator.SimRuntime.tvOS-16-2": [{ ...first, udid: "tv" }],
} });

test("iOS captures select an explicit available simulator without claiming a tvOS or ambiguous booted device", () => {
    assert.deepEqual(selectIosSimulator(inventory([first, second]), "booted"),
        { udid: first.udid, name: first.name, state: first.state, runtime });
    assert.equal(selectIosSimulator(inventory([first, second]), second.udid).state, "Shutdown");
    assert.throws(() => selectIosSimulator(inventory([first]), "tv"), /found 0/);
    assert.throws(() => selectIosSimulator(inventory([first, { ...second, state: "Booted" }]), "booted"), /found 2/);
    assert.throws(() => selectIosSimulator(inventory([{ ...first, isAvailable: false }]), first.udid), /found 0/);
    for (const value of ["null", "{}", '{"devices":[]}', '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-16-2":null}}', inventory([{}])]) {
        assert.throws(() => selectIosSimulator(value, "booted"), /simctl/);
    }
});

test("iOS smoke keeps the registered pose, capture frame and backend while disabling physical input", () => {
    for (const id of ["scene1", "torus-states", "scene304"]) {
        const scene = resolveScene(id);
        const original = structuredClone(scene.parity?.nativeEnvironment);
        for (const backend of ["sdl_gpu", "dawn"] as const) {
            const environment = iosCaptureEnvironment(scene, backend);
            assert.deepEqual(environment, { ...original, BBLITE_GPU_BACKEND: backend,
                BBLITE_GPU_DEBUG: "1", BBLITE_TEST_PASS: "1", BBLITE_MAX_FRAMES: String(nativeCaptureFrameBudget(original)) });
            assert.deepEqual(scene.parity?.nativeEnvironment, original);
        }
    }
});

test("iOS canvas-only capture changes only UI pixels, not registry timing or renderer selection", () => {
    const scene = resolveScene("littlest-tokyo");
    for (const backend of ["dawn", "sdl_gpu"] as const) {
        const ordinary = iosCaptureEnvironment(scene, backend);
        assert.deepEqual(iosCaptureEnvironment(scene, backend, { canvasOnly: true }),
            { ...ordinary, BBLITE_CAPTURE_UI: "0" });
        assert.deepEqual(iosCaptureEnvironment(scene, backend, { canvasOnly: false }), ordinary);
    }
});

test("iOS smoke refuses failed, missing, duplicate and stale native exits", () => {
    verifyIosNativeExit("startup\nNative exit: 0 run=current\n", "current");
    assert.throws(() => verifyIosNativeExit("Native exit: 1 run=current\n", "current"), /status 1/);
    for (const log of ["", "Native exit: 0 run=old\n",
        "Native exit: 0 run=current\nNative exit: 0 run=current\n"]) {
        assert.throws(() => verifyIosNativeExit(log, "current"), /one exit/);
    }
});

test("desktop and Simulator measurements share frame, pose and replay precedence", () => {
    const scene = resolveScene("torus-states");
    const options = { frame: 40, tape: ["-*30", "UiClick@260:197"], testPass: false };
    const environment = iosCaptureEnvironment(scene, "dawn", options);
    assert.deepEqual(environment, measuredRunEnvironment({ ...options, environment: scene.parity?.nativeEnvironment ?? {},
        backend: "dawn", extra: { BBLITE_GPU_BACKEND: "dawn", BBLITE_GPU_DEBUG: "1" } }));
    assert.equal(environment.BBLITE_SCREENSHOT_FRAME, "40");
    assert.equal(environment.BBLITE_MAX_FRAMES, "41");
    assert.equal(environment.BBLITE_TEST_PASS, "0");
    assert.equal(environment.BBLITE_INPUT_REPLAY, "-*30,UiClick@260:197");
    assert.equal(environment.BBLITE_FRAME_DELTA_MS, scene.parity?.nativeEnvironment?.BBLITE_FRAME_DELTA_MS);
});

const tools = discoverDevelopmentTools();
test("iOS dependency triplets keep static libraries and isolate device and simulator architectures", { skip: !tools.cmake }, t => {
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-triplets-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [triplet, arch, sdk] of [
        ["arm64-ios-bblite", "arm64", "iphoneos"],
        ["arm64-ios-simulator-bblite", "arm64", "iphonesimulator"],
        ["x64-ios-simulator-bblite", "x64", "iphonesimulator"],
    ]) {
        const script = join(directory, "triplet.cmake"), output = join(directory, "values.txt");
        writeFileSync(script, `set(CMAKE_HOST_APPLE FALSE)
include("${resolve("native/triplets", `${triplet}.cmake`).replaceAll("\\", "/")}")
file(WRITE "${output.replaceAll("\\", "/")}" "\${VCPKG_TARGET_ARCHITECTURE};\${VCPKG_OSX_SYSROOT};\${VCPKG_LIBRARY_LINKAGE};\${VCPKG_CMAKE_SYSTEM_NAME};\${VCPKG_OSX_DEPLOYMENT_TARGET}")
`);
        execFileSync(tools.cmake!, ["-P", script]);
        assert.equal(readFileSync(output, "utf8"), `${arch};${sdk};static;iOS;16.0`);
    }
});

test("iOS CMake refuses unsupported renderers and admits reached document pickers", { skip: !tools.cmake }, t => {
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-configure-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const guard = cppSection(cmake, "if(IOS)", 'include("${BBLITE_NATIVE_ROOT}/compiler-cache.cmake")');
    const script = join(directory, "guard.cmake");
    writeFileSync(script, `set(IOS TRUE)\n${guard}`);
    const configure = (backend: string, sdk: string, features = "") => spawnSync(tools.cmake!,
        [`-DCMAKE_OSX_SYSROOT=${sdk}`, `-DBBLITE_BACKEND=${backend}`, `-DBBLITE_RUNTIME_FEATURES=${features}`, "-P", script],
        { encoding: "utf8", windowsHide: true });
    assert.equal(configure("DAWN", "iphonesimulator").status, 0);
    assert.equal(configure("SDL_GPU", "iphoneos").status, 0);
    for (const backend of ["SDL_GPU", "BOTH"]) {
        const result = configure(backend, "Xcode/Platforms/iPhoneSimulator.platform/SDK");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Simulator requires BBLITE_BACKEND=DAWN/);
    }
    const files = configure("DAWN", "iphoneos", "browser:file");
    assert.equal(files.status, 0, files.stderr);
});

test("an explicit Dawn install replaces a cached package selection", { skip: !tools.cmake }, t => {
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-dawn-selection-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const selection = cppSection(cmake.replaceAll("\r\n", "\n"), '    set(\n        Dawn_DIR', "    # The static monolithic Dawn export");
    const prefix = directory.replaceAll("\\", "/");
    for (const name of ["first", "second"]) {
        const config = join(directory, name, "lib/cmake/Dawn");
        mkdirSync(config, { recursive: true });
        writeFileSync(join(config, "DawnConfig.cmake"), `set(SELECTED_DAWN "${name}")\n`);
    }
    const script = join(directory, "select.cmake");
    writeFileSync(script, `set(BBLITE_DAWN_DIR "${prefix}/first")
${selection}
if(NOT SELECTED_DAWN STREQUAL "first")
    message(FATAL_ERROR "Initial Dawn selection failed.")
endif()
set(BBLITE_DAWN_DIR "${prefix}/second")
${selection}
if(NOT SELECTED_DAWN STREQUAL "second")
    message(FATAL_ERROR "Stale Dawn package was retained.")
endif()
`);
    execFileSync(tools.cmake!, ["-P", script], { stdio: "pipe" });
});

test("iOS compiler arguments and dependency scripts parse and refuse incompatible targets", { skip: !tools.powershell }, t => {
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-tools-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const module = readFileSync("tools/bblite-tools.psm1", "utf8");
    const helper = cppSection(module, "function Get-IosCompilerArguments", "function Get-BuildParallelArguments")
        .replaceAll("$IsMacOS", "$macHost");
    const sdkPath = join(directory, "SDK with spaces");
    mkdirSync(sdkPath);
    const script = join(directory, "probe.ps1");
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
foreach ($file in @('tools/ios.ps1', 'tools/bblite-tools.psm1', 'tools/build-dawn.ps1', 'tools/build-rmlui.ps1', 'tools/build-labsound.ps1', 'tools/android.ps1')) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path '${process.cwd().replaceAll("'", "''")}' $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}
function Get-PosixCompilerArguments { return @('-DCMAKE_CXX_COMPILER=chosen-clang') }
function xcrun { $global:LASTEXITCODE = 0; return '${sdkPath.replaceAll("'", "''")}' }
${helper}
$macHost = $true
$arguments = @(Get-IosCompilerArguments iphonesimulator x86_64)
foreach ($required in @('-DCMAKE_SYSTEM_NAME=iOS', '-DCMAKE_OSX_ARCHITECTURES=x86_64',
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=16.0', '-DCMAKE_CXX_COMPILER=chosen-clang',
    '-DCMAKE_OSX_SYSROOT=${sdkPath.replaceAll("'", "''")}', '-DCMAKE_SYSROOT=${sdkPath.replaceAll("'", "''")}')) {
    if ($required -notin $arguments) { throw "Missing argument $required" }
}
try { Get-IosCompilerArguments iphoneos x86_64; throw 'Expected device refusal' } catch {
    if ($_.Exception.Message -notmatch 'devices require arm64') { throw }
}
$macHost = $false
try { Get-IosCompilerArguments iphonesimulator arm64; throw 'Expected host refusal' } catch {
    if ($_.Exception.Message -notmatch 'require macOS') { throw }
}
`);
    const result = spawnSync(tools.powershell!, ["-NoProfile", "-File", script], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("mobile dependency reuse requires matching inputs, target identity and complete output", { skip: !tools.powershell }, t => {
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/mobile-dependency-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const script = join(directory, "cache.ps1");
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Import-Module '${resolve("tools/bblite-tools.psm1").replaceAll("'", "''")}' -Force
$inputFile = Join-Path $PSScriptRoot 'input.txt'
$output = Join-Path $PSScriptRoot 'install'
New-Item -ItemType Directory $output | Out-Null
Set-Content $inputFile 'first'
$count = [ref]0
$build = { $count.Value++; Set-Content (Join-Path $output 'library.a') 'built' }
Build-DependencyArtifact 'Fixture' $output @('simulator') @($inputFile) @('library.a') $build
Build-DependencyArtifact 'Fixture' $output @('simulator') @($inputFile) @('library.a') $build
if ($count.Value -ne 1) { throw 'Unchanged dependency was rebuilt' }
Set-Content $inputFile 'second'
Build-DependencyArtifact 'Fixture' $output @('simulator') @($inputFile) @('library.a') $build
Build-DependencyArtifact 'Fixture' $output @('device') @($inputFile) @('library.a') $build
Remove-Item (Join-Path $output 'library.a')
Build-DependencyArtifact 'Fixture' $output @('device') @($inputFile) @('library.a') $build
if ($count.Value -ne 4) { throw 'Changed or incomplete dependency was reused' }
try {
    Build-DependencyArtifact 'Fixture' $output @('device') @($inputFile) @('missing.a') {}
    throw 'Expected incomplete-build refusal'
} catch {
    if ($_.Exception.Message -notmatch 'did not produce missing.a') { throw }
}
`);
    const result = spawnSync(tools.powershell!, ["-NoProfile", "-File", script], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("iOS SDL entry accepts both generated main signatures and preserves a failing exit status", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native compiler and SDL are required."); return; }
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-entry-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const entry = join(directory, "entry.cpp"), executable = join(directory, "entry.exe");
    for (const body of ['int main() { return 7; }', 'int main(int argc, char**) { return argc + 6; }']) {
        writeFileSync(entry, body);
        runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
            `/DBBLITE_IOS_ENTRY="${entry.replaceAll("\\", "/")}"`, `/Fo:${directory}/`, `/Fe:${executable}`,
            `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
            "native/src/pal_ios_main.cpp", join(nativeFixtureVcpkgRoot, "lib/SDL3.lib")]);
        const result: SpawnSyncReturns<string> = spawnSync(executable, [], { encoding: "utf8", windowsHide: true,
            env: { ...native.environment, BBLITE_RUN_ID: "entry-contract",
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${native.environment.PATH ?? ""}` } });
        assert.equal(result.status, 7, result.stdout + result.stderr);
        assert.match(result.stderr, /Native exit: 7 run=entry-contract/);
    }
});

test("iOS window density preserves native pixels and authored DPR 1 without rounding other caps", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native compiler and SDL are required."); return; }
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-density-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = readFileSync("native/src/pal_window.hpp", "utf8");
    const fixture = join(directory, "density.cpp"), executable = join(directory, "density.exe");
    writeFileSync(fixture, `
#include <bblite/runtime.hpp>
#include <SDL3/SDL.h>
#include <cmath>
#include <stdexcept>
#define SDL_PLATFORM_IOS 1
static SDL_DisplayID primary_display() { return 1; }
static const SDL_DisplayMode* display_mode(SDL_DisplayID) {
    static const auto mode = [] { SDL_DisplayMode value{}; value.pixel_density = 2; return value; }();
    return &mode;
}
#define SDL_GetPrimaryDisplay primary_display
#define SDL_GetCurrentDisplayMode display_mode
namespace bbl::pal {
${cppFunction(source, "inline void configure_run_surface(")}
${cppFunction(source, "inline SDL_WindowFlags run_window_flags(")}
}
int main() {
    bbl::EngineOptions options;
    bbl::pal::configure_run_surface(options);
    if (!(bbl::pal::run_window_flags(0, options) & SDL_WINDOW_HIGH_PIXEL_DENSITY)) return 1;
    options.max_device_pixel_ratio = 1;
    bbl::pal::configure_run_surface(options);
    const auto low = bbl::pal::run_window_flags(SDL_WINDOW_HIGH_PIXEL_DENSITY, options);
    if ((low & SDL_WINDOW_HIGH_PIXEL_DENSITY) || !(low & SDL_WINDOW_FULLSCREEN)) return 2;
    for (const double value : {2.0, 3.0}) {
        options.max_device_pixel_ratio = value;
        bbl::pal::configure_run_surface(options);
        if (!(bbl::pal::run_window_flags(0, options) & SDL_WINDOW_HIGH_PIXEL_DENSITY)) return 3;
    }
    for (const double value : {0.0, 0.5, 1.5, std::numeric_limits<double>::quiet_NaN()}) {
        options.max_device_pixel_ratio = value;
        try { bbl::pal::configure_run_surface(options); return 4; }
        catch (const std::runtime_error&) {}
    }
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        `/Fo:${directory}/`, `/Fe:${executable}`, fixture]);
    assert.equal(execFileSync(executable, { encoding: "utf8", windowsHide: true }), "");
});

test("iOS source setup observes its actual canvas extent before rendering, while realm extents stay owned", t => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native compiler is required."); return; }
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/ios-initial-extent-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const create = cppFunction(readFileSync("native/src/pal.cpp", "utf8"), "Engine create_engine(");
    const metrics = cppFunction(readFileSync("native/src/pal_platform_events.hpp", "utf8"), "inline bool update_engine_canvas_metrics(");
    const source = join(directory, "initial.cpp");
    writeFileSync(source, `
#include <bblite/runtime.hpp>
#include <bblite/pal_construction.hpp>
#include <cassert>
#define SDL_PLATFORM_IOS 1
namespace bbl::pal {
using SDL_WindowFlags = unsigned;
constexpr unsigned SDL_INIT_VIDEO = 1, SDL_INIT_EVENTS = 2, SDL_WINDOW_RESIZABLE = 4, SDL_WINDOW_NOT_FOCUSABLE = 8;
struct SDL_Window {};
SDL_Window fixture_window;
int scope = 1, windows = 0, failure = 0, stamps = 0;
int* active_window_run = &scope;
unsigned requested_flags = 0;
int pixel_width = 1334, pixel_height = 750;
float density = 2;
void report_build_stamp() { ++stamps; }
std::string environment_variable(const char*) { return "1"; }
const char* SDL_GetError() { return "fixture failure"; }
bool initialize_run_sdl(unsigned) { return failure != 1; }
SDL_Window* acquire_run_window(const EngineOptions& options, unsigned value) {
    ++windows; requested_flags = value;
    density = options.max_device_pixel_ratio == 1 ? 1.0f : 2.0f;
    pixel_width = static_cast<int>(667 * density); pixel_height = static_cast<int>(375 * density);
    return failure == 2 ? nullptr : &fixture_window;
}
bool SDL_GetWindowSizeInPixels(SDL_Window*, int* width, int* height) {
    *width = pixel_width; *height = pixel_height; return failure != 3;
}
float SDL_GetWindowPixelDensity(SDL_Window*) { return failure == 4 ? 0.0f : density; }
float SDL_GetWindowDisplayScale(SDL_Window*) { return failure == 5 ? 0.0f : density; }
${metrics}
${create}
}
int main() {
    using namespace bbl::pal;
    bbl::EngineOptions options;
    extracting_constructor_inputs = true;
    {
        auto extracted = bbl::pal::create_engine(options);
        assert(extracted.options.width == 1280 && extracted.options.height == 720 && windows == 0);
    }
    extracting_constructor_inputs = false;
#if BBLITE_OFFSCREEN_SURFACES
    options.width = 321; options.height = 123;
    auto engine = bbl::pal::create_engine(options);
    assert(engine.options.width == 321 && engine.options.height == 123 && windows == 0);
#else
    {
        auto engine = bbl::pal::create_engine(options);
        assert(engine.options.width == 1334 && engine.options.height == 750);
        assert(engine.canvas_client_width == 667 && engine.canvas_client_height == 375);
        assert(engine.canvas_window_to_client_scale == 1);
        assert(engine.options.width / 2.0 - 224 == 443);
        assert((requested_flags & SDL_WINDOW_NOT_FOCUSABLE) != 0);
    }
    options.max_device_pixel_ratio = 1;
    {
        auto engine = bbl::pal::create_engine(options);
        assert(engine.options.width == 667 && engine.options.height == 375);
        assert(engine.canvas_client_width == 667 && engine.canvas_client_height == 375);
    }
    for (failure = 1; failure <= 5; ++failure) {
        bool threw = false;
        try { (void)bbl::pal::create_engine(options); } catch (const std::runtime_error&) { threw = true; }
        assert(threw);
    }
    failure = 0;
    active_window_run = nullptr;
    bool threw = false;
    try { (void)bbl::pal::create_engine(options); } catch (const std::runtime_error&) { threw = true; }
    assert(threw);
#endif
    assert(stamps > 0);
}
`);
    for (const offscreen of [0, 1]) {
        const executable = join(directory, `initial-${offscreen}.exe`);
        runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
            `/DBBLITE_OFFSCREEN_SURFACES=${offscreen}`, "/DBBLITE_PHYSICS_VIEWER=1", "/I", "native/include",
            `/Fo:${directory}/`, `/Fe:${executable}`, source]);
        assert.equal(execFileSync(executable, { encoding: "utf8", windowsHide: true }), "");
    }
});
