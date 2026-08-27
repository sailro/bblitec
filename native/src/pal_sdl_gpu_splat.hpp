#pragma once

// The Gaussian-splat pass on SDL_GPU.
//
// The mirror of `pal_dawn_splat.hpp`; read that file for what the pass is and
// which pinned decisions it folds. Only the resource plumbing differs, and it
// differs in the two ways this backend always differs:
//
//   * The uniform block is PUSHED per stage rather than bound as a buffer, at
//     the register the compaction pass left it in. `splat.vert.slots` is the
//     authority (`b0 u`, `s0 e`, `t0..t3`), never the pin's own group numbers.
//   * The four data textures are bound to the VERTEX stage, because that is
//     where the pin samples them — the fragment stage reads only varyings and
//     binds nothing at all.

#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_depth_state.hpp>
#include <bblite/upstream/splat_geometry.hpp>
#include <bblite/upstream/splat_sort.hpp>

#include <array>
// std::abs on a float in the re-sort gate. Without this only the integer
// overloads may be visible, and the delta would truncate to int -- the cloud
// would silently stop re-sorting.
#include <cmath>
#include <cstdint>
#include <vector>

#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

/** One cloud's GPU state. */
struct SplatPass {
    SplatMeshHandle mesh{};
    std::uint32_t vertex_count = 0;

    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUBuffer* quad = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUBuffer* order = nullptr;
    std::array<SDL_GPUTextureSamplerBinding, 4> textures{};
    SDL_GPUSampler* sampler = nullptr;

    /** The register `splat.vert.slots` left the uniform block in. */
    int uniform_slot = -1;
    /**
     * The same, for the fragment stage: a `GsShaderFragment` plugin may
     * read the pin's own UBO -- its layout declares binding 0 for both
     * stages -- and the stock fragment reads nothing at all, so the
     * sidecar is what says whether the block survived compilation.
     */
    int fragment_uniform_slot = -1;

    upstream::SplatSortScratch scratch;
    std::vector<std::uint32_t> cpu_order;
    std::vector<float> order_floats;
    std::array<float, 4> depth_transform{};
};

inline SplatPass create_splat_pass(
    SDL_GPUDevice* device,
    const Engine& engine,
    SplatMeshHandle handle,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count) {
    const SplatMeshRecord& record = engine.splat_meshes[handle.value];
    SplatPass pass;
    pass.mesh = handle;
    pass.vertex_count = record.vertex_count;

    const PinnedStageSlots slots = read_pinned_stage_slots("splat.vert");
    pass.uniform_slot = stage_uniform_slot(slots, "u");
    if (pass.uniform_slot < 0) {
        gpu_error("splat.vert kept no uniform block for the splat UBO");
    }
    SDL_GPUShader* vertex_shader = load_shader(
        device,
        "splat.vert",
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<std::uint32_t>(slots.textures.size()),
        static_cast<std::uint32_t>(slots.uniforms.size()),
        "vs");
    // The fragment stage samples nothing: the four data textures are read
    // in the vertex stage. Whether it declares the uniform block depends on
    // the scene -- the stock density is `exp(-dot(vq, vq)) * vc.a` over the
    // varyings alone, while a depth plugin reads the projection out of the
    // block -- so the sidecar decides, exactly as it does for a custom
    // sprite fragment.
    const PinnedStageSlots fragment_slots =
        read_pinned_stage_slots("splat.frag");
    pass.fragment_uniform_slot = stage_uniform_slot(fragment_slots, "u");
    if (!fragment_slots.textures.empty()) {
        gpu_error(
            "splat.frag kept a texture binding; the splat fragment stage "
            "binds none");
    }
    SDL_GPUShader* fragment_shader = load_shader(
        device,
        "splat.frag",
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        0,
        static_cast<std::uint32_t>(fragment_slots.uniforms.size()),
        "fs");

    SDL_GPUVertexAttribute attributes[2]{};
    attributes[0] = SDL_GPUVertexAttribute{
        0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 0};
    attributes[1] = SDL_GPUVertexAttribute{
        1, 1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT, 0};
    SDL_GPUVertexBufferDescription buffers[2]{};
    buffers[0].slot = 0;
    buffers[0].pitch = 8;
    buffers[0].input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    buffers[1].slot = 1;
    buffers[1].pitch = 4;
    buffers[1].input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
    buffers[1].instance_step_rate = 0;

    // BJS GS material uses ALPHA_COMBINE, which is exactly the shared
    // `transparent_blend` tuple; only this API's enum residue is local.
    SDL_GPUColorTargetDescription target{};
    target.format = target_format;
    target.blend_state = blend_state_from(transparent_blend);

    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    info.vertex_input_state.vertex_buffer_descriptions = buffers;
    info.vertex_input_state.num_vertex_buffers = 2;
    info.vertex_input_state.vertex_attributes = attributes;
    info.vertex_input_state.num_vertex_attributes = 2;
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    // A splat's quad is expanded around the projected covariance axes, so it
    // has no consistent winding to cull against.
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.depth_stencil_state.compare_op =
        gpu_depth_compare(upstream::pinned_depth_compare);
    info.depth_stencil_state.enable_depth_test = true;
    // Depth writes off: the sorted draw order is the composite.
    info.depth_stencil_state.enable_depth_write = false;
    info.multisample_state.sample_count = sample_count;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    info.target_info.depth_stencil_format = depth_format;
    info.target_info.has_depth_stencil_target = true;
    pass.pipeline = SDL_CreateGPUGraphicsPipeline(device, &info);
    if (!pass.pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline splat");
    SDL_ReleaseGPUShader(device, vertex_shader);
    SDL_ReleaseGPUShader(device, fragment_shader);

    // The pin's own quad and indices, emitted as data from
    // gaussian-splatting-mesh.ts: the [-2, 2] half-extent is the domain
    // of the fragment's `exp(-dot(k, k))` kernel, so it travels from the
    // pin rather than being re-typed here.
    pass.quad = upload_buffer(
        device,
        SDL_GPU_BUFFERUSAGE_VERTEX,
        upstream::splat_quad_vertices.data(),
        upstream::splat_quad_vertices.size() * sizeof(float));
    pass.indices = upload_buffer(
        device,
        SDL_GPU_BUFFERUSAGE_INDEX,
        upstream::splat_quad_indices.data(),
        upstream::splat_quad_indices.size() * sizeof(std::uint16_t));

    SDL_GPUBufferCreateInfo order_info{};
    order_info.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
    order_info.size =
        static_cast<Uint32>(record.vertex_count * sizeof(float));
    pass.order = SDL_CreateGPUBuffer(device, &order_info);
    if (!pass.order) gpu_error("SDL_CreateGPUBuffer splat order");

    // The pin's nearest/clamp data sampler, emitted as data beside the
    // quad: a point fetch at level 0, so nothing here filters.
    pass.sampler =
        create_texture_sampler(device, upstream::splat_data_sampler);

    // The payload order {centers, cov_a, cov_b, colors} is the pin's,
    // published by the generated splat unit both backends consume.
    const auto payloads = upstream::splat_texture_payloads(record);
    for (std::size_t slot = 0; slot < payloads.size(); ++slot) {
        pass.textures[slot].texture = upload_2d_texture(
            device,
            payloads[slot]->data(),
            payloads[slot]->size() * sizeof(float),
            record.texture_width,
            record.texture_height,
            SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT,
            "splat data");
        pass.textures[slot].sampler = pass.sampler;
    }

    pass.scratch = upstream::create_splat_sort_scratch(
        static_cast<double>(record.vertex_count));
    pass.cpu_order.assign(record.vertex_count, 0u);
    pass.order_floats.assign(record.vertex_count, 0.0f);
    return pass;
}

/**
 * The pin's `update` hook: sort when the view-depth kernel drifted past the
 * epsilon, then upload the order. The UBO is pushed at record time on this
 * backend, so only the order lands here.
 */
inline void upload_splat_pass(
    SDL_GPUDevice* device,
    const Engine& engine,
    SplatPass& pass,
    const std::array<float, 16>& view) {
    const SplatMeshRecord& record = engine.splat_meshes[pass.mesh.value];

    if (!upstream::splat_sort_dirty(
            upstream::build_splat_world(record),
            view,
            pass.depth_transform)) {
        return;
    }
    upstream::sort_splats_back_to_front(
        record.positions,
        static_cast<double>(record.vertex_count),
        pass.depth_transform,
        pass.cpu_order,
        pass.scratch);
    // The stage reads the index as a float attribute, which is what the
    // pin's own `Float32Array` order buffer gives it.
    for (std::size_t i = 0; i < pass.cpu_order.size(); ++i) {
        pass.order_floats[i] = static_cast<float>(pass.cpu_order[i]);
    }
    update_buffer(
        device,
        pass.order,
        pass.order_floats.data(),
        pass.order_floats.size() * sizeof(float));
}

/** Records the splat draw into a pass the scene renderer already began. */
inline void record_splat_pass(
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* render_pass,
    const Engine& engine,
    const SplatPass& pass,
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    double width,
    double height) {
    if (pass.vertex_count == 0) return;
    const SplatMeshRecord& record = engine.splat_meshes[pass.mesh.value];
    SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline);

    upstream::SplatUniforms uniforms;
    upstream::write_splat_uniforms(
        uniforms,
        upstream::build_splat_world(record),
        view,
        projection,
        width,
        height,
        record.texture_width,
        record.texture_height);
    SDL_PushGPUVertexUniformData(
        command,
        static_cast<Uint32>(pass.uniform_slot),
        &uniforms,
        sizeof(uniforms));
    if (pass.fragment_uniform_slot >= 0) {
        SDL_PushGPUFragmentUniformData(
            command,
            static_cast<Uint32>(pass.fragment_uniform_slot),
            &uniforms,
            sizeof(uniforms));
    }

    SDL_GPUBufferBinding vertex_bindings[2]{};
    vertex_bindings[0].buffer = pass.quad;
    vertex_bindings[1].buffer = pass.order;
    SDL_BindGPUVertexBuffers(render_pass, 0, vertex_bindings, 2);

    SDL_GPUBufferBinding index_binding{};
    index_binding.buffer = pass.indices;
    SDL_BindGPUIndexBuffer(
        render_pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);

    // Bound to the VERTEX stage: the pin samples the four data textures
    // there and the fragment stage reads none of them.
    SDL_BindGPUVertexSamplers(
        render_pass,
        0,
        pass.textures.data(),
        static_cast<Uint32>(pass.textures.size()));

    SDL_DrawGPUIndexedPrimitives(
        render_pass,
        static_cast<Uint32>(upstream::splat_quad_indices.size()),
        pass.vertex_count,
        0,
        0,
        0);
}

inline void release_splat_pass(SDL_GPUDevice* device, SplatPass& pass) {
    for (SDL_GPUTextureSamplerBinding& binding : pass.textures) {
        if (binding.texture) SDL_ReleaseGPUTexture(device, binding.texture);
        binding.texture = nullptr;
        binding.sampler = nullptr;
    }
    if (pass.sampler) SDL_ReleaseGPUSampler(device, pass.sampler);
    if (pass.order) SDL_ReleaseGPUBuffer(device, pass.order);
    if (pass.indices) SDL_ReleaseGPUBuffer(device, pass.indices);
    if (pass.quad) SDL_ReleaseGPUBuffer(device, pass.quad);
    if (pass.pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(device, pass.pipeline);
    }
    pass.sampler = nullptr;
    pass.order = nullptr;
    pass.indices = nullptr;
    pass.quad = nullptr;
    pass.pipeline = nullptr;
}

} // namespace bbl::pal
