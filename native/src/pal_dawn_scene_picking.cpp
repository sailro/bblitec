// Dawn scene picking: the pick pipelines and the scene pick. SDL_GPU's
// twin is pal_sdl_gpu_scene_picking.cpp.
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_splats.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PICKING
WGPURenderPipeline
create_dawn_pick_mesh_pipeline(WGPUDevice device, WGPUBindGroupLayout scene_layout,
                               WGPUBindGroupLayout mesh_layout, const char* stem_vertex,
                               const char* stem_fragment, std::uint32_t target_count,
                               WGPUBindGroupLayout empty_layout, WGPUBindGroupLayout deform_layout,
                               [[maybe_unused]] bool skeleton) {
    DawnShaderModule vertex{load_wgsl_module(device, stem_vertex)};
    DawnShaderModule fragment{load_wgsl_module(device, stem_fragment)};

    const std::array<WGPUBindGroupLayout, 4> groups{scene_layout, mesh_layout, empty_layout,
                                                    deform_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = deform_layout ? 4u : 2u;
    layout_descriptor.bindGroupLayouts = groups.data();
    DawnPipelineLayout pipeline_layout{wgpuDeviceCreatePipelineLayout(device, &layout_descriptor)};
    if (!pipeline_layout)
        dawn_error("pick pipeline layout");

    // The renderer's interleaved stream read at its own pitch: the pin
    // binds a position-only buffer, and these are the same numbers.
    auto attributes = vertex_attribute_array<3>();
    attributes[0].shaderLocation = 0;
    attributes[0].offset = 0;
    attributes[0].format = WGPUVertexFormat_Float32x3;
#if BBLITE_GPU_DEFORMATION && (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON)
    attributes[1].shaderLocation = 1;
    attributes[1].offset = offsetof(GpuVertex, joint_indices);
    attributes[1].format = WGPUVertexFormat_Uint32x4;
    attributes[2].shaderLocation = 2;
    attributes[2].offset = offsetof(GpuVertex, weights);
    attributes[2].format = WGPUVertexFormat_Float32x4;
#endif
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.attributeCount = skeleton ? 3u : 1u;
    vertex_layout.attributes = attributes.data();

    std::array<WGPUColorTargetState, pick_color_targets> targets{};
    fill_dawn_pick_targets(targets);

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    fragment_state.targetCount = target_count;
    fragment_state.targets = targets.data();

    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth.format = WGPUTextureFormat_Depth24Plus;
    depth.depthCompare = WGPUCompareFunction_Greater;
    depth.depthWriteEnabled = WGPUOptionalBool_True;

    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = vertex;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.fragment = &fragment_state;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth;
    descriptor.multisample.count = 1;

    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(device, &descriptor)};
    pipeline_layout.reset();
    vertex.reset();
    fragment.reset();
    if (!pipeline)
        dawn_error("pick mesh render pipeline");
    return pipeline.release();
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PICKING && BBLITE_DEFORM_PICKING
std::vector<DawnLayoutStage> dawn_pick_deform_stages(const upstream::PickDeformVariant& variant) {
    std::vector<DawnLayoutStage> stages{{variant.vertex, WGPUShaderStage_Vertex},
                                        {"picking.frag", WGPUShaderStage_Fragment}};
    if (variant.detailed_vertex) {
        stages.push_back({variant.detailed_vertex, WGPUShaderStage_Vertex});
        stages.push_back({"picking-detailed.frag", WGPUShaderStage_Fragment});
    }
    return stages;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PICKING && BBLITE_HAS_SPLATS
WGPURenderPipeline create_dawn_pick_cloud_pipeline(WGPUDevice device,
                                                   WGPUBindGroupLayout scene_layout,
                                                   WGPUBindGroupLayout cloud_layout,
                                                   WGPUBindGroupLayout color_layout) {
    DawnShaderModule vertex{load_wgsl_module(device, "picking-splat.vert")};
    DawnShaderModule fragment{load_wgsl_module(device, "picking-splat.frag")};

    const std::array<WGPUBindGroupLayout, 3> groups{scene_layout, cloud_layout, color_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = groups.size();
    layout_descriptor.bindGroupLayouts = groups.data();
    DawnPipelineLayout pipeline_layout{wgpuDeviceCreatePipelineLayout(device, &layout_descriptor)};
    if (!pipeline_layout)
        dawn_error("cloud pick pipeline layout");

    WGPUVertexAttribute corner = WGPU_VERTEX_ATTRIBUTE_INIT;
    corner.shaderLocation = 0;
    corner.offset = 0;
    corner.format = WGPUVertexFormat_Float32x2;
    WGPUVertexBufferLayout quad_layout{};
    quad_layout.arrayStride = 8;
    quad_layout.stepMode = WGPUVertexStepMode_Vertex;
    quad_layout.attributeCount = 1;
    quad_layout.attributes = &corner;

    WGPUVertexAttribute index = WGPU_VERTEX_ATTRIBUTE_INIT;
    index.shaderLocation = 1;
    index.offset = 0;
    index.format = WGPUVertexFormat_Float32;
    WGPUVertexBufferLayout order_layout{};
    order_layout.arrayStride = 4;
    order_layout.stepMode = WGPUVertexStepMode_Instance;
    order_layout.attributeCount = 1;
    order_layout.attributes = &index;
    const std::array<WGPUVertexBufferLayout, 2> buffers{quad_layout, order_layout};

    std::array<WGPUColorTargetState, pick_color_targets> targets{};
    fill_dawn_pick_targets(targets);

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    // The cloud contributor draws the pin's own pair; a detailed pick
    // composes no contributor, so it never binds the third.
    fragment_state.targetCount = 2;
    fragment_state.targets = targets.data();

    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth.format = WGPUTextureFormat_Depth24Plus;
    depth.depthCompare = WGPUCompareFunction_Less;
    depth.depthWriteEnabled = WGPUOptionalBool_True;

    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = vertex;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = buffers.size();
    descriptor.vertex.buffers = buffers.data();
    descriptor.fragment = &fragment_state;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth;
    descriptor.multisample.count = 1;

    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(device, &descriptor)};
    pipeline_layout.reset();
    vertex.reset();
    fragment.reset();
    if (!pipeline)
        dawn_error("cloud pick render pipeline");
    return pipeline.release();
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && (BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING)
PickingInfo pick_dawn_scene(DawnState& state, Engine& engine, const upstream::RenderPlan& root_plan,
                            const std::vector<upstream::RenderPlan>& overlay_plans,
                            const std::vector<std::shared_ptr<Scene>>& active_registered_scenes,
                            [[maybe_unused]] GpuPickerHandle picker, double x, double y,
                            const Engine::PickFilter* filter
#if BBLITE_HAS_BILLBOARDS
                            ,
                            DawnBillboardPickContributor& billboard_pick
#endif
) {
    const auto layer = picker_scene_index(engine, picker, active_registered_scenes);
    if (!layer)
        return PickingInfo{};
    const Scene& scene = *active_registered_scenes[*layer];
    const auto& render_plan = *layer == 0 ? root_plan : overlay_plans[*layer - 1];
    auto& pick_meshes = *layer == 0 ? state.meshes : state.overlay_meshes[*layer - 1];
    // The pin's preamble -- camera, pointer mapping, scene block -- is
    // shared with the SDL pick (pal_gpu_shared.hpp).
    const std::optional<PickRequest> request = prepare_gpu_pick(engine, picker, scene, x, y);
    if (!request)
        return PickingInfo{};
#if BBLITE_HAS_DETAILED_PICKING
    const bool detailed = request->detailed;
#else
    constexpr bool detailed = false;
#endif
    [[maybe_unused]] const CameraRecord& camera = *request->camera;
    [[maybe_unused]] const upstream::PickPointer& pointer = request->pointer;
    ensure_dawn_pick_targets(state.device, state.pick_targets);
    if (!state.pick_mesh_pipeline) {
        state.pick_scene_layout = create_dawn_pick_scene_layout(state.device);
        state.pick_mesh_layout = create_dawn_pick_mesh_layout(state.device);
        state.pick_mesh_pipeline = create_dawn_pick_mesh_pipeline(
            state.device, state.pick_scene_layout, state.pick_mesh_layout, "picking.vert",
            "picking.frag", 2);
#if BBLITE_GPU_INSTANCING
        state.pick_thin_layout = create_dawn_pick_thin_layout(state.device);
        state.pick_thin_pipeline = create_dawn_pick_mesh_pipeline(
            state.device, state.pick_scene_layout, state.pick_thin_layout, "picking-thin.vert",
            "picking-thin.frag", 2);
#endif
#if BBLITE_HAS_DETAILED_PICKING
        // The pin's second module, built beside the first: the picker
        // dynamic-imports whichever `_detailedPicking` selected, and
        // a picker can be armed after another has already picked.
        state.pick_detailed_pipeline = create_dawn_pick_mesh_pipeline(
            state.device, state.pick_scene_layout, state.pick_mesh_layout, "picking-detailed.vert",
            "picking-detailed.frag", pick_color_targets);
#endif
#if BBLITE_DEFORM_PICKING
        state.pick_deform_empty_layout =
            create_dawn_pick_empty_layout(state.device, upstream::pick_deform_variants.front());
        WGPUBindGroupDescriptor empty_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        empty_group.layout = state.pick_deform_empty_layout;
        empty_group.entryCount = 0;
        state.pick_deform_empty_group = wgpuDeviceCreateBindGroup(state.device, &empty_group);
        if (!state.pick_deform_empty_group) {
            dawn_error("pick deform empty bind group");
        }
        for (std::size_t index = 0; index < upstream::pick_deform_variants.size(); ++index) {
            const auto& variant = upstream::pick_deform_variants[index];
            auto& program = state.pick_deform_programs[index];
            program.layout = create_dawn_pick_deform_layout(state.device, variant);
            for (std::size_t mode = 0; mode < 2; ++mode) {
                const char* stem = mode == 0 ? variant.vertex : variant.detailed_vertex;
                if (!stem)
                    continue;
                program.pipelines[mode] = create_dawn_pick_mesh_pipeline(
                    state.device, state.pick_scene_layout, state.pick_mesh_layout, stem,
                    mode == 0 ? "picking.frag" : "picking-detailed.frag", mode == 0 ? 2u : 3u,
                    state.pick_deform_empty_layout, program.layout, variant.skeleton);
            }
        }
#endif
        WGPUBufferDescriptor scene_buffer = WGPU_BUFFER_DESCRIPTOR_INIT;
        scene_buffer.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        scene_buffer.size = sizeof(PickSceneUniforms);
        state.pick_scene_buffer = wgpuDeviceCreateBuffer(state.device, &scene_buffer);
        WGPUBindGroupEntry scene_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entry.binding = 0;
        scene_entry.buffer = state.pick_scene_buffer;
        scene_entry.size = sizeof(PickSceneUniforms);
        WGPUBindGroupDescriptor scene_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_group.layout = state.pick_scene_layout;
        scene_group.entryCount = 1;
        scene_group.entries = &scene_entry;
        state.pick_scene_group = wgpuDeviceCreateBindGroup(state.device, &scene_group);
    }

    const PickSceneUniforms& scene_uniforms = request->scene_uniforms;
    wgpuQueueWriteBuffer(state.queue, state.pick_scene_buffer, 0, &scene_uniforms,
                         sizeof(scene_uniforms));

    // Every candidate's block is written before the pass opens,
    // because WebGPU forbids a queue write between draws inside one.
    std::vector<PickRange> ranges;
    std::vector<DawnPickMeshUniforms> blocks;
    std::uint32_t next_id = 1;
    // The shared collector owns the plan walk, the generated pick
    // predicate and the id/range assignment; only "does this row have
    // GPU buffers" is answered here. Candidate rows carry plan-item
    // indices rather than pointers: the same function pushes into
    // `state.splat_passes` below, and a raw pointer into a growing
    // vector is the shape of the bloom-composite crash.
    const std::vector<PickMeshCandidate> candidates = collect_pick_mesh_candidates(
        engine, scene, render_plan, pick_meshes.size(),
        [&](std::size_t item_index) {
            const DawnMesh& mesh = pick_meshes[item_index];
            return mesh.vertices && mesh.indices;
        },
        ranges, next_id, filter, detailed);
    // `pickAsyncImpl` takes no pick source under a supplied filter.
    [[maybe_unused]] const bool pick_sources = filter == nullptr;
    validate_pick_contributors(engine, scene, detailed, pick_sources);
#if BBLITE_DEFORM_PICKING
    for (const auto& candidate : candidates) {
        if (candidate.deform < 0)
            continue;
        const auto& item = render_plan.items[candidate.item_index];
        const auto& record = handle_at(engine.meshes, item.mesh);
        auto& gpu = pick_meshes[candidate.item_index];
#if BBLITE_GPU_MORPH_STORAGE
        sync_morph_weights(state, gpu, engine.geometries[item.geometry], record);
#endif
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
        if (record.skinned)
            write_pinned_bone_texture(state, gpu, record);
#endif
    }
#endif
    blocks.reserve(candidates.size());
    for (const PickMeshCandidate& candidate : candidates) {
        // The shared block at this backend's 256-byte dynamic-offset
        // stride.
        blocks.push_back(DawnPickMeshUniforms{candidate.uniforms});
    }
    if (blocks.size() > state.pick_mesh_capacity) {
#if BBLITE_GPU_INSTANCING
        state.release_thin_pick_groups();
#endif
        if (state.pick_mesh_group) {
            wgpuBindGroupRelease(state.pick_mesh_group);
            state.pick_mesh_group = nullptr;
        }
        if (state.pick_mesh_buffer) {
            wgpuBufferRelease(state.pick_mesh_buffer);
            state.pick_mesh_buffer = nullptr;
        }
        state.pick_mesh_capacity = blocks.size();
        WGPUBufferDescriptor mesh_buffer = WGPU_BUFFER_DESCRIPTOR_INIT;
        mesh_buffer.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        mesh_buffer.size =
            static_cast<std::uint64_t>(state.pick_mesh_capacity * sizeof(DawnPickMeshUniforms));
        state.pick_mesh_buffer = wgpuDeviceCreateBuffer(state.device, &mesh_buffer);
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = 0;
        entry.buffer = state.pick_mesh_buffer;
        entry.size = sizeof(DawnPickMeshUniforms);
        WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group.layout = state.pick_mesh_layout;
        group.entryCount = 1;
        group.entries = &entry;
        state.pick_mesh_group = wgpuDeviceCreateBindGroup(state.device, &group);
    }
    if (!blocks.empty()) {
        wgpuQueueWriteBuffer(state.queue, state.pick_mesh_buffer, 0, blocks.data(),
                             blocks.size() * sizeof(DawnPickMeshUniforms));
    }
#if BBLITE_GPU_INSTANCING
    // Membership is stable across picks. Uniform contents are dynamic,
    // but only replacing a bound resource or its range needs a new group.
    for (std::size_t index = 0; index < candidates.size(); ++index) {
        if (!candidates[index].thin)
            continue;
#if BBLITE_HAS_DETAILED_PICKING
        if (detailed) {
            dawn_error("detailed thin-instance picking was not composed");
        }
#endif
        DawnMesh& mesh = pick_meshes[candidates[index].item_index];
        if (!mesh.instances) {
            dawn_error("a thin-instance pick candidate has no instance buffer");
        }
        const std::uint64_t bound_size =
            static_cast<std::uint64_t>(candidates[index].instance_count) *
            sizeof(std::array<float, 16>);
        if (mesh.thin_pick_group && mesh.thin_pick_uniform_buffer == state.pick_mesh_buffer &&
            mesh.thin_pick_instances == mesh.instances && mesh.thin_pick_bound_size == bound_size)
            continue;
        mesh.release_thin_pick_group();
        std::array<WGPUBindGroupEntry, 2> entries{};
        for (WGPUBindGroupEntry& entry : entries) {
            entry = WGPU_BIND_GROUP_ENTRY_INIT;
        }
        entries[0].binding = 0;
        entries[0].buffer = state.pick_mesh_buffer;
        entries[0].size = sizeof(DawnPickMeshUniforms);
        entries[1].binding = 1;
        entries[1].buffer = mesh.instances;
        entries[1].size = bound_size;
        WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group.layout = state.pick_thin_layout;
        group.entryCount = entries.size();
        group.entries = entries.data();
        mesh.thin_pick_group = wgpuDeviceCreateBindGroup(state.device, &group);
        if (!mesh.thin_pick_group) {
            dawn_error("pick thin bind group");
        }
        mesh.thin_pick_uniform_buffer = state.pick_mesh_buffer;
        mesh.thin_pick_instances = mesh.instances;
        mesh.thin_pick_bound_size = bound_size;
    }
#endif

#if BBLITE_HAS_SPLATS
    // The clouds and their sorted order buffers are the frame loop's:
    // its upload phase creates each pass and brings the sort current
    // before the drain a pick can arrive on, and a scene that picks
    // sooner than one elapsed frame yields sooner than the pin's own
    // `firstSortReady` scene does. The pick only reads.
    if (!state.splat_passes.empty() && !state.pick_cloud_pipeline) {
        // Group 2 of the pin's cloud pick module: the id colour block.
        constexpr std::array<DawnLayoutStage, 2> cloud_stages{{
            {"picking-splat.vert", WGPUShaderStage_Vertex},
            {"picking-splat.frag", WGPUShaderStage_Fragment},
        }};
        state.pick_cloud_color_layout = create_dawn_reflected_layout(state.device, cloud_stages, 2);
        state.pick_cloud_pipeline = create_dawn_pick_cloud_pipeline(
            state.device, state.pick_scene_layout, state.splat_passes[0].layout,
            state.pick_cloud_color_layout);
        const auto uniform_pair = [&](std::uint64_t size, WGPUBindGroupLayout layout,
                                      WGPUBuffer& buffer, WGPUBindGroup& group) {
            WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            descriptor.size = size;
            buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = 0;
            entry.buffer = buffer;
            entry.size = size;
            WGPUBindGroupDescriptor descriptor_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            descriptor_group.layout = layout;
            descriptor_group.entryCount = 1;
            descriptor_group.entries = &entry;
            group = wgpuDeviceCreateBindGroup(state.device, &descriptor_group);
        };
        uniform_pair(64, state.pick_scene_layout, state.pick_cloud_shear,
                     state.pick_cloud_shear_group);
        uniform_pair(16, state.pick_cloud_color_layout, state.pick_cloud_color,
                     state.pick_cloud_color_group);
    }
    // One cloud per pick: the shear and the id colour are single
    // buffers, so a second cloud would need the same dynamic-offset
    // treatment the mesh blocks get. No reached scene loads two.
    if (pick_sources && state.splat_passes.size() > 1) {
        throw std::runtime_error("Picking more than one Gaussian cloud needs a per-cloud "
                                 "id buffer; the reached slice loads one.");
    }
    for (DawnSplatPass& splat : state.splat_passes) {
        if (!pick_sources)
            break;
        // Refresh data before encoding, retaining the last frame's order.
        sync_dawn_splat_data(state.queue, handle_at(engine.splat_meshes, splat.mesh), splat);
        std::array<float, 16> shear{};
        compute_cloud_pick_matrix(shear, pointer.sample_x, pointer.sample_y, pointer.w, pointer.h);
        wgpuQueueWriteBuffer(state.queue, state.pick_cloud_shear, 0, shear.data(),
                             shear.size() * sizeof(float));
        const std::array<float, 3> color = encode_pick_id_to_color(next_id);
        const std::array<float, 4> picking_block{color[0], color[1], color[2], 0.0f};
        wgpuQueueWriteBuffer(state.queue, state.pick_cloud_color, 0, picking_block.data(),
                             picking_block.size() * sizeof(float));
        ranges.push_back({next_id, PickedNodeKind::splat_mesh, splat.mesh.value});
        ++next_id;
    }
#endif
#if BBLITE_HAS_BILLBOARDS
    // The last contributor in the pin's own order: meshes own 1..M,
    // then each registered pick source's contiguous range. Its blocks
    // are written here for the same reason the mesh blocks above are
    // -- WebGPU forbids a queue write between draws inside a pass.
    if (pick_sources) {
        billboard_pick.prepare(state.device, state.queue, state.pick_scene_layout, engine, scene,
                               upstream::build_view_matrix(upstream::camera_world_matrix(camera)),
                               ranges, next_id);
    }
#endif

    WGPUCommandEncoderDescriptor encoder_descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state.device, &encoder_descriptor)};

    std::array<WGPURenderPassColorAttachment, pick_color_targets> attachments{};
    for (std::size_t index = 0; index < attachments.size(); ++index) {
        const auto& clear = pick_color_clears[index];
        attachments[index] = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachments[index].loadOp = WGPULoadOp_Clear;
        attachments[index].storeOp = WGPUStoreOp_Store;
        attachments[index].clearValue = WGPUColor{clear[0], clear[1], clear[2], clear[3]};
    }
    attachments[0].view = state.pick_targets.color_view;
    attachments[1].view = state.pick_targets.depth_color_view;
#if BBLITE_HAS_DETAILED_PICKING
    attachments[2].view = state.pick_targets.detail_view;
#endif
    // The detail attachment only when the pick is detailed.
    const std::size_t attachment_count = detailed ? 3u : 2u;

    WGPURenderPassDepthStencilAttachment depth_attachment =
        WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    depth_attachment.view = state.pick_targets.depth_view;
    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
    depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
    depth_attachment.depthClearValue = static_cast<float>(pick_depth_clear);

    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = attachment_count;
    pass_descriptor.colorAttachments = attachments.data();
    pass_descriptor.depthStencilAttachment = &depth_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};

    wgpuRenderPassEncoderSetPipeline(pass,
#if BBLITE_HAS_DETAILED_PICKING
                                     detailed ? state.pick_detailed_pipeline :
#endif
                                              state.pick_mesh_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, state.pick_scene_group, 0, nullptr);
#if BBLITE_GPU_INSTANCING
    bool regular_pick_pipeline_bound = true;
#endif
#if BBLITE_DEFORM_PICKING
    // The projection's per-mesh group. Built here rather than inside
    // the loop only so every one of them is released together; the
    // pin builds its own the same way, from the pose the frame has
    // already uploaded.
    std::vector<WGPUBindGroup> deform_groups(blocks.size(), nullptr);
    int deform_bound = -1;
    const std::size_t deform_mode =
#if BBLITE_HAS_DETAILED_PICKING
        detailed ? 1u :
#endif
                 0u;
#endif
    for (std::size_t index = 0; index < blocks.size(); ++index) {
        const DawnMesh& mesh = pick_meshes[candidates[index].item_index];
        const std::uint32_t offset =
            static_cast<std::uint32_t>(index * sizeof(DawnPickMeshUniforms));
#if BBLITE_GPU_INSTANCING
        if (candidates[index].thin) {
            wgpuRenderPassEncoderSetPipeline(pass, state.pick_thin_pipeline);
            wgpuRenderPassEncoderSetBindGroup(pass, 0, state.pick_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(pass, 1, mesh.thin_pick_group, 1, &offset);
            wgpuRenderPassEncoderSetVertexBuffer(pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(pass, mesh.indices, WGPUIndexFormat_Uint32, 0,
                                                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, mesh.index_count,
                           candidates[index].instance_count, 0, 0, 0);
            regular_pick_pipeline_bound = false;
            continue;
        }
        if (!regular_pick_pipeline_bound) {
            wgpuRenderPassEncoderSetPipeline(pass,
#if BBLITE_HAS_DETAILED_PICKING
                                             detailed ? state.pick_detailed_pipeline :
#endif
                                                      state.pick_mesh_pipeline);
            wgpuRenderPassEncoderSetBindGroup(pass, 0, state.pick_scene_group, 0, nullptr);
            regular_pick_pipeline_bound = true;
#if BBLITE_DEFORM_PICKING
            deform_bound = -1;
#endif
        }
#endif
#if BBLITE_DEFORM_PICKING
        const int deform_draw = candidates[index].deform;
        const auto* deform_program =
            deform_draw >= 0 ? &state.pick_deform_programs[static_cast<std::size_t>(deform_draw)]
                             : nullptr;
        if (deform_draw != deform_bound) {
            deform_bound = deform_draw;
            wgpuRenderPassEncoderSetPipeline(
                pass, deform_program ? deform_program->pipelines[deform_mode] :
#if BBLITE_HAS_DETAILED_PICKING
                      detailed ? state.pick_detailed_pipeline
                               :
#endif
                               state.pick_mesh_pipeline);
            wgpuRenderPassEncoderSetBindGroup(pass, 0, state.pick_scene_group, 0, nullptr);
        }
        if (deform_program) {
            const auto& variant =
                upstream::pick_deform_variants[static_cast<std::size_t>(deform_draw)];
            std::array<WGPUBindGroupEntry, 3> entries{};
            std::size_t entry_count = 0;
            bool pose_bound = true;
            const auto append = [&]() -> WGPUBindGroupEntry& {
                auto& entry = entries[entry_count];
                entry = WGPU_BIND_GROUP_ENTRY_INIT;
                entry.binding = static_cast<std::uint32_t>(entry_count++);
                return entry;
            };
            if (variant.skeleton) {
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
                auto& entry = append();
                entry.textureView = mesh.pinned_bone_view;
                pose_bound = entry.textureView != nullptr;
#else
                dawn_error("deformation pick has no bone palette transport");
#endif
            }
#if BBLITE_DEFORM_PICKING_MORPH
            if (variant.morph) {
                auto& deltas = append();
                deltas.buffer = mesh.morph_deltas;
                deltas.size = WGPU_WHOLE_SIZE;
                auto& weights = append();
                weights.buffer = mesh.morph_weights;
                weights.size = WGPU_WHOLE_SIZE;
                pose_bound = pose_bound && deltas.buffer != nullptr && weights.buffer != nullptr;
            }
#endif
            if (!pose_bound) {
                dawn_error("a deforming pick candidate reached the pass "
                           "without the pose the projection samples");
            }
            WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            group.layout = deform_program->layout;
            group.entryCount = static_cast<std::uint32_t>(entry_count);
            group.entries = entries.data();
            deform_groups[index] = wgpuDeviceCreateBindGroup(state.device, &group);
            if (!deform_groups[index]) {
                dawn_error("pick deform bind group");
            }
            wgpuRenderPassEncoderSetBindGroup(pass, 2, state.pick_deform_empty_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(pass, 3, deform_groups[index], 0, nullptr);
        }
#endif
        wgpuRenderPassEncoderSetBindGroup(pass, 1, state.pick_mesh_group, 1, &offset);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(pass, mesh.indices, WGPUIndexFormat_Uint32, 0,
                                            WGPU_WHOLE_SIZE);
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, mesh.index_count, 1, 0, 0, 0);
    }
#if BBLITE_HAS_SPLATS
    for (const DawnSplatPass& splat : state.splat_passes) {
        if (!pick_sources)
            break;
        if (splat.vertex_count == 0)
            continue;
        wgpuRenderPassEncoderSetPipeline(pass, state.pick_cloud_pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, state.pick_cloud_shear_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(pass, 1, splat.group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(pass, 2, state.pick_cloud_color_group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0, splat.quad, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 1, splat.order, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(pass, splat.indices, WGPUIndexFormat_Uint16, 0,
                                            WGPU_WHOLE_SIZE);
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass,
                       static_cast<std::uint32_t>(upstream::splat_quad_indices.size()),
                       splat.vertex_count, 0, 0, 0);
    }
#endif
#if BBLITE_HAS_BILLBOARDS
    if (pick_sources) {
        billboard_pick.record(pass, state.pick_scene_group);
    }
#endif
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
#if BBLITE_DEFORM_PICKING
    for (WGPUBindGroup group : deform_groups) {
        if (group)
            wgpuBindGroupRelease(group);
    }
#endif

    WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    source.texture = state.pick_targets.color;
    WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    destination.buffer = state.pick_targets.staging;
    destination.layout.bytesPerRow = pick_readback_row;
    destination.layout.rowsPerImage = 1;
    const WGPUExtent3D one{1, 1, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &one);
    source.texture = state.pick_targets.depth_color;
    destination.layout.offset = pick_depth_offset;
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &one);
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed) {
        source.texture = state.pick_targets.detail;
        destination.layout.offset = pick_detail_offset;
        wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &one);
    }
#endif

    WGPUCommandBufferDescriptor finish = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
    DawnCommandBuffer commands{wgpuCommandEncoderFinish(encoder, &finish)};
    submit_dawn_command(state.queue, commands);
    commands.reset();
    encoder.reset();

    WGPUBufferMapCallbackInfo map_callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    // Recorded rather than thrown: the callback runs inside
    // `wgpuInstanceWaitAny`, so an exception would unwind through
    // Dawn's own C frame. Every other wait in this backend reports a
    // map failure the same way.
    map_callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1,
                               void*) {
        if (status != WGPUMapAsyncStatus_Success) {
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty())
                *error = view_text(message);
        }
    };
    map_callback.userdata1 = &state.uncaptured_error;
    wait_for(state.instance, wgpuBufferMapAsync(state.pick_targets.staging, WGPUMapMode_Read, 0,
                                                pick_staging_bytes, map_callback));
    if (!state.uncaptured_error.empty()) {
        dawn_error("pick buffer map failed: " + state.uncaptured_error);
    }
    const void* mapped =
        wgpuBufferGetConstMappedRange(state.pick_targets.staging, 0, pick_staging_bytes);
    if (!mapped)
        dawn_error("pick map returned no data.");
    const PickReadback readback =
        decode_pick_readback(static_cast<const std::uint8_t*>(mapped), detailed);
    wgpuBufferUnmap(state.pick_targets.staging);
    return resolve_gpu_pick(engine, *request, ranges, readback);
}
#endif

} // namespace bbl::pal
