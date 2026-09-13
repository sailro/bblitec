#include "pal_sdl_gpu_resources.hpp"
#include "pal_texture_upload_cache.hpp"
#include <cassert>
#include <cstdint>
#include <stdexcept>
#include <type_traits>

static int textures = 0;
static int samplers = 0;
static int buffers = 0;
template <typename T> T fake() { return reinterpret_cast<T>(std::uintptr_t{1}); }
void SDL_ReleaseGPUTexture(SDL_GPUDevice* device, SDL_GPUTexture* texture) {
    assert(device && texture); --textures;
}
void SDL_ReleaseGPUSampler(SDL_GPUDevice* device, SDL_GPUSampler* sampler) {
    assert(device && sampler); --samplers;
}
void SDL_ReleaseGPUBuffer(SDL_GPUDevice* device, SDL_GPUBuffer* buffer) {
    assert(device && buffer); --buffers;
}

int main() {
    using namespace bbl::pal;
    static_assert(!std::is_copy_constructible_v<SdlSampledTextures>);
    for (int failure = 0; failure < 6; ++failure) {
        try {
            auto material = std::make_unique<SdlSampledTextures>(fake<SDL_GPUDevice*>());
            for (int allocation = 0; allocation < 6; ++allocation) {
                if (allocation % 2 == 0) material->bindings.emplace_back();
                auto& binding = material->bindings.back();
                if (allocation == failure) throw std::runtime_error("GPU allocation failed");
                if (allocation % 2 == 0) {
                    binding.texture = fake<SDL_GPUTexture*>(); ++textures;
                } else {
                    binding.sampler = fake<SDL_GPUSampler*>(); ++samplers;
                }
            }
        } catch (const std::runtime_error&) {}
        assert(textures == 0 && samplers == 0);
    }
    {
        std::vector<std::unique_ptr<SdlSampledTextures>> cache;
        auto material = std::make_unique<SdlSampledTextures>(fake<SDL_GPUDevice*>());
        material->bindings.push_back({fake<SDL_GPUTexture*>(), fake<SDL_GPUSampler*>()});
        ++textures; ++samplers;
        cache.push_back(std::move(material));
        assert(!material && textures == 1 && samplers == 1);
        cache.front()->clear();
        cache.front()->clear();
    }
    assert(textures == 0 && samplers == 0);
    {
        TextureUploadCache<OwnedSdlTexture> images;
        bbl::TextureData atlas;
        atlas.bytes = bbl::SharedTextureBytes::Storage{1, 2, 3, 4};
        atlas.rgba_width = atlas.rgba_height = 1;
        int uploads = 0;
        const auto upload = [&] {
            ++uploads; ++textures;
            return OwnedSdlTexture{fake<SDL_GPUTexture*>(), {fake<SDL_GPUDevice*>()}};
        };
        const auto acquire = [&](const bbl::TextureData& source, bool srgb = false) {
            return images.acquire(source, srgb, {255, 255, 255, 255}, upload);
        };
        auto first = acquire(atlas);
        auto second_source = atlas;
        second_source.sampler.max_lod = 0;
        auto second = acquire(second_source);
        assert(first == second && uploads == 1);
        auto srgb = acquire(atlas, true);
        assert(srgb != first && uploads == 2);
        second_source.bytes[0] = 9;
        auto changed = acquire(second_source);
        assert(changed != first && uploads == 3);
        assert(acquire(atlas) == first);
        auto flipped = atlas;
        flipped.invert_y = !atlas.invert_y;
        auto flip_image = acquire(flipped);
        assert(flip_image != first);
        SdlSampledTextures a{fake<SDL_GPUDevice*>()}, b{fake<SDL_GPUDevice*>()};
        a.append_shared_texture(first).sampler = fake<SDL_GPUSampler*>(); ++samplers;
        // A generated/CSM slot can sit between shared image bindings.
        a.bindings.push_back({fake<SDL_GPUTexture*>(), nullptr}); ++textures;
        a.append_shared_texture(first);
        b.append_shared_texture(second).sampler = fake<SDL_GPUSampler*>(); ++samplers;
        first.reset(); second.reset(); srgb.reset(); changed.reset(); flip_image.reset();
        assert(textures == 2);
        a.clear(); a.clear();
        assert(textures == 1 && samplers == 1);
        b.clear();
        assert(textures == 0 && samplers == 0);
        images.prune();
        auto fresh = acquire(atlas);
        assert(uploads == 5 && textures == 1);
        auto resized = atlas;
        resized.rgba_width = 2;
        assert(acquire(resized) != fresh);
        auto premultiplied = atlas;
        premultiplied.premultiply_alpha = !atlas.premultiply_alpha;
        assert(acquire(premultiplied) != fresh);
        bbl::TextureData blocks;
        blocks.compressed.storage = std::make_shared<const std::vector<std::uint8_t>>(16, std::uint8_t{0});
        blocks.compressed.format = "bc1-rgba-unorm";
        blocks.compressed.width = blocks.compressed.height = 4;
        blocks.compressed.block_width = blocks.compressed.block_height = 4;
        blocks.compressed.block_bytes = 8;
        blocks.compressed.mips.push_back({4, 4, std::span<const std::uint8_t>(*blocks.compressed.storage).first(8)});
        auto compressed = acquire(blocks);
        auto other_blocks = blocks;
        assert(acquire(other_blocks) == compressed);
        other_blocks.compressed.mips[0].bytes = std::span<const std::uint8_t>(*blocks.compressed.storage).subspan(8);
        assert(acquire(other_blocks) != compressed);
        other_blocks = blocks;
        other_blocks.compressed.format = "bc1-rgba-unorm-srgb";
        assert(acquire(other_blocks) != compressed);
    }
    assert(textures == 0 && samplers == 0);
    try {
        OwnedSdlBuffer first{fake<SDL_GPUBuffer*>(), {fake<SDL_GPUDevice*>()}};
        ++buffers;
        auto second = std::move(first);
        assert(!first && second);
        throw std::runtime_error("second geometry upload failed");
    } catch (const std::runtime_error&) {}
    assert(buffers == 0);
}
