import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
    sharedGpuSource,
} from "./native-fixture.js";

const shared = (): string => sharedGpuSource();

test("a geometry task's Standard renderables keep the pin's previous world and start velocity disabled", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native fixture compiler is required.");
        return;
    }
    const output = resolve("artifacts/pinned-velocity-history");
    mkdirSync(output, { recursive: true });
    const includes = join(output, "bblite/upstream");
    mkdirSync(includes, { recursive: true });
    // The generated interface varies by geometry output; the PAL header is
    // compiled intact against both shapes and the real runtime records.
    writeFileSync(
        join(includes, "render_capabilities.hpp"),
        `#pragma once
#define BBLITE_PINNED_MATERIALS 1
#define BBLITE_PINNED_MATERIAL_VARIANTS 1
#define BBLITE_PBR_VARIANTS 0
#define BBLITE_STANDARD_VARIANTS 1
#define BBLITE_NODE_VARIANTS 0
#define BBLITE_FLOATING_ORIGIN 0
`,
    );
    writeFileSync(
        join(includes, "standard_variants.hpp"),
        `#pragma once
#include <array>
namespace bbl::upstream {
struct MeshUniforms {
    std::array<float, 16> world{};
#if FIXTURE_VELOCITY
    std::array<float, 16> previousWorld{};
    float velocityEnabled = -1.0f;
#endif
};
}
`,
    );
    writeFileSync(
        join(includes, "renderer_plan.hpp"),
        `#pragma once
#include <bblite/runtime.hpp>
namespace bbl::upstream {
enum class RenderMaterialKind { standard, pbr };
struct RenderItem {
    MeshHandle mesh;
    int material = 0;
    RenderMaterialKind material_kind = RenderMaterialKind::standard;
};
inline RenderItem bind_render_item(RenderItem item, const Engine&, int) { return item; }
}
`,
    );
    const executable = join(output, "check.exe");
    for (const velocity of [0, 1]) {
        runNativeFixtureCompiler(tools, [
            "/O2",
            `/DFIXTURE_VELOCITY=${velocity}`,
            "/DBBLITE_HAS_PBR_RENDERER=1",
            "/Inative/src",
            `/Fo:${output}/`,
            `/Fe:${executable}`,
            "/I",
            output,
            "test/fixtures/pinned-velocity-history-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /pinned-velocity-history-check: ok/,
        );
    }
});

test("only the geometry task's Standard draws write the velocity tail", () => {
    const source = shared();
    // The colour passes' block carries the world and the light selection
    // alone; the tail is the task's renderable state.
    const block = cppFunction(
        source,
        "upstream::MeshUniforms pinned_mesh_block(",
    );
    assert.doesNotMatch(block, /previousWorld|velocityEnabled/);
    const sdl = sceneBackendSource("sdl");
    const dawn = sceneBackendSource("dawn");
    for (const [backend, text] of [
        ["SDL", sdl],
        ["Dawn", dawn],
    ] as const) {
        assert.equal(
            text.match(/update_pinned_velocity_frame\(/g)?.length,
            1,
            `${backend} updates each geometry task's renderables once a frame`,
        );
        assert.match(
            text,
            /pinned_mesh_block\(scene, engine, (?:draw\.item|item)\.mesh, velocity_history\)/,
            `${backend} uses the task's composed world and velocity tail`,
        );
    }
    assert.match(
        sdl,
        /geometry\.params, &geometry\.velocity\);/,
        "the SDL geometry task hands its history to its draws",
    );
    assert.match(
        dawn,
        /colour_state, &geometry\.velocity\);/,
        "the Dawn geometry task hands its history to its draws",
    );
});
