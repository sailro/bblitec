#pragma once
#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core/Elements/ElementFormControl.h>
#include <RmlUi/Core/Elements/ElementFormControlSelect.h>
#include <RmlUi/Core/ElementText.h>
#include <RmlUi/Core/ElementUtilities.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Decorator.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/RenderManager.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <cmath>
#include <fstream>
#include <iterator>
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

// A browser select sizes to its longest option plus the native arrow. RmlUi's
// default replacement box is an arbitrary 128px and cannot size an auto grid track.
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
        dimensions = {label_width + 20.f * density, std::max(GetLineHeight(), 17.f * density)};
        ratio = -1.f;
        return true;
    }

protected:
    void OnLayout() override {
        ElementFormControlSelect::OnLayout();
        if (auto* arrow = GetChild(0)) {
            const auto size = GetBox().GetSize(Rml::BoxArea::Border);
            const auto arrow_size = arrow->GetBox().GetSize(Rml::BoxArea::Border);
            arrow->SetOffset({size.x - arrow_size.x, (size.y - arrow_size.y) * .5f}, this);
        }
    }
    void OnRender() override {
        ElementFormControlSelect::OnRender();
        // RmlUi formats selectvalue against the entire border box. Keep its
        // text in the content area, reserving the native arrow's intrinsic space.
        if (auto* value = GetChild(1)) {
            const auto content = GetBox().GetSize(Rml::BoxArea::Content);
            const float available = std::max(
                0.f,
                content.x - 20.f * Rml::ElementUtilities::GetDensityIndependentPixelRatio(this));
            if (value->GetBox().GetSize(Rml::BoxArea::Content).x != available)
                Rml::ElementUtilities::FormatElement(value, {available, content.y});
            value->SetOffset(GetBox().GetPosition(Rml::BoxArea::Content) +
                                 Rml::Vector2f{0, (content.y - value->GetBox().GetSize().y) * .5f},
                             this);
        }
    }
};

class UiControlArrowDecorator final : public Rml::Decorator {
    bool solid;
    struct Data {
        Rml::Geometry geometry;
        Rml::Vector2f size{};
        Rml::ColourbPremultiplied color{};
        float density = 0;
    };

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
        if (data.size != size || data.color != color || data.density != density) {
            Rml::Mesh mesh;
            if (solid) {
                const bool horizontal =
                    element->GetParentNode()->GetTagName() == "scrollbarhorizontal";
                const float direction = element->GetTagName() == "sliderarrowdec" ? -1.f : 1.f;
                for (auto point : {Rml::Vector2f{-4, -2.5f}, {0, 3}, {4, -2.5f}}) {
                    point.y *= direction;
                    if (horizontal)
                        std::swap(point.x, point.y);
                    mesh.vertices.push_back({size * .5f + point * density, color, {}});
                }
                mesh.indices = {0, 1, 2};
            } else {
                for (const auto point : {Rml::Vector2f{-4, -1.5f},
                                         {0, 2.5f},
                                         {4, -1.5f},
                                         {3, -2.5f},
                                         {0, .5f},
                                         {-3, -2.5f}})
                    mesh.vertices.push_back({size * .5f + point * density, color, {}});
                mesh.indices = {0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4};
            }
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
        std::ifstream input(descriptor->path, std::ios::binary);
        const std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(input)), {});
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
