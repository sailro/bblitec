// The pin's per-pass and per-mesh blocks, built once for both backends:
// the scene block, the billboard group, the lights array, the mesh blocks
// and the geometry task's parameters and velocity history.
#pragma once
#include <bblite/features/external_renderables.hpp>
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_pbr_renderer.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <array>
#include <cstdint>
#include <vector>
#include "pal_gpu_variants.hpp"
#include "pal_gpu_velocity.hpp"
#if BBLITE_EXTERNAL_RENDERABLES
#include <bblite/gpu_renderable.hpp>
#include "pal_gpu_common.hpp"
#endif
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#endif

namespace bbl::pal {

/**
 * The pin's `gpUniforms` block, declared by a geometry-output variant whose
 * attachments include NORMALIZED_VIEW_DEPTH or LINEAR_VELOCITY
 * (`pbr-geometry-output-shader.ts` createPbrGeometryParamsFragment):
 * the task's previous-frame view-projection and the camera's near/far.
 * Unguarded because the geometry encode names it in both backends whatever
 * the variant count.
 */
struct PinnedGeometryParams {
    std::array<float, 16> previousViewProjection{};
    std::array<float, 4> cameraNearFar{};
};

#if BBLITE_PINNED_MATERIALS || BBLITE_HAS_BILLBOARDS
/**
 * The pin's per-pass scene block.
 *
 * Every member is the one the pin's own declaration names; the fragment reads
 * its view direction from `vEyePosition` and its reflection path from `view`,
 * both from the camera the pass renders with. Shared, because the block is the
 * pin's rather than either backend's: Dawn uploads it to a buffer and SDL_GPU
 * pushes it at a uniform slot, and neither should decide what is in it.
 */
upstream::SceneUniforms pinned_scene_block(const Scene& scene, const Engine& engine,
                                           const CameraRecord& camera,
                                           const std::array<float, 16>& view_projection);
#endif

#if BBLITE_HAS_BILLBOARDS
/**
 * The scene block a billboard program binds at its group 0: the pin's
 * block for the pass, over the view projection and view the pass draws
 * billboards with. A pass without a camera writes none and keeps what its
 * block last held (`pal::write_billboard_scene_block`).
 */
upstream::SceneUniforms billboard_scene_block(const Scene& scene, const Engine& engine,
                                              const CameraRecord& camera,
                                              const std::array<float, 16>& view_projection,
                                              const std::array<float, 16>& view);
#endif

#if BBLITE_EXTERNAL_RENDERABLES
class ExternalRenderablePass;
/**
 * The engine's scene layout rows (`Engine::webgpu_scene_uniform_bindings`):
 * the pin's `getSceneBindGroupLayout` rows its composed shaders declare, set
 * before the engine's WebGPU device makes the layout. A build without
 * composed materials sets none.
 */
void configure_engine_scene_layout(Engine& engine);
struct RetainedSceneBlock;
/**
 * render-task-base.ts before a pass begins, for the scene's external
 * renderables: bound for the pass's target (`ExternalRenderablePass::follow`),
 * group 0 written from the scene block the pass retains, which this frame
 * already wrote (`write_pass_scene_block`, kept as it was by a camera-less
 * pass), and the scene's lights (`refreshTaskSceneBindGroup`), then updated
 * into the frame encoder `encoder` opens. Returns the pass when it has
 * bindings to draw; null otherwise, without opening an encoder.
 */
const ExternalRenderablePass* prepare_external_pass(ExternalRenderablePass& pass, Engine& engine,
                                                    const Scene& scene,
                                                    const GpuRenderTargetSignature& signature,
                                                    const RetainedSceneBlock& retained,
                                                    const GpuDrawUpdateContext& context,
                                                    FunctionRef<GpuCommandEncoderHandle()> encoder);
#endif

#if BBLITE_PINNED_MATERIALS
/**
 * The pin's per-pass lights block: a u32 count, three words of padding, then
 * MAX_LIGHTS entries.
 *
 * `fillLightsData` writes that count through a Float32Array view of the same
 * buffer, so it lands in the first four bytes. Returned as bytes because that is
 * what both a buffer upload and a uniform push take.
 */
std::vector<std::uint8_t> pinned_lights_block(const Scene& scene, const Engine& engine);

// The pin's per-draw mesh block.
//
// `writeMeshLightSelection` decides its shape: the world matrix, the count of
// lights affecting this mesh, then their indices. Which lights those are comes
// from the generated `light_affects_mesh`, lowered from the pin's own
// `affectsMesh`, so this walks exactly the set the Standard slot writer walks.
/**
 * The pin's own per-mesh light selection (`writeMeshLightSelection`).
 *
 * Shared because the mesh block is not one struct: the material families
 * declare `MeshUniforms` and a node graph declares its own `MeshU` with a
 * shadow lane between the world matrix and the count. What they agree on is
 * this walk, so it is written once over whichever block's lanes.
 */
template <typename Block>
inline void pinned_mesh_light_selection(const Scene& scene, const Engine& engine, MeshHandle mesh,
                                        Block& block) {
    if constexpr (requires {
                      block.li;
                      block.lc;
                  }) {
        std::uint32_t count = 0;
        std::uint32_t light_index = 0;
        for (const LightHandle handle : scene.lights) {
            if (light_index >= upstream::pinned_max_lights)
                break;
            const LightRecord* light = handle_find(engine.lights, handle);
            if (!light)
                continue;
            if (upstream::light_affects_mesh(*light, mesh)) {
                block.li[count / 4][count % 4] = light_index;
                ++count;
            }
            ++light_index;
        }
        block.lc = count;
    }
}

#if BBLITE_PINNED_MATERIAL_VARIANTS
/** The pin's mesh block, reusing a geometry task's updated world when it has velocity. */
upstream::MeshUniforms pinned_mesh_block(const Scene& scene, const Engine& engine, MeshHandle mesh,
                                         const PinnedVelocityHistory* velocity_history = nullptr);

#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's per-draw mesh block (`node-renderable.ts`).
 *
 * The pin packs the mesh's world matrix, `receiveShadows ? 1 : 0` in the
 * shadow lane, and the same light selection every family uses.
 *
 * The shadow lane is a VALUE here where it is a composition key for the
 * other two families: `node-shadow.ts` mixes each light's factor by it
 * (`mix(1.0, _sf[i], meshU.receivesShadow.x)`), so one composed module
 * draws a receiving mesh and a non-receiving one alike.
 */
upstream::NodeMeshUniforms node_mesh_block(const Scene& scene, const Engine& engine,
                                           MeshHandle mesh);
#endif
#endif

} // namespace bbl::pal
