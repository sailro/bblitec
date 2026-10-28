// A lowered library's material images, samplers and scene environment on
// the engine's Dawn WebGPU-subset device, uploaded by the scene renderer's
// own texture routines (pal_dawn_scene_textures.cpp) and adopted as subset
// objects. SDL_GPU's twin is pal_sdl_gpu_library_textures.cpp.
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/library_runtime.hpp>
#include "pal_gpu_backend.hpp"

#include "pal_dawn_scene.hpp"
#include "pal_dawn_webgpu.hpp"

#include <stdexcept>
#include <vector>

namespace bbl::pal {
#if BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER
namespace {

DawnWebGpuOwner& library_device(const Engine& engine) {
    auto* device = dynamic_cast<DawnWebGpuDevice*>(engine.webgpu_device.get());
    if (!device)
        throw std::logic_error("A lowered library's texture needs the engine's Dawn device.");
    return *device->owner;
}

/** The mip generator a device's library uploads share, released with the device. */
DawnMipGenerator& library_mips(DawnWebGpuOwner& owner) {
    return device_scratch<DawnMipGenerator>(owner.shared_from_this());
}

/** A sampled texture the renderer's upload made, as the subset's `GPUTexture`. */
std::shared_ptr<DawnWebGpuTexture> adopt_texture(DawnWebGpuOwner& owner, WGPUTexture texture,
                                                 const char* what) {
    auto adopted = std::make_shared<DawnWebGpuTexture>();
    adopted->owner = owner.shared_from_this();
    adopted->lease = owner.adopt<DawnWebGpuTextureLease>(texture, what);
    adopted->usage = webgpu_texture_usage::texture_binding;
    return adopted;
}

/** A view of `texture` the subset binds, keeping the texture alive. */
std::shared_ptr<DawnWebGpuView> adopt_view(DawnWebGpuOwner& owner,
                                           const std::shared_ptr<DawnWebGpuTexture>& texture,
                                           const WGPUTextureViewDescriptor* descriptor) {
    auto view = std::make_shared<DawnWebGpuView>();
    view->texture = texture->lease;
    view->lease = owner.adopt<DawnWebGpuViewLease>(
        create_dawn_texture_view(texture->lease->get(), descriptor), "library texture view");
    return view;
}

} // namespace

LibraryImage dawn_library_image(Engine& engine, const TextureData& data) {
    auto& owner = library_device(engine);
    std::uint32_t mip_count = 1;
    const auto texture =
        adopt_texture(owner,
                      upload_material_texture(owner.live_device(), owner.queue, library_mips(owner),
                                              data, data.srgb, library_fallback_texel, mip_count),
                      "library material image");
    return {texture, static_cast<double>(wgpuTextureGetWidth(texture->lease->get())),
            static_cast<double>(wgpuTextureGetHeight(texture->lease->get()))};
}

std::shared_ptr<GpuObject> dawn_library_sampler(Engine& engine,
                                                const TextureSamplerState& sampler) {
    auto& owner = library_device(engine);
    auto adopted = std::make_shared<DawnWebGpuSampler>();
    adopted->lease = owner.adopt<DawnWebGpuSamplerLease>(
        create_texture_sampler(owner.live_device(), sampler), "library material sampler");
    return adopted;
}

LibraryEnvironmentViews dawn_library_environment_views(Engine& engine,
                                                       const EnvironmentState& environment) {
    auto& owner = library_device(engine);
    auto* cube_texture = create_environment_texture(owner.live_device(), owner.queue, environment);
    if (!cube_texture)
        throw std::logic_error("A scene environment without a specular cube has no textures.");
    const auto cube = adopt_texture(owner, cube_texture, "library environment cube");
    const auto brdf =
        adopt_texture(owner, create_brdf_texture(owner.live_device(), owner.queue, environment),
                      "library BRDF LUT");
    // env-helpers.ts: `specularCube.createView({ dimension: "cube" })`.
    WGPUTextureViewDescriptor cube_view = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    cube_view.dimension = WGPUTextureViewDimension_Cube;
    cube_view.arrayLayerCount = 6;
    return {adopt_view(owner, cube, &cube_view), adopt_view(owner, brdf, nullptr)};
}
#endif
} // namespace bbl::pal
