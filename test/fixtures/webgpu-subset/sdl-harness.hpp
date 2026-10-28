#pragma once

// An SDL_GPU device for the WebGPU-subset fixtures, the PAL services its
// shader loader reads (the pinned stages compiled under the names
// `wgsl_stage_stem` gives them, BBLITE_GPU_SHADER_DIR), and the realm thread
// their checks run on over an `SdlWebGpuDevice`.

#include "fixture-files.hpp"
#include "fixture-require.hpp"
#include "pal_sdl_gpu_webgpu.hpp"

#include <bblite/js_realm_state.hpp>

#include <SDL3/SDL.h>

#include <atomic>
#include <cstdio>
#include <thread>

namespace bbl::pal {
// The PAL file services the shader loaders read through.
std::string join_path(const std::string& root, const std::string& relative_path) {
    return root + "/" + relative_path;
}
std::string executable_directory() { return "."; }
std::string environment_variable(const char* name) {
    const char* value = SDL_getenv(name);
    return value ? value : "";
}
} // namespace bbl::pal

namespace webgpu_fixture {

inline std::atomic<int> sdl_errors = 0;
inline void SDLCALL log_message(void*, int, SDL_LogPriority priority, const char* message) {
    std::fprintf(stderr, "SDL: %s\n", message);
    if (priority >= SDL_LOG_PRIORITY_ERROR)
        ++sdl_errors;
}

/**
 * Runs `checks(device, native)` on its own realm thread (the library's realm
 * state ends with that thread, before the device does), then reports SDL's
 * errors; prints `<label> ok` and returns 0 when all held.
 */
template <class Checks>
int run_sdl(const bbl::GpuSupportedLimits& limits, Checks checks, const char* label) {
    try {
        SDL_SetLogOutputFunction(log_message, nullptr);
        require(SDL_Init(SDL_INIT_VIDEO), "SDL_Init");
        SDL_GPUDevice* native = bbl::pal::create_compiled_shader_device(true);
        require(native != nullptr, "SDL_CreateGPUDevice");
        std::exception_ptr failure;
        std::thread([&] {
            try {
                const bbl::js::RealmScope realm;
                bbl::pal::EventLoop loop;
                loop.run([&] {
                    auto device = std::make_shared<bbl::pal::SdlWebGpuDevice>(native, limits);
                    checks(device, native)
                        .then([device, &loop](const bbl::js::PromiseVoid&) { loop.close(); },
                              [device, &loop, &failure](std::exception_ptr error) {
                                  failure = error;
                                  loop.close();
                              });
                });
            } catch (...) {
                failure = std::current_exception();
            }
        }).join();
        SDL_WaitForGPUIdle(native);
        SDL_DestroyGPUDevice(native);
        SDL_Quit();
        if (failure)
            std::rethrow_exception(failure);
        require(sdl_errors == 0, "SDL reported errors");
        std::printf("%s ok\n", label);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

} // namespace webgpu_fixture
