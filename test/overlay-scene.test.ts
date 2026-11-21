import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerOverlayScenes } from "../src/lowering/overlay-scene-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const preamble = `
    import {
        createEngine, createOverlayScene, createSceneContext, createSurface,
        createUtilityLayer, enableSceneTransmission, moveRenderingContext,
        registerScene, registerSceneWithShadowSupport, registerUtilityLayer,
        setRenderTaskGpuTimingEnabled,
    } from "@babylonjs/lite";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const base = createSceneContext(engine);
    const { rt, rst } = base.defaultRenderTask!.config;
    const targets = { rt, rst };
`;

test("createOverlayScene builds a scene over its base", () => {
    const result = compileSource(`${preamble}
        const overlay = createOverlayScene(base, targets);
        await registerScene(overlay);
        await registerScene(base);
    `);
    assert.match(
        result.cpp,
        /bbl::create_overlay_scene\(v_base, bbl::OverlayTargets\{/,
    );
    assert.ok(result.manifest.features.includes("scene:overlay"));
    assert.throws(
        () => compileSource(`${preamble}createOverlayScene(base);`),
        /Expected 2 arguments/,
    );
});

test("an overlay of an auxiliary surface's scene refuses", () => {
    assert.throws(
        () =>
            compileSource(`${preamble}
                const other = document.getElementById("canvasB") as HTMLCanvasElement;
                const surface = createSurface(engine, other);
                const aux = createSceneContext(surface);
                createOverlayScene(aux, targets);
            `),
        /An overlay of a scene on an auxiliary surface is not supported/,
    );
});

test("createUtilityLayer borrows explicit targets and refuses unlowered light options", () => {
    const result = compileSource(`${preamble}
        const layer = createUtilityLayer(base, targets);
        await registerScene(base);
        await registerUtilityLayer(layer);
    `);
    assert.match(
        result.cpp,
        /bbl::create_utility_layer\(v_base, bbl::OverlayTargets\{/,
    );
    assert.ok(result.manifest.features.includes("scene:overlay"));
    assert.throws(
        () =>
            compileSource(`${preamble}
                createUtilityLayer(base, { lightIntensity: 1 });
            `),
        /Overlay options support only rt and rst/,
    );
});

test("moveRenderingContext and an engine-first utility layer refuse", () => {
    assert.throws(
        () =>
            compileSource(`${preamble}
                createUtilityLayer(engine, base);
            `),
        /Expected scene, received engine\./,
    );
    assert.throws(
        () =>
            compileSource(`${preamble}
                moveRenderingContext(engine, base, 0);
            `),
        /'moveRenderingContext' is not supported/,
    );
});

test("an overlay with tasks of its own or under GPU task timing compiles its own scene task", () => {
    for (const source of [
        `const overlay = createOverlayScene(base, targets);
        await registerSceneWithShadowSupport(overlay);`,
        `const overlay = createOverlayScene(base, targets);
        await registerScene(base);
        await registerScene(overlay);
        await setRenderTaskGpuTimingEnabled(engine, true);`,
    ]) {
        const result = compileSource(`${preamble}${source}`);
        assert.match(result.cpp, /bbl_ensure_default_render_task\(/);
        assert.ok(result.manifest.features.includes("scene:overlay"));
    }
});

test("registration runs the overlay hook only where an overlay is built", () => {
    const register = (overlayScenes: boolean): string =>
        cppFunction(
            new SceneLowerer(new LoweringContext()).lowerCore({
                overlayScenes,
            }).source,
            "void register_scene(",
        );
    assert.match(
        register(true),
        /move_swapchain_overlays_after_base\(scene\);/,
    );
    assert.doesNotMatch(register(false), /move_swapchain_overlays_after_base/);
});

const tools = optionalNativeFixtureTools(false);
test(
    "overlays keep their base's order, suspend without it, and a later scene clears its surface",
    { skip: !tools },
    () => {
        const context = new LoweringContext();
        const scene = new SceneLowerer(context).lowerCore({
            overlayScenes: true,
        }).source;
        const registration = [
            "void require_scene_engine(",
            "std::uint32_t material_family_bit(",
            "std::uint32_t scene_material_families(",
            "void drain_scene_deferred_builders(",
            "Scene create_scene_context(Engine& engine)",
            "void register_scene(",
            "void unregister_scene(",
        ]
            .map((signature) => cppFunction(scene, signature))
            .join("\n");
        runGeneratedProgram(
            tools!,
            "overlay-scene-order",
            `#include <bblite/runtime.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <initializer_list>
namespace bbl {
${registration}
RenderTargetHandle create_render_target(Engine& engine, RenderTargetOptions options) {
    assert(options.has_depth && !options.has_color && options.scale_source.value == 3 && options.samples == 4);
    engine.render_targets.emplace_back();
    return {static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}
void dispose_render_target(Engine& engine, RenderTargetHandle handle) { handle_at(engine.render_targets, handle).retired = true; }
TaskHandle create_render_task(Engine& engine, Scene& scene, RenderTaskOptions options) {
    FrameTaskRecord task;
    task.render = options;
    task.source_scene = scene.state;
    return append_frame_task(engine, std::move(task));
}
void add_task(Scene& scene, TaskHandle handle) { scene.tasks.push_back(handle); }
${lowerOverlayScenes(context)}
} // namespace bbl
using bbl::Scene;
bool same(const std::vector<std::shared_ptr<Scene>>& scenes, std::initializer_list<const Scene*> expected) {
    if (scenes.size() != expected.size()) return false;
    auto at = scenes.begin();
    for (const Scene* scene : expected)
        if (!(*at++)->shares_identity(*scene)) return false;
    return true;
}
std::vector<std::shared_ptr<Scene>> registered(const bbl::Engine& engine) { return engine.scenes(); }
int main() {
    bbl::Engine engine;
    Scene a = bbl::create_scene_context(engine);
    const bbl::OverlayTargets targets{{3}, {1}};
    engine.render_targets.resize(4);
    engine.render_targets[3].samples = 4;
    Scene b = bbl::create_overlay_scene(a, targets);
    Scene c = bbl::create_overlay_scene(b, targets);
    Scene d = bbl::create_overlay_scene(a, targets);
    assert(b.clear_color.a == 0.0f && b.state->overlay_base == a.state);
    const auto& pass = bbl::handle_at(engine.frame_tasks, b.state->default_render_task_handle).render;
    assert(pass.target == targets.rt && pass.resolve_target == targets.rst && pass.shared_target && !pass.clear);
    assert(pass.depth.target.value == 4);
    const auto published = bbl::render_task_targets(engine, b.state->default_render_task_handle);
    assert(published.rt == targets.rt && published.rst == targets.rst);
    bbl::Engine other;
    bool cross_engine = false;
    try { (void)bbl::overlay_target_for_engine(engine, other, targets.rt); }
    catch (const std::runtime_error&) { cross_engine = true; }
    assert(cross_engine);
    const auto retained = bbl::overlay_color_targets({std::make_shared<Scene>(a), std::make_shared<Scene>(b), std::make_shared<Scene>(c)});
    assert(retained.size() == 1 && retained.contains(targets.rt.value) && !retained.contains(targets.rst.value));
    for (const auto& dispose : b.disposables) dispose();
    assert(engine.render_targets[4].retired && !engine.render_targets[3].retired && !engine.render_targets[1].retired);
    // Overlays registered before their base wait, suspended.
    bool wrong_targets = false;
    try { static_cast<void>(bbl::create_overlay_scene(a, {{1}, {3}})); }
    catch (const std::runtime_error&) { wrong_targets = true; }
    assert(wrong_targets);
    bbl::register_scene(c);
    bbl::register_scene(d);
    bbl::register_scene(b);
    assert(bbl::overlay_scene_suspended(engine, b) && bbl::overlay_scene_suspended(engine, c));
    assert(bbl::composited_scenes(engine).empty());
    // The base gathers its tree: siblings in registration order, nested depth-first.
    bbl::register_scene(a);
    assert(same(registered(engine), {&a, &d, &b, &c}));
    assert(same(bbl::composited_scenes(engine), {&a, &d, &b, &c}));
    // A later ordinary scene clears the surface; another surface keeps its own.
    Scene e = bbl::create_scene_context(engine);
    Scene aux = bbl::create_scene_context(engine);
    aux.surface_canvas = bbl::UiElementHandle{7};
    // A base on another surface refuses.
    bool refused = false;
    try {
        static_cast<void>(bbl::create_overlay_scene(aux, targets));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    assert(refused);
    bbl::register_scene(e);
    bbl::register_scene(aux);
    assert(same(bbl::composited_scenes(engine), {&e, &aux}));
    bbl::unregister_scene(e);
    // An unregistered link suspends the overlays under it, and its return restores the order.
    bbl::unregister_scene(b);
    assert(bbl::overlay_scene_suspended(engine, c) && !bbl::overlay_scene_suspended(engine, d));
    assert(same(bbl::composited_scenes(engine), {&a, &d, &aux}));
    bbl::register_scene(b);
    assert(same(registered(engine), {&a, &d, &b, &c, &aux}));
    assert(same(bbl::composited_scenes(engine), {&a, &d, &b, &c, &aux}));
}
`,
        );
    },
);

test("an overlay over a root writing the swapchain itself or through transmission compiles", () => {
    for (const shape of [
        "const target = engine.scRT;",
        "enableSceneTransmission(base, engine);",
    ]) {
        const result = compileSource(`${preamble}
            ${shape}
            const overlay = createOverlayScene(base, targets);
            await registerScene(base);
            await registerScene(overlay);
        `);
        assert.ok(result.manifest.features.includes("scene:overlay"));
    }
});
