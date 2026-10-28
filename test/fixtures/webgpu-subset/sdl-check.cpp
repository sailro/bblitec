// The lowered splat-stream library's GPU work on an SDL_GPU device through
// `SdlWebGpuDevice`, with the pinned WGSL compiled by the offline shader
// compiler under the names `wgsl_stage_stem` gives them (BBLITE_GPU_SHADER_DIR):
// a stage the device does not find under the name the library's own module
// text gives it fails the run.

#include "sdl-harness.hpp"
#include "stream-render.hpp"

namespace {

/** The scene pass an SDL_GPU renderer opens: rgba8 colour and its depth format. */
struct SdlTarget final : stream_check::RenderTarget {
    SDL_GPUDevice* native;
    bbl::pal::SdlWebGpuDevice& device;
    bbl::pal::OwnedSdlTexture color, multisampled, depth;
    bbl::pal::OwnedSdlTransfer download;
    SDL_GPUTextureFormat depth_format;
    SdlTarget(SDL_GPUDevice* owner, bbl::pal::SdlWebGpuDevice& gpu)
        : native(owner), device(gpu), color(nullptr, {owner}), multisampled(nullptr, {owner}),
          depth(nullptr, {owner}), download(nullptr, {owner}) {
        width = 96;
        height = 64;
        depth_format = SDL_GPUTextureSupportsFormat(native, SDL_GPU_TEXTUREFORMAT_D24_UNORM_S8_UINT,
                                                    SDL_GPU_TEXTURETYPE_2D,
                                                    SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET)
                           ? SDL_GPU_TEXTUREFORMAT_D24_UNORM_S8_UINT
                           : SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
        signature = {"rgba8unorm", bbl::pal::sdl_webgpu_format_name(depth_format), {}, 1};
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
        info.size = width * height * 4;
        download.reset(SDL_CreateGPUTransferBuffer(native, &info));
        stream_check::require(download != nullptr, "SDL_CreateGPUTransferBuffer target");
    }
    void configure(std::uint32_t samples) override {
        signature.sample_count = samples;
        const auto count = bbl::pal::gpu_sample_count_from(samples);
        const auto texture = [&](SDL_GPUTextureFormat format, SDL_GPUTextureUsageFlags usage,
                                 SDL_GPUSampleCount sample_count) {
            SDL_GPUTextureCreateInfo info{};
            info.type = SDL_GPU_TEXTURETYPE_2D;
            info.format = format;
            info.usage = usage;
            info.width = width;
            info.height = height;
            info.layer_count_or_depth = 1;
            info.num_levels = 1;
            info.sample_count = sample_count;
            auto* result = SDL_CreateGPUTexture(native, &info);
            stream_check::require(result != nullptr, "SDL_CreateGPUTexture target");
            return result;
        };
        color.reset(texture(SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                            SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER,
                            SDL_GPU_SAMPLECOUNT_1));
        depth.reset(texture(depth_format, SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET, count));
        multisampled.reset(samples > 1 ? texture(SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                                                 SDL_GPU_TEXTUREUSAGE_COLOR_TARGET, count)
                                       : nullptr);
    }
    std::vector<std::uint8_t>
    frame(const std::function<void(const bbl::GpuCommandEncoderHandle&)>& prepare,
          const std::function<void(const bbl::GpuEncoderHandle&)>& draw) override {
        bbl::pal::SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(native)};
        stream_check::require(command.get() != nullptr, "SDL_AcquireGPUCommandBuffer frame");
        const auto encoder = device.frame_command_encoder();
        prepare(encoder);
        encoder->encode(command);
        SDL_GPUColorTargetInfo color_info{};
        color_info.texture = multisampled ? multisampled.get() : color.get();
        color_info.resolve_texture = multisampled ? color.get() : nullptr;
        color_info.clear_color = SDL_FColor{0, 0, 0, 1};
        color_info.load_op = SDL_GPU_LOADOP_CLEAR;
        color_info.store_op = multisampled ? SDL_GPU_STOREOP_RESOLVE : SDL_GPU_STOREOP_STORE;
        SDL_GPUDepthStencilTargetInfo depth_info{};
        depth_info.texture = depth.get();
        depth_info.clear_depth = 0;
        depth_info.load_op = SDL_GPU_LOADOP_CLEAR;
        depth_info.store_op = SDL_GPU_STOREOP_DONT_CARE;
        depth_info.stencil_load_op = SDL_GPU_LOADOP_CLEAR;
        depth_info.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
        {
            bbl::pal::SdlRenderPass pass{
                SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info)};
            stream_check::require(pass.get() != nullptr, "SDL_BeginGPURenderPass");
            draw(bbl::pal::SdlWebGpuDevice::borrow_render_pass(command, pass));
        }
        {
            bbl::pal::SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
            const SDL_GPUTextureRegion source{color.get(), 0, 0, 0, 0, 0, width, height, 1};
            const SDL_GPUTextureTransferInfo destination{download.get(), 0, width, height};
            SDL_DownloadFromGPUTexture(copy, &source, &destination);
        }
        bbl::pal::OwnedSdlFence fence{command.submit_with_fence(), {native}};
        stream_check::require(fence && bbl::pal::wait_sdl_gpu_fence(native, fence.get()),
                              "SDL frame fence");
        const auto* bytes = static_cast<const std::uint8_t*>(
            SDL_MapGPUTransferBuffer(native, download.get(), false));
        stream_check::require(bytes != nullptr, "SDL_MapGPUTransferBuffer target");
        std::vector<std::uint8_t> image(bytes, bytes + std::size_t{width} * height * 4);
        SDL_UnmapGPUTransferBuffer(native, download.get());
        return image;
    }
};

bbl::js::Promise<bbl::js::PromiseVoid> run(std::shared_ptr<bbl::pal::SdlWebGpuDevice> device,
                                           SDL_GPUDevice* native,
                                           const bbl::GpuSupportedLimits& limits) {
    stream_check::Library library(device);
    stream_check::check_limits(*device, limits);
    co_await stream_check::check_mapping(*device);
    co_await stream_check::check_sort(library, 70000, 69123, 0x13579bdfu);
    co_await stream_check::check_projection(library);
    const auto sog = stream_check::sog_images();
    const auto source = stream_check::upload_source(*device, sog);
    co_await stream_check::check_gather(library, sog, source);
    SdlTarget target(native, *device);
    co_await stream_check::check_render(library, source, target);
    co_return bbl::js::PromiseVoid{};
}

} // namespace

int main() {
    const auto limits = bbl::gpu_required_limits(
        {{"maxBufferSize", 256640000}, {"maxStorageBufferBindingSize", 256640000}});
    return webgpu_fixture::run_sdl(
        limits,
        [&](std::shared_ptr<bbl::pal::SdlWebGpuDevice> device, SDL_GPUDevice* native) {
            return run(device, native, limits);
        },
        "sdl");
}
