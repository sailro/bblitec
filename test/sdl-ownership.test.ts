import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("SDL Window shutdown never drops an image lease after a failed idle wait", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable");
    const out = resolve("artifacts/sdl-presenter-shutdown");
    mkdirSync(out, { recursive: true });
    const source = join(out, "wait.cpp"),
        exe = join(out, "wait.exe");
    const destructor = cppFunction(
        readFileSync("native/src/pal_sdl_gpu_window_presenter.cpp", "utf8"),
        "~SdlWindowPresenter()",
    );
    writeFileSync(
        source,
        `#include <bblite/teardown.hpp>
#include <cstdlib>
#include <cstdio>
#include <string_view>
namespace bbl::pal {
bool idle = false;
bool SDL_WaitForGPUIdle(int) { return idle; }
const char* SDL_GetError(){return "fixture wait failure";}
void release_sprite_ui_sdl_gpu_resources(int,int){}
void SDL_ReleaseWindowFromGPUDevice(int,int){}
struct SdlWindowPresenter {
    struct Device { int get() { return 1; } } device_;
    struct Leases { void clear() { std::puts("released"); } } in_flight_;
    struct Composite { void release(int) {} } composite_;
    int ui_ = 0, window_ = 0;
    ${destructor.replace(" override", "")}
};
}
int main(int argc, char**) {
    std::set_terminate([]{std::_Exit(19);});
    bbl::pal::idle = argc == 1;
    bbl::pal::SdlWindowPresenter presenter;
}`,
    );
    runNativeFixtureCompiler(tools, [source, `/Fo:${out}/`, `/Fe:${exe}`]);
    assert.match(execFileSync(exe, { encoding: "utf8" }), /released/);
    const failed = spawnSync(exe, ["fail"], {
        encoding: "utf8",
        timeout: 5000,
    });
    assert.equal(failed.status, 19, failed.stderr);
    assert.match(
        failed.stderr,
        /Window SDL_WaitForGPUIdle: fixture wait failure/,
    );
    assert.doesNotMatch(failed.stdout, /released/);
});

test("SDL material and geometry owners unwind partial uploads and cache publication", (t) => {
    const tools = optionalNativeFixtureTools(false);
    const sdlInclude = join(nativeFixtureVcpkgRoot, "include");
    if (!tools || !existsSync(join(sdlInclude, "SDL3/SDL_gpu.h"))) {
        t.skip(
            "A native fixture compiler and the pinned SDL headers are required.",
        );
        return;
    }
    const output = resolve("artifacts/test-sdl-ownership");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/I${resolve("native/src")}`,
        resolve("test/fixtures/sdl-ownership-check.cpp"),
        `/Fe:${executable}`,
        `/Fo:${join(output, "check.obj")}`,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
