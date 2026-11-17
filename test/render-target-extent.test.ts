import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

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
        /const double (v_\w+) = bbl::swapchain_render_target_extent\(v_engine, (v_\w+), false\);\s*const double (v_\w+) = bbl::swapchain_render_target_extent\(v_engine, \2, true\);\s*[^\n]*effective_aspect_ratio\([^\n]*\1, \3\)/,
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
