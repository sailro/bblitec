#pragma once

#include "pal_ui_defaults.hpp"
#include "pal_ui_range.hpp"
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/ElementInstancer.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Factory.h>
#include <RmlUi/Core/Input.h>
#include <array>
#include <cstdio>
#include <functional>
#include <optional>
#include <stdexcept>

namespace bbl::pal {

inline std::optional<std::string> ui_simple_color(std::string value) {
    if (value.size() != 7 || value.front() != '#')
        return std::nullopt;
    for (std::size_t index = 1; index < value.size(); ++index) {
        char& digit = value[index];
        if (digit >= 'A' && digit <= 'F')
            digit = static_cast<char>(digit + ('a' - 'A'));
        if (!((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f')))
            return std::nullopt;
    }
    return value;
}

/** A form control retains the source input identity; the picker is native UI. */
class UiColorInput final : public Rml::ElementFormControl {
public:
    explicit UiColorInput(const Rml::String& tag) : ElementFormControl(tag) {}
    std::function<void()> activate;

    Rml::String GetValue() const override {
        return ui_simple_color(GetAttribute<Rml::String>("value", "")).value_or("#000000");
    }
    void SetValue(const Rml::String& value) override {
        SetAttribute("value", ui_simple_color(value).value_or("#000000"));
    }
    bool GetIntrinsicDimensions(Rml::Vector2f& dimensions, float& ratio) override {
        const auto* context = GetContext();
        dimensions = Rml::Vector2f(50.f, 27.f) *
                     (context ? context->GetDensityIndependentPixelRatio() : 1.f);
        ratio = -1.f;
        return true;
    }

protected:
    void OnRender() override {
        ElementFormControl::OnRender();
        const auto size = GetBox().GetSize(Rml::BoxArea::Content);
        const auto value = GetValue();
        const float opacity = GetComputedValues().opacity();
        const float density = GetContext()->GetDensityIndependentPixelRatio();
        if (!swatch || swatch_size != size || swatch_value != value || swatch_opacity != opacity ||
            swatch_density != density) {
            Rml::Mesh mesh;
            const auto color =
                Rml::Colourb(static_cast<Rml::byte>(std::stoi(value.substr(1, 2), nullptr, 16)),
                             static_cast<Rml::byte>(std::stoi(value.substr(3, 2), nullptr, 16)),
                             static_cast<Rml::byte>(std::stoi(value.substr(5, 2), nullptr, 16)));
            // The native swatch is independent of the author-styled button.
            // Its inset border remains visible for white and black selections.
            // The anonymous swatch wrapper adds padding independently of
            // the input's author-styled content box.
            const Rml::Vector2f padding{std::min(2 * density, size.x * .5f),
                                        std::min(4 * density, size.y * .5f)};
            const auto dimensions = size - padding * 2;
            const float inset = std::min({density, dimensions.x * .5f, dimensions.y * .5f});
            Rml::MeshUtilities::GenerateQuad(mesh, padding, dimensions,
                                             Rml::Colourb{119, 119, 119}.ToPremultiplied(opacity));
            Rml::MeshUtilities::GenerateQuad(mesh, padding + Rml::Vector2f{inset, inset},
                                             dimensions - Rml::Vector2f{2 * inset, 2 * inset},
                                             color.ToPremultiplied(opacity));
            swatch = GetContext()->GetRenderManager().MakeGeometry(std::move(mesh));
            swatch_size = size;
            swatch_value = value;
            swatch_opacity = opacity;
            swatch_density = density;
        }
        swatch.Render(GetAbsoluteOffset(Rml::BoxArea::Content));
    }
    void OnAttributeChange(const Rml::ElementAttributes& attributes) override {
        ElementFormControl::OnAttributeChange(attributes);
        if (attributes.find("type") != attributes.end() &&
            GetAttribute<Rml::String>("type", "") != "color")
            throw std::runtime_error(
                "Changing a projected color input into another type is not represented.");
    }
    void ProcessDefaultAction(Rml::Event& event) override {
        ElementFormControl::ProcessDefaultAction(event);
        if (IsDisabled())
            return;
        if (event == Rml::EventId::Click) {
            if (activate)
                activate();
        } else if (event == Rml::EventId::Keydown) {
            const int key = event.GetParameter<int>("key_identifier", 0);
            if (key == Rml::Input::KI_RETURN || key == Rml::Input::KI_SPACE) {
                Click();
                event.StopPropagation();
            }
        }
    }

private:
    Rml::Geometry swatch;
    Rml::Vector2f swatch_size{};
    std::string swatch_value;
    float swatch_opacity = 0;
    float swatch_density = 0;
};

class UiInputInstancer final : public Rml::ElementInstancer {
public:
    Rml::ElementPtr InstanceElement(Rml::Element*, const Rml::String& tag,
                                    const Rml::XMLAttributes& attributes) override {
        const auto type = attributes.find("type");
        if (type != attributes.end() && type->second.Get<Rml::String>() == "color")
            return Rml::ElementPtr(new UiColorInput(tag));
        return Rml::ElementPtr(new UiInputElement(tag));
    }
    void ReleaseElement(Rml::Element* element) override { delete element; }
};

/** Portable opaque sRGB picker, using the same Rml controls on every backend. */
class UiColorPopup final : public Rml::EventListener {
public:
    UiColorPopup(Rml::Context& context, UiColorInput& owner, const std::string& font_family,
                 const std::function<std::string(std::string)>& project_style)
        : owner(owner), initial(owner.GetValue()), current(initial) {
        document = context.CreateDocument();
        if (!document)
            throw std::runtime_error("Could not create native color picker.");
        document->SetStyleSheetContainer(Rml::Factory::InstanceStyleSheetString(project_style(
            std::string(ui_user_agent_css) +
            "html{position:absolute;left:50%;top:50%;width:300dp;height:238dp;"
            "margin-left:-150dp;margin-top:-119dp;padding:16dp;box-sizing:border-box;"
            "background-color:#172331;color:#ffffff;border-width:1dp;border-color:#52647a;"
            "border-radius:8dp;font-size:14dp;line-height:1.3;font-family:" +
            font_family +
            ";}"
            "h3{display:block;margin:0 0 12dp;font-size:16dp;}"
            "label{display:block;height:30dp;}label span{display:inline-block;width:24dp;}"
            "input[type=range]{width:222dp;vertical-align:middle;}"
            "input[type=text]{width:112dp;height:26dp;padding:3dp;box-sizing:border-box;"
            "background-color:#ffffff;color:#111111;border-width:1dp;border-color:#7d8ca0;}"
            "button{height:28dp;width:88dp;margin:10dp 8dp 0 0;background-color:#dce6f2;"
            "color:#111111;border-width:1dp;border-color:#7d8ca0;pointer-events:auto;}")));
        document->SetInnerRML(
            "<h3>Choose color</h3>"
            "<label><span>R</span><input id='red' type='range' min='0' max='255' step='1'/></label>"
            "<label><span>G</span><input id='green' type='range' min='0' max='255' step='1'/></label>"
            "<label><span>B</span><input id='blue' type='range' min='0' max='255' step='1'/></label>"
            "<label><span>#</span><input id='hex' type='text' maxlength='7'/></label>"
            "<div><button id='apply'>Apply</button><button id='cancel'>Cancel</button></div>");
        const std::array<const char*, 3> ids{"red", "green", "blue"};
        for (std::size_t index = 0; index < channels.size(); ++index)
            channels[index] = form(ids[index]);
        hex = form("hex");
        synchronize();
        for (auto* control : channels)
            listen(*control, "change");
        listen(*hex, "change");
        listen(*document->GetElementById("apply"), "click");
        listen(*document->GetElementById("cancel"), "click");
        listen(*document, "keydown");
        document->Show(Rml::ModalFlag::Modal, Rml::FocusFlag::Document);
    }

    bool closed() const { return document == nullptr; }
    Rml::ElementDocument* element() const { return document; }
    UiColorInput* input() const { return &owner; }
    void close() {
        if (!document)
            return;
        for (const auto& [element, event] : listeners)
            element->RemoveEventListener(event, this);
        listeners.clear();
        document->Close();
        document = nullptr;
    }

    void ProcessEvent(Rml::Event& event) override {
        if (updating || !document)
            return;
        if (event == Rml::EventId::Keydown) {
            const int key = event.GetParameter<int>("key_identifier", 0);
            if (key == Rml::Input::KI_ESCAPE) {
                finish(false);
                event.StopPropagation();
            }
            return;
        }
        const auto id = event.GetCurrentElement()->GetId();
        if (id == "apply" || id == "cancel") {
            if (id == "cancel" || ui_simple_color(hex->GetValue()))
                finish(id == "apply");
        } else {
            if (id == "hex") {
                const auto value = ui_simple_color(hex->GetValue());
                hex->SetProperty("border-color", value ? "#7d8ca0" : "#ff5252");
                if (!value)
                    return;
                current = *value;
            } else {
                std::array<unsigned, 3> rgb{};
                for (std::size_t index = 0; index < rgb.size(); ++index)
                    rgb[index] = static_cast<unsigned>(
                        std::clamp(std::stoi(channels[index]->GetValue()), 0, 255));
                char value[8]{};
                std::snprintf(value, sizeof(value), "#%02x%02x%02x", rgb[0], rgb[1], rgb[2]);
                current = value;
            }
            synchronize();
            if (owner.GetValue() != current) {
                owner.SetValue(current);
                owner.DispatchEvent("input", {});
            }
        }
        event.StopPropagation();
    }

private:
    Rml::ElementFormControl* form(const char* id) {
        auto* control = rmlui_dynamic_cast<Rml::ElementFormControl*>(document->GetElementById(id));
        if (!control)
            throw std::runtime_error("Native color picker form control is missing.");
        return control;
    }
    void listen(Rml::Element& element, const char* event) {
        element.AddEventListener(event, this);
        listeners.emplace_back(&element, event);
    }
    void synchronize() {
        updating = true;
        for (std::size_t index = 0; index < channels.size(); ++index)
            channels[index]->SetValue(
                std::to_string(std::stoi(current.substr(1 + index * 2, 2), nullptr, 16)));
        hex->SetValue(current);
        updating = false;
    }
    void finish(bool accepted) {
        if (!accepted && owner.GetValue() != initial) {
            owner.SetValue(initial);
            owner.DispatchEvent("input", {});
        } else if (accepted && owner.GetValue() != initial)
            owner.DispatchEvent("change", {});
        close();
    }
    UiColorInput& owner;
    const std::string initial;
    std::string current;
    Rml::ElementDocument* document = nullptr;
    std::array<Rml::ElementFormControl*, 3> channels{};
    Rml::ElementFormControl* hex = nullptr;
    std::vector<std::pair<Rml::Element*, std::string>> listeners;
    bool updating = false;
};
} // namespace bbl::pal
