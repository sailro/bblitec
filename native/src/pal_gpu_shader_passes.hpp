// A pass's matrices as a shader material reads them: the camera pass
// matrices, the per-draw products and the stage block gather.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <array>
#include <optional>
#include <vector>
#include "pal_gpu_surface.hpp"
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#endif

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
    std::array<float, 16> world;
    std::array<float, 16> world_view_projection;
    std::optional<std::array<float, 16>> world_view;

    ShaderDrawMatrices(const Scene& scene, const Engine& engine, const MeshRecord& mesh,
                       const ShaderPassMatrices& pass)
        : world(mesh_block_world(scene, engine, mesh)),
          world_view_projection(upstream::matrix_product(pass.view_projection, world)),
          world_view(shader_world_view(pass.view, world)) {}

    /** The pass matrices with this draw's three lanes patched in. */
    [[nodiscard]] ShaderPassMatrices apply(const ShaderPassMatrices& pass) const {
        ShaderPassMatrices patched = pass;
        patched.world = &world;
        patched.world_view = world_view ? &*world_view : nullptr;
        patched.world_view_projection = &world_view_projection;
        return patched;
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
    std::array<float, 16> view{};
    std::array<float, 16> projection{};
    std::array<float, 4> camera_position{};

    /** The pass matrices a shader draw reads, pointing into this record. */
    [[nodiscard]] ShaderPassMatrices pass() const {
        ShaderPassMatrices matrices{view_projection.data(), &view, &projection};
        matrices.camera_position = &camera_position;
        return matrices;
    }
};

/**
 * `camera`'s pass over a `width` x `height` extent. The aspect is the
 * pinned `getEffectiveAspectRatio`, a division of two JavaScript numbers
 * that reaches the projection writers in double: a camera carrying a
 * viewport scales the extent's ratio by the viewport's own. The projection
 * is the pin's `getProjectionMatrix`, the arm that branches on the camera,
 * rather than the perspective writer the skybox takes.
 */
CameraPassMatrices camera_pass_matrices(const Scene& scene, const Engine& engine,
                                        const CameraRecord* camera, double width, double height);

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
