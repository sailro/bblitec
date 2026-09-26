// SDL_GPU post-process and screen-space passes. Dawn's twin is
// pal_dawn_scene_post_process.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_targets.hpp"
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_POST_PROCESS

std::size_t post_process_program(GpuState& state, std::uint32_t module_index,
                                 SDL_GPUTextureFormat format, SDL_GPUSampleCount samples,
                                 std::uint32_t alpha_mode) {
    return find_or_create_program(
        state.post_process_programs,
        [&](const GpuPostProcessProgram& program) {
            return program.module_index == module_index && program.format == format &&
                   program.samples == samples && program.alpha_mode == alpha_mode;
        },
        [&] {
            return build_sdl_gpu_post_process_program(state.device, module_index, format, samples,
                                                      alpha_mode);
        });
}

void write_sdl_gpu_post_process_uniforms(GpuState& state, Engine& engine, TaskHandle handle,
                                         std::size_t index, std::uint32_t width,
                                         std::uint32_t height) {
    PostProcessPassOptions& pass = handle_at(engine.frame_tasks, handle).post_process.passes[index];
    auto& uniforms = handle_at(state.post_process_tasks, handle)[index].uniform_data;
    if (uniforms.empty())
        return;
    const PostProcessExtent extent =
        resolve_post_process_extent(handle_at(engine.render_targets, pass.output_target),
                                    state.render_targets, pass, width, height);
    std::fill(uniforms.begin(), uniforms.end(), 0.0f);
    upstream::write_post_process_uniforms(engine, pass, extent.output_width, extent.output_height,
                                          extent.source_width, extent.source_height,
                                          uniforms.data());
}

void encode_post_process_pass(GpuState& state, SDL_GPUCommandBuffer* command,
                              const PreparedSdlPostProcessPass& prepared,
                              SDL_GPUTexture*& capture_texture) {
    // Repeated executions bind one persistent uniform buffer in the pin.
    // Resolve its final bytes by task/child identity at submission encoding.
    const auto& uniforms =
        handle_at(state.post_process_tasks, prepared.task)[prepared.child].uniform_data;
    if (!uniforms.empty()) {
        const Uint32 bytes = static_cast<Uint32>(uniforms.size() * sizeof(float));
        if (prepared.vertex_uniforms)
            SdlGpuWriteDevice{}.write_vertex_uniform(command, 0, uniforms.data(), bytes);
        if (prepared.fragment_uniforms)
            SdlGpuWriteDevice{}.write_fragment_uniform(command, 0, uniforms.data(), bytes);
    }
    SdlRenderPass post_pass{SDL_BeginGPURenderPass(command, &prepared.target, 1, nullptr)};
    SDL_BindGPUGraphicsPipeline(post_pass, prepared.pipeline);
    if (prepared.has_viewport) {
        SDL_SetGPUViewport(post_pass, &prepared.viewport);
        SDL_SetGPUScissor(post_pass, &prepared.scissor);
    }
    if (prepared.texture_count != 0) {
        SDL_BindGPUFragmentSamplers(post_pass, 0, prepared.textures.data(), prepared.texture_count);
    }
    count_gpu_draw(SDL_DrawGPUPrimitives, post_pass, 3, 1, 0, 0);
    post_pass.end();
    if (prepared.presents) {
        SdlRenderPass present_pass{
            SDL_BeginGPURenderPass(command, &prepared.present_target, 1, nullptr)};
        SDL_BindGPUGraphicsPipeline(present_pass, state.blit_pipeline);
        const SDL_GPUTextureSamplerBinding present_binding{
            state.post_process_present,
            state.background_sampler,
        };
        SDL_BindGPUFragmentSamplers(present_pass, 0, &present_binding, 1);
        count_gpu_draw(SDL_DrawGPUPrimitives, present_pass, 3, 1, 0, 0);
        present_pass.end();
        capture_texture = state.post_process_present;
    }
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_SCREEN_SPACE
GpuScreenSpaceProgram build_screen_space_program(GpuState& state, std::uint32_t stage) {
    const upstream::ScreenSpaceShaderInfo& info = upstream::screen_space_shader_infos.at(stage);
    GpuScreenSpaceProgram program;
    program.stage = stage;
    const std::string vertex_name = std::string(info.stem) + ".vert";
    const std::string fragment_name = std::string(info.stem) + ".frag";
    program.vertex_slots = read_pinned_stage_slots(vertex_name);
    program.fragment_slots = read_pinned_stage_slots(fragment_name);
    auto vertex_shader =
        load_shader(state.device, vertex_name, SDL_GPU_SHADERSTAGE_VERTEX, program.vertex_slots);
    auto fragment_shader = load_shader(state.device, fragment_name, SDL_GPU_SHADERSTAGE_FRAGMENT,
                                       program.fragment_slots);
    // The pin builds each stage against its own single-sample target
    // format with no blend and a triangle list (`ensureProducerPipeline`).
    SDL_GPUColorTargetDescription target{};
    target.format = texture_format(info.target_format);
    SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
    pipeline_info.vertex_shader = vertex_shader.get();
    pipeline_info.fragment_shader = fragment_shader.get();
    pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    pipeline_info.target_info.color_target_descriptions = &target;
    pipeline_info.target_info.num_color_targets = 1;
    program.pipeline = OwnedSdlPipeline{
        create_sdl_gpu_graphics_pipeline(state.device, vertex_shader, &pipeline_info),
        {state.device}};
    if (!program.pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline screen-space");
    }
    // The sidecar names the fragment textures the compaction kept, in slot
    // order; each is matched to the pin's own binding once here, so the
    // frame path indexes roles rather than comparing names.
    if (program.fragment_slots.textures.size() > max_post_process_textures) {
        throw std::runtime_error("A screen-space stage exceeds 8 textures.");
    }
    for (const std::string& name : program.fragment_slots.textures) {
        const upstream::ScreenSpaceStageBinding* declared = nullptr;
        for (std::size_t index = 0; index < info.binding_count; ++index) {
            if (name == info.bindings[index].name) {
                declared = &info.bindings[index];
                break;
            }
        }
        if (!declared) {
            throw std::runtime_error("Screen-space stage declares a texture the pin did not "
                                     "bind: " +
                                     name);
        }
        program.fragment_roles.push_back(declared->role);
    }
    return program;
}

std::size_t screen_space_program(GpuState& state, std::uint32_t stage) {
    return find_or_create_program(
        state.screen_space_programs,
        [&](const GpuScreenSpaceProgram& program) { return program.stage == stage; },
        [&] { return build_screen_space_program(state, stage); });
}

SDL_GPUTexture* screen_space_binding_texture(GpuState& state, const ScreenSpaceTaskOptions& task,
                                             upstream::ScreenSpaceTextureRole role) {
    switch (role) {
    case upstream::ScreenSpaceTextureRole::depth:
        return handle_at(state.render_targets, task.depth).depth;
    case upstream::ScreenSpaceTextureRole::source_color:
        return handle_at(state.render_targets, task.source).sampled_color;
    case upstream::ScreenSpaceTextureRole::raw:
        return handle_at(state.render_targets, task.raw).sampled_color;
    case upstream::ScreenSpaceTextureRole::history:
        return handle_at(state.render_targets, task.history).sampled_color;
    default:
        throw std::runtime_error("A screen-space stage binds a texture role this backend "
                                 "does not serve.");
    }
}

SDL_GPURenderPass* begin_screen_space_pass(SDL_GPUCommandBuffer* command, SDL_GPUTexture* target) {
    SDL_GPUColorTargetInfo color{};
    color.texture = target;
    color.load_op = SDL_GPU_LOADOP_CLEAR;
    color.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    color.store_op = SDL_GPU_STOREOP_STORE;
    return SDL_BeginGPURenderPass(command, &color, 1, nullptr);
}

void record_screen_space_stage(GpuState& state, const ScreenSpaceTaskOptions& task,
                               std::size_t program_index, SDL_GPUCommandBuffer* command,
                               SDL_GPUTexture* target, const float* uniforms) {
    const GpuScreenSpaceProgram& program = state.screen_space_programs[program_index];
    const upstream::ScreenSpaceShaderInfo& info =
        upstream::screen_space_shader_infos[program.stage];
    if (!program.vertex_slots.uniforms.empty()) {
        SdlGpuWriteDevice{}.write_vertex_uniform(command, 0, uniforms,
                                                 static_cast<Uint32>(info.uniform_bytes));
    }
    if (!program.fragment_slots.uniforms.empty()) {
        SdlGpuWriteDevice{}.write_fragment_uniform(command, 0, uniforms,
                                                   static_cast<Uint32>(info.uniform_bytes));
    }
    SdlRenderPass pass{begin_screen_space_pass(command, target)};
    SDL_BindGPUGraphicsPipeline(pass, program.pipeline.get());
    std::array<SDL_GPUTextureSamplerBinding, max_post_process_textures> bindings{};
    for (std::size_t slot = 0; slot < program.fragment_roles.size(); ++slot) {
        bindings[slot] = SDL_GPUTextureSamplerBinding{
            screen_space_binding_texture(state, task, program.fragment_roles[slot]),
            state.post_process_bilinear_sampler};
    }
    if (!program.fragment_roles.empty()) {
        SDL_BindGPUFragmentSamplers(pass, 0, bindings.data(),
                                    static_cast<Uint32>(program.fragment_roles.size()));
    }
    count_gpu_draw(SDL_DrawGPUPrimitives, pass, 3, 1, 0, 0);
    pass.end();
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal
