#pragma once

#include "pal_gpu_targets.hpp"
#include "pal_texture_upload_cache.hpp"

namespace bbl::pal {

/** Images owned by one effect pass; render targets remain borrowed at draw time. */
template <typename Image> class EffectTextureImages {
    enum class Kind { solid, pixels, render };
    struct Binding {
        std::uint32_t binding = 0;
        std::size_t position = 0;
        Kind kind = Kind::solid;
        std::uint64_t identity = 0;
        std::array<std::uint8_t, 4> solid{};
        std::shared_ptr<Image> image;
    };
    std::vector<Binding> bindings_;
    TextureUploadCache<Image> images_;

    static Kind kind(const EffectTextureSlot& slot) {
        return slot.render_texture   ? Kind::render
               : slot.pixels_texture ? Kind::pixels
                                     : Kind::solid;
    }

    template <typename Upload>
    std::shared_ptr<Image> acquire(const EffectTextureSlot& slot, Upload upload) {
        if (slot.render_texture)
            return {};
        if (slot.pixels_texture) {
            const TextureData source = pixels_texture_data(*slot.pixels_texture);
            return images_.acquire(source, source.srgb, {}, [&] { return upload(slot); });
        }
        return images_.acquire({}, false, slot.texture.texel, [&] { return upload(slot); });
    }

public:
    template <typename Upload>
    std::shared_ptr<Image> add(const EffectTextureSlot& slot, std::size_t position, Upload upload) {
        Binding binding{slot.binding,       position,
                        kind(slot),         slot.pixels_texture ? slot.pixels_texture->identity : 0,
                        slot.texture.texel, acquire(slot, upload)};
        bindings_.push_back(binding);
        return binding.image;
    }

    template <typename Upload, typename Rebind>
    void refresh(const EffectWrapperRecord& wrapper, Upload upload, Rebind rebind) {
        for (auto& binding : bindings_) {
            const auto& slot = effect_texture_slot(wrapper, binding.binding);
            const Kind current = kind(slot);
            const auto identity = slot.pixels_texture ? slot.pixels_texture->identity : 0;
            if (current == binding.kind &&
                (current == Kind::render ||
                 (current == Kind::pixels && identity == binding.identity) ||
                 (current == Kind::solid && slot.texture.texel == binding.solid)))
                continue;
            auto image = acquire(slot, upload);
            rebind(binding.position, slot, image);
            binding.image = std::move(image);
            binding.kind = current;
            binding.identity = identity;
            binding.solid = slot.texture.texel;
        }
    }

    template <typename Write> void upload_writes(Write write) {
        images_.upload_pixels_writes(write);
    }

    template <typename Release> void release_bindings(Release release) const {
        for (const auto& binding : bindings_)
            release(binding.position);
    }
};

} // namespace bbl::pal
