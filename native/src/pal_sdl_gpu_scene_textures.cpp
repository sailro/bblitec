// SDL_GPU scene textures: material, compressed, cube and environment
// uploads and the pinned backgrounds. Dawn's twin is
// pal_dawn_scene_textures.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_images.hpp"
#include "pal_gpu_textures.hpp"
#include <bblite/features/compute_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER
SDL_GPUTextureFormat compressed_texture_format(std::string_view name) {
    switch (compressed_block_format(name)) {
#define BBLITE_SDL_COMPRESSED_FORMAT(id, text, sdl, dawn)                                          \
    case CompressedBlockFormat::id:                                                                \
        return SDL_GPU_TEXTUREFORMAT_##sdl;
        BBLITE_COMPRESSED_FORMATS(BBLITE_SDL_COMPRESSED_FORMAT)
#undef BBLITE_SDL_COMPRESSED_FORMAT
    }
    throw std::runtime_error("SDL_GPU has no compressed texture format for '" + std::string(name) +
                             "'.");
}

SDL_GPUTexture* upload_compressed_texture(SDL_GPUDevice* device,
                                          const CompressedTexture& compressed) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = compressed_texture_format(compressed.format);
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = compressed.width;
    texture_info.height = compressed.height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = static_cast<Uint32>(compressed.mips.size());
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture texture_owner{SDL_CreateGPUTexture(device, &texture_info), {device}};
    auto* texture = texture_owner.get();
    if (!texture)
        gpu_error("SDL_CreateGPUTexture compressed");

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    std::vector<OwnedSdlTransfer> transfers;
    transfers.reserve(compressed.mips.size());
    const bool metal = SDL_strcmp(SDL_GetGPUDeviceDriver(device), "metal") == 0;
    for (std::size_t level = 0; level < compressed.mips.size(); ++level) {
        const CompressedMipLevel& mip = compressed.mips[level];
        const CompressedMipCopy geometry = compressed_mip_copy(compressed, mip);
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = static_cast<Uint32>(mip.bytes.size());
        OwnedSdlTransfer transfer_owner{SDL_CreateGPUTransferBuffer(device, &transfer_info),
                                        {device}};
        auto* transfer = transfer_owner.get();
        if (!transfer)
            gpu_error("SDL_CreateGPUTransferBuffer");
        transfers.push_back(std::move(transfer_owner));
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer");
        std::memcpy(mapped, mip.bytes.data(), mip.bytes.size());
        SDL_UnmapGPUTransferBuffer(device, transfer);
        // Transfer strides stay block-aligned. Metal's destination extent
        // must fit the logical mip, including tail levels smaller than a block.
        SDL_GPUTextureTransferInfo source{transfer, 0, geometry.width, geometry.height};
        SDL_GPUTextureRegion destination{texture,
                                         static_cast<Uint32>(level),
                                         0,
                                         0,
                                         0,
                                         0,
                                         metal ? mip.width : geometry.width,
                                         metal ? mip.height : geometry.height,
                                         1};
        SDL_UploadToGPUTexture(copy, &source, &destination, false);
    }
    copy.end();
    if (!command.submit()) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
    transfers.clear();
    return texture_owner.release();
}

SDL_GPUTexture* upload_texture(SDL_GPUDevice* device, const TextureData& texture_data, bool srgb,
                               std::array<std::uint8_t, 4> fallback) {
    // A compressed slot carries its own format and its own chain, so the
    // table's sRGB rule has nothing to select: the container states which
    // of the two views its blocks decode through.
    if (!texture_data.compressed.mips.empty()) {
        const auto& compressed =
            select_compressed_texture(texture_data, [&](std::string_view format) {
                return SDL_GPUTextureSupportsFormat(device, compressed_texture_format(format),
                                                    SDL_GPU_TEXTURETYPE_2D,
                                                    SDL_GPU_TEXTUREUSAGE_SAMPLER);
            });
        return upload_compressed_texture(device, compressed);
    }
    const DecodedImage image = decode_uploadable_image(texture_data, fallback);
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format =
        srgb ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = image.width;
    texture_info.height = image.height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = full_mip_chain(static_cast<std::uint32_t>(image.width),
                                             static_cast<std::uint32_t>(image.height));
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture texture_owner{SDL_CreateGPUTexture(device, &texture_info), {device}};
    auto* texture = texture_owner.get();
    if (!texture)
        gpu_error("SDL_CreateGPUTexture");

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(image.rgba.size());
    OwnedSdlTransfer transfer_owner{SDL_CreateGPUTransferBuffer(device, &transfer_info), {device}};
    auto* transfer = transfer_owner.get();
    if (!transfer)
        gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, image.rgba.data(), image.rgba.size());
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    SDL_GPUTextureTransferInfo source{transfer, 0, static_cast<Uint32>(image.width),
                                      static_cast<Uint32>(image.height)};
    SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0, static_cast<Uint32>(image.width), static_cast<Uint32>(image.height),
        1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    copy.end();
    generate_texture_mipmaps(device, command, texture, texture_info.width, texture_info.height,
                             texture_info.num_levels);
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer");
    transfer_owner.reset();
    return texture_owner.release();
}

SDL_GPUTexture* upload_cube_texture(SDL_GPUDevice* device,
                                    const std::array<TextureData, 6>* texture_data) {
    std::array<DecodedImage, 6> images;
    int width = 1;
    int height = 1;
    for (std::size_t index = 0; index < images.size(); ++index) {
        if (texture_data && !(*texture_data)[index].bytes.empty()) {
            images[index] = decode_image(js::ArrayBuffer((*texture_data)[index].bytes));
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
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = static_cast<Uint32>(width);
    texture_info.height = static_cast<Uint32>(height);
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels =
        full_mip_chain(static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height));
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture texture_owner{SDL_CreateGPUTexture(device, &texture_info), {device}};
    auto* texture = texture_owner.get();
    if (!texture)
        gpu_error("SDL_CreateGPUTexture reflection cube");

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command) {
        gpu_error("SDL_AcquireGPUCommandBuffer reflection cube");
    }
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    std::array<OwnedSdlTransfer, 6> transfers{};
    for (std::size_t index = 0; index < images.size(); ++index) {
        const DecodedImage& image = images[index];
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = static_cast<Uint32>(image.rgba.size());
        transfers[index] =
            OwnedSdlTransfer{SDL_CreateGPUTransferBuffer(device, &transfer_info), {device}};
        if (!transfers[index]) {
            gpu_error("SDL_CreateGPUTransferBuffer reflection cube");
        }
        void* mapped = SDL_MapGPUTransferBuffer(device, transfers[index].get(), false);
        if (!mapped) {
            gpu_error("SDL_MapGPUTransferBuffer reflection cube");
        }
        std::memcpy(mapped, image.rgba.data(), image.rgba.size());
        SDL_UnmapGPUTransferBuffer(device, transfers[index].get());
        const SDL_GPUTextureTransferInfo source{
            transfers[index].get(),
            0,
            static_cast<Uint32>(width),
            static_cast<Uint32>(height),
        };
        const SDL_GPUTextureRegion destination{
            texture, 0, static_cast<Uint32>(index), 0,
            0,       0, static_cast<Uint32>(width), static_cast<Uint32>(height),
            1,
        };
        SDL_UploadToGPUTexture(copy, &source, &destination, false);
    }
    copy.end();
    generate_texture_mipmaps(device, command, texture, texture_info.width, texture_info.height,
                             texture_info.num_levels, texture_info.layer_count_or_depth);
    if (!command.submit()) {
        gpu_error("SDL_SubmitGPUCommandBuffer reflection cube");
    }
    return texture_owner.release();
}

SDL_GPUTexture* upload_rgbd_texture(SDL_GPUDevice* device, const TextureData& texture_data) {
    int width = 0;
    int height = 0;
    const std::vector<std::uint16_t> pixels = decode_rgbd(texture_data, width, height);
    return upload_2d_texture(device, pixels.data(), pixels.size() * sizeof(std::uint16_t),
                             static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height),
                             SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT, "upload RGBD texture");
}

SDL_GPUTexture* upload_brdf_lut(SDL_GPUDevice* device, const EnvironmentState& environment) {
    if (!environment.brdf_lut_rgba16f) {
        return upload_rgbd_texture(device, environment.brdf_lut);
    }
    const std::size_t expected_size =
        static_cast<std::size_t>(environment.brdf_lut_width) * environment.brdf_lut_width * 8;
    if (environment.brdf_lut_width == 0 || environment.brdf_lut.bytes.size() != expected_size) {
        throw std::runtime_error("Compiled BRDF LUT has invalid RGBA16F dimensions.");
    }
    return upload_2d_texture(device, environment.brdf_lut.bytes.data(),
                             environment.brdf_lut.bytes.size(), environment.brdf_lut_width,
                             environment.brdf_lut_width, SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                             "upload BRDF LUT");
}

SDL_GPUTexture* upload_environment(SDL_GPUDevice* device, const EnvironmentState& environment,
                                   std::uint32_t layers, bool cube_array,
                                   std::shared_ptr<ComputeTextureAllocation>* borrowed) {
#if BBLITE_COMPUTE_TEXTURES
    if (environment.specular_gpu) {
        const auto image = std::dynamic_pointer_cast<SdlComputeTexture>(environment.specular_gpu);
        if (!image || !image->texture || image->device != device || !borrowed || layers != 6 ||
            cube_array)
            throw std::runtime_error("GPU environment requires a live cubemap on the same device.");
        *borrowed = environment.specular_gpu;
        return image->texture;
    }
#else
    (void)borrowed;
#endif
    const bool has_environment = environment_cube_present(environment);
    const std::uint32_t width = has_environment ? environment.specular_width : 1;
    const std::uint32_t mip_count = has_environment ? environment.specular_mip_count : 1;
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = cube_array ? SDL_GPU_TEXTURETYPE_CUBE_ARRAY : SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = width;
    texture_info.layer_count_or_depth = layers;
    texture_info.num_levels = mip_count;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture texture_owner{SDL_CreateGPUTexture(device, &texture_info), {device}};
    auto* texture = texture_owner.get();
    if (!texture)
        gpu_error("SDL_CreateGPUTexture environment");

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer environment");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    std::vector<OwnedSdlTransfer> transfers;
    transfers.reserve(static_cast<std::size_t>(mip_count) * 6);
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        for (std::uint32_t face = 0; face < layers; ++face) {
            int image_width = static_cast<int>(std::max(width >> mip, 1u));
            int image_height = image_width;
            const TextureData* face_data =
                has_environment
                    ? &environment.specular_faces[static_cast<std::size_t>(mip) * layers + face]
                    : nullptr;
            std::vector<std::uint16_t> decoded_half_pixels;
            const std::uint8_t* source_bytes = nullptr;
            std::size_t byte_size = 0;
            std::size_t row_size = 0;
            if (environment.specular_rgba16f && face_data) {
                byte_size = static_cast<std::size_t>(image_width) * image_height * 8;
                if (face_data->bytes.size() != byte_size) {
                    throw std::runtime_error("Compiled HDR cubemap face has an invalid size.");
                }
                source_bytes = face_data->bytes.data();
                row_size = static_cast<std::size_t>(image_width) * 8;
            } else {
                // No environment: the pin composes no IBL arm without
                // PBR_HAS_ENV (pbr-compose.ts `_hasIbl`), so no variant
                // samples this texel; it exists only to fill the slot.
                decoded_half_pixels = face_data ? decode_rgbd(*face_data, image_width, image_height)
                                                : std::vector<std::uint16_t>(4, 0);
                source_bytes = reinterpret_cast<const std::uint8_t*>(decoded_half_pixels.data());
                byte_size = decoded_half_pixels.size() * sizeof(std::uint16_t);
                row_size = static_cast<std::size_t>(image_width) * 4 * sizeof(std::uint16_t);
            }
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(byte_size);
            OwnedSdlTransfer transfer_owner{SDL_CreateGPUTransferBuffer(device, &transfer_info),
                                            {device}};
            auto* transfer = transfer_owner.get();
            if (!transfer)
                gpu_error("SDL_CreateGPUTransferBuffer environment");
            void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
            if (!mapped)
                gpu_error("SDL_MapGPUTransferBuffer environment");
            for (int row = 0; row < image_height; ++row) {
                const int source_row = environment.specular_rgba16f ? row : image_height - row - 1;
                std::memcpy(
                    static_cast<std::uint8_t*>(mapped) + static_cast<std::size_t>(row) * row_size,
                    source_bytes + static_cast<std::size_t>(source_row) * row_size, row_size);
            }
            SDL_UnmapGPUTransferBuffer(device, transfer);
            transfers.push_back(std::move(transfer_owner));
            const SDL_GPUTextureTransferInfo source{transfer, 0, static_cast<Uint32>(image_width),
                                                    static_cast<Uint32>(image_height)};
            const SDL_GPUTextureRegion destination{texture,
                                                   mip,
                                                   face,
                                                   0,
                                                   0,
                                                   0,
                                                   static_cast<Uint32>(image_width),
                                                   static_cast<Uint32>(image_height),
                                                   1};
            SDL_UploadToGPUTexture(copy, &source, &destination, false);
        }
    }
    copy.end();
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer environment");
    transfers.clear();
    return texture_owner.release();
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_PINNED_BACKGROUNDS
SDL_GPUTexture* upload_dds_skybox(SDL_GPUDevice* device, const EnvironmentState& environment) {
    const TextureData& data = environment.skybox_texture;
    if (!environment.has_skybox || environment.skybox_width == 0 ||
        environment.skybox_mip_count == 0 || environment.skybox_data_offset >= data.bytes.size()) {
        throw std::runtime_error("DDS skybox metadata is incomplete.");
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = environment.skybox_width;
    texture_info.height = environment.skybox_width;
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels = environment.skybox_mip_count;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture texture_owner{SDL_CreateGPUTexture(device, &texture_info), {device}};
    auto* texture = texture_owner.get();
    if (!texture)
        gpu_error("SDL_CreateGPUTexture DDS skybox");

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer DDS skybox");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    std::vector<OwnedSdlTransfer> transfers;
    transfers.reserve(static_cast<std::size_t>(environment.skybox_mip_count) * 6);
    // The face/mip/offset walk and its truncation guard are the shared
    // half; only the upload below is this backend's.
    for_each_dds_skybox_level(environment, [&](std::uint32_t face, std::uint32_t mip,
                                               std::uint32_t size, std::size_t offset,
                                               std::size_t byte_size) {
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = static_cast<Uint32>(byte_size);
        OwnedSdlTransfer transfer_owner{SDL_CreateGPUTransferBuffer(device, &transfer_info),
                                        {device}};
        auto* transfer = transfer_owner.get();
        if (!transfer)
            gpu_error("SDL_CreateGPUTransferBuffer DDS skybox");
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer DDS skybox");
        std::memcpy(mapped, data.bytes.data() + offset, byte_size);
        SDL_UnmapGPUTransferBuffer(device, transfer);
        transfers.push_back(std::move(transfer_owner));
        const SDL_GPUTextureTransferInfo source{transfer, 0, size, size};
        const SDL_GPUTextureRegion destination{texture, mip, face, 0, 0, 0, size, size, 1};
        SDL_UploadToGPUTexture(copy, &source, &destination, false);
    });
    copy.end();
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer DDS skybox");
    transfers.clear();
    return texture_owner.release();
}

SDL_GPUVertexElementFormat pinned_vertex_format(upstream::PinnedVertexFormat format) {
    switch (format) {
    case upstream::PinnedVertexFormat::float32x2:
        return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
    case upstream::PinnedVertexFormat::float32x3:
        return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
    case upstream::PinnedVertexFormat::float32x4:
        return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4;
    }
    throw std::runtime_error("Unmapped pinned vertex format.");
}

void create_background_arms(GpuState& state, const Scene& scene,
                            const SDL_GPUGraphicsPipelineCreateInfo& base,
                            const SDL_GPUColorTargetDescription& base_target) {
    state.background_draws.for_each([&](upstream::PinnedBackgroundArmKind kind) {
        const upstream::PinnedBackgroundArm& arm = upstream::pinned_background_arm(kind);
        GpuBackgroundArm resources;
        resources.arm = &arm;
        PinnedStage vertex = load_pinned_stage(state.device, std::string(arm.vertex_stem),
                                               SDL_GPU_SHADERSTAGE_VERTEX);
        PinnedStage fragment = load_pinned_stage(state.device, std::string(arm.fragment_stem),
                                                 SDL_GPU_SHADERSTAGE_FRAGMENT);
        std::vector<SDL_GPUVertexBufferDescription> buffers;
        std::vector<SDL_GPUVertexAttribute> attributes;
        for (std::uint32_t slot = 0; slot < arm.stream_count; ++slot) {
            const upstream::PinnedVertexStream& stream =
                upstream::pinned_background_streams[arm.first_stream + slot];
            buffers.push_back({slot, stream.stride, SDL_GPU_VERTEXINPUTRATE_VERTEX, 0});
            for (std::uint32_t index = 0; index < stream.attribute_count; ++index) {
                const upstream::PinnedVertexAttribute& attribute =
                    upstream::pinned_background_attributes[stream.first_attribute + index];
                attributes.push_back({attribute.location, slot,
                                      pinned_vertex_format(attribute.format), attribute.offset});
            }
        }
        SDL_GPUColorTargetDescription target = base_target;
        target.blend_state =
            arm.blend ? blend_state_from(arm.blend_factors) : SDL_GPUColorTargetBlendState{};
        SDL_GPUGraphicsPipelineCreateInfo info = base;
        info.vertex_shader = vertex.shader.get();
        info.fragment_shader = fragment.shader.get();
        info.vertex_input_state = SDL_GPUVertexInputState{
            buffers.data(),
            static_cast<Uint32>(buffers.size()),
            attributes.data(),
            static_cast<Uint32>(attributes.size()),
        };
        info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        info.rasterizer_state.cull_mode = gpu_cull_mode(arm.cull);
        info.rasterizer_state.front_face = gpu_front_face(arm.clockwise_front_face);
        info.depth_stencil_state.enable_depth_write =
            arm.depth_write && info.target_info.has_depth_stencil_target;
        info.target_info.color_target_descriptions = &target;
        info.target_info.num_color_targets = 1;
        resources.pipeline = create_sdl_gpu_graphics_pipeline(state.device, &info);
        if (!resources.pipeline) {
            gpu_error(("SDL_CreateGPUGraphicsPipeline background " + std::string(arm.fragment_stem))
                          .c_str());
        }
        resources.vertex_slots = std::move(vertex.slots);
        resources.fragment_slots = std::move(fragment.slots);
        upstream::PinnedBackgroundBuffers data = upstream::pinned_background_buffers(arm, scene);
        for (const std::vector<std::uint8_t>& bytes : data.vertex) {
            resources.vertex_buffers.push_back(upload_buffer(
                state.device, SDL_GPU_BUFFERUSAGE_VERTEX, bytes.data(), bytes.size()));
        }
        resources.indices = upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_INDEX,
                                          data.indices.data(), data.indices.size());
        resources.index_count = static_cast<std::uint32_t>(
            data.indices.size() /
            (arm.index_uint32 ? sizeof(std::uint32_t) : sizeof(std::uint16_t)));
        resources.mesh_block = std::move(data.mesh_block);
        switch (kind) {
        case upstream::PinnedBackgroundArmKind::ground:
        case upstream::PinnedBackgroundArmKind::ground_dither:
            resources.texture = upload_texture(state.device, scene.environment.ground_texture,
                                               false, {255, 255, 255, 255});
            resources.owns_texture = true;
            resources.sampler = state.ground_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::dds_skybox:
        case upstream::PinnedBackgroundArmKind::dds_skybox_no_dither:
            resources.texture = upload_dds_skybox(state.device, scene.environment);
            resources.owns_texture = true;
            resources.sampler = state.background_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::hdr_skybox:
            resources.texture = state.environment;
            resources.sampler = state.background_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::image_skybox:
            resources.texture =
                upload_cube_texture(state.device, &scene.environment.image_skybox_faces);
            resources.owns_texture = true;
            resources.sampler = state.background_sampler;
            break;
        case upstream::PinnedBackgroundArmKind::solid_skybox:
            break;
        }
        state.background_arms.push_back(std::move(resources));
    });
}

void draw_background_arm(SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                         const GpuBackgroundArm& arm, const upstream::SceneUniforms& scene_block) {
    SDL_BindGPUGraphicsPipeline(pass, arm.pipeline);
    const auto blocks = [&](const std::string& name, std::size_t) -> PinnedStageBlock {
        if (name == "scene")
            return {&scene_block, sizeof(scene_block)};
        if (name == "mesh")
            return {arm.mesh_block.data(), arm.mesh_block.size()};
        return {};
    };
    push_stage_uniforms(command, arm.vertex_slots, false, "background vertex stage", blocks);
    push_stage_uniforms(command, arm.fragment_slots, true, "background fragment stage", blocks);
    std::vector<SDL_GPUBufferBinding> vertex_bindings;
    vertex_bindings.reserve(arm.vertex_buffers.size());
    for (SDL_GPUBuffer* buffer : arm.vertex_buffers)
        vertex_bindings.push_back({buffer, 0});
    SDL_BindGPUVertexBuffers(pass, 0, vertex_bindings.data(),
                             static_cast<Uint32>(vertex_bindings.size()));
    const SDL_GPUBufferBinding index_binding{arm.indices, 0};
    SDL_BindGPUIndexBuffer(pass, &index_binding,
                           arm.arm->index_uint32 ? SDL_GPU_INDEXELEMENTSIZE_32BIT
                                                 : SDL_GPU_INDEXELEMENTSIZE_16BIT);
    // Each arm's group 1 samples at most its one texture, through the
    // sampler its factory pairs with it.
    bind_stage_textures(pass, arm.fragment_slots, true, "background fragment stage",
                        [&](const std::string&, std::size_t) {
                            return SDL_GPUTextureSamplerBinding{arm.texture, arm.sampler};
                        });
    count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, arm.index_count, 1, 0, 0, 0);
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal
