// Dawn material variants: the pinned PBR, node and Standard families'
// layouts, resources, pipelines and draws. SDL_GPU's twin is
// pal_sdl_gpu_scene_variants.cpp.
#include <bblite/features/has_clustered_lights.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_standard_uv_transform.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

inline std::uint64_t material_ubo_version(const Engine& engine, const MaterialRecord* material) {
    if (!material)
        return 0;
    const auto* source = handle_find(engine.materials, material->source_material);
    return source ? source->ubo_version : material->ubo_version;
}

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) &&                                                \
    (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_VARIANTS > 0)
void release_variant_family(
    std::map<std::uint32_t, std::map<DawnVariantPipelineKey, WGPURenderPipeline>>& pipelines,
    std::vector<WGPUShaderModule>& fragment_modules,
    std::vector<WGPUShaderModule>& vertex_modules) {
    for (auto& [key, by_variant] : pipelines) {
        static_cast<void>(key);
        for (auto& [variant, pipeline] : by_variant) {
            static_cast<void>(variant);
            if (pipeline)
                wgpuRenderPipelineRelease(pipeline);
        }
    }
    for (WGPUShaderModule module : fragment_modules) {
        if (module)
            wgpuShaderModuleRelease(module);
    }
    for (WGPUShaderModule module : vertex_modules) {
        if (module)
            wgpuShaderModuleRelease(module);
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) &&                                                \
    (BBLITE_PINNED_MATERIAL_VARIANTS || BBLITE_PINNED_BACKGROUNDS)
WGPUBindGroupLayoutEntry variant_layout_entry(const upstream::PinnedVariantBinding& binding,
                                              bool depth_emissive) {
    WGPUBindGroupLayoutEntry layout_entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    layout_entry.binding = binding.binding;
    // Group 1 is shared, so a binding declared only in the vertex stage --
    // the bone palette is the one -- must not be visible to the fragment.
    layout_entry.visibility = 0;
    if (binding.vertex)
        layout_entry.visibility |= WGPUShaderStage_Vertex;
    if (binding.fragment) {
        layout_entry.visibility |= WGPUShaderStage_Fragment;
    }
    switch (binding.kind) {
    case upstream::PinnedBindingKind::sampler:
        layout_entry.sampler.type = depth_emissive || binding.non_filtering_sampler
                                        ? WGPUSamplerBindingType_NonFiltering
                                        : WGPUSamplerBindingType_Filtering;
        break;
    case upstream::PinnedBindingKind::samplerComparison:
        layout_entry.sampler.type = WGPUSamplerBindingType_Comparison;
        break;
    case upstream::PinnedBindingKind::textureDepth2d:
    case upstream::PinnedBindingKind::textureDepth2dArray:
        layout_entry.texture.sampleType = WGPUTextureSampleType_Depth;
        layout_entry.texture.viewDimension =
            binding.kind == upstream::PinnedBindingKind::textureDepth2dArray
                ? WGPUTextureViewDimension_2DArray
                : WGPUTextureViewDimension_2D;
        break;
    case upstream::PinnedBindingKind::storageBuffer:
        // The morph arms' deltas and weights.
        layout_entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
        break;
    case upstream::PinnedBindingKind::uniformBuffer:
        // A group-1 uniform block past mesh and material: the vertex
        // `up` block, the geometry arms' gpUniforms, and a displaced
        // `mat`/`mesh` block riding a reflected row.
        layout_entry.buffer.type = WGPUBufferBindingType_Uniform;
        break;
    default:
        // An rgba32float texture read with textureLoad cannot be bound
        // as filterable; the pin's bone palette is exactly that. An
        // INTEGER texture is a third case -- WebGPU has no sampler for
        // one at all -- and the clustered slice and tile-mask pair are
        // the reached ones.
        layout_entry.texture.sampleType =
            binding.kind == upstream::PinnedBindingKind::texture2dUint ? WGPUTextureSampleType_Uint
            : binding.kind == upstream::PinnedBindingKind::texture2dLoad || depth_emissive
                ? WGPUTextureSampleType_UnfilterableFloat
                : WGPUTextureSampleType_Float;
        layout_entry.texture.viewDimension =
            binding.kind == upstream::PinnedBindingKind::textureCube ? WGPUTextureViewDimension_Cube
            : binding.kind == upstream::PinnedBindingKind::textureCubeArray
                ? WGPUTextureViewDimension_CubeArray
                : WGPUTextureViewDimension_2D;
        break;
    }
    return layout_entry;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
WGPUBindGroupLayoutEntry uniform_layout_entry(std::uint32_t binding, WGPUShaderStage visibility) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = binding;
    entry.visibility = visibility;
    entry.buffer.type = WGPUBufferBindingType_Uniform;
    return entry;
}

WGPUBindGroupLayoutEntry storage_layout_entry(std::uint32_t binding, WGPUShaderStage visibility) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = binding;
    entry.visibility = visibility;
    entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
    return entry;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS
WGPUBindGroupLayout pinned_frame_layout_for(DawnState& state) {
    return state.layouts.group(state.device, {DawnLayoutFamily::frame}, [] {
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (const upstream::PinnedSceneLayoutEntry& row : upstream::pinned_scene_layout) {
            entries.push_back(uniform_layout_entry(
                row.binding, (row.vertex ? WGPUShaderStage_Vertex : WGPUShaderStage_None) |
                                 (row.fragment ? WGPUShaderStage_Fragment : WGPUShaderStage_None)));
        }
        return entries;
    });
}

WGPUPipelineLayout composed_pipeline_layout(DawnState& state, const DawnLayoutKey& key,
                                            WGPUBindGroupLayout draw_layout,
                                            WGPUBindGroupLayout shadow_layout) {
    return state.layouts.pipeline(state.device, key, [&] {
        std::vector<WGPUBindGroupLayout> groups{pinned_frame_layout_for(state), draw_layout};
        if (shadow_layout)
            groups.push_back(shadow_layout);
        return groups;
    });
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    BBLITE_PBR_VARIANTS > 0
WGPUBindGroupLayout pinned_draw_layout_for(DawnState& state, std::size_t variant) {
    return state.layouts.group(state.device, {DawnLayoutFamily::pbr, variant}, [variant] {
        const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
        // `mesh.world` is read in the vertex stage and `mesh.li` in the
        // fragment, so the mesh block is visible to both.
        return reflected_group_layout_entries(
            {
                uniform_layout_entry(0, WGPUShaderStage_Vertex | WGPUShaderStage_Fragment),
                uniform_layout_entry(1, WGPUShaderStage_Fragment |
                                            (entry.material_ubo_vertex ? WGPUShaderStage_Vertex
                                                                       : WGPUShaderStage_None)),
            },
            pbr_variant_rows(variant), [](const upstream::PinnedVariantBinding&) { return false; });
    });
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS
void ensure_pinned_frame_buffers(DawnState& state) {
    if (state.pinned_scene_uniforms)
        return;
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer)
            dawn_error("pinned uniform buffer creation failed.");
        return buffer.release();
    };
    state.pinned_scene_uniforms = uniform_buffer(sizeof(upstream::SceneUniforms));
    // The pin's own header: 16 bytes of count and padding, then MAX_LIGHTS
    // entries. `getLightsUboSize()` states it and the mirrored LightEntry is
    // what makes the entry stride the pin's rather than a guess.
    state.pinned_lights_uniforms =
        uniform_buffer(16 + upstream::pinned_max_lights * sizeof(upstream::LightEntry));
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS && BBLITE_HAS_TAA
void restore_temporal_source_buffer(DawnState& state, FrameTaskRecord& source,
                                    DawnRenderTask& gpu) {
    if (!source.scene_uniforms)
        source.scene_uniforms = upstream::create_persistent_scene_uniforms();
    if (!gpu.pinned_scene_uniforms) {
        const auto& bytes = source.scene_uniforms->drawn;
        gpu.pinned_scene_uniforms = create_buffer(state, WGPUBufferUsage_Uniform, bytes.data(),
                                                  bytes.size() * sizeof(float));
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS
WGPUBindGroup overlay_frame_group(DawnState& state, DawnState::OverlayFrame& overlay) {
    if (!overlay.lights_uniforms) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(16 + upstream::pinned_max_lights *
                                                              sizeof(upstream::LightEntry));
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        overlay.lights_uniforms = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!overlay.lights_uniforms) {
            dawn_error("overlay lights buffer creation failed.");
        }
    }
    return pinned_frame_group_over(state, overlay.scene_uniforms, overlay.frame_group,
                                   "swapchain overlay frame", overlay.lights_uniforms);
}

void write_pinned_geometry_prologue(DawnState& state, const Scene& scene, const Engine& engine,
                                    const CameraRecord& camera, DawnGeometryTask& geometry,
                                    const std::array<float, 16>& geometry_matrix) {
    pinned_geometry_frame_group(state);
    const upstream::SceneUniforms scene_block =
        pinned_scene_block(scene, engine, camera, geometry_matrix);
    wgpuQueueWriteBuffer(state.queue, state.pinned_geometry_scene_uniforms, 0, &scene_block,
                         sizeof(scene_block));
    if (!geometry.pinned_geometry_params) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = sizeof(PinnedGeometryParams);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        geometry.pinned_geometry_params = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!geometry.pinned_geometry_params) {
            dawn_error("pinned geometry params buffer creation failed.");
        }
    }
    if (!geometry.has_previous_view_projection) {
        geometry.previous_view_projection = geometry_matrix;
        geometry.has_previous_view_projection = true;
    }
    const PinnedGeometryParams params{
        geometry.previous_view_projection,
        {
            static_cast<float>(camera.near_plane),
            static_cast<float>(camera.far_plane),
            0.0f,
            0.0f,
        },
    };
    wgpuQueueWriteBuffer(state.queue, geometry.pinned_geometry_params, 0, &params, sizeof(params));
    geometry.previous_view_projection = geometry_matrix;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    BBLITE_PINNED_MATERIALS
PinnedResource state_resource_for(const DawnState& state, upstream::MaterialTextureSource source) {
    switch (source) {
    case upstream::MaterialTextureSource::environment_cube:
        return PinnedResource{state.environment_cube_view, state.default_sampler};
    case upstream::MaterialTextureSource::brdf_lut:
        return PinnedResource{state.brdf_view, state.clamp_sampler};
    case upstream::MaterialTextureSource::scene_color:
        return PinnedResource{state.transmission_color_view, state.transmission_sampler};
    default:
        return {};
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    BBLITE_PBR_VARIANTS > 0
PinnedResource pinned_resource_for(DawnState& state, const DawnMesh& mesh, std::string_view name,
                                   [[maybe_unused]] const MaterialRecord* material) {
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    if (material && mesh.shared_plugin_textures) {
        for (std::size_t index = 0; index < material->plugin_textures.size(); ++index) {
            const auto& binding = material->plugin_textures[index];
            if (binding.texture_name == name || binding.sampler_name == name) {
                auto& sampled = mesh.shared_plugin_textures->textures.at(index);
                if (const auto& source = binding.data.render_source) {
                    if (source->engine_lifetime.expired())
                        throw std::runtime_error("Render texture engine has expired.");
                    const auto& reference = source->reference;
                    const auto& target = handle_at(state.render_targets, reference.target);
                    if (target.color || target.depth) {
                        const auto [texture, view] = dawn_render_target_texture(
                            state, *source->engine, reference.target, reference.depth_only);
                        if (sampled.view.get() != view) {
                            wgpuTextureAddRef(texture);
                            wgpuTextureViewAddRef(view);
                            sampled.texture = texture;
                            sampled.view = view;
                            const auto sampler =
                                reference.depth_only ? state.nearest_sampler : state.ground_sampler;
                            wgpuSamplerAddRef(sampler);
                            sampled.sampler = sampler;
                        }
                    }
                    if (!sampled.view)
                        throw std::runtime_error("Render texture has no live sampled allocation.");
                }
                return {sampled.view, sampled.sampler};
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
                return {local.array_view, state.default_sampler};
            if (slot->source == upstream::MaterialTextureSource::environment_cube &&
                local.source->overrides_environment)
                return {local.cube_view, state.default_sampler};
        }
#endif
        if (slot->slot != upstream::material_texture_no_slot) {
            // The material's own textures, in the generated slot order the
            // upload loop fills.
            return PinnedResource{mesh.views[slot->slot], mesh.samplers[slot->slot]};
        }
        const PinnedResource resource = state_resource_for(state, slot->source);
        if (resource.view != nullptr)
            return resource;
        switch (slot->source) {
        case upstream::MaterialTextureSource::scene_color:
            // The scene-colour grab the pin refracts through. The
            // persistent bind group needs a complete entry before the
            // grab exists, so the base-colour pair stands in until the
            // group is rebuilt with the real texture -- which is the
            // mesh's, so this one arm cannot move to the scene-owned
            // resolver above.
            return PinnedResource{mesh.views[0], mesh.samplers[0]};
        case upstream::MaterialTextureSource::bone_palette:
            return PinnedResource{mesh.pinned_bone_view, nullptr};
#if BBLITE_VAT
        // The baked palette and its per-instance params: the mesh's
        // own textures, textureLoaded like the live palette, so no
        // sampler on this backend either.
        case upstream::MaterialTextureSource::vat_palette:
            return PinnedResource{mesh.pinned_vat_view, nullptr};
#if BBLITE_VAT_INSTANCES
        case upstream::MaterialTextureSource::vat_instance_params:
            return PinnedResource{mesh.pinned_vat_instance_view, nullptr};
#endif
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
        // The clustered field's three, from the container the scene
        // holds. Each is `textureLoad`ed, so none carries a sampler at
        // all on this backend.
        case upstream::MaterialTextureSource::clustered_lights:
            return PinnedResource{state.clustered.lights, nullptr};
        case upstream::MaterialTextureSource::clustered_cells:
            return PinnedResource{state.clustered.cells, nullptr};
        case upstream::MaterialTextureSource::clustered_indices:
            return PinnedResource{state.clustered.indices, nullptr};
#endif
        default:
            break;
        }
    }
    dawn_error(
        (std::string("pinned variant declares an unmapped resource '") + std::string(name) + "'.")
            .c_str());
    return PinnedResource{};
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    BBLITE_GPU_MORPH_STORAGE
void sync_morph_weights(DawnState& state, DawnMesh& mesh, const ModelGeometry& geometry,
                        const MeshRecord& record) {
    if (!mesh.owns_morph_buffers || mesh.morph_weights_version == record.morph_weights_version)
        return;
    const std::vector<float> weights = morph_weight_values(geometry, record);
    wgpuQueueWriteBuffer(state.queue, mesh.morph_weights, 16, weights.data(),
                         weights.size() * sizeof(float));
    mesh.morph_weights_version = record.morph_weights_version;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON)
WGPUTexture create_pinned_float_texture(DawnState& state, std::uint32_t width, std::uint32_t height,
                                        const char* failure) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.size = {width, height, 1};
    descriptor.format = WGPUTextureFormat_RGBA32Float;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.mipLevelCount = 1;
    descriptor.sampleCount = 1;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error(failure);
    return texture.release();
}

void write_pinned_bone_texture(DawnState& state, DawnMesh& mesh, const MeshRecord& record) {
    sync_pinned_bone_palette(
        mesh, record,
        [&](const BonePaletteLayout& palette) {
            if (mesh.pinned_bone_view) {
                wgpuTextureViewRelease(mesh.pinned_bone_view);
            }
            if (mesh.pinned_bone_texture) {
                wgpuTextureRelease(mesh.pinned_bone_texture);
            }
            mesh.pinned_bone_texture = create_pinned_float_texture(
                state, palette.width, palette.height, "pinned bone texture creation failed.");
            mesh.pinned_bone_view = create_dawn_texture_view(mesh.pinned_bone_texture, nullptr);
        },
        [&](const float* floats, const BonePaletteLayout& palette) {
            WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = mesh.pinned_bone_texture;
            WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
            layout.bytesPerRow = palette.bytes;
            layout.rowsPerImage = palette.height;
            WGPUExtent3D extent{palette.width, palette.height, 1};
            wgpuQueueWriteTexture(state.queue, &destination, floats, palette.bytes, &layout,
                                  &extent);
        });
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    BBLITE_PBR_VARIANTS > 0 && BBLITE_VAT
void write_pinned_float_texture(DawnState& state, WGPUTexture texture, const float* data,
                                const VatTextureLayout& layout) {
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout copy = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    copy.bytesPerRow = layout.row_bytes;
    copy.rowsPerImage = layout.height;
    WGPUExtent3D extent{layout.width, layout.height, 1};
    wgpuQueueWriteTexture(state.queue, &destination, data, layout.bytes, &copy, &extent);
}

void write_pinned_vat_texture(DawnState& state, DawnMesh& mesh, const MeshRecord& record,
                              const Engine& engine) {
    sync_pinned_vat(
        mesh, record, engine,
        [&](const VatBakeRecord& bake, const VatTextureLayout& layout) {
            if (mesh.pinned_vat_view)
                wgpuTextureViewRelease(mesh.pinned_vat_view);
            if (mesh.pinned_vat_texture)
                wgpuTextureRelease(mesh.pinned_vat_texture);
            mesh.pinned_vat_texture = create_pinned_float_texture(
                state, layout.width, layout.height, "pinned VAT texture creation failed.");
            mesh.pinned_vat_view = create_dawn_texture_view(mesh.pinned_vat_texture, nullptr);
            if (!mesh.pinned_vat_view)
                dawn_error("pinned VAT texture view creation failed.");
            write_pinned_float_texture(state, mesh.pinned_vat_texture, bake.data.data(), layout);
        },
        [&](const VatData& vat) {
            if (!mesh.pinned_vat_settings) {
                WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
                descriptor.size = sizeof(float) * 8;
                descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
                mesh.pinned_vat_settings = wgpuDeviceCreateBuffer(state.device, &descriptor);
                if (!mesh.pinned_vat_settings)
                    dawn_error("pinned VAT settings buffer creation failed.");
                mesh.pinned_vat_settings_version = 0;
            }
            if (mesh.pinned_vat_settings_version != vat.settings_version) {
                wgpuQueueWriteBuffer(state.queue, mesh.pinned_vat_settings, 0, vat.settings.data(),
                                     sizeof(float) * 8);
                mesh.pinned_vat_settings_version = vat.settings_version;
            }
        },
#if BBLITE_VAT_INSTANCES
        [&](const VatData& vat) {
            if (mesh.pinned_vat_instance_view)
                wgpuTextureViewRelease(mesh.pinned_vat_instance_view);
            if (mesh.pinned_vat_instance_texture)
                wgpuTextureRelease(mesh.pinned_vat_instance_texture);
            mesh.pinned_vat_instance_texture = create_pinned_float_texture(
                state, vat.instance_texels, 1u, "pinned VAT instance texture creation failed.");
            mesh.pinned_vat_instance_view =
                create_dawn_texture_view(mesh.pinned_vat_instance_texture, nullptr);
            if (!mesh.pinned_vat_instance_view)
                dawn_error("pinned VAT instance view creation failed.");
        },
        [&](const VatData& vat, const VatTextureLayout& layout) {
            write_pinned_float_texture(state, mesh.pinned_vat_instance_texture,
                                       vat.instance_params.data(), layout);
        }
#else
        [](const VatData&) {}, [](const VatData&, const VatTextureLayout&) {}
#endif
    );
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS &&                     \
    BBLITE_PBR_VARIANTS > 0
WGPUBindGroup
build_pinned_draw_group(DawnState& state, DawnMesh& mesh, std::size_t variant,
                        WGPUBuffer mesh_uniforms, WGPUBuffer material_uniforms,
                        WGPUBuffer geometry_params,
                        // The material this group is built for, whose ESM caster view names the
                        // generator its `shadowParams` block belongs to.
                        [[maybe_unused]] const MaterialRecord* material) {
#if BBLITE_LOCAL_CUBEMAP
    const auto* local_cubemap = ensure_local_cubemap(state, material);
#endif
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const std::span<const upstream::PinnedVariantBinding> rows = pbr_variant_rows(variant);
    std::vector<WGPUBindGroupEntry> entries;
    entries.reserve(2 + rows.size());
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = mesh_uniforms;
    mesh_entry.size = sizeof(upstream::MeshUniforms);
    WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    material_entry.binding = 1;
    material_entry.buffer = material_uniforms;
    material_entry.size = entry.material_ubo_bytes;
    append_unclaimed_entries(entries, rows, {mesh_entry, material_entry});
    for (const upstream::PinnedVariantBinding& binding : rows) {
        WGPUBindGroupEntry group_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        group_entry.binding = binding.binding;
#if BBLITE_LOCAL_CUBEMAP
        if (local_cubemap &&
            (binding.name == "localProbeData" || binding.name == "localProbeGrid")) {
            const bool uniform = binding.name == "localProbeData";
            group_entry.buffer = uniform ? local_cubemap->uniform : local_cubemap->grid;
            group_entry.size = (uniform ? local_cubemap->source->uniform_data.size()
                                        : local_cubemap->source->grid_data.size()) *
                               sizeof(std::uint32_t);
            entries.push_back(group_entry);
            continue;
        }
#endif
        if (binding.kind == upstream::PinnedBindingKind::uniformBuffer) {
#if BBLITE_SHADOWS_ESM
            // The ESM caster's own block, from the generator its view was
            // built for -- the Standard family's arm, for the family that
            // shares the view's factory.
            if (binding.name == "shadowParams") {
                group_entry.buffer = esm_caster_params_buffer(state, material);
                if (!group_entry.buffer) {
                    dawn_error("an ESM caster draw reached the encode before its "
                               "generator's shadow params.");
                }
                group_entry.size = upstream::shadow_params_block_bytes;
                entries.push_back(group_entry);
                continue;
            }
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
            // The clustered field's params block, from the container the
            // scene holds rather than from this material.
            if (binding.name == "clusteredLightParams") {
                group_entry.buffer = state.clustered.params;
                if (!group_entry.buffer) {
                    dawn_error("a clustered draw reached the encode before its "
                               "container's params buffer.");
                }
                group_entry.size = sizeof(std::uint32_t) * 8;
                entries.push_back(group_entry);
                continue;
            }
#endif
#if BBLITE_VAT
            // The pin's 32-byte VAT settings: params then clock, written
            // on the mesh's own buffer by play/update.
            if (binding.name == "vat") {
                group_entry.buffer = mesh.pinned_vat_settings;
                if (!group_entry.buffer) {
                    dawn_error("a baked draw reached the encode before its VAT "
                               "settings block.");
                }
                group_entry.size = sizeof(float) * 8;
                entries.push_back(group_entry);
                continue;
            }
#endif
            // The geometry arms' gpUniforms, per task.
            if (binding.name != "gp" || !geometry_params) {
                dawn_error(("pinned variant declares an unmapped uniform "
                            "block '" +
                            std::string(binding.name) + "'.")
                               .c_str());
            }
            group_entry.buffer = geometry_params;
            group_entry.size = sizeof(PinnedGeometryParams);
            entries.push_back(group_entry);
            continue;
        }
        if (binding.kind == upstream::PinnedBindingKind::storageBuffer) {
            // The morph arms' storage, by the pin's own names. These are the
            // same buffers the transcribed stage read: the upload loop
            // maintains the deltas and the {count, vertexCount}-headed
            // weights in the pin's own layout.
#if BBLITE_GPU_MORPH_STORAGE
            if (binding.name == "morphDeltas") {
                group_entry.buffer = mesh.morph_deltas;
            } else if (binding.name == "morph") {
                group_entry.buffer = mesh.morph_weights;
            }
#endif
            if (!group_entry.buffer) {
                dawn_error(("pinned variant declares an unmapped storage buffer '" +
                            std::string(binding.name) + "'.")
                               .c_str());
            }
            group_entry.size = WGPU_WHOLE_SIZE;
            entries.push_back(group_entry);
            continue;
        }
        const PinnedResource resource = pinned_resource_for(state, mesh, binding.name, material);
        if (binding.kind == upstream::PinnedBindingKind::sampler ||
            binding.kind == upstream::PinnedBindingKind::samplerComparison) {
            group_entry.sampler = resource.sampler;
        } else {
            group_entry.textureView = resource.view;
        }
        entries.push_back(group_entry);
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = pinned_draw_layout_for(state, variant);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group) {
        dawn_error("pinned variant draw bind group creation failed.");
    }
    return group.release();
}

DawnDrawState& ensure_pinned_draw_bindings(DawnState& state, DawnMesh& mesh, std::uint32_t material,
                                           std::size_t variant, const MaterialRecord* record) {
    DawnDrawState& draw_state = mesh.pinned_states.try_emplace(material, state).first->second;
    auto& allocations = draw_state.plugin_texture_allocations;
    std::size_t allocation_count = 0;
    bool allocations_changed = false;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    if (record)
        for (const auto& binding : record->plugin_textures) {
            if (const auto& source = binding.data.render_source) {
                const auto allocation =
                    state.render_targets.at(source->reference.target.value).allocation;
                if (allocation_count == allocations.size()) {
                    allocations.push_back(allocation);
                    allocations_changed = true;
                } else if (allocations[allocation_count] != allocation) {
                    allocations[allocation_count] = allocation;
                    allocations_changed = true;
                }
                ++allocation_count;
            }
        }
#endif
    if (allocation_count != allocations.size()) {
        allocations.resize(allocation_count);
        allocations_changed = true;
    }
    if (draw_state.group && draw_state.group_key == variant && !allocations_changed) {
        return draw_state;
    }
    if (draw_state.group)
        wgpuBindGroupRelease(draw_state.group);
    draw_state.group = nullptr;
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer)
            dawn_error("pinned draw buffer creation failed.");
        return buffer.release();
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms = uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    // Sized by the variant, so a swap to one with more fields reallocates.
    if (WGPUBuffer old =
            std::exchange(draw_state.material_uniforms, uniform_buffer(entry.material_ubo_bytes))) {
        wgpuBufferRelease(old);
    }
    draw_state.material_upload.reset();
    draw_state.group = build_pinned_draw_group(state, mesh, variant, draw_state.mesh_uniforms,
                                               draw_state.material_uniforms, nullptr, record);
    draw_state.group_key = variant;
    return draw_state;
}

DawnDrawState& ensure_pinned_geometry_bindings(DawnState& state, DawnMesh& mesh,
                                               std::size_t variant, WGPUBuffer geometry_params) {
    auto existing = mesh.pinned_geometry_states.find(variant);
    if (existing != mesh.pinned_geometry_states.end()) {
        return existing->second;
    }
    DawnDrawState draw_state{state};
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer)
            dawn_error("pinned geometry buffer creation failed.");
        return buffer.release();
    };
    draw_state.mesh_uniforms = uniform_buffer(sizeof(upstream::MeshUniforms));
    draw_state.material_uniforms = uniform_buffer(entry.material_ubo_bytes);
    draw_state.group = build_pinned_draw_group(state, mesh, variant, draw_state.mesh_uniforms,
                                               draw_state.material_uniforms, geometry_params);
    return mesh.pinned_geometry_states.emplace(variant, std::move(draw_state)).first->second;
}

void write_pinned_draw_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                              const upstream::RenderDrawCommand& draw, std::size_t variant,
                              DawnDrawState& draw_state) {
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const upstream::MeshUniforms mesh_block = pinned_mesh_block(scene, engine, draw.item.mesh);
    wgpuQueueWriteBuffer(state.queue, draw_state.mesh_uniforms, 0, &mesh_block, sizeof(mesh_block));
    const auto& material = handle_at(engine.materials, draw.item.material);
    const auto upload =
        std::tuple(state.material_upload_frame, material_ubo_version(engine, &material), variant,
                   draw.item.material.value);
    if (draw_state.material_upload == upload)
        return;
    std::vector<std::uint8_t> material_block(entry.material_ubo_bytes, 0);
    upstream::write_pbr_variant_material(variant, material, material_block.data(),
                                         entry.material_ubo_bytes);
    wgpuQueueWriteBuffer(state.queue, draw_state.material_uniforms, 0, material_block.data(),
                         entry.material_ubo_bytes);
    draw_state.material_upload = upload;
}

void write_pinned_geometry_task(DawnState& state, const Scene& scene, const Engine& engine,
                                const FrameTaskRecord& task, DawnGeometryTask& geometry,
                                const upstream::RenderDrawLists& draw_lists) {
    for (const auto* list : {&draw_lists.opaque, &draw_lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (draw.item.material_kind != upstream::RenderMaterialKind::pbr) {
                continue;
            }
            if (draw.item_index >= state.meshes.size())
                continue;
            pal::PinnedVariantKey geometry_key;
            const std::size_t variant = pinned_variant_for_draw(
                scene, engine, draw, static_cast<std::size_t>(task.geometry.shader_index),
                &geometry_key);
            if (variant == npos) {
                dawn_error(("PBR draw for mesh " + std::to_string(draw.item.mesh.value) +
                            ", material " + std::to_string(draw.item.material.value) +
                            " resolves no pinned variant in a geometry task: " +
                            pal::pinned_variant_request(
                                geometry_key, static_cast<std::size_t>(task.geometry.shader_index)))
                               .c_str());
            }
            DawnMesh& mesh = state.meshes[draw.item_index];
            DawnDrawState& draw_state = ensure_pinned_geometry_bindings(
                state, mesh, variant, geometry.pinned_geometry_params);
            write_pinned_draw_blocks(state, scene, engine, draw, variant, draw_state);
        }
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS
void write_pinned_frame_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                               const upstream::SceneUniforms& scene_block) {
    ensure_pinned_frame_buffers(state);
    wgpuQueueWriteBuffer(state.queue, state.pinned_scene_uniforms, 0, &scene_block,
                         sizeof(scene_block));
    const std::vector<std::uint8_t> lights = pinned_lights_block(scene, engine);
    wgpuQueueWriteBuffer(state.queue, state.pinned_lights_uniforms, 0, lights.data(),
                         lights.size());
}

InstanceStreams instance_streams_for([[maybe_unused]] const MeshRecord& record,
                                     [[maybe_unused]] const DawnMesh& mesh) {
#if BBLITE_GPU_INSTANCING
    if (!pinned_record_instanced(record) || !mesh.instances) {
        return InstanceStreams{};
    }
    InstanceStreams streams{mesh.instances, nullptr, mesh.instance_count};
#if BBLITE_GPU_INSTANCE_COLORS
    // The colour lane rides the pool: the composed variant declares it only
    // for a record whose pool carries colours, so the same record test
    // answers the key and the binding.
    if (pinned_record_instance_colored(record)) {
        streams.colors = mesh.instance_colors;
    }
#endif
    return streams;
#else
    return InstanceStreams{};
#endif
}

void encode_variant_draw(WGPURenderPassEncoder pass, WGPURenderPipeline pipeline,
                         WGPURenderPipeline& bound_pipeline, WGPUBindGroup frame_group,
                         WGPUBindGroup draw_group, WGPUBuffer vertex_buffer,
                         InstanceStreams instances, WGPUBuffer index_buffer,
                         std::uint32_t index_count,
                         // Group 2, bound only by a draw whose composed fragment declares it:
                         // the pin binds it under exactly the same test (`receiveShadows &&
                         // shadowBindGroup`).
                         WGPUBindGroup shadow_group) {
    if (pipeline != bound_pipeline) {
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        bound_pipeline = pipeline;
    }
    wgpuRenderPassEncoderSetBindGroup(pass, 0, frame_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(pass, 1, draw_group, 0, nullptr);
    if (shadow_group) {
        wgpuRenderPassEncoderSetBindGroup(pass, 2, shadow_group, 0, nullptr);
    }
    wgpuRenderPassEncoderSetVertexBuffer(pass, vertex_stream_slot(VertexInputStream::vertex),
                                         vertex_buffer, 0, WGPU_WHOLE_SIZE);
    if (instances.matrices) {
        wgpuRenderPassEncoderSetVertexBuffer(pass,
                                             vertex_stream_slot(VertexInputStream::instance_matrix),
                                             instances.matrices, 0, WGPU_WHOLE_SIZE);
    }
    if (instances.colors) {
        wgpuRenderPassEncoderSetVertexBuffer(pass,
                                             vertex_stream_slot(VertexInputStream::instance_color),
                                             instances.colors, 0, WGPU_WHOLE_SIZE);
    }
    wgpuRenderPassEncoderSetIndexBuffer(pass, index_buffer, WGPUIndexFormat_Uint32, 0,
                                        WGPU_WHOLE_SIZE);
    count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, index_count, instances.count, 0, 0, 0);
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_STANDARD_VARIANTS > 0
WGPUBindGroupLayout standard_draw_layout_for(DawnState& state, std::size_t variant,
                                             bool unfilterable_emissive) {
    return state.layouts.group(
        state.device, {DawnLayoutFamily::standard, variant, unfilterable_emissive ? 1u : 0u},
        [variant, unfilterable_emissive] {
            return reflected_group_layout_entries(
                {
                    uniform_layout_entry(0, WGPUShaderStage_Vertex | WGPUShaderStage_Fragment),
                    uniform_layout_entry(1, WGPUShaderStage_Fragment),
                },
                standard_variant_rows(variant),
                [unfilterable_emissive](const upstream::PinnedVariantBinding& row) {
                    return unfilterable_emissive && (row.name == "eT" || row.name == "eS");
                });
        });
}

WGPUPipelineLayout standard_pipeline_layout_for(DawnState& state, std::size_t variant,
                                                bool unfilterable_emissive) {
    return composed_pipeline_layout(
        state, {DawnLayoutFamily::standard, variant, unfilterable_emissive ? 1u : 0u},
        standard_draw_layout_for(state, variant, unfilterable_emissive),
        pal::standard_variant_receives_shadows(variant)
            ? shadow_layout_for(state, DawnLayoutFamily::standard_shadow, variant)
            : nullptr);
}

WGPUBindGroup
build_standard_draw_group(DawnState& state, DawnMesh& mesh, const MaterialRecord* material,
                          std::size_t variant, WGPUBuffer mesh_uniforms,
                          WGPUBuffer material_uniforms, WGPUBuffer uv_uniforms,
                          // Bound only when the composed variant declares the extension's block,
                          // which is a reflected binding name rather than a compile-time fact --
                          // the same shape `geometry_params` takes below.
                          [[maybe_unused]] WGPUBuffer uv_transform_uniforms,
                          WGPUBuffer geometry_params, StandardRenderViews render_views) {
    const WGPUTextureView emissive_render_view = render_views.emissive;
    const WGPUTextureView diffuse_render_view = render_views.diffuse;
    const bool unfilterable_emissive = emissive_render_view != nullptr;
    // The fixed mesh@0/material@1 entries yield to reflected rows exactly
    // as the layout's do.
    const std::span<const upstream::PinnedVariantBinding> rows = standard_variant_rows(variant);
    std::vector<WGPUBindGroupEntry> entries;
    entries.reserve(2 + rows.size());
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = mesh_uniforms;
    mesh_entry.size = sizeof(upstream::MeshUniforms);
    WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    material_entry.binding = 1;
    material_entry.buffer = material_uniforms;
    material_entry.size = upstream::standard_material_ubo_bytes;
    append_unclaimed_entries(entries, rows, {mesh_entry, material_entry});
    for (const upstream::PinnedVariantBinding& binding : rows) {
        WGPUBindGroupEntry group_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        group_entry.binding = binding.binding;
        if (binding.kind == upstream::PinnedBindingKind::uniformBuffer) {
            if (binding.name == "up") {
                group_entry.buffer = uv_uniforms;
                group_entry.size = sizeof(upstream::StandardUvTransformUniforms);
#if BBLITE_HAS_STANDARD_UV_TRANSFORM
            } else if (binding.name == "stdUvTx") {
                group_entry.buffer = uv_transform_uniforms;
                group_entry.size = sizeof(upstream::StandardUvTxUniforms);
#endif
            } else if (binding.name == "gp" && geometry_params) {
                group_entry.buffer = geometry_params;
                group_entry.size = sizeof(PinnedGeometryParams);
            } else if (binding.name == "mat") {
                // The material block, displaced past hand-managed
                // binding 1 by the morph storage pair.
                group_entry.buffer = material_uniforms;
                group_entry.size = upstream::standard_material_ubo_bytes;
            } else if (binding.name == "mesh") {
                // The mesh block's mirror arm, should a variant ever
                // displace binding 0 the same way.
                group_entry.buffer = mesh_uniforms;
                group_entry.size = sizeof(upstream::MeshUniforms);
#if BBLITE_SHADOWS_ESM
            } else if (binding.name == "shadowParams" &&
                       esm_caster_params_buffer(state, material)) {
                group_entry.buffer = esm_caster_params_buffer(state, material);
                group_entry.size = upstream::shadow_params_block_bytes;
#endif
            } else {
                dawn_error(("standard variant declares an unmapped uniform "
                            "block '" +
                            std::string(binding.name) + "'.")
                               .c_str());
            }
            entries.push_back(group_entry);
            continue;
        }
        if (binding.kind == upstream::PinnedBindingKind::storageBuffer) {
#if BBLITE_GPU_MORPH_STORAGE
            if (binding.name == "morphDeltas") {
                group_entry.buffer = mesh.morph_deltas;
            } else if (binding.name == "morph") {
                group_entry.buffer = mesh.morph_weights;
            }
#endif
            if (!group_entry.buffer) {
                dawn_error(("standard variant declares an unmapped storage "
                            "buffer '" +
                            std::string(binding.name) + "'.")
                               .c_str());
            }
            group_entry.size = WGPU_WHOLE_SIZE;
            entries.push_back(group_entry);
            continue;
        }
        // The generated name->slot rows; the cube pair and the
        // depth-sampled emissive are the resources outside the table.
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        bool matched = false;
        for (const upstream::StandardBindingResource& row : upstream::standard_binding_resources) {
            if (binding.name != row.texture_name && binding.name != row.sampler_name) {
                continue;
            }
            matched = true;
            if (row.reflection_cube) {
                view = mesh.reflection;
                sampler = state.default_sampler;
#if BBLITE_STANDARD_SKELETON
            } else if (row.source == upstream::MaterialTextureSource::bone_palette) {
                view = mesh.pinned_bone_view;
#endif
            } else if (row.source == upstream::MaterialTextureSource::standard_emissive &&
                       material != nullptr && material->has_emissive_render_texture) {
                view = emissive_render_view;
                sampler = state.nearest_sampler;
            } else if (row.source == upstream::MaterialTextureSource::base_color &&
                       material != nullptr && material->has_diffuse_render_texture) {
                // `material.diffuseTexture = <render target>`: a colour
                // attachment, which rtt.ts hands the pin's bilinear
                // sampler (`getBilinearSampler`: linear mag/min over
                // WebGPU's clamp default). This backend's clamp sampler
                // differs only in its mip filter, and buildRenderTarget
                // allocates one level, so nothing samples past mip 0.
                view = diffuse_render_view;
                sampler = state.clamp_sampler;
            } else {
                // By source, not by name: the row names are the pin's own
                // std bindings (dT/oT/rT...), the slot table's names are
                // the PBR pinned bindings, and the row's declared source
                // is the join key -- the same resolution the SDL sibling's
                // mesh_slot_members makes.
                const upstream::MaterialTextureSlot* slot = material_slot_for_source(row.source);
                if (slot == nullptr || slot->slot == upstream::material_texture_no_slot) {
                    dawn_error(("standard variant resource '" + std::string(binding.name) +
                                "' has no material slot.")
                                   .c_str());
                }
                view = mesh.views[slot->slot];
                sampler = mesh.samplers[slot->slot];
            }
            break;
        }
        (void)unfilterable_emissive;
        if (!matched) {
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
            // A material plugin's own declaration. The name alone does not
            // resolve it -- two plugin lists may declare the same WGSL
            // name -- so the row is found by the material's own signature
            // index, and the texture is that material's, at the position
            // the pin's `bindPluginTextures` fills.
            const upstream::StandardPluginBinding* plugin_row =
                material ? upstream::standard_plugin_binding_for(binding.name,
                                                                 material->plugin_signature_index)
                         : nullptr;
            if (plugin_row && mesh.shared_plugin_textures) {
                if (plugin_row->ordinal >= mesh.shared_plugin_textures->textures.size()) {
                    dawn_error(("standard variant plugin resource '" + std::string(binding.name) +
                                "' has no bound texture.")
                                   .c_str());
                }
                const DawnSampledTexture& plugin_texture =
                    mesh.shared_plugin_textures->textures[plugin_row->ordinal];
                view = plugin_texture.view;
                sampler = plugin_texture.sampler;
                matched = true;
            }
#endif
            if (!matched) {
                dawn_error(("standard variant declares an unmapped resource '" +
                            std::string(binding.name) + "'.")
                               .c_str());
            }
        }
        if (binding.kind == upstream::PinnedBindingKind::sampler ||
            binding.kind == upstream::PinnedBindingKind::samplerComparison) {
            group_entry.sampler = sampler;
        } else {
            group_entry.textureView = view;
        }
        entries.push_back(group_entry);
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = standard_draw_layout_for(state, variant, unfilterable_emissive);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group) {
        dawn_error("standard variant draw bind group creation failed.");
    }
    return group.release();
}

DawnDrawState& ensure_standard_draw_buffers(DawnState& state, DawnMesh& mesh,
                                            std::uint32_t material) {
    DawnDrawState& draw_state = mesh.standard_states.try_emplace(material, state).first->second;
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer)
            dawn_error("standard draw buffer creation failed.");
        return buffer.release();
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms = uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    if (!draw_state.material_uniforms) {
        draw_state.material_uniforms = uniform_buffer(upstream::standard_material_ubo_bytes);
    }
    if (!draw_state.uv_uniforms) {
        draw_state.uv_uniforms = uniform_buffer(sizeof(upstream::StandardUvTransformUniforms));
    }
#if BBLITE_HAS_STANDARD_UV_TRANSFORM
    if (!draw_state.uv_transform_uniforms) {
        draw_state.uv_transform_uniforms = uniform_buffer(sizeof(upstream::StandardUvTxUniforms));
    }
#endif
    return draw_state;
}

StandardRenderViews standard_render_views(DawnState& state, const Engine& engine,
                                          const MaterialRecord* material) {
    if (!material)
        return {};
    const auto view = [&](const RenderTextureRef& reference) {
        if (reference.source != RenderTextureSource::render_target) {
            dawn_error("a material render texture must name a render target "
                       "built by createRenderTargetTexture.");
        }
        return dawn_render_target_texture(state, engine, reference.target, reference.depth_only)
            .second;
    };
    return StandardRenderViews{
        material->has_emissive_render_texture ? view(material->emissive_render_texture) : nullptr,
        material->has_diffuse_render_texture ? view(material->diffuse_render_texture) : nullptr,
    };
}

void write_standard_draw_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                                const upstream::RenderDrawCommand& draw, WGPUBuffer mesh_uniforms,
                                DawnDrawState& material_state,
                                const PinnedVelocityHistory* velocity_history) {
    const MaterialRecord* material = handle_find(engine.materials, draw.item.material);
    const upstream::MeshUniforms mesh_block =
        pinned_mesh_block(scene, engine, draw.item.mesh, velocity_history);
    wgpuQueueWriteBuffer(state.queue, mesh_uniforms, 0, &mesh_block, sizeof(mesh_block));
    std::uint32_t features = material ? upstream::standard_material_features(*material) : 0u;
    if (material && material->no_color) {
        features |= upstream::standard_no_color_output_flag;
    }
    const auto upload =
        std::tuple(state.material_upload_frame, material_ubo_version(engine, material),
                   static_cast<std::size_t>(features), draw.item.material.value);
    if (material_state.material_upload == upload)
        return;
    const upstream::StandardMaterialUniforms material_block =
        standard_material_block(material, features);
    wgpuQueueWriteBuffer(state.queue, material_state.material_uniforms, 0, &material_block,
                         sizeof(material_block));
    const upstream::StandardUvTransformUniforms uv_block = standard_uv_block(material, features);
    wgpuQueueWriteBuffer(state.queue, material_state.uv_uniforms, 0, &uv_block, sizeof(uv_block));
#if BBLITE_HAS_STANDARD_UV_TRANSFORM
    const upstream::StandardUvTxUniforms uv_transform = standard_uv_transform_block(material);
    wgpuQueueWriteBuffer(state.queue, material_state.uv_transform_uniforms, 0, &uv_transform,
                         sizeof(uv_transform));
#endif
    material_state.material_upload = upload;
}

void write_standard_geometry_task(DawnState& state, const Scene& scene, const Engine& engine,
                                  const FrameTaskRecord& task, DawnGeometryTask& geometry,
                                  const upstream::RenderDrawLists& draw_lists) {
    for (const auto* list : {&draw_lists.opaque, &draw_lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (draw.item.material_kind != upstream::RenderMaterialKind::standard) {
                continue;
            }
            if (draw.item_index >= state.meshes.size())
                continue;
            const std::size_t variant = standard_variant_for_draw(
                scene, engine, draw, static_cast<std::size_t>(task.geometry.shader_index));
            if (variant == npos) {
                dawn_error(("Standard draw for mesh " + std::to_string(draw.item.mesh.value) +
                            ", material " + std::to_string(draw.item.material.value) +
                            " resolves no composed variant in a geometry task: " +
                            standard_variant_request(scene, engine, draw))
                               .c_str());
            }
            DawnMesh& mesh = state.meshes[draw.item_index];
#if BBLITE_STANDARD_SKELETON
            if (upstream::standard_variant_skeleton(upstream::standard_variants[variant])) {
                write_pinned_bone_texture(state, mesh, handle_at(engine.meshes, draw.item.mesh));
            }
#endif
            const MaterialRecord* material = handle_find(engine.materials, draw.item.material);
            DawnDrawState& colour_state =
                ensure_standard_draw_buffers(state, mesh, draw.item.material.value);
            DawnDrawState& draw_state =
                mesh.standard_geometry_states.try_emplace(variant, state).first->second;
            // A geometry task's mesh block carries its own renderable's
            // velocity tail, and every queue write lands before the frame's
            // submission — so a geometry variant cannot share the colour
            // pass's mesh buffer, or another task's, without the last writer
            // poisoning the other pass. Each geometry draw state owns its
            // mesh block; the material and uv blocks are the same bytes in
            // every pass and stay shared.
            if (!draw_state.mesh_uniforms) {
                WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
                descriptor.size = sizeof(upstream::MeshUniforms);
                descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
                draw_state.mesh_uniforms = wgpuDeviceCreateBuffer(state.device, &descriptor);
                if (!draw_state.mesh_uniforms) {
                    dawn_error("standard geometry mesh buffer creation failed.");
                }
            }
            write_standard_draw_blocks(state, scene, engine, draw, draw_state.mesh_uniforms,
                                       colour_state, &geometry.velocity);
            if (!draw_state.group) {
                draw_state.group = build_standard_draw_group(
                    state, mesh, material, variant, draw_state.mesh_uniforms,
                    colour_state.material_uniforms, colour_state.uv_uniforms,
                    colour_state.uv_transform_uniforms, geometry.pinned_geometry_params,
                    // A geometry task writes the MRT attachments and
                    // samples neither slot, and its layout arm is the
                    // filterable one, so it binds neither view.
                    StandardRenderViews{});
            }
        }
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PBR_VARIANTS > 0
WGPUPipelineLayout pinned_pipeline_layout_for(DawnState& state, std::size_t variant) {
    return composed_pipeline_layout(
        state, {DawnLayoutFamily::pbr, variant}, pinned_draw_layout_for(state, variant),
        pal::pbr_variant_receives_shadows(variant)
            ? shadow_layout_for(state, DawnLayoutFamily::pbr_shadow, variant)
            : nullptr);
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_MATERIALS
bool append_variant_attribute(std::string_view name, std::uint32_t location,
                              VariantVertexAttributes& inputs) {
    const PinnedVertexInput input = pinned_vertex_input(name);
    if (!input.mapped)
        return false;
    WGPUVertexAttribute attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
    attribute.shaderLocation = location;
    attribute.offset = input.offset;
    switch (input.lane) {
    case VertexInputLane::float2:
        attribute.format = WGPUVertexFormat_Float32x2;
        break;
    case VertexInputLane::float3:
        attribute.format = WGPUVertexFormat_Float32x3;
        break;
    case VertexInputLane::float4:
        attribute.format = WGPUVertexFormat_Float32x4;
        break;
    case VertexInputLane::uint4:
        attribute.format = WGPUVertexFormat_Uint32x4;
        break;
    }
    inputs.of(input.stream).push_back(attribute);
    return true;
}

std::uint32_t
fill_variant_vertex_layouts(VariantVertexAttributes& inputs,
                            std::array<WGPUVertexBufferLayout, vertex_streams.size()>& layouts) {
    std::uint32_t used = 1;
    for (std::size_t index = 0; index < vertex_streams.size(); ++index) {
        const VertexInputStream stream = vertex_streams[index];
        const std::vector<WGPUVertexAttribute>& attributes = inputs.of(stream);
        layouts[index].stepMode = vertex_stream_is_instanced(stream) ? WGPUVertexStepMode_Instance
                                                                     : WGPUVertexStepMode_Vertex;
        layouts[index].arrayStride = vertex_stream_stride(stream);
        layouts[index].attributeCount = attributes.size();
        layouts[index].attributes = attributes.data();
        if (!attributes.empty()) {
            used = std::max(used, vertex_stream_slot(stream) + 1u);
        }
    }
    return used;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
void apply_pass_depth_state(WGPUDepthStencilState& depth_stencil, bool shadow_pass,
                            std::optional<DawnTaskTarget> target) {
    depth_stencil.format = target ? target->depth
                                  : (shadow_pass ? WGPUTextureFormat_Depth32Float
                                                 : WGPUTextureFormat_Depth24PlusStencil8);
    depth_stencil.depthCompare = dawn_depth_compare(pal::pass_depth_compare(shadow_pass));
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) &&                                                \
    (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_GEOMETRY_VARIANTS > 0)
void apply_geometry_color_targets(WGPUFragmentState& fragment, WGPUDepthStencilState& depth_stencil,
                                  std::vector<WGPUColorTargetState>& targets,
                                  const DawnState& state, const FrameTaskRecord& task,
                                  std::size_t entry_color_target_count, const char* family,
                                  const WGPUBlendState* blend) {
    const std::vector<WGPUTextureFormat> formats = geometry_color_target_formats<WGPUTextureFormat>(
        task, entry_color_target_count, family,
        [](TextureFormatClass format_class) { return texture_format(format_class); },
        state.frame_color_format);
    targets.reserve(formats.size());
    for (const WGPUTextureFormat format : formats) {
        WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
        target.format = format;
        target.blend = blend;
        targets.push_back(target);
    }
    fragment.targetCount = targets.size();
    fragment.targets = targets.data();
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PBR_VARIANTS > 0
WGPURenderPipeline
pinned_variant_pipeline(DawnState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                        std::uint32_t samples, bool has_depth,
                        // The geometry-output task an MRT variant draws in. A geometry variant
                        // is composed for exactly one task, so the variant-keyed cache stays
                        // valid with the task's targets baked into its pipeline.
                        const FrameTaskRecord* geometry_task,
                        // The pin's one exception to this port's depth convention: a shadow
                        // caster pass renders standard-Z into the generator's own
                        // `depth32float` map. The Standard sibling takes the same flag -- a
                        // caster is drawn through whichever family its own material belongs
                        // to, so a depth state either family answered alone would be right
                        // only for the casters that family happens to own.
                        bool shadow_pass,
                        // Which ESM generator's map this pass writes, when it writes one. The
                        // colour format is that generator's own recorded row, so two generators
                        // whose factories returned different formats build different pipelines.
                        std::uint32_t esm_shadow_index, std::optional<DawnTaskTarget> target) {
    const auto variant_key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(variant, upstream::pbr_variants.size(), esm_shadow_index), kind,
        {shadow_pass, has_depth});
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format = target ? target->depth
                                     : (shadow_pass ? WGPUTextureFormat_Depth32Float
                                                    : WGPUTextureFormat_Depth24PlusStencil8);
    const auto key = std::make_tuple(variant_key, color_format,
                                     has_depth ? depth_format : WGPUTextureFormat_Undefined);
    auto& map = state.pinned_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end())
        return existing->second;
    // The same traits the transcribed pipeline reads, from the same kind. The
    // winding matters: a mesh whose node matrix mirrors draws through
    // `pbr_*_none_clockwise`, and hardcoding counter-clockwise here inverted
    // Scene 168's double-sided faces and Scene 266's negative-scale spheres.
    // Decoded after the cache lookup, as every sibling builder does: a hit is
    // every draw past the first, and it needs none of this.
    const PipelineKindTraits traits = pipeline_traits(kind);
    if (state.pinned_vertex_modules.size() < upstream::pbr_variants.size()) {
        state.pinned_vertex_modules.resize(upstream::pbr_variants.size(), nullptr);
        state.pinned_fragment_modules.resize(upstream::pbr_variants.size(), nullptr);
    }
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    if (!state.pinned_vertex_modules[variant]) {
        // The deployed module name: generation prefixes the variant stages so
        // they cannot collide with the scene's own modules.
        const auto stem = [](std::string_view file) {
            return "variant-" + std::string(file.substr(0, file.find(".wgsl")));
        };
        state.pinned_vertex_modules[variant] =
            load_wgsl_module(state, stem(entry.vertex_shader).c_str());
        state.pinned_fragment_modules[variant] =
            load_wgsl_module(state, stem(entry.fragment_shader).c_str());
    }
    // The variant's own inputs, at the locations it declares them. The names
    // are the pin's; where each sits in our vertex is the PAL's, so a variant
    // asking for something we do not carry fails by name here.
    VariantVertexAttributes inputs;
    inputs.vertex.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::PbrVariantAttribute& input =
            upstream::pbr_variant_attributes[entry.first_attribute + index];
        if (!append_variant_attribute(input.name, input.location, inputs)) {
            dawn_error((std::string("pinned variant declares an unmapped vertex ") + "input '" +
                        std::string(input.name) + "'.")
                           .c_str());
        }
    }
    std::array<WGPUVertexBufferLayout, vertex_streams.size()> vertex_layouts{};
    const std::uint32_t vertex_buffer_count = fill_variant_vertex_layouts(inputs, vertex_layouts);

    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pinned_pipeline_layout_for(state, variant);
    descriptor.vertex.module = state.pinned_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("main");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = traits.topology;
    descriptor.primitive.stripIndexFormat = traits.strip_index_format;
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    apply_pass_depth_state(depth_stencil, shadow_pass, target);
    // A no-color view draws in the depth-only tasks, which write depth
    // whatever the material's own alpha would have said.
    depth_stencil.depthWriteEnabled = !entry.no_color_output && traits.transparent
                                          ? WGPUOptionalBool_False
                                          : WGPUOptionalBool_True;
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = color_format;
#if BBLITE_SHADOWS_ESM
    // An ESM caster variant draws into ONE generator's map -- the task that
    // owns this pass names it -- so the format is that generator's own row
    // rather than an assumption that every ESM map agrees.
    if (esm_shadow_index != invalid_handle && entry.esm_shadow_output) {
        color_target.format =
            esm_texture_format(upstream::esm_shadow_resources[esm_shadow_index].textures[0].format);
    }
#endif
    WGPUBlendState blend{};
    if (traits.transparent) {
        blend = blend_state_from(transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.pinned_fragment_modules[variant];
    fragment.entryPoint = string_view("main");
    // A depth-only view's fragment writes no colour target, and the pass it
    // draws in carries none either.
    fragment.targetCount = entry.no_color_output ? 0 : 1;
    fragment.targets = entry.no_color_output ? nullptr : &color_target;
    // A geometry-output MRT variant draws into its task's own attachments,
    // through the builder all three families share.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        apply_geometry_color_targets(fragment, depth_stencil, geometry_targets, state,
                                     *geometry_task, entry.color_target_count, "pinned",
                                     traits.transparent ? &blend : nullptr);
    }
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline)
        dawn_error("pinned variant pipeline creation failed.");
    const auto result = map.emplace(key, pipeline.get());
    if (result.second)
        (void)pipeline.release();
    return result.first->second;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_STANDARD_VARIANTS > 0
WGPURenderPipeline
standard_variant_pipeline(DawnState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                          std::uint32_t samples, bool has_depth, bool unfilterable_emissive,
                          const FrameTaskRecord* geometry_task,
                          // The pin's one exception to this port's depth convention: a shadow
                          // caster pass renders standard-Z into the generator's own
                          // `depth32float` map.
                          bool shadow_pass,
                          // Which ESM generator's map this pass writes, when it writes one. The
                          // colour format is that generator's own recorded row, so two generators
                          // whose factories returned different formats build different pipelines.
                          std::uint32_t esm_shadow_index, std::optional<DawnTaskTarget> target) {
    const auto variant_key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(variant, upstream::standard_variants.size(), esm_shadow_index), kind,
        {shadow_pass, has_depth, unfilterable_emissive});
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format = target ? target->depth
                                     : (shadow_pass ? WGPUTextureFormat_Depth32Float
                                                    : WGPUTextureFormat_Depth24PlusStencil8);
    const auto key = std::make_tuple(variant_key, color_format,
                                     has_depth ? depth_format : WGPUTextureFormat_Undefined);
    auto& map = state.standard_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end())
        return existing->second;
    // After the lookup, as every sibling builder does: a cache hit is every
    // draw past the first and needs none of the decode.
    const PipelineKindTraits traits = pipeline_traits(kind);
    if (state.standard_vertex_modules.size() < upstream::standard_variants.size()) {
        state.standard_vertex_modules.resize(upstream::standard_variants.size(), nullptr);
        state.standard_fragment_modules.resize(upstream::standard_variants.size(), nullptr);
    }
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    if (!state.standard_vertex_modules[variant]) {
        const auto stem = [](std::string_view file) {
            return "variant-std-" + std::string(file.substr(0, file.find(".wgsl")));
        };
        state.standard_vertex_modules[variant] =
            load_wgsl_module(state, stem(entry.vertex_shader).c_str());
        state.standard_fragment_modules[variant] =
            load_wgsl_module(state, stem(entry.fragment_shader).c_str());
    }
    VariantVertexAttributes inputs;
    inputs.vertex.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::StandardVariantAttribute& input =
            upstream::standard_variant_attributes[entry.first_attribute + index];
        if (!append_variant_attribute(input.name, input.location, inputs)) {
            dawn_error((std::string("standard variant declares an unmapped vertex ") + "input '" +
                        std::string(input.name) + "'.")
                           .c_str());
        }
    }
    std::array<WGPUVertexBufferLayout, vertex_streams.size()> vertex_layouts{};
    const std::uint32_t vertex_buffer_count = fill_variant_vertex_layouts(inputs, vertex_layouts);
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = standard_pipeline_layout_for(state, variant, unfilterable_emissive);
    descriptor.vertex.module = state.standard_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("main");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    // The winding is the kind's under the mirrored-mesh opt-in: the pin
    // installs a Standard primitive resolver precisely because this family
    // has none of its own, and a mirrored mesh drawn counter-clockwise
    // renders inside-out.
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    apply_pass_depth_state(depth_stencil, shadow_pass, target);
    depth_stencil.depthWriteEnabled = !entry.no_color_output && traits.transparent
                                          ? WGPUOptionalBool_False
                                          : WGPUOptionalBool_True;
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = color_format;
#if BBLITE_SHADOWS_ESM
    // An ESM caster variant draws into ONE generator's map -- the task that
    // owns this pass names it -- so the format is that generator's own row
    // rather than an assumption that every ESM map agrees.
    if ((entry.features & upstream::standard_esm_shadow_output_flag) &&
        esm_shadow_index != invalid_handle) {
        color_target.format =
            esm_texture_format(upstream::esm_shadow_resources[esm_shadow_index].textures[0].format);
    }
#endif
    WGPUBlendState blend{};
    if (traits.transparent) {
        blend = blend_state_from(transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.standard_fragment_modules[variant];
    fragment.entryPoint = string_view("main");
    fragment.targetCount = entry.no_color_output ? 0 : 1;
    fragment.targets = entry.no_color_output ? nullptr : &color_target;
    // The Standard sibling of the pinned MRT assembly above, through the
    // same shared builder.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        apply_geometry_color_targets(fragment, depth_stencil, geometry_targets, state,
                                     *geometry_task, entry.color_target_count, "standard",
                                     traits.transparent ? &blend : nullptr);
    }
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline)
        dawn_error("standard variant pipeline creation failed.");
    const auto result = map.emplace(key, pipeline.get());
    if (result.second)
        (void)pipeline.release();
    return result.first->second;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_NODE_VARIANTS > 0
std::vector<WGPUBindGroupLayoutEntry>
node_draw_layout_entries(std::size_t slot, [[maybe_unused]] bool caster,
                         [[maybe_unused]] std::size_t geometry_variant) {
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    [[maybe_unused]] const bool geometry_view = geometry_variant != pal::no_node_geometry_variant;
    std::vector<WGPUBindGroupLayoutEntry> entries;
    entries.push_back(uniform_layout_entry(0, WGPUShaderStage_Vertex | WGPUShaderStage_Fragment));
    if (upstream::has_node_ubo(view)) {
        entries.push_back(uniform_layout_entry(static_cast<std::uint32_t>(view.ubo_binding),
                                               WGPUShaderStage_Vertex | WGPUShaderStage_Fragment));
    }
    // The graph's own `TextureBlock`/`ImageSourceBlock` pairs, at the
    // bindings the pin's pipeline builder allocated and with the visibility
    // its own BGL entry carries -- a UV chain can put the sample in either
    // stage, so the pin declares both and so does this.
    for (std::size_t index = 0; index < view.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures[view.first_texture + index];
        WGPUBindGroupLayoutEntry texture = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture.binding = binding.texture;
        texture.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        texture.texture.sampleType = WGPUTextureSampleType_Float;
        texture.texture.viewDimension = WGPUTextureViewDimension_2D;
        entries.push_back(texture);
        WGPUBindGroupLayoutEntry sampler = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        sampler.binding = binding.sampler;
        sampler.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        sampler.sampler.type = WGPUSamplerBindingType_Filtering;
        entries.push_back(sampler);
    }
    // Everything past the graph's own bindings is per view, and the row
    // this slot names is that view's: `ensureGeometryResources` refuses a
    // graph whose geometry emit reaches morph targets, the environment or a
    // shadow light, so a geometry view's row declares all three absent and
    // the three arms below fall out on their own.
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (geometry_view) {
        // The task's gpUniforms, at the binding `_buildGeomUbo` took --
        // present only for a view whose emit raised `_needsGpUbo`.
        const upstream::NodeGeometryVariantEntry& geometry =
            upstream::node_geometry_variants[geometry_variant];
        if (geometry.geometry_params_binding != upstream::node_no_ubo) {
            WGPUBindGroupLayoutEntry params =
                uniform_layout_entry(static_cast<std::uint32_t>(geometry.geometry_params_binding),
                                     WGPUShaderStage_Fragment);
            params.buffer.minBindingSize = sizeof(PinnedGeometryParams);
            entries.push_back(params);
        }
    }
#endif
    if (view.morph.present) {
        entries.push_back(storage_layout_entry(view.morph.deltas_binding, WGPUShaderStage_Vertex));
        entries.push_back(storage_layout_entry(view.morph.weights_binding, WGPUShaderStage_Vertex));
    }
    if (view.env.present) {
        // The pin's own four, in the order `emitEnv` allocates them: the
        // specular cube and its sampler, then the BRDF LUT and its own.
        const auto texture = [&](std::uint32_t binding, WGPUTextureViewDimension dimension) {
            WGPUBindGroupLayoutEntry item = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            item.binding = binding;
            item.visibility = WGPUShaderStage_Fragment;
            item.texture.sampleType = WGPUTextureSampleType_Float;
            item.texture.viewDimension = dimension;
            entries.push_back(item);
        };
        const auto sampler = [&](std::uint32_t binding) {
            WGPUBindGroupLayoutEntry item = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            item.binding = binding;
            item.visibility = WGPUShaderStage_Fragment;
            item.sampler.type = WGPUSamplerBindingType_Filtering;
            entries.push_back(item);
        };
        texture(view.env.ibl_texture, WGPUTextureViewDimension_Cube);
        sampler(view.env.ibl_sampler);
        texture(view.env.brdf_lut, WGPUTextureViewDimension_2D);
        sampler(view.env.brdf_sampler);
    }
#if BBLITE_NODE_SHADOWS
    if (caster) {
#if BBLITE_SHADOWS_ESM
        if (view.caster.esm) {
            // The ESM caster adds one row; the PCF no-colour compile adds
            // none and keeps only the graph's shared bindings above.
            WGPUBindGroupLayoutEntry params =
                uniform_layout_entry(view.caster.params_binding, WGPUShaderStage_Fragment);
            params.buffer.minBindingSize = upstream::shadow_params_block_bytes;
            entries.push_back(params);
        }
#endif
    } else {
        // The receiver's rows, continuing the graph's own binding run
        // rather than opening a group of their own -- but each is the same
        // reflected row the composed families' are, so the same builder
        // answers what type it carries and which stages read it.
        for (const upstream::PinnedShadowBinding& row : pal::node_shadow_rows(view)) {
            entries.push_back(shadow_layout_entry(row));
        }
    }
#endif
    return entries;
}

WGPUBindGroupLayout node_draw_layout_for(DawnState& state, std::size_t variant, bool caster,
                                         std::size_t geometry_variant) {
    const std::size_t slot = pal::node_draw_slot(variant, caster, geometry_variant);
    return state.layouts.group(
        state.device, {DawnLayoutFamily::node, slot},
        [&] { return node_draw_layout_entries(slot, caster, geometry_variant); }, "node-mesh");
}

WGPUPipelineLayout node_pipeline_layout_for(DawnState& state, std::size_t variant, bool caster,
                                            std::size_t geometry_variant) {
    const std::size_t slot = pal::node_draw_slot(variant, caster, geometry_variant);
    return state.layouts.pipeline(state.device, {DawnLayoutFamily::node, slot}, [&] {
        return std::vector{pinned_frame_layout_for(state),
                           node_draw_layout_for(state, variant, caster, geometry_variant)};
    });
}

WGPURenderPipeline
node_variant_pipeline(DawnState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                      std::uint32_t samples, bool has_depth,
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
                      // the slot-keyed cache stays valid with that task's targets baked in.
                      [[maybe_unused]] const FrameTaskRecord* geometry_task,
                      std::size_t geometry_variant, std::optional<DawnTaskTarget> target) {
    const bool geometry_view = geometry_variant != pal::no_node_geometry_variant;
    const std::size_t slot = pal::node_draw_slot(variant, caster, geometry_variant);
    const auto variant_key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(slot, pal::node_variant_slots(), esm_shadow_index), kind,
        {shadow_pass, has_depth});
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format = target ? target->depth
                                     : (shadow_pass ? WGPUTextureFormat_Depth32Float
                                                    : WGPUTextureFormat_Depth24PlusStencil8);
    const auto key = std::make_tuple(variant_key, color_format,
                                     has_depth ? depth_format : WGPUTextureFormat_Undefined);
    auto& map = state.node_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end())
        return existing->second;
    if (state.node_vertex_modules.size() < pal::node_variant_slots()) {
        state.node_vertex_modules.resize(pal::node_variant_slots(), nullptr);
        state.node_fragment_modules.resize(pal::node_variant_slots(), nullptr);
    }
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    if (!state.node_vertex_modules[slot]) {
        const upstream::NodeVariantStems stems = pal::node_variant_stems(slot);
        // Both entry points live in one composed module, deployed once
        // under the fragment stem -- the vertex stem is an `alsoStages`
        // declaration carrying only compiled artifacts -- so the vertex
        // handle loads the fragment stem's file too. Two handles stay:
        // the teardown's `release_variant_family` releases one per table.
        const std::string module_file(stems.fragment);
        state.node_vertex_modules[slot] = load_wgsl_module(state, module_file);
        state.node_fragment_modules[slot] = load_wgsl_module(state, module_file);
    }
    VariantVertexAttributes inputs;
    // A node graph declaring the thin-instance columns would need a second
    // stream this pipeline does not bind, so the shared table's own marking
    // is what refuses it.
    inputs.vertex.reserve(view.attribute_count);
    for (std::size_t index = 0; index < view.attribute_count; ++index) {
        const upstream::NodeVariantAttribute& input =
            upstream::node_variant_attributes[view.first_attribute + index];
        if (!append_variant_attribute(input.name, input.location, inputs)) {
            dawn_error((std::string("node variant declares an unmapped vertex ") + "input '" +
                        std::string(input.name) + "'.")
                           .c_str());
        }
        if (!inputs.instance_matrix.empty() || !inputs.instance_color.empty()) {
            dawn_error((std::string("node variant declares the per-instance ") + "vertex input '" +
                        std::string(input.name) + "', which its pipeline binds no stream for.")
                           .c_str());
        }
    }
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.attributeCount = inputs.vertex.size();
    vertex_layout.attributes = inputs.vertex.data();
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = node_pipeline_layout_for(state, variant, caster, geometry_variant);
    descriptor.vertex.module = state.node_vertex_modules[slot];
    descriptor.vertex.entryPoint = string_view("vs_main");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    // A geometry view is compiled at the pin's alpha mode 0 whatever the
    // graph's own blending says (`ensureGeometryCompile` passes it), so its
    // pipeline neither blends nor drops depth writes.
    const bool transparent = traits.transparent && !shadow_pass && !caster && !geometry_view;
    // The graph's culling and alpha-combine state, decoded through the same
    // shared kind table as the other families. Shadow views force the pin's
    // alpha mode 0 and therefore keep depth writes and no colour blending,
    // and so does the geometry view -- but its culling is still the graph's
    // own `backFaceCulling`, which is the fact the plan's node kinds are
    // bucketed by, so all three views read the one table.
    descriptor.primitive.cullMode = dawn_cull_mode(traits.cull);
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    apply_pass_depth_state(depth_stencil, shadow_pass, target);
    depth_stencil.depthWriteEnabled = transparent ? WGPUOptionalBool_False : WGPUOptionalBool_True;
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = color_format;
#if BBLITE_SHADOWS_ESM
    // The caster writes ONE generator's map, so the format is that
    // generator's own recorded row rather than the frame's.
    if (caster && esm_shadow_index != invalid_handle) {
        color_target.format =
            esm_texture_format(upstream::esm_shadow_resources[esm_shadow_index].textures[0].format);
    }
#endif
    WGPUBlendState blend{};
    if (transparent) {
        blend = blend_state_from(transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.node_fragment_modules[slot];
    fragment.entryPoint = string_view("fs_main");
    const bool pcf_caster = caster && !view.caster.esm;
    fragment.targetCount = pcf_caster ? 0 : 1;
    fragment.targets = pcf_caster ? nullptr : &color_target;
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The task's own attachments, through the builder the two material
    // families' MRT arms take. No blend and no trailing output: a geometry
    // view is compiled at the pin's alpha mode 0 and
    // `createNodeGeometryMaterialView` refuses `emitColor`.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_view) {
        apply_geometry_color_targets(
            fragment, depth_stencil, geometry_targets, state, *geometry_task,
            upstream::node_geometry_variants[geometry_variant].color_target_count, "node", nullptr);
    }
#endif
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline)
        dawn_error("node variant pipeline creation failed.");
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        NodeGpuPipelineCapture receipt;
        receipt.id = state.node_capture.allocate(pipeline, "node-pipeline");
        receipt.variant = static_cast<std::uint32_t>(variant);
        receipt.geometry_variant = geometry_view ? static_cast<int>(geometry_variant) : -1;
        receipt.color_target_count = static_cast<std::uint32_t>(fragment.targetCount);
        receipt.samples = descriptor.multisample.count;
        receipt.topology = descriptor.primitive.topology == WGPUPrimitiveTopology_TriangleList
                               ? "triangle-list"
                               : "unknown";
        receipt.cull_mode = descriptor.primitive.cullMode == WGPUCullMode_None   ? "none"
                            : descriptor.primitive.cullMode == WGPUCullMode_Back ? "back"
                                                                                 : "front";
        receipt.front_face = descriptor.primitive.frontFace == WGPUFrontFace_CCW ? "ccw" : "cw";
        for (std::size_t i = 0; i < vertex_layout.attributeCount; ++i) {
            const auto& attribute = vertex_layout.attributes[i];
            const char* format = attribute.format == WGPUVertexFormat_Float32x2   ? "float32x2"
                                 : attribute.format == WGPUVertexFormat_Float32x3 ? "float32x3"
                                 : attribute.format == WGPUVertexFormat_Float32x4 ? "float32x4"
                                                                                  : "unknown";
            receipt.attributes.push_back(
                {std::string(upstream::node_variant_attributes[view.first_attribute + i].name),
                 format, attribute.shaderLocation, 0, static_cast<std::size_t>(attribute.offset),
                 static_cast<std::size_t>(vertex_layout.arrayStride)});
        }
        state.node_capture.capture.pipeline(std::move(receipt));
    }
#endif
    return map.emplace(key, pipeline).first->second;
}

void fill_node_draw_buffers(DawnState& state, DawnDrawState& draw_state,
                            const upstream::NodeVariantEntry& view) {
    const auto uniform_buffer = [&](std::uint64_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = size;
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer)
            dawn_error("node uniform buffer creation failed.");
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        state.node_capture.allocate(buffer, "node-uniform",
                                    static_cast<std::size_t>(descriptor.size));
#endif
        return buffer.release();
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms = uniform_buffer(sizeof(upstream::NodeMeshUniforms));
    }
    if (!draw_state.material_uniforms && upstream::has_node_ubo(view)) {
        draw_state.material_uniforms = uniform_buffer(static_cast<std::uint64_t>(view.ubo_bytes));
        // The constants the graph declared, written with the buffer that
        // holds them: nothing a reached scene does changes them.
        wgpuQueueWriteBuffer(state.queue, draw_state.material_uniforms, 0,
                             &upstream::node_variant_uniform_floats[view.first_uniform_float],
                             view.ubo_bytes);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        state.node_capture.write(draw_state.material_uniforms,
                                 &upstream::node_variant_uniform_floats[view.first_uniform_float],
                                 view.ubo_bytes);
#endif
    }
}

DawnDrawState& ensure_node_draw_buffers(DawnState& state, DawnMesh& mesh, std::uint32_t material,
                                        const upstream::NodeVariantEntry& entry) {
    DawnDrawState& draw_state = mesh.node_states.try_emplace(material, state).first->second;
    fill_node_draw_buffers(state, draw_state, entry);
    return draw_state;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_NODE_VARIANTS > 0 &&                    \
    BBLITE_NODE_GEOMETRY_VARIANTS > 0
DawnDrawState& ensure_node_geometry_draw_buffers(DawnState& state, DawnMesh& mesh,
                                                 std::size_t geometry_variant) {
    DawnDrawState& draw_state =
        mesh.node_geometry_states.try_emplace(geometry_variant, state).first->second;
    fill_node_draw_buffers(
        state, draw_state,
        upstream::node_variants[upstream::node_geometry_entry(geometry_variant)]);
    return draw_state;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_NODE_VARIANTS > 0
WGPUBindGroup
build_node_draw_group(DawnState& state, [[maybe_unused]] const Scene& scene,
                      [[maybe_unused]] const Engine& engine, DawnMesh& mesh,
                      const DawnDrawState& draw_state, std::size_t variant,
                      // Which of the graph's two compiled views, and the material that says
                      // so -- an ESM caster view carries both the bit and its generator.
                      bool caster, [[maybe_unused]] const MaterialRecord* material,
                      // The composed geometry view this draw is, when it is one; the task's
                      // gpUniforms comes with it because only the encode knows which task.
                      std::size_t geometry_variant, [[maybe_unused]] WGPUBuffer geometry_params) {
    [[maybe_unused]] const bool geometry_view = geometry_variant != pal::no_node_geometry_variant;
    const std::size_t slot = pal::node_draw_slot(variant, caster, geometry_variant);
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    std::vector<WGPUBindGroupEntry> entries;
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = draw_state.mesh_uniforms;
    mesh_entry.size = sizeof(upstream::NodeMeshUniforms);
    entries.push_back(mesh_entry);
    if (upstream::has_node_ubo(view)) {
        WGPUBindGroupEntry node_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        node_entry.binding = static_cast<std::uint32_t>(view.ubo_binding);
        node_entry.buffer = draw_state.material_uniforms;
        node_entry.size = static_cast<std::uint64_t>(view.ubo_bytes);
        entries.push_back(node_entry);
    }
    // The images the scene supplied, uploaded with the mesh: the variant
    // table's order is the pin's allocation order, and the material's slots
    // were filled in that same order by `create_node_material`.
    const auto& shader_textures = mesh_shader_textures(mesh);
    for (std::size_t index = 0; index < view.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures[view.first_texture + index];
        if (index >= shader_textures.size()) {
            dawn_error("a node graph declares more textures than its material "
                       "carries.");
        }
        const DawnSampledTexture& supplied = shader_textures[index];
        WGPUBindGroupEntry texture = WGPU_BIND_GROUP_ENTRY_INIT;
        texture.binding = binding.texture;
        texture.textureView = supplied.view;
        entries.push_back(texture);
        WGPUBindGroupEntry sampler = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler.binding = binding.sampler;
        sampler.sampler = supplied.sampler;
        entries.push_back(sampler);
    }
    if (view.morph.present) {
#if BBLITE_GPU_MORPH_STORAGE
        WGPUBindGroupEntry deltas = WGPU_BIND_GROUP_ENTRY_INIT;
        deltas.binding = view.morph.deltas_binding;
        deltas.buffer = mesh.morph_deltas;
        deltas.size = WGPU_WHOLE_SIZE;
        entries.push_back(deltas);
        WGPUBindGroupEntry weights = WGPU_BIND_GROUP_ENTRY_INIT;
        weights.binding = view.morph.weights_binding;
        weights.buffer = mesh.morph_weights;
        weights.size = WGPU_WHOLE_SIZE;
        entries.push_back(weights);
#else
        dawn_error("a node graph declares morph storage in a build without "
                   "mesh morph buffers.");
#endif
    }
    if (view.env.present) {
        // `pushEnvBindGroupEntries` binds the scene's own EnvironmentTextures,
        // which is what the material families already sample here.
        if (!state.environment_cube_view || !state.brdf_view) {
            dawn_error("a node graph reaches the environment in a scene that "
                       "loaded none.");
        }
        // Which of our resources each role names is the slot table's
        // answer, the same one `pinned_resource_for` gives the other
        // families -- the graph's names join it by source.
        const auto pair = [&](std::uint32_t texture_binding, std::uint32_t sampler_binding,
                              upstream::MaterialTextureSource source) {
            const PinnedResource resource = state_resource_for(state, source);
            WGPUBindGroupEntry texture = WGPU_BIND_GROUP_ENTRY_INIT;
            texture.binding = texture_binding;
            texture.textureView = resource.view;
            entries.push_back(texture);
            WGPUBindGroupEntry item = WGPU_BIND_GROUP_ENTRY_INIT;
            item.binding = sampler_binding;
            item.sampler = resource.sampler;
            entries.push_back(item);
        };
        pair(view.env.ibl_texture, view.env.ibl_sampler,
             upstream::MaterialTextureSource::environment_cube);
        pair(view.env.brdf_lut, view.env.brdf_sampler, upstream::MaterialTextureSource::brdf_lut);
    }
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The task's gpUniforms, the one binding no colour view declares. The
    // arms above fall out on their own: a geometry view's row states its
    // morph, environment, caster and receiver arms absent, because the pin
    // refuses a geometry emit reaching any of them.
    if (geometry_view) {
        const upstream::NodeGeometryVariantEntry& geometry =
            upstream::node_geometry_variants[geometry_variant];
        if (geometry.geometry_params_binding != upstream::node_no_ubo) {
            if (!geometry_params) {
                dawn_error("a node geometry view declares NmeGeomParams but its "
                           "task built no gpUniforms buffer.");
            }
            WGPUBindGroupEntry params = WGPU_BIND_GROUP_ENTRY_INIT;
            params.binding = static_cast<std::uint32_t>(geometry.geometry_params_binding);
            params.buffer = geometry_params;
            params.size = sizeof(PinnedGeometryParams);
            entries.push_back(params);
        }
    }
#endif
#if BBLITE_NODE_SHADOWS
    if (caster) {
#if BBLITE_SHADOWS_ESM
        if (view.caster.esm) {
            // PCF's NODE_NO_COLOR_OUTPUT module adds no caster-only row.
            WGPUBindGroupEntry params = WGPU_BIND_GROUP_ENTRY_INIT;
            params.binding = view.caster.params_binding;
            params.buffer = esm_caster_params_buffer(state, material);
            if (!params.buffer) {
                dawn_error("a node caster draw reached the encode before its "
                           "generator's shadow params.");
            }
            params.size = upstream::shadow_params_block_bytes;
            entries.push_back(params);
        }
#endif
    } else if (view.shadow_binding_count > 0) {
        // The receiver's rows, in the GRAPH's own group 1 -- whether a
        // given mesh receives is the `meshU.receivesShadow` lane, not a
        // selection, so every draw of this graph binds them.
        ensure_shadow_samplers(state);
        const std::vector<ShadowGeneratorHandle> generators =
            shadow_generators_in_light_order(scene, engine);
        for (const upstream::PinnedShadowBinding& row : pal::node_shadow_rows(view)) {
            entries.push_back(shadow_group_entry(state, engine, generators, row));
        }
    }
#endif
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = node_draw_layout_for(state, variant, caster, geometry_variant);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group)
        dawn_error("node variant bind group creation failed.");
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        state.node_capture.allocate(group, "node-bind-group");
        auto& captured = state.node_capture.groups[group];
        captured.clear();
        for (const auto& binding : entries) {
            NodeGpuBindingCapture receipt;
            receipt.binding = binding.binding;
            if (binding.buffer) {
                receipt.role = binding.binding == 0 ? "meshU" : "buffer";
                receipt.resource = state.node_capture.identity(binding.buffer, "bound-buffer");
            } else if (binding.sampler) {
                receipt.role = "sampler";
                receipt.resource = state.node_capture.identity(binding.sampler, "bound-sampler");
            } else if (binding.textureView) {
                receipt.role = "texture";
                receipt.view =
                    state.node_capture.identity(binding.textureView, "bound-texture-view");
                for (const auto& supplied : shader_textures) {
                    if (supplied.view == binding.textureView) {
                        receipt.resource =
                            state.node_capture.identity(supplied.texture, "bound-texture");
                        break;
                    }
                }
            }
            captured.push_back(std::move(receipt));
        }
    }
#endif
    return group.release();
}

void encode_node_variant_draw([[maybe_unused]] DawnState& state,
                              [[maybe_unused]] const upstream::RenderDrawCommand& draw,
                              WGPURenderPassEncoder pass, WGPURenderPipeline pipeline,
                              WGPURenderPipeline& bound_pipeline, WGPUBindGroup frame_group,
                              WGPUBindGroup draw_group, WGPUBuffer vertex_buffer,
                              InstanceStreams instances, WGPUBuffer index_buffer,
                              std::uint32_t index_count) {
    encode_variant_draw(pass, pipeline, bound_pipeline, frame_group, draw_group, vertex_buffer,
                        instances, index_buffer, index_count);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        NodeGpuDrawCapture receipt;
        receipt.pipeline = state.node_capture.identity(pipeline, "node-pipeline");
        receipt.group = state.node_capture.identity(draw_group, "node-bind-group");
        receipt.mesh = draw.item.mesh.value;
        receipt.material = draw.item.material.value;
        receipt.vertices = state.node_capture.identity(vertex_buffer, "node-vertices");
        receipt.indices = state.node_capture.identity(index_buffer, "node-indices");
        receipt.index_count = index_count;
        receipt.instance_count = instances.count;
        receipt.bindings = state.node_capture.groups.at(draw_group);
        for (const auto& binding : receipt.bindings) {
            if (binding.role == "meshU")
                receipt.mesh_uniform = binding.resource;
        }
        state.node_capture.capture.draw(std::move(receipt));
    }
#endif
}

const upstream::NodeMeshUniforms& node_mesh_block_for(NodeMeshBlockCache& cache, const Scene& scene,
                                                      const Engine& engine, MeshHandle mesh) {
    if (cache.scene != &scene) {
        cache.scene = &scene;
        std::fill(cache.composed.begin(), cache.composed.end(), std::uint8_t{0});
    }
    const std::size_t slot = mesh.value;
    if (cache.composed.size() <= slot) {
        cache.blocks.resize(slot + 1u);
        cache.composed.resize(slot + 1u, 0u);
    }
    if (!cache.composed[slot]) {
        cache.blocks[slot] = node_mesh_block(scene, engine, mesh);
        cache.composed[slot] = 1u;
    }
    return cache.blocks[slot];
}

void write_node_mesh_block(DawnState& state, const upstream::NodeMeshUniforms& block,
                           const DawnDrawState& draw_state) {
    wgpuQueueWriteBuffer(state.queue, draw_state.mesh_uniforms, 0, &block, sizeof(block));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    state.node_capture.write(draw_state.mesh_uniforms, &block, sizeof(block));
#endif
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_NODE_VARIANTS > 0 &&                    \
    BBLITE_NODE_GEOMETRY_VARIANTS > 0
void write_node_geometry_task(DawnState& state, NodeMeshBlockCache& mesh_blocks, const Scene& scene,
                              const Engine& engine, const FrameTaskRecord& task,
                              DawnGeometryTask& geometry,
                              const upstream::RenderDrawLists& draw_lists) {
    for (const auto* list : {&draw_lists.opaque, &draw_lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (draw.item.material_kind != upstream::RenderMaterialKind::node) {
                continue;
            }
            if (draw.item_index >= state.meshes.size())
                continue;
            const std::size_t geometry_variant = pal::require_node_geometry_variant(
                draw.item.shader_variant, static_cast<std::size_t>(task.geometry.shader_index));
            DawnMesh& mesh = state.meshes[draw.item_index];
            DawnDrawState& draw_state =
                ensure_node_geometry_draw_buffers(state, mesh, geometry_variant);
            write_node_mesh_block(
                state, node_mesh_block_for(mesh_blocks, scene, engine, draw.item.mesh), draw_state);
            if (!draw_state.group) {
                draw_state.group = build_node_draw_group(
                    state, scene, engine, mesh, draw_state, draw.item.shader_variant, false,
                    nullptr, geometry_variant, geometry.pinned_geometry_params);
            }
        }
    }
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal
