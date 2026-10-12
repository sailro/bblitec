#pragma once

#include "pal_ui_control_scheme.hpp"
#include "pal_ui_coverage.hpp"
#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/ComputedValues.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Core.h>
#include <RmlUi/Core/Decorator.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/FontMetrics.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <cmath>

namespace bbl::pal {

// Retained native controls own their state. These marks supply only the
// browser-default check and disclosure glyphs that RmlUi does not paint.
class UiControlMarkDecorator final : public Rml::Decorator {
    const UiControlSchemeProperties& properties;
    struct Data {
        Rml::Geometry geometry;
        Rml::CallbackTexture texture;
        Rml::Vector2f size{};
        Rml::ColourbPremultiplied color{};
        float font_size = 0;
        float baseline = 0;
        bool open = false;
        bool initialized = false;
    };

    // Chromium 152's disclosure marker, measured: a 0.66em square whose bottom
    // sits on the first baseline holds an equilateral triangle, pointing right
    // from its left edge when closed, and down and vertically centered when
    // open, antialiased by pixel coverage.
    static void render_disclosure(Rml::Element& element, Data& data,
                                  Rml::ColourbPremultiplied color, float font_size, bool open) {
        const auto face = element.GetFontFaceHandle();
        if (!face)
            return;
        const auto& metrics = Rml::GetFontEngineInterface()->GetFontMetrics(face);
        const float baseline =
            (element.GetLineHeight() - metrics.ascent - metrics.descent) * .5f + metrics.ascent;
        const float side = font_size * .66f, height = side * std::sqrt(3.f) * .5f;
        const float top = std::floor(baseline - side);
        const int width = static_cast<int>(std::ceil(side)) + 1,
                  rows = static_cast<int>(std::ceil(baseline - top)) + 1;
        auto& manager = element.GetContext()->GetRenderManager();
        if (!data.initialized || data.color != color || data.font_size != font_size ||
            data.open != open || data.baseline != baseline) {
            const float square = baseline - side - top;
            const auto inside = [=](float x, float y) {
                y -= square;
                if (open) {
                    y -= (side - height) * .5f;
                    return y >= 0.f && y <= height &&
                           std::abs(x - side * .5f) <= (height - y) / std::sqrt(3.f);
                }
                return x >= 0.f && x <= height &&
                       std::abs(y - side * .5f) <= (height - x) / std::sqrt(3.f);
            };
            data.texture = manager.MakeCallbackTexture(
                [bytes = ui_coverage_pixels(width, rows, 1.f, color, inside), width,
                 rows](const Rml::CallbackTextureInterface& out) {
                    return out.GenerateTexture(bytes, {width, rows});
                });
            Rml::Mesh mesh;
            Rml::MeshUtilities::GenerateQuad(
                mesh, {0, 0}, {static_cast<float>(width), static_cast<float>(rows)},
                Rml::ColourbPremultiplied{255, 255, 255, 255}, {0, 0}, {1, 1});
            data.geometry = manager.MakeGeometry(std::move(mesh));
            data.color = color;
            data.font_size = font_size;
            data.open = open;
            data.baseline = baseline;
            data.initialized = true;
        }
        const auto origin = element.GetAbsoluteOffset(Rml::BoxArea::Padding);
        data.geometry.Render({std::round(origin.x), std::round(origin.y + top)}, data.texture);
    }

public:
    explicit UiControlMarkDecorator(const UiControlSchemeProperties& properties)
        : properties(properties) {}
    Rml::DecoratorDataHandle GenerateElementData(Rml::Element*, Rml::BoxArea) const override {
        return reinterpret_cast<Rml::DecoratorDataHandle>(new Data{});
    }
    void ReleaseElementData(Rml::DecoratorDataHandle handle) const override {
        delete reinterpret_cast<Data*>(handle);
    }
    void RenderElement(Rml::Element* element, Rml::DecoratorDataHandle handle) const override {
        const bool summary = element->GetTagName() == "summary";
        bool open = false;
        if (summary) {
            auto* parent = element->GetParentNode();
            if (!parent || parent->GetTagName() != "details")
                return;
            for (int index = 0; index < parent->GetNumChildren(); ++index) {
                auto* child = parent->GetChild(index);
                if (child->GetTagName() == "summary") {
                    if (child != element)
                        return;
                    break;
                }
            }
            open = parent->HasAttribute("open");
        } else if (!element->IsPseudoClassSet("checked")) {
            return;
        }
        auto& data = *reinterpret_cast<Data*>(handle);
        const auto area = summary ? Rml::BoxArea::Padding : Rml::BoxArea::Content;
        const auto size = element->GetBox().GetSize(area);
        const auto& style = element->GetComputedValues();
        // A check takes the checkmark color of its accent-adjusted palette.
        const auto check = [&] {
            const auto mark =
                ui_control_colors(*element, properties, element->IsPseudoClassSet("disabled"))
                    .palette->checkmark;
            return Rml::Colourb{mark.r, mark.g, mark.b};
        };
        const auto color = (summary ? style.color() : check()).ToPremultiplied(style.opacity());
        const float font_size = style.font_size();
        if (summary) {
            render_disclosure(*element, data, color, font_size, open);
            return;
        }
        if (!data.initialized || data.size != size || data.color != color) {
            Rml::Mesh mesh;
            for (const auto point : {Rml::Vector2f{.12f, .49f},
                                     {.39f, .77f},
                                     {.91f, .23f},
                                     {.79f, .11f},
                                     {.39f, .53f},
                                     {.24f, .37f}})
                mesh.vertices.push_back({point * size, color, {}});
            mesh.indices = {0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4};
            data.geometry = element->GetContext()->GetRenderManager().MakeGeometry(std::move(mesh));
            data.size = size;
            data.color = color;
            data.initialized = true;
        }
        data.geometry.Render(element->GetAbsoluteOffset(area));
    }
};

class UiControlMarkDecoratorInstancer final : public Rml::DecoratorInstancer {
public:
    explicit UiControlMarkDecoratorInstancer(const UiControlSchemeProperties& properties)
        : properties(properties) {}
    Rml::SharedPtr<Rml::Decorator>
    InstanceDecorator(const Rml::String&, const Rml::PropertyDictionary&,
                      const Rml::DecoratorInstancerInterface&) override {
        return Rml::MakeShared<UiControlMarkDecorator>(properties);
    }

private:
    const UiControlSchemeProperties& properties;
};

} // namespace bbl::pal
