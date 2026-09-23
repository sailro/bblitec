#include <bblite/pal_offscreen.hpp>
#include <bblite/pal_procedural_sky.hpp>
#include "pal_gpu_shared.hpp"
#include "pal_sdl_compute_pipeline.hpp"
#include "pal_dawn_compute_pipeline.hpp"
#include "pal_sdl_storage_readback.hpp"
#include "pal_dawn_storage_readback.hpp"
#include <filesystem>
#include <iostream>
#include <cassert>
#include <condition_variable>

namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read fixture artifact: " + path);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
std::string join_path(const std::string& root, const std::string& path) {
    return (std::filesystem::path(root) / path).string();
}
std::string executable_directory() { return std::filesystem::current_path().string(); }
std::string environment_variable(const char* name) {
    const auto* value = SDL_GetEnvironmentVariable(SDL_GetEnvironment(), name);
    return value ? value : "";
}
} // namespace bbl::pal
using namespace bbl::pal;

ComputeTextureDescriptor texture_descriptor() {
    ComputeTextureDescriptor descriptor;
    descriptor.extent = {4, 4, 6};
    descriptor.mip_levels = 3;
    descriptor.format = "rgba16float";
    descriptor.accesses = {"write-only"};
    descriptor.sampled = true;
    descriptor.render_attachment = true;
    descriptor.sample_type = "float";
    descriptor.sampler_type = "filtering";
    descriptor.storage_view_dimension = "2d-array";
    descriptor.sampled_view_dimension = "cube";
    return descriptor;
}
ComputeGroupLayoutDescriptor array_group() {
    ComputeLayoutEntry entry;
    entry.binding = 0;
    entry.visibility = 4;
    entry.storage_texture =
        bbl::ComputeStorageTextureLayout{"write-only", "rgba16float", "2d-array"};
    return {"array-write", {entry}};
}
void verify_pixels(const std::uint8_t* bytes, std::size_t row_pitch, std::size_t layer_pitch) {
    constexpr std::array<std::uint16_t, 6> half{0x3c00, 0x4000, 0x4200, 0x4400, 0x4500, 0x4600};
    for (std::size_t face = 0; face < 6; ++face) {
        for (std::size_t y = 0; y < 4; ++y) {
            for (std::size_t x = 0; x < 4; ++x) {
                std::uint16_t red, alpha;
                const auto offset = face * layer_pitch + y * row_pitch + x * 8;
                std::memcpy(&red, bytes + offset, 2);
                std::memcpy(&alpha, bytes + offset + 6, 2);
                if (red != half[face] || alpha != half[0])
                    throw std::runtime_error("Array face " + std::to_string(face) +
                                             " did not receive compute output.");
            }
        }
    }
    std::cout << "All 96 pixels across six faces contain face values 1,2,3,4,5,6 and alpha=1\n";
}
void run_sdl(const std::string& source) {
    if (!SDL_Init(SDL_INIT_VIDEO))
        gpu_error("SDL_Init");
    auto* device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL, true, "direct3d12");
    if (!device)
        gpu_error("SDL_CreateGPUDevice");
    {
        std::shared_ptr<ComputeTextureAllocation> allocation;
        create_sdl_compute_texture(device, texture_descriptor(), [&](auto image, auto error) {
            if (error)
                std::rethrow_exception(error);
            allocation = std::move(image);
        });
        auto texture = std::dynamic_pointer_cast<SdlComputeTexture>(allocation);
        if (!texture)
            throw std::runtime_error("SDL array texture missing.");
        auto layout = std::make_shared<SdlComputeGroupLayout>(array_group());
        auto layouts = std::make_shared<ComputeGroupLayouts>();
        layouts->push_back(layout);
        auto pipeline_layout = std::make_shared<SdlComputePipelineLayout>(
            ComputePipelineLayoutDescriptor{"layout", layouts});
        auto module = std::make_shared<SdlComputeShaderModule>(
            ComputeShaderModuleDescriptor{"module", source}, "fixture.comp");
        auto pipeline =
            create_sdl_compute_pipeline(device, {"array", pipeline_layout, {module, "main"}});
        auto group = create_sdl_compute_bind_group(
            {"array",
             layout,
             {{0, ComputeTextureResource{allocation, ComputeTextureViewRole::storage}}}});
        dispatch_sdl_compute(device, {pipeline, {{group, {}}}, {4, 4, 6}, {}});
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
        transfer_info.size = 6 * 1024;
        auto* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
        if (!transfer)
            gpu_error("array transfer buffer");
        auto* command = SDL_AcquireGPUCommandBuffer(device);
        auto* pass = SDL_BeginGPUCopyPass(command);
        for (Uint32 face = 0; face < 6; ++face) {
            SDL_GPUTextureRegion region{};
            region.texture = texture->texture;
            region.layer = face;
            region.w = 4;
            region.h = 4;
            region.d = 1;
            SDL_GPUTextureTransferInfo target{};
            target.transfer_buffer = transfer;
            target.offset = face * 1024;
            target.pixels_per_row = 32;
            target.rows_per_layer = 4;
            SDL_DownloadFromGPUTexture(pass, &region, &target);
        }
        SDL_EndGPUCopyPass(pass);
        auto* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
        if (!fence || !SDL_WaitForGPUFences(device, true, &fence, 1))
            gpu_error("array copy fence");
        const auto* pixels =
            static_cast<const std::uint8_t*>(SDL_MapGPUTransferBuffer(device, transfer, false));
        if (!pixels)
            gpu_error("array transfer map");
        verify_pixels(pixels, 256, 1024);
        SDL_UnmapGPUTransferBuffer(device, transfer);
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    SDL_DestroyGPUDevice(device);
    SDL_Quit();
}
void wait_dawn(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo info{};
    info.future = future;
    if (wgpuInstanceWaitAny(instance, 1, &info, 10000000000ull) != WGPUWaitStatus_Success)
        throw std::runtime_error("Dawn fixture wait failed.");
}
void run_dawn(const std::string& source) {
    WGPUInstanceFeatureName feature = WGPUInstanceFeatureName_TimedWaitAny;
    WGPUInstanceDescriptor instance_info = WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_info.requiredFeatureCount = 1;
    instance_info.requiredFeatures = &feature;
    auto instance = wgpuCreateInstance(&instance_info);
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    options.backendType = WGPUBackendType_D3D12;
    WGPURequestAdapterCallbackInfo adapter_callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    adapter_callback.userdata1 = &adapter;
    adapter_callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter value,
                                   WGPUStringView, void* data, void*) {
        if (status == WGPURequestAdapterStatus_Success)
            *static_cast<WGPUAdapter*>(data) = value;
    };
    wait_dawn(instance, wgpuInstanceRequestAdapter(instance, &options, adapter_callback));
    if (!adapter)
        throw std::runtime_error("No Dawn adapter.");
    WGPUDeviceDescriptor device_info = WGPU_DEVICE_DESCRIPTOR_INIT;
    device_info.uncapturedErrorCallbackInfo.callback = [](WGPUDevice const*, WGPUErrorType,
                                                          WGPUStringView error, void*, void*) {
        std::cerr << std::string(error.data, error.length) << "\n";
        std::abort();
    };
    WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.userdata1 = &device;
    device_callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice value, WGPUStringView,
                                  void* data, void*) {
        if (status == WGPURequestDeviceStatus_Success)
            *static_cast<WGPUDevice*>(data) = value;
    };
    wait_dawn(instance, wgpuAdapterRequestDevice(adapter, &device_info, device_callback));
    if (!device)
        throw std::runtime_error("No Dawn device.");
    auto queue = wgpuDeviceGetQueue(device);
    {

        std::shared_ptr<ComputeTextureAllocation> allocation;
        std::exception_ptr creation_error;
        std::atomic<bool> ready = false;
        create_dawn_compute_texture(device, texture_descriptor(), [&](auto image, auto error) {
            allocation = std::move(image);
            creation_error = error;
            ready = true;
        });
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!ready && std::chrono::steady_clock::now() < deadline)
            wgpuInstanceProcessEvents(instance);
        if (!ready)
            throw std::runtime_error("Dawn array validation timed out.");
        if (creation_error)
            std::rethrow_exception(creation_error);
        auto texture = std::dynamic_pointer_cast<DawnComputeTexture>(allocation);
        if (!texture)
            throw std::runtime_error("Dawn array texture missing.");
        auto layout = create_dawn_compute_group_layout(device, array_group());
        auto layouts = std::make_shared<ComputeGroupLayouts>();
        layouts->push_back(layout);
        auto pipeline_layout = create_dawn_compute_pipeline_layout(device, {"layout", layouts});
        auto module = create_dawn_compute_shader_module(device, {"array", source});
        auto pipeline =
            create_dawn_compute_pipeline(device, {"array", pipeline_layout, {module, "main"}});
        auto group = create_dawn_compute_bind_group(
            device, {"array",
                     layout,
                     {{0, ComputeTextureResource{allocation, ComputeTextureViewRole::storage}}}});
        dispatch_dawn_compute(device, queue, {pipeline, {{group, {}}}, {4, 4, 6}, {}});
        DawnStorageReadback staging(instance, device, queue, {"array", 6144, 9});
        DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(device, nullptr)};
        WGPUTexelCopyTextureInfo from = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        from.texture = texture->texture;
        WGPUTexelCopyBufferInfo to = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        to.buffer = staging.buffer;
        to.layout.bytesPerRow = 256;
        to.layout.rowsPerImage = 4;
        WGPUExtent3D extent{4, 4, 6};
        wgpuCommandEncoderCopyTextureToBuffer(encoder, &from, &to, &extent);
        DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
        submit_dawn_command(queue, command);
        WGPUBufferMapCallbackInfo mapped = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        mapped.mode = WGPUCallbackMode_WaitAnyOnly;
        bool success = false;
        mapped.userdata1 = &success;
        mapped.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* data, void*) {
            *static_cast<bool*>(data) = status == WGPUMapAsyncStatus_Success;
        };
        wait_dawn(instance, wgpuBufferMapAsync(staging.buffer, WGPUMapMode_Read, 0, 6144, mapped));
        if (!success)
            throw std::runtime_error("Dawn array readback map failed.");
        verify_pixels(staging.mapped_range(0, 6144).data(), 256, 1024);
        staging.unmap();
    }
    wgpuQueueRelease(queue);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuInstanceRelease(instance);
}
int main(int argc, char** argv) {
    try {
        if (argc != 3)
            throw std::runtime_error("Expected backend and WGSL path.");
        const auto bytes = read_binary_file(argv[2]);
        const std::string source(bytes.begin(), bytes.end());
        if (std::string(argv[1]) == "dawn")
            run_dawn(source);
        else
            run_sdl(source);
        std::cout << argv[1] << ": whole-array storage with cube sampling view PASS\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
