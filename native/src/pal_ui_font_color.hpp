#pragma once
#include <SDL3/SDL_platform_defines.h>
#if defined(__ANDROID__) || defined(SDL_PLATFORM_IOS)
#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/FontEffect.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <RmlUi/Core/StringUtilities.h>
#include <SDL3/SDL.h>
#include "pal_freetype.hpp"
#if defined(__ANDROID__)
#include <jni.h>
#else
#include <CoreText/CoreText.h>
#include <CoreGraphics/CoreGraphics.h>
#endif
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

namespace bbl::pal {
// Keep FreeType's ordinary text and layout. System text APIs decode color
// glyphs that FreeType cannot rasterize, including Android COLRv1 and iOS emjc.
class ColorUiFontEngine final : public Rml::FontEngineInterface {
    struct EmojiData {
        int advance = 0;
        Rml::Vector2i origin{}, dimensions{};
        std::vector<Rml::byte> pixels;
    };
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
#if defined(SDL_PLATFORM_IOS)
    using AppleFont = FontOwner<CTFontRef, &CFRelease>;
    std::map<std::tuple<std::string, int, int>, AppleFont> apple_fonts;

    CTFontRef apple_font(int size) {
        const auto key = std::tuple{path, face_index, size};
        if (const auto found = apple_fonts.find(key); found != apple_fonts.end())
            return found->second.get();
        const auto library = platform_font_library();
        FT_Face raw_face = nullptr;
        if (!library || FT_New_Face(library, path.c_str(), face_index, &raw_face)) {
            throw std::runtime_error("iOS emoji font face unavailable.");
        }
        FontOwner<FT_Face, &FT_Done_Face> face(raw_face, FT_Done_Face);
        const char* postscript = FT_Get_Postscript_Name(face.get());
        if (!postscript)
            throw std::runtime_error("iOS emoji font has no PostScript identity.");
        FontOwner<CFStringRef, &CFRelease> name(
            CFStringCreateWithCString(kCFAllocatorDefault, postscript, kCFStringEncodingUTF8),
            CFRelease);
        if (!name)
            throw std::runtime_error("iOS emoji font name allocation failed.");
        AppleFont font(CTFontCreateWithName(name.get(), size, nullptr), CFRelease);
        if (!font)
            throw std::runtime_error("CoreText could not create the selected emoji font.");
        FontOwner<CFStringRef, &CFRelease> resolved(CTFontCopyPostScriptName(font.get()),
                                                    CFRelease);
        if (!resolved || !CFEqual(name.get(), resolved.get())) {
            throw std::runtime_error("CoreText substituted a different emoji font.");
        }
        return apple_fonts.emplace(key, std::move(font)).first->second.get();
    }
#endif

    void register_characters(const std::string& file, int index, bool color) {
        const auto key = std::tuple{file, index, color};
        if (registered_characters.contains(key))
            return;
        const auto library = platform_font_library();
        if (!library)
            throw std::runtime_error("Emoji fallback font discovery failed.");
        FT_Face face = nullptr;
        if (FT_New_Face(library, file.c_str(), index, &face))
            throw std::runtime_error("Emoji fallback font face unavailable.");
        FontOwner<FT_Face, &FT_Done_Face> face_owner(face, FT_Done_Face);
        auto& characters = color ? color_characters : text_characters;
        FT_UInt glyph = 0;
        for (FT_ULong point = FT_Get_First_Char(face, &glyph); glyph;
             point = FT_Get_Next_Char(face, point, &glyph))
            characters.insert(static_cast<Rml::Character>(point));
        registered_characters.insert(key);
    }
    template <class Visit>
    void spans(Rml::FontFaceHandle handle, Rml::StringView text, Visit&& visit) {
        const char* begin = text.begin();
        const char* end = begin + text.size();
        bool previous = false;
        const char* start = begin;
        for (const char* cursor = begin; cursor < end;) {
            const auto point = Rml::StringUtilities::ToCharacter(cursor, end);
            const bool color = color_faces.contains(handle) || (color_characters.contains(point) &&
                                                                !text_characters.contains(point));
            if (cursor != begin && color != previous) {
                visit(Rml::StringView(start, cursor), previous);
                start = cursor;
            }
            previous = color;
            cursor = Rml::StringUtilities::SeekForwardUTF8(cursor + 1, end);
        }
        if (start != end)
            visit(Rml::StringView(start, end), previous);
    }

    static std::unique_ptr<Rml::CallbackTextureSource>
    texture(std::shared_ptr<const std::vector<Rml::byte>> pixels, Rml::Vector2i dimensions) {
        return std::make_unique<Rml::CallbackTextureSource>(
            [pixels = std::move(pixels), dimensions](const Rml::CallbackTextureInterface& output) {
                return output.GenerateTexture(*pixels, dimensions);
            });
    }
    EmojiData emoji_data(int size, Rml::StringView text, float spacing, bool render) {
#if defined(__ANDROID__)
        auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
        if (!env || env->PushLocalFrame(8) < 0)
            throw std::runtime_error("Android emoji JNI unavailable.");
        struct Frame {
            JNIEnv* env;
            ~Frame() { env->PopLocalFrame(nullptr); }
        } frame{env};
        const auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
        const auto type = env->GetObjectClass(activity);
        const auto method = env->GetMethodID(type, render ? "rasterizeEmoji" : "measureEmoji",
                                             "([BLjava/lang/String;IIF)[I");
        const auto bytes = env->NewByteArray(static_cast<jsize>(text.size()));
        env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()),
                                reinterpret_cast<const jbyte*>(text.begin()));
        const auto font = env->NewStringUTF(path.c_str());
        const auto output = method ? static_cast<jintArray>(env->CallObjectMethod(
                                         activity, method, bytes, font, face_index, size, spacing))
                                   : nullptr;
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            throw std::runtime_error("Android emoji rasterization failed.");
        }
        if (!output || env->GetArrayLength(output) < (render ? 5 : 1))
            throw std::runtime_error("Invalid Android emoji result.");
        std::vector<jint> values(env->GetArrayLength(output));
        env->GetIntArrayRegion(output, 0, static_cast<jsize>(values.size()), values.data());
        EmojiData result;
        result.advance = values[0];
        if (!render)
            return result;
        result.origin = {values[1], values[2]};
        result.dimensions = {values[3], values[4]};
        const auto count = values.size() - 5;
        if (result.dimensions.x <= 0 || result.dimensions.y <= 0 ||
            static_cast<size_t>(result.dimensions.x) * result.dimensions.y != count) {
            throw std::runtime_error("Invalid Android emoji dimensions.");
        }
        result.pixels.resize(count * 4);
        for (size_t i = 0; i < count; ++i) {
            const auto argb = static_cast<std::uint32_t>(values[i + 5]);
            const auto alpha = argb >> 24;
            for (unsigned c = 0; c < 3; ++c)
                result.pixels[i * 4 + c] =
                    static_cast<Rml::byte>((((argb >> (16 - c * 8)) & 255) * alpha + 127) / 255);
            result.pixels[i * 4 + 3] = static_cast<Rml::byte>(alpha);
        }
        return result;
#else
        FontOwner<CFStringRef, &CFRelease> string(
            CFStringCreateWithBytes(
                kCFAllocatorDefault, reinterpret_cast<const UInt8*>(text.begin()),
                static_cast<CFIndex>(text.size()), kCFStringEncodingUTF8, false),
            CFRelease);
        FontOwner<CFNumberRef, &CFRelease> kern(
            CFNumberCreate(kCFAllocatorDefault, kCFNumberFloatType, &spacing), CFRelease);
        if (!string || !kern)
            throw std::runtime_error("CoreText emoji text allocation failed.");
        const void* keys[] = {kCTFontAttributeName, kCTKernAttributeName};
        const void* values[] = {apple_font(size), kern.get()};
        FontOwner<CFDictionaryRef, &CFRelease> attributes(
            CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks,
                               &kCFTypeDictionaryValueCallBacks),
            CFRelease);
        if (!attributes)
            throw std::runtime_error("CoreText emoji attributes allocation failed.");
        FontOwner<CFAttributedStringRef, &CFRelease> attributed(
            CFAttributedStringCreate(kCFAllocatorDefault, string.get(), attributes.get()),
            CFRelease);
        if (!attributed)
            throw std::runtime_error("CoreText emoji attributed string allocation failed.");
        FontOwner<CTLineRef, &CFRelease> line(CTLineCreateWithAttributedString(attributed.get()),
                                              CFRelease);
        if (!line)
            throw std::runtime_error("CoreText emoji layout failed.");
        const double advance = CTLineGetTypographicBounds(line.get(), nullptr, nullptr, nullptr);
        if (!std::isfinite(advance) || advance < 0 || advance > 1048576) {
            throw std::runtime_error("Invalid CoreText emoji advance.");
        }
        EmojiData result;
        result.advance = static_cast<int>(std::lround(advance));
        if (!render)
            return result;
        const CGRect bounds = CTLineGetImageBounds(line.get(), nullptr);
        if (CGRectIsNull(bounds) || CGRectIsInfinite(bounds) || CGRectIsEmpty(bounds)) {
            throw std::runtime_error("CoreText produced no emoji glyph image.");
        }
        const double left = std::floor(CGRectGetMinX(bounds)) - 1;
        const double top = std::ceil(CGRectGetMaxY(bounds)) + 1;
        const double width = std::ceil(CGRectGetMaxX(bounds)) + 1 - left;
        const double height = top - std::floor(CGRectGetMinY(bounds)) + 1;
        if (!std::isfinite(left) || !std::isfinite(top) || !std::isfinite(width) ||
            !std::isfinite(height) || std::abs(left) > 1048576 || std::abs(top) > 1048576 ||
            width <= 0 || height <= 0 || width > 16384 || height > 16384 ||
            width * height > 16 * 1024 * 1024) {
            throw std::runtime_error("Invalid CoreText emoji image bounds.");
        }
        result.origin = {static_cast<int>(left), -static_cast<int>(top)};
        result.dimensions = {static_cast<int>(width), static_cast<int>(height)};
        result.pixels.resize(static_cast<size_t>(result.dimensions.x) * result.dimensions.y * 4);
        FontOwner<CGColorSpaceRef, &CGColorSpaceRelease> color_space(
            CGColorSpaceCreateWithName(kCGColorSpaceSRGB), CGColorSpaceRelease);
        if (!color_space)
            throw std::runtime_error("CoreText emoji color space allocation failed.");
        FontOwner<CGContextRef, &CGContextRelease> context(
            CGBitmapContextCreate(result.pixels.data(), result.dimensions.x, result.dimensions.y, 8,
                                  static_cast<size_t>(result.dimensions.x) * 4, color_space.get(),
                                  static_cast<CGBitmapInfo>(kCGImageAlphaPremultipliedLast) |
                                      kCGBitmapByteOrder32Big),
            CGContextRelease);
        if (!context)
            throw std::runtime_error("CoreText emoji bitmap allocation failed.");
        CGContextSetTextPosition(context.get(), -left, height - top);
        CTLineDraw(line.get(), context.get());
        return result;
#endif
    }
    int advance(int size, Rml::StringView text, float spacing) {
        const RasterKey key{size, std::string(text.begin(), text.size()), spacing};
        if (const auto found = advances.find(key); found != advances.end())
            return found->second;
        return advances.emplace(key, emoji_data(size, text, spacing, false).advance).first->second;
    }
    Raster& raster(int size, Rml::StringView text, float spacing) {
        const RasterKey key{size, std::string(text.begin(), text.size()), spacing};
        if (const auto found = rasters.find(key); found != rasters.end())
            return found->second;
        auto data = emoji_data(size, text, spacing, true);
        Raster value{data.advance,
                     data.origin,
                     data.dimensions,
                     std::make_shared<const std::vector<Rml::byte>>(std::move(data.pixels)),
                     {}};
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
            glyph.bitmap_data = base.pixels->data();
            glyph.bitmap_dimensions = base.dimensions;
            glyph.color_format = Rml::ColorFormat::RGBA8;
            glyph.advance = base.advance;
            glyph.bearing = {base.origin.x, -base.origin.y};
            EffectRaster value{{0, 0}, base.dimensions, {}};
            if (!effect.GetGlyphMetrics(value.offset, value.dimensions, glyph))
                return;
            if (effect.HasUniqueTexture()) {
                std::vector<Rml::byte> pixels(static_cast<size_t>(value.dimensions.x) *
                                              value.dimensions.y * 4);
                effect.GenerateGlyphTexture(pixels.data(), value.dimensions, value.dimensions.x * 4,
                                            glyph);
                value.texture =
                    texture(std::make_shared<const std::vector<Rml::byte>>(std::move(pixels)),
                            value.dimensions);
            } else {
                auto pixels = *base.pixels;
                for (size_t i = 0; i < pixels.size(); i += 4)
                    pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3];
                value.dimensions = base.dimensions;
                value.texture =
                    texture(std::make_shared<const std::vector<Rml::byte>>(std::move(pixels)),
                            value.dimensions);
            }
            found = effect_rasters.emplace(key, std::move(value)).first;
        }
        const auto& value = found->second;
        meshes.emplace_back();
        meshes.back().texture = value.texture->GetTexture(manager);
        auto color = effect.GetColour();
        color.alpha =
            static_cast<Rml::byte>(std::clamp(std::lround(color.alpha * opacity), 0l, 255l));
        Rml::MeshUtilities::GenerateQuad(
            meshes.back().mesh, position + Rml::Vector2f(base.origin + value.offset),
            Rml::Vector2f(value.dimensions), color.ToPremultiplied(), {0, 0}, {1, 1});
    }

public:
    explicit ColorUiFontEngine(Rml::FontEngineInterface& fallback) : fallback(fallback) {}
    void Shutdown() override {
        ReleaseFontResources();
        fallback.Shutdown();
    }
    bool LoadFontFace(const Rml::String& file, int index, bool is_fallback,
                      Rml::Style::FontWeight weight) override {
        return fallback.LoadFontFace(file, index, is_fallback, weight);
    }
    bool LoadFontFace(Rml::Span<const Rml::byte> data, int index, const Rml::String& family,
                      Rml::Style::FontStyle style, Rml::Style::FontWeight weight,
                      bool is_fallback) override {
        return fallback.LoadFontFace(data, index, family, style, weight, is_fallback);
    }
    bool LoadFontFace(const Rml::String& file, int index, const Rml::String& family,
                      Rml::Style::FontStyle style, Rml::Style::FontWeight weight,
                      bool is_fallback) override {
        if (!fallback.LoadFontFace(file, index, family, style, weight, is_fallback))
            return false;
        register_characters(file, index, family == "bbl-emoji");
        if (family == "bbl-emoji") {
            path = file;
            face_index = index;
        }
        return true;
    }
    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String& family, Rml::Style::FontStyle style,
                                          Rml::Style::FontWeight weight, int size) override {
        const auto handle = fallback.GetFontFaceHandle(family, style, weight, size);
        if (handle)
            sizes.emplace(handle, size);
        if (handle && family == "bbl-emoji")
            color_faces.insert(handle);
        return handle;
    }
    Rml::FontEffectsHandle PrepareFontEffects(Rml::FontFaceHandle handle,
                                              const Rml::FontEffectList& list) override {
        const auto result = fallback.PrepareFontEffects(handle, list);
        effects.insert_or_assign(result, list);
        return result;
    }
    const Rml::FontMetrics& GetFontMetrics(Rml::FontFaceHandle handle) override {
        return fallback.GetFontMetrics(handle);
    }
    int GetStringWidth(Rml::FontFaceHandle handle, Rml::StringView text,
                       const Rml::TextShapingContext& context, Rml::Character prior) override {
        const auto found = sizes.find(handle);
        if (found == sizes.end())
            return fallback.GetStringWidth(handle, text, context, prior);
        int width = 0;
        spans(handle, text, [&](Rml::StringView span, bool color) {
            width += color ? advance(found->second, span, context.letter_spacing)
                           : fallback.GetStringWidth(handle, span, context, prior);
            prior = Rml::Character::Null;
        });
        return width;
    }
    int GenerateString(Rml::RenderManager& manager, Rml::FontFaceHandle handle,
                       Rml::FontEffectsHandle effect_handle, Rml::StringView text,
                       Rml::Vector2f position, Rml::ColourbPremultiplied color, float opacity,
                       const Rml::TextShapingContext& context,
                       Rml::TexturedMeshList& meshes) override {
        const auto found = sizes.find(handle);
        if (found == sizes.end())
            return fallback.GenerateString(manager, handle, effect_handle, text, position, color,
                                           opacity, context, meshes);
        int width = 0;
        spans(handle, text, [&](Rml::StringView span, bool is_color) {
            if (!is_color) {
                Rml::TexturedMeshList retained;
                const int advance =
                    fallback.GenerateString(manager, handle, effect_handle, span, position, color,
                                            opacity, context, retained);
                for (auto& mesh : retained)
                    meshes.push_back(std::move(mesh));
                width += advance;
                position.x += advance;
                return;
            }
            auto& value = raster(found->second, span, context.letter_spacing);
            const auto draw_effects = [&](Rml::FontEffect::Layer layer) {
                if (const auto list = effects.find(effect_handle); list != effects.end())
                    for (const auto& effect : list->second)
                        if (effect->GetLayer() == layer)
                            effect_mesh(manager, value, *effect, position, opacity, meshes);
            };
            draw_effects(Rml::FontEffect::Layer::Back);
            meshes.emplace_back();
            meshes.back().texture = value.texture->GetTexture(manager);
            Rml::MeshUtilities::GenerateQuad(
                meshes.back().mesh, position + Rml::Vector2f(value.origin),
                Rml::Vector2f(value.dimensions),
                Rml::ColourbPremultiplied(color.alpha, color.alpha, color.alpha, color.alpha),
                {0, 0}, {1, 1});
            draw_effects(Rml::FontEffect::Layer::Front);
            width += value.advance;
            position.x += value.advance;
        });
        return width;
    }
    int GetVersion(Rml::FontFaceHandle handle) override { return fallback.GetVersion(handle); }
    void ReleaseFontResources() override {
        effect_rasters.clear();
        rasters.clear();
        advances.clear();
        effects.clear();
        sizes.clear();
        color_faces.clear();
#if defined(SDL_PLATFORM_IOS)
        apple_fonts.clear();
#endif
        fallback.ReleaseFontResources();
    }
};
} // namespace bbl::pal
#endif
