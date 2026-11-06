import type { LoweringContext } from "./context.js";
import { stringLiteral } from "../cpp-literals.js";

const OVERLAY_MODULE = "src/scene/overlay-scene.ts";
const CORE_MODULE = "src/scene/scene-core.ts";

/**
 * The overlay shapes a native layer does not stand for, refused at
 * generation where the source shows them and at run time otherwise.
 */
export const overlayRefusals = {
    auxiliarySurface:
        "An overlay of a scene on an auxiliary surface is not supported: that scene presents through its own frame graph.",
    frameGraph:
        "An overlay scene with its own frame-graph tasks is not supported: a native overlay is drawn as a layer of its base's scene pass, never through tasks of its own.",
} as const;

/**
 * overlay-scene.ts `isSuspended` and registerScene's overlay hook, the pinned
 * shapes of the runtime's composition (runtime.hpp `overlay_scene_suspended`
 * and `composited_scenes`): registerScene leaves every scene clearing its
 * surface unless `createOverlayScene` made it. Asserted for every program,
 * since both renderers draw that composition whether or not one builds an
 * overlay.
 */
export function assertOverlayComposition(context: LoweringContext): void {
    context.assertFunctionContract(
        OVERLAY_MODULE,
        "isSuspended",
        `
function isSuspended(scene: SceneContext): boolean {
    let base = scene._overlayBase;
    while (base && isRenderingContextRegistered(scene.surface, base)) {
        base = base._overlayBase;
    }
    return !!base;
}
`,
        "overlay-scene.isSuspended native contract",
    );
    for (const name of ["registerScene", "registerSceneWithShadowSupport"])
        context.expectShapeCount(
            context.functionDeclaration(CORE_MODULE, name).declaration,
            "_lateCleanup?.get(ctx)?.() || (registerRenderingContext(surface, ctx) && _overlaySceneRegistered?.(ctx))",
            `${name}'s registration and overlay hook`,
        );
}

/**
 * overlay-scene.ts `createOverlayScene` and the registration order it
 * installs: `register_scene` runs `move_swapchain_overlays_after_base`
 * after every insertion, as the installed `_overlaySceneRegistered` hook
 * does once an overlay exists (before one does, it moves nothing). The
 * overlay's suspended `_update` and `_record` are the renderers', which draw
 * `composited_scenes`, and its `configureSwapchainOverlayScene` record is
 * runtime.hpp `overlay_composite`. An overlay never runs tasks of its own
 * (`overlayRefusals.frameGraph`), so the record's replaced-task restore has
 * nothing to restore.
 */
export function lowerOverlayScenes(context: LoweringContext): string {
    context.assertFunctionContract(
        OVERLAY_MODULE,
        "createOverlayScene",
        `
export function createOverlayScene(baseScene: SceneContext): SceneContext {
    const scene = createSceneContext(baseScene.surface);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
    scene._overlayBase = baseScene;
    _installOverlaySceneRegistration(moveSwapchainOverlaysAfterBase);
    configureSwapchainOverlayScene(scene);

    const update = scene._update;
    const record = scene._record;
    scene._update = () => {
        if (isSuspended(scene)) {
            scene._drawCallsPre = 0;
        } else {
            update();
        }
    };
    scene._record = () => (isSuspended(scene) ? 0 : record());
    return scene;
}
`,
        "overlay-scene.createOverlayScene native contract",
    );
    context.assertFunctionContract(
        CORE_MODULE,
        "_installOverlaySceneRegistration",
        `
export function _installOverlaySceneRegistration(registered: (scene: SceneContext) => void): void {
    _overlaySceneRegistered = registered;
}
`,
        "scene-core._installOverlaySceneRegistration native contract",
    );
    context.assertFunctionContract(
        "src/scene/swapchain-overlay.ts",
        "configureSwapchainOverlayScene",
        `
export function configureSwapchainOverlayScene(overlay: SceneContext): void {
    const surface = overlay.surface;
    const record = overlay._record;
    let task: RenderTask | undefined;
    let clr: boolean | undefined;
    overlay._record = () => {
        const current = getDefaultSwapchainTask(overlay, surface);
        if (current !== task) {
            if (task) {
                task._config.clr = clr;
                task._colorAttachment.view = task._config.rt._colorView!;
            }
            task = current;
            clr = current?._config.clr;
        }
        if (current) {
            if (surface.msaaSamples > 1) {
                let root = overlay._overlayBase!;
                while (root._overlayBase) {
                    root = root._overlayBase;
                }
                const rootTask = getDefaultSwapchainTask(root, surface);
                const view = rootTask?.enabled !== false && rootTask?.executionEnabled !== false && rootTask?._config.rst === surface.scRT && rootTask._colorAttachment.view;
                if (!view) {
                    const enabled = current.enabled;
                    current.enabled = false;
                    try {
                        return record();
                    } finally {
                        current.enabled = enabled;
                    }
                }
                current._colorAttachment.view = view;
            }
            current._config.clr = false;
        }
        return record();
    };
}
`,
        "swapchain-overlay.configureSwapchainOverlayScene native contract",
    );
    context.assertFunctionContract(
        "src/engine/rendering-context-order.ts",
        "moveRenderingContext",
        `
export function moveRenderingContext(surface: SurfaceContext, context: RenderingContext, index: number): boolean {
    if (!Number.isInteger(index)) {
        throw new RangeError("Rendering context index must be an integer.");
    }
    const list = surface._renderingContexts;
    const i = list.indexOf(context);
    if (i === -1) {
        return false;
    }
    list.splice(i, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, context);
    return true;
}
`,
        "rendering-context-order.moveRenderingContext native contract",
    );
    context.assertFunctionContract(
        OVERLAY_MODULE,
        "isOverlayDescendant",
        `
function isOverlayDescendant(context: RenderingContext, base: SceneContext): boolean {
    let parent = (context as Partial<SceneContext>)._overlayBase;
    while (parent) {
        if (parent === base) {
            return true;
        }
        parent = parent._overlayBase;
    }
    return false;
}
`,
        "overlay-scene.isOverlayDescendant native contract",
    );
    context.assertFunctionContract(
        OVERLAY_MODULE,
        "moveOverlayDescendants",
        `
function moveOverlayDescendants(base: SceneContext, baseIndex: number): number {
    const surface = base.surface;
    const contexts = surface._renderingContexts;
    const overlays = contexts.filter((context): context is SceneContext => "_overlayBase" in context && context._overlayBase === base);
    for (const overlay of overlays) {
        baseIndex++;
        if (contexts[baseIndex] !== overlay) {
            moveRenderingContext(surface, overlay, baseIndex);
        }
        baseIndex = moveOverlayDescendants(overlay, baseIndex);
    }
    return baseIndex;
}
`,
        "overlay-scene.moveOverlayDescendants native contract",
    );
    context.assertFunctionContract(
        OVERLAY_MODULE,
        "moveSwapchainOverlaysAfterBase",
        `
export function moveSwapchainOverlaysAfterBase(scene: SceneContext): void {
    let base = scene;
    while (base._overlayBase) {
        base = base._overlayBase;
    }
    const surface = base.surface;
    const contexts = surface._renderingContexts;
    let baseIndex = contexts.indexOf(base);
    if (baseIndex === -1) {
        return;
    }
    const firstDescendantIndex = contexts.findIndex((context) => isOverlayDescendant(context, base));
    if (firstDescendantIndex === -1) {
        return;
    }
    if (firstDescendantIndex < baseIndex) {
        moveRenderingContext(surface, base, firstDescendantIndex);
        baseIndex = firstDescendantIndex;
    }
    moveOverlayDescendants(base, baseIndex);
}
`,
        "overlay-scene.moveSwapchainOverlaysAfterBase native contract",
    );
    return `
namespace {

/** The scene a rendering context entry holds, or null for another context kind. */
const SceneState* rendering_context_scene(const Engine& engine, std::size_t index) {
    if (index >= engine.rendering_contexts.size()) return nullptr;
    const auto* registered =
        std::get_if<std::shared_ptr<Scene>>(&engine.rendering_contexts[index].context);
    return registered && *registered ? (*registered)->identity() : nullptr;
}

// ${context.provenance("src/engine/rendering-context-order.ts", "moveRenderingContext")}
// Its callers here pass list positions, so the integer guard holds.
bool move_rendering_context(Engine& engine, const SceneState& context, std::size_t index) {
    const std::optional<std::size_t> i = rendering_context_index(engine, context);
    if (!i) return false;
    auto entry = engine.rendering_contexts.take_at(*i);
    engine.rendering_contexts.insert_at(std::min(index, engine.rendering_contexts.size()),
                                        std::move(entry));
    return true;
}

// ${context.provenance(OVERLAY_MODULE, "isOverlayDescendant")}
bool is_overlay_descendant(const SceneState& context, const SceneState& base) {
    const SceneState* parent = context.overlay_base.get();
    while (parent) {
        if (parent == &base) return true;
        parent = parent->overlay_base.get();
    }
    return false;
}

// ${context.provenance(OVERLAY_MODULE, "moveOverlayDescendants")}
std::size_t move_overlay_descendants(Engine& engine, const SceneState& base, std::size_t base_index) {
    std::vector<std::shared_ptr<SceneState>> overlays;
    for (const std::shared_ptr<Scene>& registered : engine.scenes()) {
        if (registered && registered->state->overlay_base.get() == &base)
            overlays.push_back(registered->state);
    }
    for (const std::shared_ptr<SceneState>& overlay : overlays) {
        ++base_index;
        if (rendering_context_scene(engine, base_index) != overlay.get())
            move_rendering_context(engine, *overlay, base_index);
        base_index = move_overlay_descendants(engine, *overlay, base_index);
    }
    return base_index;
}

} // namespace

// ${context.provenance(OVERLAY_MODULE, "moveSwapchainOverlaysAfterBase")}
void move_swapchain_overlays_after_base(const Scene& scene) {
    require_scene_engine(scene);
    Engine& engine = *scene.engine;
    const SceneState* base = scene.identity();
    while (base->overlay_base) {
        base = base->overlay_base.get();
    }
    const std::optional<std::size_t> registered_index = rendering_context_index(engine, *base);
    if (!registered_index) return;
    std::size_t base_index = *registered_index;
    std::optional<std::size_t> first_descendant_index;
    for (std::size_t index = 0; index < engine.rendering_contexts.size(); ++index) {
        const SceneState* registered = rendering_context_scene(engine, index);
        if (registered && is_overlay_descendant(*registered, *base)) {
            first_descendant_index = index;
            break;
        }
    }
    if (!first_descendant_index) return;
    if (*first_descendant_index < base_index) {
        move_rendering_context(engine, *base, *first_descendant_index);
        base_index = *first_descendant_index;
    }
    move_overlay_descendants(engine, *base, base_index);
}

// ${context.provenance(OVERLAY_MODULE, "createOverlayScene")}
Scene create_overlay_scene(const Scene& base_scene) {
    require_scene_engine(base_scene);
    Engine& engine = *base_scene.engine;
#if BBLITE_HAS_UI
    const std::optional<UiElementHandle> primary = engine.surface_canvas;
#else
    const std::optional<UiElementHandle> primary;
#endif
    if (base_scene.surface_canvas.has_value() != primary.has_value() ||
        (primary && base_scene.surface_canvas->value != primary->value))
        throw std::runtime_error(${stringLiteral(overlayRefusals.auxiliarySurface)});
    // \`createSceneContext(baseScene.surface)\`: the engine's own surface.
    Scene scene = create_scene_context(engine);
    scene.clear_color = Color4{0.0f, 0.0f, 0.0f, 0.0f};
    scene.state->overlay_base = base_scene.state;
    return scene;
}
`;
}
