#include <SDL3/SDL.h>
#include <webgpu/webgpu.h>
#include <cstddef>
namespace {
std::size_t sdl_submissions = 0, dawn_submissions = 0;
bool counted_sdl_submit(SDL_GPUCommandBuffer* command) {
    ++sdl_submissions;
    return SDL_SubmitGPUCommandBuffer(command);
}
void counted_dawn_submit(WGPUQueue queue, std::size_t count, const WGPUCommandBuffer* commands) {
    ++dawn_submissions;
    wgpuQueueSubmit(queue, count, commands);
}
} // namespace
#define SDL_SubmitGPUCommandBuffer counted_sdl_submit
#define wgpuQueueSubmit counted_dawn_submit
#define BBLITE_COMPUTE_SHADERS 1
#define BBLITE_COMPUTE_MIPMAPS 1
#include <bblite/pal_offscreen.hpp>
#include "pal_gpu_shared.hpp"
#include "pal_sdl_compute_pipeline.hpp"
#include "pal_dawn_compute_pipeline.hpp"
#include "pal_sdl_compute_commands.hpp"
#include "pal_dawn_compute_commands.hpp"
#include "pal_sdl_storage_readback.hpp"
#include "pal_dawn_storage_readback.hpp"
#include <filesystem>
#include <iostream>
#include <cassert>
#include <condition_variable>
#undef SDL_SubmitGPUCommandBuffer
#undef wgpuQueueSubmit

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

ComputeGroupLayoutDescriptor group_descriptor() {
    ComputeGroupLayoutDescriptor result;
    result.label = "dispatch-fixture";
    ComputeLayoutEntry uniform;
    uniform.binding = 2;
    uniform.visibility = 4;
    uniform.buffer = bbl::ComputeBufferLayout{"uniform", true, 32};
    ComputeLayoutEntry storage;
    storage.binding = 7;
    storage.visibility = 4;
    storage.buffer = bbl::ComputeBufferLayout{"storage", false, 64};
    auto unused_uniform = uniform;
    unused_uniform.binding = 11;
    result.entries = {unused_uniform, storage, uniform};
    return result;
}
std::vector<std::uint8_t> initial_values() {
    std::vector<float> values(16);
    for (std::size_t i = 0; i < values.size(); ++i)
        values[i] = static_cast<float>(i);
    const auto* bytes = reinterpret_cast<const std::uint8_t*>(values.data());
    return {bytes, bytes + 64};
}
std::vector<std::uint8_t> uniforms() {
    std::vector<std::uint8_t> bytes(512);
    float a = 3, b = 7;
    std::memcpy(bytes.data(), &a, 4);
    std::memcpy(bytes.data() + 256, &b, 4);
    return bytes;
}
void assert_result(const void* bytes) {
    const auto* values = static_cast<const float*>(bytes);
    for (std::size_t i = 0; i < 16; ++i)
        if (values[i] != static_cast<float>(i) + 10)
            throw std::runtime_error("GPU dispatch readback mismatch at " + std::to_string(i) +
                                     ": " + std::to_string(values[i]));
}
void qualify_readback(StorageReadback& readback,
                      const std::shared_ptr<StorageBufferAllocation>& storage) {
    const auto map = [&readback](std::size_t length) {
        struct Completion {
            std::mutex mutex;
            std::condition_variable changed;
            bool ready = false;
            std::exception_ptr error;
        };
        auto state = std::make_shared<Completion>();
        auto operation = readback.map_async(0, length, [state](std::exception_ptr error) {
            {
                std::lock_guard lock(state->mutex);
                state->error = std::move(error);
                state->ready = true;
            }
            state->changed.notify_one();
        });
        std::unique_lock lock(state->mutex);
        if (!state->changed.wait_for(lock, std::chrono::seconds(30), [&] { return state->ready; }))
            throw std::runtime_error("PAL storage readback completion timed out.");
        if (state->error)
            std::rethrow_exception(state->error);
        return readback.mapped_range(0, length);
    };
    readback.copy_from(storage, 0, 0, 64, "whole-result");
    const auto bytes = map(64);
    assert_result(bytes.data());
    std::cout << "PAL staging values:";
    for (std::size_t i = 0; i < 16; ++i) {
        float value;
        std::memcpy(&value, bytes.data() + i * sizeof(float), sizeof(float));
        std::cout << ' ' << value;
    }
    std::cout << '\n';
    readback.unmap();
    readback.copy_from(storage, 8, 0, 16, "partial-result");
    const auto partial = map(16);
    for (std::size_t i = 0; i < 4; ++i) {
        float value;
        std::memcpy(&value, partial.data() + i * sizeof(float), sizeof(float));
        if (value != static_cast<float>(i) + 12)
            throw std::runtime_error("Reused PAL staging buffer returned the wrong source range.");
    }
    readback.unmap();
    readback.destroy();
}
void run_sdl(const std::string& source) {
    if (!SDL_Init(SDL_INIT_VIDEO))
        gpu_error("SDL_Init");
    auto* device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL, true, "direct3d12");
    if (!device)
        gpu_error("SDL_CreateGPUDevice");
    {
        const auto bytes = initial_values(), params = uniforms();
        auto storage = create_sdl_storage_buffer(device, {64, 132, "values"}, bytes);
        auto uniform = create_sdl_storage_buffer(device, {512, 64, "uniforms"}, params);
        auto layout = std::make_shared<SdlComputeGroupLayout>(group_descriptor());
        auto layouts = std::make_shared<ComputeGroupLayouts>();
        layouts->push_back(layout);
        auto pipeline_layout = std::make_shared<SdlComputePipelineLayout>(
            ComputePipelineLayoutDescriptor{"layout", layouts});
        auto module = std::make_shared<SdlComputeShaderModule>(
            ComputeShaderModuleDescriptor{"module", source}, "fixture.comp");
        auto pipeline =
            create_sdl_compute_pipeline(device, {"pipeline", pipeline_layout, {module, "main"}});
        ComputeBindGroupDescriptor group{"group",
                                         layout,
                                         {{11, ComputeBufferResource{uniform, 0, 32}},
                                          {2, ComputeBufferResource{uniform, 0, 32}},
                                          {7, ComputeBufferResource{storage, 0, 64}}}};
        auto binding = create_sdl_compute_bind_group(group);
        ComputeDispatch dispatch;
        dispatch.pipeline = pipeline;
        dispatch.groups = {{binding, {0, 256}}};
        dispatch.workgroups = {4, 1, 1};
        std::vector<ComputeCommand> commands{dispatch};
        dispatch.groups[0].dynamic_offsets = {256, 0};
        commands.emplace_back(dispatch);
        sdl_submissions = 0;
        submit_sdl_compute_commands(device, commands);
        if (sdl_submissions != 1)
            throw std::runtime_error("Two dependent dispatches did not use one GPU submission.");
        std::cout << "sdl: dispatches=2 submissions=" << sdl_submissions << '\n';
        SdlStorageReadback readback(device, {"fixture-readback", 64, 9});
        qualify_readback(readback, storage);
    }
    SDL_DestroyGPUDevice(device);
    SDL_Quit();
    std::cout
        << "sdl_gpu: two ordered dispatches + dynamic uniforms + 16 GPU readback values passed\n";
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
        const auto bytes = initial_values(), params = uniforms();
        auto storage = create_dawn_storage_buffer(device, queue, {64, 132, "values"}, bytes),
             uniform = create_dawn_storage_buffer(device, queue, {512, 64, "uniforms"}, params);
        auto layout = create_dawn_compute_group_layout(device, group_descriptor());
        auto layouts = std::make_shared<ComputeGroupLayouts>();
        layouts->push_back(layout);
        auto pipeline_layout = create_dawn_compute_pipeline_layout(device, {"layout", layouts});
        auto module = create_dawn_compute_shader_module(device, {"module", source});
        auto pipeline =
            create_dawn_compute_pipeline(device, {"pipeline", pipeline_layout, {module, "main"}});
        auto binding =
            create_dawn_compute_bind_group(device, {"group",
                                                    layout,
                                                    {{11, ComputeBufferResource{uniform, 0, 32}},
                                                     {2, ComputeBufferResource{uniform, 0, 32}},
                                                     {7, ComputeBufferResource{storage, 0, 64}}}});
        ComputeDispatch dispatch;
        dispatch.pipeline = pipeline;
        dispatch.groups = {{binding, {0, 256}}};
        dispatch.workgroups = {4, 1, 1};
        std::vector<ComputeCommand> commands{dispatch};
        dispatch.groups[0].dynamic_offsets = {256, 0};
        commands.emplace_back(dispatch);
        dawn_submissions = 0;
        submit_dawn_compute_commands(device, queue, commands);
        if (dawn_submissions != 1)
            throw std::runtime_error("Two dependent dispatches did not use one GPU submission.");
        std::cout << "dawn: dispatches=2 submissions=" << dawn_submissions << '\n';
        DawnStorageReadback readback(instance, device, queue, {"fixture-readback", 64, 9});
        qualify_readback(readback, storage);
    }
    wgpuQueueRelease(queue);
    wgpuDeviceDestroy(device);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuInstanceRelease(instance);
    std::cout
        << "dawn: two ordered dispatches + dynamic uniforms + 16 GPU readback values passed\n";
}
int main(int argc, char** argv) {
    try {
        if (argc != 3)
            throw std::runtime_error("Expected backend and WGSL source path.");
        auto bytes = read_binary_file(argv[2]);
        const std::string source(bytes.begin(), bytes.end());
        if (std::string(argv[1]) == "dawn")
            run_dawn(source);
        else if (std::string(argv[1]) == "sdl_gpu")
            run_sdl(source);
        else
            throw std::runtime_error("Unknown backend.");
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
