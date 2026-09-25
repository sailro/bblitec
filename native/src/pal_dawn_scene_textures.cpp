// Dawn scene textures: material, compressed, cube and environment uploads
// and the pinned backgrounds. SDL_GPU's twin is
// pal_sdl_gpu_scene_textures.cpp.
#include <bblite/features/compute_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
WGPUTexture create_solid_texture(DawnState& state, const std::vector<std::uint8_t>& texel,
                                 WGPUTextureFormat format, std::uint32_t layers) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {1, 1, layers};
    descriptor.format = format;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture solid");
    for (std::uint32_t layer = 0; layer < layers; ++layer) {
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, layer};
        WGPUTexelCopyBufferLayout layout{};
        layout.offset = 0;
        layout.bytesPerRow = 256;
        layout.rowsPerImage = 1;
        const WGPUExtent3D size{1, 1, 1};
        std::array<std::uint8_t, 256> row{};
        std::memcpy(row.data(), texel.data(), texel.size());
        wgpuQueueWriteTexture(state.queue, &destination, row.data(), row.size(), &layout, &size);
    }
    return texture.release();
}

WGPUTextureFormat compressed_texture_format(std::string_view name) {
    switch (compressed_block_format(name)) {
#define BBLITE_DAWN_COMPRESSED_FORMAT(id, text, sdl, dawn)                                         \
    case CompressedBlockFormat::id:                                                                \
        return WGPUTextureFormat_##dawn;
        BBLITE_COMPRESSED_FORMATS(BBLITE_DAWN_COMPRESSED_FORMAT)
#undef BBLITE_DAWN_COMPRESSED_FORMAT
    }
    throw std::runtime_error("Dawn has no compressed texture format for '" + std::string(name) +
                             "'.");
}

WGPUTexture upload_compressed_texture(DawnState& state, const CompressedTexture& compressed) {
    // The device request is opportunistic (the pinned engine asks for every
    // optional feature the adapter offers), so an adapter without block
    // compression reaches here rather than failing at creation. Refuse by
    // name, as the SDL_GPU sibling does through
    // `SDL_GPUTextureSupportsFormat`.
    if (!wgpuAdapterHasFeature(state.adapter, WGPUFeatureName_TextureCompressionBC)) {
        throw std::runtime_error("This adapter cannot sample '" + std::string(compressed.format) +
                                 "' textures: it reports no block-compression feature.");
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {compressed.width, compressed.height, 1};
    descriptor.format = compressed_texture_format(compressed.format);
    descriptor.mipLevelCount = static_cast<std::uint32_t>(compressed.mips.size());
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture compressed");
    for (std::size_t level = 0; level < compressed.mips.size(); ++level) {
        const CompressedMipLevel& mip = compressed.mips[level];
        const CompressedMipCopy geometry = compressed_mip_copy(compressed, mip);
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.mipLevel = static_cast<std::uint32_t>(level);
        WGPUTexelCopyBufferLayout layout{};
        layout.offset = 0;
        layout.bytesPerRow = geometry.row_bytes;
        layout.rowsPerImage = geometry.block_rows;
        const WGPUExtent3D size{geometry.width, geometry.height, 1};
        wgpuQueueWriteTexture(state.queue, &destination, mip.bytes.data(), mip.bytes.size(),
                              &layout, &size);
    }
    return texture.release();
}

WGPUTexture upload_material_texture(DawnState& state, const TextureData& texture_data, bool srgb,
                                    const std::array<std::uint8_t, 4>& fallback,
                                    std::uint32_t& out_mip_count) {
    // A compressed slot carries its own format and its own chain, so the
    // table's sRGB rule has nothing to select: the container states which
    // of the two views its blocks decode through.
    if (!texture_data.compressed.mips.empty()) {
        const auto& compressed =
            select_compressed_texture(texture_data, [&](std::string_view format) {
                return wgpuDeviceHasFeature(state.device,
                                            format.starts_with("astc-")
                                                ? WGPUFeatureName_TextureCompressionASTC
                                                : WGPUFeatureName_TextureCompressionBC);
            });
        out_mip_count = static_cast<std::uint32_t>(compressed.mips.size());
        return upload_compressed_texture(state, compressed);
    }
    const DecodedImage image = decode_uploadable_image(texture_data, fallback);
    const std::uint32_t mip_count = full_mip_chain(static_cast<std::uint32_t>(image.width),
                                                   static_cast<std::uint32_t>(image.height));
    out_mip_count = mip_count;
    const WGPUTextureFormat format =
        srgb ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment |
                       WGPUTextureUsage_CopyDst;
    descriptor.size = {
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height),
        1,
    };
    descriptor.format = format;
    descriptor.mipLevelCount = mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture material");
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = static_cast<std::uint32_t>(image.width) * 4;
    layout.rowsPerImage = static_cast<std::uint32_t>(image.height);
    const WGPUExtent3D size{
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height),
        1,
    };
    wgpuQueueWriteTexture(state.queue, &destination, image.rgba.data(), image.rgba.size(), &layout,
                          &size);
    generate_mipmaps(state, texture, format, mip_count);
    return texture.release();
}

WGPUTexture upload_reflection_cube(DawnState& state,
                                   const std::array<TextureData, 6>& texture_data) {
    std::array<DecodedImage, 6> images;
    int width = 1;
    int height = 1;
    for (std::size_t index = 0; index < images.size(); ++index) {
        if (!texture_data[index].bytes.empty()) {
            images[index] = decode_image(js::ArrayBuffer(texture_data[index].bytes));
        } else {
            images[index].width = 1;
            images[index].height = 1;
            images[index].rgba = {0, 0, 0, 255};
        }
        if (index == 0) {
            width = images[index].width;
            height = images[index].height;
        } else if (images[index].width != width || images[index].height != height) {
            throw std::runtime_error("Cube texture faces must have matching dimensions.");
        }
    }
    const std::uint32_t mip_count =
        full_mip_chain(static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height));
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment |
                       WGPUTextureUsage_CopyDst;
    descriptor.size = {
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height),
        6,
    };
    descriptor.format = WGPUTextureFormat_RGBA8Unorm;
    descriptor.mipLevelCount = mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture reflection cube");
    for (std::uint32_t face = 0; face < 6; ++face) {
        const DecodedImage& image = images[face];
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, face};
        WGPUTexelCopyBufferLayout layout{};
        layout.bytesPerRow = static_cast<std::uint32_t>(width) * 4;
        layout.rowsPerImage = static_cast<std::uint32_t>(height);
        const WGPUExtent3D size{
            static_cast<std::uint32_t>(width),
            static_cast<std::uint32_t>(height),
            1,
        };
        wgpuQueueWriteTexture(state.queue, &destination, image.rgba.data(), image.rgba.size(),
                              &layout, &size);
        generate_mipmaps(state, texture, WGPUTextureFormat_RGBA8Unorm, mip_count,
                         static_cast<std::int32_t>(face));
    }
    return texture.release();
}

WGPUTexture create_environment_texture(DawnState& state, const EnvironmentState& environment,
                                       std::uint32_t layers) {
#if BBLITE_COMPUTE_TEXTURES
    if (environment.specular_gpu) {
        const auto allocation =
            std::dynamic_pointer_cast<DawnComputeTexture>(environment.specular_gpu);
        if (!allocation || !allocation->texture || layers != 6)
            throw std::runtime_error("Dawn environment requires a live six-face GPU cube.");
        wgpuTextureAddRef(allocation->texture);
        return allocation->texture;
    }
#endif
    const bool has_environment = environment_cube_present(environment);
    if (!has_environment)
        return nullptr;
    const std::uint32_t width = environment.specular_width;
    const std::uint32_t mip_count = environment.specular_mip_count;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, width, layers};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    descriptor.mipLevelCount = mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture environment");
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        const std::uint32_t mip_width = std::max(width >> mip, 1u);
        for (std::uint32_t face = 0; face < layers; ++face) {
            const TextureData& face_data =
                environment.specular_faces[static_cast<std::size_t>(mip) * layers + face];
            std::vector<std::uint16_t> half_pixels;
            const std::uint8_t* source_bytes = nullptr;
            std::size_t byte_size = 0;
            if (environment.specular_rgba16f) {
                byte_size = static_cast<std::size_t>(mip_width) * mip_width * 8;
                if (face_data.bytes.size() != byte_size) {
                    throw std::runtime_error("Compiled HDR cubemap face has an invalid size.");
                }
                source_bytes = face_data.bytes.data();
            } else {
                // RGBD faces are Y-flipped on upload, matching the
                // pinned uploadCubemapRGBD (BJS invertY cubemaps). The
                // decode already hands back the upload's own type, so the
                // flip is a row swap in place rather than a second buffer.
                int face_width = 0;
                int face_height = 0;
                half_pixels = decode_rgbd(face_data, face_width, face_height);
                const std::size_t row_channels = static_cast<std::size_t>(face_width) * 4;
                for (int row = 0; row < face_height / 2; ++row) {
                    const auto top =
                        half_pixels.begin() +
                        static_cast<std::ptrdiff_t>(static_cast<std::size_t>(row) * row_channels);
                    const auto bottom =
                        half_pixels.begin() +
                        static_cast<std::ptrdiff_t>(
                            static_cast<std::size_t>(face_height - row - 1) * row_channels);
                    std::swap_ranges(top, top + static_cast<std::ptrdiff_t>(row_channels), bottom);
                }
                source_bytes = reinterpret_cast<const std::uint8_t*>(half_pixels.data());
                byte_size = half_pixels.size() * sizeof(std::uint16_t);
            }
            WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = texture;
            destination.mipLevel = mip;
            destination.origin = {0, 0, face};
            WGPUTexelCopyBufferLayout layout{};
            layout.bytesPerRow = mip_width * 8;
            layout.rowsPerImage = mip_width;
            const WGPUExtent3D size{mip_width, mip_width, 1};
            wgpuQueueWriteTexture(state.queue, &destination, source_bytes, byte_size, &layout,
                                  &size);
        }
    }
    return texture.release();
}

void upload_environment(DawnState& state, const EnvironmentState& environment) {
    const auto texture = create_environment_texture(state, environment);
    if (!texture)
        return;
    if (state.environment_cube_view) {
        wgpuTextureViewRelease(state.environment_cube_view);
    }
    if (state.environment_cube) {
        wgpuTextureRelease(state.environment_cube);
    }
    state.environment_cube = texture;
    WGPUTextureViewDescriptor view_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view_descriptor.dimension = WGPUTextureViewDimension_Cube;
    view_descriptor.arrayLayerCount = 6;
    state.environment_cube_view = create_dawn_texture_view(texture, &view_descriptor);
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_LOCAL_CUBEMAP
DawnState::LocalCubemap* ensure_local_cubemap(DawnState& state, const MaterialRecord* material) {
    if (!material || !material->local_environment)
        return nullptr;
    const auto& source = material->local_environment;
    if (const auto found = state.local_cubemaps.find(source.get());
        found != state.local_cubemaps.end())
        return found->second.get();
    auto gpu = std::make_unique<DawnState::LocalCubemap>();
    gpu->source = source;
    gpu->texture =
        create_environment_texture(state, local_cubemap_texture(*source), source->layers);
    if (!gpu->texture)
        dawn_error("Local cubemap texture upload failed.");
    WGPUTextureViewDescriptor view = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view.dimension = WGPUTextureViewDimension_CubeArray;
    view.arrayLayerCount = source->layers;
    gpu->array_view = create_dawn_texture_view(gpu->texture, &view);
    if (source->overrides_environment) {
        view.dimension = WGPUTextureViewDimension_Cube;
        view.arrayLayerCount = 6;
        gpu->cube_view = create_dawn_texture_view(gpu->texture, &view);
    }
    gpu->uniform = create_buffer(state, WGPUBufferUsage_Uniform, source->uniform_data.data(),
                                 source->uniform_data.size() * sizeof(std::uint32_t));
    gpu->grid = create_buffer(state, WGPUBufferUsage_Storage, source->grid_data.data(),
                              source->grid_data.size() * sizeof(std::uint32_t));
    auto* result = gpu.get();
    state.local_cubemaps.emplace(source.get(), std::move(gpu));
    return result;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
void upload_brdf(DawnState& state, const EnvironmentState& environment) {
    std::vector<std::uint16_t> half_pixels;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    if (environment.brdf_lut_rgba16f) {
        const std::size_t expected_size =
            static_cast<std::size_t>(environment.brdf_lut_width) * environment.brdf_lut_width * 8;
        if (environment.brdf_lut_width == 0 || environment.brdf_lut.bytes.size() != expected_size) {
            throw std::runtime_error("Compiled BRDF LUT has invalid RGBA16F dimensions.");
        }
        width = height = environment.brdf_lut_width;
        half_pixels.resize(expected_size / 2);
        std::memcpy(half_pixels.data(), environment.brdf_lut.bytes.data(), expected_size);
    } else {
        // No empty-bytes guard: the shared decode's own empty arm yields
        // the 1x1 {0,0,0,1} half texel, so a build with no LUT samples
        // the same fallback SDL_GPU uploads. An early return kept this
        // backend's startup zeros instead -- a silent backend delta.
        int lut_width = 0;
        int lut_height = 0;
        half_pixels = decode_rgbd(environment.brdf_lut, lut_width, lut_height);
        width = static_cast<std::uint32_t>(lut_width);
        height = static_cast<std::uint32_t>(lut_height);
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, height, 1};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    WGPUTexture texture = wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture brdf");
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = width * 8;
    layout.rowsPerImage = height;
    const WGPUExtent3D size{width, height, 1};
    wgpuQueueWriteTexture(state.queue, &destination, half_pixels.data(),
                          half_pixels.size() * sizeof(std::uint16_t), &layout, &size);
    if (state.brdf_view)
        wgpuTextureViewRelease(state.brdf_view);
    if (state.brdf_texture)
        wgpuTextureRelease(state.brdf_texture);
    state.brdf_texture = texture;
    state.brdf_view = create_dawn_texture_view(texture, nullptr);
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal

namespace bbl::pal {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_PINNED_BACKGROUNDS
WGPUTexture upload_dawn_dds_skybox(DawnState& state, const EnvironmentState& environment) {
    const TextureData& data = environment.skybox_texture;
    if (environment.skybox_width == 0 || environment.skybox_mip_count == 0 ||
        environment.skybox_data_offset >= data.bytes.size()) {
        throw std::runtime_error("DDS skybox metadata is incomplete.");
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {
        environment.skybox_width,
        environment.skybox_width,
        6,
    };
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    descriptor.mipLevelCount = environment.skybox_mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) {
        dawn_error("wgpuDeviceCreateTexture DDS skybox");
    }
    // The face/mip/offset walk and its truncation guard are the shared half;
    // only the queue write below is this backend's.
    for_each_dds_skybox_level(environment, [&](std::uint32_t face, std::uint32_t mip,
                                               std::uint32_t mip_size, std::size_t offset,
                                               std::size_t byte_size) {
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.mipLevel = mip;
        destination.origin = {0, 0, face};
        WGPUTexelCopyBufferLayout layout{};
        layout.bytesPerRow = mip_size * 8;
        layout.rowsPerImage = mip_size;
        const WGPUExtent3D size{mip_size, mip_size, 1};
        wgpuQueueWriteTexture(state.queue, &destination, data.bytes.data() + offset, byte_size,
                              &layout, &size);
    });
    return texture.release();
}

WGPUTextureView dawn_cube_view(WGPUTexture texture) {
    WGPUTextureViewDescriptor view_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view_descriptor.dimension = WGPUTextureViewDimension_Cube;
    view_descriptor.arrayLayerCount = 6;
    return create_dawn_texture_view(texture, &view_descriptor);
}

WGPUVertexFormat dawn_vertex_format(upstream::PinnedVertexFormat format) {
    switch (format) {
    case upstream::PinnedVertexFormat::float32x2:
        return WGPUVertexFormat_Float32x2;
    case upstream::PinnedVertexFormat::float32x3:
        return WGPUVertexFormat_Float32x3;
    case upstream::PinnedVertexFormat::float32x4:
        return WGPUVertexFormat_Float32x4;
    }
    throw std::runtime_error("Unmapped pinned vertex format.");
}

void initialize_dawn_backgrounds(DawnState& state, const Scene& scene) {
    state.background_draws.for_each([&](upstream::PinnedBackgroundArmKind kind) {
        const upstream::PinnedBackgroundArm& arm = upstream::pinned_background_arm(kind);
        DawnBackgroundArm resources;
        resources.arm = &arm;
        const std::span<const upstream::PinnedVariantBinding> rows(
            upstream::pinned_background_bindings.data() + arm.first_binding, arm.binding_count);
        const DawnLayoutKey key{DawnLayoutFamily::background, static_cast<std::size_t>(kind)};
        WGPUBindGroupLayout group_layout = state.layouts.group(state.device, key, [&] {
            return reflected_group_layout_entries(
                {}, rows, [](const upstream::PinnedVariantBinding&) { return false; });
        });
        WGPUPipelineLayout pipeline_layout = state.layouts.pipeline(state.device, key, [&] {
            return std::vector<WGPUBindGroupLayout>{pinned_frame_layout_for(state), group_layout};
        });
        DawnShaderModule vertex{load_wgsl_module(state, std::string(arm.vertex_stem))};
        DawnShaderModule fragment{load_wgsl_module(state, std::string(arm.fragment_stem))};
        std::vector<WGPUVertexAttribute> attributes;
        std::vector<WGPUVertexBufferLayout> buffers(arm.stream_count);
        std::size_t attribute_total = 0;
        for (std::uint32_t slot = 0; slot < arm.stream_count; ++slot) {
            attribute_total +=
                upstream::pinned_background_streams[arm.first_stream + slot].attribute_count;
        }
        attributes.reserve(attribute_total);
        for (std::uint32_t slot = 0; slot < arm.stream_count; ++slot) {
            const upstream::PinnedVertexStream& stream =
                upstream::pinned_background_streams[arm.first_stream + slot];
            const std::size_t first = attributes.size();
            for (std::uint32_t index = 0; index < stream.attribute_count; ++index) {
                const upstream::PinnedVertexAttribute& row =
                    upstream::pinned_background_attributes[stream.first_attribute + index];
                WGPUVertexAttribute attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
                attribute.format = dawn_vertex_format(row.format);
                attribute.offset = row.offset;
                attribute.shaderLocation = row.location;
                attributes.push_back(attribute);
            }
            buffers[slot].stepMode = WGPUVertexStepMode_Vertex;
            buffers[slot].arrayStride = stream.stride;
            buffers[slot].attributeCount = stream.attribute_count;
            buffers[slot].attributes = attributes.data() + first;
        }
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = pipeline_layout;
        descriptor.vertex.module = vertex;
        descriptor.vertex.bufferCount = buffers.size();
        descriptor.vertex.buffers = buffers.data();
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace =
            arm.clockwise_front_face ? WGPUFrontFace_CW : WGPUFrontFace_CCW;
        descriptor.primitive.cullMode =
            arm.cull == upstream::RenderCullMode::back ? WGPUCullMode_Back : WGPUCullMode_None;
        WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled =
            arm.depth_write ? WGPUOptionalBool_True : WGPUOptionalBool_False;
        depth_stencil.depthCompare = dawn_depth_compare(upstream::pinned_depth_compare);
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = state.sample_count;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.frame_color_format;
        const WGPUBlendState blend = blend_state_from(arm.blend_factors);
        if (arm.blend)
            color_target.blend = &blend;
        WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
        fragment_state.module = fragment;
        fragment_state.targetCount = 1;
        fragment_state.targets = &color_target;
        descriptor.fragment = &fragment_state;
        resources.pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!resources.pipeline) {
            dawn_error(
                ("background pipeline " + std::string(arm.fragment_stem) + " creation failed.")
                    .c_str());
        }
        upstream::PinnedBackgroundBuffers data = upstream::pinned_background_buffers(arm, scene);
        for (std::vector<std::uint8_t>& bytes : data.vertex) {
            resources.vertex_buffers.emplace_back(
                create_padded_buffer(state, WGPUBufferUsage_Vertex, std::move(bytes)));
        }
        resources.index_count = static_cast<std::uint32_t>(
            data.indices.size() /
            (arm.index_uint32 ? sizeof(std::uint32_t) : sizeof(std::uint16_t)));
        resources.indices =
            create_padded_buffer(state, WGPUBufferUsage_Index, std::move(data.indices));
        resources.mesh_uniforms =
            create_padded_buffer(state, WGPUBufferUsage_Uniform, std::move(data.mesh_block));
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        switch (kind) {
        case upstream::PinnedBackgroundArmKind::ground:
        case upstream::PinnedBackgroundArmKind::ground_dither: {
            std::uint32_t ground_mips = 1;
            resources.texture = upload_material_texture(state, scene.environment.ground_texture,
                                                        false, {255, 255, 255, 255}, ground_mips);
            resources.texture_view = create_dawn_texture_view(resources.texture, nullptr);
            view = resources.texture_view;
            sampler = state.ground_sampler;
            break;
        }
        case upstream::PinnedBackgroundArmKind::dds_skybox:
        case upstream::PinnedBackgroundArmKind::dds_skybox_no_dither:
            resources.texture = upload_dawn_dds_skybox(state, scene.environment);
            resources.texture_view = dawn_cube_view(resources.texture);
            view = resources.texture_view;
            sampler = state.clamp_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::hdr_skybox:
            view = state.environment_cube_view;
            sampler = state.clamp_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::image_skybox:
            resources.texture = upload_reflection_cube(state, scene.environment.image_skybox_faces);
            resources.texture_view = dawn_cube_view(resources.texture);
            view = resources.texture_view;
            sampler = state.default_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::solid_skybox:
            break;
        }
        std::vector<WGPUBindGroupEntry> entries;
        entries.reserve(rows.size());
        for (const upstream::PinnedVariantBinding& row : rows) {
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = row.binding;
            switch (row.kind) {
            case upstream::PinnedBindingKind::uniformBuffer:
                entry.buffer = resources.mesh_uniforms;
                entry.size = WGPU_WHOLE_SIZE;
                break;
            case upstream::PinnedBindingKind::sampler:
                entry.sampler = sampler;
                break;
            default:
                entry.textureView = view;
                break;
            }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = group_layout;
        group_descriptor.entryCount = entries.size();
        group_descriptor.entries = entries.data();
        resources.group = wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
        if (!resources.group) {
            dawn_error(("background group " + std::string(arm.fragment_stem) + " creation failed.")
                           .c_str());
        }
        state.background_arms.push_back(std::move(resources));
    });
}

void draw_dawn_background_arm(WGPURenderPassEncoder pass, const DawnBackgroundArm& arm,
                              WGPUBindGroup frame_group) {
    wgpuRenderPassEncoderSetPipeline(pass, arm.pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, frame_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(pass, 1, arm.group, 0, nullptr);
    for (std::size_t slot = 0; slot < arm.vertex_buffers.size(); ++slot) {
        wgpuRenderPassEncoderSetVertexBuffer(pass, static_cast<std::uint32_t>(slot),
                                             arm.vertex_buffers[slot], 0, WGPU_WHOLE_SIZE);
    }
    wgpuRenderPassEncoderSetIndexBuffer(
        pass, arm.indices, arm.arm->index_uint32 ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16,
        0, WGPU_WHOLE_SIZE);
    count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, arm.index_count, 1, 0, 0, 0);
}
#endif

} // namespace bbl::pal
