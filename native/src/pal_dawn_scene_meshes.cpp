// Dawn scene meshes: vertex, material and diagnostic bindings, shader
// storage, the scene mesh upload and its release. SDL_GPU's twin is
// pal_sdl_gpu_scene_meshes.cpp.
#include <bblite/features/compute_buffers.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/mesh_position_update.hpp>
#include <bblite/features/shadows_csm.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
void release_dawn_shader_bindings(DawnShaderBindings& bindings) {
    if (bindings.material)
        bindings.material.reset();
    if (bindings.resources)
        bindings.resources.reset();
    if (bindings.scene)
        bindings.scene.reset();
    if (bindings.storage)
        bindings.storage.reset();
    bindings = {};
}

void release_dawn_composed_material_textures(DawnSharedComposedMaterialTextures& textures) {
    for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
        if (textures.views[slot]) {
            textures.views[slot].reset();
        }
        if (textures.textures[slot]) {
            textures.textures[slot].reset();
        }
        if (textures.samplers[slot]) {
            textures.samplers[slot].reset();
        }
    }
}

void sync_shader_storage_buffers(DawnState& state, const Engine& engine) {
    sync_storage_records(
        engine.storage_buffers, state.shader_storage_buffers,
        [&] { state.release_shader_bindings(); },
        [](WGPUBuffer buffer) { wgpuBufferRelease(buffer); },
        [&](const void* bytes, std::size_t size) {
            return create_buffer(state, WGPUBufferUsage_Storage, bytes, size);
        },
        [&](WGPUBuffer buffer, const void* bytes, std::size_t size) {
            wgpuQueueWriteBuffer(state.queue, buffer, 0, bytes, size);
        },
        [](const Engine::StorageBufferRecord& source) -> DawnState::ShaderStorageBuffer {
            if (!source.gpu || source.disposed)
                return {};
#if BBLITE_COMPUTE_BUFFERS
            const auto allocation =
                std::dynamic_pointer_cast<DawnStorageBuffer>(source.gpu->allocation);
            if (!allocation || !allocation->buffer)
                throw std::runtime_error("Storage allocation does not belong to Dawn.");
            return {allocation->buffer.get(), static_cast<std::size_t>(source.byte_length),
                    source.version, source.gpu};
#else
            throw std::runtime_error("This renderer has no owned storage-buffer support.");
#endif
        });
}

DawnMeshBindings& diagnostic_bindings_for(DawnState& state, DawnMesh& mesh) {
    DawnMeshBindings& bindings = mesh.diagnostic_bindings;
    if (bindings.scene)
        return bindings;
    const auto unserved = [](std::uint32_t group, std::uint32_t binding) {
        dawn_error("the diagnostic program declares @group(" + std::to_string(group) +
                   ") @binding(" + std::to_string(binding) + "), which no mesh resource serves.");
    };
    const auto group_for = [&](std::uint32_t group, auto&& serve) {
        std::vector<WGPUBindGroupEntry> entries;
        for (const WGPUBindGroupLayoutEntry& declared :
             dawn_reflected_layout_entries(diagnostic_stages, group)) {
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = declared.binding;
            serve(entry);
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = diagnostic_group_layout(state, group);
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        return DawnBindGroup{require_dawn_resource(
            wgpuDeviceCreateBindGroup(state.device, &descriptor), "diagnostic bind group")};
    };
    bindings.scene = group_for(1, [&](WGPUBindGroupEntry& entry) {
        if (entry.binding == 0) {
            entry.buffer = state.view_projection;
            entry.size = 64;
#if BBLITE_GPU_DEFORMATION
        } else if (entry.binding == 1) {
            entry.buffer = mesh.deformation_uniforms;
            entry.size = sizeof(DeformationUniforms);
#endif
        } else if (entry.binding == mesh_world_uniform_binding) {
            entry.buffer = mesh.mesh_world_uniform;
            entry.size = 64;
        } else {
            unserved(1, entry.binding);
        }
    });
    bindings.textures = group_for(2, [&](WGPUBindGroupEntry& entry) {
        const std::size_t slot = entry.binding / 2;
        if (slot >= mesh.views.size())
            unserved(2, entry.binding);
        if (entry.binding % 2 == 0)
            entry.textureView = mesh.views[slot];
        else
            entry.sampler = mesh.samplers[slot];
    });
#if BBLITE_GPU_MORPH_STORAGE
    bindings.morph = group_for(0, [&](WGPUBindGroupEntry& entry) {
        if (entry.binding > 1)
            unserved(0, entry.binding);
        entry.buffer = entry.binding == 0 ? mesh.morph_deltas : mesh.morph_weights;
        entry.size = WGPU_WHOLE_SIZE;
    });
#endif
    return bindings;
}

DawnShaderBindings& shader_bindings_for(DawnState& state, [[maybe_unused]] const Scene& scene,
                                        const Engine& engine, DawnMesh& mesh,
                                        MaterialHandle material_handle, std::uint32_t variant,
                                        WGPUBuffer pass_uniforms) {
    if (material_handle.value >= engine.materials.size()) {
        pal::refuse_invalid_frame_handle("Shader draw has an invalid material.");
    }
    const MaterialRecord& material = handle_at(engine.materials, material_handle);
    const upstream::ShaderVariantInfo& info = upstream::shader_variant_info(variant);
    const WGPUBuffer vertex_uniforms =
        info.vertex.present && block_is_shared_scene_matrix(info.vertex)
            ? pass_uniforms
            : mesh.shader_vertex_uniforms;
    const DawnShaderBindingKey key{
        variant,
        material_handle.value,
        vertex_uniforms,
    };
    const auto existing = mesh.shader_bindings.find(key);
    if (existing != mesh.shader_bindings.end())
        return existing->second;

    shader_pipeline_layout_for(state, variant);
    const std::array<WGPUBindGroupLayout, 4> layouts{
        shader_group_layout(state, variant, 0), shader_group_layout(state, variant, 1),
        shader_group_layout(state, variant, 2), shader_group_layout(state, variant, 3)};
    DawnShaderBindings bindings;
    const auto storage_buffer = [&](std::size_t declared_slot) {
        if (declared_slot >= material.shader_storage_buffers.size()) {
            dawn_error((std::string("Shader material storage binding count is "
                                    "stale for '") +
                        info.name + "'.")
                           .c_str());
        }
        const StorageBufferHandle handle = material.shader_storage_buffers[declared_slot];
        if (handle.value >= state.shader_storage_buffers.size() ||
            !handle_at(state.shader_storage_buffers, handle).buffer) {
            dawn_error((std::string("Shader material storage buffer '") +
                        info.storage_buffers[declared_slot].name + "' is not ready.")
                           .c_str());
        }
        return handle_at(state.shader_storage_buffers, handle).buffer;
    };

    std::vector<WGPUBindGroupEntry> storage_entries;
    for (std::size_t slot = 0; slot < info.storage_buffers.size(); ++slot) {
        if (!info.storage_buffers[slot].vertex)
            continue;
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = static_cast<std::uint32_t>(storage_entries.size());
        entry.buffer = storage_buffer(slot);
        entry.size = WGPU_WHOLE_SIZE;
        storage_entries.push_back(entry);
    }
    if (!storage_entries.empty()) {
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[0];
        descriptor.entryCount = storage_entries.size();
        descriptor.entries = storage_entries.data();
        bindings.storage = require_dawn_resource(
            wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.storage) {
            dawn_error("Shader storage bind group creation failed.");
        }
    }

    if (info.vertex.present) {
        if (!vertex_uniforms) {
            dawn_error("Shader vertex uniform buffer is not ready.");
        }
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = 0;
        entry.buffer = vertex_uniforms;
        entry.size = info.vertex.float_size * 4ull;
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[1];
        descriptor.entryCount = 1;
        descriptor.entries = &entry;
        bindings.scene = require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &descriptor),
                                               "mesh bind group");
        if (!bindings.scene) {
            dawn_error("Shader vertex bind group creation failed.");
        }
    }

    std::vector<WGPUBindGroupEntry> resource_entries;
    const auto& textures = mesh_shader_textures(mesh);
    for (std::size_t slot = 0; slot < info.samplers.size(); ++slot) {
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
#if BBLITE_SHADOWS_CSM
        const bool csm = slot < material.shader_csm_textures.size() &&
                         material.shader_csm_textures[slot].value != invalid_handle;
        if (csm) {
#if BBLITE_SHADOW_RECEIVERS
            const ShadowGeneratorHandle generator = material.shader_csm_textures[slot];
            if (generator.value >= engine.shadow_generators.size()) {
                pal::refuse_invalid_frame_handle("Shader CSM receiver has an invalid generator.");
            }
            ensure_shadow_samplers(state);
            view = shadow_map_view(state, engine, generator);
            sampler = state.shadow_comparison_sampler;
#else
            dawn_error("Shader CSM texture in a build with no receiver.");
#endif
        } else
#endif
        {
            if (slot >= textures.size()) {
                dawn_error(shader_sampler_shortfall(info, textures.size()));
            }
            view = textures[slot].view;
            sampler = textures[slot].sampler;
        }
        if (!view || !sampler) {
            dawn_error(
                (std::string("Shader material texture '") + info.samplers[slot] + "' is not ready.")
                    .c_str());
        }
        WGPUBindGroupEntry texture = WGPU_BIND_GROUP_ENTRY_INIT;
        texture.binding = static_cast<std::uint32_t>(slot * 2);
        texture.textureView = view;
        resource_entries.push_back(texture);
        WGPUBindGroupEntry sampler_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler_entry.binding = static_cast<std::uint32_t>(slot * 2 + 1);
        sampler_entry.sampler = sampler;
        resource_entries.push_back(sampler_entry);
    }
    std::uint32_t fragment_storage_binding = static_cast<std::uint32_t>(info.samplers.size() * 2);
    for (std::size_t slot = 0; slot < info.storage_buffers.size(); ++slot) {
        if (!info.storage_buffers[slot].fragment)
            continue;
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = fragment_storage_binding++;
        entry.buffer = storage_buffer(slot);
        entry.size = WGPU_WHOLE_SIZE;
        resource_entries.push_back(entry);
    }
    if (!resource_entries.empty()) {
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[2];
        descriptor.entryCount = resource_entries.size();
        descriptor.entries = resource_entries.data();
        bindings.resources = require_dawn_resource(
            wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.resources) {
            dawn_error("Shader resource bind group creation failed.");
        }
    }

    if (info.fragment.present) {
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = 0;
        entry.buffer = mesh.material_uniforms;
        entry.size = info.fragment.float_size * 4ull;
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[3];
        descriptor.entryCount = 1;
        descriptor.entries = &entry;
        bindings.material = require_dawn_resource(
            wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.material) {
            dawn_error("Shader fragment bind group creation failed.");
        }
    }
    return mesh.shader_bindings.emplace(key, std::move(bindings)).first->second;
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal

namespace bbl::pal {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
void sync_dawn_scene_sprites(DawnState& state, Engine& engine) {
    state.sprite_render_textures.resize(engine.sprite_render_textures.size(), nullptr);
    state.sprite_render_texture_views.resize(engine.sprite_render_textures.size(), nullptr);
    sync_retained_textures(
        engine.sprite_render_textures,
        [&](std::size_t index) { return state.sprite_render_textures[index] != nullptr; },
        [&] { refuse_disposed_sprite_render_texture_in_use(engine); },
        [&](std::size_t index) {
            auto& view = state.sprite_render_texture_views[index];
            auto& texture = state.sprite_render_textures[index];
            if (view)
                wgpuTextureViewRelease(view);
            if (texture)
                wgpuTextureRelease(texture);
            view = nullptr;
            texture = nullptr;
        },
        [&](std::size_t index, const SpriteRenderTextureRecord& texture) {
            WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                               WGPUTextureUsage_CopySrc;
            descriptor.dimension = WGPUTextureDimension_2D;
            descriptor.size = WGPUExtent3D{texture.width, texture.height, 1u};
            descriptor.format = state.surface_format;
            descriptor.mipLevelCount = 1;
            descriptor.sampleCount = 1;
            auto& gpu_texture = state.sprite_render_textures[index];
            auto& gpu_view = state.sprite_render_texture_views[index];
            gpu_texture = wgpuDeviceCreateTexture(state.device, &descriptor);
            if (!gpu_texture)
                dawn_error("sprite render texture");
            gpu_view = create_dawn_texture_view(gpu_texture, nullptr);
            if (!gpu_view)
                dawn_error("sprite render texture view");
        });
    while (state.sprite_passes.size() < engine.sprite_renderers.size()) {
        state.sprite_passes.push_back(create_dawn_sprite_pass(
            state.device, state.queue, state.mips, engine,
            SpriteRendererHandle{static_cast<std::uint32_t>(state.sprite_passes.size())},
            state.sprite_render_textures, state.sprite_render_texture_views, state.surface_format));
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
DawnMesh upload_dawn_scene_mesh(DawnState& state, Engine& engine,
                                const upstream::RenderItem& item) {
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
    DawnMesh mesh(state);
    if (shader_material) {
#if BBLITE_MESH_POSITION_UPDATE
        // Mutable procedural geometry must own its upload instead of
        // borrowing the immutable shader-geometry cache.
        mesh.vertices = create_buffer(state, WGPUBufferUsage_Vertex, vertices.data(),
                                      vertices.size() * sizeof(GpuVertex));
        mesh.indices = create_buffer(state, WGPUBufferUsage_Index, upload_indices.data(),
                                     upload_indices.size() * sizeof(std::uint32_t));
#else
        const SharedGeometryIdentity identity = shared_geometry_identity(vertices, upload_indices);
        mesh.shared_geometry = find_shared_shader_geometry(state.shared_shader_geometries, identity,
                                                           vertices, upload_indices);
        if (!mesh.shared_geometry) {
            const bool keep_bytes = shared_geometry_keeps_bytes(vertices);
            auto created = std::make_unique<DawnSharedShaderGeometry>(DawnSharedShaderGeometry{
                .identity = identity,
                .vertices = keep_bytes ? vertices : std::vector<GpuVertex>{},
                .indices = keep_bytes ? upload_indices : std::vector<std::uint32_t>{},
            });
            state.shared_shader_geometries.push_back(std::move(created));
            mesh.shared_geometry = state.shared_shader_geometries.back().get();
        }
        ++mesh.shared_geometry->users;
        mesh.owns_geometry_buffers = false;
        if (!mesh.shared_geometry->vertex_buffer) {
            mesh.shared_geometry->vertex_buffer =
                create_buffer(state, WGPUBufferUsage_Vertex, vertices.data(),
                              vertices.size() * sizeof(GpuVertex));
            mesh.shared_geometry->index_buffer =
                create_buffer(state, WGPUBufferUsage_Index, upload_indices.data(),
                              upload_indices.size() * sizeof(std::uint32_t));
        }
        mesh.vertices = mesh.shared_geometry->vertex_buffer;
        mesh.indices = mesh.shared_geometry->index_buffer;
#endif
    } else {
        mesh.vertices = create_buffer(state, WGPUBufferUsage_Vertex, vertices.data(),
                                      vertices.size() * sizeof(GpuVertex));
        mesh.indices = create_buffer(state, WGPUBufferUsage_Index, upload_indices.data(),
                                     upload_indices.size() * sizeof(std::uint32_t));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        if (item.material_kind == upstream::RenderMaterialKind::node) {
            state.node_capture.upload(mesh.vertices, "node-vertices", vertices.data(),
                                      vertices.size() * sizeof(GpuVertex));
            state.node_capture.upload(mesh.indices, "node-indices", upload_indices.data(),
                                      upload_indices.size() * sizeof(std::uint32_t));
        }
#endif
    }
    mesh.index_count = static_cast<std::uint32_t>(geometry.indices.size());
#if BBLITE_GPU_DEFORMATION
    mesh.deformation_uniforms =
        create_buffer(state, WGPUBufferUsage_Uniform, nullptr, sizeof(DeformationUniforms));
#endif
    mesh.mesh_world_uniform = create_buffer(state, WGPUBufferUsage_Uniform, nullptr, 64);
#if BBLITE_GPU_MORPH_STORAGE
    mesh.morph_deltas = state.empty_morph_deltas;
    mesh.morph_weights = state.empty_morph_weights;
    if (mesh_record.gpu_deformation && !geometry.morph_positions.empty()) {
        mesh.morph_deltas = nullptr;
        mesh.morph_weights = nullptr;
        mesh.owns_morph_buffers = true;
        const std::vector<float> deltas = upstream::pack_morph_deltas(geometry);
        mesh.morph_deltas = create_buffer(state, WGPUBufferUsage_Storage, deltas.data(),
                                          deltas.size() * sizeof(float));
        const std::vector<std::uint8_t> weights_blob = pack_morph_weights(geometry, mesh_record);
        mesh.morph_weights =
            create_buffer(state, WGPUBufferUsage_Storage, weights_blob.data(), weights_blob.size());
        mesh.morph_weights_version = mesh_record.morph_weights_version;
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
        // draw the record count and re-upload through the frame
        // loop's version-gated mesh-sync pass.
        mesh.instances = create_buffer(
            state, WGPUBufferUsage_Vertex | WGPUBufferUsage_Storage, instance_matrices.data(),
            instance_matrices.size() * sizeof(instance_matrices.front()));
        mesh.instance_count = mesh_record.thin_instanced
                                  ? mesh_record.instance_count
                                  : static_cast<std::uint32_t>(instance_matrices.size());
        mesh.instance_version = mesh_record.instance_version;
        mesh.instance_capacity = static_cast<std::uint32_t>(instance_matrices.size());
#if BBLITE_GPU_INSTANCE_COLORS
        {
            // One tightly-packed RGBA row per matrix-pool slot. A
            // colour setter may first run after registration, so the
            // fallback must reserve the established capacity, not one
            // row, before the versioned upload fills it.
            std::vector<float> instance_colors = instance_colors_for_upload(mesh_record);
            instance_colors.resize(std::max(instance_colors.size(), instance_matrices.size() * 4),
                                   1.0f);
            mesh.instance_colors =
                create_buffer(state, WGPUBufferUsage_Vertex, instance_colors.data(),
                              instance_colors.size() * sizeof(float));
        }
#endif
    }
#endif
    const upstream::ShaderVariantInfo* mesh_shader_info =
        item.material_kind == upstream::RenderMaterialKind::shader
            ? &upstream::shader_variant_info(item.shader_variant)
            : nullptr;
    // A Standard item's blocks live in the pinned standard buffers,
    // so the transcribed material buffer is a 16-byte stub for it.
    mesh.material_uniform_size =
        ((item.material_kind == upstream::RenderMaterialKind::standard ? 16ull
          : mesh_shader_info
              ? std::max<std::uint64_t>(mesh_shader_info->fragment.float_size * 4ull, 16ull)
              // The pinned material blocks own every PBR
              // draw; like the Standard arm this buffer is
              // never written for them, so it stays a stub.
              : 16ull) +
         15) &
        ~15ull;
    mesh.material_uniforms =
        create_buffer(state, WGPUBufferUsage_Uniform, nullptr, mesh.material_uniform_size);
    if (mesh_shader_info) {
        mesh.shader_vertex_uniforms = create_buffer(
            state, WGPUBufferUsage_Uniform, nullptr,
            std::max<std::uint64_t>(mesh_shader_info->vertex.float_size * 4ull, 16ull));
    }
    mesh.position_version = geometry.position_version;

    // Per-slot texture selection reads the generated
    // `material_texture_slots` table -- the same rows the SDL_GPU
    // backend executes -- so which record field a slot takes, its
    // sRGB view and its fallback texel are decided once, at
    // generation; this backend keeps only the upload mechanics.
    const bool standard_material = item.material_kind == upstream::RenderMaterialKind::standard;
    const bool composed_material =
        item.material_kind == upstream::RenderMaterialKind::pbr || standard_material;
    const MaterialRecord* material = nullptr;
    if (item.material.value < engine.materials.size()) {
        material = &handle_at(engine.materials, item.material);
        if (standard_material && material->reflection_cube < state.reflection_cube_views.size()) {
            mesh.reflection = state.reflection_cube_views[material->reflection_cube];
        }
    }
    // The explicit superset bind-group layout still needs inert values
    // for families that do not read generated PBR/Standard slots.
    mesh.views.fill(state.white_view);
    mesh.samplers.fill(state.default_sampler);
    if (composed_material) {
        const auto shared_it =
            std::find_if(state.shared_composed_material_textures.begin(),
                         state.shared_composed_material_textures.end(), [&](const auto& candidate) {
                             return candidate->material.value == item.material.value &&
                                    candidate->standard_material == standard_material;
                         });
        if (shared_it == state.shared_composed_material_textures.end()) {
            auto created = std::make_unique<DawnSharedComposedMaterialTextures>();
            created->material = item.material;
            created->standard_material = standard_material;
            state.shared_composed_material_textures.push_back(std::move(created));
            mesh.shared_composed_textures = state.shared_composed_material_textures.back().get();
            ++mesh.shared_composed_textures->users;
            for (const upstream::MaterialTextureSlot& slot_row : upstream::material_texture_slots) {
                if (slot_row.slot == upstream::material_texture_no_slot) {
                    continue;
                }
                const TextureData* slot_data =
                    material ? material_slot_texture(*material, slot_row.source, standard_material)
                             : nullptr;
                const TextureData empty{};
                const TextureData& data = slot_data ? *slot_data : empty;
                std::uint32_t mip_count = 1;
                mesh.shared_composed_textures->textures[slot_row.slot] = upload_material_texture(
                    state, data, material_slot_srgb(slot_row.srgb, material, standard_material),
                    material_slot_fallback(slot_row.fallback, material, standard_material),
                    mip_count);
                mesh.shared_composed_textures->views[slot_row.slot] = create_dawn_texture_view(
                    mesh.shared_composed_textures->textures[slot_row.slot], nullptr);
                mesh.shared_composed_textures->samplers[slot_row.slot] = create_texture_sampler(
                    state.device, slot_data ? slot_data->sampler : TextureSamplerState{});
            }
        } else {
            mesh.shared_composed_textures = shared_it->get();
            ++mesh.shared_composed_textures->users;
        }
        for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
            if (mesh.shared_composed_textures->views[slot]) {
                mesh.views[slot] = mesh.shared_composed_textures->views[slot];
            }
            if (mesh.shared_composed_textures->samplers[slot]) {
                mesh.samplers[slot] = mesh.shared_composed_textures->samplers[slot];
            }
        }
    }
    const auto upload_material_slot_texture =
        [&](DawnSampledTexture& sampled, const auto& texture,
            std::vector<std::shared_ptr<DawnTexture>>* leases) {
            if (texture.data.render_source)
                return;
            if (const auto& source = texture.data.gpu_source) {
                const auto image =
                    std::dynamic_pointer_cast<DawnComputeTexture>(source->allocation);
                if (source->owners == 0 || !image || !image->sampled_view || !image->sampler)
                    throw std::runtime_error(
                        "Material texture has no live Dawn sampled allocation.");
                sampled.borrowed_image = std::make_shared<GpuTextureLease>(source);
                sampled.texture = image->texture.retain();
                sampled.view = image->sampled_view.retain();
                wgpuSamplerAddRef(image->sampler);
                sampled.sampler = image->sampler.get();
                return;
            }
            const auto upload = [&] {
                std::uint32_t mip_count = 1;
                return DawnTexture{upload_material_texture(state, texture.data, texture.srgb,
                                                           {255, 255, 255, 255}, mip_count)};
            };
            if (leases) {
                auto image = state.shared_material_images.acquire(texture.data, texture.srgb,
                                                                  {255, 255, 255, 255}, upload);
                leases->push_back(image);
                sampled.texture = image->retain();
            } else {
                sampled.texture = upload();
            }
            sampled.view = create_dawn_texture_view(sampled.texture, nullptr);
            sampled.sampler = create_texture_sampler(state.device, texture.data.sampler);
        };
    const auto upload_shader_textures = [&](std::vector<DawnSampledTexture>& textures,
                                            std::vector<std::shared_ptr<DawnTexture>>* leases =
                                                nullptr) {
        for (const FileTexture& texture : material->shader_textures) {
            DawnSampledTexture& sampled = textures.emplace_back();
            upload_material_slot_texture(sampled, texture, leases);
        }
    };
    // A node graph's declared images take the same per-MATERIAL cache
    // the shader family uses -- keyed by handle, and a material is
    // exactly one family -- so two meshes sharing one graph decode and
    // upload its images once, as the SDL backend does. Every other
    // family's `shader_textures` list is empty, so its per-mesh upload
    // stays the no-op it always was.
    if (material && (material->shader_material || material->node_material)) {
        mesh.shared_shader_textures = find_shared_shader_material_textures(
            state.shared_shader_material_textures, item.material);
        if (!mesh.shared_shader_textures) {
            auto created = std::make_unique<DawnSharedShaderMaterialTextures>();
            created->material = item.material;
            state.shared_shader_material_textures.push_back(std::move(created));
            mesh.shared_shader_textures = state.shared_shader_material_textures.back().get();
            ++mesh.shared_shader_textures->users;
            upload_shader_textures(mesh.shared_shader_textures->textures,
                                   &mesh.shared_shader_textures->image_leases);
        } else {
            ++mesh.shared_shader_textures->users;
        }
    } else if (material) {
        upload_shader_textures(mesh.shader_textures);
    }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    // The textures this material's plugins bound, uploaded once per
    // material like every other caller-owned family: the payload, its
    // own encoding and its own sampler, with the white fallback an
    // empty slot takes. The generated `standard_plugin_bindings` table
    // resolves a composed binding name to a position in this list.
    if (material && !material->plugin_textures.empty()) {
        mesh.shared_plugin_textures = find_shared_shader_material_textures(
            state.shared_plugin_material_textures, item.material);
        if (!mesh.shared_plugin_textures) {
            auto created = std::make_unique<DawnSharedPluginMaterialTextures>();
            created->material = item.material;
            state.shared_plugin_material_textures.push_back(std::move(created));
            mesh.shared_plugin_textures = state.shared_plugin_material_textures.back().get();
            ++mesh.shared_plugin_textures->users;
            for (const MaterialPluginTexture& texture : material->plugin_textures) {
                DawnSampledTexture& sampled = mesh.shared_plugin_textures->textures.emplace_back();
                upload_material_slot_texture(sampled, texture,
                                             &mesh.shared_plugin_textures->image_leases);
            }
        } else {
            ++mesh.shared_plugin_textures->users;
        }
    }
#endif
    return mesh;
}
#endif

} // namespace bbl::pal
