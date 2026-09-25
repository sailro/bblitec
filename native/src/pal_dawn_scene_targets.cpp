// Dawn scene targets: frame-graph and render-target textures, the
// transmission grab, depth copies and the diagnostic readbacks. SDL_GPU's
// twin is pal_sdl_gpu_scene_targets.cpp.
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
WGPUTexture create_frame_texture(DawnState& state, WGPUTextureFormat format, std::uint32_t samples,
                                 std::uint32_t width, std::uint32_t height, WGPUTextureUsage usage,
                                 std::uint32_t layers) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = usage;
    descriptor.size = {width, height, layers};
    descriptor.format = format;
    descriptor.sampleCount = samples;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture frame graph");
    return texture.release();
}

void create_frame_graph_textures(DawnState& state, const Engine& engine, std::uint32_t width,
                                 std::uint32_t height) {
    if (state.render_targets.size() == engine.render_targets.size() &&
        state.frame_graph_width == width && state.frame_graph_height == height &&
        !surface_targets_changed(engine, state.render_targets, width, height)) {
        synchronize_render_target_lifecycles(engine);
        return;
    }
    const auto target_plans =
        plan_render_targets(engine, width, height, state.surface_format,
                            [](TextureFormatClass format) { return texture_format(format); });
    state.release_frame_graph_textures(&engine);
#if BBLITE_SHADOW_RECEIVERS
    // Every shadow map was just released with the other targets, so the
    // render gate's "already rendered" sentinels no longer describe a
    // texture that exists: each generator's next frame must render.
    state.shadow_refresh.invalidate_rendered_maps();
#endif
    state.render_targets.resize(engine.render_targets.size());
    for (std::size_t index = 0; index < target_plans.size(); ++index) {
        const RenderTargetRecord record = engine.render_targets[index];
        const auto& planned = target_plans[index];
        auto& current = state.render_targets[index];
        std::shared_ptr<DawnRenderTarget> replacement;
        if (record.lifecycle) {
            if (current.allocation && current.width == planned.width &&
                current.height == planned.height && current.color_format == planned.color_format) {
                record.lifecycle->synchronize();
                continue;
            }
            record.lifecycle->prepare_resize();
            replacement = std::make_shared<DawnRenderTarget>();
        }
        DawnRenderTarget& target = replacement ? *replacement : current;
        target.width = planned.width;
        target.height = planned.height;
        target.color_format = planned.color_format;
        target.depth_format =
            record.has_depth ? depth_texture_format(record) : WGPUTextureFormat_Undefined;
        if (record.swapchain)
            continue;
        target.allocation = ++state.render_target_allocations;
        const auto samples = task_sample_count(state, record.samples);
        const auto color_format = planned.color_format;
        if (record.has_color) {
            target.color = create_frame_texture(
                state, color_format, samples, target.width, target.height,
                samples == 1
                    // A single-sample frame turns the graph's resolve
                    // step into a copy, and the target of one is a
                    // colour target of another, so both ends of that
                    // copy are the same kind of texture.
                    ? WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                          WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst
                    : WGPUTextureUsage_RenderAttachment);
            target.color_view = create_dawn_texture_view(target.color, nullptr,
                                                         "wgpuTextureCreateView frame graph color");
            if (samples == 1) {
                target.sampled_color = target.color.retain();
                target.sampled_color_view = target.color_view.retain();
            } else {
                target.sampled_color = create_frame_texture(
                    state, color_format, 1, target.width, target.height,
                    WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                        WGPUTextureUsage_CopySrc);
                target.sampled_color_view =
                    create_dawn_texture_view(target.sampled_color, nullptr,
                                             "wgpuTextureCreateView frame graph sampled color");
            }
        }
        if (record.has_depth) {
            // A shadow map states its own format: the pinned generator
            // creates `depth32float` where the frame's own attachments take
            // the browser's depth24plus-stencil8.
            // `create_render_target` normalises this, so the record's own
            // invariant is that it is at least one.
            const std::uint32_t depth_layers = record.depth_layers;
            target.depth = create_frame_texture(
                state, target.depth_format, samples, target.width, target.height,
                record.sampled_depth
                    ? WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding
                    : WGPUTextureUsage_RenderAttachment,
                depth_layers);
            // One attachment view per layer:
            // `ensureCsmShadowTaskState` builds each cascade's render
            // target over `createView({dimension:"2d", baseArrayLayer:i,
            // arrayLayerCount:1})`, and a pass writes exactly one of them.
            target.depth_layer_views.resize(depth_layers);
            for (std::uint32_t layer = 0; layer < depth_layers; ++layer) {
                WGPUTextureViewDescriptor layer_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
                layer_descriptor.dimension = WGPUTextureViewDimension_2D;
                layer_descriptor.baseArrayLayer = layer;
                layer_descriptor.arrayLayerCount = 1;
                target.depth_layer_views[layer] =
                    create_dawn_texture_view(target.depth, &layer_descriptor,
                                             "wgpuTextureCreateView frame graph depth layer");
            }
            if (record.sampled_depth) {
                WGPUTextureViewDescriptor depth_view_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
                depth_view_descriptor.aspect = WGPUTextureAspect_DepthOnly;
                // The cascaded receiver declares `texture_depth_2d_array`,
                // so its sampled view is the pin's own
                // `dimension: "2d-array"` one over every layer.
                if (depth_layers > 1) {
                    depth_view_descriptor.dimension = WGPUTextureViewDimension_2DArray;
                    depth_view_descriptor.arrayLayerCount = depth_layers;
                }
                target.depth_sampled_view =
                    create_dawn_texture_view(target.depth, &depth_view_descriptor,
                                             "wgpuTextureCreateView frame graph sampled depth");
                // A shadow map is read through a comparison sampler on the
                // depth texture itself, and a screen-space effect reads a
                // colour-carrying target's depth through the depth-only view
                // above. The remaining sampled depth -- a colour-less target
                // -- is read as a Standard emissive slot, which needs the
                // r32float copy so it decodes like SDL's D3D12 depth SRV;
                // `dawn_render_target_texture` hands out nothing else.
                if (!record.shadow_map && !record.has_color) {
                    target.depth_copy = create_frame_texture(
                        state, WGPUTextureFormat_R32Float, 1, target.width, target.height,
                        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding);
                    target.depth_copy_view = create_dawn_texture_view(
                        target.depth_copy, nullptr, "wgpuTextureCreateView frame graph depth copy");
                }
            }
        }
        if (replacement) {
            auto previous = std::make_shared<DawnRenderTarget>(std::move(current));
            current = std::move(*replacement);
            if (previous->allocation) {
                record.lifecycle->replaced([previous] { *previous = {}; });
            }
        }
    }

    if (state.geometry_tasks.size() < engine.frame_tasks.size()) {
        state.geometry_tasks.resize(engine.frame_tasks.size());
    }
#if BBLITE_HAS_POST_PROCESS
    if (state.post_process_tasks.size() < engine.frame_tasks.size()) {
        state.post_process_tasks.resize(engine.frame_tasks.size());
    }
    // Each post-process task keeps one entry per pass it records, sized here
    // rather than grown from the record path: a composite's chain is known
    // before a frame starts and its entries own vectors worth not moving.
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& task = engine.frame_tasks[index];
        // A screen-space task's history copy and composite are ordinary
        // passes in the same list, recorded by the same pass path.
        if (task.kind != FrameTaskKind::post_process && task.kind != FrameTaskKind::screen_space) {
            continue;
        }
        if (state.post_process_tasks[index].size() < task.post_process.passes.size()) {
            state.post_process_tasks[index].resize(task.post_process.passes.size());
        }
    }
#endif
#if BBLITE_HAS_SCREEN_SPACE
    if (state.screen_space_tasks.size() < engine.frame_tasks.size()) {
        state.screen_space_tasks.resize(engine.frame_tasks.size());
    }
#endif
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& record = engine.frame_tasks[index];
        if (record.kind != FrameTaskKind::geometry)
            continue;
        DawnGeometryTask& task = state.geometry_tasks[index];
        task.depth_borrowed = geometry_depth_is_borrowed(engine, index);
        const std::uint32_t samples = task_sample_count(state, record.geometry.samples);
        task.colors.reserve(record.geometry.attachments.size());
        for (const GeometryTextureDescription& description : record.geometry.attachments) {
            const WGPUTextureFormat format = geometry_texture_format(description);
            DawnTexture color{create_frame_texture(
                state, format, samples, width, height,
                samples == 1 ? WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding
                             : WGPUTextureUsage_RenderAttachment)};
            task.colors.push_back(std::move(color));
            task.color_views.push_back(DawnTextureView{create_dawn_texture_view(
                task.colors.back(), nullptr, "wgpuTextureCreateView geometry task color")});
            if (samples == 1) {
                task.sampled_colors.push_back(task.colors.back().retain());
                task.sampled_views.push_back(task.color_views.back().retain());
            } else {
                DawnTexture sampled{create_frame_texture(state, format, 1, width, height,
                                                         WGPUTextureUsage_RenderAttachment |
                                                             WGPUTextureUsage_TextureBinding)};
                task.sampled_colors.push_back(std::move(sampled));
                task.sampled_views.push_back(DawnTextureView{
                    create_dawn_texture_view(task.sampled_colors.back(), nullptr,
                                             "wgpuTextureCreateView geometry task sampled color")});
            }
        }
        task.depth = create_frame_texture(state, WGPUTextureFormat_Depth24PlusStencil8, samples,
                                          width, height, WGPUTextureUsage_RenderAttachment);
        task.depth_view = create_dawn_texture_view(task.depth, nullptr,
                                                   "wgpuTextureCreateView geometry task depth");
    }
    state.frame_graph_width = width;
    state.frame_graph_height = height;
}

std::pair<WGPUTexture, WGPUTextureView> dawn_render_target_texture(DawnState& state,
                                                                   const Engine& engine,
                                                                   RenderTargetHandle target_handle,
                                                                   bool depth_only) {
    if (target_handle.value >= state.render_targets.size()) {
        pal::refuse_invalid_frame_handle("Frame graph render target handle is invalid.");
    }
    const RenderTargetRecord& record = handle_at(engine.render_targets, target_handle);
    DawnRenderTarget& target = handle_at(state.render_targets, target_handle);
    if (depth_only) {
        if (!record.sampled_depth || !target.depth_sampled_view) {
            pal::fail_render_target_has_no_texture();
        }
        return {target.depth, target.depth_sampled_view};
    }
    if (pal::render_target_samples_depth(record)) {
        if (record.has_depth && target.depth_copy) {
            return {target.depth_copy, target.depth_copy_view};
        }
        pal::fail_render_target_has_no_texture();
    }
    return {target.sampled_color, target.sampled_color_view};
}

void encode_transmission_grab(DawnState& state, WGPUCommandEncoder encoder) {
    if (!state.transmission_grab_pipeline) {
        state.transmission_grab_module =
            load_wgsl_module(state, state.multisampled() ? "transmission-grab.frag"
                                                         : "transmission-grab-single.frag");
        if (!state.multisampled())
            state.transmission_grab_sampler = create_dawn_bilinear_sampler(state.device);
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.transmission_grab_module;
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = WGPUTextureFormat_RGBA16Float;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.transmission_grab_module;
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.transmission_grab_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.transmission_grab_pipeline) {
            dawn_error("transmission grab pipeline creation failed.");
        }
    }
    DawnBindGroupLayout layout{
        wgpuRenderPipelineGetBindGroupLayout(state.transmission_grab_pipeline, 0)};
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].textureView = state.msaa_color_view;
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].sampler = state.transmission_grab_sampler;
    WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = layout;
    bind_descriptor.entryCount = state.transmission_grab_sampler ? 2u : 1u;
    bind_descriptor.entries = entries.data();
    DawnBindGroup bind_group{wgpuDeviceCreateBindGroup(state.device, &bind_descriptor)};
    layout.reset();
    WGPUTextureViewDescriptor level_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    level_descriptor.baseMipLevel = 0;
    level_descriptor.mipLevelCount = 1;
    DawnTextureView level_view{
        create_dawn_texture_view(state.transmission_color, &level_descriptor)};
    WGPURenderPassColorAttachment color_attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = level_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, state.transmission_grab_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
    bind_group.reset();
    level_view.reset();
    record_mipmaps(state, encoder, state.transmission_color, WGPUTextureFormat_RGBA16Float,
                   state.transmission_mip_count);
}

void encode_image_processing(DawnState& state, WGPUCommandEncoder encoder,
                             WGPUTextureView surface_view, const Scene& scene) {
    if (!state.image_processing_pipeline) {
        state.image_processing_module = load_wgsl_module(
            state, state.multisampled() ? "image-processing.frag" : "image-processing-single.frag");
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.image_processing_module;
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.surface_format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.image_processing_module;
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.image_processing_pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.image_processing_pipeline) {
            dawn_error("image processing pipeline creation failed.");
        }
        state.image_processing_params = create_buffer(state, WGPUBufferUsage_Uniform, nullptr, 16);
    }
    if (!state.image_processing_group) {
        DawnBindGroupLayout layout{
            wgpuRenderPipelineGetBindGroupLayout(state.image_processing_pipeline, 0)};
        std::array<WGPUBindGroupEntry, 2> entries{};
        entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[0].binding = 0;
        entries[0].buffer = state.image_processing_params;
        entries[0].size = 16;
        entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[1].binding = 1;
        entries[1].textureView = state.msaa_color_view;
        WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        bind_descriptor.layout = layout;
        bind_descriptor.entryCount = entries.size();
        bind_descriptor.entries = entries.data();
        state.image_processing_group = wgpuDeviceCreateBindGroup(state.device, &bind_descriptor);
        layout.reset();
    }
    const std::array<float, 4> params{
        scene.environment.exposure,
        scene.environment.contrast,
        scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
        0.0f,
    };
    wgpuQueueWriteBuffer(state.queue, state.image_processing_params, 0, params.data(),
                         sizeof(params));
    WGPURenderPassColorAttachment color_attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = surface_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    color_attachment.clearValue = WGPUColor{
        scene.clear_color.r,
        scene.clear_color.g,
        scene.clear_color.b,
        scene.clear_color.a,
    };
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, state.image_processing_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, state.image_processing_group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}

void encode_depth_copy(DawnState& state, WGPUCommandEncoder encoder,
                       const DawnRenderTarget& target) {
    if (!state.depth_copy_pipeline) {
        WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
        wgsl.code = string_view(depth_copy_wgsl);
        WGPUShaderModuleDescriptor module_descriptor{};
        module_descriptor.nextInChain = &wgsl.chain;
        module_descriptor.label = string_view("depth-copy");
        state.depth_copy_module = wgpuDeviceCreateShaderModule(state.device, &module_descriptor);
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.depth_copy_module;
        descriptor.vertex.entryPoint = string_view("vs");
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = WGPUTextureFormat_R32Float;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.depth_copy_module;
        fragment.entryPoint = string_view("fs");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.depth_copy_pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.depth_copy_pipeline) {
            dawn_error("depth copy pipeline creation failed.");
        }
    }
    DawnBindGroupLayout layout{wgpuRenderPipelineGetBindGroupLayout(state.depth_copy_pipeline, 0)};
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.textureView = target.depth_sampled_view;
    WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = layout;
    bind_descriptor.entryCount = 1;
    bind_descriptor.entries = &entry;
    DawnBindGroup bind_group{wgpuDeviceCreateBindGroup(state.device, &bind_descriptor)};
    layout.reset();
    WGPURenderPassColorAttachment color_attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = target.depth_copy_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, state.depth_copy_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
    bind_group.reset();
}

WGPURenderPipeline blit_pipeline_for(DawnState& state, WGPUTextureFormat format,
                                     std::uint32_t samples) {
    const auto key = std::make_pair(format, samples);
    const auto existing = state.blit_pipelines.find(key);
    if (existing != state.blit_pipelines.end()) {
        return existing->second;
    }
    if (!state.blit_vertex_module) {
        state.blit_vertex_module = load_wgsl_module(state, "blit.vert");
        state.blit_fragment_module = load_wgsl_module(state, "blit.frag");
    }
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = state.blit_vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.blit_fragment_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline)
        dawn_error("blit pipeline creation failed.");
    auto& slot = state.blit_pipelines[key];
    slot = pipeline.release();
    return slot;
}

WGPUBindGroup blit_group_for(DawnState& state, WGPURenderPipeline pipeline,
                             WGPUTextureView source) {
    const auto layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 2);
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].textureView = source;
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].sampler = state.clamp_sampler;
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    const auto group = wgpuDeviceCreateBindGroup(state.device, &descriptor);
    wgpuBindGroupLayoutRelease(layout);
    return group;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_TAA
void retain_temporal_presentation(DawnState& state, WGPUCommandEncoder encoder, WGPUTexture surface,
                                  std::uint32_t width, std::uint32_t height) {
    if (!state.temporal_presented) {
        state.temporal_presented =
            create_frame_texture(state, state.surface_format, 1u, width, height,
                                 WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding);
        state.temporal_presented_view = create_dawn_texture_view(state.temporal_presented, nullptr);
        state.temporal_presented_group =
            blit_group_for(state, blit_pipeline_for(state, state.surface_format, 1u),
                           state.temporal_presented_view);
    }
    WGPUTexelCopyTextureInfo source{};
    source.texture = surface;
    WGPUTexelCopyTextureInfo target{};
    target.texture = state.temporal_presented;
    const WGPUExtent3D extent{width, height, 1u};
    wgpuCommandEncoderCopyTextureToTexture(encoder, &source, &target, &extent);
}

void present_stopped_temporal_frame(DawnState& state, WGPUCommandEncoder encoder,
                                    WGPUTextureView surface) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = surface;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    descriptor.colorAttachmentCount = 1;
    descriptor.colorAttachments = &attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, blit_pipeline_for(state, state.surface_format, 1u));
    wgpuRenderPassEncoderSetBindGroup(pass, 2u, state.temporal_presented_group, 0u, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3u, 1u, 0u, 0u);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
void save_dawn_texture_file(DawnState& state, WGPUTexture texture, WGPUTextureFormat format,
                            std::uint32_t width, std::uint32_t height, const std::string& path,
                            const std::string& raw_path) {
    const std::uint32_t bytes_per_pixel = format == WGPUTextureFormat_RGBA16Float ? 8u
                                          : format == WGPUTextureFormat_R16Float  ? 2u
                                                                                  : 4u;
    const std::uint32_t source_row_bytes = width * bytes_per_pixel;
    const std::uint32_t aligned_row_bytes = (source_row_bytes + 255u) & ~255u;
    WGPUBufferDescriptor readback_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    readback_descriptor.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    readback_descriptor.size = static_cast<std::uint64_t>(aligned_row_bytes) * height;
    DawnBuffer readback{wgpuDeviceCreateBuffer(state.device, &readback_descriptor)};
    DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state.device, nullptr)};
    WGPUTexelCopyTextureInfo copy_source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    copy_source.texture = texture;
    WGPUTexelCopyBufferInfo copy_destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    copy_destination.layout.bytesPerRow = aligned_row_bytes;
    copy_destination.layout.rowsPerImage = height;
    copy_destination.buffer = readback;
    const WGPUExtent3D copy_size{width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &copy_source, &copy_destination, &copy_size);
    DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
    submit_dawn_command(state.queue, command);
    command.reset();
    encoder.reset();
    const DawnReadbackMap mapping(state, readback,
                                  static_cast<std::size_t>(aligned_row_bytes) * height);
    const auto* mapped = mapping.bytes().data();
    if (!raw_path.empty() && format == WGPUTextureFormat_RGBA16Float) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            throw std::runtime_error("Unable to open HDR diagnostic output '" + raw_path + "'.");
        }
        write_readback_raw_rows(raw, mapped, height, aligned_row_bytes, source_row_bytes);
    }
    const std::uint32_t output_row_bytes = width * 4;
    // The shared row conversion (pal_gpu_shared.hpp); only the WebGPU
    // format enum is translated here.
    const ReadbackFormatClass format_class =
        format == WGPUTextureFormat_RGBA16Float ? ReadbackFormatClass::rgba16_float
        : format == WGPUTextureFormat_R16Float  ? ReadbackFormatClass::r16_float
                                                : ReadbackFormatClass::rgba8;
    std::vector<std::uint8_t> rgba =
        convert_readback_rows(mapped, width, height, aligned_row_bytes, format_class);
    save_capture_png(rgba, width, height, output_row_bytes, false, path);
}

void save_dawn_geometry_id_buffer(DawnState& state, std::uint32_t width, std::uint32_t height,
                                  const std::vector<upstream::RenderItem>& render_plan,
                                  const Engine& engine, const std::string& path, bool cluster_ids) {
    if (cluster_ids && !state.diagnostic_cluster_module) {
        state.diagnostic_cluster_module = load_wgsl_module(state, "diagnostic-cluster.frag");
    }
    if (!cluster_ids && !state.diagnostic_id_module) {
        state.diagnostic_id_module = load_wgsl_module(state, "diagnostic-id.frag");
    }
    const WGPUTextureFormat color_format = WGPUTextureFormat_RGBA8Unorm;
    auto& pipelines = cluster_ids ? state.cluster_pipelines : state.id_pipelines;
    for (int sided = 0; sided < 2; ++sided) {
        if (!pipelines[sided]) {
            pipelines[sided] = create_diagnostic_pipeline(
                state, cluster_ids ? state.diagnostic_cluster_module : state.diagnostic_id_module,
                sided == 1, 1, &color_format, 1);
        }
    }

    WGPUTextureDescriptor color_info = WGPU_TEXTURE_DESCRIPTOR_INIT;
    color_info.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    color_info.size = {width, height, 1};
    color_info.format = color_format;
    DawnTexture color{wgpuDeviceCreateTexture(state.device, &color_info)};
    if (!color)
        dawn_error("wgpuDeviceCreateTexture ID buffer");
    DawnTextureView color_view{create_dawn_texture_view(color, nullptr)};
    WGPUTextureDescriptor depth_info = WGPU_TEXTURE_DESCRIPTOR_INIT;
    depth_info.usage = WGPUTextureUsage_RenderAttachment;
    depth_info.size = {width, height, 1};
    depth_info.format = WGPUTextureFormat_Depth24PlusStencil8;
    DawnTexture depth{wgpuDeviceCreateTexture(state.device, &depth_info)};
    if (!depth)
        dawn_error("wgpuDeviceCreateTexture ID depth");
    DawnTextureView depth_view{create_dawn_texture_view(depth, nullptr)};

    std::vector<DawnBuffer> transient_buffers;
    std::vector<DawnBindGroup> transient_groups;
    DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state.device, nullptr)};
    WGPURenderPassColorAttachment color_attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = color_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    color_attachment.clearValue = WGPUColor{0.0, 0.0, 0.0, 0.0};
    WGPURenderPassDepthStencilAttachment depth_attachment{};
    depth_attachment.view = depth_view;
    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
    depth_attachment.depthClearValue = upstream::pinned_depth_clear;
    depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
    depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
    depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    pass_descriptor.depthStencilAttachment = &depth_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
        wgpuRenderPassEncoderSetPipeline(pass, pipelines[sided_mode]);
        std::uint32_t cluster_id_base = 1;
        for (std::size_t mesh_index = 0;
             mesh_index < state.meshes.size() && mesh_index < render_plan.size(); ++mesh_index) {
            DawnMesh& mesh = state.meshes[mesh_index];
            const ClusterRange cluster = advance_cluster_range(mesh.index_count, cluster_id_base);

            const std::uint32_t current_cluster_base = cluster.id_start;
            const upstream::RenderItem& item = render_plan[mesh_index];
            const MaterialRecord* material = handle_find(engine.materials, item.material);
            const bool double_sided = item.cull_mode == upstream::RenderCullMode::none;
            if (double_sided != (sided_mode == 1))
                continue;

            const std::array<float, 4> alpha_options = diagnostic_alpha_options(item, material);
            WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            uniform_descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            uniform_descriptor.size = 32;
            DawnBuffer uniform_buffer{wgpuDeviceCreateBuffer(state.device, &uniform_descriptor)};
            if (cluster_ids) {
                const DiagnosticClusterUniforms uniforms =
                    diagnostic_cluster_uniforms(current_cluster_base, alpha_options);
                wgpuQueueWriteBuffer(state.queue, uniform_buffer, 0, &uniforms, sizeof(uniforms));
            } else {
                const DiagnosticIdUniforms uniforms = diagnostic_id_uniforms(
                    static_cast<std::uint32_t>(mesh_index + 1), alpha_options);
                wgpuQueueWriteBuffer(state.queue, uniform_buffer, 0, &uniforms, sizeof(uniforms));
            }
            WGPUBindGroupEntry uniform_entry = WGPU_BIND_GROUP_ENTRY_INIT;
            uniform_entry.binding = 0;
            uniform_entry.buffer = uniform_buffer;
            uniform_entry.size = 32;
            WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            group_descriptor.layout = diagnostic_group_layout(state, 3);
            group_descriptor.entryCount = 1;
            group_descriptor.entries = &uniform_entry;
            DawnBindGroup uniform_group{wgpuDeviceCreateBindGroup(state.device, &group_descriptor)};

            DawnMeshBindings& bindings = diagnostic_bindings_for(state, mesh);
            wgpuRenderPassEncoderSetBindGroup(pass, 1, bindings.scene, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(pass, 2, bindings.textures, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(pass, 3, uniform_group, 0, nullptr);
            transient_buffers.push_back(std::move(uniform_buffer));
            transient_groups.push_back(std::move(uniform_group));
#if BBLITE_GPU_MORPH_STORAGE
            wgpuRenderPassEncoderSetBindGroup(pass, 0, bindings.morph, 0, nullptr);
#endif
            wgpuRenderPassEncoderSetVertexBuffer(pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
            wgpuRenderPassEncoderSetVertexBuffer(pass, 1, mesh.instances, 0, WGPU_WHOLE_SIZE);
#endif
#if BBLITE_GPU_INSTANCE_COLORS
            wgpuRenderPassEncoderSetVertexBuffer(pass, 2, mesh.instance_colors, 0, WGPU_WHOLE_SIZE);
#endif
            wgpuRenderPassEncoderSetIndexBuffer(pass, mesh.indices, WGPUIndexFormat_Uint32, 0,
                                                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, mesh.index_count,
#if BBLITE_GPU_INSTANCING
                           mesh.instance_count,
#else
                           1,
#endif
                           0, 0, 0);
        }
    }
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
    DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
    submit_dawn_command(state.queue, command);
    command.reset();
    encoder.reset();
    save_dawn_texture_file(state, color, color_format, width, height, path);
    transient_groups.clear();
    transient_buffers.clear();
    depth_view.reset();
    depth.reset();
    color_view.reset();
    color.reset();
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal

namespace bbl::pal {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
void recreate_dawn_scene_targets(DawnState& state, const Scene& scene, std::uint32_t width,
                                 std::uint32_t height) {
    if (state.image_processing_group) {
        wgpuBindGroupRelease(state.image_processing_group);
        state.image_processing_group = nullptr;
    }
    if (state.depth_view)
        wgpuTextureViewRelease(state.depth_view);
    if (state.depth)
        wgpuTextureRelease(state.depth);
    if (state.msaa_color_view) {
        wgpuTextureViewRelease(state.msaa_color_view);
    }
    if (state.msaa_color)
        wgpuTextureRelease(state.msaa_color);
    state.depth_view = nullptr;
    state.depth = nullptr;
    state.msaa_color_view = nullptr;
    state.msaa_color = nullptr;

    WGPUTextureDescriptor color_descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    color_descriptor.usage = scene.transmission_enabled ? WGPUTextureUsage_RenderAttachment |
                                                              WGPUTextureUsage_TextureBinding
                                                        : WGPUTextureUsage_RenderAttachment;
    color_descriptor.size = {width, height, 1};
    color_descriptor.format = state.frame_color_format;
    color_descriptor.sampleCount = state.sample_count;
    state.msaa_color = wgpuDeviceCreateTexture(state.device, &color_descriptor);
    state.msaa_color_view = create_dawn_texture_view(state.msaa_color, nullptr);
    WGPUTextureDescriptor depth_descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    depth_descriptor.usage = WGPUTextureUsage_RenderAttachment;
    depth_descriptor.size = {width, height, 1};
    depth_descriptor.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_descriptor.sampleCount = state.sample_count;
    state.depth = wgpuDeviceCreateTexture(state.device, &depth_descriptor);
    state.depth_view = create_dawn_texture_view(state.depth, nullptr);
    if (!state.msaa_color || !state.msaa_color_view || !state.depth || !state.depth_view) {
        dawn_error("resizable frame target creation failed.");
    }
}
#endif

} // namespace bbl::pal
