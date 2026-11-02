#include "workgroup_parser.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string_view>

namespace {
std::atomic<unsigned> validation_errors = 0;
thread_local const char* expected_error = nullptr;
thread_local unsigned expected_error_count = 0;
void SDLCALL log_message(void*, int, SDL_LogPriority priority, const char* message) {
    std::fprintf(stderr, "%s\n", message);
    if (priority >= SDL_LOG_PRIORITY_ERROR) {
        if (priority == SDL_LOG_PRIORITY_ERROR && expected_error &&
            std::string_view(message) == expected_error)
            ++expected_error_count;
        else
            ++validation_errors;
    }
}
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(std::string(message) + ": " + SDL_GetError());
}
template <typename T, auto Release> struct Delete {
    SDL_GPUDevice* device;
    void operator()(T* value) const { Release(device, value); }
};
template <typename T, auto Release> using Owner = std::unique_ptr<T, Delete<T, Release>>;
using Buffer = Owner<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>;
using Transfer = Owner<SDL_GPUTransferBuffer, SDL_ReleaseGPUTransferBuffer>;
using Pipeline = Owner<SDL_GPUComputePipeline, SDL_ReleaseGPUComputePipeline>;

std::vector<Uint8> read(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    require(bool(stream), "Read shader");
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
std::vector<Uint32> sizes(const std::filesystem::path& directory, const char* name) {
    std::ifstream stream(directory / (std::string(name) + ".slots"));
    std::string line;
    std::optional<std::vector<Uint32>> result;
    while (std::getline(stream, line)) {
        std::istringstream row(line);
        std::string key;
        row >> key;
        if (key == "@msl-workgroup-memory")
            read_sdl_metal_workgroup_memory(row, result);
    }
    require(result.has_value(), "Typed MSL allocations missing");
    return *result;
}
Pipeline pipeline(SDL_GPUDevice* device, const std::filesystem::path& directory, const char* name,
                  Uint32 threads) {
    const auto bytes = read(directory / (std::string(name) + ".msl"));
    auto lengths = sizes(directory, name);
    SDL_GPUComputePipelineCreateInfo info{};
    info.code = bytes.data();
    info.code_size = bytes.size();
    info.entrypoint = "main0";
    info.format = SDL_GPU_SHADERFORMAT_MSL;
    info.num_readwrite_storage_buffers = 1;
    info.threadcount_x = threads;
    info.threadcount_y = info.threadcount_z = 1;
    info.props = SDL_CreateProperties();
    require(info.props &&
                SDL_SetNumberProperty(
                    info.props,
                    SDL_PROP_GPU_COMPUTEPIPELINE_CREATE_METAL_THREADGROUP_MEMORY_COUNT_NUMBER,
                    static_cast<Sint64>(lengths.size())),
            "Set allocation count");
    if (!lengths.empty())
        require(SDL_SetPointerProperty(
                    info.props,
                    SDL_PROP_GPU_COMPUTEPIPELINE_CREATE_METAL_THREADGROUP_MEMORY_POINTER,
                    lengths.data()),
                "Set typed allocation lengths");
    Pipeline result{SDL_CreateGPUComputePipeline(device, &info), {device}};
    SDL_DestroyProperties(info.props);
    require(bool(result), "Create compute pipeline");
    // The driver must own a copy after properties and caller storage disappear.
    std::fill(lengths.begin(), lengths.end(), 0);
    return result;
}
void reject_invalid(SDL_GPUDevice* device, const std::filesystem::path& directory) {
    const auto bytes = read(directory / "scalar.msl");
    const auto attempt = [&](Sint64 count, Uint32* lengths, const char* error) {
        SDL_GPUComputePipelineCreateInfo info{};
        info.code = bytes.data();
        info.code_size = bytes.size();
        info.entrypoint = "main0";
        info.format = SDL_GPU_SHADERFORMAT_MSL;
        info.num_readwrite_storage_buffers = 1;
        info.threadcount_x = info.threadcount_y = info.threadcount_z = 1;
        info.props = SDL_CreateProperties();
        require(info.props &&
                    SDL_SetNumberProperty(
                        info.props,
                        SDL_PROP_GPU_COMPUTEPIPELINE_CREATE_METAL_THREADGROUP_MEMORY_COUNT_NUMBER,
                        count),
                "Invalid fixture properties");
        if (lengths)
            require(SDL_SetPointerProperty(
                        info.props,
                        SDL_PROP_GPU_COMPUTEPIPELINE_CREATE_METAL_THREADGROUP_MEMORY_POINTER,
                        lengths),
                    "Invalid fixture length property");
        SDL_ClearError();
        expected_error_count = 0;
        expected_error = error;
        auto* result = SDL_CreateGPUComputePipeline(device, &info);
        expected_error = nullptr;
        const std::string creation_error = SDL_GetError();
        SDL_DestroyProperties(info.props);
        require(result == nullptr, "Malformed allocations must be refused");
        require(expected_error_count == 1, "Expected exactly one allocation error");
        require(creation_error == error, "Unexpected allocation error");
        require(validation_errors == 0, "Unexpected GPU validation error");
    };
    const char* vector_error = "Invalid Metal threadgroup-memory allocation vector";
    Uint32 size = 12;
    attempt(-1, &size, vector_error);
    attempt(SDL_GPU_METAL_MAX_THREADGROUP_MEMORY_SLOTS + 1, &size, vector_error);
    attempt(1, nullptr, vector_error);
    size = SDL_MAX_UINT32;
    attempt(1, &size, "Metal threadgroup-memory allocation size overflows alignment");
    size = SDL_MAX_UINT32 - 15u;
    attempt(1, &size, "Metal threadgroup-memory allocations exceed the device limit");
}
void submit(SDL_GPUDevice* device, SDL_GPUCommandBuffer* command) {
    auto* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    require(fence, "Submit command");
    const bool done = SDL_WaitForGPUFences(device, true, &fence, 1);
    SDL_ReleaseGPUFence(device, fence);
    require(done, "Wait for GPU");
}
Buffer buffer(SDL_GPUDevice* device, SDL_GPUBufferUsageFlags usage) {
    SDL_GPUBufferCreateInfo info{};
    info.usage = usage;
    info.size = 16;
    Buffer result{SDL_CreateGPUBuffer(device, &info), {device}};
    require(bool(result), "Create buffer");
    return result;
}
Transfer transfer(SDL_GPUDevice* device, SDL_GPUTransferBufferUsage usage) {
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = usage;
    info.size = 16;
    Transfer result{SDL_CreateGPUTransferBuffer(device, &info), {device}};
    require(bool(result), "Create transfer");
    return result;
}
void exercise(SDL_GPUDevice* device, const std::filesystem::path& directory) {
    auto plain = pipeline(device, directory, "plain", 1);
    auto scalar = pipeline(device, directory, "scalar", 1);
    auto matrix8 = pipeline(device, directory, "matrix8", 4);
    auto matrix12 = pipeline(device, directory, "matrix12", 4);
    auto output = buffer(device, SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE);
    auto indirect = buffer(device, SDL_GPU_BUFFERUSAGE_INDIRECT);
    auto upload = transfer(device, SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD);
    auto download = transfer(device, SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD);
    auto* mapped = SDL_MapGPUTransferBuffer(device, upload.get(), false);
    require(mapped, "Map indirect arguments");
    const std::array<Uint32, 4> arguments{1, 1, 1, 0};
    std::memcpy(mapped, arguments.data(), sizeof(arguments));
    SDL_UnmapGPUTransferBuffer(device, upload.get());
    auto* commands = SDL_AcquireGPUCommandBuffer(device);
    auto* copy = SDL_BeginGPUCopyPass(commands);
    const SDL_GPUTransferBufferLocation from{upload.get(), 0};
    const SDL_GPUBufferRegion to{indirect.get(), 0, 16};
    SDL_UploadToGPUBuffer(copy, &from, &to, false);
    SDL_EndGPUCopyPass(copy);
    submit(device, commands);

    struct Case {
        SDL_GPUComputePipeline* program;
        Uint32 count;
        std::array<Uint32, 4> expected;
    };
    const std::array cases{
        Case{scalar.get(), 1, {12, 0, 0, 0}}, Case{matrix8.get(), 4, {9, 10, 11, 8}},
        Case{plain.get(), 1, {19, 0, 0, 0}},  Case{matrix12.get(), 4, {9, 10, 11, 8}},
        Case{scalar.get(), 1, {12, 0, 0, 0}},
    };
    for (const bool indirect_dispatch : {false, true}) {
        for (const auto& item : cases) {
            commands = SDL_AcquireGPUCommandBuffer(device);
            SDL_GPUStorageBufferReadWriteBinding binding{};
            binding.buffer = output.get();
            auto* pass = SDL_BeginGPUComputePass(commands, nullptr, 0, &binding, 1);
            require(pass, "Begin compute");
            SDL_BindGPUComputePipeline(pass, item.program);
            if (indirect_dispatch)
                SDL_DispatchGPUComputeIndirect(pass, indirect.get(), 0);
            else
                SDL_DispatchGPUCompute(pass, 1, 1, 1);
            SDL_EndGPUComputePass(pass);
            copy = SDL_BeginGPUCopyPass(commands);
            const SDL_GPUBufferRegion source{output.get(), 0, 16};
            const SDL_GPUTransferBufferLocation destination{download.get(), 0};
            SDL_DownloadFromGPUBuffer(copy, &source, &destination);
            SDL_EndGPUCopyPass(copy);
            submit(device, commands);
            const auto* values =
                static_cast<const Uint32*>(SDL_MapGPUTransferBuffer(device, download.get(), false));
            require(values, "Map result");
            for (Uint32 index = 0; index < item.count; ++index)
                require(values[index] == item.expected[index], "Workgroup memory result");
            SDL_UnmapGPUTransferBuffer(device, download.get());
        }
    }
    reject_invalid(device, directory);
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 2, "Shader directory argument");
        SDL_SetLogOutputFunction(log_message, nullptr);
        require(SDL_Init(SDL_INIT_VIDEO), "SDL video initialization");
        auto* device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_MSL, true, "metal");
        require(device, "Metal device");
        exercise(device, argv[1]);
        SDL_DestroyGPUDevice(device);
        SDL_Quit();
        require(validation_errors == 0, "Unexpected GPU validation error");
        std::puts(
            "sdl-metal-workgroup-check: direct, indirect, initialization, matrix, switching and validation passed");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
