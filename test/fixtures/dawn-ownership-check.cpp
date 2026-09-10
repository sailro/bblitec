#include "pal_dawn_resources.hpp"
#include <cassert>
#include <type_traits>
#include <vector>

static std::vector<int> released;
static bool fail_view = false;
static int view_calls = 0;
static int texture_refs = 0;
static int view_refs = 0;
template <typename T> T fake() { return reinterpret_cast<T>(std::uintptr_t{1}); }

void wgpuTextureRelease(WGPUTexture texture) { assert(texture); released.push_back(1); }
void wgpuTextureViewRelease(WGPUTextureView view) { assert(view); released.push_back(2); }
void wgpuSamplerRelease(WGPUSampler sampler) { assert(sampler); released.push_back(3); }
void wgpuTextureAddRef(WGPUTexture texture) { assert(texture); ++texture_refs; }
void wgpuTextureViewAddRef(WGPUTextureView view) { assert(view); ++view_refs; }
WGPUTextureView wgpuTextureCreateView(WGPUTexture texture, const WGPUTextureViewDescriptor*) {
    assert(texture);
    ++view_calls;
    return fail_view ? nullptr : fake<WGPUTextureView>();
}

int main() {
    using namespace bbl::pal;
    static_assert(!std::is_copy_constructible_v<DawnSampledTexture>);
    static_assert(std::is_nothrow_move_constructible_v<DawnSampledTexture>);
    for (int stage = 1; stage <= 3; ++stage) {
        released.clear();
        try {
            DawnSampledTexture texture;
            texture.texture = fake<WGPUTexture>();
            fail_view = stage == 1;
            texture.view = create_dawn_texture_view(texture.texture, nullptr);
            if (stage == 2) throw bbl::GpuTransportError("sampler creation failed");
            texture.sampler = fake<WGPUSampler>();
            std::vector<DawnSampledTexture> textures;
            textures.push_back(std::move(texture));
            assert(!texture.texture && !texture.view && !texture.sampler);
            throw bbl::GpuTransportError("upload failed");
        } catch (const bbl::GpuTransportError&) {}
        const std::vector<int> expected = stage == 1 ? std::vector<int>{1} :
            stage == 2 ? std::vector<int>{2, 1} : std::vector<int>{3, 2, 1};
        assert(released == expected);
    }
    const int previous_calls = view_calls;
    try {
        (void)create_dawn_texture_view(nullptr, nullptr);
        assert(false);
    } catch (const bbl::GpuTransportError&) {}
    assert(view_calls == previous_calls);
    released.clear();
    {
        DawnTexture first{fake<WGPUTexture>()};
        DawnTexture second;
        second = std::move(first);
        assert(!first && second);
        first = std::move(second);
        assert(first && !second);
        const auto borrowed = first.get();
        assert(borrowed == fake<WGPUTexture>());
        auto transferred = first.release();
        assert(!first && released.empty());
        first = transferred;
        first.reset();
        first.reset();
    }
    assert(released == std::vector<int>{1});
    released.clear();
    {
        DawnTexture color{fake<WGPUTexture>()};
        DawnTextureView view{fake<WGPUTextureView>()};
        std::vector<DawnTexture> colors;
        std::vector<DawnTextureView> views;
        colors.push_back(color.retain());
        views.push_back(view.retain());
        assert(texture_refs == 1 && view_refs == 1);
        color.reset();
        view.reset();
        assert(colors.front() && views.front());
        assert(!DawnTexture{}.retain());
        // Partial attachment creation leaves independent owning vectors.
        colors.push_back(DawnTexture{fake<WGPUTexture>()});
    }
    assert(released == (std::vector<int>{1, 2, 2, 1, 1}));
}
