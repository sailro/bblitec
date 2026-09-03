#pragma once

// GPU picking on Dawn. The contract is stated once in
// `pal_sdl_gpu_picking.hpp`; what differs here is only the API layer, and
// the two facts WebGPU adds:
//
//   * the pin's groups map natively, so the mesh pass declares group 0 for
//     the scene block and group 1 for the per-candidate block, and the
//     cloud pass declares the pin's own three. SDL_GPU reaches the same
//     bindings through the `.slots` sidecar because its stages went through
//     a register remap; nothing here does.
//   * a readback is a mapped buffer rather than a fenced download, so the
//     pick waits on `wgpuBufferMapAsync` where SDL waits on a fence.
//
// The per-candidate block is rewritten between draws, which WebGPU forbids
// inside a pass: every candidate therefore owns its own slice of one
// uniform buffer, bound at a dynamic offset the pass advances. SDL_GPU
// pushes the same bytes per draw and needs no such buffer.

#include <bblite/runtime.hpp>

#include "pal_dawn_shared.hpp"
#include "pal_gpu_shared.hpp"
#if BBLITE_HAS_BILLBOARDS
// dawn_billboard_format: one translation of the pinned float count,
// shared with the visible billboard pass.
#include "pal_dawn_billboard.hpp"
#endif

#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace bbl::pal {

/**
 * The pin's `MeshUniforms` at WebGPU's 256-byte dynamic-offset alignment,
 * so one buffer can carry every candidate's block.
 *
 * The scene block needs no twin: `PickSceneUniforms` in
 * `pal_gpu_shared.hpp` is the pin's own layout and both backends upload it
 * unchanged. Only this one differs, and only in its stride -- which the
 * language computes from `alignas` rather than a hand-counted tail, so a
 * field added here cannot silently move it.
 */
struct alignas(256) DawnPickMeshUniforms {
    std::array<float, 16> world{};
    std::uint32_t pick_id = 0;
};
static_assert(
    sizeof(DawnPickMeshUniforms) == 256,
    "a pick candidate's block is one dynamic-offset stride");

/** The one-pixel target set and the buffer its id and depth are mapped from. */
struct DawnPickTargets {
    WGPUTexture color = nullptr;
    WGPUTextureView color_view = nullptr;
    WGPUTexture depth_color = nullptr;
    WGPUTextureView depth_color_view = nullptr;
#if BBLITE_HAS_DETAILED_PICKING
    /** The pin's `pick-detail`: 1x1 rgba32uint carrying the winning
     *  primitive index and the interpolated rest position. */
    WGPUTexture detail = nullptr;
    WGPUTextureView detail_view = nullptr;
#endif
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    WGPUBuffer staging = nullptr;
};

inline void release_dawn_pick_targets(DawnPickTargets& targets) {
    for (WGPUTextureView* view :
         {&targets.color_view,
          &targets.depth_color_view,
#if BBLITE_HAS_DETAILED_PICKING
          &targets.detail_view,
#endif
          &targets.depth_view}) {
        if (*view) wgpuTextureViewRelease(*view);
        *view = nullptr;
    }
    for (WGPUTexture* texture :
         {&targets.color,
          &targets.depth_color,
#if BBLITE_HAS_DETAILED_PICKING
          &targets.detail,
#endif
          &targets.depth}) {
        if (*texture) wgpuTextureRelease(*texture);
        *texture = nullptr;
    }
    if (targets.staging) wgpuBufferRelease(targets.staging);
    targets.staging = nullptr;
}

inline void ensure_dawn_pick_targets(
    WGPUDevice device,
    DawnPickTargets& targets) {
    if (targets.color) return;
    const auto attachment =
        [&](WGPUTextureFormat format,
            WGPUTextureUsage extra) -> WGPUTexture {
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.dimension = WGPUTextureDimension_2D;
        descriptor.format = format;
        descriptor.usage = WGPUTextureUsage_RenderAttachment | extra;
        descriptor.size = WGPUExtent3D{1, 1, 1};
        WGPUTexture texture = wgpuDeviceCreateTexture(device, &descriptor);
        if (!texture) dawn_error("pick attachment");
        return texture;
    };
    const auto view = [](WGPUTexture texture) -> WGPUTextureView {
        WGPUTextureViewDescriptor descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        WGPUTextureView created =
            wgpuTextureCreateView(texture, &descriptor);
        if (!created) dawn_error("pick attachment view");
        return created;
    };
    targets.color = attachment(
        WGPUTextureFormat_RGBA8Unorm, WGPUTextureUsage_CopySrc);
    targets.color_view = view(targets.color);
    targets.depth_color = attachment(
        WGPUTextureFormat_R32Float, WGPUTextureUsage_CopySrc);
    targets.depth_color_view = view(targets.depth_color);
#if BBLITE_HAS_DETAILED_PICKING
    targets.detail = attachment(
        WGPUTextureFormat_RGBA32Uint, WGPUTextureUsage_CopySrc);
    targets.detail_view = view(targets.detail);
#endif
    targets.depth =
        attachment(WGPUTextureFormat_Depth24Plus, WGPUTextureUsage_None);
    targets.depth_view = view(targets.depth);

    WGPUBufferDescriptor staging = WGPU_BUFFER_DESCRIPTOR_INIT;
    staging.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    // Three 256-aligned rows where the detailed pipeline draws, two
    // otherwise. The map below asks for the same size, and a mismatch
    // truncates silently rather than failing.
    staging.size = pick_staging_bytes;
    targets.staging = wgpuDeviceCreateBuffer(device, &staging);
    if (!targets.staging) dawn_error("pick staging buffer");
}

/** The mesh pass's two groups, in the pin's own order. */
inline WGPUBindGroupLayout create_dawn_pick_scene_layout(
    WGPUDevice device) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = 0;
    entry.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entry.buffer.type = WGPUBufferBindingType_Uniform;
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = 1;
    descriptor.entries = &entry;
    WGPUBindGroupLayout layout =
        wgpuDeviceCreateBindGroupLayout(device, &descriptor);
    if (!layout) dawn_error("pick scene bind group layout");
    return layout;
}

inline WGPUBindGroupLayout create_dawn_pick_mesh_layout(
    WGPUDevice device) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = 0;
    entry.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entry.buffer.type = WGPUBufferBindingType_Uniform;
    entry.buffer.hasDynamicOffset = true;
    entry.buffer.minBindingSize = sizeof(DawnPickMeshUniforms);
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = 1;
    descriptor.entries = &entry;
    WGPUBindGroupLayout layout =
        wgpuDeviceCreateBindGroupLayout(device, &descriptor);
    if (!layout) dawn_error("pick mesh bind group layout");
    return layout;
}

/**
 * The pin's own attachment formats, shared by every pick pipeline: the id
 * and the clip depth always, and the detailed module's packed primitive
 * and rest position where this build draws one. The list is filled whole
 * and each pipeline states how many of it it binds.
 */
inline void fill_dawn_pick_targets(
    std::array<WGPUColorTargetState, pick_color_targets>& targets) {
    for (WGPUColorTargetState& target : targets) {
        target = WGPU_COLOR_TARGET_STATE_INIT;
        target.writeMask = WGPUColorWriteMask_All;
    }
    targets[0].format = WGPUTextureFormat_RGBA8Unorm;
    targets[1].format = WGPUTextureFormat_R32Float;
#if BBLITE_HAS_DETAILED_PICKING
    targets[2].format = WGPUTextureFormat_RGBA32Uint;
#endif
}

#if BBLITE_HAS_BILLBOARDS
/**
 * The billboard pick contributor on Dawn. The contract is stated once in
 * `pal_sdl_gpu_picking.hpp` and the walk that assigns its ids once in
 * `collect_pick_billboard_candidates`; what differs here is the API layer
 * and one consequence of it. WebGPU forbids a queue write between draws
 * inside a pass, so every system's 48-byte block is written -- and so the
 * id ranges those blocks carry are assigned -- BEFORE the encoder opens,
 * and `record` only binds and draws. SDL_GPU pushes the same bytes per
 * draw and assigns its ranges where it draws them.
 */
class DawnBillboardPickContributor {
public:
    DawnBillboardPickContributor() = default;
    DawnBillboardPickContributor(
        const DawnBillboardPickContributor&) = delete;
    DawnBillboardPickContributor& operator=(
        const DawnBillboardPickContributor&) = delete;
    ~DawnBillboardPickContributor() { release(); }

    /**
     * The contributor's `draw`, minus the encoder half: the shared
     * collector's id ranges, then the resources and the two uploads each
     * drawing system needs. The pipeline is built here too, so an open
     * pass never carries a WGSL parse and a PSO compile.
     */
    void prepare(
        WGPUDevice device,
        WGPUQueue queue,
        WGPUBindGroupLayout scene_layout,
        const Engine& engine,
        const Scene& scene,
        const std::array<float, 16>& view,
        std::vector<PickRange>& ranges,
        std::uint32_t& next_id) {
        if (device_ && device_ != device) release();
        device_ = device;
        queue_ = queue;
        scene_layout_ = scene_layout;
        draws_ = collect_pick_billboard_candidates(
            engine, scene, ranges, next_id);
        systems_.resize(scene.billboard_systems.size());
        for (const PickBillboardCandidate& candidate : draws_) {
            ensure_indices();
            ensure_pipeline(candidate.orientation);
            SystemResources& resources = systems_[candidate.system_index];
            const BillboardSystemRecord& system =
                engine.billboard_systems[
                    scene.billboard_systems[candidate.system_index].value];
            ensure_system(resources, system);
            // The system's own rows in LOGICAL order, so
            // `pickId - baseId` is the sprite's slot; the visible pass
            // uploads the same rows sorted back to front. Ungated as the
            // pin leaves it: `writeBuffer` is a staged copy with no
            // submit, which is the SDL twin's whole reason for a stamp.
            wgpuQueueWriteBuffer(
                queue_,
                resources.instances,
                0,
                system.instance_data.data(),
                static_cast<std::size_t>(candidate.count) *
                    upstream::billboard_instance_stride_bytes);
            const BillboardPickUniforms uniforms =
                build_billboard_pick_uniforms(
                    view, candidate.base_id, 0.0f, candidate.axis);
            wgpuQueueWriteBuffer(
                queue_,
                resources.uniforms,
                0,
                &uniforms,
                sizeof(uniforms));
        }
    }

    /** The draws, inside the pass the picker already opened. */
    void record(
        WGPURenderPassEncoder pass,
        WGPUBindGroup scene_group) {
        for (const PickBillboardCandidate& draw : draws_) {
            wgpuRenderPassEncoderSetPipeline(
                pass, ensure_pipeline(draw.orientation));
            // The pin's contributor rebinds group 0 at the start of its
            // draw, because a prior contributor may have rebound it.
            wgpuRenderPassEncoderSetBindGroup(
                pass, 0, scene_group, 0, nullptr);
            const SystemResources& resources =
                systems_[draw.system_index];
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, resources.group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, resources.instances, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                indices_,
                WGPUIndexFormat_Uint16,
                0,
                WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderDrawIndexed(
                pass,
                static_cast<std::uint32_t>(
                    upstream::billboard_index_data.size()),
                draw.count,
                0,
                0,
                0);
        }
    }

private:
    struct SystemResources {
        WGPUBuffer instances = nullptr;
        WGPUBuffer uniforms = nullptr;
        WGPUBindGroup group = nullptr;
        std::uint32_t capacity = 0;
    };
    WGPUBindGroupLayout ensure_system_layout() {
        if (system_layout_) return system_layout_;
        WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = 0;
        entry.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        entry.buffer.type = WGPUBufferBindingType_Uniform;
        entry.buffer.minBindingSize = sizeof(BillboardPickUniforms);
        WGPUBindGroupLayoutDescriptor descriptor =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = 1;
        descriptor.entries = &entry;
        system_layout_ =
            wgpuDeviceCreateBindGroupLayout(device_, &descriptor);
        if (!system_layout_) {
            dawn_error("billboard pick bind group layout");
        }
        return system_layout_;
    }

    void ensure_indices() {
        if (indices_) return;
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage =
            WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
        descriptor.size =
            sizeof(std::uint16_t) *
            upstream::billboard_index_data.size();
        indices_ = wgpuDeviceCreateBuffer(device_, &descriptor);
        if (!indices_) dawn_error("billboard pick index buffer");
        wgpuQueueWriteBuffer(
            queue_,
            indices_,
            0,
            upstream::billboard_index_data.data(),
            static_cast<std::size_t>(descriptor.size));
    }

    void ensure_system(
        SystemResources& resources,
        const BillboardSystemRecord& system) {
        if (!resources.uniforms) {
            WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            descriptor.usage =
                WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            descriptor.size = sizeof(BillboardPickUniforms);
            resources.uniforms =
                wgpuDeviceCreateBuffer(device_, &descriptor);
            if (!resources.uniforms) {
                dawn_error("billboard pick uniform buffer");
            }
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = 0;
            entry.buffer = resources.uniforms;
            entry.size = sizeof(BillboardPickUniforms);
            WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            group.layout = ensure_system_layout();
            group.entryCount = 1;
            group.entries = &entry;
            resources.group =
                wgpuDeviceCreateBindGroup(device_, &group);
            if (!resources.group) {
                dawn_error("billboard pick bind group");
            }
        }
        if (system.capacity <= resources.capacity) return;
        if (resources.instances) wgpuBufferRelease(resources.instances);
        resources.capacity = system.capacity;
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage =
            WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
        descriptor.size =
            static_cast<std::uint64_t>(resources.capacity) *
            upstream::billboard_instance_stride_bytes;
        resources.instances =
            wgpuDeviceCreateBuffer(device_, &descriptor);
        if (!resources.instances) {
            dawn_error("billboard pick instance buffer");
        }
    }

    /**
     * One pipeline per orientation, built on first use -- the pin keys its
     * own cache by `orientation|cutout|detailed`, and the reached slice
     * composes only the first arm of the other two.
     */
    WGPURenderPipeline ensure_pipeline(BillboardOrientation orientation) {
        const std::size_t slot =
            orientation == BillboardOrientation::axis_locked ? 1u : 0u;
        if (pipelines_[slot]) return pipelines_[slot];
        WGPUShaderModule vertex = load_wgsl_module(
            device_, billboard_pick_vertex_stem(orientation));
        WGPUShaderModule fragment =
            load_wgsl_module(device_, billboard_pick_fragment_stem());

        const std::array<WGPUBindGroupLayout, 2> groups{
            scene_layout_, ensure_system_layout()};
        WGPUPipelineLayoutDescriptor layout_descriptor =
            WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
        layout_descriptor.bindGroupLayoutCount = groups.size();
        layout_descriptor.bindGroupLayouts = groups.data();
        WGPUPipelineLayout pipeline_layout =
            wgpuDeviceCreatePipelineLayout(device_, &layout_descriptor);
        if (!pipeline_layout) {
            dawn_error("billboard pick pipeline layout");
        }

        std::array<WGPUVertexAttribute, billboard_pick_attributes>
            attributes{};
        for (std::size_t index = 0; index < attributes.size(); ++index) {
            const upstream::BillboardInstanceAttribute& row =
                upstream::billboard_instance_attributes[index];
            attributes[index] = WGPUVertexAttribute{
                nullptr,
                dawn_billboard_format(row.float_count),
                row.byte_offset,
                row.shader_location};
        }
        WGPUVertexBufferLayout instance_layout =
            WGPU_VERTEX_BUFFER_LAYOUT_INIT;
        instance_layout.stepMode = WGPUVertexStepMode_Instance;
        instance_layout.arrayStride =
            upstream::billboard_instance_stride_bytes;
        instance_layout.attributeCount =
            static_cast<std::uint32_t>(attributes.size());
        instance_layout.attributes = attributes.data();

        std::array<WGPUColorTargetState, pick_color_targets> targets{};
        fill_dawn_pick_targets(targets);
        WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
        fragment_state.module = fragment;
        fragment_state.entryPoint = string_view("fs");
        // A contributor draws the pin's own pair; the detailed attachment
        // belongs to the mesh module alone, and the two never compose.
        fragment_state.targetCount = 2;
        fragment_state.targets = targets.data();

        // The MESH picker's depth state, for the reason its SDL twin
        // states.
        WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
        depth.format = WGPUTextureFormat_Depth24Plus;
        depth.depthCompare = WGPUCompareFunction_Greater;
        depth.depthWriteEnabled = WGPUOptionalBool_True;

        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = pipeline_layout;
        descriptor.vertex.module = vertex;
        descriptor.vertex.entryPoint = string_view("vs");
        descriptor.vertex.bufferCount = 1;
        descriptor.vertex.buffers = &instance_layout;
        descriptor.fragment = &fragment_state;
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.cullMode = WGPUCullMode_None;
        descriptor.depthStencil = &depth;
        descriptor.multisample.count = 1;

        pipelines_[slot] =
            wgpuDeviceCreateRenderPipeline(device_, &descriptor);
        wgpuPipelineLayoutRelease(pipeline_layout);
        wgpuShaderModuleRelease(vertex);
        wgpuShaderModuleRelease(fragment);
        if (!pipelines_[slot]) {
            dawn_error("billboard pick render pipeline");
        }
        return pipelines_[slot];
    }

    void release() {
        for (SystemResources& resources : systems_) {
            if (resources.group) wgpuBindGroupRelease(resources.group);
            if (resources.uniforms) wgpuBufferRelease(resources.uniforms);
            if (resources.instances) {
                wgpuBufferRelease(resources.instances);
            }
            resources = SystemResources{};
        }
        systems_.clear();
        draws_.clear();
        if (indices_) wgpuBufferRelease(indices_);
        indices_ = nullptr;
        for (WGPURenderPipeline& pipeline : pipelines_) {
            if (pipeline) wgpuRenderPipelineRelease(pipeline);
            pipeline = nullptr;
        }
        if (system_layout_) {
            wgpuBindGroupLayoutRelease(system_layout_);
        }
        system_layout_ = nullptr;
        device_ = nullptr;
    }

    WGPUDevice device_ = nullptr;
    WGPUQueue queue_ = nullptr;
    WGPUBindGroupLayout scene_layout_ = nullptr;
    WGPUBindGroupLayout system_layout_ = nullptr;
    WGPUBuffer indices_ = nullptr;
    std::array<WGPURenderPipeline, 2> pipelines_{};
    std::vector<SystemResources> systems_;
    std::vector<PickBillboardCandidate> draws_;
};
#endif

} // namespace bbl::pal
