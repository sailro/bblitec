// A pass's matrices as a shader material reads them: the camera pass
// matrices, the per-draw products and the stage block gather.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include "pal_gpu_pipeline.hpp"

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
inline bool block_is_shared_scene_matrix(const upstream::ShaderVariantStageBlock& block) {
    if (block.system_matrices.size() != 1 || !block.gather.empty()) {
        return false;
    }
    switch (block.system_matrices.front()) {
    case upstream::ShaderSystemMatrix::view_projection:
        return true;
    case upstream::ShaderSystemMatrix::world:
    case upstream::ShaderSystemMatrix::world_view:
    case upstream::ShaderSystemMatrix::world_view_projection:
    case upstream::ShaderSystemMatrix::view:
    case upstream::ShaderSystemMatrix::projection:
    case upstream::ShaderSystemMatrix::camera_position:
        return false;
    }
    return false;
}

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
inline std::array<float, 4> shader_camera_position(const Scene& scene, const Engine& engine,
                                                   const CameraRecord& camera) {
    const Vec3d eye = upstream::arc_rotate_eye_position(camera);
#if BBLITE_FLOATING_ORIGIN
    const Vec3d origin = floating_origin_offset(scene, engine);
    return {static_cast<float>(eye.x - origin.x), static_cast<float>(eye.y - origin.y),
            static_cast<float>(eye.z - origin.z), 0.0f};
#else
    (void)scene;
    (void)engine;
    return {static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), 0.0f};
#endif
}

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
inline CameraPassMatrices camera_pass_matrices(const Scene& scene, const Engine& engine,
                                               const CameraRecord* camera, double width,
                                               double height) {
    CameraPassMatrices matrices;
    if (!camera)
        return matrices;
    matrices.aspect = upstream::effective_aspect_ratio(*camera, width, height);
    matrices.view_projection = upstream::build_view_projection(*camera, matrices.aspect);
    matrices.view = upstream::build_view_matrix(upstream::camera_world_matrix(*camera));
    matrices.projection = upstream::build_scene_projection(*camera, matrices.aspect);
    matrices.camera_position = shader_camera_position(scene, engine, *camera);
    return matrices;
}

/**
 * One custom-shader stage block: declared system matrices followed by the
 * reflected gathers from the material's flat value storage. These exact
 * floats feed SDL pushes, Dawn buffer writes and render capture.
 *
 * Filled into a caller-owned scratch rather than a returned vector so the
 * per-draw walks in all three consumers reuse one allocation; `assign`
 * zero-fills every element, so the bytes match a freshly sized vector's.
 */
inline void shader_stage_block_floats(const upstream::ShaderVariantStageBlock& block,
                                      const ShaderPassMatrices& pass,
                                      const MaterialRecord& material, std::vector<float>& floats) {
    // The world a pass without a mesh (a full-screen shader) reads.
    static constexpr std::array<float, 16> identity{
        1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f,
    };
    floats.assign(block.float_size, 0.0f);
    std::size_t head = 0;
    const auto copy_from = [&](const float* source, std::size_t count, const char* name) {
        if (!source) {
            throw std::runtime_error(std::string("A shader material declares the '") + name +
                                     "' system uniform in a pass that renders with no such "
                                     "matrix.");
        }
        std::copy_n(source, count, floats.begin() + head);
    };
    for (const upstream::ShaderSystemMatrix matrix : block.system_matrices) {
        // No default arm: a new enumerator has to be given a source here
        // rather than silently inheriting one.
        switch (matrix) {
        case upstream::ShaderSystemMatrix::world:
            copy_from(pass.world ? pass.world->data() : identity.data(), 16, "world");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::world_view:
            copy_from(pass.world_view ? pass.world_view->data() : nullptr, 16, "worldView");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::view:
            copy_from(pass.view ? pass.view->data() : nullptr, 16, "view");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::projection:
            copy_from(pass.projection ? pass.projection->data() : nullptr, 16, "projection");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::view_projection:
            copy_from(pass.view_projection, 16, "viewProjection");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::world_view_projection:
            copy_from(pass.world_view_projection ? pass.world_view_projection->data()
                                                 : pass.view_projection,
                      16, "worldViewProjection");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::camera_position:
            copy_from(pass.camera_position ? pass.camera_position->data() : nullptr, 3,
                      "cameraPosition");
            // vec3 uniform members consume one 16-byte slot.
            head += 4;
            break;
        }
    }
    for (const std::array<std::uint32_t, 3>& gather : block.gather) {
        for (std::uint32_t index = 0; index < gather[2]; ++index) {
            floats[gather[0] + index] = material.shader_uniform_values[gather[1] + index];
        }
    }
}
#endif

} // namespace bbl::pal
