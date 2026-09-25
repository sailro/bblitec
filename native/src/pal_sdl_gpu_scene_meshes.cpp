// SDL_GPU scene meshes: vertex and material bindings, shader storage,
// the scene mesh upload and its release. Dawn's twin is
// pal_dawn_scene_meshes.cpp.
#include <bblite/features/compute_buffers.hpp>
#include <bblite/features/device_recovery.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/mesh_position_update.hpp>
#include <bblite/features/shadows_csm.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER
SDL_GPUBuffer* morph_storage_buffer_for(const GpuMesh& mesh, const std::string& name) {
#if BBLITE_GPU_MORPH_STORAGE
    if (name == "morphDeltas")
        return mesh.morph_deltas;
    if (name == "morph")
        return mesh.morph_weights;
#else
    (void)mesh;
    (void)name;
#endif
    return nullptr;
}

void bind_composed_mesh_vertex_buffers(SDL_GPURenderPass* pass, SDL_GPUBuffer* vertices,
                                       SDL_GPUBuffer* instances, SDL_GPUBuffer* colors) {
    std::array<SDL_GPUBufferBinding, vertex_streams.size()> bindings{};
    bindings[0] = SDL_GPUBufferBinding{vertices, 0};
    Uint32 count = 1;
    if (instances) {
        bindings[1] = SDL_GPUBufferBinding{instances, 0};
        count = 2;
        if (colors) {
            bindings[2] = SDL_GPUBufferBinding{colors, 0};
            count = 3;
        }
    }
    SDL_BindGPUVertexBuffers(pass, 0, bindings.data(), count);
}

SDL_GPUGraphicsPipeline* secondary_pipeline_for(const SecondaryPipelines& pipelines,
                                                upstream::RenderPipelineKind kind,
                                                std::uint32_t shader_variant,
                                                const char* dispatch) {
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    switch (traits.family) {
    case upstream::RenderMaterialKind::pbr:
        gpu_error((std::string(dispatch) + " reached a PBR pipeline kind; the pinned branch owns "
                                           "every PBR draw.")
                      .c_str());
    case upstream::RenderMaterialKind::standard:
        gpu_error((std::string(dispatch) + " reached a Standard pipeline kind; the pinned branch "
                                           "owns every Standard draw.")
                      .c_str());
    case upstream::RenderMaterialKind::shader: {
        const std::vector<SDL_GPUGraphicsPipeline*>* variants =
            pipeline_kind_wants_a2c(kind) ? pipelines.shader_a2c : pipelines.shader;
        return variants && shader_variant < variants->size() ? (*variants)[shader_variant]
                                                             : nullptr;
    }
    case upstream::RenderMaterialKind::node:
        // Node draws bind their own compiled graphs; a node kind here
        // returns nothing and the caller refuses by name.
        return nullptr;
    }
    return nullptr;
}

GpuMeshSlotMembers mesh_slot_members(upstream::MaterialTextureSource source) {
    using Source = upstream::MaterialTextureSource;
    switch (source) {
    case Source::base_color:
        return {&GpuMesh::base_color, &GpuMesh::base_color_sampler};
    case Source::specular_or_metallic_roughness:
        return {&GpuMesh::metallic_roughness, &GpuMesh::metallic_roughness_sampler};
    case Source::opacity_or_normal:
        return {&GpuMesh::normal, &GpuMesh::normal_sampler};
    case Source::ambient_or_emissive:
        return {&GpuMesh::emissive, &GpuMesh::emissive_sampler};
    case Source::standard_emissive:
        return {&GpuMesh::standard_emissive, &GpuMesh::standard_emissive_sampler};
#if BBLITE_MATERIAL_TRANSMISSION_MAP
    case Source::transmission:
        return {&GpuMesh::transmission, &GpuMesh::transmission_sampler};
#endif
#if BBLITE_MATERIAL_THICKNESS_MAP
    case Source::thickness:
        return {&GpuMesh::thickness, &GpuMesh::thickness_sampler};
#endif
#if BBLITE_MATERIAL_CLEARCOAT
    case Source::clearcoat:
        return {&GpuMesh::clearcoat, &GpuMesh::clearcoat_sampler};
    case Source::clearcoat_roughness:
        return {&GpuMesh::clearcoat_roughness, &GpuMesh::clearcoat_roughness_sampler};
    case Source::clearcoat_normal:
        return {&GpuMesh::clearcoat_normal, &GpuMesh::clearcoat_normal_sampler};
#endif
#if BBLITE_MATERIAL_SHEEN
    case Source::sheen_color:
        return {&GpuMesh::sheen_color, &GpuMesh::sheen_color_sampler};
    case Source::sheen_roughness:
        return {&GpuMesh::sheen_roughness, &GpuMesh::sheen_roughness_sampler};
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    case Source::iridescence:
        return {&GpuMesh::iridescence, &GpuMesh::iridescence_sampler};
    case Source::iridescence_thickness:
        return {&GpuMesh::iridescence_thickness, &GpuMesh::iridescence_thickness_sampler};
#endif
#if BBLITE_MATERIAL_LIGHTMAP
    case Source::lightmap:
        return {&GpuMesh::lightmap, &GpuMesh::lightmap_sampler};
#endif
#if BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP
    case Source::metallic_reflectance:
        return {&GpuMesh::metallic_reflectance, &GpuMesh::metallic_reflectance_sampler};
#endif
#if BBLITE_MATERIAL_REFLECTANCE_MAP
    case Source::reflectance:
        return {&GpuMesh::reflectance, &GpuMesh::reflectance_sampler};
#endif
#if BBLITE_MATERIAL_ANISOTROPY_MAP
    case Source::anisotropy:
        return {&GpuMesh::anisotropy, &GpuMesh::anisotropy_sampler};
#endif
#if BBLITE_MATERIAL_TRANSLUCENCY_COLOR_MAP
    case Source::translucency_color:
        return {&GpuMesh::translucency_color, &GpuMesh::translucency_color_sampler};
#endif
#if BBLITE_MATERIAL_TRANSLUCENCY_INTENSITY_MAP
    case Source::translucency_intensity:
        return {&GpuMesh::translucency_intensity, &GpuMesh::translucency_intensity_sampler};
#endif
#if BBLITE_MATERIAL_SPEC_GLOSS
    case Source::spec_gloss:
        return {&GpuMesh::spec_gloss, &GpuMesh::spec_gloss_sampler};
#endif
#if BBLITE_MATERIAL_OCCLUSION_UV2
    case Source::occlusion_uv2:
        return {&GpuMesh::occlusion, &GpuMesh::occlusion_sampler};
#endif
#if BBLITE_MATERIAL_STANDARD_BUMP
    case Source::standard_bump:
        return {&GpuMesh::standard_bump, &GpuMesh::standard_bump_sampler};
#endif
#if BBLITE_MATERIAL_STANDARD_REFLECTION
    case Source::standard_reflection:
        return {&GpuMesh::standard_reflection, &GpuMesh::standard_reflection_sampler};
#endif
    default:
        return {};
    }
}

void bind_mesh_vertex_buffers(SDL_GPURenderPass* pass, const GpuMesh& mesh) {
#if BBLITE_GPU_INSTANCE_COLORS
    // The matrix pool at slot 1 and the per-instance RGBA rows at slot 2,
    // which the line family's vertex stage reads as `instanceColor`.
    const std::array<SDL_GPUBufferBinding, 3> bindings{
        SDL_GPUBufferBinding{mesh.vertices, 0},
        SDL_GPUBufferBinding{mesh.instances, 0},
        SDL_GPUBufferBinding{mesh.instance_colors, 0},
    };
    SDL_BindGPUVertexBuffers(pass, 0, bindings.data(), static_cast<Uint32>(bindings.size()));
#elif BBLITE_GPU_INSTANCING
    const std::array<SDL_GPUBufferBinding, 2> bindings{
        SDL_GPUBufferBinding{mesh.vertices, 0},
        SDL_GPUBufferBinding{mesh.instances, 0},
    };
    SDL_BindGPUVertexBuffers(pass, 0, bindings.data(), static_cast<Uint32>(bindings.size()));
#else
    const SDL_GPUBufferBinding binding{
        mesh.vertices,
        0,
    };
    SDL_BindGPUVertexBuffers(pass, 0, &binding, 1);
#endif
#if BBLITE_GPU_MORPH_STORAGE
    const std::array<SDL_GPUBuffer*, 2> storage{
        mesh.morph_deltas,
        mesh.morph_weights,
    };
    SDL_BindGPUVertexStorageBuffers(pass, 0, storage.data(), static_cast<Uint32>(storage.size()));
#endif
}

void sync_shader_storage_buffers(GpuState& state, const Engine& engine,
                                 GpuBufferUploadBatch& uploads) {
    sync_storage_records(
        engine.storage_buffers, state.storage_buffers, [] {},
        [&](SDL_GPUBuffer* buffer) { SDL_ReleaseGPUBuffer(state.device, buffer); },
        [&](const void* bytes, std::size_t size) {
            return uploads.upload(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, bytes, size);
        },
        [&](SDL_GPUBuffer* buffer, const void* bytes, std::size_t size) {
            uploads.update(buffer, bytes, size);
        },
        [](const Engine::StorageBufferRecord& source) -> GpuState::StorageBuffer {
            if (!source.gpu || source.disposed)
                return {};
#if BBLITE_COMPUTE_BUFFERS
            const auto allocation =
                std::dynamic_pointer_cast<SdlStorageBuffer>(source.gpu->allocation);
            if (!allocation || !allocation->buffer)
                throw std::runtime_error("Storage allocation does not belong to SDL_GPU.");
            return {allocation->buffer, static_cast<std::size_t>(source.byte_length),
                    source.version, source.gpu};
#else
            throw std::runtime_error("This renderer has no owned storage-buffer support.");
#endif
        });
}

SDL_GPUBuffer* shader_storage_buffer(GpuState& state, const MaterialRecord& material,
                                     const upstream::ShaderVariantInfo& info,
                                     const std::string& name) {
    const auto declared = std::find_if(
        info.storage_buffers.begin(), info.storage_buffers.end(),
        [&](const upstream::ShaderStorageBufferInfo& candidate) { return name == candidate.name; });
    if (declared == info.storage_buffers.end())
        return nullptr;
    const std::size_t slot = static_cast<std::size_t>(declared - info.storage_buffers.begin());
    if (slot >= material.shader_storage_buffers.size())
        return nullptr;
    const StorageBufferHandle handle = material.shader_storage_buffers[slot];
    return handle.value < state.storage_buffers.size()
               ? handle_at(state.storage_buffers, handle).buffer
               : nullptr;
}

void bind_shader_material_textures(GpuState& state, SDL_GPURenderPass* pass,
                                   [[maybe_unused]] const Scene& scene,
                                   [[maybe_unused]] const Engine& engine,
                                   [[maybe_unused]] const MaterialRecord& material,
                                   std::uint32_t variant, const GpuMesh& mesh) {
    const auto& names = state.shader_fragment_slots[variant].textures;
    // A shadow pass can replace a textured receiver material with a
    // texture-free caster while retaining the mesh's receiver-side cache.
    // The active pipeline's reflected slots are authoritative: binding the
    // cached receiver samplers to a zero-slot caster pipeline is invalid.
    if (names.empty())
        return;
    const auto& uploaded = mesh_shader_textures(mesh);
    if (uploaded.empty())
        return;
    state.shader_texture_binding_scratch.assign(uploaded.begin(), uploaded.end());
    const upstream::ShaderVariantInfo& info = upstream::shader_variant_info(variant);
#if BBLITE_SHADOWS_CSM
    for (std::size_t packed = 0; packed < names.size(); ++packed) {
        const auto declared =
            std::find_if(info.samplers.begin(), info.samplers.end(),
                         [&](const char* candidate) { return names[packed] == candidate; });
        if (declared == info.samplers.end())
            continue;
        const std::size_t slot = static_cast<std::size_t>(declared - info.samplers.begin());
        if (slot >= material.shader_csm_textures.size())
            continue;
        const ShadowGeneratorHandle generator = material.shader_csm_textures[slot];
        if (generator.value == invalid_handle)
            continue;
#if BBLITE_SHADOW_RECEIVERS
        if (generator.value >= state.shadow_generators.size()) {
            pal::refuse_invalid_frame_handle("Shader CSM receiver has an invalid generator.");
        }
        if (!handle_at(state.shadow_generators, generator).map ||
            !state.shadow_comparison_sampler) {
            gpu_error("Shader CSM receiver texture is not ready.");
        }
        state.shader_texture_binding_scratch[packed] = {
            handle_at(state.shadow_generators, generator).map, state.shadow_comparison_sampler};
#else
        gpu_error("Shader CSM texture in a build with no shadow receiver.");
#endif
    }
#endif
    if (state.shader_texture_binding_scratch.size() != names.size()) {
        gpu_error((std::string("Shader material texture binding count is stale for '") + info.name +
                   "' (uploaded " + std::to_string(state.shader_texture_binding_scratch.size()) +
                   ", compiled " + std::to_string(names.size()) + ").")
                      .c_str());
    }
    for (std::size_t packed = 0; packed < state.shader_texture_binding_scratch.size(); ++packed) {
        const SDL_GPUTextureSamplerBinding& binding = state.shader_texture_binding_scratch[packed];
        if (!binding.texture || !binding.sampler) {
            gpu_error((std::string("Shader material texture '") + names[packed] + "' is not ready.")
                          .c_str());
        }
    }
    SDL_BindGPUFragmentSamplers(pass, 0, state.shader_texture_binding_scratch.data(),
                                static_cast<Uint32>(state.shader_texture_binding_scratch.size()));
}

void release_gpu_mesh_resources([[maybe_unused]] GpuState* state, GpuMeshResources& mesh) noexcept {
    if (mesh.owns_geometry_buffers) {
        SDL_ReleaseGPUBuffer(state->device, mesh.vertices);
    } else if (mesh.shared_geometry) {
        release_shared_user(mesh.shared_geometry, "Shader geometry reference count underflow.");
    }
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    if (mesh.pinned_bone_texture) {
        SDL_ReleaseGPUTexture(state->device, mesh.pinned_bone_texture);
        mesh.pinned_bone_texture = nullptr;
        mesh.pinned_bone_count = 0;
    }
#endif
#if BBLITE_PBR_VARIANTS > 0
#if BBLITE_VAT
    if (mesh.pinned_vat_texture) {
        SDL_ReleaseGPUTexture(state->device, mesh.pinned_vat_texture);
        mesh.pinned_vat_texture = nullptr;
        mesh.pinned_vat_bones = 0;
        mesh.pinned_vat_frames = 0;
    }
#if BBLITE_VAT_INSTANCES
    if (mesh.pinned_vat_instance_texture) {
        SDL_ReleaseGPUTexture(state->device, mesh.pinned_vat_instance_texture);
        mesh.pinned_vat_instance_texture = nullptr;
        mesh.pinned_vat_instance_texels = 0;
        mesh.pinned_vat_instance_version = 0;
    }
#endif
#endif
#endif
    if (mesh.owns_geometry_buffers) {
        SDL_ReleaseGPUBuffer(state->device, mesh.indices);
    }
    SDL_ReleaseGPUBuffer(state->device, mesh.instances);
#if BBLITE_GPU_INSTANCE_COLORS
    SDL_ReleaseGPUBuffer(state->device, mesh.instance_colors);
#endif
#if BBLITE_GPU_MORPH_STORAGE
    if (mesh.owns_morph_buffers) {
        SDL_ReleaseGPUBuffer(state->device, mesh.morph_deltas);
        SDL_ReleaseGPUBuffer(state->device, mesh.morph_weights);
    }
#endif
    if (mesh.shared_composed_textures) {
        release_shared_user(mesh.shared_composed_textures,
                            "Composed material texture reference count underflow.");
    } else {
        // Non-shared fallback for families that own generated slots without
        // entering the composed-material cache.
        for (const upstream::MaterialTextureSlot& slot_row : upstream::material_texture_slots) {
            if (slot_row.slot == upstream::material_texture_no_slot)
                continue;
            const GpuMeshSlotMembers members = mesh_slot_members(slot_row.source);
            if (members.texture == nullptr)
                continue;
            SDL_ReleaseGPUTexture(state->device, mesh.*members.texture);
            SDL_ReleaseGPUSampler(state->device, mesh.*members.sampler);
        }
    }
    // The shader material's own pairs, which the upload loop created
    // outside the slot table.
    if (mesh.shared_shader_textures) {
        release_shared_user(mesh.shared_shader_textures,
                            "Shader material texture reference count underflow.");
    } else {
        release_sprite_fragment_textures(state->device, mesh.shader_textures);
    }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    if (mesh.shared_plugin_textures) {
        release_shared_user(mesh.shared_plugin_textures,
                            "Plugin material texture reference count underflow.");
    }
#endif
    mesh = GpuMeshResources{};
}

void prune_shared_shader_geometries(GpuState& state) {
    prune_unused_shared(state.shared_shader_geometries, [&](SharedShaderGeometry& geometry) {
        geometry.vertex_buffer.reset();
        geometry.index_buffer.reset();
    });
}

void prune_shared_shader_material_textures(GpuState& state) {
    prune_unused_shared(state.shared_shader_material_textures,
                        [](SharedShaderMaterialTextures& textures) { textures.clear(); });
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    prune_unused_shared(state.shared_plugin_material_textures,
                        [](SharedPluginMaterialTextures& textures) { textures.clear(); });
#endif
    state.shared_material_images.prune();
}

void prune_shared_composed_material_textures(GpuState& state) {
    prune_unused_shared(state.shared_composed_material_textures,
                        [&](SharedComposedMaterialTextures& textures) {
                            release_sprite_fragment_textures(state.device, textures.bindings);
                        });
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal

namespace bbl::pal {

#if BBLITE_HAS_PBR_RENDERER
GpuMesh upload_sdl_gpu_scene_mesh(GpuState& state, Engine& engine, const upstream::RenderItem& item,
                                  GpuBufferUploadBatch* buffer_uploads) {
    const ModelGeometry& geometry = engine.geometries[item.geometry];
    const MeshRecord& mesh_record = handle_at(engine.meshes, item.mesh);
    const bool use_source_indices = mesh_record.detached_imported_mesh
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                                    || item.material_kind == upstream::RenderMaterialKind::node
#endif
        ;
    std::vector<std::uint32_t> source_indices;
    if (use_source_indices && geometry.source_indices_reversed) {
        node_source_indices(geometry, source_indices);
    }
    const auto& upload_indices = source_indices.empty() ? geometry.indices : source_indices;
    const bool shader_material = item.material_kind == upstream::RenderMaterialKind::shader;
    const std::vector<GpuVertex> vertices = mesh_gpu_vertices(geometry, mesh_record);
    const auto upload_mesh_buffer = [&, buffer_uploads](SDL_GPUBufferUsageFlags usage,
                                                        const void* data, std::size_t size) {
        return buffer_uploads ? buffer_uploads->upload(usage, data, size)
                              : upload_buffer(state.device, usage, data, size);
    };
    GpuMesh gpu_mesh{&state};
    if (shader_material) {
#if BBLITE_MESH_POSITION_UPDATE
        // A procedural position stream is mutable and therefore
        // cannot borrow the immutable shader-geometry cache.
        gpu_mesh.vertices = upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_VERTEX, vertices.data(),
                                               vertices.size() * sizeof(GpuVertex));
        gpu_mesh.indices = upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_INDEX, upload_indices.data(),
                                              upload_indices.size() * sizeof(std::uint32_t));
#else
        const SharedGeometryIdentity identity = shared_geometry_identity(vertices, upload_indices);
        gpu_mesh.shared_geometry = find_shared_shader_geometry(state.shared_shader_geometries,
                                                               identity, vertices, upload_indices);
        if (!gpu_mesh.shared_geometry) {
            const bool keep_bytes = shared_geometry_keeps_bytes(vertices);
            auto created = std::make_unique<SharedShaderGeometry>(SharedShaderGeometry{
                .identity = identity,
                .vertices = keep_bytes ? vertices : std::vector<GpuVertex>{},
                .indices = keep_bytes ? upload_indices : std::vector<std::uint32_t>{},
            });
            created->vertex_buffer =
                OwnedSdlBuffer{upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_VERTEX, vertices.data(),
                                                  vertices.size() * sizeof(GpuVertex)),
                               {state.device}};
            created->index_buffer =
                OwnedSdlBuffer{upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_INDEX, upload_indices.data(),
                                                  upload_indices.size() * sizeof(std::uint32_t)),
                               {state.device}};
            state.shared_shader_geometries.push_back(std::move(created));
            gpu_mesh.shared_geometry = state.shared_shader_geometries.back().get();
        }
        ++gpu_mesh.shared_geometry->users;
        gpu_mesh.vertices = gpu_mesh.shared_geometry->vertex_buffer.get();
        gpu_mesh.indices = gpu_mesh.shared_geometry->index_buffer.get();
        gpu_mesh.owns_geometry_buffers = false;
#endif
    } else {
        gpu_mesh.vertices = upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_VERTEX, vertices.data(),
                                               vertices.size() * sizeof(GpuVertex));
        gpu_mesh.indices = upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_INDEX, upload_indices.data(),
                                              upload_indices.size() * sizeof(std::uint32_t));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        if (item.material_kind == upstream::RenderMaterialKind::node) {
            state.node_capture.upload(gpu_mesh.vertices, "node-vertices", vertices.data(),
                                      vertices.size() * sizeof(GpuVertex));
            state.node_capture.upload(gpu_mesh.indices, "node-indices", upload_indices.data(),
                                      upload_indices.size() * sizeof(std::uint32_t));
        }
#endif
    }
#if BBLITE_GPU_MORPH_STORAGE
    gpu_mesh.morph_deltas = state.empty_morph_deltas;
    gpu_mesh.morph_weights = state.empty_morph_weights;
    if (mesh_record.gpu_deformation && !geometry.morph_positions.empty()) {
        gpu_mesh.morph_deltas = nullptr;
        gpu_mesh.morph_weights = nullptr;
        gpu_mesh.owns_morph_buffers = true;
        const std::vector<float> deltas = upstream::pack_morph_deltas(geometry);
        gpu_mesh.morph_deltas = upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                                   deltas.data(), deltas.size() * sizeof(float));
        const std::vector<std::uint8_t> weights_blob = pack_morph_weights(geometry, mesh_record);
        gpu_mesh.morph_weights = upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                                    weights_blob.data(), weights_blob.size());
        gpu_mesh.morph_weights_version = mesh_record.morph_weights_version;
    }
#endif
#if BBLITE_GPU_INSTANCING
    {
        std::vector<std::array<float, 16>> instance_matrices = mesh_record.instance_matrices;
        if (instance_matrices.empty()) {
            std::array<float, 16> identity{};
            identity[0] = 1.0f;
            identity[5] = 1.0f;
            identity[10] = 1.0f;
            identity[15] = 1.0f;
            instance_matrices.push_back(identity);
        }
        // The buffer holds the full capacity pool; dynamic pools
        // draw record.instance_count of it and re-upload through the
        // version-gated per-frame sync below.
        gpu_mesh.instances = upload_mesh_buffer(
            SDL_GPU_BUFFERUSAGE_VERTEX | SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
            instance_matrices.data(), instance_matrices.size() * sizeof(instance_matrices.front()));
        gpu_mesh.instance_count = mesh_record.thin_instanced
                                      ? mesh_record.instance_count
                                      : static_cast<std::uint32_t>(instance_matrices.size());
        gpu_mesh.instance_version = mesh_record.instance_version;
        gpu_mesh.instance_capacity = static_cast<std::uint32_t>(instance_matrices.size());
#if BBLITE_GPU_INSTANCE_COLORS
        {
            // One tightly-packed RGBA row per matrix-pool slot. A
            // colour setter may first run after registration, so
            // the fallback must reserve the established capacity,
            // not one row, before the versioned upload fills it.
            std::vector<float> instance_colors = instance_colors_for_upload(mesh_record);
            instance_colors.resize(std::max(instance_colors.size(), instance_matrices.size() * 4),
                                   1.0f);
            gpu_mesh.instance_colors =
                upload_mesh_buffer(SDL_GPU_BUFFERUSAGE_VERTEX, instance_colors.data(),
                                   instance_colors.size() * sizeof(float));
        }
#endif
    }
#endif
    gpu_mesh.index_count = static_cast<std::uint32_t>(geometry.indices.size());
    gpu_mesh.position_version = geometry.position_version;
    const bool standard_material = item.material_kind == upstream::RenderMaterialKind::standard;
    const MaterialRecord* material = nullptr;
    if (item.material.value < engine.materials.size()) {
        material = &handle_at(engine.materials, item.material);
        if (standard_material && material->reflection_cube < state.reflection_cubes.size()) {
            gpu_mesh.reflection = state.reflection_cubes[material->reflection_cube];
        }
    }
    if (standard_material && !gpu_mesh.reflection) {
        gpu_mesh.reflection = state.reflection_fallback;
    }
    // One backend upload per MATERIAL, then one borrowed pointer per
    // render item. Which record field fills a slot, its sRGB view
    // and fallback texel remain the generated table's. The cache is
    // essential for fractured meshes: their hundreds of pieces
    // intentionally share a very small material set.
    const bool composed_material = item.material_kind == upstream::RenderMaterialKind::pbr ||
                                   item.material_kind == upstream::RenderMaterialKind::standard;
    if (composed_material) {
        const auto found =
            std::find_if(state.shared_composed_material_textures.begin(),
                         state.shared_composed_material_textures.end(), [&](const auto& candidate) {
                             return candidate->material.value == item.material.value &&
                                    candidate->standard_material == standard_material;
                         });
        if (found != state.shared_composed_material_textures.end()) {
            gpu_mesh.shared_composed_textures = found->get();
        } else {
            auto created = std::make_unique<SharedComposedMaterialTextures>(state.device);
            created->material = item.material;
            created->standard_material = standard_material;
            for (const upstream::MaterialTextureSlot& slot_row : upstream::material_texture_slots) {
                if (slot_row.slot == upstream::material_texture_no_slot) {
                    continue;
                }
                const TextureData* data =
                    material ? material_slot_texture(*material, slot_row.source, standard_material)
                             : nullptr;
                const TextureData empty{};
                auto& binding = created->bindings.emplace_back();
                binding.texture = upload_texture(
                    state.device, data ? *data : empty,
                    material_slot_srgb(slot_row.srgb, material, standard_material),
                    material_slot_fallback(slot_row.fallback, material, standard_material));
                binding.sampler = create_texture_sampler(
                    state.device, data ? data->sampler : TextureSamplerState{});
#if BBLITE_DEVICE_RECOVERY
                if (engine.device_recovery && !engine.device_recovery->fallback.object &&
                    (!data || !data->has_image())) {
                    engine.device_recovery->fallback = publish_gpu_texture_identity(engine);
                }
#endif
            }
            state.shared_composed_material_textures.push_back(std::move(created));
            gpu_mesh.shared_composed_textures =
                state.shared_composed_material_textures.back().get();
        }

        std::size_t binding_index = 0;
        for (const upstream::MaterialTextureSlot& slot_row : upstream::material_texture_slots) {
            if (slot_row.slot == upstream::material_texture_no_slot) {
                continue;
            }
            const GpuMeshSlotMembers members = mesh_slot_members(slot_row.source);
            if (members.texture == nullptr) {
                gpu_error("generated texture slot has no SDL_GPU member.");
            }
            if (binding_index >= gpu_mesh.shared_composed_textures->bindings.size()) {
                gpu_error("shared material texture binding shortfall.");
            }
            const SDL_GPUTextureSamplerBinding& binding =
                gpu_mesh.shared_composed_textures->bindings[binding_index++];
            gpu_mesh.*members.texture = binding.texture;
            gpu_mesh.*members.sampler = binding.sampler;
        }
        ++gpu_mesh.shared_composed_textures->users;
    }
    // A shader material's own samplers sit outside the generated
    // slot table: the caller named them, so they bind as fragment
    // samplers of their own.
    //
    // The record stores them in the order `samplers` declared, and
    // the compiled stage keeps whichever its WGSL reads, densely,
    // at registers the compaction pass assigned. So the upload
    // walks that stage's sidecar and pulls each surviving name's
    // texture out of the declared order -- the same name-to-
    // resource resolution the composed Standard variants use. A
    // register naming something the material never declared is a
    // generation bug, not a draw to skip.
    // The caller's own texture slots -- a shader material's declared
    // samplers and a node graph's `TextureBlock` bindings alike --
    // upload the same way: the image's own bytes, the material's own
    // sampler, and the white fallback every slot takes.
    const auto upload_material_slot_texture = [&](SharedMaterialTextures& textures,
                                                  const auto& texture) {
        if (texture.data.render_source) {
            textures.bindings.push_back({nullptr, nullptr});
            return;
        }
        if (const auto& source = texture.data.gpu_source) {
            const auto image = std::dynamic_pointer_cast<SdlComputeTexture>(source->allocation);
            if (source->owners == 0 || !image || !image->texture || !image->sampler)
                throw std::runtime_error("Material texture has no live SDL sampled allocation.");
            textures.append_borrowed_texture(source, image->texture, image->sampler);
            return;
        }
        auto image = state.shared_material_images.acquire(
            texture.data, texture.srgb, {255, 255, 255, 255}, [&] {
                return OwnedSdlTexture{
                    upload_texture(state.device, texture.data, texture.srgb, {255, 255, 255, 255}),
                    {state.device}};
            });
        auto& binding = textures.append_shared_texture(std::move(image));
        binding.sampler = create_texture_sampler(state.device, texture.data.sampler);
    };
    // The caller-owned texture families share one per-MATERIAL
    // cache -- keyed by handle, and a material is exactly one
    // family -- so two meshes sharing one material decode and
    // upload its images once, the same shell the Dawn backend
    // keeps. Only the fill differs: a node graph's textures
    // upload in the order the variant table declares them,
    // because that is the order the draw resolves a declared
    // binding by -- the compaction that reorders a shader
    // material's slots does not reach them, since a node stage
    // names its bindings `nodeTex_<name>` and the draw matches on
    // the name rather than on a register. A shader material's
    // upload instead walks the compiled stage's sidecar and pulls
    // each surviving name's texture out of the declared order.
    if (material && (material->shader_material || material->node_material)) {
        gpu_mesh.shared_shader_textures = find_shared_shader_material_textures(
            state.shared_shader_material_textures, item.material);
        if (!gpu_mesh.shared_shader_textures) {
            auto created = std::make_unique<SharedShaderMaterialTextures>(state.device);
            created->material = item.material;
            if (material->node_material) {
                for (const FileTexture& texture : material->shader_textures) {
                    upload_material_slot_texture(*created, texture);
                }
            } else {
                const upstream::ShaderVariantInfo& shader_info =
                    upstream::shader_variant_info(material->shader_variant);
                const PinnedStageSlots& slots =
                    state.shader_fragment_slots[material->shader_variant];
                for (const std::string& texture_name : slots.textures) {
                    const auto declared = std::find_if(
                        shader_info.samplers.begin(), shader_info.samplers.end(),
                        [&](const char* candidate) { return texture_name == candidate; });
                    if (declared == shader_info.samplers.end()) {
                        gpu_error(shader_sampler_unmapped(shader_info, texture_name).c_str());
                    }
                    const std::size_t slot =
                        static_cast<std::size_t>(declared - shader_info.samplers.begin());
                    if (slot >= material->shader_textures.size()) {
                        gpu_error(
                            shader_sampler_shortfall(shader_info, material->shader_textures.size())
                                .c_str());
                    }
#if BBLITE_SHADOWS_CSM
                    const bool csm_texture =
                        slot < material->shader_csm_textures.size() &&
                        material->shader_csm_textures[slot].value != invalid_handle;
#else
                    constexpr bool csm_texture = false;
#endif
                    if (csm_texture)
                        created->bindings.emplace_back();
                    else
                        upload_material_slot_texture(*created, material->shader_textures[slot]);
                }
            }
            state.shared_shader_material_textures.push_back(std::move(created));
            gpu_mesh.shared_shader_textures = state.shared_shader_material_textures.back().get();
        }
        ++gpu_mesh.shared_shader_textures->users;
    }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    // The textures this material's plugins bound, uploaded once per
    // material through the same caller-owned slot path: the
    // payload's own bytes, its own encoding, its own sampler and
    // the white fallback. `standard_plugin_bindings` resolves a
    // composed binding name to a position in this list.
    if (material && !material->plugin_textures.empty()) {
        gpu_mesh.shared_plugin_textures = find_shared_shader_material_textures(
            state.shared_plugin_material_textures, item.material);
        if (!gpu_mesh.shared_plugin_textures) {
            auto created = std::make_unique<SharedPluginMaterialTextures>(state.device);
            created->material = item.material;
            for (const MaterialPluginTexture& texture : material->plugin_textures) {
                upload_material_slot_texture(*created, texture);
            }
            state.shared_plugin_material_textures.push_back(std::move(created));
            gpu_mesh.shared_plugin_textures = state.shared_plugin_material_textures.back().get();
        }
        ++gpu_mesh.shared_plugin_textures->users;
    }
#endif
    return gpu_mesh;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_SPRITE_RENDERER
void sync_sdl_gpu_scene_sprites(GpuState& state, Engine& engine,
                                std::vector<SpritePass>& sprite_passes,
                                std::vector<SDL_GPUTexture*>& sprite_render_textures,
                                SDL_GPUTextureFormat swapchain_format) {
    sprite_render_textures.resize(engine.sprite_render_textures.size(), nullptr);
    sync_retained_textures(
        engine.sprite_render_textures,
        [&](std::size_t index) { return sprite_render_textures[index] != nullptr; },
        [&] { refuse_disposed_sprite_render_texture_in_use(engine); },
        [&](std::size_t index) {
            auto& texture = sprite_render_textures[index];
            if (texture)
                SDL_ReleaseGPUTexture(state.device, texture);
            texture = nullptr;
        },
        [&](std::size_t index, const SpriteRenderTextureRecord& texture) {
            SDL_GPUTextureCreateInfo info{};
            info.type = SDL_GPU_TEXTURETYPE_2D;
            info.format = swapchain_format;
            info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
            info.width = texture.width;
            info.height = texture.height;
            info.layer_count_or_depth = 1;
            info.num_levels = 1;
            info.sample_count = SDL_GPU_SAMPLECOUNT_1;
            sprite_render_textures[index] = SDL_CreateGPUTexture(state.device, &info);
            if (!sprite_render_textures[index])
                gpu_error("sprite render texture");
        });
    while (sprite_passes.size() < engine.sprite_renderers.size()) {
        sprite_passes.push_back(create_sprite_pass(
            state.device, engine,
            SpriteRendererHandle{static_cast<std::uint32_t>(sprite_passes.size())},
            sprite_render_textures, swapchain_format));
    }
}
#endif

} // namespace bbl::pal
