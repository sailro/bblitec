// SDL_GPU material variants: the pinned PBR, node and Standard families'
// slots, resources, pipelines and draws. Dawn's twin is
// pal_dawn_scene_variants.cpp.
#include <bblite/features/has_clustered_lights.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_standard_uv_transform.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PINNED_MATERIALS
bool append_variant_attribute(std::string_view name, Uint32 location,
                              std::vector<SDL_GPUVertexAttribute>& attributes) {
    const PinnedVertexInput input = pinned_vertex_input(name);
    if (!input.mapped)
        return false;
    SDL_GPUVertexAttribute attribute{};
    attribute.location = location;
    attribute.buffer_slot = static_cast<Uint32>(input.stream);
    attribute.offset = static_cast<Uint32>(input.offset);
    switch (input.lane) {
    case VertexInputLane::float2:
        attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
        break;
    case VertexInputLane::float3:
        attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
        break;
    case VertexInputLane::float4:
        attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4;
        break;
    case VertexInputLane::uint4:
        attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_UINT4;
        break;
    }
    attributes.push_back(attribute);
    return true;
}

Uint32 fill_variant_vertex_buffers(
    const std::vector<SDL_GPUVertexAttribute>& attributes,
    std::array<SDL_GPUVertexBufferDescription, vertex_streams.size()>& buffers) {
    for (std::size_t index = 0; index < vertex_streams.size(); ++index) {
        const VertexInputStream stream = vertex_streams[index];
        buffers[index].slot = vertex_stream_slot(stream);
        buffers[index].pitch = static_cast<Uint32>(vertex_stream_stride(stream));
        buffers[index].input_rate = vertex_stream_is_instanced(stream)
                                        ? SDL_GPU_VERTEXINPUTRATE_INSTANCE
                                        : SDL_GPU_VERTEXINPUTRATE_VERTEX;
    }
    Uint32 used = 1;
    for (const SDL_GPUVertexAttribute& attribute : attributes) {
        used = std::max(used, attribute.buffer_slot + 1u);
    }
    return used;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PINNED_MATERIALS && BBLITE_SHADOW_RECEIVERS
const upstream::PinnedShadowBinding*
shadow_row_for(std::span<const upstream::PinnedShadowBinding> rows, const std::string& name) {
    for (const upstream::PinnedShadowBinding& row : rows) {
        if (name == row.name)
            return &row;
    }
    return nullptr;
}

const GpuState::ShadowGenerator&
shadow_generator_for_row(const GpuState& state, const upstream::PinnedShadowBinding& row) {
    const std::uint32_t handle = row.light < state.shadow_light_slots.size()
                                     ? state.shadow_light_slots[row.light]
                                     : invalid_handle;
    if (handle >= state.shadow_generators.size() ||
        state.shadow_generators[handle].info == nullptr) {
        gpu_error(("a composed shadow binding names light " + std::to_string(row.light) +
                   ", which carries no generator (handle " + std::to_string(handle) + ", slots " +
                   std::to_string(state.shadow_light_slots.size()) + ").")
                      .c_str());
    }
    return state.shadow_generators[handle];
}

const upstream::PinnedShadowBinding*
shadow_sampler_row_for(std::span<const upstream::PinnedShadowBinding> rows, std::uint32_t light) {
    for (const upstream::PinnedShadowBinding& row : rows) {
        if (row.light == light && row.role == upstream::PinnedShadowRole::map_sampler) {
            return &row;
        }
    }
    return nullptr;
}

PinnedStageShadowRows
resolve_stage_shadow_rows(const PinnedStageSlots& slots,
                          std::span<const upstream::PinnedShadowBinding> rows) {
    PinnedStageShadowRows resolved;
    const auto rows_for = [&](const std::vector<std::string>& names) {
        std::vector<const upstream::PinnedShadowBinding*> result;
        result.reserve(names.size());
        for (const std::string& name : names) {
            result.push_back(shadow_row_for(rows, name));
        }
        return result;
    };
    resolved.uniforms = rows_for(slots.uniforms);
    resolved.textures = rows_for(slots.textures);
    resolved.storage = rows_for(slots.storage);
    resolved.texture_samplers.reserve(resolved.textures.size());
    for (const upstream::PinnedShadowBinding* row : resolved.textures) {
        const upstream::PinnedShadowBinding* companion =
            row ? shadow_sampler_row_for(rows, row->light) : nullptr;
        if (row && !companion) {
            gpu_error(("a composed shadow map '" + std::string(row->name) +
                       "' declares no sampler beside it.")
                          .c_str());
        }
        resolved.texture_samplers.push_back(companion);
    }
    return resolved;
}

SDL_GPUBuffer* shadow_info_buffer_at(const GpuState& state,
                                     const upstream::PinnedShadowBinding* row) {
    if (row == nullptr)
        return nullptr;
    return shadow_generator_for_row(state, *row).info;
}

PinnedStageBlock shadow_info_uniform_at(const GpuState& state,
                                        const upstream::PinnedShadowBinding* row) {
    if (row == nullptr)
        return {};
    const GpuState::ShadowGenerator& generator = shadow_generator_for_row(state, *row);
    return {generator.block.bytes.data(), generator.block.size};
}

PinnedResource shadow_resource_at(const GpuState& state, const PinnedStageShadowRows& rows,
                                  std::size_t slot) {
    const upstream::PinnedShadowBinding* row = rows.textures[slot];
    if (row == nullptr)
        return {};
    return {
        shadow_generator_for_row(state, *row).map,
        rows.texture_samplers[slot]->kind == upstream::PinnedBindingKind::samplerComparison
            ? state.shadow_comparison_sampler
            : state.shadow_filtering_sampler,
    };
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PINNED_MATERIALS && BBLITE_SHADOWS_ESM
const GpuState::EsmBlur* esm_caster_params_for(const GpuState& state, const Engine& engine,
                                               const MaterialRecord* material) {
    if (!material || !material->esm_shadow ||
        material->esm_shadow_generator.value >= engine.shadow_generators.size()) {
        return nullptr;
    }
    const std::uint32_t esm_index =
        handle_at(engine.shadow_generators, material->esm_shadow_generator).esm_index;
    if (esm_index >= state.esm_blurs.size())
        return nullptr;
    return &state.esm_blurs[esm_index];
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PINNED_MATERIALS
PinnedResource state_resource_for(const GpuState& state, upstream::MaterialTextureSource source) {
    switch (source) {
    case upstream::MaterialTextureSource::environment_cube:
        return {state.environment, state.sampler};
    case upstream::MaterialTextureSource::brdf_lut:
        return {state.brdf_lut, state.background_sampler};
    case upstream::MaterialTextureSource::scene_color:
#if BBLITE_RENDERER_TRANSMISSION
        // The pin's transmission grab: the 1024x1024 mip-chained scene
        // colour copied out mid-pass, sampled trilinear-anisotropic.
        return {state.transmission_color, state.transmission_sampler};
#else
        // No grab exists in a tree that composes no transmission; the
        // base-colour stand-in below is what the binding resolves to.
        return {};
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
    // The clustered field's three, from the container the scene holds.
    // Integer payloads bind as storage textures; the float payload
    // retains its unused sampler binding.
    case upstream::MaterialTextureSource::clustered_lights:
        return {state.clustered.lights, state.clustered.sampler};
    case upstream::MaterialTextureSource::clustered_cells:
        return {state.clustered.cells, nullptr};
    case upstream::MaterialTextureSource::clustered_indices:
        return {state.clustered.indices, nullptr};
#endif
    default:
        return {};
    }
}
#endif

#if BBLITE_HAS_PBR_RENDERER
void apply_pass_depth_state(SDL_GPUGraphicsPipelineCreateInfo& info, const GpuState& state,
                            bool shadow_pass, std::optional<SDL_GPUSampleCount> task_samples,
                            std::optional<ShaderTaskTarget> target) {
    info.depth_stencil_state.compare_op = gpu_depth_compare(pal::pass_depth_compare(shadow_pass));
    info.depth_stencil_state.enable_depth_test = true;
    info.multisample_state.sample_count =
        shadow_pass ? task_sample_count(state, pal::pass_depth_samples(true, 1))
        : target    ? target->samples
                    : task_samples.value_or(state.sample_count);
    info.target_info.depth_stencil_format =
        target ? target->depth
               : (shadow_pass ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT : state.depth_format);
    info.target_info.has_depth_stencil_target =
        info.target_info.depth_stencil_format != SDL_GPU_TEXTUREFORMAT_INVALID;
    info.depth_stencil_state.enable_depth_test = info.target_info.has_depth_stencil_target;
}
#endif

#if BBLITE_HAS_PBR_RENDERER &&                                                                     \
    (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_GEOMETRY_VARIANTS > 0)
void apply_geometry_color_targets(SDL_GPUGraphicsPipelineCreateInfo& info,
                                  std::vector<SDL_GPUColorTargetDescription>& targets,
                                  const GpuState& state, const FrameTaskRecord& task,
                                  std::size_t entry_color_target_count, const char* family,
                                  const SDL_GPUColorTargetBlendState* blend) {
    const std::vector<SDL_GPUTextureFormat> formats =
        geometry_color_target_formats<SDL_GPUTextureFormat>(
            task, entry_color_target_count, family,
            [](TextureFormatClass format_class) { return texture_format(format_class); },
            state.frame_color_format);
    targets.reserve(formats.size());
    for (const SDL_GPUTextureFormat format : formats) {
        SDL_GPUColorTargetDescription target{};
        target.format = format;
        if (blend)
            target.blend_state = *blend;
        targets.push_back(target);
    }
    info.target_info.color_target_descriptions = targets.data();
    info.target_info.num_color_targets = static_cast<Uint32>(targets.size());
    info.multisample_state.sample_count = task_sample_count(state, task.geometry.samples);
    info.depth_stencil_state.enable_depth_write = true;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PBR_VARIANTS > 0 && BBLITE_LOCAL_CUBEMAP
GpuState::LocalCubemap* ensure_local_cubemap(GpuState& state, const MaterialRecord* material) {
    if (!material || !material->local_environment)
        return nullptr;
    const auto& source = material->local_environment;
    if (const auto found = state.local_cubemaps.find(source.get());
        found != state.local_cubemaps.end())
        return found->second.get();
    auto gpu = std::make_unique<GpuState::LocalCubemap>();
    gpu->device = state.device;
    gpu->source = source;
    gpu->texture =
        upload_environment(state.device, local_cubemap_texture(*source), source->layers, true);
    if (source->overrides_environment)
        gpu->environment = upload_environment(state.device, *source->environments.at(0), 6, false,
                                              &gpu->environment_gpu);
    gpu->uniform = upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                 source->uniform_data.data(),
                                 source->uniform_data.size() * sizeof(std::uint32_t));
    gpu->grid =
        upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                      source->grid_data.data(), source->grid_data.size() * sizeof(std::uint32_t));
    auto* result = gpu.get();
    state.local_cubemaps.emplace(source.get(), std::move(gpu));
    return result;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PBR_VARIANTS > 0
PinnedResource
pinned_resource_for(GpuState& state, const GpuMesh& mesh, const std::string& name,
                    [[maybe_unused]] std::size_t variant,
                    // Which stage's texture list the name came from, and its index there:
                    // the pair that makes the group-2 fallback below a cached-row index.
                    [[maybe_unused]] bool fragment, [[maybe_unused]] std::size_t stage_slot,
                    [[maybe_unused]] const MaterialRecord* material) {
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    if (material && mesh.shared_plugin_textures) {
        for (std::size_t index = 0; index < material->plugin_textures.size(); ++index) {
            const auto& binding = material->plugin_textures[index];
            if (binding.texture_name == name || binding.sampler_name == name) {
                if (const auto& source = binding.data.render_source) {
                    if (source->engine_lifetime.expired())
                        throw std::runtime_error("Render texture engine has expired.");
                    const auto& reference = source->reference;
                    auto& target = handle_at(state.render_targets, reference.target);
                    if (target.color || target.depth) {
                        const auto texture =
                            reference.depth_only ? target.depth : target.sampled_color;
                        if (!texture)
                            throw std::runtime_error("Render texture has no sampled allocation.");
                        mesh.shared_plugin_textures->bind_external_texture(
                            index, retain_render_target(state.device, target),
                            {texture,
                             reference.depth_only ? state.depth_sampler : state.ground_sampler});
                    }
                }
                const auto& sampled = mesh.shared_plugin_textures->bindings.at(index);
                if (!sampled.texture)
                    throw std::runtime_error("Plugin texture has no live sampled allocation.");
                return {sampled.texture, sampled.sampler};
            }
        }
    }
#endif
    const upstream::MaterialTextureSlot* slot = material_slot_for_binding(name);
    if (slot != nullptr) {
#if BBLITE_LOCAL_CUBEMAP
        if (material && material->local_environment) {
            const auto& local = *state.local_cubemaps.at(material->local_environment.get());
            if (slot->source == upstream::MaterialTextureSource::local_probe_cube)
                return {local.texture, state.sampler};
            if (slot->source == upstream::MaterialTextureSource::environment_cube &&
                local.source->overrides_environment)
                return {local.environment, state.sampler};
        }
#endif
        if (slot->slot != upstream::material_texture_no_slot) {
            const GpuMeshSlotMembers members = mesh_slot_members(slot->source);
            if (members.texture != nullptr) {
                return {mesh.*members.texture, mesh.*members.sampler};
            }
        } else {
            const PinnedResource resource = state_resource_for(state, slot->source);
            if (resource.texture != nullptr)
                return resource;
            if (slot->source == upstream::MaterialTextureSource::bone_palette) {
                // The texture is the mesh's; only the sampler is the
                // scene's, so this one row cannot join the resolver above.
                return {mesh.pinned_bone_texture, state.pinned_bone_sampler};
            }
#if BBLITE_VAT
            // The baked palette and its per-instance params ride the same
            // split: both are the MESH's textures, both are textureLoaded,
            // and this backend still pairs a sampler with every binding --
            // the nearest-clamp one the bone palette already uses.
            if (slot->source == upstream::MaterialTextureSource::vat_palette) {
                return {mesh.pinned_vat_texture, state.pinned_bone_sampler};
            }
#if BBLITE_VAT_INSTANCES
            if (slot->source == upstream::MaterialTextureSource::vat_instance_params) {
                return {mesh.pinned_vat_instance_texture, state.pinned_bone_sampler};
            }
#endif
#endif
        }
    }
#if BBLITE_PBR_SHADOWS
    // The receiver's group 2, resolved from its own cached rows exactly as
    // the Standard family's is: this backend binds by name, so group 2 joins
    // the same lookup rather than being a separate bind call. Asked AFTER the
    // slot table because the two name sets are disjoint and a material
    // texture is the common case -- so an ordinary base-colour or ORM
    // binding never pays for the shadow lookup at all.
    if (const PinnedResource shadow =
            shadow_resource_at(state,
                               (fragment ? state.pinned_fragment_shadow_rows
                                         : state.pinned_vertex_shadow_rows)[variant],
                               stage_slot);
        shadow.texture != nullptr) {
        return shadow;
    }
#endif
    gpu_error(("pinned variant declares an unmapped resource '" + name + "'.").c_str());
    return {};
}

void ensure_pinned_slots(GpuState& state, std::size_t variant) {
    if (state.pinned_vertex_slots.size() < upstream::pbr_variants.size()) {
        state.pinned_vertex_slots.resize(upstream::pbr_variants.size());
        state.pinned_fragment_slots.resize(upstream::pbr_variants.size());
#if BBLITE_PBR_SHADOWS
        state.pinned_vertex_shadow_rows.resize(upstream::pbr_variants.size());
        state.pinned_fragment_shadow_rows.resize(upstream::pbr_variants.size());
#endif
    }
    if (!state.pinned_vertex_slots[variant].uniforms.empty())
        return;
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    state.pinned_vertex_slots[variant] =
        read_pinned_stage_slots(pinned_stage_name(entry.vertex_shader));
    state.pinned_fragment_slots[variant] =
        read_pinned_stage_slots(pinned_stage_name(entry.fragment_shader));
#if BBLITE_PBR_SHADOWS
    // The shadow rows each slot resolves to, cached beside the slots they
    // are parallel to and refreshed with them.
    state.pinned_vertex_shadow_rows[variant] = resolve_stage_shadow_rows(
        state.pinned_vertex_slots[variant], pal::pbr_shadow_rows(variant));
    state.pinned_fragment_shadow_rows[variant] = resolve_stage_shadow_rows(
        state.pinned_fragment_slots[variant], pal::pbr_shadow_rows(variant));
#endif
}

SDL_GPUGraphicsPipeline*
pinned_variant_pipeline(GpuState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                        // The geometry-output task an MRT variant draws in. A geometry variant
                        // is composed for exactly one task, so the variant-keyed cache stays
                        // valid with the task's targets baked into its pipeline.
                        const FrameTaskRecord* geometry_task,
                        // The pin's one exception to this port's depth convention: a shadow
                        // caster pass renders standard-Z into the generator's own
                        // `depth32float` map, at one sample. The Standard sibling takes the
                        // same flag -- a caster is drawn through whichever family its own
                        // material belongs to, so a depth state either family answered alone
                        // would be right only for the casters that family happens to own.
                        bool shadow_pass,
                        // Which ESM generator's map this pass writes, when it writes one: a
                        // caster's colour target is that generator's own recorded row.
                        std::uint32_t esm_shadow_index,
                        std::optional<SDL_GPUSampleCount> task_samples,
                        std::optional<ShaderTaskTarget> target) {
    const std::size_t variant_key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(variant, upstream::pbr_variants.size(), esm_shadow_index), kind,
        {shadow_pass});
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format =
        target ? target->depth
               : (shadow_pass ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT : state.depth_format);
    const auto key = std::make_tuple(
        variant_key, target ? target->samples : task_samples.value_or(state.sample_count),
        color_format, depth_format);
    const auto existing = state.pinned_pipelines.find(key);
    if (existing != state.pinned_pipelines.end())
        return existing->second.get();
    ensure_pinned_slots(state, variant);
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const std::string vertex_name = pinned_stage_name(entry.vertex_shader);
    const std::string fragment_name = pinned_stage_name(entry.fragment_shader);
    const PinnedStageSlots& vertex_slots = state.pinned_vertex_slots[variant];
    const PinnedStageSlots& fragment_slots = state.pinned_fragment_slots[variant];
    auto vertex_shader =
        load_shader(state.device, vertex_name, SDL_GPU_SHADERSTAGE_VERTEX, vertex_slots);
    auto fragment_shader =
        load_shader(state.device, fragment_name, SDL_GPU_SHADERSTAGE_FRAGMENT, fragment_slots);

    // The variant's own inputs, at the locations it declares them. The names are
    // the pin's; where each sits in our vertex is this backend's.
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::PbrVariantAttribute& input =
            upstream::pbr_variant_attributes[entry.first_attribute + index];
        if (!append_variant_attribute(input.name, input.location, attributes)) {
            gpu_error(("pinned variant declares an unmapped vertex input '" +
                       std::string(input.name) + "'.")
                          .c_str());
        }
    }

    // The kind carries the fixed-function state, decoded once for both
    // backends (`pipeline_kind_traits`). Reading it here rather than
    // restating per-draw booleans is what keeps a mirrored node's
    // clockwise winding from being lost.
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    const bool transparent = traits.transparent;
    SDL_GPUColorTargetDescription color_target{};
    color_target.format = color_format;
#if BBLITE_SHADOWS_ESM
    // An ESM caster variant draws into ONE generator's map, whose recorded
    // row is the format its PSO must declare.
    if (esm_shadow_index != invalid_handle) {
        color_target.format = esm_caster_color_format(esm_shadow_index);
    }
#endif
    if (transparent) {
        color_target.blend_state = blend_state_from(transparent_blend);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    std::array<SDL_GPUVertexBufferDescription, vertex_streams.size()> vertex_buffers{};
    const Uint32 vertex_buffer_count = fill_variant_vertex_buffers(attributes, vertex_buffers);
    info.vertex_input_state = SDL_GPUVertexInputState{
        vertex_buffers.data(),
        vertex_buffer_count,
        attributes.data(),
        static_cast<Uint32>(attributes.size()),
    };
    info.primitive_type = gpu_primitive_type(traits.topology);
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = gpu_cull_mode(traits.cull);
    info.rasterizer_state.front_face = gpu_front_face(traits.clockwise_front_face);
    info.rasterizer_state.enable_depth_clip = true;
    apply_pass_depth_state(info, state, shadow_pass, task_samples, target);
    info.depth_stencil_state.enable_depth_write = entry.no_color_output || !transparent;
    info.depth_stencil_state.enable_depth_write &= info.target_info.has_depth_stencil_target;
    // A depth-only view's fragment writes no colour target, and the pass it
    // draws in carries none either.
    info.target_info.color_target_descriptions = entry.no_color_output ? nullptr : &color_target;
    info.target_info.num_color_targets = entry.no_color_output ? 0 : 1;
    // A geometry-output MRT variant draws into its task's own attachments,
    // through the builder all three families share.
    std::vector<SDL_GPUColorTargetDescription> geometry_targets;
    if (geometry_task) {
        apply_geometry_color_targets(info, geometry_targets, state, *geometry_task,
                                     entry.color_target_count, "pinned",
                                     transparent ? &color_target.blend_state : nullptr);
    }
    OwnedSdlPipeline pipeline{create_sdl_graphics_pipeline(state.device, &info), {state.device}};
    if (!pipeline)
        gpu_error("SDL_CreateGPUGraphicsPipeline pinned variant");
    return state.pinned_pipelines.emplace(key, std::move(pipeline)).first->second.get();
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_GPU_MORPH_STORAGE
void sync_morph_weights(GpuBufferUploadBatch& uploads, GpuMesh& mesh, const ModelGeometry& geometry,
                        const MeshRecord& record) {
    if (!mesh.owns_morph_buffers || mesh.morph_weights_version == record.morph_weights_version)
        return;
    const std::vector<std::uint8_t> weights = pack_morph_weights(geometry, record);
    uploads.update(mesh.morph_weights, weights.data(), weights.size());
    mesh.morph_weights_version = record.morph_weights_version;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON)
void upload_pinned_float_texture(GpuState& state, SDL_GPUTexture* texture, const float* data,
                                 std::uint32_t width, std::uint32_t height, std::uint32_t bytes) {
    if (!state.pinned_float_transfer || state.pinned_float_transfer_bytes < bytes) {
        if (state.pinned_float_transfer) {
            SDL_ReleaseGPUTransferBuffer(state.device, state.pinned_float_transfer);
        }
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = bytes;
        state.pinned_float_transfer = SDL_CreateGPUTransferBuffer(state.device, &transfer_info);
        if (!state.pinned_float_transfer)
            gpu_error("SDL_CreateGPUTransferBuffer");
        state.pinned_float_transfer_bytes = bytes;
    }
    SDL_GPUTransferBuffer* transfer = state.pinned_float_transfer;
    void* mapped = SDL_MapGPUTransferBuffer(state.device, transfer, true);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, bytes);
    SDL_UnmapGPUTransferBuffer(state.device, transfer);
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(state.device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    SDL_GPUTextureTransferInfo source{transfer, 0, width, height};
    SDL_GPUTextureRegion destination{texture, 0, 0, 0, 0, 0, width, height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, true);
    copy.end();
    if (!command.submit()) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
}

SDL_GPUTexture* create_pinned_float_texture(GpuState& state, std::uint32_t width,
                                            std::uint32_t height, const char* label) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(state.device, &texture_info);
    if (!texture)
        gpu_error(label);
    return texture;
}

void ensure_pinned_bone_sampler(GpuState& state) {
    if (state.pinned_bone_sampler)
        return;
    SDL_GPUSamplerCreateInfo sampler_info{};
    sampler_info.min_filter = SDL_GPU_FILTER_NEAREST;
    sampler_info.mag_filter = SDL_GPU_FILTER_NEAREST;
    sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sampler_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    state.pinned_bone_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
    if (!state.pinned_bone_sampler) {
        gpu_error("SDL_CreateGPUSampler pinned bone palette");
    }
}

void write_pinned_bone_texture(GpuState& state, GpuMesh& mesh, const MeshRecord& record) {
    ensure_pinned_bone_sampler(state);
    sync_pinned_bone_palette(
        mesh, record,
        [&](const BonePaletteLayout& palette) {
            if (mesh.pinned_bone_texture) {
                SDL_ReleaseGPUTexture(state.device, mesh.pinned_bone_texture);
            }
            mesh.pinned_bone_texture = create_pinned_float_texture(
                state, palette.width, palette.height, "SDL_CreateGPUTexture pinned bone palette");
        },
        [&](const float* floats, const BonePaletteLayout& palette) {
            upload_pinned_float_texture(state, mesh.pinned_bone_texture, floats, palette.width,
                                        palette.height, palette.bytes);
        });
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PBR_VARIANTS > 0 && BBLITE_VAT
void write_pinned_vat_texture(GpuState& state, GpuMesh& mesh, const MeshRecord& record,
                              const Engine& engine) {
    sync_pinned_vat(
        mesh, record, engine,
        [&](const VatBakeRecord& bake, const VatTextureLayout& layout) {
            ensure_pinned_bone_sampler(state);
            if (mesh.pinned_vat_texture)
                SDL_ReleaseGPUTexture(state.device, mesh.pinned_vat_texture);
            mesh.pinned_vat_texture = create_pinned_float_texture(
                state, layout.width, layout.height, "SDL_CreateGPUTexture pinned VAT");
            upload_pinned_float_texture(state, mesh.pinned_vat_texture, bake.data.data(),
                                        layout.width, layout.height, layout.bytes);
        },
        [](const VatData&) {},
#if BBLITE_VAT_INSTANCES
        [&](const VatData& vat) {
            if (mesh.pinned_vat_instance_texture)
                SDL_ReleaseGPUTexture(state.device, mesh.pinned_vat_instance_texture);
            mesh.pinned_vat_instance_texture = create_pinned_float_texture(
                state, vat.instance_texels, 1u, "SDL_CreateGPUTexture pinned VAT instances");
        },
        [&](const VatData& vat, const VatTextureLayout& layout) {
            upload_pinned_float_texture(state, mesh.pinned_vat_instance_texture,
                                        vat.instance_params.data(), layout.width, layout.height,
                                        layout.bytes);
        }
#else
        [](const VatData&) {}, [](const VatData&, const VatTextureLayout&) {}
#endif
    );
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PBR_VARIANTS > 0
void draw_pinned_variant(
    GpuState& state, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass, const Scene& scene,
    const Engine& engine,
    // The pass's scene and lights blocks, built once per pass by the
    // caller (Dawn builds both per frame): their builders run camera and
    // view math that must not repeat per draw.
    const upstream::SceneUniforms& pinned_scene, const std::vector<std::uint8_t>& pinned_lights,
    const upstream::RenderDrawCommand& draw, const GpuMesh& mesh, const MaterialRecord* material,
    std::size_t pinned_variant, SDL_GPUGraphicsPipeline*& bound_pipeline,
    // Set for a draw inside a geometry-output task: the task whose targets
    // the MRT pipeline binds, and the pin's gpUniforms block when the
    // variant declares one.
    const FrameTaskRecord* geometry_task, const PinnedGeometryParams* geometry_params,
    // The same block as a buffer, for a fragment whose `gp` the shader
    // compile demoted out of the four uniform slots.
    SDL_GPUBuffer* geometry_params_buffer,
    // Set when this draw is a caster in a shadow pass, which takes the
    // pin's standard-Z depth state rather than this port's reverse-Z.
    bool shadow_pass,
    // The generator whose map that pass writes, when it writes one.
    std::uint32_t esm_shadow_index, std::optional<SDL_GPUSampleCount> task_samples,
    std::optional<ShaderTaskTarget> target) {
#if BBLITE_LOCAL_CUBEMAP
    const auto* local_cubemap = ensure_local_cubemap(state, material);
#endif
    const upstream::RenderItem& item = draw.item;
    SDL_GPUGraphicsPipeline* variant_pipeline =
        pinned_variant_pipeline(state, pinned_variant, draw.pipeline, geometry_task, shadow_pass,
                                esm_shadow_index, task_samples, target);
    if (variant_pipeline != bound_pipeline) {
        SDL_BindGPUGraphicsPipeline(pass, variant_pipeline);
        bound_pipeline = variant_pipeline;
    }
    const upstream::PbrVariantEntry& variant_entry = upstream::pbr_variants[pinned_variant];
    [[maybe_unused]] const MeshRecord& pinned_record = handle_at(engine.meshes, item.mesh);
    const upstream::MeshUniforms pinned_mesh = pinned_mesh_block(scene, engine, draw.item.mesh);
    std::vector<std::uint8_t> pinned_material(variant_entry.material_ubo_bytes, 0);
    if (material) {
        upstream::write_pbr_variant_material(pinned_variant, *material, pinned_material.data(),
                                             pinned_material.size());
    }
    // Each block at the slot the remap assigned it. The
    // order is the `.slots` map's, because a stage can
    // declare a block it never reads and Tint strips it.
    const auto resolve = [&](const std::string& block) -> PinnedStageBlock {
        if (block == "scene") {
            return {&pinned_scene, sizeof(pinned_scene)};
        }
        if (block == "lights") {
            return {pinned_lights.data(), pinned_lights.size()};
        }
        if (block == "mesh")
            return {&pinned_mesh, sizeof(pinned_mesh)};
        if (block == "material") {
            return {pinned_material.data(), pinned_material.size()};
        }
#if BBLITE_VAT
        // The pin's 32-byte vertex-visible VAT settings: params then clock,
        // written by play/update on the record itself.
        if (block == "vat") {
            return {
                pinned_record.vat.settings.data(),
                pinned_record.vat.settings.size() * sizeof(float),
            };
        }
#endif
        if (block == "gp") {
            // The geometry-params block: previous view-projection and
            // camera near/far, built by the geometry task's caller.
            if (!geometry_params) {
                gpu_error("pinned variant declares gpUniforms outside a "
                          "geometry task.");
            }
            return {geometry_params, sizeof(*geometry_params)};
        }
#if BBLITE_SHADOWS_ESM
        // The ESM caster's own block, the same lookup the Standard family
        // makes: the two share the view's factory shape.
        if (block == "shadowParams") {
            if (const GpuState::EsmBlur* blur = esm_caster_params_for(state, engine, material)) {
                return {
                    blur->params.data(),
                    blur->params.size() * sizeof(float),
                };
            }
        }
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
        // The clustered field's params block. It belongs to the container
        // the scene was given rather than to this material, which is why it
        // resolves here and not through the material slot table.
        if (block == "clusteredLightParams") {
            if (const ClusteredLightContainer* container =
                    upstream::clustered_container(engine, scene.clustered_lights)) {
                return {
                    container->params.data(),
                    container->params.size() * sizeof(std::uint32_t),
                };
            }
        }
#endif
        return {};
    };
#if BBLITE_PBR_SHADOWS
    // The cached rows parallel to this variant's slot lists; the walks
    // below hand each resolver the slot index into them -- what turns the
    // old per-name row walk into a read. The uniform fallback answers with
    // the receiver block, one per shadow-casting light, by the cached row
    // each slot resolved to, never by parsing the name.
    const PinnedStageShadowRows& vertex_shadow_rows =
        state.pinned_vertex_shadow_rows[pinned_variant];
    const PinnedStageShadowRows& fragment_shadow_rows =
        state.pinned_fragment_shadow_rows[pinned_variant];
    const auto vertex_uniforms = with_shadow_uniform_rows(state, vertex_shadow_rows, resolve);
    const auto fragment_uniforms = with_shadow_uniform_rows(state, fragment_shadow_rows, resolve);
#else
    const auto vertex_uniforms = [&](const std::string& block, std::size_t) {
        return resolve(block);
    };
    const auto fragment_uniforms = vertex_uniforms;
#endif
    push_stage_uniforms(command, state.pinned_vertex_slots[pinned_variant], false, "pinned variant",
                        vertex_uniforms);
    push_stage_uniforms(command, state.pinned_fragment_slots[pinned_variant], true,
                        "pinned variant", fragment_uniforms);
    const PinnedStageSlots& pinned_fragment = state.pinned_fragment_slots[pinned_variant];
    bind_stage_textures(pass, pinned_fragment, true, "pinned variant fragment",
                        [&](const std::string& name, std::size_t slot) {
                            const PinnedResource resource = pinned_resource_for(
                                state, mesh, name, pinned_variant, true, slot, material);
                            return SDL_GPUTextureSamplerBinding{
                                resource.texture,
                                resource.sampler,
                            };
                        });
    bind_stage_storage(
        pass, pinned_fragment, true, "pinned variant fragment", state.storage_binding_scratch,
        [&](const std::string& name, [[maybe_unused]] std::size_t slot) -> SDL_GPUBuffer* {
            if (name == "gp")
                return geometry_params_buffer;
#if BBLITE_LOCAL_CUBEMAP
            if (local_cubemap) {
                if (name == "localProbeData")
                    return local_cubemap->uniform;
                if (name == "localProbeGrid")
                    return local_cubemap->grid;
            }
#endif
#if BBLITE_PBR_SHADOWS
            // The receiver blocks the shader compile demoted out of the
            // uniform slots, the same way the geometry arms' gp block is:
            // SDL_GPU caps those at four per stage and a receiving PBR
            // fragment spends all four on scene, lights, mesh and material.
            if (SDL_GPUBuffer* info =
                    shadow_info_buffer_at(state, fragment_shadow_rows.storage[slot])) {
                return info;
            }
#endif
            return nullptr;
        });
    // The vertex stage's own textures -- the skeleton
    // arm's bone palette -- in the same `.slots` order as
    // the fragment's, and its storage buffers -- the
    // morph arms' deltas and weights, the same buffers
    // the transcribed stage read.
    const PinnedStageSlots& pinned_vertex = state.pinned_vertex_slots[pinned_variant];
    bind_stage_storage(
        pass, pinned_vertex, false, "pinned variant vertex", state.storage_binding_scratch,
        [&](const std::string& name, [[maybe_unused]] std::size_t slot) -> SDL_GPUBuffer* {
            // Cast unconditionally: which arms below compile is a capability
            // question, and a compound negative would have to be re-derived
            // every time one is added.
            (void)name;
            if (SDL_GPUBuffer* morph = morph_storage_buffer_for(mesh, name)) {
                return morph;
            }
#if BBLITE_PBR_SHADOWS
            // A receiver whose vertex stage also overflows the four uniform
            // slots has its own receiver blocks demoted there too.
            if (SDL_GPUBuffer* info =
                    shadow_info_buffer_at(state, vertex_shadow_rows.storage[slot])) {
                return info;
            }
#endif
            return nullptr;
        });
    bind_stage_textures(pass, pinned_vertex, false, "pinned variant vertex",
                        [&](const std::string& name, std::size_t slot) {
                            const PinnedResource resource = pinned_resource_for(
                                state, mesh, name, pinned_variant, false, slot, material);
                            return SDL_GPUTextureSamplerBinding{
                                resource.texture,
                                resource.sampler,
                            };
                        });
    // The thin-instance arm's second stream and the instance count; a
    // non-instanced variant binds neither and draws once.
    const bool instanced_draw = pinned_record_instanced(handle_at(engine.meshes, item.mesh));
    SDL_GPUBuffer* pinned_colors = nullptr;
#if BBLITE_GPU_INSTANCE_COLORS
    // The selected coloured PBR arm declares the pin's `ti-color` stream at
    // slot 2. Match the key and the Standard/Dawn bindings through the same
    // record predicate, so a declared instanceColor never reads an unbound
    // lane.
    if (pinned_record_instance_colored(pinned_record)) {
        pinned_colors = mesh.instance_colors;
    }
#endif
    bind_composed_mesh_vertex_buffers(pass, mesh.vertices,
                                      instanced_draw ? mesh.instances : nullptr, pinned_colors);
    const SDL_GPUBufferBinding pinned_index_binding{
        mesh.indices,
        0,
    };
    SDL_BindGPUIndexBuffer(pass, &pinned_index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, mesh.index_count,
                   instanced_draw ? mesh.instance_count : 1, 0, 0, 0);
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_NODE_VARIANTS > 0
void ensure_node_slots(GpuState& state, std::size_t slot) {
    if (state.node_vertex_slots.size() < pal::node_variant_slots()) {
        state.node_vertex_slots.resize(pal::node_variant_slots());
        state.node_fragment_slots.resize(pal::node_variant_slots());
#if BBLITE_NODE_SHADOWS
        state.node_vertex_shadow_rows.resize(pal::node_variant_slots());
        state.node_fragment_shadow_rows.resize(pal::node_variant_slots());
#endif
    }
    if (!state.node_vertex_slots[slot].uniforms.empty())
        return;
    const upstream::NodeVariantStems stems = pal::node_variant_stems(slot);
    state.node_vertex_slots[slot] = read_pinned_stage_slots(std::string(stems.vertex));
    state.node_fragment_slots[slot] = read_pinned_stage_slots(std::string(stems.fragment));
#if BBLITE_NODE_SHADOWS
    // The view's receiver rows, resolved against its own stages' slots. A
    // geometry view receives from nothing -- `ensureGeometryResources`
    // refuses a graph whose geometry emit raised any shadow light -- so its
    // row carries an empty range and this resolves to nothing.
    const upstream::NodeVariantEntry& entry = pal::node_slot_view(slot);
    state.node_vertex_shadow_rows[slot] =
        resolve_stage_shadow_rows(state.node_vertex_slots[slot], pal::node_shadow_rows(entry));
    state.node_fragment_shadow_rows[slot] =
        resolve_stage_shadow_rows(state.node_fragment_slots[slot], pal::node_shadow_rows(entry));
#endif
}

SDL_GPUGraphicsPipeline*
node_variant_pipeline(GpuState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                      // The shadow target's own depth state, taken by every family: a node
                      // material casts through its own ESM view exactly as the Standard
                      // family does.
                      bool shadow_pass,
                      // Which of the graph's two compiled views this draws, and -- when it is
                      // the caster -- which ESM generator's map it writes, whose recorded row
                      // is the colour format.
                      bool caster, std::uint32_t esm_shadow_index,
                      // The geometry-output task an MRT view draws in, with the composed view
                      // it resolved. A geometry module is composed for exactly ONE task, so
                      // the slot-keyed cache stays valid with that task's targets baked in --
                      // the same reason the two material families key theirs on the variant.
                      [[maybe_unused]] const FrameTaskRecord* geometry_task,
                      std::size_t geometry_variant, std::optional<ShaderTaskTarget> target) {
    const std::optional<SDL_GPUSampleCount> task_samples;
    const bool geometry_view = geometry_variant != pal::no_node_geometry_variant;
    const std::size_t slot = pal::node_draw_slot(variant, caster, geometry_variant);
    const std::size_t variant_key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(slot, pal::node_variant_slots(), esm_shadow_index), kind,
        {shadow_pass});
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format =
        target ? target->depth
               : (shadow_pass ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT : state.depth_format);
    const auto key = std::make_tuple(
        variant_key, target ? target->samples : task_samples.value_or(state.sample_count),
        color_format, depth_format);
    const auto existing = state.node_variant_pipelines.find(key);
    if (existing != state.node_variant_pipelines.end()) {
        return existing->second.get();
    }
    ensure_node_slots(state, slot);
    const upstream::NodeVariantEntry& entry = upstream::node_variants[variant];
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    const upstream::NodeVariantStems stems = pal::node_variant_stems(slot);
    const PinnedStageSlots& vertex_slots = state.node_vertex_slots[slot];
    const PinnedStageSlots& fragment_slots = state.node_fragment_slots[slot];
    auto vertex_shader = load_shader(state.device, std::string(stems.vertex),
                                     SDL_GPU_SHADERSTAGE_VERTEX, vertex_slots);
    auto fragment_shader = load_shader(state.device, std::string(stems.fragment),
                                       SDL_GPU_SHADERSTAGE_FRAGMENT, fragment_slots);
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(view.attribute_count);
    for (std::size_t index = 0; index < view.attribute_count; ++index) {
        const upstream::NodeVariantAttribute& input =
            upstream::node_variant_attributes[view.first_attribute + index];
        if (!append_variant_attribute(input.name, input.location, attributes)) {
            gpu_error(("node variant declares an unmapped vertex input '" +
                       std::string(input.name) + "'.")
                          .c_str());
        }
        if (attributes.back().buffer_slot != 0) {
            gpu_error(("node variant declares the per-instance vertex input '" +
                       std::string(input.name) +
                       "', which its pipeline binds no "
                       "stream for.")
                          .c_str());
        }
    }
    SDL_GPUColorTargetDescription color_target{};
    color_target.format = color_format;
#if BBLITE_SHADOWS_ESM
    if (caster && esm_shadow_index != invalid_handle) {
        color_target.format = esm_caster_color_format(esm_shadow_index);
    }
#endif
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    // A geometry view is compiled at the pin's alpha mode 0 whatever the
    // graph's own blending says (`ensureGeometryCompile` passes it), so its
    // pipeline neither blends nor drops depth writes.
    const bool transparent = traits.transparent && !shadow_pass && !caster && !geometry_view;
    if (transparent) {
        color_target.blend_state = blend_state_from(transparent_blend);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    SDL_GPUVertexBufferDescription vertex_buffer{};
    vertex_buffer.slot = 0;
    vertex_buffer.pitch = sizeof(GpuVertex);
    vertex_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    info.vertex_input_state = SDL_GPUVertexInputState{
        &vertex_buffer,
        1u,
        attributes.data(),
        static_cast<Uint32>(attributes.size()),
    };
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    // The graph's culling and alpha-combine state, decoded through the same
    // shared kind table as the other families. Shadow views force the pin's
    // alpha mode 0 and therefore keep depth writes and no colour blending.
    // The geometry compile reads the GRAPH's own `backFaceCulling`
    // (`ensureGeometryCompile`), which is the same fact the plan's node kinds
    // are bucketed by -- both node cull arms carry it and neither the caster
    // nor the geometry view changes it -- so all three views read the one
    // shared kind table rather than a per-view exception.
    info.rasterizer_state.cull_mode = gpu_cull_mode(traits.cull);
    info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    info.rasterizer_state.enable_depth_clip = true;
    apply_pass_depth_state(info, state, shadow_pass, task_samples, target);
    info.depth_stencil_state.enable_depth_write = !transparent;
    info.depth_stencil_state.enable_depth_write &= info.target_info.has_depth_stencil_target;
    const bool pcf_caster = caster && !entry.caster.esm;
    info.target_info.color_target_descriptions = pcf_caster ? nullptr : &color_target;
    info.target_info.num_color_targets = pcf_caster ? 0 : 1;
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The task's own attachments, through the builder the two material
    // families' MRT arms take, with the family named so a mismatch says
    // which table was composed against which task. No blend and no
    // trailing output: a geometry view is compiled at the pin's alpha mode
    // 0 and `createNodeGeometryMaterialView` refuses `emitColor`.
    std::vector<SDL_GPUColorTargetDescription> geometry_targets;
    if (geometry_view) {
        apply_geometry_color_targets(
            info, geometry_targets, state, *geometry_task,
            upstream::node_geometry_variants[geometry_variant].color_target_count, "node", nullptr);
    }
#endif
    OwnedSdlPipeline pipeline{create_sdl_graphics_pipeline(state.device, &info), {state.device}};
    if (!pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline node variant");
    }
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        NodeGpuPipelineCapture receipt;
        receipt.id = state.node_capture.allocate(pipeline.get(), "node-pipeline");
        receipt.variant = static_cast<std::uint32_t>(variant);
        receipt.geometry_variant = geometry_view ? static_cast<int>(geometry_variant) : -1;
        receipt.color_target_count = info.target_info.num_color_targets;
        receipt.samples = 1u << static_cast<unsigned>(info.multisample_state.sample_count);
        receipt.topology =
            info.primitive_type == SDL_GPU_PRIMITIVETYPE_TRIANGLELIST ? "triangle-list" : "unknown";
        receipt.cull_mode = info.rasterizer_state.cull_mode == SDL_GPU_CULLMODE_NONE   ? "none"
                            : info.rasterizer_state.cull_mode == SDL_GPU_CULLMODE_BACK ? "back"
                                                                                       : "front";
        receipt.front_face =
            info.rasterizer_state.front_face == SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE ? "ccw" : "cw";
        for (std::size_t i = 0; i < attributes.size(); ++i) {
            const auto& attribute = attributes[i];
            const char* format =
                attribute.format == SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2   ? "float32x2"
                : attribute.format == SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3 ? "float32x3"
                : attribute.format == SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4 ? "float32x4"
                                                                         : "unknown";
            receipt.attributes.push_back(
                {std::string(upstream::node_variant_attributes[view.first_attribute + i].name),
                 format, attribute.location, attribute.buffer_slot, attribute.offset,
                 vertex_buffer.pitch});
        }
        state.node_capture.capture.pipeline(std::move(receipt));
    }
#endif
    return state.node_variant_pipelines.emplace(key, std::move(pipeline)).first->second.get();
}

void draw_node_variant(GpuState& state, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                       const Scene& scene, const Engine& engine,
                       // The pass's scene and lights blocks, built once per pass by the
                       // caller alongside the other composed families'.
                       const upstream::SceneUniforms& pinned_scene,
                       const std::vector<std::uint8_t>& pinned_lights,
                       const upstream::RenderDrawCommand& draw, const GpuMesh& mesh,
                       std::size_t variant, SDL_GPUGraphicsPipeline*& bound_pipeline,
                       bool shadow_pass,
                       // The material this draw resolved to, whose ESM bit selects the graph's
                       // caster view over its receiver one.
                       [[maybe_unused]] const MaterialRecord* material,
                       // The generator whose map this pass writes, when it writes one.
                       std::uint32_t esm_shadow_index,
                       // The geometry-output task this draw is inside, with the task's own
                       // gpUniforms in both the shapes a stage can read it: the block the
                       // register remap keeps as a uniform, and the buffer it demotes to
                       // storage once four uniform slots are spent.
                       [[maybe_unused]] const FrameTaskRecord* geometry_task,
                       [[maybe_unused]] const PinnedGeometryParams* geometry_params,
                       [[maybe_unused]] SDL_GPUBuffer* geometry_params_buffer,
                       std::optional<ShaderTaskTarget> target) {
#if BBLITE_NODE_SHADOWS
    const bool caster = material && (material->esm_shadow || material->no_color);
#else
    const bool caster = false;
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The composed view for this (graph, task), or the shared refusal.
    const std::size_t geometry_variant =
        geometry_task ? pal::require_node_geometry_variant(
                            variant, static_cast<std::size_t>(geometry_task->geometry.shader_index))
                      : pal::no_node_geometry_variant;
#else
    if (geometry_task) {
        gpu_error("a node material in a geometry task in a build with no composed "
                  "node geometry views.");
    }
    const std::size_t geometry_variant = pal::no_node_geometry_variant;
#endif
    const std::size_t slot = pal::node_draw_slot(variant, caster, geometry_variant);
    SDL_GPUGraphicsPipeline* variant_pipeline =
        node_variant_pipeline(state, variant, draw.pipeline, shadow_pass, caster, esm_shadow_index,
                              geometry_task, geometry_variant, target);
    if (variant_pipeline != bound_pipeline) {
        SDL_BindGPUGraphicsPipeline(pass, variant_pipeline);
        bound_pipeline = variant_pipeline;
    }
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    const upstream::NodeMeshUniforms node_mesh = node_mesh_block(scene, engine, draw.item.mesh);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    std::vector<std::uint8_t> captured_mesh_uniform;
#endif
    const auto resolve = [&](const std::string& block) -> PinnedStageBlock {
        if (block == "scene") {
            return {&pinned_scene, sizeof(pinned_scene)};
        }
        if (block == "nmeLights") {
            return {pinned_lights.data(), pinned_lights.size()};
        }
        if (block == "meshU") {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            if (state.node_capture.capture.enabled()) {
                const auto* bytes = reinterpret_cast<const std::uint8_t*>(&node_mesh);
                captured_mesh_uniform.assign(bytes, bytes + sizeof(node_mesh));
            }
#endif
            return {&node_mesh, sizeof(node_mesh)};
        }
        if (block == "nodeU") {
            return {
                &upstream::node_variant_uniform_floats[view.first_uniform_float],
                view.ubo_bytes,
            };
        }
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        // The task's gpUniforms, under the name the pin's own
        // `_buildGeomUbo` declares for the node family.
        if (block == "nmeGeom") {
            if (!geometry_params) {
                gpu_error("node geometry view declares NmeGeomParams outside a "
                          "geometry task.");
            }
            return {geometry_params, sizeof(*geometry_params)};
        }
#endif
#if BBLITE_SHADOWS_ESM
        // The caster's own params block, the same one the two composed
        // families' casters read.
        if (block == "nmeShadowParams") {
            if (const GpuState::EsmBlur* blur = esm_caster_params_for(state, engine, material)) {
                return {
                    blur->params.data(),
                    blur->params.size() * sizeof(float),
                };
            }
        }
#endif
        return {};
    };
#if BBLITE_NODE_SHADOWS
    // The cached receiver rows for this view's stages, indexed by the slot
    // every walk below hands its resolver -- the node rows are the same
    // reflected shape both other families cache, in the graph's own group
    // rather than a group of their own.
    const PinnedStageShadowRows& vertex_shadow_rows = state.node_vertex_shadow_rows[slot];
    const PinnedStageShadowRows& fragment_shadow_rows = state.node_fragment_shadow_rows[slot];
    const auto vertex_uniforms = with_shadow_uniform_rows(state, vertex_shadow_rows, resolve);
    const auto fragment_uniforms = with_shadow_uniform_rows(state, fragment_shadow_rows, resolve);
#else
    const auto vertex_uniforms = [&](const std::string& block, std::size_t) {
        return resolve(block);
    };
    const auto fragment_uniforms = vertex_uniforms;
#endif
    push_stage_uniforms(command, state.node_vertex_slots[slot], false, "node variant",
                        vertex_uniforms);
    push_stage_uniforms(command, state.node_fragment_slots[slot], true, "node variant",
                        fragment_uniforms);
    // Two kinds of name reach a node stage's sampler slots. The graph's own
    // `TextureBlock` bindings are declared `nodeTex_<name>` / `nodeSamp_<name>`
    // around the sanitized block name, so they resolve against the images the
    // scene supplied -- in the variant table's order, which is the order
    // `create_node_material` filled the material's slots in. Every other name
    // is one of the pin's environment resources and carries no slot this
    // table knows, so it joins through the source `node_binding_resources`
    // declares, the pair every other family already resolves.
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    std::vector<NodeGpuBindingCapture> captured_bindings;
#endif
    const auto resolve_texture =
        [&](const std::string& name, [[maybe_unused]] bool fragment_stage,
            [[maybe_unused]] std::size_t texture_slot) -> SDL_GPUTextureSamplerBinding {
        const auto& shader_textures = mesh_shader_textures(mesh);
        // The prefix is stripped once rather than re-concatenated onto every
        // candidate: this runs per declared name, per stage, per draw, per
        // frame, and building the comparison strings there allocated three
        // times a binding.
        std::string_view declared(name);
        const bool prefixed = declared.starts_with("nodeTex_") ? (declared.remove_prefix(8), true)
                              : declared.starts_with("nodeSamp_")
                                  ? (declared.remove_prefix(9), true)
                                  : false;
        if (prefixed) {
            for (std::size_t index = 0; index < view.texture_count; ++index) {
                const upstream::NodeVariantTexture& binding =
                    upstream::node_variant_textures[view.first_texture + index];
                if (binding.name != declared)
                    continue;
                if (index >= shader_textures.size()) {
                    gpu_error("a node graph declares more textures than its "
                              "material carries.");
                }
                return shader_textures[index];
            }
        }
#if BBLITE_NODE_SHADOWS
        if (const PinnedResource shadow = shadow_resource_at(
                state, fragment_stage ? fragment_shadow_rows : vertex_shadow_rows, texture_slot);
            shadow.texture != nullptr) {
            return SDL_GPUTextureSamplerBinding{
                shadow.texture,
                shadow.sampler,
            };
        }
#endif
        const PinnedResource resource =
            state_resource_for(state, upstream::node_binding_source(name));
        if (resource.texture == nullptr) {
            gpu_error(("node variant declares an unmapped resource '" + name + "'.").c_str());
        }
        return SDL_GPUTextureSamplerBinding{
            resource.texture,
            resource.sampler,
        };
    };
    bind_stage_textures(
        pass, state.node_vertex_slots[slot], false, "node variant vertex",
        [&](const std::string& name, std::size_t texture_slot) {
            const auto binding = resolve_texture(name, false, texture_slot);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            if (state.node_capture.capture.enabled()) {
                captured_bindings.push_back(
                    {static_cast<std::uint32_t>(texture_slot), "vertex-texture:" + name,
                     state.node_capture.identity(binding.texture, "bound-texture"), 0});
                captured_bindings.push_back(
                    {static_cast<std::uint32_t>(texture_slot), "vertex-sampler:" + name,
                     state.node_capture.identity(binding.sampler, "bound-sampler"), 0});
            }
#endif
            return binding;
        });
    bind_stage_textures(
        pass, state.node_fragment_slots[slot], true, "node variant fragment",
        [&](const std::string& name, std::size_t texture_slot) {
            const auto binding = resolve_texture(name, true, texture_slot);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            if (state.node_capture.capture.enabled()) {
                captured_bindings.push_back(
                    {static_cast<std::uint32_t>(texture_slot), "fragment-texture:" + name,
                     state.node_capture.identity(binding.texture, "bound-texture"), 0});
                captured_bindings.push_back(
                    {static_cast<std::uint32_t>(texture_slot), "fragment-sampler:" + name,
                     state.node_capture.identity(binding.sampler, "bound-sampler"), 0});
            }
#endif
            return binding;
        });
    // Storage resources survive register compaction by name. MorphTargetsBlock
    // contributes the vertex pair below; shadow receiver blocks can join the
    // same sidecar when the fragment has exhausted SDL_GPU's uniform slots.
    const auto resolve_storage = [&](const std::string& name, [[maybe_unused]] bool fragment_stage,
                                     [[maybe_unused]] std::size_t storage_slot) -> SDL_GPUBuffer* {
        // A non-morph, non-shadow node build keeps the common resolver but
        // compiles every named arm below out.
        (void)name;
        // Every uploaded mesh owns the exact pin-shaped pair or aliases the
        // shared zero-target fallback, matching node-renderable.ts.
        if (SDL_GPUBuffer* morph = morph_storage_buffer_for(mesh, name)) {
            return morph;
        }
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        // The gpUniforms block once the shader compile demoted it out of
        // SDL_GPU's four uniform slots, exactly as the two material
        // families' `gp` is.
        if (name == "nmeGeom")
            return geometry_params_buffer;
#endif
#if BBLITE_NODE_SHADOWS
#if BBLITE_SHADOWS_ESM
        if (name == "nmeShadowParams") {
            if (const GpuState::EsmBlur* blur = esm_caster_params_for(state, engine, material)) {
                return blur->params_buffer;
            }
        }
#endif
        return shadow_info_buffer_at(
            state,
            (fragment_stage ? fragment_shadow_rows : vertex_shadow_rows).storage[storage_slot]);
#else
        return nullptr;
#endif
    };
    bind_stage_storage(pass, state.node_vertex_slots[slot], false, "node variant vertex",
                       state.storage_binding_scratch,
                       [&](const std::string& name, std::size_t storage_slot) {
                           return resolve_storage(name, false, storage_slot);
                       });
    bind_stage_storage(pass, state.node_fragment_slots[slot], true, "node variant fragment",
                       state.storage_binding_scratch,
                       [&](const std::string& name, std::size_t storage_slot) {
                           return resolve_storage(name, true, storage_slot);
                       });
    const SDL_GPUBufferBinding vertex_binding{mesh.vertices, 0};
    SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
    const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
    SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, mesh.index_count, 1, 0, 0, 0);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        NodeGpuDrawCapture receipt;
        receipt.pipeline = state.node_capture.identity(variant_pipeline, "node-pipeline");
        receipt.mesh = draw.item.mesh.value;
        receipt.material = draw.item.material.value;
        receipt.vertices = state.node_capture.identity(vertex_binding.buffer, "node-vertices");
        receipt.indices = state.node_capture.identity(index_binding.buffer, "node-indices");
        receipt.vertex_offset = vertex_binding.offset;
        receipt.index_offset = index_binding.offset;
        receipt.index_count = mesh.index_count;
        receipt.bindings = std::move(captured_bindings);
        receipt.pushed_uniform_bytes = std::move(captured_mesh_uniform);
        state.node_capture.capture.draw(std::move(receipt));
    }
#endif
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_STANDARD_VARIANTS > 0
void ensure_standard_slots(GpuState& state, std::size_t variant) {
    if (state.standard_vertex_slots.size() < upstream::standard_variants.size()) {
        state.standard_vertex_slots.resize(upstream::standard_variants.size());
        state.standard_fragment_slots.resize(upstream::standard_variants.size());
#if BBLITE_STANDARD_SHADOWS
        state.standard_vertex_shadow_rows.resize(upstream::standard_variants.size());
        state.standard_fragment_shadow_rows.resize(upstream::standard_variants.size());
#endif
    }
    if (!state.standard_vertex_slots[variant].uniforms.empty())
        return;
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    state.standard_vertex_slots[variant] =
        read_pinned_stage_slots(standard_stage_name(entry.vertex_shader));
    state.standard_fragment_slots[variant] =
        read_pinned_stage_slots(standard_stage_name(entry.fragment_shader));
#if BBLITE_STANDARD_SHADOWS
    // The shadow rows each slot resolves to, cached beside the slots they
    // are parallel to, exactly as the PBR family's are.
    state.standard_vertex_shadow_rows[variant] = resolve_stage_shadow_rows(
        state.standard_vertex_slots[variant], pal::standard_shadow_rows(variant));
    state.standard_fragment_shadow_rows[variant] = resolve_stage_shadow_rows(
        state.standard_fragment_slots[variant], pal::standard_shadow_rows(variant));
#endif
}

PinnedResource standard_resource_for(GpuState& state, const GpuMesh& mesh,
                                     const MaterialRecord* material,
                                     const StandardRenderTextures& render_textures,
                                     const std::string& name, [[maybe_unused]] std::size_t variant,
                                     [[maybe_unused]] bool fragment,
                                     // The name's index in its stage's texture list.
                                     [[maybe_unused]] std::size_t stage_slot) {
    for (const upstream::StandardBindingResource& row : upstream::standard_binding_resources) {
        if (name != row.texture_name && name != row.sampler_name)
            continue;
#if BBLITE_STANDARD_SKELETON
        if (row.source == upstream::MaterialTextureSource::bone_palette) {
            return {mesh.pinned_bone_texture, state.pinned_bone_sampler};
        }
#endif
        if (row.reflection_cube) {
            return {mesh.reflection, state.sampler};
        }
        if (row.source == upstream::MaterialTextureSource::standard_emissive &&
            material != nullptr && material->has_emissive_render_texture) {
            // The compiled `material.emissiveTexture = <render texture>`
            // setter: the pin's depth-sampled texture, bound with the
            // non-filtering depth sampler.
            return {render_textures.standard_emissive, state.depth_sampler};
        }
        if (row.source == upstream::MaterialTextureSource::base_color && material != nullptr &&
            material->has_diffuse_render_texture) {
            // `material.diffuseTexture = <render texture>`: a colour
            // attachment, which rtt.ts hands the pin's bilinear sampler.
            // `getBilinearSampler`: linear mag/min over clamp
            // addressing, which is the descriptor `ground_sampler` was
            // already built with (its `max_lod` 0 and the pin's nearest
            // mip filter agree, because buildRenderTarget allocates one
            // level).
            return {render_textures.base_color, state.ground_sampler};
        }
        const GpuMeshSlotMembers members = mesh_slot_members(row.source);
        if (members.texture != nullptr) {
            return {mesh.*members.texture, mesh.*members.sampler};
        }
        break;
    }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    // A material plugin's own declaration. The name alone does not resolve
    // it -- two plugin lists may declare the same WGSL name -- so the row
    // is found by the material's own signature index, and the texture is
    // that material's, at the position `bindPluginTextures` fills.
    if (material != nullptr && mesh.shared_plugin_textures != nullptr) {
        if (const upstream::StandardPluginBinding* plugin_row =
                upstream::standard_plugin_binding_for(name, material->plugin_signature_index)) {
            if (plugin_row->ordinal >= mesh.shared_plugin_textures->bindings.size()) {
                gpu_error(("standard variant plugin resource '" + name + "' has no bound texture.")
                              .c_str());
            }
            const SDL_GPUTextureSamplerBinding& bound =
                mesh.shared_plugin_textures->bindings[plugin_row->ordinal];
            return {bound.texture, bound.sampler};
        }
    }
#endif
#if BBLITE_STANDARD_SHADOWS
    // Group 2, after the slot table for the reason the PBR resolver asks in
    // that order: the two name sets are disjoint, and a material texture is
    // the common case.
    if (const PinnedResource shadow =
            shadow_resource_at(state,
                               (fragment ? state.standard_fragment_shadow_rows
                                         : state.standard_vertex_shadow_rows)[variant],
                               stage_slot);
        shadow.texture != nullptr) {
        return shadow;
    }
#endif
    gpu_error(("standard variant declares an unmapped resource '" + name + "'.").c_str());
    return {};
}

SDL_GPUGraphicsPipeline*
standard_variant_pipeline(GpuState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                          const FrameTaskRecord* geometry_task,
                          // The pin's one exception to this port's depth convention: a shadow
                          // caster pass renders standard-Z into the generator's own
                          // `depth32float` map, at one sample.
                          bool shadow_pass,
                          // Which ESM generator's map this pass writes, when it writes one.
                          std::uint32_t esm_shadow_index,
                          std::optional<SDL_GPUSampleCount> task_samples,
                          std::optional<ShaderTaskTarget> target) {
    const std::size_t variant_key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(variant, upstream::standard_variants.size(), esm_shadow_index), kind,
        {shadow_pass});
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format =
        target ? target->depth
               : (shadow_pass ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT : state.depth_format);
    const auto key = std::make_tuple(
        variant_key, target ? target->samples : task_samples.value_or(state.sample_count),
        color_format, depth_format);
    const auto existing = state.standard_variant_pipelines.find(key);
    if (existing != state.standard_variant_pipelines.end()) {
        return existing->second.get();
    }
    ensure_standard_slots(state, variant);
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    const std::string vertex_name = standard_stage_name(entry.vertex_shader);
    const std::string fragment_name = standard_stage_name(entry.fragment_shader);
    const PinnedStageSlots& vertex_slots = state.standard_vertex_slots[variant];
    const PinnedStageSlots& fragment_slots = state.standard_fragment_slots[variant];
    auto vertex_shader =
        load_shader(state.device, vertex_name, SDL_GPU_SHADERSTAGE_VERTEX, vertex_slots);
    auto fragment_shader =
        load_shader(state.device, fragment_name, SDL_GPU_SHADERSTAGE_FRAGMENT, fragment_slots);
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::StandardVariantAttribute& input =
            upstream::standard_variant_attributes[entry.first_attribute + index];
        if (!append_variant_attribute(input.name, input.location, attributes)) {
            gpu_error(("standard variant declares an unmapped vertex input '" +
                       std::string(input.name) + "'.")
                          .c_str());
        }
    }
    // The same shared decode the PBR sibling reads. The winding is part
    // of it under the mirrored-mesh opt-in: std-mirrored-support.ts
    // installs a Standard primitive resolver precisely because this
    // family has no winding of its own, and a mirrored mesh drawn
    // counter-clockwise renders inside-out.
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    const bool transparent = traits.transparent;
    SDL_GPUColorTargetDescription color_target{};
    color_target.format = color_format;
#if BBLITE_SHADOWS_ESM
    // An ESM caster variant draws into ONE generator's map, whose recorded
    // row is the format its PSO must declare.
    if (esm_shadow_index != invalid_handle) {
        color_target.format = esm_caster_color_format(esm_shadow_index);
    }
#endif
    if (transparent) {
        color_target.blend_state = blend_state_from(transparent_blend);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    std::array<SDL_GPUVertexBufferDescription, vertex_streams.size()> vertex_buffers{};
    const Uint32 vertex_buffer_count = fill_variant_vertex_buffers(attributes, vertex_buffers);
    info.vertex_input_state = SDL_GPUVertexInputState{
        vertex_buffers.data(),
        vertex_buffer_count,
        attributes.data(),
        static_cast<Uint32>(attributes.size()),
    };
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = gpu_cull_mode(traits.cull);
    info.rasterizer_state.front_face = gpu_front_face(traits.clockwise_front_face);
    info.rasterizer_state.enable_depth_clip = true;
    apply_pass_depth_state(info, state, shadow_pass, task_samples, target);
    info.depth_stencil_state.enable_depth_write = entry.no_color_output || !transparent;
    info.depth_stencil_state.enable_depth_write &= info.target_info.has_depth_stencil_target;
    info.target_info.color_target_descriptions = entry.no_color_output ? nullptr : &color_target;
    info.target_info.num_color_targets = entry.no_color_output ? 0 : 1;
    // A geometry-output MRT variant draws into its task's own
    // attachments, exactly as the PBR sibling does and through the same
    // shared builder.
    std::vector<SDL_GPUColorTargetDescription> geometry_targets;
    if (geometry_task) {
        apply_geometry_color_targets(info, geometry_targets, state, *geometry_task,
                                     entry.color_target_count, "standard",
                                     transparent ? &color_target.blend_state : nullptr);
    }
    OwnedSdlPipeline pipeline{create_sdl_graphics_pipeline(state.device, &info), {state.device}};
    if (!pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline standard variant");
    }
    return state.standard_variant_pipelines.emplace(key, std::move(pipeline)).first->second.get();
}

void draw_standard_variant(
    GpuState& state, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass, const Scene& scene,
    const Engine& engine,
    // The pass's scene and lights blocks, built once per pass by the
    // caller (Dawn builds both per frame): their builders run camera and
    // view math that must not repeat per draw.
    const upstream::SceneUniforms& pinned_scene, const std::vector<std::uint8_t>& pinned_lights,
    const upstream::RenderDrawCommand& draw, const GpuMesh& mesh, const MaterialRecord* material,
    std::size_t variant,
    // The feature word the selector already derived for this draw
    // (`standard_variant_key`), passed through rather than re-derived.
    std::uint32_t features, SDL_GPUGraphicsPipeline*& bound_pipeline,
    const FrameTaskRecord* geometry_task, const PinnedGeometryParams* geometry_params,
    StandardRenderTextures render_textures, SDL_GPUBuffer* geometry_params_buffer,
    // The geometry task's velocity history, updated for this frame.
    const PinnedVelocityHistory* velocity_history,
    // Drawing the shadow map, so the pipeline renders standard-Z into the
    // generator's own single-sample depth32float target.
    bool shadow_pass,
    // The generator whose map that pass writes, when it writes one.
    std::uint32_t esm_shadow_index
#if BBLITE_HAS_TAA
    ,
    std::vector<PreparedSdlDraw>* deferred,
    const std::shared_ptr<PersistentSceneUniforms>& deferred_scene
#endif
    ,
    std::optional<SDL_GPUSampleCount> task_samples, std::optional<ShaderTaskTarget> target) {
    const upstream::RenderItem& item = draw.item;
    SDL_GPUGraphicsPipeline* variant_pipeline =
        standard_variant_pipeline(state, variant, draw.pipeline, geometry_task, shadow_pass,
                                  esm_shadow_index, task_samples, target);
    if (
#if BBLITE_HAS_TAA
        deferred == nullptr &&
#endif
        variant_pipeline != bound_pipeline) {
        SDL_BindGPUGraphicsPipeline(pass, variant_pipeline);
        bound_pipeline = variant_pipeline;
    }
    const MeshRecord& record = handle_at(engine.meshes, item.mesh);
    const upstream::MeshUniforms pinned_mesh =
        pinned_mesh_block(scene, engine, item.mesh, velocity_history);
    const upstream::StandardMaterialUniforms material_block =
        standard_material_block(material, features);
    const upstream::StandardUvTransformUniforms uv_block = standard_uv_block(material, features);
#if BBLITE_HAS_STANDARD_UV_TRANSFORM
    const upstream::StandardUvTxUniforms uv_transform_block = standard_uv_transform_block(material);
#endif
    const auto resolve = [&](const std::string& block) -> PinnedStageBlock {
        if (block == "scene") {
            return {&pinned_scene, sizeof(pinned_scene)};
        }
        if (block == "lights") {
            return {pinned_lights.data(), pinned_lights.size()};
        }
        if (block == "mesh")
            return {&pinned_mesh, sizeof(pinned_mesh)};
        if (block == "mat")
            return {&material_block, sizeof(material_block)};
        if (block == "up")
            return {&uv_block, sizeof(uv_block)};
#if BBLITE_HAS_STANDARD_UV_TRANSFORM
        if (block == "stdUvTx") {
            return {&uv_transform_block, sizeof(uv_transform_block)};
        }
#endif
        if (block == "gp") {
            if (!geometry_params) {
                gpu_error("standard variant declares gpUniforms outside a "
                          "geometry task.");
            }
            return {geometry_params, sizeof(*geometry_params)};
        }
#if BBLITE_SHADOWS_ESM
        // The ESM caster's own block, from the generator its material view
        // was built for.
        if (block == "shadowParams") {
            if (const GpuState::EsmBlur* blur = esm_caster_params_for(state, engine, material)) {
                return {
                    blur->params.data(),
                    blur->params.size() * sizeof(float),
                };
            }
        }
#endif
        return {};
    };
#if BBLITE_STANDARD_SHADOWS
    // The cached rows parallel to this variant's slot lists; the walks
    // below hand each resolver the slot index into them, and the uniform
    // fallback answers with the receiver block the cached row names.
    const PinnedStageShadowRows& vertex_shadow_rows = state.standard_vertex_shadow_rows[variant];
    const PinnedStageShadowRows& fragment_shadow_rows =
        state.standard_fragment_shadow_rows[variant];
    const auto vertex_uniforms = with_shadow_uniform_rows(state, vertex_shadow_rows, resolve);
    const auto fragment_uniforms = with_shadow_uniform_rows(state, fragment_shadow_rows, resolve);
#else
    const auto vertex_uniforms = [&](const std::string& block, std::size_t) {
        return resolve(block);
    };
    const auto fragment_uniforms = vertex_uniforms;
#endif
    const PinnedStageSlots& vertex_slots = state.standard_vertex_slots[variant];
    const PinnedStageSlots& fragment_slots = state.standard_fragment_slots[variant];
    const auto textures = [&](bool fragment, const std::string& name, std::size_t slot) {
        const PinnedResource resource = standard_resource_for(
            state, mesh, material, render_textures, name, variant, fragment, slot);
        return SDL_GPUTextureSamplerBinding{resource.texture, resource.sampler};
    };
    const auto fragment_storage = [&](const std::string& name,
                                      [[maybe_unused]] std::size_t slot) -> SDL_GPUBuffer* {
        if (name == "gp")
            return geometry_params_buffer;
#if BBLITE_STANDARD_SHADOWS
        if (SDL_GPUBuffer* info = shadow_info_buffer_at(state, fragment_shadow_rows.storage[slot]))
            return info;
#endif
        return nullptr;
    };
    const auto vertex_storage = [&](const std::string& name,
                                    [[maybe_unused]] std::size_t slot) -> SDL_GPUBuffer* {
        if (SDL_GPUBuffer* morph = morph_storage_buffer_for(mesh, name))
            return morph;
#if BBLITE_STANDARD_SHADOWS
        if (SDL_GPUBuffer* info = shadow_info_buffer_at(state, vertex_shadow_rows.storage[slot]))
            return info;
#endif
        return nullptr;
    };
    const bool instanced_draw = pinned_record_instanced(record);
    SDL_GPUBuffer* instance_colors = nullptr;
#if BBLITE_GPU_INSTANCE_COLORS
    if (pinned_record_instance_colored(record))
        instance_colors = mesh.instance_colors;
#endif
#if BBLITE_HAS_TAA
    if (deferred) {
        PreparedSdlDraw prepared;
        prepared.pipeline = variant_pipeline;
        prepared.vertex_uniforms =
            prepare_sdl_uniforms(vertex_slots.uniforms, vertex_uniforms, deferred_scene);
        prepared.fragment_uniforms =
            prepare_sdl_uniforms(fragment_slots.uniforms, fragment_uniforms, deferred_scene);
        prepared.vertex_textures = resolve_stage_textures(
            vertex_slots, "standard variant",
            [&](const std::string& name, std::size_t slot) { return textures(false, name, slot); });
        prepared.fragment_textures = resolve_stage_textures(
            fragment_slots, "standard variant",
            [&](const std::string& name, std::size_t slot) { return textures(true, name, slot); });
        resolve_stage_storage(fragment_slots, "standard variant fragment",
                              prepared.fragment_storage, fragment_storage);
        resolve_stage_storage(vertex_slots, "standard variant vertex", prepared.vertex_storage,
                              vertex_storage);
        prepared.vertex_buffers.push_back({mesh.vertices, 0});
        if (instanced_draw) {
            prepared.vertex_buffers.push_back({mesh.instances, 0});
            if (instance_colors)
                prepared.vertex_buffers.push_back({instance_colors, 0});
        }
        prepared.indices = {mesh.indices, 0};
        prepared.index_count = mesh.index_count;
        prepared.instance_count = instanced_draw ? mesh.instance_count : 1;
        deferred->push_back(std::move(prepared));
        return;
    }
#endif
    push_stage_uniforms(command, state.standard_vertex_slots[variant], false, "standard variant",
                        vertex_uniforms);
    push_stage_uniforms(command, state.standard_fragment_slots[variant], true, "standard variant",
                        fragment_uniforms);
    const auto bind_textures = [&](bool fragment) {
        bind_stage_textures(
            pass, (fragment ? state.standard_fragment_slots : state.standard_vertex_slots)[variant],
            fragment, "standard variant", [&](const std::string& name, std::size_t slot) {
                return textures(fragment, name, slot);
            });
    };
    bind_textures(false);
    bind_textures(true);
    // The gp block the shader compile demoted out of the uniform slots:
    // SDL_GPU caps those at four per stage and a geometry fragment spends all
    // four on scene, lights, mesh and mat.
    bind_stage_storage(pass, fragment_slots, true, "standard variant fragment",
                       state.storage_binding_scratch, fragment_storage);
    // The morph arms' deltas and weights, by the pin's own names.
    bind_stage_storage(pass, vertex_slots, false, "standard variant vertex",
                       state.storage_binding_scratch, vertex_storage);
    // The Standard families carry no glTF X-mirror: the pin's world is the
    // identity (or the record's parent TRS for a pool), so the baked vertex
    // buffer is the pin's own convention already.
    bind_composed_mesh_vertex_buffers(pass, mesh.vertices,
                                      instanced_draw ? mesh.instances : nullptr, instance_colors);
    const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
    SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, mesh.index_count,
                   instanced_draw ? mesh.instance_count : 1, 0, 0, 0);
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal
