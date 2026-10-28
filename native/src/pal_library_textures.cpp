// A lowered library's material textures and scene environment
// (library_runtime.hpp): the backend-neutral half. Each backend uploads with
// its own scene-texture routines (pal_sdl_gpu_library_textures.cpp and its
// Dawn twin); this unit keeps one upload per image and one `Texture2D` per
// material slot, as the pin's material holds one object per texture.
#include <bblite/library_runtime.hpp>

#include "pal_gpu_dispatch.hpp"
#include "pal_texture_upload_cache.hpp"

#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {
namespace {

/** The images uploaded on one engine's WebGPU device, shared by every slot reading one. */
TextureUploadCache<LibraryImage>& library_images(const Engine& engine) {
    return device_scratch<TextureUploadCache<LibraryImage>>(engine.webgpu_device);
}

const GpuBackend& library_backend(const Engine& engine) {
    const GpuBackend& backend = selected_gpu_backend();
    if (!backend.library_image || !backend.library_sampler || !backend.library_environment_views)
        throw std::runtime_error(std::string(backend.name) +
                                 " provides no lowered library textures in this build.");
    if (!engine.webgpu_device)
        throw std::logic_error("A lowered library's texture needs the engine's WebGPU device.");
    return backend;
}

/** One `Texture2D` stands for a slot while its image, encoding, sampling and transform stay. */
bool same_slot(const TextureData& left, const TextureData& right) {
    return left.srgb == right.srgb && left.sampler == right.sampler &&
           left.uv_transform == right.uv_transform && left.uv_invert_y == right.uv_invert_y &&
           same_texture_image(left, right);
}

} // namespace

std::shared_ptr<library::Texture2D> library_texture(Engine& engine, const TextureData& data,
                                                    std::shared_ptr<void>& held) {
    if (auto texture = std::static_pointer_cast<library::Texture2D>(held);
        texture && same_slot(texture->source, data))
        return texture;
    const GpuBackend& backend = library_backend(engine);
    // The fallback texel stands in for an undecodable image, as the
    // renderer's own material uploads take it.
    auto image = library_images(engine).acquire(
        data, data.srgb, library_fallback_texel, [&] { return backend.library_image(engine, data); });
    auto texture = std::make_shared<library::Texture2D>();
    texture->texture = image->texture;
    texture->view = image->texture->create_view();
    texture->sampler = backend.library_sampler(engine, data.sampler);
    texture->width = image->width;
    texture->height = image->height;
    const auto& uv = data.uv_transform;
    texture->u_scale = uv.u_scale;
    texture->v_scale = uv.v_scale;
    texture->u_offset = uv.u_offset;
    texture->v_offset = uv.v_offset;
    texture->u_ang = uv.u_ang;
    texture->invert_y = data.uv_invert_y;
    texture->source = data;
    texture->upload = image;
    // texture-acquire.ts: the creation-time reference the material holds.
    auto references = library::texture_references();
    if (!references.has(texture->texture))
        references.set(texture->texture, 1.0);
    held = texture;
    return texture;
}

LibraryEnvironmentViews library_environment_views(Engine& engine,
                                                  const EnvironmentState& environment) {
    return library_backend(engine).library_environment_views(engine, environment);
}

} // namespace bbl::pal
