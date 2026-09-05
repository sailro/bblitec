#pragma once

// GPU picking on SDL_GPU.
//
// The pin renders the whole candidate set into a ONE-PIXEL target through a
// view projection sheared so the sampled point lands on that pixel
// (`computePickVP` in `picking/gpu-picker.ts`), writes each candidate's id
// as a colour and its clip-space depth to a second attachment, and reads
// both back. Nothing here casts a ray, which is the reason a Gaussian cloud
// picks at all: it has no triangles to intersect, and its own pass draws
// the same splats it draws for the frame with the pick colour substituted.
//
// Two contracts are this port's rather than the pin's, and both come from
// where the world transform lives:
//
//   * an ordinary mesh's vertices are baked to WORLD space here
//     (`transformed_vertices`), while the pin keeps them local and multiplies
//     by `mesh.worldMatrix` in the pick vertex stage. So the mesh block
//     carries the IDENTITY for a baked mesh -- the same positions reach the
//     shader either way. A thin-instanced or floating-origin mesh keeps
//     local vertices precisely because its transform travels as a matrix,
//     and neither is composed with picking by any reached scene, so both
//     refuse rather than picking the wrong geometry.
//   * the position stream is the renderer's interleaved `GpuVertex` buffer
//     read at its own stride rather than a second position-only upload. The
//     pin binds `gpu.positionBuffer`; these are the same numbers at a
//     different pitch.

#include <bblite/runtime.hpp>

#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_shared.hpp"
#if BBLITE_HAS_BILLBOARDS
#include <bblite/upstream/billboard_system.hpp>
// billboard_attribute_format: one translation of the pinned float
// count, shared with the visible billboard pass.
#include "pal_sdl_gpu_billboard.hpp"
#endif

#include <SDL3/SDL_gpu.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {

/**
 * The one-pixel target set, plus the staging buffer both attachments are
 * copied into. Built on the first pick and released with the renderer, as
 * the pin builds them on first use and releases them in `disposePicker`.
 */
struct PickTargets {
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* depth_color = nullptr;
#if BBLITE_HAS_DETAILED_PICKING
    /** The pin's `pick-detail`: 1x1 rgba32uint, made with the pair above
     *  because the detailed pipeline is the only one this build draws. */
    SDL_GPUTexture* detail = nullptr;
#endif
    SDL_GPUTexture* depth = nullptr;
    SDL_GPUTransferBuffer* staging = nullptr;
};

inline void release_pick_targets(
    SDL_GPUDevice* device,
    PickTargets& targets) {
    if (targets.color) SDL_ReleaseGPUTexture(device, targets.color);
    if (targets.depth_color) {
        SDL_ReleaseGPUTexture(device, targets.depth_color);
    }
#if BBLITE_HAS_DETAILED_PICKING
    if (targets.detail) SDL_ReleaseGPUTexture(device, targets.detail);
#endif
    if (targets.depth) SDL_ReleaseGPUTexture(device, targets.depth);
    if (targets.staging) {
        SDL_ReleaseGPUTransferBuffer(device, targets.staging);
    }
    targets = PickTargets{};
}

/** One 1x1 attachment. */
inline SDL_GPUTexture* create_pick_attachment(
    SDL_GPUDevice* device,
    SDL_GPUTextureFormat format,
    SDL_GPUTextureUsageFlags usage,
    const char* label) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = 1;
    info.height = 1;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (!texture) {
        gpu_error(
            (std::string("SDL_CreateGPUTexture ") + label).c_str());
    }
    return texture;
}

inline void ensure_pick_targets(
    SDL_GPUDevice* device,
    PickTargets& targets) {
    if (targets.color) return;
    targets.color = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET,
        "pick-color");
    targets.depth_color = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_R32_FLOAT,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET,
        "pick-depth-color");
#if BBLITE_HAS_DETAILED_PICKING
    targets.detail = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_R32G32B32A32_UINT,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET,
        "pick-detail");
#endif
    targets.depth = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_D24_UNORM,
        SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET,
        "pick-depth");
    // 256-aligned rows: the encoded id, then the r32float clip depth used
    // by the pin to reconstruct `PickingInfo.pickedPoint`, and -- where
    // the detailed pipeline draws -- the packed primitive index and
    // interpolated position.
    SDL_GPUTransferBufferCreateInfo transfer{};
    transfer.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer.size = static_cast<Uint32>(pick_staging_bytes);
    targets.staging = SDL_CreateGPUTransferBuffer(device, &transfer);
    if (!targets.staging) {
        gpu_error("SDL_CreateGPUTransferBuffer pick");
    }
}

#if BBLITE_HAS_BILLBOARDS
/**
 * The billboard pick contributor, on SDL_GPU.
 *
 * The pin registers one `PickSource` per billboard system when the system
 * is added to the scene, and the picker -- which names no entity type --
 * walks that list after its own mesh draws and lets each source's module
 * draw into the SAME one-pixel pass against the SAME depth buffer. So a
 * billboard behind a mesh loses the pick, and a nearer billboard beats a
 * further one, with no sort and no CPU intersection.
 *
 * Three things are this contributor's rather than the mesh pass's:
 *
 *   * it draws the system's instance data in LOGICAL order, so
 *     `pickId - baseId` is the sprite's own slot. The visible pass uploads
 *     the same rows sorted back to front, which is why this owns a second
 *     buffer instead of borrowing `BillboardPass::instances`.
 *   * its vertex stage reproduces the render shader's quad expansion term
 *     for term, around a camera basis it cannot read from the pick scene
 *     block -- that carries only the sheared view projection. The basis
 *     travels in the per-system block instead, packed by the pin's own
 *     `packBillboardPickUbo`.
 *   * one system owns `count` consecutive ids, where a mesh owns one.
 *
 * A hidden or empty system still consumes its range without drawing, as
 * the pin's contributor does, so ids stay positional.
 */
class BillboardPickContributor {
public:
    BillboardPickContributor() = default;
    BillboardPickContributor(const BillboardPickContributor&) = delete;
    BillboardPickContributor& operator=(
        const BillboardPickContributor&) = delete;
    ~BillboardPickContributor() { release(); }

    /**
     * Buffers, uploads and pipelines, before the pick command buffer
     * exists: `update_buffer` submits one of its own, which is the same
     * reason the frame loop uploads its billboard instances before
     * acquiring the frame's, and a pipeline built inside an open pass
     * would put a shader load and a PSO compile there. Ids are not
     * assigned here -- they follow the meshes and the clouds, which the
     * picker counts inside its own pass.
     */
    void prepare(
        SDL_GPUDevice* device,
        const Engine& engine,
        const Scene& scene) {
        if (device_ && device_ != device) release();
        device_ = device;
        systems_.resize(scene.billboard_systems.size());
        bool any = false;
        for (std::size_t index = 0;
             index < scene.billboard_systems.size();
             ++index) {
            const BillboardSystemRecord& system =
                engine.billboard_systems[
                    scene.billboard_systems[index].value];
            if (!billboard_pick_draws(system)) continue;
            any = true;
            ensure_pipeline(system.orientation);
            SystemResources& resources = systems_[index];
            if (system.capacity > resources.capacity) {
                if (resources.instances) {
                    SDL_ReleaseGPUBuffer(device_, resources.instances);
                }
                resources.capacity = system.capacity;
                SDL_GPUBufferCreateInfo info{};
                info.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
                info.size = static_cast<Uint32>(
                    static_cast<std::size_t>(resources.capacity) *
                    upstream::billboard_instance_stride_bytes);
                resources.instances = SDL_CreateGPUBuffer(device_, &info);
                if (!resources.instances) {
                    gpu_error("SDL_CreateGPUBuffer billboard-pick");
                }
                resources.uploaded = SystemUpload{};
            }
            // The system's own rows, in LOGICAL order: `pickId - baseId`
            // is the sprite's slot, which the visible pass's back-to-front
            // upload could not answer. Gated where the visible pass gates
            // its own and for the reason stated there -- `update_buffer`
            // acquires and SUBMITS a command buffer, so re-uploading an
            // unchanged buffer is the one real cost in a repeated pick.
            // The pin needs no gate because `writeBuffer` is a staged copy
            // with no submit. This upload depends on the view not at all,
            // so what the system holds is the whole stamp.
            const SystemUpload wanted{
                system.count, system.instance_version};
            if (resources.uploaded == wanted) continue;
            resources.uploaded = wanted;
            update_buffer(
                device_,
                resources.instances,
                system.instance_data.data(),
                static_cast<std::size_t>(system.count) *
                    upstream::billboard_instance_stride_bytes);
        }
        if (any && !indices_) {
            indices_ = upload_buffer(
                device_,
                SDL_GPU_BUFFERUSAGE_INDEX,
                upstream::billboard_index_data.data(),
                upstream::billboard_index_data.size() *
                    sizeof(std::uint16_t));
        }
    }

    /**
     * The contributor's `draw`: the shared collector assigns one id range
     * per system after every earlier candidate, and the draws go into the
     * pass the picker already opened.
     */
    void record(
        SDL_GPUCommandBuffer* command,
        SDL_GPURenderPass* pass,
        const Engine& engine,
        const Scene& scene,
        const std::array<float, 16>& view,
        const PickSceneUniforms& scene_uniforms,
        std::vector<PickRange>& ranges,
        std::uint32_t& next_id) {
        const std::vector<PickBillboardCandidate> candidates =
            collect_pick_billboard_candidates(
                engine, scene, ranges, next_id);
        bool scene_pushed = false;
        for (const PickBillboardCandidate& candidate : candidates) {
            const Pipeline& pipeline =
                ensure_pipeline(candidate.orientation);
            SDL_BindGPUGraphicsPipeline(pass, pipeline.pipeline);
            if (!scene_pushed) {
                // Loop-invariant, as the mesh pass's own push is: both
                // orientations come out of one composed module, so they
                // resolve `scene` to the same slot, and pushed uniform
                // state persists across draws.
                SDL_PushGPUVertexUniformData(
                    command,
                    static_cast<Uint32>(pipeline.scene_slot),
                    &scene_uniforms,
                    sizeof(scene_uniforms));
                scene_pushed = true;
            }
            const BillboardPickUniforms uniforms =
                build_billboard_pick_uniforms(
                    view, candidate.base_id, 0.0f, candidate.axis);
            SDL_PushGPUVertexUniformData(
                command,
                static_cast<Uint32>(pipeline.system_slot),
                &uniforms,
                sizeof(uniforms));
            SDL_GPUBufferBinding instance_binding{};
            instance_binding.buffer =
                systems_[candidate.system_index].instances;
            SDL_BindGPUVertexBuffers(pass, 0, &instance_binding, 1);
            SDL_GPUBufferBinding index_binding{};
            index_binding.buffer = indices_;
            SDL_BindGPUIndexBuffer(
                pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);
            SDL_DrawGPUIndexedPrimitives(
                pass,
                static_cast<Uint32>(
                    upstream::billboard_index_data.size()),
                candidate.count,
                0,
                0,
                0);
        }
    }

private:
    /** What the pick instance buffer already holds, so a repeated
     *  pick of an unchanged system submits no copy. */
    struct SystemUpload {
        std::uint32_t count = 0;
        std::uint64_t instance_version = 0;
        bool operator==(const SystemUpload&) const = default;
    };
    struct SystemResources {
        SDL_GPUBuffer* instances = nullptr;
        std::uint32_t capacity = 0;
        SystemUpload uploaded{};
    };
    struct Pipeline {
        SDL_GPUGraphicsPipeline* pipeline = nullptr;
        int scene_slot = -1;
        int system_slot = -1;
    };

    /**
     * One pipeline per orientation, built on first use.
     *
     * The pin keys its own cache by `orientation|cutout|detailed` because
     * those are the three arms its shader builder forks on; the reached
     * slice composes only the first, so the key is the orientation and the
     * module beside it is the stage the same builder wrote.
     */
    const Pipeline& ensure_pipeline(BillboardOrientation orientation) {
        const std::size_t slot =
            orientation == BillboardOrientation::axis_locked ? 1u : 0u;
        Pipeline& pipeline = pipelines_[slot];
        if (pipeline.pipeline) return pipeline;
        const char* vertex_stem = billboard_pick_vertex_stem(orientation);
        const char* fragment_stem = billboard_pick_fragment_stem();
        const PinnedStageSlots vertex_slots =
            read_pinned_stage_slots(vertex_stem);
        const PinnedStageSlots fragment_slots =
            read_pinned_stage_slots(fragment_stem);
        pipeline.scene_slot = stage_uniform_slot(vertex_slots, "scene");
        pipeline.system_slot = stage_uniform_slot(vertex_slots, "bb");
        // Both in one message, as the mesh picker refuses its own pair:
        // the composed stage projects through `scene` and takes its id
        // base out of `bb`, so a stage that kept either one cannot draw.
        if (pipeline.scene_slot < 0 || pipeline.system_slot < 0) {
            gpu_error(
                "picking-billboard.vert kept neither the scene nor the "
                "per-system block");
        }
        auto vertex = load_shader(
            device_,
            vertex_stem,
            SDL_GPU_SHADERSTAGE_VERTEX,
            0,
            static_cast<std::uint32_t>(vertex_slots.uniforms.size()),
            "vs");
        auto fragment = load_shader(
            device_,
            fragment_stem,
            SDL_GPU_SHADERSTAGE_FRAGMENT,
            static_cast<std::uint32_t>(fragment_slots.textures.size()),
            static_cast<std::uint32_t>(fragment_slots.uniforms.size()),
            "fs");

        // The pin's own six instance attributes, read out of the table the
        // billboard lowerer generated from the RENDER pipeline's offsets --
        // which is what the pick module's own copy of them must equal. The
        // colour lane at location 6 is the visible stage's alone; the pick
        // fragment writes an id.
        std::array<SDL_GPUVertexAttribute, billboard_pick_attributes>
            attributes{};
        for (std::size_t index = 0; index < attributes.size(); ++index) {
            const upstream::BillboardInstanceAttribute& row =
                upstream::billboard_instance_attributes[index];
            attributes[index] = SDL_GPUVertexAttribute{
                row.shader_location,
                0,
                billboard_attribute_format(row.float_count),
                row.byte_offset};
        }
        SDL_GPUVertexBufferDescription instance_buffer{};
        instance_buffer.slot = 0;
        instance_buffer.pitch = upstream::billboard_instance_stride_bytes;
        instance_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;

        SDL_GPUColorTargetDescription color_targets[2]{};
        color_targets[0].format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        color_targets[1].format = SDL_GPU_TEXTUREFORMAT_R32_FLOAT;

        SDL_GPUGraphicsPipelineCreateInfo info{};
        info.vertex_shader = vertex.get();
        info.fragment_shader = fragment.get();
        info.vertex_input_state.vertex_buffer_descriptions =
            &instance_buffer;
        info.vertex_input_state.num_vertex_buffers = 1;
        info.vertex_input_state.vertex_attributes = attributes.data();
        info.vertex_input_state.num_vertex_attributes =
            static_cast<Uint32>(attributes.size());
        info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
        // The pin's own pick depth state, which is the MESH picker's and
        // not the visible billboard pass's: test and WRITE under reverse-Z
        // `greater`, so a billboard occludes the pick as well as losing
        // to one. The transparent pass writes no depth precisely because
        // its draw order is the composite; a pick has no composite.
        info.depth_stencil_state.enable_depth_test = true;
        info.depth_stencil_state.enable_depth_write = true;
        info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_GREATER;
        info.target_info.color_target_descriptions = color_targets;
        info.target_info.num_color_targets = 2;
        info.target_info.depth_stencil_format =
            SDL_GPU_TEXTUREFORMAT_D24_UNORM;
        info.target_info.has_depth_stencil_target = true;
        pipeline.pipeline =
            SDL_CreateGPUGraphicsPipeline(device_, &info);
        if (!pipeline.pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline picking-billboard");
        }
        return pipeline;
    }

    void release() {
        if (!device_) return;
        for (SystemResources& resources : systems_) {
            if (resources.instances) {
                SDL_ReleaseGPUBuffer(device_, resources.instances);
            }
            resources = SystemResources{};
        }
        systems_.clear();
        if (indices_) SDL_ReleaseGPUBuffer(device_, indices_);
        indices_ = nullptr;
        for (Pipeline& pipeline : pipelines_) {
            if (pipeline.pipeline) {
                SDL_ReleaseGPUGraphicsPipeline(
                    device_, pipeline.pipeline);
            }
            pipeline = Pipeline{};
        }
        device_ = nullptr;
    }

    SDL_GPUDevice* device_ = nullptr;
    SDL_GPUBuffer* indices_ = nullptr;
    std::array<Pipeline, 2> pipelines_{};
    std::vector<SystemResources> systems_;
};
#endif

} // namespace bbl::pal
