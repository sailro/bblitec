#pragma once

#include <bblite/features/compute_buffers.hpp>
#include <bblite/features/compute_mipmaps.hpp>
#include <bblite/features/compute_shaders.hpp>
#include <bblite/features/compute_textures.hpp>
#include <bblite/features/gpu_task_timing.hpp>
#include <bblite/features/storage_readback.hpp>

#include "pal_sdl_gpu_shared.hpp"
#include "pal_offscreen_gpu.hpp"
#if BBLITE_GPU_TASK_TIMING
#include "pal_sdl_gpu_timestamp.hpp"
#endif
#if BBLITE_COMPUTE_SHADERS
#include "pal_sdl_compute_pipeline.hpp"
#endif
#if BBLITE_COMPUTE_TEXTURES
#include "pal_sdl_compute_texture.hpp"
#endif
#if BBLITE_COMPUTE_MIPMAPS
#include "pal_sdl_compute_mipmaps.hpp"
#endif

#if BBLITE_COMPUTE_SHADERS || BBLITE_COMPUTE_MIPMAPS || BBLITE_GPU_TASK_TIMING
#include "pal_sdl_compute_commands.hpp"
#endif
#if BBLITE_COMPUTE_BUFFERS
#include "pal_sdl_storage_buffer.hpp"
#endif
#include <thread>
#if BBLITE_STORAGE_READBACK
#include "pal_sdl_storage_readback.hpp"
#endif

namespace bbl::pal {

/** Capture the queue boundary on its owner; only the native fence wait leaves that thread. */
class SdlSubmissionCompletion final : public OffscreenCompletion {
public:
    SdlSubmissionCompletion(SDL_GPUDevice* owner, std::function<void(std::exception_ptr)> complete)
        : device_(owner), fence_(capture(owner), {owner}),
          waiter_([this, complete = std::move(complete)] {
              std::exception_ptr error;
              try {
                  if (!wait_sdl_fence(device_, fence_.get()))
                      gpu_error("SDL_WaitForGPUFences submitted work");
              } catch (...) {
                  error = std::current_exception();
              }
              complete(error);
          }) {}

private:
    static SDL_GPUFence* capture(SDL_GPUDevice* device) {
        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
        if (!command)
            gpu_error("SDL_AcquireGPUCommandBuffer completion fence");
        auto* fence = command.submit_with_fence();
        if (!fence)
            gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence completion");
        return fence;
    }
    SDL_GPUDevice* device_;
    OwnedSdlFence fence_;
    std::jthread waiter_;
};

/** The host retains the device until all producers and image leases end. */
struct SdlOffscreenDevice final : OffscreenDevice {
#if BBLITE_GPU_TASK_TIMING
    bool supports_gpu_timestamps() const override {
        return SDL_BBLiteGetGPUTimestampFrequency(device) != 0;
    }
    std::shared_ptr<GpuTimestampQuerySet>
    create_gpu_timestamp_query_set(std::uint32_t count) override {
        return std::make_shared<SdlGpuTimestampQuerySet>(device, count);
    }
    std::shared_ptr<GpuTimestampReadback>
    resolve_gpu_timestamps(const std::shared_ptr<GpuTimestampQuerySet>& queries,
                           std::uint32_t count) override {
        const auto native = std::dynamic_pointer_cast<SdlGpuTimestampQuerySet>(queries);
        if (!native || native->device != device)
            throw std::runtime_error("Timestamp queries belong to a different GPU device.");
        return std::make_shared<SdlGpuTimestampReadback>(native, count);
    }
#endif
#if BBLITE_COMPUTE_SHADERS || BBLITE_COMPUTE_MIPMAPS || BBLITE_GPU_TASK_TIMING
    void submit_compute_commands(std::span<const ComputeCommand> commands) override {
        submit_sdl_compute_commands(device, commands);
    }
#endif
#if BBLITE_COMPUTE_MIPMAPS
    std::shared_ptr<ComputeMipmapPipeline>
    prepare_compute_mipmap_pipeline(const std::string&, const std::string&) override {
        return std::make_shared<SdlComputeMipmapPipeline>();
    }
    std::shared_ptr<ComputeMipmapLevel>
    prepare_compute_mipmap_level(const std::shared_ptr<ComputeMipmapPipeline>& pipeline,
                                 const std::shared_ptr<ComputeTextureAllocation>& allocation,
                                 const ComputeTextureDescriptor& descriptor,
                                 std::uint32_t source_mip, std::uint32_t target_mip,
                                 std::uint32_t base_array_layer) override {
        return create_sdl_compute_mipmap_level(device, pipeline, allocation, descriptor, source_mip,
                                               target_mip, base_array_layer);
    }
#endif
    explicit SdlOffscreenDevice(SDL_GPUDevice* value) : device(value) {}
#if BBLITE_STORAGE_READBACK
    std::shared_ptr<StorageReadback>
    create_storage_readback(const StorageReadbackDescriptor& descriptor) override {
        return std::make_shared<SdlStorageReadback>(device, descriptor);
    }
#endif
#if BBLITE_COMPUTE_SHADERS
    std::shared_ptr<ComputeGroupLayout>
    create_compute_group_layout(const ComputeGroupLayoutDescriptor& descriptor) override {
        return std::make_shared<SdlComputeGroupLayout>(descriptor);
    }
    std::shared_ptr<ComputePipelineLayout>
    create_compute_pipeline_layout(const ComputePipelineLayoutDescriptor& descriptor) override {
        return std::make_shared<SdlComputePipelineLayout>(descriptor);
    }
    std::shared_ptr<ComputeShaderModule>
    create_compute_shader_module(const ComputeShaderModuleDescriptor& descriptor,
                                 const std::string& artifact) override {
        return std::make_shared<SdlComputeShaderModule>(descriptor, artifact);
    }
    std::shared_ptr<ComputePipeline>
    create_compute_pipeline(const ComputePipelineDescriptor& descriptor) override {
        return create_sdl_compute_pipeline(device, descriptor);
    }
    std::shared_ptr<ComputeBindGroup>
    create_compute_bind_group(const ComputeBindGroupDescriptor& descriptor) override {
        return create_sdl_compute_bind_group(descriptor);
    }
    void dispatch_compute(const ComputeDispatch& dispatch) override {
        dispatch_sdl_compute(device, dispatch);
    }
#endif
    ComputeShaderLimits compute_shader_limits() const override {
        // SDL validates pipeline resource counts; it exposes no numeric query.
        return {};
    }
#if BBLITE_COMPUTE_BUFFERS
    double minimum_uniform_buffer_offset_alignment() const override {
        // Uniform slices use the portable WebGPU/D3D12 constant-buffer alignment.
        return 256;
    }
    double maximum_storage_buffer_size() const override {
        // SDL exposes the API's Uint32 size range; allocation validates device capacity.
        return static_cast<double>(std::numeric_limits<Uint32>::max());
    }
    std::shared_ptr<StorageBufferAllocation>
    create_storage_buffer(const StorageBufferDescriptor& options,
                          std::optional<std::span<const std::uint8_t>> initial) override {
        return create_sdl_storage_buffer(device, options, initial);
    }
#endif
#if BBLITE_COMPUTE_TEXTURES
    ComputeTextureCapabilities compute_texture_capabilities() const override {
        // SDL exposes format/usage queries, but no numeric texture limits or
        // optional WebGPU feature negotiation. Allocation validates the extent.
        return {};
    }
    void create_compute_texture(const ComputeTextureDescriptor& options,
                                ComputeTextureCreated complete) override {
        create_sdl_compute_texture(device, options, std::move(complete));
    }
#endif
    std::unique_ptr<OffscreenCompletion>
    on_submitted_work_done(std::function<void(std::exception_ptr)> complete) override {
        return std::make_unique<SdlSubmissionCompletion>(device, std::move(complete));
    }
    SDL_GPUDevice* device;
};

struct SdlOffscreenImage final : OffscreenImage {
    SdlOffscreenImage(SDL_GPUDevice* owner, std::uint32_t width, std::uint32_t height)
        : device(owner),
          texture(create_frame_texture(
              owner, SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM, SDL_GPU_SAMPLECOUNT_1, width, height,
              SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER)) {}
    ~SdlOffscreenImage() override { SDL_ReleaseGPUTexture(device, texture); }
    SDL_GPUDevice* device;
    SDL_GPUTexture* texture;
};

/** Three GPU images, reused only after the presenter releases its GPU fences. */
class SdlOffscreenTarget {
public:
    explicit SdlOffscreenTarget(SDL_GPUDevice* device) : device_(device) {}

    SDL_GPUTexture* acquire(std::uint32_t width, std::uint32_t height, OffscreenRun& run) {
        auto* image = images_.acquire(width, height, run, [&](auto w, auto h) {
            return std::make_shared<SdlOffscreenImage>(device_, w, h);
        });
        return image ? image->texture : nullptr;
    }

    void publish(SdlGpuCommand& command, OffscreenRun& run) {
        if (!command.submit())
            gpu_error("SDL_SubmitGPUCommandBuffer offscreen");
        // The presenter's submit follows this one on the same device queue.
        images_.publish(run);
    }

private:
    SDL_GPUDevice* device_;
    OffscreenImagePool<SdlOffscreenImage> images_;
};

} // namespace bbl::pal
