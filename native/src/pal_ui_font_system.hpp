#pragma once

#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/Log.h>
#include <RmlUi/Core/StringUtilities.h>
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

namespace bbl::pal {

/** Resolve CSS family lists and load installed faces before delegating shaping. */
class SystemUiFontEngine final : public Rml::FontEngineInterface {
    using FaceKey = std::tuple<std::string, Rml::Style::FontStyle, Rml::Style::FontWeight>;
    Rml::FontEngineInterface& renderer_;
    std::string default_family_;
    std::map<FaceKey, Rml::Style::FontWeight> processed_;
    std::map<std::string, std::vector<std::string>> families_;
    std::set<std::string> reported_;

    const std::vector<std::string>& families(const std::string& value) {
        if (const auto found = families_.find(value); found != families_.end())
            return found->second;
        std::vector<std::string> names;
        std::string name;
        char quote = 0;
        bool escaped = false;
        for (const char character : value) {
            if (escaped) {
                name += character;
                escaped = false;
            } else if (character == '\\') {
                escaped = true;
            } else if (quote) {
                if (character == quote)
                    quote = 0;
                else
                    name += character;
            } else if (character == '\'' || character == '"') {
                quote = character;
            } else if (character == ',') {
                names.push_back(Rml::StringUtilities::StripWhitespace(name));
                name.clear();
            } else {
                name += character;
            }
        }
        if (quote || escaped)
            throw std::runtime_error("Unterminated retained UI font-family name.");
        names.push_back(Rml::StringUtilities::StripWhitespace(name));
        for (auto& family : names)
            family = Rml::StringUtilities::ToLower(family);
        return families_.emplace(value, std::move(names)).first->second;
    }

    Rml::Style::FontWeight ensure_face(const std::string& family, Rml::Style::FontStyle style,
                                       Rml::Style::FontWeight weight) {
        const FaceKey key{family, style, weight};
        if (const auto found = processed_.find(key); found != processed_.end())
            return found->second;
        const auto face = find_system_font(family, static_cast<int>(weight),
                                           style == Rml::Style::FontStyle::Italic);
        if (!face || Rml::StringUtilities::ToLower(face->family) != family) {
            processed_.emplace(key, weight);
            return weight;
        }
        const auto resolved_weight =
            weight == Rml::Style::FontWeight::Auto
                ? weight
                : static_cast<Rml::Style::FontWeight>(
                      face->named_weight.value_or(static_cast<int>(weight)));
        if (!processed_.contains(FaceKey{family, style, resolved_weight}) &&
            !LoadFontFace(face->path.string(), face->face_index, family, style, resolved_weight,
                          false))
            throw std::runtime_error("RmlUi failed to load installed font: " + family);
        processed_.emplace(key, resolved_weight);
        return resolved_weight;
    }

public:
    SystemUiFontEngine(Rml::FontEngineInterface& renderer, std::string default_family)
        : renderer_(renderer), default_family_(Rml::StringUtilities::ToLower(default_family)) {}

    void Shutdown() override {
        processed_.clear();
        families_.clear();
        reported_.clear();
        renderer_.Shutdown();
    }
    bool LoadFontFace(const Rml::String& path, int index, bool fallback,
                      Rml::Style::FontWeight weight) override {
        return renderer_.LoadFontFace(path, index, fallback, weight);
    }
    bool LoadFontFace(const Rml::String& path, int index, const Rml::String& family,
                      Rml::Style::FontStyle style, Rml::Style::FontWeight weight,
                      bool fallback) override {
        const bool loaded = renderer_.LoadFontFace(path, index, family, style, weight, fallback);
        if (loaded)
            processed_.insert_or_assign(
                FaceKey{Rml::StringUtilities::ToLower(family), style, weight}, weight);
        return loaded;
    }
    bool LoadFontFace(Rml::Span<const Rml::byte> bytes, int index, const Rml::String& family,
                      Rml::Style::FontStyle style, Rml::Style::FontWeight weight,
                      bool fallback) override {
        const bool loaded = renderer_.LoadFontFace(bytes, index, family, style, weight, fallback);
        if (loaded)
            processed_.insert_or_assign(
                FaceKey{Rml::StringUtilities::ToLower(family), style, weight}, weight);
        return loaded;
    }
    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String& family, Rml::Style::FontStyle style,
                                          Rml::Style::FontWeight weight, float size) override {
        if (size == 0)
            return 0;
        if (!std::isfinite(size) || size < 0 || size > 16384.f)
            throw std::runtime_error(
                "The retained UI font size must be finite and between 0 and 16384 pixels.");
        for (const auto& name : families(family)) {
            if (name.empty())
                continue;
            const auto resolved_weight = ensure_face(name, style, weight);
            if (const auto handle = renderer_.GetFontFaceHandle(name, style, resolved_weight, size))
                return handle;
        }
        if (reported_.insert(family).second)
            Rml::Log::Message(Rml::Log::LT_WARNING,
                              "UI font-family '%s' is unavailable; using '%s'.", family.c_str(),
                              default_family_.c_str());
        const auto resolved_weight = ensure_face(default_family_, style, weight);
        const auto handle =
            renderer_.GetFontFaceHandle(default_family_, style, resolved_weight, size);
        if (!handle)
            throw std::runtime_error("The retained UI has no usable default font face.");
        return handle;
    }
    Rml::FontEffectsHandle PrepareFontEffects(Rml::FontFaceHandle handle,
                                              const Rml::FontEffectList& effects) override {
        return renderer_.PrepareFontEffects(handle, effects);
    }
    const Rml::FontMetrics& GetFontMetrics(Rml::FontFaceHandle handle) override {
        return renderer_.GetFontMetrics(handle);
    }
    float GetStringWidth(Rml::FontFaceHandle handle, Rml::StringView text,
                         const Rml::TextShapingContext& context, Rml::Character previous) override {
        return renderer_.GetStringWidth(handle, text, context, previous);
    }
    float GenerateString(Rml::RenderManager& manager, Rml::FontFaceHandle handle,
                         Rml::FontEffectsHandle effects, Rml::StringView text,
                         Rml::Vector2f position, Rml::ColourbPremultiplied color, float opacity,
                         const Rml::TextShapingContext& context,
                         Rml::TexturedMeshList& meshes) override {
        return renderer_.GenerateString(manager, handle, effects, text, position, color, opacity,
                                        context, meshes);
    }
    int GetVersion(Rml::FontFaceHandle handle) override { return renderer_.GetVersion(handle); }
    void ReleaseFontResources() override { renderer_.ReleaseFontResources(); }
};

} // namespace bbl::pal
