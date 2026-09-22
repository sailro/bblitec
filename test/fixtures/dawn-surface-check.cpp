#include "pal_device_options.hpp"
#include "pal_gpu_backend.hpp"
#include <bblite/js_data.hpp>
#include <webgpu/webgpu.h>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using bbl::pal::DeviceOptions;
using bbl::pal::use_dawn_backend;
namespace js = bbl::js;
struct ANativeWindow {
    int references = 0;
};
struct DawnDevice {
    WGPUInstance instance = nullptr;
    WGPUDevice device = nullptr;
    WGPUSurface surface = nullptr;
    WGPUAdapter adapter = nullptr;
    void* window = nullptr;
    ANativeWindow* android_window = nullptr;
    bool surface_recovery_pending = false;
    std::string uncaptured_error;
    WGPUTextureFormat surface_format = WGPUTextureFormat_Undefined;
    WGPUPresentMode present_mode = WGPUPresentMode_Undefined;
    std::uint32_t surface_width = 0, surface_height = 0;
    void release_surface() noexcept;
};
struct OffscreenImage {
    virtual ~OffscreenImage() = default;
};
[[noreturn]] void dawn_error(const std::string& message) { throw std::runtime_error(message); }
constexpr const char* SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER = "android.window";
static ANativeWindow* native_window = nullptr;
static bool locked = false, lock_succeeds = true, create_succeeds = true;
static int live_surfaces = 0, surfaces_created = 0, configured = 0;
void* SDL_GetWindowProperties(void* window) { return window; }
bool SDL_LockProperties(void*) {
    assert(!locked);
    return locked = lock_succeeds;
}
void SDL_UnlockProperties(void*) {
    assert(locked);
    locked = false;
}
const char* SDL_GetError() { return "property lock failed"; }
void* SDL_GetPointerProperty(void*, const char*, void*) {
    assert(locked);
    return native_window;
}
void ANativeWindow_acquire(ANativeWindow* window) {
    assert(locked);
    ++window->references;
}
void ANativeWindow_release(ANativeWindow* window) {
    assert(!locked && live_surfaces == 0 && window->references > 0);
    --window->references;
}
WGPUSurface wgpuInstanceCreateSurface(WGPUInstance, const WGPUSurfaceDescriptor* descriptor) {
    assert(!locked);
    assert(descriptor->nextInChain->sType == WGPUSType_SurfaceSourceAndroidNativeWindow);
    const auto* source =
        reinterpret_cast<const WGPUSurfaceSourceAndroidNativeWindow*>(descriptor->nextInChain);
    assert(source->window == native_window && native_window->references == 1);
    if (!create_succeeds)
        return nullptr;
    ++surfaces_created;
    ++live_surfaces;
    return reinterpret_cast<WGPUSurface>(std::uintptr_t{1});
}
void wgpuSurfaceRelease(WGPUSurface) {
    assert(live_surfaces == 1);
    --live_surfaces;
}
static WGPUSurfaceConfiguration surface_configuration;
void wgpuSurfaceConfigure(WGPUSurface, const WGPUSurfaceConfiguration* configuration) {
    ++configured;
    surface_configuration = *configuration;
}
using SDL_WindowFlags = std::uint64_t;
constexpr SDL_WindowFlags SDL_WINDOW_FULLSCREEN = 1, SDL_WINDOW_VULKAN = 2,
                          SDL_WINDOW_RESIZABLE = 4;
struct EngineOptions {
    int width = 0, height = 0;
};
static std::string requested_backend;
namespace bbl::pal {
std::string environment_variable(const char*) { return requested_backend; }
} // namespace bbl::pal

static std::vector<WGPUTextureFormat> formats;
static std::vector<WGPUPresentMode> modes;
static WGPUTextureUsage usages = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
static WGPUStatus status = WGPUStatus_Success;
static int freed = 0;
WGPUStatus wgpuSurfaceGetCapabilities(WGPUSurface, WGPUAdapter,
                                      WGPUSurfaceCapabilities* capabilities) {
    capabilities->formatCount = formats.size();
    capabilities->formats = formats.data();
    capabilities->presentModeCount = modes.size();
    capabilities->presentModes = modes.data();
    capabilities->usages = usages;
    return status;
}
void wgpuSurfaceCapabilitiesFreeMembers(WGPUSurfaceCapabilities) { ++freed; }
static WGPUTextureDescriptor texture_descriptor;
WGPUTexture wgpuDeviceCreateTexture(WGPUDevice, const WGPUTextureDescriptor* descriptor) {
    texture_descriptor = *descriptor;
    return reinterpret_cast<WGPUTexture>(std::uintptr_t{1});
}
static int textures_released = 0, acquisitions = 0;
void wgpuTextureRelease(WGPUTexture) { ++textures_released; }
static WGPUSurfaceGetCurrentTextureStatus acquisition_status =
    WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal;
static bool acquisition_texture = true;
void wgpuSurfaceGetCurrentTexture(WGPUSurface, WGPUSurfaceTexture* texture) {
    ++acquisitions;
    texture->status = acquisition_status;
    texture->texture =
        acquisition_texture ? reinterpret_cast<WGPUTexture>(std::uintptr_t{1}) : nullptr;
}

#include "surface-under-test.hpp"

template <typename Action> void expect_error(Action action) {
    bool failed = false;
    try {
        action();
    } catch (const std::exception&) {
        failed = true;
    }
    assert(failed);
}

int main() {
    requested_backend = "dawn";
#if BBLITE_HAS_DAWN
    assert(use_dawn_backend());
    assert(run_window_flags(SDL_WINDOW_RESIZABLE, {}) ==
           (SDL_WINDOW_RESIZABLE | SDL_WINDOW_FULLSCREEN | SDL_WINDOW_VULKAN));
#else
    expect_error([] { use_dawn_backend(); });
#endif
    requested_backend.clear();
    assert(use_dawn_backend() == !BBLITE_HAS_SDL_GPU);
    assert(bool(run_window_flags(0, {}) & SDL_WINDOW_VULKAN) == !BBLITE_HAS_SDL_GPU);
    requested_backend = "sdl_gpu";
#if BBLITE_HAS_SDL_GPU
    assert(!use_dawn_backend());
    assert(!(run_window_flags(0, {}) & SDL_WINDOW_VULKAN));
#else
    expect_error([] { use_dawn_backend(); });
#endif
    for (const auto invalid : {"gpu", "BOTH", "invalid"}) {
        requested_backend = invalid;
        expect_error([] { use_dawn_backend(); });
    }
    DawnDevice state;
    modes = {WGPUPresentMode_Fifo, WGPUPresentMode_Immediate};
    formats = {WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_BGRA8Unorm};
    select_dawn_surface_configuration(state, {});
    assert(state.surface_format == WGPUTextureFormat_BGRA8Unorm);
    assert(state.present_mode == WGPUPresentMode_Fifo && freed == 1);
    DeviceOptions immediate;
    immediate.immediate_present = true;
    formats = {WGPUTextureFormat_RGBA8Unorm};
    select_dawn_surface_configuration(state, immediate);
    assert(state.surface_format == WGPUTextureFormat_RGBA8Unorm);
    assert(state.present_mode == WGPUPresentMode_Immediate && freed == 2);
    modes = {WGPUPresentMode_Fifo};
    select_dawn_surface_configuration(state, immediate);
    assert(state.present_mode == WGPUPresentMode_Fifo && freed == 3);
    for (const auto format : {WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_BGRA8Unorm}) {
        DawnOffscreenImage image(nullptr, format, 321, 123);
        assert(texture_descriptor.format == format);
        assert(texture_descriptor.size.width == 321 && texture_descriptor.size.height == 123);
        assert(texture_descriptor.usage & WGPUTextureUsage_TextureBinding);
    }
    usages = WGPUTextureUsage_RenderAttachment;
    expect_error([&] { select_dawn_surface_configuration(state, {}); });
    assert(freed == 4);
    usages |= WGPUTextureUsage_CopySrc;
    for (const auto supported :
         {std::vector<WGPUTextureFormat>{}, {WGPUTextureFormat_RGBA16Float}}) {
        formats = supported;
        expect_error([&] { select_dawn_surface_configuration(state, {}); });
    }
    assert(freed == 6);
    status = WGPUStatus_Error;
    expect_error([&] { select_dawn_surface_configuration(state, {}); });
    state.surface_format = WGPUTextureFormat_RGBA8Unorm;
    state.present_mode = WGPUPresentMode_Fifo;
    state.device = reinterpret_cast<WGPUDevice>(std::uintptr_t{1});
    ANativeWindow first, second;
    state.window = &state;
    native_window = &first;
    assert(resize_dawn_surface(state, 1280, 720));
    assert(first.references == 1 && surfaces_created == 1 && configured == 1);
    assert(!resize_dawn_surface(state, 1280, 720));
    assert(first.references == 1 && surfaces_created == 1 && configured == 1);
    native_window = &second;
    assert(!resize_dawn_surface(state, 1280, 720));
    assert(first.references == 0 && second.references == 1 && surfaces_created == 2 &&
           configured == 2);
    assert(resize_dawn_surface(state, 960, 540));
    assert(surfaces_created == 2 && configured == 3);
    assert(surface_configuration.width == 960 && surface_configuration.height == 540);
    assert(surface_configuration.format == WGPUTextureFormat_RGBA8Unorm);
    assert(surface_configuration.device == state.device);
    assert(!resize_dawn_surface(state, EngineOptions{0, 540}));
    WGPUSurfaceTexture acquired = WGPU_SURFACE_TEXTURE_INIT;
    for (const auto success : {WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal,
                               WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal}) {
        acquisition_status = success;
        assert(acquire_dawn_surface_texture(state, acquired));
        wgpuTextureRelease(acquired.texture);
    }
    for (const auto retry : {WGPUSurfaceGetCurrentTextureStatus_Timeout,
                             WGPUSurfaceGetCurrentTextureStatus_Outdated}) {
        acquisition_status = retry;
        const int released = textures_released;
        assert(!acquire_dawn_surface_texture(state, acquired));
        assert(!acquired.texture && textures_released == released + 1);
        assert(live_surfaces == 1 && second.references == 1);
    }
    acquisition_status = WGPUSurfaceGetCurrentTextureStatus_Lost;
    assert(!acquire_dawn_surface_texture(state, acquired));
    assert(!state.surface && second.references == 0 && state.surface_recovery_pending);
    assert(!resize_dawn_surface(state, 960, 540));
    expect_error([&] { acquire_dawn_surface_texture(state, acquired); });
    assert(live_surfaces == 1 && second.references == 1);
    acquisition_status = WGPUSurfaceGetCurrentTextureStatus_Error;
    expect_error([&] { acquire_dawn_surface_texture(state, acquired); });
    acquisition_status = WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal;
    acquisition_texture = false;
    expect_error([&] { acquire_dawn_surface_texture(state, acquired); });
    acquisition_texture = true;
    assert(acquire_dawn_surface_texture(state, acquired));
    wgpuTextureRelease(acquired.texture);
    assert(!state.surface_recovery_pending);
    native_window = nullptr;
    assert(!resize_dawn_surface(state, 1280, 720));
    assert(second.references == 0 && live_surfaces == 0 && !locked && state.surface_width == 960);
    const int previous_acquisitions = acquisitions;
    assert(!acquire_dawn_surface_texture(state, acquired));
    assert(acquisitions == previous_acquisitions);
    native_window = &second;
    assert(resize_dawn_surface(state, 1280, 720));
    lock_succeeds = false;
    expect_error([&] { refresh_dawn_android_surface(state); });
    assert(!locked);
    lock_succeeds = true;
    native_window = &first;
    create_succeeds = false;
    expect_error([&] { refresh_dawn_android_surface(state); });
    assert(second.references == 0 && first.references == 1 && !state.surface);
    state.release_surface();
    state.release_surface();
    assert(first.references == 0 && live_surfaces == 0);
    state.window = nullptr;
    assert(!refresh_dawn_android_surface(state));
}
