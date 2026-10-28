// A lowered library's material images, samplers and scene environment on
// the engine's SDL_GPU WebGPU-subset device, uploaded by the scene
// renderer's own texture routines (pal_sdl_gpu_scene_textures.cpp) and
// adopted as subset objects. Dawn's twin is pal_dawn_library_textures.cpp.
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/library_runtime.hpp>
#include "pal_gpu_backend.hpp"

#include "pal_sdl_gpu_scene.hpp"
#include "pal_sdl_gpu_webgpu.hpp"

#include <stdexcept>

namespace bbl::pal {
#if BBLITE_HAS_PBR_RENDERER
namespace {

SdlWebGpuOwner& library_device(const Engine& engine) {
    auto* device = dynamic_cast<SdlWebGpuDevice*>(engine.webgpu_device.get());
    if (!device)
        throw std::logic_error("A lowered library's texture needs the engine's SDL_GPU device.");
    return *device->owner;
}

/** A sampled texture the renderer's upload made, as the subset's `GPUTexture`. */
std::shared_ptr<SdlWebGpuTexture> adopt_texture(SdlWebGpuOwner& owner, SDL_GPUTexture* texture,
                                                std::uint32_t width, std::uint32_t height,
                                                const char* what) {
    auto adopted = std::make_shared<SdlWebGpuTexture>();
    adopted->owner = owner.shared_from_this();
    adopted->lease = owner.adopt<SdlWebGpuTextureLease>(texture, what);
    adopted->usage = webgpu_texture_usage::texture_binding;
    adopted->width = width;
    adopted->height = height;
    return adopted;
}

} // namespace

LibraryImage sdl_gpu_library_image(Engine& engine, const TextureData& data) {
    auto& owner = library_device(engine);
    std::array<std::uint32_t, 2> size{};
    auto* texture =
        upload_texture(owner.live_device(), data, data.srgb, library_fallback_texel, &size);
    return {adopt_texture(owner, texture, size[0], size[1], "library material image"),
            static_cast<double>(size[0]), static_cast<double>(size[1])};
}

std::shared_ptr<GpuObject> sdl_gpu_library_sampler(Engine& engine,
                                                   const TextureSamplerState& sampler) {
    auto& owner = library_device(engine);
    auto adopted = std::make_shared<SdlWebGpuSampler>();
    adopted->lease = owner.adopt<SdlWebGpuSamplerLease>(
        create_texture_sampler(owner.live_device(), sampler), "library material sampler");
    return adopted;
}

LibraryEnvironmentViews sdl_gpu_library_environment_views(Engine& engine,
                                                          const EnvironmentState& environment) {
    auto& owner = library_device(engine);
    auto* device = owner.live_device();
    // SDL_GPU binds whole textures, so the cube texture's view is its cube.
    const auto cube =
        adopt_texture(owner, upload_environment(device, environment, 6, false, nullptr), 0, 0,
                      "library environment cube");
    const auto brdf =
        adopt_texture(owner, upload_brdf_lut(device, environment), 0, 0, "library BRDF LUT");
    return {cube->create_view(), brdf->create_view()};
}
#endif
} // namespace bbl::pal
