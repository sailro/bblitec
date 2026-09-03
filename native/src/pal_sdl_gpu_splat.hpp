#pragma once

// The Gaussian-splat pass on SDL_GPU.
//
// The mirror of `pal_dawn_splat.hpp`; read that file for what the pass is and
// which pinned decisions it folds. Only the resource plumbing differs, and it
// differs in the two ways this backend always differs:
//
//   * The uniform block is PUSHED per stage rather than bound as a buffer, at
//     the register the compaction pass left it in. `splat.vert.slots` is the
//     authority (`b0 u`, `s0 e`, `t0` upward), never the pin's own group numbers.
//   * The data textures -- four float payloads, plus one uint texture per
//     SH payload for a cloud carrying harmonics -- bind to the VERTEX stage,
//     because that is
//     where the pin samples them — the fragment stage reads only varyings and
//     binds nothing at all.

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
#include <tuple>
#include <utility>
#include <vector>

#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

/**
 * The data textures the vertex stage samples: the pin's RGBA32F payloads,
 * then one RGBA32UINT spherical-harmonic payload per texture the SH layout
 * appends after them. Zero of the latter is the stock module, and then this
 * is the four it always was.
 *
 * The float half is the size of the generated `splat_texture_payloads`
 * array rather than a four typed here, so it is the pin's own bind-group
 * order that decides -- the same declaration both backends upload from.
 */

/** One cloud's GPU state. */
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

struct SplatPass {
    SplatMeshHandle mesh{};
    std::uint32_t vertex_count = 0;

    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUBuffer* quad = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUBuffer* order = nullptr;
    std::array<SDL_GPUTextureSamplerBinding, splat_texture_count> textures{};
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
    /**
     * The cloud's world, composed once per frame by `upload_splat_pass`
     * and read back by `record_splat_pass` -- the same single composition
     * the Dawn upload makes for both its sort gate and its UBO write. A
     * cache on the pass rather than on the record, because the record
     * deliberately carries none (`SplatMeshRecord` re-derives live), and
     * refreshed unconditionally each upload rather than version-gated,
     * because the record carries no transform version to gate on. The
     * frame loop uploads every pass before any pass records, so the draw
     * always reads this frame's composition.
     */
    std::array<float, 16> world{};
};

inline SplatPass create_splat_pass(
    SDL_GPUDevice* device,
    // Mutable because pass creation CONSUMES the cloud's staging bytes:
    // it uploads the SH payloads and then releases them, which is the
    // same reach boundary the neighbouring `rows` field draws.
    Engine& engine,
    SplatMeshHandle handle,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count) {
    SplatMeshRecord& record = engine.splat_meshes[handle.value];
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
    // The fragment stage samples nothing: every data texture is read
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
#if BBLITE_SPLAT_SH
    // The harmonics, at the same texel grid and the same sampler pair the
    // four above take: the stage `textureLoad`s them, so no filtering
    // happens and SDL's texture/sampler pairing is satisfied by the one
    // point sampler already created -- the shape `pal_sdl_gpu_clustered.hpp`
    // takes for its own unsigned data textures.
    if (record.sh_textures.size() != upstream::splat_sh_texture_count) {
        gpu_error("splat record carries the wrong SH payload count");
    }
    for (std::size_t slot = 0; slot < record.sh_textures.size(); ++slot) {
        SDL_GPUTextureSamplerBinding& binding =
            pass.textures[payloads.size() + slot];
        binding.texture = upload_2d_texture(
            device,
            record.sh_textures[slot].data(),
            record.sh_textures[slot].size(),
            record.texture_width,
            record.texture_height,
            SDL_GPU_TEXTUREFORMAT_R32G32B32A32_UINT,
            "splat harmonics");
        binding.sampler = pass.sampler;
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

    // Composed once here for both the sort gate and the draw's uniforms,
    // exactly as the Dawn upload composes it once for both.
    pass.world = upstream::build_splat_world(record);
    if (!upstream::splat_sort_dirty(
            pass.world,
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
    // `getCameraPosition` is the camera world matrix's own translation, in
    // absolute space -- which is what the shared helper returns, because a
    // floating-origin scene reaching a splat refuses at generation.
    [[maybe_unused]] const std::array<float, 4>& camera_position,
    double width,
    double height) {
    if (pass.vertex_count == 0) return;
    const SplatMeshRecord& record = engine.splat_meshes[pass.mesh.value];
    SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline);

    upstream::SplatUniforms uniforms;
    upstream::write_splat_uniforms(
        uniforms,
        // This frame's composition, stashed by `upload_splat_pass` above.
        pass.world,
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
    SDL_PushGPUVertexUniformData(
        command,
        static_cast<Uint32>(pass.uniform_slot),
        &uniforms,
        sizeof(uniforms));
    push_stage_uniform(
        command, pass.fragment_uniform_slot, &uniforms, sizeof(uniforms));

    SDL_GPUBufferBinding vertex_bindings[2]{};
    vertex_bindings[0].buffer = pass.quad;
    vertex_bindings[1].buffer = pass.order;
    SDL_BindGPUVertexBuffers(render_pass, 0, vertex_bindings, 2);

    SDL_GPUBufferBinding index_binding{};
    index_binding.buffer = pass.indices;
    SDL_BindGPUIndexBuffer(
        render_pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);

    // Bound to the VERTEX stage: the pin samples every data texture
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
