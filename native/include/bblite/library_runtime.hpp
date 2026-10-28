#pragma once

// The engine, scene, camera and render-task objects a lowered pinned library
// (src/lowering/library-runtime.ts) reaches, over the native ones: the engine
// is a `StoredEngine` whose `_device` is `Engine::webgpu_device` and whose
// `_currentEncoder` is the encoder a scene pass names while its external
// renderables' batches flush (pal_external_renderables.hpp); a scene is its
// shared `SceneState`; a renderable, its bindings and their update batches
// implement `gpu_renderable.hpp`, which the scene pass drives with
// render-task-base.ts's protocol. The camera math and the scene node's world
// matrix are generated pinned functions (`bblite/upstream/library_prelude.hpp`).

#include <bblite/gpu.hpp>
#include <bblite/gpu_renderable.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/js_callback.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_gc.hpp>
#include <bblite/pal_frame_post_submit.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <bblite/pal_source_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/web_platform.hpp>

#include <array>
#include <cmath>
#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace bbl {

/** A `SceneContext` a library holds: the scene's shared state, by identity. */
using LibraryScene = std::shared_ptr<SceneState>;
/** A scene pass's `RenderTargetSignature`: one object per distinct signature. */
using LibraryTargetSignature = GpuRenderTargetSignatureHandle;

} // namespace bbl

namespace bbl::pinned {

/** The engine as a WeakMap key: its lifetime, which expires with it. */
[[nodiscard]] inline std::weak_ptr<const void> weak_key(const StoredEngine& engine) {
    return engine.weak_key();
}

} // namespace bbl::pinned

namespace bbl::library {

/** An `Error | null` member the record stores as an empty js::Error for null. */
[[nodiscard]] inline js::Nullable<js::Error> nullable_error(const js::Error& error) {
    return error.identity() ? js::Nullable<js::Error>(error) : js::Nullable<js::Error>();
}

/** A `Record | null` member the record stores as a handle, null for none. */
template <class T>
[[nodiscard]] js::Nullable<std::shared_ptr<T>> nullable_handle(const std::shared_ptr<T>& handle) {
    return handle ? js::Nullable<std::shared_ptr<T>>(handle) : js::Nullable<std::shared_ptr<T>>();
}

// ── Engine ─────────────────────────────────────────────────────────────

/** `engine._device`: the WebGPU subset the engine has from createEngine on. */
[[nodiscard]] inline GpuDeviceHandle engine_device(const StoredEngine& engine) {
    auto& owner = *engine;
    if (!owner.webgpu_device || owner.device_disposed)
        throw std::runtime_error("The engine has no WebGPU device for the lowered library.");
    return owner.webgpu_device;
}

/** `engine._currentEncoder`: the frame encoder while a scene pass flushes its batches. */
[[nodiscard]] inline GpuCommandEncoderHandle engine_encoder(const StoredEngine& engine) {
    auto& owner = *engine;
    if (!owner.current_encoder)
        throw std::runtime_error(
            "engine._currentEncoder is read outside a scene pass's batch flush.");
    return owner.current_encoder;
}

/** `retireGpuResources(engine, retirement)`: runs once the next submission drains. */
inline void retire_gpu_resources(const StoredEngine& engine, js::Callback<void()> retirement) {
    bbl::retire_gpu_resources(pal::gpu_retirement_state(*engine),
                              [retirement = std::move(retirement)] { retirement(); });
}

// ── Scene ──────────────────────────────────────────────────────────────

/** `scene.surface.engine`. */
[[nodiscard]] inline StoredEngine scene_engine(const LibraryScene& scene) {
    if (!scene || !scene->engine)
        throw std::runtime_error("The lowered library's scene has no engine.");
    return StoredEngine(*scene->engine);
}

// ── Camera ─────────────────────────────────────────────────────────────

/** The camera a scene pass draws with: its record in its engine. */
struct Camera {
    Engine* engine = nullptr;
    CameraHandle handle{};
    [[nodiscard]] CameraRecord& record() const {
        if (!engine)
            throw std::runtime_error("A lowered library's camera has no engine.");
        return handle_at(engine->cameras, handle);
    }
};

/** The pin's `DrawUpdateContext`. */
struct DrawContext {
    double target_width = 0;
    double target_height = 0;
    js::Nullable<Camera> camera;
};

/** The pin's `OrthographicBounds`: a null plane derives from `half_height`. */
struct OrthographicBounds {
    double half_height = 1.0;
    js::Nullable<double> left, right, bottom, top;
};

/** `camera.ortho`: null for a perspective camera. */
[[nodiscard]] inline js::Nullable<OrthographicBounds> camera_ortho(const Camera& camera) {
    const auto& record = camera.record();
    if (!record.orthographic)
        return std::nullopt;
    const auto plane = [](const std::optional<double>& value) {
        return value ? js::Nullable<double>(*value) : js::Nullable<double>();
    };
    return OrthographicBounds{record.ortho_half_height, plane(record.ortho_left),
                              plane(record.ortho_right), plane(record.ortho_bottom),
                              plane(record.ortho_top)};
}
[[nodiscard]] inline double camera_fov(const Camera& camera) { return camera.record().fov; }
[[nodiscard]] inline js::Nullable<NormalizedViewport> camera_viewport(const Camera& camera) {
    const auto& viewport = camera.record().viewport;
    return viewport ? js::Nullable<NormalizedViewport>(*viewport) : std::nullopt;
}
[[nodiscard]] inline double camera_near_plane(const Camera& camera) {
    return camera.record().near_plane;
}
[[nodiscard]] inline double camera_far_plane(const Camera& camera) {
    return camera.record().far_plane;
}

// ── Render tasks ───────────────────────────────────────────────────────

/** `getSceneBindGroupLayout(engine)`: the engine's scene layout (`bind_engine_scene_group`). */
[[nodiscard]] inline GpuHandle scene_bind_group_layout(const StoredEngine& engine) {
    auto& owner = *engine;
    if (!owner.webgpu_scene_layout || owner.device_disposed)
        throw std::runtime_error("The engine has no WebGPU scene layout for the lowered library.");
    return owner.webgpu_scene_layout;
}

/** The pin's `DrawUpdateBatch`, whose members are the lowered literal's. */
struct DrawUpdateBatch : GpuDrawUpdateBatch {
    bool retired_flag = false;
    js::Callback<void()> reset_callback;
    js::Callback<void(StoredEngine)> flush_callback;
    js::Callback<void()> destroy_callback;
    /** The engine the batch's binding was bound on, which `flush(engine)` names. */
    StoredEngine flush_engine;

    bool retired() const override { return retired_flag; }
    void mark_retired() override { retired_flag = true; }
    void reset() override { reset_callback(); }
    void flush() override { flush_callback(flush_engine); }
    void destroy() override { destroy_callback(); }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(reset_callback);
        visitor(flush_callback);
        visitor(destroy_callback);
    }
};

struct Renderable;

/** The pin's `DrawBinding`. */
struct DrawBinding final : GpuDrawBinding {
    std::shared_ptr<Renderable> renderable;
    /** `pipeline`, a getter: a binding's update may replace its pipeline. */
    js::Callback<GpuHandle()> get_pipeline;
    js::Callback<void(DrawContext)> update_callback;
    js::Callback<double(GpuEncoderHandle, StoredEngine)> draw_callback;
    js::Nullable<js::Array<std::shared_ptr<DrawUpdateBatch>>> update_batch_list;
    StoredEngine bound_engine;

    GpuHandle pipeline() const override { return get_pipeline(); }
    void update(const GpuDrawUpdateContext& context) override {
        if (!update_callback)
            return;
        update_callback(DrawContext{
            context.target_width, context.target_height,
            context.camera ? js::Nullable<Camera>(Camera{&*bound_engine, *context.camera})
                           : std::nullopt});
    }
    double draw(const GpuEncoderHandle& pass) override { return draw_callback(pass, bound_engine); }
    std::vector<GpuDrawUpdateBatchHandle> update_batches() const override {
        std::vector<GpuDrawUpdateBatchHandle> batches;
        if (update_batch_list)
            for (const auto& batch : *update_batch_list)
                batches.push_back(batch);
        return batches;
    }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(renderable);
        visitor(get_pipeline);
        visitor(update_callback);
        visitor(draw_callback);
        visitor(update_batch_list);
    }
};

/**
 * The pin's `Renderable`, drawn in the scene's own pass: `bind(engine,
 * signature)` per published version and signature, with the pass's own
 * signature object. The pin's literal has no `_worldCenter`, so its binding
 * sorts at distance 0.
 */
struct Renderable final : GpuExternalRenderable {
    double order_value = 0;
    bool is_transparent = false;
    js::Callback<std::shared_ptr<DrawBinding>(StoredEngine, LibraryTargetSignature)> bind_callback;
    /** `_rebuild`: the renderable its builder makes again on a recovered device. */
    js::Callback<js::Promise<std::shared_ptr<Renderable>>()> rebuild_callback;
    /** The engine whose scene published it. */
    StoredEngine bound_engine;

    double order() const override { return order_value; }
    bool transparent() const override { return is_transparent; }
    std::optional<std::array<double, 3>> world_center() const override { return std::nullopt; }
    GpuDrawBindingHandle bind(const GpuRenderTargetSignatureHandle& signature) override {
        auto binding = bind_callback(bound_engine, signature);
        if (!binding)
            throw std::runtime_error("A lowered library's renderable bind returned no binding.");
        binding->bound_engine = bound_engine;
        if (binding->update_batch_list)
            for (const auto& batch : *binding->update_batch_list)
                batch->flush_engine = bound_engine;
        return binding;
    }
    void gc_trace(const js::TraceVisitor& visitor) const override {
        visitor(bind_callback);
        visitor(rebuild_callback);
    }
};

/** `signature._colorFormat`. */
[[nodiscard]] inline js::Nullable<std::string>
signature_color_format(const LibraryTargetSignature& signature) {
    return signature->color_format;
}

/** What a deferred builder publishes. */
struct DeferredRenderables {
    js::Array<std::shared_ptr<Renderable>> renderables;
    js::Callback<void()> dispose;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(renderables);
        visitor(dispose);
    }
};

// ── The scene's renderables ────────────────────────────────────────────

/** A scene renderable as a lowered library reads it: one a lowered library made. */
[[nodiscard]] inline std::shared_ptr<Renderable>
library_renderable(const GpuExternalRenderableHandle& renderable) {
    auto library = std::dynamic_pointer_cast<Renderable>(renderable);
    if (!library)
        throw std::runtime_error("A library reads a scene renderable no lowered library owns.");
    return library;
}

/** `scene._renderables` read as an array: each a lowered library's renderable. */
[[nodiscard]] inline js::Array<std::shared_ptr<Renderable>>
scene_renderables(const LibraryScene& scene) {
    js::Array<std::shared_ptr<Renderable>> values;
    for (const auto& renderable : scene->external_renderables)
        values.push_back(library_renderable(renderable));
    return values;
}

/**
 * A renderable joining the scene pass as `_renderables.push` publishes it:
 * bound to `engine`, at the next `_renderables` position. Returns the list's
 * new length.
 */
inline double join_scene_renderable(SceneState& state, const StoredEngine& engine,
                                    const std::shared_ptr<Renderable>& renderable) {
    renderable->bound_engine = engine;
    renderable->publication = ++state.engine->source_output_identity;
    return scene_list_push(state.external_renderables, renderable);
}

/** `scene._renderables.push(renderable)`. */
inline double push_scene_renderable(const LibraryScene& scene,
                                    const std::shared_ptr<Renderable>& renderable) {
    if (!scene->engine)
        throw std::runtime_error("A renderable joins a scene that has no engine.");
    return join_scene_renderable(*scene, StoredEngine(*scene->engine), renderable);
}

/** `scene._renderables.sort(compare)`: a stable sort of the scene's own list. */
inline void sort_scene_renderables(
    const LibraryScene& scene,
    const js::Callback<double(std::shared_ptr<Renderable>, std::shared_ptr<Renderable>)>& compare) {
    std::stable_sort(scene->external_renderables.begin(), scene->external_renderables.end(),
                     [&](const auto& left, const auto& right) {
                         return compare(library_renderable(left), library_renderable(right)) < 0;
                     });
}

// ── The scene pass a library pauses (gps-pass.ts) ──────────────────────

/** The scene pass's depth (`SceneState::pass_depth`), which no lowered library samples yet. */
struct SceneDepthTexture final : GpuObject {
    std::shared_ptr<GpuObject> create_view() override {
        throw std::runtime_error("Sampling the scene pass's depth is not lowered.");
    }
};

/** A pass target as gps-scene-depth.ts reads it: its depth and whether it loads it. */
struct RenderTargetView {
    GpuHandle depth_texture;
    bool eager = false;
};
struct RenderTaskConfigView {
    RenderTargetView target;
    js::Nullable<RenderTargetView> depth;
    js::Nullable<bool> depth_clear;
};
/** The scene task drawing a signature's pass (render-task-base.ts `RenderTask`). */
struct RenderTaskView {
    RenderTaskConfigView config;
    LibraryScene scene;
};

/** `task._renderables`: the scene task mirrors the scene's (`autoMirror`). */
[[nodiscard]] inline LibraryScene task_renderables(const RenderTaskView& task) {
    return task.scene;
}

/**
 * `gpsRenderTask(scene, signature)`: the scene's own task for its pass,
 * whose depth is the task's own, cleared at the pass's start
 * (scene-core.ts `_createAutomaticRenderTask`); none for another target.
 */
[[nodiscard]] inline js::Nullable<RenderTaskView>
gps_render_task(const LibraryScene& scene, const LibraryTargetSignature& signature) {
    if (!scene->pausable_pass || scene->pausable_pass != signature)
        return std::nullopt;
    RenderTaskView task;
    task.scene = scene;
    if (signature->depth_stencil_format) {
        if (!scene->pass_depth)
            scene->pass_depth = std::make_shared<SceneDepthTexture>();
        task.config.depth = RenderTargetView{scene->pass_depth, false};
    }
    return task;
}

/**
 * `installGpsPasses(scene, isRendering)`: the scene pass splits on a frame
 * the renderer renders, by default every frame (`scene_pass_split`); the
 * release gives it back once.
 */
[[nodiscard]] inline js::Callback<void()>
gps_install_passes(const LibraryScene& scene, js::Callback<bool()> is_rendering = {}) {
    js::Callback<bool()> rendering(
        js::make_closure(std::tuple{std::move(is_rendering)}, [](auto& environment) {
            const auto& [predicate] = environment;
            return !predicate || predicate();
        }));
    const auto identity = rendering.identity();
    scene->pass_controllers.push_back(std::move(rendering));
    auto released = std::make_shared<bool>(false);
    // The release sits in the scene's own disposables: it holds the scene weakly.
    return [owner = std::weak_ptr<SceneState>(scene), released, identity]() {
        if (std::exchange(*released, true))
            return;
        if (const auto state = owner.lock())
            std::erase_if(state->pass_controllers, [&](const js::Callback<bool()>& rendering) {
                return rendering.identity() == identity;
            });
    };
}

/** `gpsRefreshPasses`: the renderer follows its own passes. */
inline void gps_refresh_passes(const LibraryScene&) {}

/**
 * `gpsDefersDraw(scene, signature)`: a held pass with depth defers its
 * renderer's work to its draw. Only the scene pass pauses natively.
 */
[[nodiscard]] inline bool gps_defers_draw(const LibraryScene& scene,
                                          const LibraryTargetSignature& signature) {
    if (scene->pass_controllers.empty() || !signature || !signature->depth_stencil_format)
        return false;
    if (scene->pausable_pass != signature)
        throw std::runtime_error("Pausing a render task's pass is not lowered.");
    return true;
}

/** `gpsPassHasDraws(pass)`: undefined for a pass the renderer did not split. */
[[nodiscard]] inline js::Nullable<bool> gps_pass_has_draws(const GpuEncoderHandle& pass) {
    const auto drawn = pass->pass_has_draws();
    return drawn ? js::Nullable<bool>(*drawn) : std::nullopt;
}

/** `gpsWithPassDepth(pass, work)`: `work` between the pass's two halves. */
inline bool gps_with_pass_depth(const GpuEncoderHandle& pass, const js::Callback<void()>& work) {
    return pass->pause_pass([&] { work(); });
}

/** What a deferred builder returns: its renderables, or their promise. */
using DeferredBuild = std::variant<DeferredRenderables, js::Promise<DeferredRenderables>>;

/** A built set joining the scene: its renderables the pass's, its disposer the scene's. */
inline void publish_deferred_renderables(SceneState& state, const StoredEngine& engine,
                                         const DeferredRenderables& built) {
    for (const auto& renderable : built.renderables)
        static_cast<void>(join_scene_renderable(state, engine, renderable));
    if (built.dispose)
        state.disposables.push_back(built.dispose);
}

/**
 * scene-core.ts `addDeferredSceneRenderables`: the builder runs when the
 * scene builds, its renderables join the scene pass's external renderables
 * and its disposer the scene's disposables. An async builder's set joins
 * when its promise settles, moving `renderable_version` again; native
 * registration returns before then, so a rejection it can no longer reject
 * with is thrown on the realm.
 */
inline void
add_deferred_scene_renderables(const LibraryScene& scene,
                               js::Callback<DeferredBuild(StoredEngine, LibraryScene)> build) {
    auto view = Scene::from_state(scene);
    const std::weak_ptr<SceneState> owner = scene;
    bbl::add_deferred_scene_renderables(view, [owner, build = std::move(build)](SceneState& state) {
        const auto shared = owner.lock();
        if (!shared || !state.engine)
            return;
        const StoredEngine engine(*state.engine);
        auto built = build(engine, shared);
        if (const auto* ready = std::get_if<DeferredRenderables>(&built)) {
            publish_deferred_renderables(state, engine, *ready);
            return;
        }
        std::get<js::Promise<DeferredRenderables>>(built).observe(
            js::make_closure(std::tuple{owner, engine},
                             [](auto& environment, const DeferredRenderables& settled) {
                                 const auto& [weak, bound] = environment;
                                 if (const auto state = weak.lock()) {
                                     publish_deferred_renderables(*state, bound, settled);
                                     ++state->renderable_version;
                                 }
                             }),
            js::Callback<void(std::exception_ptr)>(
                [](std::exception_ptr error) { std::rethrow_exception(error); }));
    });
}

// ── Scene members ──────────────────────────────────────────────────────

/** A scene member's value of type `T`, traced as `T` (`SceneState::library_members`). */
template <class T> struct SceneMember final : SceneLibraryMember {
    T value{};
    void gc_trace(const js::TraceVisitor& visitor) const override { visitor(value); }
};

/** `scene.<name>`: what the library stored there, or `T`'s absence. */
template <class T>
[[nodiscard]] T scene_member(const LibraryScene& scene, const std::string& name) {
    const auto found = scene->library_members.find(name);
    if (found == scene->library_members.end())
        return T{};
    const auto* member = dynamic_cast<const SceneMember<T>*>(found->second.get());
    if (!member)
        throw std::logic_error("A scene member '" + name + "' holds another type.");
    return member->value;
}

/** `scene.<name> = value`. */
template <class T>
void set_scene_member(const LibraryScene& scene, const std::string& name, T value) {
    auto member = std::make_shared<SceneMember<T>>();
    member->value = std::move(value);
    scene->library_members[name] = std::move(member);
}

/** `scene._z`: `disposeScene` ran. */
[[nodiscard]] inline bool scene_disposed(const LibraryScene& scene) { return scene->disposed; }

/** `scene.fog`, by presence: a fog object the scene holds (`fog_identity`). */
struct Fog {};
[[nodiscard]] inline js::Nullable<Fog> scene_fog(const LibraryScene& scene) {
    return scene->fog_identity ? js::Nullable<Fog>(Fog{}) : std::nullopt;
}

// ── Materials and textures ─────────────────────────────────────────────

/**
 * The pin's `Texture2D` a library binds: its GPU texture, view and sampler on
 * the engine's WebGPU-subset device, its size, and the per-texture fields a
 * material reads (UV transform, `invertY`).
 */
struct Texture2D {
    GpuHandle texture;
    GpuHandle view;
    GpuHandle sampler;
    double width = 0;
    double height = 0;
    js::Nullable<double> u_scale, v_scale, u_offset, v_offset, u_ang;
    js::Nullable<bool> invert_y;
    /** A material slot's texture: the slot it was made from and its shared upload. */
    TextureData source;
    std::shared_ptr<const void> upload;
};

/** tone-mapping.ts `ToneMapping`: one of the pin's curves (`scene_tone_mapping`, the prelude). */
struct ToneMapping {
    std::string id;
    std::string helpers_wgsl;
    std::string call_wgsl;
};

/** `EnvironmentTextures`: a scene environment's BRDF LUT and specular cube, sampled. */
struct EnvironmentTextures {
    GpuHandle brdf_lut_view;
    GpuHandle brdf_sampler;
    GpuHandle specular_cube_view;
    GpuHandle cube_sampler;
    /** The scene environment they were made from (`SceneState::environment_identity`). */
    std::uint64_t identity = 0;
};

} // namespace bbl::library

namespace bbl::pal {

/**
 * A material texture slot's `Texture2D` on the engine's WebGPU-subset device:
 * `held`, the one the slot made before, while the slot keeps its image,
 * sampling and transform, else a new one over the backend's own upload of
 * the image (shared by every slot reading it) and its own sampler. A new
 * texture counts the material's reference (texture-acquire.ts), so a
 * library's release never destroys what the material binds.
 */
std::shared_ptr<library::Texture2D> library_texture(Engine& engine, const TextureData& data,
                                                    std::shared_ptr<void>& held);

/** A scene environment's specular cube (a cube view) and BRDF LUT as WebGPU-subset views. */
struct LibraryEnvironmentViews {
    GpuHandle specular_cube_view;
    GpuHandle brdf_lut_view;
};
LibraryEnvironmentViews library_environment_views(Engine& engine,
                                                  const EnvironmentState& environment);

} // namespace bbl::pal

namespace bbl::library {

/**
 * A PBR material a program holds (`PbrMaterialProps`): its native record by
 * engine and handle, compared and hashed by identity. A member the record
 * keeps seeded with the pin's default reads as present (`seeded` in
 * library-runtime.ts); a feature flag reads true or absent.
 */
struct PbrMaterial {
    Engine* engine = nullptr;
    MaterialHandle handle{};
    [[nodiscard]] MaterialRecord& record() const {
        if (!engine)
            throw std::runtime_error("A lowered library's material has no engine.");
        return handle_at(engine->materials, handle);
    }
    [[nodiscard]] std::size_t key_hash() const noexcept {
        return std::hash<const void*>{}(engine) ^ handle.value;
    }
    friend bool operator==(const PbrMaterial&, const PbrMaterial&) = default;
};

/** A program's material as a library's `PbrMaterialProps`: a PBR record only. */
[[nodiscard]] inline PbrMaterial pbr_material(const StoredEngine& engine, MaterialHandle handle) {
    PbrMaterial material{&*engine, handle};
    if (material_family_bit(material.record()) != material_family_pbr)
        throw std::runtime_error("A lowered library's PbrMaterialProps is a PBR material.");
    return material;
}

/** A device-lost recovery capture: generation refuses one beside a lowered library. */
struct DeviceLossCapture {
    [[noreturn]] void refuse() const {
        throw std::logic_error("Device-lost recovery captures no lowered library's texture.");
    }
};
[[nodiscard]] inline std::shared_ptr<DeviceLossCapture>
engine_device_loss_capture(const StoredEngine&) {
    return nullptr;
}

/** A program's material plugins or stencil state, which a MeshLoD material never has. */
[[nodiscard]] inline std::shared_ptr<const void> pbr_absent_object(const PbrMaterial&) {
    return nullptr;
}
[[nodiscard]] inline js::Nullable<js::Array<std::shared_ptr<const void>>>
pbr_absent_plugins(const PbrMaterial&) {
    return std::nullopt;
}

/**
 * texture-reference-store.ts `getTextureReferenceStore()`: one store, in
 * which `pal::library_texture` counts the material's own reference to each
 * GPU texture it borrows, so the library's release never destroys it.
 */
[[nodiscard]] inline js::WeakMap<double> texture_references() {
    static const js::WeakMap<double> references;
    return references;
}

/**
 * texture-metadata.ts `hasTextureTransform`: `readTransform`'s fields, each
 * its identity when absent (offsets 0, scales 1, angle 0) and no transform at
 * all when one is not finite (`readTransformNumber`), against the identity
 * `isIdentityTransform` compares with; the pin reads them reflectively off
 * the wrapper. A material slot's texture is a 2D one, which
 * `supportsTransform` admits.
 */
[[nodiscard]] inline bool texture_has_transform(const std::shared_ptr<Texture2D>& texture) {
    const std::array<std::pair<const js::Nullable<double>*, double>, 5> fields{{
        {&texture->u_offset, 0},
        {&texture->v_offset, 0},
        {&texture->u_scale, 1},
        {&texture->v_scale, 1},
        {&texture->u_ang, 0},
    }};
    bool differs = false;
    for (const auto& [value, identity] : fields) {
        if (*value && !std::isfinite(**value))
            return false;
        differs = differs || (*value && **value != identity);
    }
    return differs;
}

/** A feature flag the pin's material leaves absent until it is set. */
[[nodiscard]] inline js::Nullable<bool> flag(bool value) {
    return value ? js::Nullable<bool>(true) : std::nullopt;
}

/** The material texture slots a library reads, each held by the material (`library_textures`). */
enum class MaterialTextureSlot : std::size_t {
    base_color,
    normal,
    orm,
    emissive,
    lightmap,
    spec_gloss,
};

/** A texture slot: absent without an image, else its `Texture2D`. */
[[nodiscard]] inline std::shared_ptr<Texture2D>
material_texture(const PbrMaterial& material, const TextureData& data, MaterialTextureSlot slot) {
    if (!data.has_image())
        return nullptr;
    auto& held = material.record().library_textures;
    const auto index = static_cast<std::size_t>(slot);
    if (held.size() <= index)
        held.resize(index + 1);
    return pal::library_texture(*material.engine, data, held[index]);
}

/** `_getPbrLocalEnvironment(material)`, by presence: a local cubemap set. */
[[nodiscard]] inline js::Nullable<bool> pbr_local_environment(const PbrMaterial& material) {
    return flag(material.record().local_environment != nullptr);
}

/** `getPbrMetallicReflectance(material)`, by presence: the setter ran. */
[[nodiscard]] inline js::Nullable<bool> pbr_metallic_reflectance(const PbrMaterial& material) {
    return flag(material.record().has_metallic_reflectance);
}

[[nodiscard]] inline js::Nullable<bool> pbr_alpha_blend(const PbrMaterial& material) {
    return flag(material.record().alpha_mode == MaterialAlphaMode::blend);
}
[[nodiscard]] inline js::Nullable<double> pbr_alpha_cutoff(const PbrMaterial& material) {
    const auto& record = material.record();
    return record.alpha_mode == MaterialAlphaMode::mask ? js::Nullable<double>(record.alpha_cutoff)
                                                        : std::nullopt;
}
[[nodiscard]] inline js::Nullable<bool> pbr_gamma_albedo(const PbrMaterial& material) {
    return flag(material.record().source_gamma_albedo);
}
[[nodiscard]] inline js::Nullable<bool> pbr_transmissive(const PbrMaterial& material) {
    return flag(material.record().source_transmissive);
}
[[nodiscard]] inline js::Nullable<bool> pbr_clear_coat(const PbrMaterial& material) {
    return flag(material.record().has_clearcoat);
}
[[nodiscard]] inline js::Nullable<bool> pbr_sheen(const PbrMaterial& material) {
    return flag(material.record().has_sheen);
}
[[nodiscard]] inline js::Nullable<bool> pbr_iridescence(const PbrMaterial& material) {
    return flag(material.record().has_iridescence);
}
[[nodiscard]] inline js::Nullable<bool> pbr_anisotropy(const PbrMaterial& material) {
    return flag(material.record().has_anisotropy);
}
[[nodiscard]] inline js::Nullable<bool> pbr_subsurface(const PbrMaterial& material) {
    return flag(material.record().has_subsurface);
}
[[nodiscard]] inline js::Nullable<bool> pbr_has_uv_transform(const PbrMaterial& material) {
    return flag(material.record().has_uv_transform);
}
[[nodiscard]] inline js::Nullable<bool> pbr_shadow_only(const PbrMaterial& material) {
    return flag(material.record().shadow_only);
}
[[nodiscard]] inline js::Nullable<bool> pbr_skybox_mode(const PbrMaterial& material) {
    return flag(material.record().skybox_mode);
}
[[nodiscard]] inline js::Nullable<bool> pbr_unlit(const PbrMaterial& material) {
    return flag(material.record().unlit);
}
[[nodiscard]] inline js::Nullable<bool> pbr_specular_aa(const PbrMaterial& material) {
    return flag(material.record().specular_aa);
}
[[nodiscard]] inline js::Nullable<bool> pbr_double_sided(const PbrMaterial& material) {
    return flag(material.record().double_sided);
}
/** `usePhysicalLightFalloff`: read only as `=== false`, its one stated value. */
[[nodiscard]] inline js::Nullable<bool>
pbr_use_physical_light_falloff(const PbrMaterial& material) {
    return material.record().use_physical_light_falloff ? std::nullopt : js::Nullable<bool>(false);
}
/** `occlusionTexCoord`: 1 for the glTF occlusion texture on TEXCOORD_1, else absent. */
[[nodiscard]] inline js::Nullable<double> pbr_occlusion_tex_coord(const PbrMaterial& material) {
    return material.record().occlusion_texture_uv2 ? js::Nullable<double>(1.0) : std::nullopt;
}
[[nodiscard]] inline std::shared_ptr<Texture2D>
pbr_base_color_texture(const PbrMaterial& material) {
    const auto& record = material.record();
    return record.has_public_base_color_texture
               ? material_texture(material, record.base_color_texture,
                                  MaterialTextureSlot::base_color)
               : nullptr;
}
[[nodiscard]] inline std::shared_ptr<Texture2D> pbr_normal_texture(const PbrMaterial& material) {
    return material_texture(material, material.record().normal_texture,
                            MaterialTextureSlot::normal);
}
[[nodiscard]] inline std::shared_ptr<Texture2D> pbr_orm_texture(const PbrMaterial& material) {
    return material_texture(material, material.record().metallic_roughness_texture,
                            MaterialTextureSlot::orm);
}
[[nodiscard]] inline std::shared_ptr<Texture2D> pbr_emissive_texture(const PbrMaterial& material) {
    return material_texture(material, material.record().emissive_texture,
                            MaterialTextureSlot::emissive);
}
[[nodiscard]] inline std::shared_ptr<Texture2D> pbr_lightmap_texture(const PbrMaterial& material) {
    return material_texture(material, material.record().lightmap_texture,
                            MaterialTextureSlot::lightmap);
}
[[nodiscard]] inline std::shared_ptr<Texture2D>
pbr_spec_gloss_texture(const PbrMaterial& material) {
    return material_texture(material, material.record().spec_gloss_texture,
                            MaterialTextureSlot::spec_gloss);
}
[[nodiscard]] inline js::Tuple<4> pbr_base_color_factor(const PbrMaterial& material) {
    const auto& factor = material.record().base_color_factor;
    return {factor.r, factor.g, factor.b, factor.a};
}
[[nodiscard]] inline js::Tuple<3> pbr_unlit_color(const PbrMaterial& material) {
    const auto& color = material.record().unlit_color;
    return {color.r, color.g, color.b};
}
/** `_emissiveColor`: the colour `setPbrEmissive` stated, absent otherwise. */
[[nodiscard]] inline js::Nullable<js::Tuple<3>> pbr_emissive_color(const PbrMaterial& material) {
    const auto& record = material.record();
    if (!record.has_emissive_color)
        return std::nullopt;
    return js::Tuple<3>{record.emissive_factor.r, record.emissive_factor.g,
                        record.emissive_factor.b};
}
[[nodiscard]] inline double pbr_alpha(const PbrMaterial& material) {
    return material.record().alpha;
}
[[nodiscard]] inline double pbr_metallic_factor(const PbrMaterial& material) {
    return material.record().metallic_factor;
}
[[nodiscard]] inline double pbr_roughness_factor(const PbrMaterial& material) {
    return material.record().roughness_factor;
}
[[nodiscard]] inline double pbr_normal_texture_scale(const PbrMaterial& material) {
    return material.record().normal_texture_scale;
}
[[nodiscard]] inline double pbr_occlusion_strength(const PbrMaterial& material) {
    return material.record().occlusion_strength;
}
[[nodiscard]] inline double pbr_environment_intensity(const PbrMaterial& material) {
    return material.record().environment_intensity;
}
[[nodiscard]] inline double pbr_direct_intensity(const PbrMaterial& material) {
    return material.record().direct_intensity;
}
[[nodiscard]] inline double pbr_reflectance(const PbrMaterial& material) {
    return material.record().reflectance;
}
[[nodiscard]] inline double pbr_ubo_version(const PbrMaterial& material) {
    return static_cast<double>(material.record().ubo_version);
}

/**
 * env-helpers.ts `assembleEnvironmentTextures` over the scene's environment
 * (`_envTextures`), absent until one is loaded: its specular cube and BRDF
 * LUT views with the pin's trilinear and bilinear samplers (the generated
 * prelude's `scene_environment` passes samplers.ts's descriptors), made once
 * per loaded environment and held by the scene.
 */
[[nodiscard]] inline std::shared_ptr<EnvironmentTextures>
environment_textures(const LibraryScene& scene, const GpuSamplerDescriptor& cube_sampler,
                     const GpuSamplerDescriptor& brdf_sampler) {
    if (!scene->environment_identity)
        return nullptr;
    using Held = std::shared_ptr<EnvironmentTextures>;
    if (auto held = scene_member<Held>(scene, "_envTextures");
        held && held->identity == scene->environment_identity)
        return held;
    Engine& engine = *scene->engine;
    const auto views = pal::library_environment_views(engine, scene->environment);
    auto& device = *engine.webgpu_device;
    auto made = std::make_shared<EnvironmentTextures>(EnvironmentTextures{
        views.brdf_lut_view, device.create_sampler(brdf_sampler), views.specular_cube_view,
        device.create_sampler(cube_sampler), scene->environment_identity});
    set_scene_member<Held>(scene, "_envTextures", made);
    return made;
}

// ── Scene node ─────────────────────────────────────────────────────────

/**
 * The TRS triple `initSceneNodeTransform` adds to the stream (scene-node.ts):
 * the quaternion is the source of truth, the Euler triple the proxy's cache
 * of the last value it applied, kept while the quaternion's version stays.
 */
struct SceneNode {
    std::string name;
    js::Array<std::shared_ptr<const void>> children;
    Vec3d position{};
    Vec3d scaling{1, 1, 1};
    Vec3d rotation{};
    Vec4d rotation_quaternion{0, 0, 0, 1};
    double quaternion_version = 0;
    double synced_quaternion_version = -1;
    /**
     * `node.parent`: a native scene node (an `IWorldMatrixProvider` the
     * world-matrix state does not track), whose world the node's composes
     * under, read when the node's world is.
     */
    std::function<js::Array<double>()> parent_world;
    /**
     * `worldMatrixVersion`: advanced when a read finds the composed world
     * changed. The pin's consumers compare versions to re-upload, so an
     * unchanged world keeping its version uploads nothing they would see.
     */
    mutable std::optional<std::array<float, 16>> versioned_world;
    mutable double world_version = 0;
};

/** `node.parent = mesh`: the node composes its world under the native mesh's. */
inline void set_node_parent(SceneNode& node, const StoredEngine& engine, MeshHandle mesh) {
    node.parent_world = [engine, mesh] { return mesh_world_matrix_array(*engine, mesh); };
}

/** `node.parent = null`. */
inline void clear_node_parent(SceneNode& node) { node.parent_world = nullptr; }

} // namespace bbl::library
