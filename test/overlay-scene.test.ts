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
`;

test("createOverlayScene builds a scene over its base", () => {
    const result = compileSource(`${preamble}
        const overlay = createOverlayScene(base);
        await registerScene(overlay);
        await registerScene(base);
    `);
    assert.match(result.cpp, /bbl::create_overlay_scene\(v_base\)/);
    assert.ok(result.manifest.features.includes("scene:overlay"));
});

test("an overlay of an auxiliary surface's scene refuses", () => {
    assert.throws(
        () =>
            compileSource(`${preamble}
                const other = document.getElementById("canvasB") as HTMLCanvasElement;
                const surface = createSurface(engine, other);
                const aux = createSceneContext(surface);
                createOverlayScene(aux);
            `),
        /An overlay of a scene on an auxiliary surface is not supported/,
    );
});

test("createUtilityLayer takes its main scene and refuses options", () => {
    const result = compileSource(`${preamble}
        const layer = createUtilityLayer(base);
        await registerScene(base);
        await registerUtilityLayer(layer);
    `);
    assert.match(result.cpp, /bbl::create_utility_layer\(v_base\)/);
    assert.ok(result.manifest.features.includes("scene:overlay"));
    assert.throws(
        () =>
            compileSource(`${preamble}
                createUtilityLayer(base, { lightIntensity: 1 });
            `),
        /createUtilityLayer options are not supported/,
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
        `const overlay = createOverlayScene(base);
        await registerSceneWithShadowSupport(overlay);`,
        `const overlay = createOverlayScene(base);
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
    Scene b = bbl::create_overlay_scene(a);
    Scene c = bbl::create_overlay_scene(b);
    Scene d = bbl::create_overlay_scene(a);
    assert(b.clear_color.a == 0.0f && b.state->overlay_base == a.state);
    // Overlays registered before their base wait, suspended.
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
        static_cast<void>(bbl::create_overlay_scene(aux));
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
            const overlay = createOverlayScene(base);
            await registerScene(base);
            await registerScene(overlay);
        `);
        assert.ok(result.manifest.features.includes("scene:overlay"));
    }
});

test(
    "an overlay composites into its root's swapchain task at MSAA and loads the swapchain at one sample",
    { skip: !tools },
    () => {
        runGeneratedProgram(
            tools!,
            "overlay-scene-composite",
            `#include <bblite/runtime.hpp>
#include <cassert>
using bbl::OverlayComposite;
using bbl::TaskHandle;
int main() {
    // A root without a frame graph: the renderer's own scene pass, which
    // always runs and resolves into the swapchain.
    bbl::Engine engine;
    bbl::Scene root;
    root.engine = &engine;
    assert(bbl::overlay_composition(engine, root, true).mode == OverlayComposite::root_attachment);
    assert(bbl::overlay_composition(engine, root, false).mode == OverlayComposite::swapchain);
    // Transmission retargets the scene pass to a linear target that resolves
    // nowhere: skipped at MSAA; at one sample the overlay loads the
    // swapchain the image processing wrote.
    root.transmission_enabled = true;
    assert(bbl::overlay_composition(engine, root, true).mode == OverlayComposite::skipped);
    assert(bbl::overlay_composition(engine, root, false).mode == OverlayComposite::swapchain);
    root.transmission_enabled = false;
    // Without its default render task and with no task of its own, it draws nothing.
    root.state->default_render_task = false;
    assert(bbl::overlay_composition(engine, root, true).mode == OverlayComposite::skipped);
    assert(bbl::overlay_composition(engine, root, false).mode == OverlayComposite::swapchain);
    root.state->default_render_task = true;
    // The compiler's scene pass (0) with its resolve (1) and present (2)
    // copies after it, and a later task (3) writing the swapchain.
    for (int task = 0; task < 4; ++task) engine.frame_tasks.emplace_back();
    engine.frame_tasks[0].render.scene_stages = true;
    engine.frame_tasks[1].kind = bbl::FrameTaskKind::copy;
    engine.frame_tasks[2].kind = bbl::FrameTaskKind::copy;
    engine.frame_tasks[3].kind = bbl::FrameTaskKind::post_process;
    root.tasks.push_back(TaskHandle{0});
    root.tasks.push_back(TaskHandle{3});
    bbl::add_pass_after(*root.state, TaskHandle{1}, TaskHandle{0});
    bbl::add_pass_after(*root.state, TaskHandle{2}, TaskHandle{0});
    // MSAA: composited into, after the root's whole graph, and resolved again.
    const auto msaa = bbl::overlay_composition(engine, root, true);
    assert(msaa.mode == OverlayComposite::root_attachment && msaa.task.value == 0);
    assert(bbl::overlay_composition(engine, root, false).mode == OverlayComposite::swapchain);
    // A record the scene pass does not render skips the layers at MSAA.
    engine.frame_tasks[0].render_enabled = false;
    assert(bbl::overlay_composition(engine, root, true).mode == OverlayComposite::skipped);
    assert(bbl::overlay_composition(engine, root, false).mode == OverlayComposite::swapchain);
    engine.frame_tasks[0].render_enabled = true;
    engine.frame_tasks[0].execution_enabled = false;
    assert(bbl::overlay_composition(engine, root, true).mode == OverlayComposite::skipped);
    // A first swapchain task drawing into the swapchain itself resolves
    // nothing into it; one resolving into it is composited into.
    bbl::Engine other;
    bbl::Scene post;
    post.engine = &other;
    other.render_targets.emplace_back();
    other.render_targets[0].swapchain = true;
    other.render_targets.emplace_back();
    other.frame_tasks.emplace_back();
    other.frame_tasks.emplace_back();
    other.frame_tasks[0].render.target = bbl::RenderTargetHandle{0};
    other.frame_tasks[1].kind = bbl::FrameTaskKind::post_process;
    post.tasks.push_back(TaskHandle{0});
    post.tasks.push_back(TaskHandle{1});
    assert(bbl::overlay_composition(other, post, true).mode == OverlayComposite::skipped);
    other.frame_tasks[0].render.target = bbl::RenderTargetHandle{1};
    other.frame_tasks[0].render.resolve_target = bbl::RenderTargetHandle{0};
    const auto resolving = bbl::overlay_composition(other, post, true);
    assert(resolving.mode == OverlayComposite::root_attachment && resolving.task.value == 0);
    // A root whose render tasks never reach the swapchain -- a post-process
    // writes it -- has no swapchain task: skipped at MSAA, loaded at one sample.
    other.frame_tasks[0].render.resolve_target = bbl::RenderTargetHandle{};
    assert(bbl::overlay_composition(other, post, true).mode == OverlayComposite::skipped);
    assert(bbl::overlay_composition(other, post, false).mode == OverlayComposite::swapchain);
    // The layer clears the surface's depth while it fits the root task's
    // target, else the target's own cleared depth; anything else refuses.
    bbl::FrameTaskRecord task;
    task.render.depth_clear = true;
    const bbl::OverlayAttachmentExtent surface{1280, 720, 4};
    assert(!bbl::overlay_lends_target_depth(task, surface, surface, false));
    assert(bbl::overlay_lends_target_depth(task, {640, 360, 4}, surface, true));
    assert(bbl::overlay_lends_target_depth(task, {1280, 720, 1}, surface, true));
    bool refused = false;
    try {
        static_cast<void>(bbl::overlay_lends_target_depth(task, {640, 360, 4}, surface, false));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    assert(refused);
}
`,
        );
    },
);
