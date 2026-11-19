import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const standInSource = (
    width = "Math.max(1, Math.floor(canvas.width / 2))",
    height = "Math.max(1, Math.floor(canvas.height / 2))",
    create = "createRenderTarget",
) => `
import { createEngine, createRenderTarget, createSurfaceRenderTargetTexture } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const extent = {
    get width(): number { return ${width}; },
    get height(): number { return ${height}; },
};
const target = ${create}(${create === "createRenderTarget" ? "" : "engine,"}
    { format: "rgba16float", samples: 1, size: { canvas: extent } } as Parameters<typeof ${create}>[${create === "createRenderTarget" ? 0 : 1}]);
`;

test("render target stand-in getters retain arithmetic for each native build", () => {
    for (const factory of [
        "createRenderTarget",
        "createSurfaceRenderTargetTexture",
    ]) {
        const { cpp } = compileSource(
            standInSource(undefined, undefined, factory),
        );
        assert.match(
            cpp,
            /options\.scale_source = bbl::swapchain_render_target/,
        );
        assert.match(cpp, /options\.resolve_surface_size = \[\]/);
        assert.match(cpp, /std::floor\(\(width \/ 2\.0\)\)/);
        assert.match(cpp, /std::floor\(\(height \/ 2\.0\)\)/);
        assert.doesNotMatch(cpp, /options\.width_ratio = 0\.5/);
    }
    const { cpp } = compileSource(
        standInSource(
            "Math.max(1, Math.floor(canvas.width / 49))",
            "Math.max(1, Math.ceil(canvas.height * 0.25))",
        ),
    );
    assert.match(cpp, /std::floor\(\(width \/ 49\.0\)\)/);
    assert.match(cpp, /std::ceil\(\(height \* 0\.25\)\)/);
    const local = standInSource()
        .replace(
            `document.getElementById("renderCanvas") as HTMLCanvasElement`,
            `document.createElement("canvas")`,
        )
        .replace(
            "const extent = {",
            "function make(view: HTMLCanvasElement) { const extent = {",
        )
        .replaceAll("canvas.width /", "view.width /")
        .replaceAll("canvas.height /", "view.height /")
        .replace(
            "const target = createRenderTarget",
            "return createRenderTarget",
        );
    assert.match(
        compileSource(`${local}\n} const target = make(canvas);`).cpp,
        /options\.resolve_surface_size = \[\]/,
    );
});

test("render target stand-ins refuse non-surface or effectful extents", () => {
    assert.doesNotThrow(() => compileSource(standInSource("canvas.width")));
    for (const width of [
        "32",
        "Math.max(1, Math.floor(canvas.clientWidth / 2))",
        "Math.max(1, Math.floor(performance.now() / 2))",
        "Math.max(1, Math.floor(canvas.height / 2))",
        "(canvas.width++, canvas.width)",
    ]) {
        assert.throws(
            () => compileSource(standInSource(width)),
            /surface stand-in requires pure width\/height getters/,
        );
    }
    assert.throws(
        () =>
            compileSource(
                standInSource()
                    .replace(
                        "const extent = {",
                        "const other = { width: 80, height: 60 }; const extent = {",
                    )
                    .replaceAll("canvas.width /", "other.width /"),
            ),
        /surface stand-in requires pure width\/height getters/,
    );
    assert.throws(
        () =>
            compileSource(
                standInSource().replace(
                    "return Math.max(1, Math.floor(canvas.width / 2));",
                    "console.log('read'); return Math.max(1, Math.floor(canvas.width / 2));",
                ),
            ),
        /surface stand-in requires pure width\/height getters/,
    );
    assert.throws(
        () =>
            compileSource(
                standInSource().replace("const canvas =", "let canvas =") +
                    `canvas = document.createElement("canvas");`,
            ),
        /surface stand-in requires pure width\/height getters/,
    );
    assert.throws(
        () =>
            compileSource(
                standInSource()
                    .replace(
                        "const extent = {",
                        `const other = document.createElement("canvas"); const extent = {`,
                    )
                    .replaceAll("canvas.width /", "other.width /"),
            ),
        /surface stand-in requires pure width\/height getters/,
    );
});

test("stand-in native target plans re-read extents at rebuild just as the pin does", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    interface Target {
        _width: number;
        _height: number;
    }
    const pinned = await importPinnedModule<{
        createRenderTarget(descriptor: {
            size: {
                canvas: { readonly width: number; readonly height: number };
            };
            samples: number;
        }): Target;
        buildRenderTarget(target: Target, engine: { _device: object }): void;
    }>("engine/render-target.js");
    const canvas = { width: 301, height: 201 };
    const target = pinned.createRenderTarget({
        samples: 1,
        size: {
            canvas: {
                get width() {
                    return Math.max(1, Math.floor((canvas.width || 98) / 49));
                },
                get height() {
                    return Math.max(1, Math.ceil(canvas.height * 0.25));
                },
            },
        },
    });
    assert.deepEqual([target._width, target._height], [0, 0]);
    const checks: string[] = [];
    for (const [width, height] of [
        [301, 201],
        [98, 99],
        [49, 1],
        [0, 0],
        [1921, 1081],
        [1921, 1081],
    ]) {
        const old = [target._width, target._height];
        canvas.width = width!;
        canvas.height = height!;
        assert.deepEqual([target._width, target._height], old);
        pinned.buildRenderTarget(target, { _device: {} });
        checks.push(`{
            const auto plans = bbl::pal::plan_render_targets(engine, ${width}, ${height}, 0,
                [](bbl::TextureFormatClass) { return 1; });
            assert(plans[1].width == ${target._width}u && plans[1].height == ${target._height}u);
        }`);
    }
    // At this integer, replacing division with its reciprocal loses a pixel.
    assert.notEqual(Math.floor(49 / 49), Math.floor(49 * (1 / 49)));
    const { cpp } = compileSource(
        standInSource(
            "Math.max(1, Math.floor((canvas.width || 98) / 49))",
            "Math.max(1, Math.ceil(canvas.height * 0.25))",
        ),
    );
    const lowered = new RenderTargetLowerer(new LoweringContext()).lower()
        .source;
    const shared = readFileSync("native/src/pal_gpu_shared.cpp", "utf8");
    const plans = readFileSync("native/src/pal_gpu_targets.hpp", "utf8");
    runGeneratedProgram(
        tools,
        "stand-in-target-resize",
        `
#define main generated_main
${cpp}
#undef main
#include <cassert>
namespace { std::vector<bbl::RenderTargetRecord> targets; }
namespace bbl {
${cppFunction(lowered, "std::uint32_t render_target_dimension(")}
// Exercise the real option-to-record transfer, retaining records after setup.
#define create_render_target make_target
${cppFunction(lowered, "RenderTargetHandle create_render_target(")}
#undef create_render_target
Engine create_engine(EngineOptions) {
    Engine engine; engine.render_targets.emplace_back(); engine.render_targets[0].swapchain = true; return engine;
}
RenderTargetHandle swapchain_render_target(Engine&) { return {0}; }
RenderTargetHandle create_render_target(Engine& engine, RenderTargetOptions options) {
    const auto result = make_target(engine, options);
    targets = engine.render_targets;
    return result;
}
}
namespace bbl::pal {
std::pair<unsigned, unsigned> surface_target_extent(const Engine&, const RenderTargetRecord& target, unsigned width, unsigned height) {
    return {target.width ? target.width : width, target.height ? target.height : height};
}
${cppFunction(plans, "inline std::uint32_t scaled_target_extent(")}
${cppFunction(plans, "struct ScaledExtents {")};
${cppFunction(shared, "ScaledExtents scaled_target_extents(")}
template<class Format> ${cppFunction(plans, "struct RenderTargetPlan {")};
template<class Format, class Convert> ${cppFunction(plans, "std::vector<RenderTargetPlan<Format>> plan_render_targets(")}
}
int main() {
    assert(generated_main() == 0);
    bbl::Engine engine; engine.render_targets = targets;
    assert(engine.render_targets.size() == 2);
    assert(engine.render_targets[1].width == 0 && engine.render_targets[1].height == 0);
    ${checks.join("\n")}
}
`,
        { expectedOutput: "" },
    );
});

test("the swapchain target's _width and _height read through a cast are its current extent", () => {
    const { cpp } = compileSource(`
import { createEngine, createSceneContext, createFreeCamera, registerScene, onBeforeRender, getEffectiveAspectRatio, startEngine, type RenderTarget } from "@babylonjs/lite";
interface EngineTarget { scRT: RenderTarget }
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
const camera = createFreeCamera([0, 0, -5], [0, 0, 0]);
scene.camera = camera;
await registerScene(scene);
const eng = engine as unknown as EngineTarget;
const initial = (eng.scRT as unknown as { _width: number })._width;
onBeforeRender(scene, () => {
    const target = eng.scRT as unknown as { _width: number; _height: number };
    camera.fov = getEffectiveAspectRatio(camera, target._width, target._height);
    camera.speed = initial;
});
await startEngine(engine);
`);
    // Each frame reads the target's extent where the pin reads it.
    assert.match(
        cpp,
        /const double (v_\w+) = bbl::swapchain_render_target_extent\(v_engine, (v_\w+), false\);\s*(?:\[\[maybe_unused\]\] )?const double (v_\w+) = bbl::swapchain_render_target_extent\(v_engine, \2, true\);\s*[^\n]*effective_aspect_ratio\([^\n]*\1, \3\)/,
    );
    // A read a binding holds is the extent when it ran, not a later one.
    assert.match(
        cpp,
        /double v_initial = bbl::swapchain_render_target_extent\(v_engine, [^;]*, false\);/,
    );
    assert.match(cpp, /\.speed = v_initial;/);
});

test("the swapchain extent is the canvas backing store, and another target's refuses", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "render-target-extent-check",
        `#include <bblite/runtime.hpp>
#include <cassert>
int main() {
    bbl::Engine engine;
    bbl::RenderTargetRecord swapchain;
    swapchain.swapchain = true;
    engine.render_targets.push_back(swapchain);
    bbl::RenderTargetRecord fixed;
    fixed.width = 8;
    fixed.height = 8;
    engine.render_targets.push_back(fixed);
    const bbl::RenderTargetHandle target{0};
    engine.options.width = 640;
    engine.options.height = 360;
    assert(bbl::swapchain_render_target_extent(engine, target, false) == 640.0);
    assert(bbl::swapchain_render_target_extent(engine, target, true) == 360.0);
    // setSurfaceSize and a frame's resize keep the backing store current.
    engine.options.width = 1024;
    engine.options.height = 768;
    assert(bbl::swapchain_render_target_extent(engine, target, false) == 1024.0);
    assert(bbl::swapchain_render_target_extent(engine, target, true) == 768.0);
    bool refused = false;
    try {
        static_cast<void>(bbl::swapchain_render_target_extent(engine, bbl::RenderTargetHandle{1}, false));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    assert(refused);
}
`,
        { expectedOutput: "" },
    );
});
