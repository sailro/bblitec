import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const families = {
    SPRITES: "sprite_layers",
    SPRITE_ANIMATION: "sprite_animation_managers",
    ANIMATION: "animation_managers",
    GIZMOS: "utility_layers",
    SHADOWS: "shadow_generators",
    PICKING: "gpu_pickers",
} as const;

test("runtime families omit unreached storage and preserve layout across translation units", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("A native compiler is required."); return; }
    const output = resolve("artifacts/runtime-families-check");
    mkdirSync(output, { recursive: true });
    const other = join(output, "other.cpp");
    writeFileSync(other, `#include <bblite/pal.hpp>
        #include <bblite/runtime.hpp>
        #include <bblite/js_data.hpp>
        std::array<std::size_t, 2> update(bbl::Engine& engine, bbl::Scene& scene) {
            engine.device_generation = 17;
            scene.fixed_delta_ms = 12.5;
            return {sizeof(engine), sizeof(scene)};
        }
    `);
    const main = join(output, "main.cpp");
    writeFileSync(main, `#include <bblite/js_data.hpp>
        #include <bblite/runtime.hpp>
        #include <cassert>
        #include <iostream>
        ${Object.entries(families).map(([family, field]) => `
            template<class T> concept Has${family} = requires(T& value) { value.${field}; };
            static_assert(Has${family}<bbl::Engine> == bool(BBLITE_HAS_${family}));
        `).join("\n")}
        std::array<std::size_t, 2> update(bbl::Engine&, bbl::Scene&);
        int main() {
            bbl::Engine engine;
            bbl::Scene scene;
            scene.engine = &engine;
            auto alias = scene;
            const auto sizes = update(engine, alias);
            assert(sizes[0] == sizeof(engine) && sizes[1] == sizeof(scene));
            assert(engine.device_generation == 17 && scene.fixed_delta_ms == 12.5);
            assert(alias.engine == &engine && alias.shares_identity(scene));
            assert(!bbl::has_sprite_renderers(engine));
            std::cout << sizeof(engine);
        }
    `);
    const sizes = new Map<string, number>();
    for (const enabled of ["none", "all", ...Object.keys(families)]) {
        const executable = join(output, `${enabled}.exe`);
        const defines = Object.keys(families).map(family =>
            `/DBBLITE_HAS_${family}=${enabled === "all" || enabled === family ? 1 : 0}`);
        runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-",
            "/I", "native/include", ...defines, `/Fo:${output}\\`, `/Fe:${executable}`, main, other]);
        sizes.set(enabled, Number(execFileSync(executable, { encoding: "utf8" })));
    }
    for (const family of Object.keys(families)) assert.ok(sizes.get(family)! > sizes.get("none")!, family);
    assert.ok(sizes.get("all")! > Math.max(...Object.keys(families).map(family => sizes.get(family)!)));
});
