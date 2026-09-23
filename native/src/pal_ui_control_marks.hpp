#pragma once

#include <RmlUi/Core/ComputedValues.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Decorator.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/RenderManager.h>
#include <array>

namespace bbl::pal {

// Retained native controls own their state. These marks supply only the
// browser-default check and disclosure glyphs that RmlUi does not paint.
class UiControlMarkDecorator final : public Rml::Decorator {
    struct Data {
        Rml::Geometry geometry;
        Rml::Vector2f size{};
        Rml::ColourbPremultiplied color{};
        float font_size = 0;
        bool open = false;
        bool initialized = false;
    };

public:
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
        const auto color = (summary ? style.color() : Rml::Colourb{255, 255, 255})
                               .ToPremultiplied(style.opacity());
        const float font_size = style.font_size();
        if (!data.initialized || data.size != size || data.color != color ||
            data.font_size != font_size || data.open != open) {
            Rml::Mesh mesh;
            if (summary) {
                const float width = font_size * .6f;
                const float top = (element->GetLineHeight() - width) * .5f;
                const auto triangle =
                    open
                        ? std::array{Rml::Vector2f{0, top}, Rml::Vector2f{width, top},
                                     Rml::Vector2f{width * .5f, top + width}}
                        : std::array{Rml::Vector2f{0, top}, Rml::Vector2f{width, top + width * .5f},
                                     Rml::Vector2f{0, top + width}};
                for (const auto point : triangle)
                    mesh.vertices.push_back({point, color, {}});
                mesh.indices = {0, 1, 2};
            } else {
                for (const auto point : {Rml::Vector2f{.12f, .49f},
                                         {.39f, .77f},
                                         {.91f, .23f},
                                         {.79f, .11f},
                                         {.39f, .53f},
                                         {.24f, .37f}})
                    mesh.vertices.push_back({point * size, color, {}});
                mesh.indices = {0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4};
            }
            data.geometry = element->GetContext()->GetRenderManager().MakeGeometry(std::move(mesh));
            data.size = size;
            data.color = color;
            data.font_size = font_size;
            data.open = open;
            data.initialized = true;
        }
        data.geometry.Render(element->GetAbsoluteOffset(area));
    }
};

class UiControlMarkDecoratorInstancer final : public Rml::DecoratorInstancer {
public:
    Rml::SharedPtr<Rml::Decorator>
    InstanceDecorator(const Rml::String&, const Rml::PropertyDictionary&,
                      const Rml::DecoratorInstancerInterface&) override {
        return Rml::MakeShared<UiControlMarkDecorator>();
    }
};

} // namespace bbl::pal
