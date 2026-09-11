#include <bblite/pal_locale.hpp>
#include <bblite/js_data.hpp>

#ifdef _WIN32
#include <icu.h>
#else
#include <unicode/ucol.h>
#include <unicode/uloc.h>
#include <unicode/unorm2.h>
#endif

namespace bbl::pal {
namespace {

void check_icu(UErrorCode status) {
    if (U_FAILURE(status)) throw std::runtime_error(u_errorName(status));
}

int32_t icu_length(std::size_t size) {
    if (size > static_cast<std::size_t>(INT32_MAX)) throw std::runtime_error("String exceeds ICU's length limit.");
    return static_cast<int32_t>(size);
}

std::string locale_id(const std::string& locale) {
    const auto length = icu_length(locale.size());
    int32_t parsed = 0;
    UErrorCode status = U_ZERO_ERROR;
    const auto size = uloc_forLanguageTag(locale.c_str(), nullptr, 0, &parsed, &status);
    if (status != U_BUFFER_OVERFLOW_ERROR) check_icu(status);
    if (length == 0 || parsed != length) throw std::runtime_error("Invalid language tag.");
    std::string result(static_cast<std::size_t>(size) + 1, '\0');
    status = U_ZERO_ERROR;
    uloc_forLanguageTag(locale.c_str(), result.data(), icu_length(result.size()), nullptr, &status);
    check_icu(status);
    result.resize(static_cast<std::size_t>(size));
    return result;
}

using Collator = std::unique_ptr<UCollator, decltype(&ucol_close)>;

Collator make_collator(const std::optional<std::string>& locale, const CollationOptions& options) {
    const auto id = locale ? locale_id(*locale) : std::string(uloc_getDefault());
    UErrorCode status = U_ZERO_ERROR;
    Collator collator(ucol_open(id.c_str(), &status), &ucol_close);
    check_icu(status);
    const auto sensitivity = options.sensitivity.value_or("variant");
    const auto strength = sensitivity == "base" || sensitivity == "case" ? UCOL_PRIMARY
        : sensitivity == "accent" ? UCOL_SECONDARY : UCOL_TERTIARY;
    if (sensitivity != "base" && sensitivity != "case" && sensitivity != "accent" && sensitivity != "variant")
        throw std::runtime_error("Invalid collation sensitivity.");
    ucol_setAttribute(collator.get(), UCOL_STRENGTH, strength, &status);
    ucol_setAttribute(collator.get(), UCOL_CASE_LEVEL, sensitivity == "case" ? UCOL_ON : UCOL_OFF, &status);
    ucol_setAttribute(collator.get(), UCOL_NORMALIZATION_MODE, UCOL_ON, &status);
    if (options.numeric) ucol_setAttribute(collator.get(), UCOL_NUMERIC_COLLATION, *options.numeric ? UCOL_ON : UCOL_OFF, &status);
    check_icu(status);
    return collator;
}

// Sorting repeatedly uses the same locale/options. Keep bounded per-thread
// state: ICU collators are mutable objects and must not cross worker realms.
UCollator* cached_collator(const std::optional<std::string>& locale, const CollationOptions& options) {
    struct Entry { std::optional<std::string> locale; CollationOptions options; Collator collator; };
    thread_local std::deque<Entry> cache;
    for (const auto& entry : cache) if (entry.locale == locale && entry.options == options) return entry.collator.get();
    auto collator = make_collator(locale, options);
    if (cache.size() == 8) cache.pop_front();
    cache.push_back({locale, options, std::move(collator)});
    return cache.back().collator.get();
}

}

std::string normalize_string(const std::string& value, const std::string& form) {
    UErrorCode status = U_ZERO_ERROR;
    const auto* normalizer = form == "NFC" ? unorm2_getNFCInstance(&status)
        : form == "NFD" ? unorm2_getNFDInstance(&status)
        : form == "NFKC" ? unorm2_getNFKCInstance(&status)
        : form == "NFKD" ? unorm2_getNFKDInstance(&status) : nullptr;
    if (!normalizer) throw std::runtime_error("Invalid normalization form.");
    check_icu(status);
    const auto input = js::string_code_units(value);
    const auto length = icu_length(input.size());
    std::u16string output(input.size(), u'\0');
    const auto size = unorm2_normalize(normalizer, input.data(), length, output.data(), length, &status);
    if (status == U_BUFFER_OVERFLOW_ERROR) {
        output.resize(static_cast<std::size_t>(size));
        status = U_ZERO_ERROR;
        unorm2_normalize(normalizer, input.data(), length, output.data(), size, &status);
    }
    check_icu(status);
    output.resize(static_cast<std::size_t>(size));
    return js::string_from_code_units(output);
}

double compare_strings(const std::string& left, const std::string& right,
    const std::optional<std::string>& locale, const CollationOptions& options) {
    const auto* collator = cached_collator(locale, options);
    const auto a = js::string_code_units(left), b = js::string_code_units(right);
    return static_cast<double>(ucol_strcoll(collator, a.data(), icu_length(a.size()), b.data(), icu_length(b.size())));
}

}
