#pragma once
#ifdef __ANDROID__
#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/FontEffect.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <RmlUi/Core/StringUtilities.h>
#include <SDL3/SDL.h>
#include "pal_android_font.hpp"
#include <jni.h>
#include <map>
#include <set>
#include <tuple>

namespace bbl::pal {
// Keep FreeType's ordinary text and layout; Android rasterizes the explicit
// color-font spans, including system COLRv1 fonts unsupported by FT_Render_Glyph.
class AndroidUiFontEngine final : public Rml::FontEngineInterface {
    struct Raster {
        int advance;
        Rml::Vector2i origin, dimensions;
        std::shared_ptr<const std::vector<Rml::byte>> pixels;
        std::unique_ptr<Rml::CallbackTextureSource> texture;
    };
    struct EffectRaster {
        Rml::Vector2i offset, dimensions;
        std::unique_ptr<Rml::CallbackTextureSource> texture;
    };
    using RasterKey = std::tuple<int, std::string, float>;
    Rml::FontEngineInterface& fallback;
    std::string path;
    int face_index = 0;
    std::map<Rml::FontFaceHandle, int> sizes;
    std::set<Rml::FontFaceHandle> color_faces;
    std::set<Rml::Character> color_characters, text_characters;
    std::set<std::tuple<std::string, int, bool>> registered_characters;
    std::map<RasterKey, int> advances;
    std::map<RasterKey, Raster> rasters;
    std::map<Rml::FontEffectsHandle, Rml::FontEffectList> effects;
    std::map<std::pair<Raster*, size_t>, EffectRaster> effect_rasters;

    void register_characters(const std::string& file, int index, bool color) {
        const auto key = std::tuple{file, index, color};
        if (registered_characters.contains(key)) return;
        const auto library = android_font_library();
        if (!library) throw std::runtime_error("Emoji fallback font discovery failed.");
        FT_Face face = nullptr;
        if (FT_New_Face(library, file.c_str(), index, &face)) throw std::runtime_error("Emoji fallback font face unavailable.");
        FontOwner<FT_Face, &FT_Done_Face> face_owner(face, FT_Done_Face);
        auto& characters = color ? color_characters : text_characters;
        FT_UInt glyph = 0;
        for (FT_ULong point = FT_Get_First_Char(face, &glyph); glyph; point = FT_Get_Next_Char(face, point, &glyph))
            characters.insert(static_cast<Rml::Character>(point));
        registered_characters.insert(key);
    }
    template<class Visit> void spans(Rml::FontFaceHandle handle, Rml::StringView text, Visit&& visit) {
        const char* begin = text.begin(); const char* end = begin + text.size();
        bool previous = false;
        const char* start = begin;
        for (const char* cursor = begin; cursor < end;) {
            const auto point = Rml::StringUtilities::ToCharacter(cursor, end);
            const bool color = color_faces.contains(handle) ||
                (color_characters.contains(point) && !text_characters.contains(point));
            if (cursor != begin && color != previous) { visit(Rml::StringView(start, cursor), previous); start = cursor; }
            previous = color;
            cursor = Rml::StringUtilities::SeekForwardUTF8(cursor + 1, end);
        }
        if (start != end) visit(Rml::StringView(start, end), previous);
    }

    static std::unique_ptr<Rml::CallbackTextureSource> texture(std::shared_ptr<const std::vector<Rml::byte>> pixels, Rml::Vector2i dimensions) {
        return std::make_unique<Rml::CallbackTextureSource>([pixels = std::move(pixels), dimensions](const Rml::CallbackTextureInterface& output) {
            return output.GenerateTexture(*pixels, dimensions);
        });
    }
    std::vector<jint> emoji_data(int size, Rml::StringView text, float spacing, bool render) {
        auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
        if (!env || env->PushLocalFrame(8) < 0) throw std::runtime_error("Android emoji JNI unavailable.");
        struct Frame { JNIEnv* env; ~Frame() { env->PopLocalFrame(nullptr); } } frame{env};
        const auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
        const auto type = env->GetObjectClass(activity);
        const auto method = env->GetMethodID(type, render ? "rasterizeEmoji" : "measureEmoji", "([BLjava/lang/String;IIF)[I");
        const auto bytes = env->NewByteArray(static_cast<jsize>(text.size()));
        env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()), reinterpret_cast<const jbyte*>(text.begin()));
        const auto font = env->NewStringUTF(path.c_str());
        const auto output = method ? static_cast<jintArray>(env->CallObjectMethod(activity, method, bytes, font, face_index, size, spacing)) : nullptr;
        if (env->ExceptionCheck()) { env->ExceptionClear(); throw std::runtime_error("Android emoji rasterization failed."); }
        if (!output || env->GetArrayLength(output) < (render ? 5 : 1)) throw std::runtime_error("Invalid Android emoji result.");
        std::vector<jint> values(env->GetArrayLength(output));
        env->GetIntArrayRegion(output, 0, static_cast<jsize>(values.size()), values.data());
        return values;
    }
    int advance(int size, Rml::StringView text, float spacing) {
        const RasterKey key{size, std::string(text.begin(), text.size()), spacing};
        if (const auto found = advances.find(key); found != advances.end()) return found->second;
        return advances.emplace(key, emoji_data(size, text, spacing, false)[0]).first->second;
    }
    Raster& raster(int size, Rml::StringView text, float spacing) {
        const RasterKey key{size, std::string(text.begin(), text.size()), spacing};
        if (const auto found = rasters.find(key); found != rasters.end()) return found->second;
        const auto values = emoji_data(size, text, spacing, true);
        Raster value{values[0], {values[1], values[2]}, {values[3], values[4]}, {}, {}};
        const auto count = values.size() - 5;
        if (value.dimensions.x <= 0 || value.dimensions.y <= 0 ||
            static_cast<size_t>(value.dimensions.x) * value.dimensions.y != count) throw std::runtime_error("Invalid Android emoji dimensions.");
        auto pixels = std::make_shared<std::vector<Rml::byte>>(count * 4);
        for (size_t i = 0; i < count; ++i) {
            const auto argb = static_cast<std::uint32_t>(values[i + 5]);
            const auto alpha = argb >> 24;
            for (unsigned c = 0; c < 3; ++c) (*pixels)[i * 4 + c] = static_cast<Rml::byte>((((argb >> (16 - c * 8)) & 255) * alpha + 127) / 255);
            (*pixels)[i * 4 + 3] = static_cast<Rml::byte>(alpha);
        }
        value.pixels = std::move(pixels);
        value.texture = texture(value.pixels, value.dimensions);
        advances.insert_or_assign(key, value.advance);
        return rasters.emplace(key, std::move(value)).first->second;
    }
    void effect_mesh(Rml::RenderManager& manager, Raster& base, const Rml::FontEffect& effect,
        Rml::Vector2f position, float opacity, Rml::TexturedMeshList& meshes) {
        const auto key = std::pair{&base, effect.GetFingerprint()};
        auto found = effect_rasters.find(key);
        if (found == effect_rasters.end()) {
            Rml::FontGlyph glyph;
            glyph.bitmap_data = base.pixels->data(); glyph.bitmap_dimensions = base.dimensions;
            glyph.color_format = Rml::ColorFormat::RGBA8; glyph.advance = base.advance;
            glyph.bearing = {base.origin.x, -base.origin.y};
            EffectRaster value{{0, 0}, base.dimensions, {}};
            if (!effect.GetGlyphMetrics(value.offset, value.dimensions, glyph)) return;
            if (effect.HasUniqueTexture()) {
                std::vector<Rml::byte> pixels(static_cast<size_t>(value.dimensions.x) * value.dimensions.y * 4);
                effect.GenerateGlyphTexture(pixels.data(), value.dimensions, value.dimensions.x * 4, glyph);
                value.texture = texture(std::make_shared<const std::vector<Rml::byte>>(std::move(pixels)), value.dimensions);
            } else {
                auto pixels = *base.pixels;
                for (size_t i = 0; i < pixels.size(); i += 4) pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3];
                value.dimensions = base.dimensions;
                value.texture = texture(std::make_shared<const std::vector<Rml::byte>>(std::move(pixels)), value.dimensions);
            }
            found = effect_rasters.emplace(key, std::move(value)).first;
        }
        const auto& value = found->second;
        meshes.emplace_back(); meshes.back().texture = value.texture->GetTexture(manager);
        auto color = effect.GetColour(); color.alpha = static_cast<Rml::byte>(std::clamp(std::lround(color.alpha * opacity), 0l, 255l));
        Rml::MeshUtilities::GenerateQuad(meshes.back().mesh, position + Rml::Vector2f(base.origin + value.offset),
            Rml::Vector2f(value.dimensions), color.ToPremultiplied(), {0,0}, {1,1});
    }
public:
    explicit AndroidUiFontEngine(Rml::FontEngineInterface& fallback) : fallback(fallback) {}
    void Shutdown() override { ReleaseFontResources(); fallback.Shutdown(); }
    bool LoadFontFace(const Rml::String& file, int index, bool is_fallback, Rml::Style::FontWeight weight) override {
        return fallback.LoadFontFace(file, index, is_fallback, weight);
    }
    bool LoadFontFace(Rml::Span<const Rml::byte> data, int index, const Rml::String& family, Rml::Style::FontStyle style, Rml::Style::FontWeight weight, bool is_fallback) override {
        return fallback.LoadFontFace(data, index, family, style, weight, is_fallback);
    }
    bool LoadFontFace(const Rml::String& file, int index, const Rml::String& family, Rml::Style::FontStyle style, Rml::Style::FontWeight weight, bool is_fallback) override {
        if (!fallback.LoadFontFace(file, index, family, style, weight, is_fallback)) return false;
        register_characters(file, index, family == "bbl-emoji");
        if (family == "bbl-emoji") { path = file; face_index = index; }
        return true;
    }
    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String& family, Rml::Style::FontStyle style, Rml::Style::FontWeight weight, int size) override {
        const auto handle = fallback.GetFontFaceHandle(family, style, weight, size);
        if (handle) sizes.emplace(handle, size);
        if (handle && family == "bbl-emoji") color_faces.insert(handle);
        return handle;
    }
    Rml::FontEffectsHandle PrepareFontEffects(Rml::FontFaceHandle handle, const Rml::FontEffectList& list) override {
        const auto result = fallback.PrepareFontEffects(handle, list);
        effects.insert_or_assign(result, list);
        return result;
    }
    const Rml::FontMetrics& GetFontMetrics(Rml::FontFaceHandle handle) override { return fallback.GetFontMetrics(handle); }
    int GetStringWidth(Rml::FontFaceHandle handle, Rml::StringView text, const Rml::TextShapingContext& context, Rml::Character prior) override {
        const auto found = sizes.find(handle);
        if (found == sizes.end()) return fallback.GetStringWidth(handle, text, context, prior);
        int width = 0;
        spans(handle, text, [&](Rml::StringView span, bool color) {
            width += color ? advance(found->second, span, context.letter_spacing) : fallback.GetStringWidth(handle, span, context, prior);
            prior = Rml::Character::Null;
        });
        return width;
    }
    int GenerateString(Rml::RenderManager& manager, Rml::FontFaceHandle handle, Rml::FontEffectsHandle effect_handle, Rml::StringView text,
        Rml::Vector2f position, Rml::ColourbPremultiplied color, float opacity, const Rml::TextShapingContext& context, Rml::TexturedMeshList& meshes) override {
        const auto found = sizes.find(handle);
        if (found == sizes.end()) return fallback.GenerateString(manager, handle, effect_handle, text, position, color, opacity, context, meshes);
        int width = 0;
        spans(handle, text, [&](Rml::StringView span, bool is_color) {
            if (!is_color) {
                Rml::TexturedMeshList retained;
                const int advance = fallback.GenerateString(manager, handle, effect_handle, span, position, color, opacity, context, retained);
                for (auto& mesh : retained) meshes.push_back(std::move(mesh));
                width += advance; position.x += advance; return;
            }
            auto& value = raster(found->second, span, context.letter_spacing);
            const auto draw_effects = [&](Rml::FontEffect::Layer layer) {
                if (const auto list = effects.find(effect_handle); list != effects.end())
                    for (const auto& effect : list->second) if (effect->GetLayer() == layer) effect_mesh(manager, value, *effect, position, opacity, meshes);
            };
            draw_effects(Rml::FontEffect::Layer::Back);
            meshes.emplace_back(); meshes.back().texture = value.texture->GetTexture(manager);
            Rml::MeshUtilities::GenerateQuad(meshes.back().mesh, position + Rml::Vector2f(value.origin), Rml::Vector2f(value.dimensions),
                Rml::ColourbPremultiplied(color.alpha, color.alpha, color.alpha, color.alpha), {0,0}, {1,1});
            draw_effects(Rml::FontEffect::Layer::Front);
            width += value.advance; position.x += value.advance;
        });
        return width;
    }
    int GetVersion(Rml::FontFaceHandle handle) override { return fallback.GetVersion(handle); }
    void ReleaseFontResources() override { effect_rasters.clear(); rasters.clear(); advances.clear(); effects.clear(); sizes.clear(); color_faces.clear(); fallback.ReleaseFontResources(); }
};
} // namespace bbl::pal
#endif
