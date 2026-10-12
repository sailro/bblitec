// A pass's matrices as a shader material reads them: the camera pass
// matrices, the per-draw products and the stage block gather.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/thin_instances.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <array>
#include <optional>
#include <vector>
#include "pal_gpu_surface.hpp"
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#if BBLITE_THIN_INSTANCES
#include <bblite/upstream/thin_instance_sync.hpp>
#include <bblite/pal_source_gpu.hpp>
#include <bblite/pal_offscreen.hpp>
#endif
#endif

namespace bbl {
struct ShaderPacketSystemState {
    std::optional<const CameraRecord*> camera;
    std::optional<double> camera_version, mesh_version, target_width, target_height, aspect,
        alpha_cutoff;
    std::optional<bool> floating_origin;
    std::array<float, 16> view_projection{}, view{}, projection{}, world{}, world_view{},
        world_view_projection{};
    std::array<float, 4> camera_position{};
};
} // namespace bbl

namespace bbl::pal {

#if BBLITE_HAS_PBR_RENDERER
inline std::optional<std::array<float, 16>> shader_world_view(const std::array<float, 16>* view,
                                                              const std::array<float, 16>& world) {
    return view ? std::optional<std::array<float, 16>>{upstream::matrix_product(*view, world)}
                : std::nullopt;
}
#endif
#if BBLITE_HAS_PBR_RENDERER

/**
 * Whether a stage's whole block is the shared scene matrix, so a backend
 * may bind the frame's own buffer instead of the material's.
 *
 * Only `viewProjection` is constant across the pass. Shader-material
 * geometry stays in local space, so `world` and `worldViewProjection`
 * depend on the draw; the two individual factors are pass values but do not
 * have the same layout as the shared product buffer.
 */
bool block_is_shared_scene_matrix(const upstream::ShaderVariantStageBlock& block);

/**
 * The matrices one pass renders with, carried together because a variant
 * may declare the product and either of its factors.
 *
 * They travel as one value so the three cannot come from two sources: a
 * pass that builds `view_projection` from a camera builds `view` and
 * `projection` from that same camera, which is what makes them the
 * factors of the product rather than a second answer to it. A shadow
 * caster pass is the one that cannot offer all three -- it renders
 * through the light's biased view-projection and the generator carries a
 * light-space view but no separate projection -- so it supplies what it
 * has and the packer names the factor it could not fill.
 *
 * Building them once per pass is also what keeps them off the per-draw
 * path: `view` costs the arc-rotate eye composition and `projection` a
 * tangent, and every draw in a pass would produce the same bytes.
 */
struct ShaderPassMatrices {
    const float* view_projection = nullptr;
    const std::array<float, 16>* view = nullptr;
    const std::array<float, 16>* projection = nullptr;
    const std::array<float, 16>* world = nullptr;
    const std::array<float, 16>* world_view = nullptr;
    const std::array<float, 16>* world_view_projection = nullptr;
    const std::array<float, 4>* camera_position = nullptr;
    const CameraRecord* camera = nullptr;
    double target_width = 0.0, target_height = 0.0;
    bool shadow_camera_facade = false;
};

/**
 * One shader draw's own matrix lanes, derived once and consumed
 * identically by both backends' draw loops and the render capture: the
 * mesh block's world (`_shaderWorldMatrix`), the world-view-projection
 * product, and the world-view product when the pass carries a view. The record owns the
 * storage the patched ShaderPassMatrices points into, so keep it alive
 * through the block writes made against `apply`'s result.
 */
struct ShaderDrawMatrices {
    std::array<float, 16> world{};
    std::array<float, 16> world_view_projection{};
    std::optional<std::array<float, 16>> world_view;

    ShaderDrawMatrices(const Scene& scene, const Engine& engine, const MeshRecord& mesh,
                       const ShaderPassMatrices& pass) {
        // Public-cache draws compute these only inside the source packet's gate.
        if constexpr (!upstream::public_camera_matrix_caches) {
            world = mesh_block_world(scene, engine, mesh);
            world_view_projection = upstream::matrix_product(pass.view_projection, world);
            world_view = shader_world_view(pass.view, world);
        }
    }

    /** The pass matrices with this draw's three lanes patched in. */
    [[nodiscard]] ShaderPassMatrices apply(const ShaderPassMatrices& pass) const {
        if constexpr (upstream::public_camera_matrix_caches) {
            return pass;
        } else {
            ShaderPassMatrices patched = pass;
            patched.world = &world;
            patched.world_view = world_view ? &*world_view : nullptr;
            patched.world_view_projection = &world_view_projection;
            return patched;
        }
    }
};

/** Camera position in the same absolute/eye-relative frame as shader world. */
std::array<float, 4> shader_camera_position(const Scene& scene, const Engine& engine,
                                            const CameraRecord& camera);

/**
 * One camera pass's matrices -- the effective aspect, the view-projection,
 * its two factors and the eye -- built from one camera so a pass cannot mix
 * two sources. A pass without a camera keeps the zeros of the scene block
 * the pin never writes for it (see `scene_camera`).
 */
struct CameraPassMatrices {
    double aspect = 0.0;
    std::array<float, 16> view_projection{};
    std::array<float, 16> live_view_projection{};
    std::array<float, 16> view{};
    std::array<float, 16> projection{};
    std::array<float, 4> camera_position{};
    const CameraRecord* camera = nullptr;
    double target_width = 0.0, target_height = 0.0;

    /** The pass matrices a shader draw reads, pointing into this record. */
    [[nodiscard]] ShaderPassMatrices pass() const {
        ShaderPassMatrices matrices{upstream::public_camera_matrix_caches
                                        ? live_view_projection.data()
                                        : view_projection.data(),
                                    &view, &projection};
        matrices.camera_position = &camera_position;
        matrices.camera = camera;
        matrices.target_width = target_width;
        matrices.target_height = target_height;
        return matrices;
    }
};

ShaderPassMatrices shader_packet_system_matrices(const ShaderPacketSystemOwner& owner,
                                                 const Scene& scene, const Engine& engine,
                                                 const MeshRecord& mesh,
                                                 const MaterialRecord& material,
                                                 const ShaderPassMatrices& current);
ShaderPassMatrices shader_packet_published_matrices(const ShaderPacketSystemOwner& owner,
                                                    const ShaderPassMatrices& current);
#if BBLITE_THIN_INSTANCES
inline GpuHandle synchronize_thin_binding(Engine& engine, ThinMaterialBinding& binding,
                                          double index_count, bool has_color) {
    return sync_thin_instance_for_draw(engine, thin_instance_data(binding.pool), has_color,
                                       ThinInstanceGeometry{index_count, {}},
                                       source_gpu_device(engine));
}

template <class Row, class BindBuffers>
void publish_thin_binding(const ThinMaterialBinding& binding, Row& row, BindBuffers bind_buffers) {
    row.thin_pool = binding.pool;
    row.thin_draw_args = binding.draw_args;
    row.indirect_args = nullptr;
    if (binding.pool && binding.pool->gpu_buffer)
        bind_buffers(row, binding.draw_args);
}

template <class Row, class BindBuffers>
void synchronize_node_thin_draw(Engine& engine, const upstream::RenderItem& item, Row& row,
                                BindBuffers bind_buffers) {
    if (!item.thin_binding)
        throw std::runtime_error("Node binding has no source thin-instance owner.");
    auto& binding = *item.thin_binding;
    const auto& mesh = handle_at(engine.meshes, item.mesh);
    upstream::sync_node_thin_binding_for_draw(
        false, static_cast<bool>(mesh.visible), upstream::render_item_material_draws(item, engine),
        static_cast<bool>(mesh.thin_instances), binding.node_requires_instances, binding.draw_args,
        [&](bool has_color) {
            binding.pool = mesh.thin_instances;
            return synchronize_thin_binding(engine, binding, static_cast<double>(row.index_count),
                                            has_color);
        });
    publish_thin_binding(binding, row, bind_buffers);
}
#endif

template <class Rows, class BindBuffers>
void update_material_bindings(const Scene& scene, Engine& engine,
                              const upstream::RenderDrawList& bindings,
                              const ShaderPassMatrices& pass, Rows& rows,
                              [[maybe_unused]] BindBuffers bind_buffers) {
    for (const auto& binding : bindings.binding_updates) {
        const auto& item = binding.item;
        const auto& material = handle_at(engine.materials, item.material);
        const auto update_custom = [&] {
            if (material.shader_uniform_snapshot)
                material.shader_uniform_snapshot(material);
        };
        const auto update_system = [&] {
            if constexpr (upstream::public_camera_matrix_caches) {
                const auto& mesh = handle_at(engine.meshes, item.mesh);
                shader_packet_system_matrices(item.shader_packet, scene, engine, mesh, material,
                                              pass);
            }
        };
#if BBLITE_THIN_INSTANCES
        auto& row = rows.at(binding.item_index);
        const auto& mesh = handle_at(engine.meshes, item.mesh);
        if (!item.thin_binding)
            throw std::runtime_error("Material binding has no source thin-instance owner.");
        auto& state = *item.thin_binding;
        if (item.material_kind != upstream::RenderMaterialKind::shader || state.pool) {
            upstream::update_thin_binding(
                item.material_kind, false, static_cast<bool>(mesh.visible),
                upstream::render_item_material_draws(item, engine),
                static_cast<bool>(mesh.thin_instances), state.mesh_features, state.shader_has_color,
                state.node_requires_instances, state.draw_args, update_custom, update_system,
                [&](bool has_color) {
                    if (item.material_kind != upstream::RenderMaterialKind::shader)
                        state.pool = handle_at(engine.meshes, item.mesh).thin_instances;
                    return synchronize_thin_binding(
                        engine, state, static_cast<double>(row.index_count), has_color);
                });
            publish_thin_binding(state, row, bind_buffers);
            continue;
        }
        publish_thin_binding(state, row, bind_buffers);
#else
        static_cast<void>(rows);
#endif
        if (item.material_kind == upstream::RenderMaterialKind::shader)
            upstream::update_shader_binding(
                item.bucket == upstream::RenderBucket::alpha_blend, false,
                upstream::render_item_material_draws(item, engine), update_custom, update_system);
    }
}

/**
 * `camera`'s pass over a `width` x `height` extent. The aspect is the
 * pinned `getEffectiveAspectRatio`, a division of two JavaScript numbers
 * that reaches the projection writers in double: a camera carrying a
 * viewport scales the extent's ratio by the viewport's own. The projection
 * is the pin's `getProjectionMatrix`, the arm that branches on the camera,
 * rather than the perspective writer the skybox takes.
 */
CameraPassMatrices camera_pass_matrices(const Scene& scene, const Engine& engine,
                                        const CameraRecord* camera, double width, double height,
                                        bool defer_projection_reads = false);

/**
 * One custom-shader stage block: declared system matrices followed by the
 * reflected gathers from the material's flat value storage. These exact
 * floats feed SDL pushes, Dawn buffer writes and render capture.
 *
 * Filled into a caller-owned scratch rather than a returned vector so the
 * per-draw walks in all three consumers reuse one allocation; `assign`
 * zero-fills every element, so the bytes match a freshly sized vector's.
 */
void shader_stage_block_floats(const upstream::ShaderVariantStageBlock& block,
                               const ShaderPassMatrices& pass, const MaterialRecord& material,
                               std::vector<float>& floats);
#endif

} // namespace bbl::pal
