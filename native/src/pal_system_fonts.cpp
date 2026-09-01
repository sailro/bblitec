#include <bblite/pal_system_fonts.hpp>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <vector>

#if defined(_WIN32)
#include <dwrite.h>
#include <wrl/client.h>
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

std::optional<std::wstring> utf8_to_wide(std::string_view value) {
    if (value.size() > static_cast<std::size_t>(
                           (std::numeric_limits<int>::max)())) {
        return std::nullopt;
    }
    const int input_size = static_cast<int>(value.size());
    const int output_size = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        value.data(),
        input_size,
        nullptr,
        0);
    if (output_size <= 0) return std::nullopt;

    std::wstring result(static_cast<std::size_t>(output_size), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8,
            MB_ERR_INVALID_CHARS,
            value.data(),
            input_size,
            result.data(),
            output_size) != output_size) {
        return std::nullopt;
    }
    return result;
}

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

    int face_index = 0;
    CfRef<CFNumberRef> index(static_cast<CFNumberRef>(
        CTFontDescriptorCopyAttribute(resolved.get(), kCTFontIndexAttribute)));
    if (index.get()) {
        CFNumberGetValue(index.get(), kCFNumberIntType, &face_index);
    }
    return SystemFontFace{
        std::filesystem::path(cf_string(path.get())),
        cf_string(resolved_family.get()),
        face_index};
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
    return find_platform_font(family, weight);
}

} // namespace bbl::pal
