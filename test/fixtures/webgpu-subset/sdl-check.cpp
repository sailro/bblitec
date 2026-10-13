// The splat-stream GPU work on an SDL_GPU device through `SdlWebGpuDevice`, with the
// pinned WGSL compiled by the offline shader compiler under the names
// `wgsl_stage_stem` gives them (BBLITE_GPU_SHADER_DIR).

#include "pal_sdl_gpu_webgpu.hpp"
#include "stream-render.hpp"

#include <bblite/js_realm_state.hpp>

#include <SDL3/SDL.h>

#include <atomic>
#include <fstream>
#include <iterator>

namespace bbl::pal {
// The PAL file services the shader loaders read through.
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("missing " + path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
std::string join_path(const std::string& root, const std::string& relative_path) {
    return root + "/" + relative_path;
}
std::string executable_directory() { return "."; }
std::string environment_variable(const char* name) {
    const char* value = SDL_getenv(name);
    return value ? value : "";
}
} // namespace bbl::pal

namespace bbl {
// The lowered GPU retirement (gpu-resource-retirement.ts) a released batch runs through;
// the fixture's GPU is idle when the protocol releases its renderables.
void retire_gpu_resources(std::shared_ptr<pal::GpuRetirementState>, pal::GpuRetirement retirement) {
    retirement();
}
void dispose_gpu_resource_retirements(std::shared_ptr<pal::GpuRetirementState>) {}
void run_gpu_resource_callbacks(pal::GpuRetirementBatch disposers) {
    for (const auto& dispose : *disposers)
        dispose();
}
} // namespace bbl

namespace {

std::atomic<int> sdl_errors = 0;
void SDLCALL log_message(void*, int, SDL_LogPriority priority, const char* message) {
    std::fprintf(stderr, "SDL: %s\n", message);
    if (priority >= SDL_LOG_PRIORITY_ERROR)
        ++sdl_errors;
}

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
        // The engine's empty scene group (`bind_engine_scene_group`).
        scene_layout = device.create_bind_group_layout({});
        scene_group = device.create_bind_group({{}, scene_layout, {}});
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

bbl::js::Promise<bbl::js::PromiseVoid> run(bbl::pal::SdlWebGpuDevice& device, SDL_GPUDevice* native,
                                           const stream_check::Shaders& shaders,
                                           const bbl::GpuSupportedLimits& limits) {
    std::printf("stem %s\n",
                bbl::pal::wgsl_stage_stem(shaders.radix, "histogramMain", "comp").c_str());
    stream_check::check_limits(device, limits);
    co_await stream_check::check_mapping(device);
    const auto pipelines = stream_check::create_pipelines(device, shaders);
    co_await stream_check::check_sort(device, pipelines, 70000, 69123, 0x13579bdfu);
    co_await stream_check::check_projection(device, pipelines);
    co_await stream_check::check_gather(device, pipelines);
    SdlTarget target(native, device);
    stream_check::check_render(device, pipelines, shaders, target);
    co_return bbl::js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    try {
        stream_check::require(argc == 2, "usage: sdl-check <shader directory>");
        SDL_SetLogOutputFunction(log_message, nullptr);
        stream_check::require(SDL_Init(SDL_INIT_VIDEO), "SDL_Init");
        const auto shaders = stream_check::read_shaders(argv[1]);
        const auto limits = bbl::gpu_required_limits(
            {{"maxBufferSize", 256640000}, {"maxStorageBufferBindingSize", 256640000}});
        SDL_GPUDevice* native = bbl::pal::create_compiled_shader_device(true);
        stream_check::require(native != nullptr, "SDL_CreateGPUDevice");
        std::exception_ptr failure;
        {
            const bbl::js::RealmScope realm;
            bbl::pal::EventLoop loop;
            loop.run([&] {
                auto device = std::make_shared<bbl::pal::SdlWebGpuDevice>(native, limits);
                run(*device, native, shaders, limits)
                    .then([device, &loop](const bbl::js::PromiseVoid&) { loop.close(); },
                          [device, &loop, &failure](std::exception_ptr error) {
                              failure = error;
                              loop.close();
                          });
            });
        }
        SDL_WaitForGPUIdle(native);
        SDL_DestroyGPUDevice(native);
        SDL_Quit();
        if (failure)
            std::rethrow_exception(failure);
        stream_check::require(sdl_errors == 0, "SDL reported errors");
        std::printf("sdl ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
