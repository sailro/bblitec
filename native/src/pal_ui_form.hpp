#pragma once
#include <bblite/pal_system_fonts.hpp>
#include "pal_file_io.hpp"
#include "pal_ui_coverage.hpp"
#include <RmlUi/Core/Elements/ElementFormControl.h>
#include <RmlUi/Core/Elements/ElementFormControlSelect.h>
#include <RmlUi/Core/ElementText.h>
#include <RmlUi/Core/ElementUtilities.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Core.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/FontMetrics.h>
#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/Decorator.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <cmath>
#include <map>
#include <optional>
#include <tuple>
#include <vector>

namespace bbl::pal {
// RmlUi otherwise treats HTML buttons as generic elements. Reuse its form
// control behavior for disabled focus, input activation and pseudo-classes.
class UiButtonElement : public Rml::ElementFormControl {
public:
    explicit UiButtonElement(const Rml::String& tag) : ElementFormControl(tag) {}
    Rml::String GetValue() const override { return GetAttribute<Rml::String>("value", ""); }
    void SetValue(const Rml::String& value) override { SetAttribute("value", value); }
};

// Chromium 152's menulist box, measured in the capture browser: inside the CSS
// padding, an internal inset of 4px before the longest option label (its width
// rounded up), 16px after it holding the arrow, and 1px above and below the
// font's normal line height, whatever its line-height. RmlUi's default
// replacement box is an arbitrary 128px and cannot size an auto grid track.
inline constexpr float ui_select_inset_start = 4.f, ui_select_inset_end = 16.f,
                       ui_select_inset_block = 1.f;
// The arrow is centered 9px left of the border box's right edge, on its
// rounded-down vertical middle.
inline constexpr float ui_select_arrow_from_right = 9.f;

class UiSelectElement final : public Rml::ElementFormControlSelect {
    static void append_text(Rml::Element& element, Rml::String& output) {
        if (const auto* text = rmlui_dynamic_cast<Rml::ElementText*>(&element))
            output += text->GetText();
        for (int index = 0; index < element.GetNumChildren(); ++index)
            append_text(*element.GetChild(index), output);
    }

public:
    explicit UiSelectElement(const Rml::String& tag) : ElementFormControlSelect(tag) {}
    bool GetIntrinsicDimensions(Rml::Vector2f& dimensions, float& ratio) override {
        float label_width = 0;
        for (int index = 0; index < GetNumOptions(); ++index) {
            Rml::String text;
            append_text(*GetOption(index), text);
            label_width = std::max(
                label_width, static_cast<float>(Rml::ElementUtilities::GetStringWidth(this, text)));
        }
        const float density = Rml::ElementUtilities::GetDensityIndependentPixelRatio(this);
        const auto face = GetFontFaceHandle();
        const float line = face ? Rml::GetFontEngineInterface()->GetFontMetrics(face).line_spacing
                                : GetLineHeight();
        dimensions = {std::ceil(label_width / density) * density +
                          (ui_select_inset_start + ui_select_inset_end) * density,
                      line + 2.f * ui_select_inset_block * density};
        ratio = -1.f;
        return true;
    }

protected:
    void OnLayout() override {
        ElementFormControlSelect::OnLayout();
        if (auto* arrow = GetChild(0)) {
            const float density = Rml::ElementUtilities::GetDensityIndependentPixelRatio(this);
            const auto size = GetBox().GetSize(Rml::BoxArea::Border);
            const auto arrow_size = arrow->GetBox().GetSize(Rml::BoxArea::Border);
            const Rml::Vector2f center{size.x - ui_select_arrow_from_right * density,
                                       std::floor(size.y / density * .5f) * density};
            arrow->SetOffset(center - arrow_size * .5f, this);
        }
    }
    void OnRender() override {
        ElementFormControlSelect::OnRender();
        // RmlUi formats selectvalue against the entire border box. Keep its
        // text inside the content area's internal inset, before the arrow.
        if (auto* value = GetChild(1)) {
            const float density = Rml::ElementUtilities::GetDensityIndependentPixelRatio(this);
            const auto content = GetBox().GetSize(Rml::BoxArea::Content);
            const float available =
                std::max(0.f, content.x - (ui_select_inset_start + ui_select_inset_end) * density);
            if (value->GetBox().GetSize(Rml::BoxArea::Content).x != available)
                Rml::ElementUtilities::FormatElement(value, {available, content.y});
            value->SetOffset(GetBox().GetPosition(Rml::BoxArea::Content) +
                                 Rml::Vector2f{ui_select_inset_start * density,
                                               (content.y - value->GetBox().GetSize().y) * .5f},
                             this);
        }
    }
};

class UiControlArrowDecorator final : public Rml::Decorator {
    bool solid;
    struct Data {
        Rml::Geometry geometry;
        Rml::CallbackTexture texture;
        Rml::Vector2f size{};
        Rml::ColourbPremultiplied color{};
        float density = 0;
    };
    // The chevron's texture, in CSS pixels around its center.
    static constexpr float chevron_width = 12.f, chevron_height = 8.f;

    // Chromium 152's menulist arrow, fitted to its rasterization: a 2px stroke
    // with butt caps through (-4,-2), (0,2) and (4,-2) CSS pixels from the
    // center, antialiased by pixel coverage.
    static bool in_chevron(float x, float y) {
        x -= chevron_width * .5f;
        y -= chevron_height * .5f;
        for (const float side : {-1.f, 1.f}) {
            // Along and across the segment from (side * 4, -2) to (0, 2).
            const float dx = -side * 4.f, dy = 4.f, length = std::sqrt(dx * dx + dy * dy);
            const float along = ((x - side * 4.f) * dx + (y + 2.f) * dy) / length;
            const float across = std::abs((x - side * 4.f) * dy - (y + 2.f) * dx) / length;
            if (along >= 0.f && along <= length && across <= 1.f)
                return true;
        }
        return false;
    }

public:
    explicit UiControlArrowDecorator(bool solid) : solid(solid) {}
    Rml::DecoratorDataHandle GenerateElementData(Rml::Element*, Rml::BoxArea) const override {
        return reinterpret_cast<Rml::DecoratorDataHandle>(new Data{});
    }
    void ReleaseElementData(Rml::DecoratorDataHandle handle) const override {
        delete reinterpret_cast<Data*>(handle);
    }
    void RenderElement(Rml::Element* element, Rml::DecoratorDataHandle handle) const override {
        auto& data = *reinterpret_cast<Data*>(handle);
        const auto size = element->GetBox().GetSize(Rml::BoxArea::Content);
        const auto color = element->GetComputedValues().color().ToPremultiplied(
            element->GetComputedValues().opacity());
        const float density = Rml::ElementUtilities::GetDensityIndependentPixelRatio(element);
        if (!solid) {
            // The texture snaps to the pixel grid around the box's center.
            const int width = static_cast<int>(std::ceil(chevron_width * density)),
                      height = static_cast<int>(std::ceil(chevron_height * density));
            auto& manager = element->GetContext()->GetRenderManager();
            if (data.color != color || data.density != density || !data.texture) {
                data.texture = manager.MakeCallbackTexture(
                    [bytes = ui_coverage_pixels(width, height, density, color, in_chevron), width,
                     height](const Rml::CallbackTextureInterface& out) {
                        return out.GenerateTexture(bytes, {width, height});
                    });
                Rml::Mesh mesh;
                Rml::MeshUtilities::GenerateQuad(
                    mesh, {0, 0}, {static_cast<float>(width), static_cast<float>(height)},
                    Rml::ColourbPremultiplied{255, 255, 255, 255}, {0, 0}, {1, 1});
                data.geometry = manager.MakeGeometry(std::move(mesh));
                data.color = color;
                data.density = density;
            }
            const auto center = element->GetAbsoluteOffset(Rml::BoxArea::Content) + size * .5f;
            data.geometry.Render(
                {std::round(center.x - width * .5f), std::round(center.y - height * .5f)},
                data.texture);
            return;
        }
        if (data.size != size || data.color != color || data.density != density) {
            Rml::Mesh mesh;
            const bool horizontal = element->GetParentNode()->GetTagName() == "scrollbarhorizontal";
            const float direction = element->GetTagName() == "sliderarrowdec" ? -1.f : 1.f;
            for (auto point : {Rml::Vector2f{-4, -2.5f}, {0, 3}, {4, -2.5f}}) {
                point.y *= direction;
                if (horizontal)
                    std::swap(point.x, point.y);
                mesh.vertices.push_back({size * .5f + point * density, color, {}});
            }
            mesh.indices = {0, 1, 2};
            data.geometry = element->GetContext()->GetRenderManager().MakeGeometry(std::move(mesh));
            data.size = size;
            data.color = color;
            data.density = density;
        }
        data.geometry.Render(element->GetAbsoluteOffset(Rml::BoxArea::Content));
    }
};

class UiControlArrowDecoratorInstancer final : public Rml::DecoratorInstancer {
public:
    Rml::SharedPtr<Rml::Decorator>
    InstanceDecorator(const Rml::String& name, const Rml::PropertyDictionary&,
                      const Rml::DecoratorInstancerInterface&) override {
        return Rml::MakeShared<UiControlArrowDecorator>(name == "bbl-native-scroll-arrow");
    }
};

// Browser text controls retain fractional advances even when their glyph masks
// are grid fitted. RmlUi's default font engine stores integer glyph advances.
// For a fixed-pitch face the difference is one uniform spacing adjustment.
class TextFormMetrics {
public:
    TextFormMetrics() {
        if (FT_Init_FreeType(&library))
            throw std::runtime_error("Text form font metrics initialization failed.");
    }
    ~TextFormMetrics() { FT_Done_FreeType(library); }
    TextFormMetrics(const TextFormMetrics&) = delete;
    TextFormMetrics& operator=(const TextFormMetrics&) = delete;

    std::optional<float> spacing(const std::string& family, int weight, float size) {
        const auto key = std::tuple{family, weight, size};
        const auto found = cache.find(key);
        if (found != cache.end())
            return found->second;
        return cache.emplace(key, measure(family, weight, size)).first->second;
    }

private:
    std::optional<float> measure(const std::string& family, int weight, float size) {
        const auto descriptor = find_system_font(family, weight);
        if (!descriptor)
            return std::nullopt;
        const auto bytes = detail::read_binary_file_bounded(
            descriptor->path,
            (std::min)(detail::maximum_resource_file_bytes,
                       static_cast<std::uintmax_t>((std::numeric_limits<FT_Long>::max)())),
            "resolved text form font", detail::FileLinks::follow);
        FT_Face face = nullptr;
        if (FT_New_Memory_Face(library, bytes.data(), static_cast<FT_Long>(bytes.size()),
                               descriptor->face_index, &face))
            throw std::runtime_error("Text form font metrics could not open the resolved face.");
        struct Release {
            FT_Face face;
            ~Release() { FT_Done_Face(face); }
        } release{face};
        if (!FT_IS_FIXED_WIDTH(face))
            return std::nullopt;
        const auto glyph = FT_Get_Char_Index(face, ' ');
        if (FT_Load_Glyph(face, glyph, FT_LOAD_NO_SCALE))
            throw std::runtime_error("Text form design advance lookup failed.");
        const float design =
            static_cast<float>(face->glyph->metrics.horiAdvance) * size / face->units_per_EM;
        if (FT_Set_Pixel_Sizes(face, 0, static_cast<FT_UInt>(std::lround(size))) ||
            FT_Load_Glyph(face, glyph, FT_LOAD_DEFAULT))
            throw std::runtime_error("Text form hinted advance lookup failed.");
        const float hinted = static_cast<float>(face->glyph->advance.x) / 64.f;
        return design - hinted;
    }
    FT_Library library = nullptr;
    std::map<std::tuple<std::string, int, float>, std::optional<float>> cache;
};
} // namespace bbl::pal
