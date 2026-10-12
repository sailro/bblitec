// The splat-stream GPU work on an SDL_GPU device through `SdlWebGpuDevice`, with the
// pinned WGSL compiled by the offline shader compiler (BBLITE_GPU_SHADER_DIR).

#include "pal_sdl_gpu_webgpu.hpp"
#include "stream-checks.hpp"

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

namespace {

std::atomic<int> sdl_errors = 0;
void SDLCALL log_message(void*, int, SDL_LogPriority priority, const char* message) {
    std::fprintf(stderr, "SDL: %s\n", message);
    if (priority >= SDL_LOG_PRIORITY_ERROR)
        ++sdl_errors;
}

/** The generation-compiled stages, named `<module>.<entry point>.<stage>`. */
std::vector<bbl::pal::SdlWgslStage> compiled_stages(const stream_check::Shaders& shaders) {
    std::vector<bbl::pal::SdlWgslStage> stages;
    const auto add = [&](const char* module, const std::string& code,
                         std::initializer_list<const char*> entries, const char* kind) {
        for (const char* entry : entries)
            stages.push_back(
                {code, entry, std::string("splat-stream-") + module + "." + entry + "." + kind});
    };
    add("compact", shaders.compact, {"scanMain", "addMain", "setupMain", "scatterMain"}, "comp");
    add("gather", shaders.gather, {"main"}, "comp");
    add("project", shaders.project, {"main"}, "comp");
    add("radix", shaders.radix,
        {"histogramMain", "scanMain", "addMain", "basesMain", "scatterMain"}, "comp");
    add("render", shaders.render, {"vs"}, "vert");
    add("render", shaders.render, {"fs"}, "frag");
    return stages;
}

bbl::js::Promise<bbl::js::PromiseVoid> run(bbl::GpuDevice& device,
                                           const stream_check::Shaders& shaders,
                                           const bbl::GpuSupportedLimits& limits) {
    stream_check::check_limits(device, limits);
    co_await stream_check::check_mapping(device);
    const auto pipelines = stream_check::create_pipelines(device, shaders);
    co_await stream_check::check_sort(device, pipelines, 70000, 69123, 0x13579bdfu);
    co_await stream_check::check_projection(device, pipelines);
    co_await stream_check::check_gather(device, pipelines);
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
                auto device = std::make_shared<bbl::pal::SdlWebGpuDevice>(native, limits,
                                                                          compiled_stages(shaders));
                run(*device, shaders, limits)
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
