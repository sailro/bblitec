import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("SDL deferred draws observe final source UBO bytes while ordinary blocks retain prepared values", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler and SDL headers unavailable."); return; }
    const directory = resolve("artifacts/sdl-temporal-uniforms-check");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include "pal_sdl_gpu_temporal.hpp"
#include <cassert>
struct Block { const void* data; std::size_t bytes; };
int main() {
    auto owner = std::make_shared<bbl::PersistentSceneUniforms>();
    owner->clean.assign(92, 51.0f); owner->drawn = owner->clean;
    std::array<float, 4> ordinary{1, 2, 3, 4};
    int resolved = 0;
    const auto resolve = [&](const std::string& name, std::size_t) -> Block {
        ++resolved;
        return name == "scene" ? Block{owner->clean.data(), 92 * sizeof(float)} : Block{ordinary.data(), sizeof(ordinary)};
    };
    auto first = bbl::pal::prepare_sdl_uniforms({"scene", "mesh"}, resolve, owner);
    owner->drawn[0] = 102; ordinary[0] = 9;
    auto second = bbl::pal::prepare_sdl_uniforms({"scene", "mesh"}, resolve, owner);
    // All encoded occurrences in one submit observe the final queue write.
    owner->drawn[0] = 204; ordinary[0] = 17;
    assert(resolved == 4 && owner->clean[0] == 51);
    assert(static_cast<const float*>(first[0].data())[0] == 204);
    assert(static_cast<const float*>(second[0].data())[0] == 204);
    float copied = 0;
    std::memcpy(&copied, first[1].data(), sizeof(copied)); assert(copied == 1);
    std::memcpy(&copied, second[1].data(), sizeof(copied)); assert(copied == 9);
    // Prepared packets retain the task's buffer after temporary wrappers die.
    std::weak_ptr<bbl::PersistentSceneUniforms> retained = owner;
    owner.reset();
    assert(!retained.expired() && first[0].size() == 92 * sizeof(float));
    assert(static_cast<const float*>(first[0].data())[0] == 204);
    bool failed = false;
    try {
        (void)bbl::pal::prepare_sdl_uniforms({"scene"}, [](const std::string&, std::size_t) {
            return Block{nullptr, 0};
        }, first[0].source);
    } catch (const std::runtime_error&) { failed = true; }
    assert(failed);
    failed = false;
    try {
        (void)bbl::pal::prepare_sdl_uniforms({"scene"}, [&](const std::string&, std::size_t) {
            return Block{ordinary.data(), sizeof(ordinary)};
        }, first[0].source);
    } catch (const std::runtime_error&) { failed = true; }
    assert(failed);
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/I${resolve("native/include")}`, `/I${resolve("native/src")}`, `/I${join(nativeFixtureVcpkgRoot, "include")}`,
        `/Fo:${directory}\\`, `/Fe:${executable}`, source]);
    execFileSync(executable);
});
