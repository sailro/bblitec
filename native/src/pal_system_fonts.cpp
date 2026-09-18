#include <bblite/pal_system_fonts.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <map>
#include <vector>

#if defined(__APPLE__)
#include <ft2build.h>
#include FT_FREETYPE_H
#include <memory>
#include <type_traits>
#endif

#if defined(_WIN32)
#include <dwrite.h>
#include <wrl/client.h>

#include "pal_win32_text.hpp"
#elif defined(__ANDROID__)
#include "pal_freetype.hpp"
#include <android/font.h>
#include <android/font_matcher.h>
#include <android/system_fonts.h>
#include FT_MULTIPLE_MASTERS_H
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreText/CoreText.h>
#else
#include <fontconfig/fontconfig.h>
#endif

namespace bbl::pal {
namespace {

#if defined(_WIN32)

using Microsoft::WRL::ComPtr;

IDWriteFontCollection* system_font_collection() {
    static const ComPtr<IDWriteFontCollection> collection = [] {
        ComPtr<IDWriteFactory> factory;
        if (FAILED(DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED,
                __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown**>(factory.GetAddressOf())))) {
            return ComPtr<IDWriteFontCollection>{};
        }
        ComPtr<IDWriteFontCollection> result;
        if (FAILED(factory->GetSystemFontCollection(&result, false))) {
            return ComPtr<IDWriteFontCollection>{};
        }
        return result;
    }();
    return collection.Get();
}

std::optional<SystemFontFace> find_platform_font(
    std::string_view family,
    int weight) {
    IDWriteFontCollection* collection = system_font_collection();
    if (!collection) return std::nullopt;

    const std::optional<std::wstring> wide_family = utf8_to_wide(family);
    if (!wide_family) return std::nullopt;
    std::uint32_t family_index = 0;
    BOOL exists = false;
    if (FAILED(collection->FindFamilyName(
            wide_family->c_str(),
            &family_index,
            &exists)) ||
        !exists) {
        return std::nullopt;
    }

    ComPtr<IDWriteFontFamily> font_family;
    if (FAILED(collection->GetFontFamily(family_index, &font_family))) {
        return std::nullopt;
    }
    ComPtr<IDWriteFont> font;
    if (FAILED(font_family->GetFirstMatchingFont(
            static_cast<DWRITE_FONT_WEIGHT>(std::clamp(weight, 1, 999)),
            DWRITE_FONT_STRETCH_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            &font))) {
        return std::nullopt;
    }
    ComPtr<IDWriteFontFace> face;
    if (FAILED(font->CreateFontFace(&face))) return std::nullopt;

    std::uint32_t file_count = 0;
    if (FAILED(face->GetFiles(&file_count, nullptr)) || file_count == 0) {
        return std::nullopt;
    }
    std::vector<ComPtr<IDWriteFontFile>> owned_files(file_count);
    std::vector<IDWriteFontFile*> files(file_count, nullptr);
    if (FAILED(face->GetFiles(&file_count, files.data()))) {
        return std::nullopt;
    }
    for (std::size_t index = 0; index < files.size(); ++index) {
        owned_files[index].Attach(files[index]);
    }

    const void* reference_key = nullptr;
    std::uint32_t reference_key_size = 0;
    if (FAILED(owned_files.front()->GetReferenceKey(
            &reference_key,
            &reference_key_size))) {
        return std::nullopt;
    }
    ComPtr<IDWriteFontFileLoader> loader;
    if (FAILED(owned_files.front()->GetLoader(&loader))) {
        return std::nullopt;
    }
    ComPtr<IDWriteLocalFontFileLoader> local_loader;
    if (FAILED(loader.As(&local_loader))) return std::nullopt;

    std::uint32_t path_length = 0;
    if (FAILED(local_loader->GetFilePathLengthFromKey(
            reference_key,
            reference_key_size,
            &path_length))) {
        return std::nullopt;
    }
    std::wstring path(path_length + 1, L'\0');
    if (FAILED(local_loader->GetFilePathFromKey(
            reference_key,
            reference_key_size,
            path.data(),
            static_cast<std::uint32_t>(path.size())))) {
        return std::nullopt;
    }
    path.resize(path_length);
    return SystemFontFace{
        std::filesystem::path(std::move(path)),
        std::string(family),
        static_cast<int>(face->GetIndex())};
}

#elif defined(__ANDROID__)

std::optional<SystemFontFace> android_font_face(const AFont* font, int weight) {
    if (!font) return std::nullopt;
    const char* path = AFont_getFontFilePath(font);
    if (!path) return std::nullopt;
    const auto library = platform_font_library();
    if (!library) return std::nullopt;
    FT_Face raw_face = nullptr;
    const auto collection_index = AFont_getCollectionIndex(font);
    if (FT_New_Face(library, path, collection_index, &raw_face)) return std::nullopt;
    FontOwner<FT_Face, &FT_Done_Face> face(raw_face, FT_Done_Face);
    if (!face->family_name) return std::nullopt;
    int index = static_cast<int>(collection_index);
    // RmlUi accepts FreeType's face index, including a variable font's named
    // instance in its high bits. Preserve the requested weight when available.
    FT_MM_Var* variations = nullptr;
    if (!FT_Get_MM_Var(face.get(), &variations)) {
        int distance = std::numeric_limits<int>::max();
        for (FT_UInt axis = 0; axis < variations->num_axis; ++axis) {
            if (variations->axis[axis].tag != FT_MAKE_TAG('w', 'g', 'h', 't')) continue;
            for (FT_UInt style = 0; style < variations->num_namedstyles; ++style) {
                const int candidate = static_cast<int>(variations->namedstyle[style].coords[axis] / 65536);
                const int difference = std::abs(candidate - weight);
                if (difference < distance) {
                    distance = difference;
                    index = static_cast<int>(collection_index | ((style + 1) << 16));
                }
            }
        }
        FT_Done_MM_Var(library, variations);
    }
    return SystemFontFace{path, face->family_name, index};
}

std::optional<SystemFontFace> find_platform_font(std::string_view family, int weight) {
    if (family == "sans-serif" || family == "serif" || family == "monospace") {
        FontOwner<AFontMatcher*, &AFontMatcher_destroy> matcher(AFontMatcher_create(), AFontMatcher_destroy);
        if (!matcher) return std::nullopt;
        AFontMatcher_setStyle(matcher.get(), static_cast<std::uint16_t>(std::clamp(weight, 1, 1000)), false);
        const std::uint16_t text[] = {'A'};
        FontOwner<AFont*, &AFont_close> font(
            AFontMatcher_match(matcher.get(), std::string(family).c_str(), text, 1, nullptr), AFont_close);
        return android_font_face(font.get(), weight);
    }
    // Named fallback families must actually exist; the matcher otherwise
    // returns its default font even for a missing emoji or symbol family.
    struct NamedFont {
        FontOwner<AFont*, &AFont_close> font;
        std::string family;
    };
    static const auto fonts = [] {
        std::vector<NamedFont> result;
        const auto library = platform_font_library();
        FontOwner<ASystemFontIterator*, &ASystemFontIterator_close> iterator(
            ASystemFontIterator_open(), ASystemFontIterator_close);
        if (!iterator || !library) return result;
        while (AFont* next = ASystemFontIterator_next(iterator.get())) {
            FontOwner<AFont*, &AFont_close> font(next, AFont_close);
            if (AFont_isItalic(font.get())) continue;
            FT_Face raw_face = nullptr;
            if (FT_New_Face(library, AFont_getFontFilePath(font.get()), AFont_getCollectionIndex(font.get()), &raw_face)) continue;
            FontOwner<FT_Face, &FT_Done_Face> face(raw_face, FT_Done_Face);
            if (face->family_name) result.push_back({std::move(font), face->family_name});
        }
        return result;
    }();
    const AFont* best = nullptr;
    int distance = std::numeric_limits<int>::max();
    for (const auto& candidate : fonts) {
        if (candidate.family != family) continue;
        const int difference = std::abs(static_cast<int>(AFont_getWeight(candidate.font.get())) - weight);
        if (difference < distance) {
            best = candidate.font.get();
            distance = difference;
            if (distance == 0) break;
        }
    }
    return android_font_face(best, weight);
}

#elif defined(__APPLE__)

template <typename T>
class CfRef {
public:
    explicit CfRef(T value = nullptr) : value(value) {}
    ~CfRef() {
        if (value) CFRelease(value);
    }
    CfRef(const CfRef&) = delete;
    CfRef& operator=(const CfRef&) = delete;
    T get() const { return value; }

private:
    T value;
};

std::string cf_string(CFStringRef value) {
    if (!value) return {};
    const CFIndex maximum = CFStringGetMaximumSizeForEncoding(
        CFStringGetLength(value),
        kCFStringEncodingUTF8);
    if (maximum < 0) return {};
    std::string result(static_cast<std::size_t>(maximum) + 1, '\0');
    if (!CFStringGetCString(
            value,
            result.data(),
            static_cast<CFIndex>(result.size()),
            kCFStringEncodingUTF8)) {
        return {};
    }
    result.resize(std::char_traits<char>::length(result.c_str()));
    return result;
}

std::optional<SystemFontFace> find_platform_font(
    std::string_view family,
    int weight) {
    const std::string family_string(family);
    CfRef<CFStringRef> family_name(CFStringCreateWithCString(
        kCFAllocatorDefault,
        family_string.c_str(),
        kCFStringEncodingUTF8));
    if (!family_name.get()) return std::nullopt;

    const float normalized_weight = std::clamp(
        (static_cast<float>(weight) - 400.0f) / 500.0f,
        -1.0f,
        1.0f);
    CfRef<CFNumberRef> weight_value(CFNumberCreate(
        kCFAllocatorDefault,
        kCFNumberFloatType,
        &normalized_weight));
    if (!weight_value.get()) return std::nullopt;
    const void* trait_keys[] = {kCTFontWeightTrait};
    const void* trait_values[] = {weight_value.get()};
    CfRef<CFDictionaryRef> traits(CFDictionaryCreate(
        kCFAllocatorDefault,
        trait_keys,
        trait_values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks));
    if (!traits.get()) return std::nullopt;
    const void* attribute_keys[] = {
        kCTFontFamilyNameAttribute,
        kCTFontTraitsAttribute};
    const void* attribute_values[] = {family_name.get(), traits.get()};
    CfRef<CFDictionaryRef> attributes(CFDictionaryCreate(
        kCFAllocatorDefault,
        attribute_keys,
        attribute_values,
        2,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks));
    if (!attributes.get()) return std::nullopt;
    CfRef<CTFontDescriptorRef> descriptor(
        CTFontDescriptorCreateWithAttributes(attributes.get()));
    if (!descriptor.get()) return std::nullopt;
    CfRef<CTFontRef> font(
        CTFontCreateWithFontDescriptor(descriptor.get(), 16.0, nullptr));
    if (!font.get()) return std::nullopt;
    CfRef<CTFontDescriptorRef> resolved(CTFontCopyFontDescriptor(font.get()));
    if (!resolved.get()) return std::nullopt;
    CfRef<CFURLRef> url(static_cast<CFURLRef>(
        CTFontDescriptorCopyAttribute(resolved.get(), kCTFontURLAttribute)));
    if (!url.get()) return std::nullopt;
    CfRef<CFStringRef> path(CFURLCopyFileSystemPath(
        url.get(),
        kCFURLPOSIXPathStyle));
    CfRef<CFStringRef> resolved_family(CTFontCopyFamilyName(font.get()));
    if (!path.get() || !resolved_family.get()) return std::nullopt;

    // CoreText exposes the file and PostScript name, but no public collection
    // index attribute. Resolve that name in the same FreeType face order the
    // UI loader consumes, rather than choosing the first face of a TTC.
    CfRef<CFStringRef> postscript_name(CTFontCopyPostScriptName(font.get()));
    if (!postscript_name.get()) return std::nullopt;
    const auto filename = cf_string(path.get());
    const auto postscript = cf_string(postscript_name.get());
    FT_Library raw_library = nullptr;
    if (FT_Init_FreeType(&raw_library)) return std::nullopt;
    const std::unique_ptr<std::remove_pointer_t<FT_Library>, decltype(&FT_Done_FreeType)>
        library(raw_library, FT_Done_FreeType);
    FT_Long face_count = 1;
    for (FT_Long face_index = 0; face_index < face_count; ++face_index) {
        FT_Face raw_face = nullptr;
        if (FT_New_Face(library.get(), filename.c_str(), face_index, &raw_face)) return std::nullopt;
        const std::unique_ptr<std::remove_pointer_t<FT_Face>, decltype(&FT_Done_Face)>
            face(raw_face, FT_Done_Face);
        face_count = std::min(face->num_faces, static_cast<FT_Long>(std::numeric_limits<int>::max()));
        const char* name = FT_Get_Postscript_Name(face.get());
        if (name && postscript == name) {
            return SystemFontFace{
                std::filesystem::path(filename), cf_string(resolved_family.get()),
                static_cast<int>(face_index)};
        }
    }
    return std::nullopt;
}

#else

int fontconfig_weight(int weight) {
    if (weight <= 200) return FC_WEIGHT_EXTRALIGHT;
    if (weight <= 300) return FC_WEIGHT_LIGHT;
    if (weight <= 500) return FC_WEIGHT_REGULAR;
    if (weight <= 600) return FC_WEIGHT_DEMIBOLD;
    if (weight <= 700) return FC_WEIGHT_BOLD;
    return FC_WEIGHT_BLACK;
}

std::optional<SystemFontFace> find_platform_font(
    std::string_view family,
    int weight) {
    if (!FcInit()) return std::nullopt;
    FcPattern* pattern = FcPatternCreate();
    if (!pattern) return std::nullopt;
    const std::string family_string(family);
    FcPatternAddString(
        pattern,
        FC_FAMILY,
        reinterpret_cast<const FcChar8*>(family_string.c_str()));
    FcPatternAddInteger(pattern, FC_WEIGHT, fontconfig_weight(weight));
    FcPatternAddInteger(pattern, FC_SLANT, FC_SLANT_ROMAN);
    FcConfigSubstitute(nullptr, pattern, FcMatchPattern);
    FcDefaultSubstitute(pattern);
    FcResult result = FcResultNoMatch;
    FcPattern* match = FcFontMatch(nullptr, pattern, &result);
    FcPatternDestroy(pattern);
    if (!match) return std::nullopt;

    FcChar8* file = nullptr;
    FcChar8* resolved_family = nullptr;
    int face_index = 0;
    const bool valid =
        FcPatternGetString(match, FC_FILE, 0, &file) == FcResultMatch &&
        FcPatternGetString(match, FC_FAMILY, 0, &resolved_family) ==
            FcResultMatch;
    FcPatternGetInteger(match, FC_INDEX, 0, &face_index);
    std::optional<SystemFontFace> font;
    if (valid) {
        font = SystemFontFace{
            reinterpret_cast<const char*>(file),
            reinterpret_cast<const char*>(resolved_family),
            face_index};
    }
    FcPatternDestroy(match);
    return font;
}

#endif

} // namespace

std::optional<SystemFontFace> find_system_font(
    std::string_view family,
    int weight) {
    if (family.empty()) return std::nullopt;
#ifdef __ANDROID__
    static thread_local std::map<std::pair<std::string, int>, std::optional<SystemFontFace>> fonts;
    const auto key = std::pair{std::string(family), weight};
    const auto found = fonts.find(key);
    if (found != fonts.end()) return found->second;
    return fonts.emplace(key, find_platform_font(family, weight)).first->second;
#else
    return find_platform_font(family, weight);
#endif
}

} // namespace bbl::pal
