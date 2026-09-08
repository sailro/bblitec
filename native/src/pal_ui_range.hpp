#pragma once
// Browser control geometry/palette adapted from Chromium 152.0.7977.76
// (ui/native_theme/native_theme_base.cc, ui/color/color_provider_utils.cc).
// BSD-3-Clause notice: native/notices/Chromium.txt.
#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/ComputedValues.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Decorator.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <tuple>
#include <vector>

namespace bbl::pal {
// Chromium 152 NativeThemeBase::PaintSliderTrack/PaintSliderThumb and the
// default light control palette. RmlUi still owns slider layout and input.
class UiRangeDecorator final : public Rml::Decorator {
    struct Data {
        std::tuple<int, int, float, int, float> key{};
        Rml::CallbackTexture texture;
        Rml::Geometry geometry;
        bool initialized = false;
    };
    // Pixel coverage of an axis-aligned rounded rectangle. Integrate the
    // horizontal circle interval; full interior pixels take the fast path.
    static float coverage(int x, int y, float left, float top, float right, float bottom, float radius) {
        if (x + 1 <= left || x >= right || y + 1 <= top || y >= bottom) return 0;
        radius = std::min(radius, std::min(right - left, bottom - top) * .5f);
        if (x >= left && x + 1 <= right && y >= top && y + 1 <= bottom &&
            ((x >= left + radius && x + 1 <= right - radius) || (y >= top + radius && y + 1 <= bottom - radius))) return 1;
        float area = 0;
        constexpr int samples = 64;
        for (int row = 0; row < samples; ++row) {
            const float py = y + (row + .5f) / samples;
            if (py < top || py >= bottom) continue;
            const float dy = std::max({top + radius - py, py - (bottom - radius), 0.f});
            const float inset = radius - std::sqrt(std::max(radius * radius - dy * dy, 0.f));
            area += std::max(0.f, std::min(x + 1.f, right - inset) - std::max(static_cast<float>(x), left + inset));
        }
        return area / samples;
    }
    static std::vector<Rml::byte> pixels(int width, int height, float thumb, int state) {
        const std::array<unsigned, 3> accent = state == 3 ? std::array<unsigned,3>{203,203,203}
            : state == 2 ? std::array<unsigned,3>{55,147,255} : state == 1 ? std::array<unsigned,3>{0,92,200} : std::array<unsigned,3>{0,117,255};
        const unsigned fill = state == 1 ? 229 : state == 2 ? 245 : 239;
        const unsigned border = state == 1 ? 79 : state == 2 ? 141 : 118;
        const float center = height * .5f, track_top = center - 4, track_bottom = center + 4;
        std::vector<Rml::byte> result(static_cast<std::size_t>(width) * height * 4);
        for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
            std::array<float,4> color{};
            const auto over = [&](const std::array<unsigned,3>& rgb, float alpha) {
                for (unsigned channel = 0; channel < 3; ++channel) color[channel] = rgb[channel] * alpha + color[channel] * (1 - alpha);
                color[3] = 255 * alpha + color[3] * (1 - alpha);
            };
            const float outer = coverage(x, y, 1, track_top, width - 1.f, track_bottom, 4);
            over({fill,fill,fill}, outer * (state == 3 ? 77.f / 255.f : 1.f));
            over(accent, outer * std::clamp(thumb + 4 - x, 0.f, 1.f));
            const float inner = coverage(x, y, 2, track_top + 1, width - 2.f, track_bottom - 1, 3);
            over({border,border,border}, (outer - inner) * 128.f / 255.f);
            over(accent, coverage(x, y, thumb - 7.5f, center - 7.5f, thumb + 7.5f, center + 7.5f, 7.5f));
            for (unsigned channel = 0; channel < 4; ++channel)
                result[(static_cast<std::size_t>(y) * width + x) * 4 + channel] = static_cast<Rml::byte>(std::clamp(std::lround(color[channel]), 0l, 255l));
        }
        return result;
    }
public:
    Rml::DecoratorDataHandle GenerateElementData(Rml::Element*, Rml::BoxArea) const override { return reinterpret_cast<Rml::DecoratorDataHandle>(new Data{}); }
    void ReleaseElementData(Rml::DecoratorDataHandle value) const override { delete reinterpret_cast<Data*>(value); }
    void RenderElement(Rml::Element* element, Rml::DecoratorDataHandle value) const override {
        auto& data = *reinterpret_cast<Data*>(value);
        Rml::Element* bar = nullptr;
        for (int child = 0; child < element->GetNumChildren(true); ++child)
            if (element->GetChild(child)->GetTagName() == "sliderbar") { bar = element->GetChild(child); break; }
        if (!bar) return;
        const auto origin = element->GetAbsoluteOffset(Rml::BoxArea::Content);
        const auto size = element->GetBox().GetSize(Rml::BoxArea::Content);
        const int width = static_cast<int>(std::lround(size.x)), height = static_cast<int>(std::lround(size.y));
        if (width <= 0 || height <= 0) return;
        const float thumb = bar->GetAbsoluteOffset(Rml::BoxArea::Border).x - origin.x + bar->GetBox().GetSize(Rml::BoxArea::Border).x * .5f;
        const int state = element->IsPseudoClassSet("disabled") ? 3 : element->IsPseudoClassSet("active") ? 2 : element->IsPseudoClassSet("hover") ? 1 : 0;
        const float opacity = element->GetComputedValues().opacity();
        const auto key = std::tuple{width, height, thumb, state, opacity};
        if (!data.initialized || key != data.key) {
            auto& manager = element->GetContext()->GetRenderManager();
            data.texture = manager.MakeCallbackTexture([bytes = pixels(width, height, thumb, state), width, height](const Rml::CallbackTextureInterface& out) {
                return out.GenerateTexture(bytes, {width, height});
            });
            Rml::Mesh mesh;
            Rml::MeshUtilities::GenerateQuad(mesh, {0,0}, {static_cast<float>(width),static_cast<float>(height)}, Rml::Colourb{255,255,255}.ToPremultiplied(opacity), {0,0}, {1,1});
            data.geometry = manager.MakeGeometry(std::move(mesh));
            data.key = key; data.initialized = true;
        }
        data.geometry.Render(origin, data.texture);
    }
};
class UiRangeDecoratorInstancer final : public Rml::DecoratorInstancer {
public:
    Rml::SharedPtr<Rml::Decorator> InstanceDecorator(const Rml::String&, const Rml::PropertyDictionary&, const Rml::DecoratorInstancerInterface&) override {
        return Rml::MakeShared<UiRangeDecorator>();
    }
};
} // namespace bbl::pal
