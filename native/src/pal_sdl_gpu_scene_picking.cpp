// SDL_GPU scene picking: the pick pipelines and the scene pick. Dawn's
// twin is pal_dawn_scene_picking.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_vertex.hpp"
#include "pal_gpu_picking.hpp"
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_splats.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {

#if BBLITE_HAS_PICKING
void ensure_pick_pipelines(GpuState& state) {
    if (state.pick_mesh_pipeline)
        return;

    const PinnedStageSlots vertex_slots = read_pinned_stage_slots("picking.vert");
    const PinnedStageSlots fragment_slots = read_pinned_stage_slots("picking.frag");
    state.pick_mesh_scene_slot = stage_uniform_slot(vertex_slots, "scene");
    state.pick_mesh_uniform_slot = stage_uniform_slot(vertex_slots, "mesh");
    if (state.pick_mesh_scene_slot < 0 || state.pick_mesh_uniform_slot < 0) {
        gpu_error("picking.vert kept neither the scene nor the mesh block");
    }
    // Read rather than assumed equal to the vertex stage's: the pin's
    // fragment reads `scene.fragmentCoord` through the default discard
    // predicate and takes the id as a flat varying, so it keeps one block
    // where the vertex stage keeps two.
    state.pick_frag_scene_slot = stage_uniform_slot(fragment_slots, "scene");
    state.pick_frag_mesh_slot = stage_uniform_slot(fragment_slots, "mesh");

    auto vertex_shader =
        load_shader(state.device, "picking.vert", SDL_GPU_SHADERSTAGE_VERTEX, vertex_slots);
    auto fragment_shader =
        load_shader(state.device, "picking.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, fragment_slots);

    // The renderer's interleaved stream read at its own pitch: the pin
    // binds a position-only buffer, and these are the same numbers.
    SDL_GPUVertexBufferDescription vertex_buffer{};
    vertex_buffer.slot = 0;
    vertex_buffer.pitch = sizeof(GpuVertex);
    vertex_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    SDL_GPUVertexAttribute position{};
    position.location = 0;
    position.buffer_slot = 0;
    position.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
    position.offset = 0;

    SDL_GPUColorTargetDescription color_targets[2]{};
    color_targets[0].format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    color_targets[1].format = SDL_GPU_TEXTUREFORMAT_R32_FLOAT;

    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    info.vertex_input_state.vertex_buffer_descriptions = &vertex_buffer;
    info.vertex_input_state.num_vertex_buffers = 1;
    info.vertex_input_state.vertex_attributes = &position;
    info.vertex_input_state.num_vertex_attributes = 1;
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    info.depth_stencil_state.enable_depth_test = true;
    info.depth_stencil_state.enable_depth_write = true;
    info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_GREATER;
    info.target_info.color_target_descriptions = color_targets;
    info.target_info.num_color_targets = 2;
    info.target_info.depth_stencil_format = SDL_GPU_TEXTUREFORMAT_D24_UNORM;
    info.target_info.has_depth_stencil_target = true;

    state.pick_mesh_pipeline = create_sdl_gpu_graphics_pipeline(state.device, vertex_shader, &info);
    vertex_shader.reset();
    fragment_shader.reset();
    if (!state.pick_mesh_pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline picking");
    }

#if BBLITE_GPU_INSTANCING
    // `gpu-picker.ts` selects the advanced pipeline when a candidate owns
    // thin instances. This is that pipeline's affine/no-discard arm, composed
    // by the pin's `pickingThinInstanceShaderSource({})` builder.
    const PinnedStageSlots thin_vertex_slots = read_pinned_stage_slots("picking-thin.vert");
    const PinnedStageSlots thin_fragment_slots = read_pinned_stage_slots("picking-thin.frag");
    state.pick_thin_scene_slot = stage_uniform_slot(thin_vertex_slots, "scene");
    state.pick_thin_uniform_slot = stage_uniform_slot(thin_vertex_slots, "tiMesh");
    state.pick_thin_frag_scene_slot = stage_uniform_slot(thin_fragment_slots, "scene");
    state.pick_thin_frag_mesh_slot = stage_uniform_slot(thin_fragment_slots, "tiMesh");
    if (state.pick_thin_scene_slot < 0 || state.pick_thin_uniform_slot < 0 ||
        thin_vertex_slots.storage.size() != 1 || thin_vertex_slots.storage[0] != "instances") {
        gpu_error("picking-thin.vert kept neither its scene, mesh nor instance block");
    }

    auto thin_vertex = load_shader(state.device, "picking-thin.vert", SDL_GPU_SHADERSTAGE_VERTEX,
                                   thin_vertex_slots);
    auto thin_fragment = load_shader(state.device, "picking-thin.frag",
                                     SDL_GPU_SHADERSTAGE_FRAGMENT, thin_fragment_slots);
    SDL_GPUGraphicsPipelineCreateInfo thin_info = info;
    thin_info.vertex_shader = thin_vertex.get();
    thin_info.fragment_shader = thin_fragment.get();
    state.pick_thin_pipeline =
        create_sdl_gpu_graphics_pipeline(state.device, thin_vertex, &thin_info);
    thin_vertex.reset();
    thin_fragment.reset();
    if (!state.pick_thin_pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline picking-thin");
    }
#endif

#if BBLITE_HAS_DETAILED_PICKING
    // The pin's second picking module, drawn instead of the first when
    // `enableDetailedPicking` armed the picker. Everything but the target
    // list and the stages is the basic pipeline's, so `info` is reused:
    // the same interleaved position stream, the same reverse-Z GREATER
    // test, the same single sample.
    const PinnedStageSlots detailed_vertex_slots = read_pinned_stage_slots("picking-detailed.vert");
    const PinnedStageSlots detailed_fragment_slots =
        read_pinned_stage_slots("picking-detailed.frag");
    state.pick_detailed_scene_slot = stage_uniform_slot(detailed_vertex_slots, "scene");
    state.pick_detailed_uniform_slot = stage_uniform_slot(detailed_vertex_slots, "mesh");
    if (state.pick_detailed_scene_slot < 0 || state.pick_detailed_uniform_slot < 0) {
        gpu_error("picking-detailed.vert kept neither the scene nor the mesh "
                  "block");
    }
    state.pick_detailed_frag_scene_slot = stage_uniform_slot(detailed_fragment_slots, "scene");
    state.pick_detailed_frag_mesh_slot = stage_uniform_slot(detailed_fragment_slots, "mesh");

    auto detailed_vertex = load_shader(state.device, "picking-detailed.vert",
                                       SDL_GPU_SHADERSTAGE_VERTEX, detailed_vertex_slots);
    auto detailed_fragment = load_shader(state.device, "picking-detailed.frag",
                                         SDL_GPU_SHADERSTAGE_FRAGMENT, detailed_fragment_slots);

    SDL_GPUColorTargetDescription detailed_targets[3]{};
    detailed_targets[0].format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    detailed_targets[1].format = SDL_GPU_TEXTUREFORMAT_R32_FLOAT;
    detailed_targets[2].format = SDL_GPU_TEXTUREFORMAT_R32G32B32A32_UINT;

    SDL_GPUGraphicsPipelineCreateInfo detailed_info = info;
    detailed_info.vertex_shader = detailed_vertex.get();
    detailed_info.fragment_shader = detailed_fragment.get();
    detailed_info.target_info.color_target_descriptions = detailed_targets;
    detailed_info.target_info.num_color_targets = 3;

    state.pick_detailed_pipeline =
        create_sdl_gpu_graphics_pipeline(state.device, detailed_vertex, &detailed_info);
    detailed_vertex.reset();
    detailed_fragment.reset();
    if (!state.pick_detailed_pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline picking-detailed");
    }

#endif
#if BBLITE_DEFORM_PICKING
    // The pin's projection changes the vertex stage and its input layout;
    // each mode retains its own affine fragment and attachment contract.
    std::array<SDL_GPUVertexAttribute, 3> deform_attributes{};
    deform_attributes[0] = {0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0};
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    deform_attributes[1] = {1, 0, SDL_GPU_VERTEXELEMENTFORMAT_UINT4,
                            static_cast<Uint32>(offsetof(GpuVertex, joint_indices))};
    deform_attributes[2] = {2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                            static_cast<Uint32>(offsetof(GpuVertex, weights))};
#endif
    for (std::size_t index = 0; index < upstream::pick_deform_variants.size(); ++index) {
        const auto& variant = upstream::pick_deform_variants[index];
        for (std::size_t mode = 0; mode < 2; ++mode) {
            const char* stem = mode == 0 ? variant.vertex : variant.detailed_vertex;
            if (!stem)
                continue;
            auto& program = state.pick_deform_programs[index][mode];
            program.vertex_slots = read_pinned_stage_slots(stem);
            program.scene_slot = stage_uniform_slot(program.vertex_slots, "scene");
            program.mesh_slot = stage_uniform_slot(program.vertex_slots, "mesh");
            if (program.scene_slot < 0 || program.mesh_slot < 0) {
                gpu_error("deformation pick projection kept neither its scene nor mesh block");
            }
            auto deform_vertex =
                load_shader(state.device, stem, SDL_GPU_SHADERSTAGE_VERTEX, program.vertex_slots);
            const char* fragment_stem = mode == 0 ? "picking.frag" : "picking-detailed.frag";
            auto deform_fragment =
                load_pinned_stage(state.device, fragment_stem, SDL_GPU_SHADERSTAGE_FRAGMENT).shader;
            SDL_GPUGraphicsPipelineCreateInfo deform_info =
#if BBLITE_HAS_DETAILED_PICKING
                mode == 1 ? detailed_info :
#endif
                          info;
            deform_info.vertex_shader = deform_vertex.get();
            deform_info.fragment_shader = deform_fragment.get();
            deform_info.vertex_input_state.vertex_attributes = deform_attributes.data();
            deform_info.vertex_input_state.num_vertex_attributes = variant.skeleton ? 3u : 1u;
            program.pipeline =
                create_sdl_gpu_graphics_pipeline(state.device, deform_vertex, &deform_info);
            if (!program.pipeline)
                gpu_error("SDL_CreateGPUGraphicsPipeline deformation pick");
        }
    }
#endif

#if BBLITE_HAS_SPLATS
    const PinnedStageSlots cloud_vertex_slots = read_pinned_stage_slots("picking-splat.vert");
    const PinnedStageSlots cloud_fragment_slots = read_pinned_stage_slots("picking-splat.frag");
    state.pick_cloud_scene_slot = stage_uniform_slot(cloud_vertex_slots, "gsPickScene");
    state.pick_cloud_mesh_slot = stage_uniform_slot(cloud_vertex_slots, "u");
    state.pick_cloud_color_slot = stage_uniform_slot(cloud_fragment_slots, "picking");
    if (state.pick_cloud_scene_slot < 0 || state.pick_cloud_mesh_slot < 0 ||
        state.pick_cloud_color_slot < 0) {
        gpu_error("picking-splat kept neither the shear, the cloud block nor "
                  "the pick colour");
    }

    auto cloud_vertex = load_shader(state.device, "picking-splat.vert", SDL_GPU_SHADERSTAGE_VERTEX,
                                    cloud_vertex_slots);
    auto cloud_fragment = load_shader(state.device, "picking-splat.frag",
                                      SDL_GPU_SHADERSTAGE_FRAGMENT, cloud_fragment_slots);

    // The pin's own two streams: the unit quad, and the sorted splat index
    // per instance.
    SDL_GPUVertexBufferDescription cloud_buffers[2]{};
    cloud_buffers[0].slot = 0;
    cloud_buffers[0].pitch = sizeof(float) * 2;
    cloud_buffers[0].input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    cloud_buffers[1].slot = 1;
    cloud_buffers[1].pitch = sizeof(float);
    cloud_buffers[1].input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
    SDL_GPUVertexAttribute cloud_attributes[2]{};
    cloud_attributes[0].location = 0;
    cloud_attributes[0].buffer_slot = 0;
    cloud_attributes[0].format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
    cloud_attributes[1].location = 1;
    cloud_attributes[1].buffer_slot = 1;
    cloud_attributes[1].format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT;

    SDL_GPUGraphicsPipelineCreateInfo cloud_info = info;
    cloud_info.vertex_shader = cloud_vertex.get();
    cloud_info.fragment_shader = cloud_fragment.get();
    cloud_info.vertex_input_state.vertex_buffer_descriptions = cloud_buffers;
    cloud_info.vertex_input_state.num_vertex_buffers = 2;
    cloud_info.vertex_input_state.vertex_attributes = cloud_attributes;
    cloud_info.vertex_input_state.num_vertex_attributes = 2;
    cloud_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;

    state.pick_cloud_pipeline =
        create_sdl_gpu_graphics_pipeline(state.device, cloud_vertex, &cloud_info);
    if (!state.pick_cloud_pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline picking-splat");
    }
#endif
}
#endif

#if BBLITE_HAS_PICKING && BBLITE_HAS_SPLATS
void record_cloud_pick_draw(SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                            const GpuState& state, const Engine& engine, const SplatPass& splat,
                            const CameraRecord& camera, std::uint32_t pick_id, double sample_x,
                            double sample_y, double width, double height) {
    if (splat.vertex_count == 0)
        return;
    const SplatMeshRecord& record = handle_at(engine.splat_meshes, splat.mesh);
    SDL_BindGPUGraphicsPipeline(pass, state.pick_cloud_pipeline);

    std::array<float, 16> shear{};
    compute_cloud_pick_matrix(shear, sample_x, sample_y, width, height);
    SdlGpuWriteDevice{}.write_vertex_uniform(
        command, static_cast<Uint32>(state.pick_cloud_scene_slot), shear.data(),
        static_cast<Uint32>(shear.size() * sizeof(float)));

    upstream::SplatUniforms uniforms;
    upstream::write_splat_uniforms(
        uniforms, upstream::build_splat_world(record),
        upstream::build_view_matrix(upstream::camera_world_matrix(camera)),
        upstream::build_scene_projection(camera, width / height), width, height,
        record.texture_width, record.texture_height);
    SdlGpuWriteDevice{}.write_vertex_uniform(
        command, static_cast<Uint32>(state.pick_cloud_mesh_slot), &uniforms, sizeof(uniforms));

    const std::array<float, 3> color = encode_pick_id_to_color(pick_id);
    const std::array<float, 4> picking_block{color[0], color[1], color[2], 0.0f};
    SdlGpuWriteDevice{}.write_fragment_uniform(
        command, static_cast<Uint32>(state.pick_cloud_color_slot), picking_block.data(),
        static_cast<Uint32>(picking_block.size() * sizeof(float)));

    SDL_GPUBufferBinding vertex_bindings[2]{};
    vertex_bindings[0].buffer = splat.quad;
    vertex_bindings[1].buffer = splat.order;
    SDL_BindGPUVertexBuffers(pass, 0, vertex_bindings, 2);
    SDL_GPUBufferBinding index_binding{};
    index_binding.buffer = splat.indices;
    SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);
    SDL_BindGPUVertexSamplers(pass, 0, splat.textures.data(),
                              static_cast<Uint32>(splat.textures.size()));
    count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass,
                   static_cast<Uint32>(upstream::splat_quad_indices.size()), splat.vertex_count, 0,
                   0, 0);
}
#endif

#if (BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING)
PickingInfo pick_sdl_gpu_scene(GpuState& state, Engine& engine,
                               const upstream::RenderPlan& root_plan,
                               const std::vector<upstream::RenderPlan>& overlay_plans,
                               const std::vector<std::shared_ptr<Scene>>& active_registered_scenes,
                               [[maybe_unused]] GpuPickerHandle picker, double x, double y,
                               const Engine::PickFilter* filter
#if BBLITE_HAS_BILLBOARDS
                               ,
                               BillboardPickContributor& billboard_pick
#endif
) {
    const auto layer = picker_scene_index(engine, picker, active_registered_scenes);
    if (!layer)
        return PickingInfo{};
    const Scene& scene = *active_registered_scenes[*layer];
    const auto& render_plan = *layer == 0 ? root_plan : overlay_plans[*layer - 1];
    auto& pick_meshes = *layer == 0 ? state.meshes : state.overlay_meshes[*layer - 1];
    // The pin's preamble -- camera, pointer mapping, scene block -- is
    // shared with the Dawn pick (shared GPU helpers).
    const std::optional<PickRequest> request = prepare_gpu_pick(engine, picker, scene, x, y);
    if (!request)
        return PickingInfo{};
#if BBLITE_HAS_DETAILED_PICKING
    const bool detailed = request->detailed;
#else
    constexpr bool detailed = false;
#endif
    [[maybe_unused]] const upstream::PickPointer& pointer = request->pointer;

    ensure_pick_targets(state.device, state.pick_targets);
    ensure_pick_pipelines(state);

#if BBLITE_HAS_SPLATS
    // Source updateData writes its existing textures immediately;
    // submit those copies before opening the pick command buffer.
    for (SplatPass& splat : state.splat_passes) {
        sync_splat_data(state.device, handle_at(engine.splat_meshes, splat.mesh), splat);
    }
#endif

    const PickSceneUniforms& scene_uniforms = request->scene_uniforms;

#if BBLITE_HAS_BILLBOARDS
    // Before the pick command buffer exists, because the instance
    // upload submits one of its own -- the same ordering the frame
    // loop's billboard upload takes.
    billboard_pick.prepare(state.device, engine, scene);
#endif

    // Ids start at 1 so that 0 stays "nothing", which is what the
    // cleared colour attachment reads back as.
    std::uint32_t next_id = 1;
    std::vector<PickRange> ranges;
    // The shared collector owns the plan walk, the generated pick
    // predicate and the id/range assignment; only "does this row
    // have GPU buffers" is answered here.
    const std::vector<PickMeshCandidate> candidates = collect_pick_mesh_candidates(
        engine, scene, render_plan, pick_meshes.size(),
        [&](std::size_t item_index) {
            const GpuMesh& gpu = pick_meshes[item_index];
            return gpu.vertices && gpu.indices;
        },
        ranges, next_id, filter, detailed);
    // `pickAsyncImpl` takes no pick source under a supplied filter.
    [[maybe_unused]] const bool pick_sources = filter == nullptr;
    validate_pick_contributors(engine, scene, detailed, pick_sources);

#if BBLITE_DEFORM_PICKING
    GpuBufferUploadBatch pose_uploads(state.device);
    for (const auto& candidate : candidates) {
        if (candidate.deform < 0)
            continue;
        const auto& item = render_plan.items[candidate.item_index];
        const auto& record = handle_at(engine.meshes, item.mesh);
        auto& gpu = pick_meshes[candidate.item_index];
#if BBLITE_DEFORM_PICKING_MORPH
        sync_morph_weights(pose_uploads, gpu, engine.geometries[item.geometry], record);
#endif
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
        if (record.skinned)
            write_pinned_bone_texture(state, gpu, record);
#endif
    }
    // Queue uploads before recording the pick so SDL buffer cycling
    // cannot leave a draw bound to the previous weight storage.
    pose_uploads.submit();
#endif

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(state.device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer pick");

    SDL_GPUColorTargetInfo color_targets[pick_color_targets]{};
    color_targets[0].texture = state.pick_targets.color;
    color_targets[1].texture = state.pick_targets.depth_color;
#if BBLITE_HAS_DETAILED_PICKING
    color_targets[2].texture = state.pick_targets.detail;
#endif
    // The detail attachment only when the pick is detailed; the clears are
    // the pin's (`pick_color_clears`). SDL states a clear as float, so
    // the detail lane's 0xffffffff rounds here, where it is visible.
    const Uint32 color_target_count = detailed ? 3u : 2u;
    for (Uint32 index = 0; index < color_target_count; ++index) {
        const auto& clear = pick_color_clears[index];
        color_targets[index].load_op = SDL_GPU_LOADOP_CLEAR;
        color_targets[index].store_op = SDL_GPU_STOREOP_STORE;
        color_targets[index].clear_color = {
            static_cast<float>(clear[0]), static_cast<float>(clear[1]),
            static_cast<float>(clear[2]), static_cast<float>(clear[3])};
    }

    SDL_GPUDepthStencilTargetInfo depth_target{};
    depth_target.texture = state.pick_targets.depth;
    depth_target.load_op = SDL_GPU_LOADOP_CLEAR;
    depth_target.store_op = SDL_GPU_STOREOP_DONT_CARE;
    depth_target.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    depth_target.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
    depth_target.clear_depth = static_cast<float>(pick_depth_clear);
    depth_target.cycle = true;

    SdlRenderPass pass{
        SDL_BeginGPURenderPass(command, color_targets, color_target_count, &depth_target)};
    if (!pass)
        gpu_error("SDL_BeginGPURenderPass pick");

#if BBLITE_HAS_DETAILED_PICKING
    const int mesh_scene_slot =
        detailed ? state.pick_detailed_scene_slot : state.pick_mesh_scene_slot;
    const int mesh_uniform_slot =
        detailed ? state.pick_detailed_uniform_slot : state.pick_mesh_uniform_slot;
    const int frag_scene_slot =
        detailed ? state.pick_detailed_frag_scene_slot : state.pick_frag_scene_slot;
    const int frag_mesh_slot =
        detailed ? state.pick_detailed_frag_mesh_slot : state.pick_frag_mesh_slot;
    SDL_BindGPUGraphicsPipeline(pass,
                                detailed ? state.pick_detailed_pipeline : state.pick_mesh_pipeline);
#else
    const int mesh_scene_slot = state.pick_mesh_scene_slot;
    const int mesh_uniform_slot = state.pick_mesh_uniform_slot;
    const int frag_scene_slot = state.pick_frag_scene_slot;
    const int frag_mesh_slot = state.pick_frag_mesh_slot;
    SDL_BindGPUGraphicsPipeline(pass, state.pick_mesh_pipeline);
#endif
    // Loop-invariant: pushed uniform state persists across draws,
    // and every cloud draw below rebinds its own slots.
    SdlGpuWriteDevice{}.write_vertex_uniform(command, static_cast<Uint32>(mesh_scene_slot),
                                             &scene_uniforms, sizeof(scene_uniforms));
    push_stage_uniform(command, frag_scene_slot, &scene_uniforms, sizeof(scene_uniforms));
#if BBLITE_GPU_INSTANCING
    bool regular_pick_pipeline_bound = true;
#endif
#if BBLITE_DEFORM_PICKING
    // Which pipeline is bound right now. The pass draws two
    // programs -- the affine projection and the pin's deform one
    // -- so the bind and the scene block that follows it move
    // with the candidate rather than sitting above the loop.
    int deform_bound = -1;
    const std::size_t deform_mode =
#if BBLITE_HAS_DETAILED_PICKING
        detailed ? 1u :
#endif
                 0u;
#endif
    for (const PickMeshCandidate& candidate : candidates) {
        const GpuMesh& gpu = pick_meshes[candidate.item_index];
#if BBLITE_GPU_INSTANCING
        if (candidate.thin) {
#if BBLITE_HAS_DETAILED_PICKING
            if (detailed) {
                gpu_error("detailed thin-instance picking was not composed");
            }
#endif
            if (!gpu.instances) {
                gpu_error("a thin-instance pick candidate has no instance buffer");
            }
            SDL_BindGPUGraphicsPipeline(pass, state.pick_thin_pipeline);
            SdlGpuWriteDevice{}.write_vertex_uniform(
                command, static_cast<Uint32>(state.pick_thin_scene_slot), &scene_uniforms,
                sizeof(scene_uniforms));
            SdlGpuWriteDevice{}.write_vertex_uniform(
                command, static_cast<Uint32>(state.pick_thin_uniform_slot), &candidate.uniforms,
                sizeof(candidate.uniforms));
            push_stage_uniform(command, state.pick_thin_frag_scene_slot, &scene_uniforms,
                               sizeof(scene_uniforms));
            push_stage_uniform(command, state.pick_thin_frag_mesh_slot, &candidate.uniforms,
                               sizeof(candidate.uniforms));
            SDL_GPUBuffer* instance_storage = gpu.instances;
            SDL_BindGPUVertexStorageBuffers(pass, 0, &instance_storage, 1);
            SDL_GPUBufferBinding vertex_binding{};
            vertex_binding.buffer = gpu.vertices;
            SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
            SDL_GPUBufferBinding index_binding{};
            index_binding.buffer = gpu.indices;
            SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
            count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, gpu.index_count,
                           candidate.instance_count, 0, 0, 0);
            regular_pick_pipeline_bound = false;
            continue;
        }
        if (!regular_pick_pipeline_bound) {
            SDL_BindGPUGraphicsPipeline(pass,
#if BBLITE_HAS_DETAILED_PICKING
                                        detailed ? state.pick_detailed_pipeline :
#endif
                                                 state.pick_mesh_pipeline);
            SdlGpuWriteDevice{}.write_vertex_uniform(command, static_cast<Uint32>(mesh_scene_slot),
                                                     &scene_uniforms, sizeof(scene_uniforms));
            push_stage_uniform(command, frag_scene_slot, &scene_uniforms, sizeof(scene_uniforms));
            regular_pick_pipeline_bound = true;
#if BBLITE_DEFORM_PICKING
            deform_bound = -1;
#endif
        }
#endif
        int candidate_mesh_slot = mesh_uniform_slot;
#if BBLITE_DEFORM_PICKING
        const int deform_draw = candidate.deform;
        const auto* deform_program =
            deform_draw >= 0
                ? &state.pick_deform_programs[static_cast<std::size_t>(deform_draw)][deform_mode]
                : nullptr;
        if (deform_draw != deform_bound) {
            deform_bound = deform_draw;
            SDL_BindGPUGraphicsPipeline(pass, deform_program ? deform_program->pipeline :
#if BBLITE_HAS_DETAILED_PICKING
                                              detailed ? state.pick_detailed_pipeline
                                                       :
#endif
                                                       state.pick_mesh_pipeline);
            SdlGpuWriteDevice{}.write_vertex_uniform(
                command,
                static_cast<Uint32>(deform_program ? deform_program->scene_slot : mesh_scene_slot),
                &scene_uniforms, sizeof(scene_uniforms));
            push_stage_uniform(command, frag_scene_slot, &scene_uniforms, sizeof(scene_uniforms));
        }
        if (deform_program) {
            candidate_mesh_slot = deform_program->mesh_slot;
            // Reuse the visible draw's current pose resources, resolved
            // through this vertex stage's own reflected slot order.
            bind_stage_textures(
                pass, deform_program->vertex_slots, false, "deformation pick",
                [&](const std::string& name, std::size_t) -> SDL_GPUTextureSamplerBinding {
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
                    if (name == "boneSampler")
                        return {gpu.pinned_bone_texture, state.pinned_bone_sampler};
#endif
                    gpu_error(("unmapped deformation pick texture: " + name).c_str());
                });
            bind_stage_storage(pass, deform_program->vertex_slots, false, "deformation pick",
                               state.storage_binding_scratch,
                               [&](const std::string& name, std::size_t) -> SDL_GPUBuffer* {
                                   return morph_storage_buffer_for(gpu, name);
                               });
        }
#endif
        SdlGpuWriteDevice{}.write_vertex_uniform(command, static_cast<Uint32>(candidate_mesh_slot),
                                                 &candidate.uniforms, sizeof(candidate.uniforms));
        push_stage_uniform(command, frag_mesh_slot, &candidate.uniforms,
                           sizeof(candidate.uniforms));
        SDL_GPUBufferBinding vertex_binding{};
        vertex_binding.buffer = gpu.vertices;
        SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
        SDL_GPUBufferBinding index_binding{};
        index_binding.buffer = gpu.indices;
        SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, gpu.index_count, 1, 0, 0, 0);
    }
#if BBLITE_HAS_SPLATS
    for (const SplatPass& splat : state.splat_passes) {
        if (!pick_sources)
            break;
        record_cloud_pick_draw(command, pass, state, engine, splat, *request->camera, next_id,
                               pointer.sample_x, pointer.sample_y, pointer.w, pointer.h);
        ranges.push_back({next_id, PickedNodeKind::splat_mesh, splat.mesh.value});
        ++next_id;
    }
#endif
#if BBLITE_HAS_BILLBOARDS
    // The last contributor in the pin's own order: meshes own
    // 1..M, then each registered pick source's contiguous range.
    if (pick_sources) {
        billboard_pick.record(
            command, pass, engine, scene,
            upstream::build_view_matrix(upstream::camera_world_matrix(*request->camera)),
            scene_uniforms, ranges, next_id);
    }
#endif
    pass.end();

    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    SDL_GPUTextureRegion region{};
    region.w = 1;
    region.h = 1;
    region.d = 1;
    SDL_GPUTextureTransferInfo destination{};
    destination.transfer_buffer = state.pick_targets.staging;
    destination.pixels_per_row = 1;
    destination.rows_per_layer = 1;
    region.texture = state.pick_targets.color;
    destination.offset = 0;
    SDL_DownloadFromGPUTexture(copy, &region, &destination);
    region.texture = state.pick_targets.depth_color;
    destination.offset = pick_depth_offset;
    SDL_DownloadFromGPUTexture(copy, &region, &destination);
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed) {
        region.texture = state.pick_targets.detail;
        destination.offset = pick_detail_offset;
        SDL_DownloadFromGPUTexture(copy, &region, &destination);
    }
#endif
    copy.end();

    SDL_GPUFence* fence = command.submit_with_fence();
    if (!fence) {
        gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence pick");
    }
    if (!SDL_WaitForGPUFences(state.device, true, &fence, 1)) {
        SDL_ReleaseGPUFence(state.device, fence);
        gpu_error("SDL_WaitForGPUFences pick");
    }
    SDL_ReleaseGPUFence(state.device, fence);

    const auto* mapped = static_cast<const std::uint8_t*>(
        SDL_MapGPUTransferBuffer(state.device, state.pick_targets.staging, false));
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer pick");
    const PickReadback readback = decode_pick_readback(mapped, detailed);
    SDL_UnmapGPUTransferBuffer(state.device, state.pick_targets.staging);
    return resolve_gpu_pick(engine, *request, ranges, readback);
}
#endif

} // namespace bbl::pal
