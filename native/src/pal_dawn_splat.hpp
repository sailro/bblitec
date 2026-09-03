#pragma once

// The Gaussian-splat pass on Dawn (WebGPU).
//
// The mirror of `pal_sdl_gpu_splat.hpp`, split from the scene renderer for
// the reason the sprite passes are: a splat cloud is its own renderable with
// its own pipeline, resources and draw, and upstream composes it into a
// frame somebody else owns (`attachGaussianSplattingMesh` pushes a
// `Renderable` onto the scene's list at `order: 200, isTransparent: true`).
//
//   `create_dawn_splat_pass`  — the resources a cloud owns for its lifetime:
//                               the four RGBA32F data textures, the unit
//                               quad, and the per-splat order buffer.
//   `upload_dawn_splat_pass`  — the pin's `update` hook: upload a fresh sort
//                               order if one is due, then the UBO the vertex
//                               stage reads.
//   `record_dawn_splat_pass`  — bind and draw into a render pass the caller
//                               opened.
//
// One adaptation, and the reason `firstSortReady` is a compile-time barrier:
// upstream posts the sort to a worker and uploads whatever order has arrived
// by the next frame, so an early frame draws in a stale order. Here the sort
// runs on the frame's own thread, before the draw that reads it. That is the
// state the pinned scene waits for, reached every frame instead of after a
// round trip. Recorded in `fidelity.json`.

#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_depth_state.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/splat_geometry.hpp>
#include <bblite/upstream/splat_sort.hpp>
#if BBLITE_SPLAT_SH
#include <bblite/upstream/splat_harmonics.hpp>
#endif

#include <array>
// std::abs on a float in the re-sort gate. Without this only the integer
// overloads may be visible, and the delta would truncate to int -- the cloud
// would silently stop re-sorting.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <tuple>
#include <utility>
#include <vector>

#include "pal_dawn_shared.hpp"
#include "pal_gpu_shared.hpp"

namespace bbl::pal {

/**
 * The data textures the vertex stage reads: the pin's RGBA32F payloads,
 * then one RGBA32UINT spherical-harmonic payload per texture the SH layout
 * appends after them. With none it is the four it always was.
 *
 * The float half is the size of the generated `splat_texture_payloads`
 * array rather than a four typed here, so it is the pin's own bind-group
 * order that decides -- the same declaration both backends upload from.
 */

/** Group 1's own entries: the UBO, the sampler, then those textures. */
/**
 * How many textures a splat draw binds, and how many of those are the
 * float payloads.
 *
 * The float half is the size of the generated `splat_texture_payloads`
 * array rather than a four typed here, so it is the pin's own bind-group
 * order that decides -- the same declaration both backends upload from.
 *
 * Stated once per backend rather than once in `pal_gpu_shared.hpp`,
 * because the generated declaration it measures has to be included
 * outside a namespace and the shared header has no such include: hoisting
 * it there put `upstream::` inside `bbl::pal` and broke every name in the
 * file. Two lines duplicated is the cheaper of the two wrongs.
 */
inline constexpr std::size_t splat_float_payload_count =
    std::tuple_size_v<decltype(upstream::splat_texture_payloads(
        std::declval<const SplatMeshRecord&>()))>;
inline constexpr std::size_t splat_texture_count =
    splat_float_payload_count +
    static_cast<std::size_t>(BBLITE_SPLAT_SH_TEXTURES);

inline constexpr std::size_t dawn_splat_first_texture_binding = 2u;
inline constexpr std::size_t dawn_splat_binding_count =
    dawn_splat_first_texture_binding + splat_texture_count;

/** One cloud's GPU state. */
struct DawnSplatPass {
    SplatMeshHandle mesh{};
    std::uint32_t vertex_count = 0;

    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroupLayout layout = nullptr;
    WGPUBindGroup group = nullptr;
    /** Group 0, declared empty so the layout's indexes line up. */
    WGPUBindGroupLayout frame_layout = nullptr;

    WGPUBuffer uniforms = nullptr;
    WGPUBuffer quad = nullptr;
    WGPUBuffer indices = nullptr;
    WGPUBuffer order = nullptr;

    std::array<WGPUTexture, splat_texture_count> textures{};
    std::array<WGPUTextureView, splat_texture_count> views{};
    WGPUSampler sampler = nullptr;

    /** The sort's own state: the scratch, the last posted transform and the
     *  order it produced. `postSplatSortIfDirty` owns the epsilon. */
    upstream::SplatSortScratch scratch;
    std::vector<std::uint32_t> cpu_order;
    /** The order as the vertex stage reads it, filled in place per sort. */
    std::vector<float> order_floats;
    std::array<float, 4> depth_transform{};
};

/**
 * One data texture, uploaded once.
 *
 * Sixteen bytes per texel either way -- four floats for a payload the stage
 * samples, four packed unsigned words for one it `textureLoad`s -- so the
 * row pitch is the same and only the format differs.
 */
inline WGPUTexture upload_dawn_splat_texture(
    WGPUDevice device,
    WGPUQueue queue,
    const void* texels,
    std::size_t byte_size,
    WGPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.format = format;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = WGPUExtent3D{width, height, 1};
    WGPUTexture texture = wgpuDeviceCreateTexture(device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture splat data");
    WGPUTexelCopyTextureInfo destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = width * 4u * 4u;
    layout.rowsPerImage = height;
    const WGPUExtent3D size{width, height, 1};
    wgpuQueueWriteTexture(
        queue, &destination, texels, byte_size, &layout, &size);
    return texture;
}

/**
 * Group 1 exactly as the pinned module declares it: the UBO, a
 * non-filtering sampler, then the four unfilterable-float data textures.
 * The stage samples them with `textureSampleLevel(..., 0.0)`, which is a
 * point fetch, so nothing here is filterable.
 *
 * A cloud carrying harmonics appends one `uint` texture per SH payload at
 * binding 6, which is what `getOrCreateShPipeline` pushes onto its own
 * layout entries. Those are `textureLoad`ed rather than sampled, so they
 * share the same point sampler and take the `uint` sample type.
 */
inline WGPUBindGroupLayout create_dawn_splat_layout(WGPUDevice device) {
    std::array<WGPUBindGroupLayoutEntry, dawn_splat_binding_count> entries{};
    for (std::size_t index = 0; index < entries.size(); ++index) {
        entries[index] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entries[index].binding = static_cast<std::uint32_t>(index);
        entries[index].visibility = WGPUShaderStage_Vertex;
    }
    entries[0].visibility =
        WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entries[0].buffer.type = WGPUBufferBindingType_Uniform;
    entries[1].sampler.type = WGPUSamplerBindingType_NonFiltering;
    for (std::size_t index = dawn_splat_first_texture_binding;
         index < entries.size();
         ++index) {
        entries[index].texture.sampleType =
            index < dawn_splat_first_texture_binding +
                        splat_float_payload_count
                ? WGPUTextureSampleType_UnfilterableFloat
                : WGPUTextureSampleType_Uint;
        entries[index].texture.viewDimension = WGPUTextureViewDimension_2D;
    }
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    WGPUBindGroupLayout layout =
        wgpuDeviceCreateBindGroupLayout(device, &descriptor);
    if (!layout) dawn_error("splat bind group layout");
    return layout;
}

/**
 * The pipeline, with the pin's own state.
 *
 * `ALPHA_COMBINE` blending, no depth write, no culling: a splat is a
 * camera-facing footprint whose coverage is the fragment's own density, so
 * it neither occludes nor is culled by winding. The depth COMPARE is this
 * renderer's one convention, which the pin also writes as `greater-equal`.
 *
 * Group 0 follows the billboard pass's convention (`pal_dawn_billboard.hpp`):
 * the module reads nothing there, so the layout is declared empty to line the
 * group indexes up and no group is ever bound to it. The pinned pipeline
 * layout names the scene layout in that slot
 * (`[getSceneBindGroupLayout(engine), meshBindGroupLayout]`), but this
 * backend has no task-owned scene group to inherit — `encode_variant_draw`
 * rebinds group 0 per draw — and a splat-only scene compiles no material
 * family and so builds no scene layout at all.
 */
inline WGPURenderPipeline create_dawn_splat_pipeline(
    WGPUDevice device,
    WGPUBindGroupLayout frame_layout,
    WGPUBindGroupLayout splat_layout,
    WGPUTextureFormat color_format,
    WGPUTextureFormat depth_format,
    std::uint32_t samples) {
    WGPUShaderModule vertex = load_wgsl_module(device, "splat.vert");
    WGPUShaderModule fragment = load_wgsl_module(device, "splat.frag");

    const std::array<WGPUBindGroupLayout, 2> groups{
        frame_layout, splat_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = groups.size();
    layout_descriptor.bindGroupLayouts = groups.data();
    WGPUPipelineLayout pipeline_layout =
        wgpuDeviceCreatePipelineLayout(device, &layout_descriptor);
    if (!pipeline_layout) dawn_error("splat pipeline layout");

    // Two streams, as the pinned descriptor declares them: the unit quad per
    // vertex, and the sorted splat index per instance.
    WGPUVertexAttribute corner{};
    corner.shaderLocation = 0;
    corner.offset = 0;
    corner.format = WGPUVertexFormat_Float32x2;
    WGPUVertexBufferLayout quad_layout{};
    quad_layout.arrayStride = 8;
    quad_layout.stepMode = WGPUVertexStepMode_Vertex;
    quad_layout.attributeCount = 1;
    quad_layout.attributes = &corner;

    WGPUVertexAttribute index{};
    index.shaderLocation = 1;
    index.offset = 0;
    index.format = WGPUVertexFormat_Float32;
    WGPUVertexBufferLayout order_layout{};
    order_layout.arrayStride = 4;
    order_layout.stepMode = WGPUVertexStepMode_Instance;
    order_layout.attributeCount = 1;
    order_layout.attributes = &index;

    const std::array<WGPUVertexBufferLayout, 2> buffers{
        quad_layout, order_layout};

    // ALPHA_COMBINE is exactly the shared `transparent_blend` tuple; only
    // this API's enum residue is local.
    const WGPUBlendState blend = blend_state_from(transparent_blend);

    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = color_format;
    target.blend = &blend;
    target.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    fragment_state.targetCount = 1;
    fragment_state.targets = &target;

    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth.format = depth_format;
    // The pin writes `greater-equal`; this renderer has one depth
    // convention and `pinned_depth_compare` is it.
    depth.depthCompare = dawn_depth_compare(upstream::pinned_depth_compare);
    depth.depthWriteEnabled = WGPUOptionalBool_False;

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = vertex;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = buffers.size();
    descriptor.vertex.buffers = buffers.data();
    descriptor.fragment = &fragment_state;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth;
    descriptor.multisample.count = samples;

    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(device, &descriptor);
    wgpuPipelineLayoutRelease(pipeline_layout);
    wgpuShaderModuleRelease(vertex);
    wgpuShaderModuleRelease(fragment);
    if (!pipeline) dawn_error("splat render pipeline");
    return pipeline;
}

/** The resources one cloud owns for its lifetime. */
inline DawnSplatPass create_dawn_splat_pass(
    WGPUDevice device,
    WGPUQueue queue,
    WGPUTextureFormat color_format,
    WGPUTextureFormat depth_format,
    std::uint32_t samples,
    // Mutable for the same reason the SDL twin is: pass creation uploads
    // the SH payloads and then releases them.
    Engine& engine,
    SplatMeshHandle handle) {
    SplatMeshRecord& record = engine.splat_meshes[handle.value];
    DawnSplatPass pass;
    pass.mesh = handle;
    pass.vertex_count = record.vertex_count;

    pass.layout = create_dawn_splat_layout(device);
    WGPUBindGroupLayoutDescriptor frame_layout =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    pass.frame_layout =
        wgpuDeviceCreateBindGroupLayout(device, &frame_layout);
    if (!pass.frame_layout) dawn_error("splat frame bind group layout");
    pass.pipeline = create_dawn_splat_pipeline(
        device,
        pass.frame_layout,
        pass.layout,
        color_format,
        depth_format,
        samples);

    // The payload order {centers, cov_a, cov_b, colors} is the pin's,
    // published by the generated splat unit both backends consume.
    const auto payloads = upstream::splat_texture_payloads(record);
    const auto view_of = [&](std::size_t slot) {
        WGPUTextureViewDescriptor view = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        pass.views[slot] =
            wgpuTextureCreateView(pass.textures[slot], &view);
        if (!pass.views[slot]) dawn_error("splat data texture view");
    };
    for (std::size_t slot = 0; slot < payloads.size(); ++slot) {
        pass.textures[slot] = upload_dawn_splat_texture(
            device,
            queue,
            payloads[slot]->data(),
            payloads[slot]->size() * sizeof(float),
            WGPUTextureFormat_RGBA32Float,
            record.texture_width,
            record.texture_height);
        view_of(slot);
    }
#if BBLITE_SPLAT_SH
    // The harmonics, at the same texel grid: `attachGaussianSplattingMeshSH`
    // writes one rgba32uint texture per sixteen coefficient bytes and binds
    // them straight after the four above.
    if (record.sh_textures.size() != upstream::splat_sh_texture_count) {
        dawn_error("splat record carries the wrong SH payload count");
    }
    for (std::size_t index = 0; index < record.sh_textures.size(); ++index) {
        const std::size_t slot = payloads.size() + index;
        pass.textures[slot] = upload_dawn_splat_texture(
            device,
            queue,
            record.sh_textures[index].data(),
            record.sh_textures[index].size(),
            WGPUTextureFormat_RGBA32Uint,
            record.texture_width,
            record.texture_height);
        view_of(slot);
    }
    // Released once the GPU owns the bytes. The neighbouring `rows` field
    // is reach-gated for the same reason and states it: these three
    // payloads are 17.9 MB for scene 124's cloud, larger than the rows,
    // and this is the only reader -- pass creation runs once. SWAPPED with
    // an empty vector rather than assigned `{}`, because assignment keeps
    // the capacity and frees nothing (measured on PR #197's reclaim).
    {
        std::vector<std::vector<std::uint8_t>> released;
        released.swap(record.sh_textures);
    }
#endif

    // The pin's nearest/clamp data sampler, emitted as data beside the
    // quad; the layout above declares the pair non-filtering.
    pass.sampler =
        create_texture_sampler(device, upstream::splat_data_sampler);

    // The pin's own quad and indices, emitted as data from
    // gaussian-splatting-mesh.ts: the [-2, 2] half-extent is the domain
    // of the fragment's `exp(-dot(k, k))` kernel, so it travels from the
    // pin rather than being re-typed here.
    const auto buffer = [&](WGPUBufferUsage usage,
                            const void* data,
                            std::uint64_t bytes) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage = usage | WGPUBufferUsage_CopyDst;
        descriptor.size = (bytes + 3ull) & ~3ull;
        WGPUBuffer created = wgpuDeviceCreateBuffer(device, &descriptor);
        if (!created) dawn_error("splat buffer");
        if (data) wgpuQueueWriteBuffer(queue, created, 0, data, bytes);
        return created;
    };
    pass.quad = buffer(
        WGPUBufferUsage_Vertex,
        upstream::splat_quad_vertices.data(),
        upstream::splat_quad_vertices.size() * sizeof(float));
    pass.indices = buffer(
        WGPUBufferUsage_Index,
        upstream::splat_quad_indices.data(),
        upstream::splat_quad_indices.size() * sizeof(std::uint16_t));
    pass.order = buffer(
        WGPUBufferUsage_Vertex,
        nullptr,
        static_cast<std::uint64_t>(record.vertex_count) * 4ull);
    pass.uniforms =
        buffer(
            WGPUBufferUsage_Uniform,
            nullptr,
            sizeof(upstream::SplatUniforms));

    std::array<WGPUBindGroupEntry, dawn_splat_binding_count> entries{};
    for (std::size_t index = 0; index < entries.size(); ++index) {
        entries[index] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[index].binding = static_cast<std::uint32_t>(index);
    }
    entries[0].buffer = pass.uniforms;
    entries[0].size = sizeof(upstream::SplatUniforms);
    entries[1].sampler = pass.sampler;
    for (std::size_t slot = 0; slot < pass.views.size(); ++slot) {
        entries[slot + dawn_splat_first_texture_binding].textureView =
            pass.views[slot];
    }
    WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    group.layout = pass.layout;
    group.entryCount = entries.size();
    group.entries = entries.data();
    pass.group = wgpuDeviceCreateBindGroup(device, &group);
    if (!pass.group) dawn_error("splat bind group");

    pass.scratch = upstream::create_splat_sort_scratch(
        static_cast<double>(record.vertex_count));
    pass.cpu_order.assign(record.vertex_count, 0u);
    pass.order_floats.assign(record.vertex_count, 0.0f);
    return pass;
}

/**
 * The pin's `update` hook, in its own order: sort if the kernel drifted,
 * upload the order, then the UBO.
 *
 * `postSplatSortIfDirty` builds the four-coefficient affine kernel from row
 * 2 of `view * world` and re-sorts only when a coefficient moved past the
 * epsilon; the first frame always sorts, because the pin's stored transform
 * starts at zero and a cloud in front of the camera cannot be.
 */
inline void upload_dawn_splat_pass(
    WGPUQueue queue,
    const Engine& engine,
    DawnSplatPass& pass,
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    // `getCameraPosition` is the camera world matrix's own translation, in
    // absolute space -- which is what the shared helper returns, because a
    // floating-origin scene reaching a splat refuses at generation.
    [[maybe_unused]] const std::array<float, 4>& camera_position,
    double width,
    double height) {
    const SplatMeshRecord& record = engine.splat_meshes[pass.mesh.value];
    const std::array<float, 16> world = upstream::build_splat_world(record);

    if (upstream::splat_sort_dirty(world, view, pass.depth_transform)) {
        upstream::sort_splats_back_to_front(
            record.positions,
            static_cast<double>(record.vertex_count),
            pass.depth_transform,
            pass.cpu_order,
            pass.scratch);
        // The stage reads the index as a float attribute, which is what the
        // pin's `Float32Array` order buffer gives it. Filled in place: a
        // fresh vector here would allocate and zero 1.3 MB per re-sort, and
        // a re-sort happens on every frame the camera moves.
        for (std::size_t i = 0; i < pass.cpu_order.size(); ++i) {
            pass.order_floats[i] = static_cast<float>(pass.cpu_order[i]);
        }
        wgpuQueueWriteBuffer(
            queue,
            pass.order,
            0,
            pass.order_floats.data(),
            pass.order_floats.size() * sizeof(float));
    }

    upstream::SplatUniforms uniforms;
    upstream::write_splat_uniforms(
        uniforms,
        world,
        view,
        projection,
        width,
        height,
        record.texture_width,
        record.texture_height
#if BBLITE_SPLAT_SH
        ,
        camera_position
#endif
    );
    wgpuQueueWriteBuffer(
        queue, pass.uniforms, 0, &uniforms, sizeof(uniforms));
}

/** Binds and draws into a pass the caller opened. */
inline void record_dawn_splat_pass(
    WGPURenderPassEncoder encoder,
    const DawnSplatPass& pass) {
    if (pass.vertex_count == 0) return;
    wgpuRenderPassEncoderSetPipeline(encoder, pass.pipeline);
    wgpuRenderPassEncoderSetBindGroup(encoder, 1, pass.group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(
        encoder, 0, pass.quad, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetVertexBuffer(
        encoder, 1, pass.order, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(
        encoder,
        pass.indices,
        WGPUIndexFormat_Uint16,
        0,
        WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(
        encoder,
        static_cast<std::uint32_t>(upstream::splat_quad_indices.size()),
        pass.vertex_count,
        0,
        0,
        0);
}

inline void release_dawn_splat_pass(DawnSplatPass& pass) {
    if (pass.frame_layout) wgpuBindGroupLayoutRelease(pass.frame_layout);
    pass.frame_layout = nullptr;
    if (pass.group) wgpuBindGroupRelease(pass.group);
    if (pass.layout) wgpuBindGroupLayoutRelease(pass.layout);
    if (pass.pipeline) wgpuRenderPipelineRelease(pass.pipeline);
    if (pass.sampler) wgpuSamplerRelease(pass.sampler);
    for (WGPUTextureView& view : pass.views) {
        if (view) wgpuTextureViewRelease(view);
        view = nullptr;
    }
    for (WGPUTexture& texture : pass.textures) {
        if (texture) wgpuTextureRelease(texture);
        texture = nullptr;
    }
    for (WGPUBuffer* buffer :
         {&pass.uniforms, &pass.quad, &pass.indices, &pass.order}) {
        if (*buffer) wgpuBufferRelease(*buffer);
        *buffer = nullptr;
    }
    pass.group = nullptr;
    pass.layout = nullptr;
    pass.pipeline = nullptr;
    pass.sampler = nullptr;
}

} // namespace bbl::pal
