#include "pal_sdl_gpu_resources.hpp"
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
    try {
        OwnedSdlBuffer first{fake<SDL_GPUBuffer*>(), {fake<SDL_GPUDevice*>()}};
        ++buffers;
        auto second = std::move(first);
        assert(!first && second);
        throw std::runtime_error("second geometry upload failed");
    } catch (const std::runtime_error&) {}
    assert(buffers == 0);
}
