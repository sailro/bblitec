#include <bblite/pal_locale.hpp>
#include <bblite/js_data.hpp>
#include <cstring>

#ifdef _WIN32
#include <icu.h>
#else
#include <unicode/ucol.h>
#include <unicode/uloc.h>
#include <unicode/unorm2.h>
#include <unicode/uenum.h>
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
using Enumeration = std::unique_ptr<UEnumeration, decltype(&uenum_close)>;

template <typename Fill>
std::string icu_string(Fill fill) {
    UErrorCode status = U_ZERO_ERROR;
    const auto length = fill(nullptr, 0, &status);
    if (status != U_BUFFER_OVERFLOW_ERROR) check_icu(status);
    std::string result(static_cast<std::size_t>(length) + 1, '\0');
    status = U_ZERO_ERROR;
    fill(result.data(), icu_length(result.size()), &status);
    check_icu(status);
    result.resize(static_cast<std::size_t>(length));
    return result;
}

std::string keyword(const std::string& id, const char* key) {
    return icu_string([&](char* output, int32_t capacity, UErrorCode* status) {
        return uloc_getKeywordValue(id.c_str(), key, output, capacity, status);
    });
}

void set_keyword(std::string& id, const char* key, const std::string& value) {
    id.resize(id.size() + std::strlen(key) + value.size() + 3, '\0');
    UErrorCode status = U_ZERO_ERROR;
    const auto length = uloc_setKeywordValue(key, value.empty() ? nullptr : value.c_str(), id.data(), icu_length(id.size()), &status);
    check_icu(status);
    id.resize(static_cast<std::size_t>(length));
}

const std::vector<const char*>& available_locales() {
    static const auto available = [] {
        std::vector<const char*> locales;
        for (int32_t index = 0; index < uloc_countAvailable(); ++index) locales.push_back(uloc_getAvailable(index));
        return locales;
    }();
    return available;
}

std::string match_locale(const std::string& requested, bool lookup) {
    const auto& available = available_locales();
    auto base = icu_string([&](char* output, int32_t capacity, UErrorCode* status) {
        return uloc_getBaseName(requested.c_str(), output, capacity, status);
    });
    if (lookup) {
        while (!base.empty()) {
            if (std::find(available.begin(), available.end(), base) != available.end()) return base;
            const auto separator = base.rfind('_');
            if (separator == std::string::npos) break;
            base.resize(separator);
        }
        return {};
    }
    UErrorCode status = U_ZERO_ERROR;
    Enumeration choices(uenum_openCharStringsEnumeration(available.data(), icu_length(available.size()), &status), &uenum_close);
    check_icu(status);
    UAcceptResult accepted = ULOC_ACCEPT_FAILED;
    const char* input = base.c_str();
    auto matched = icu_string([&](char* output, int32_t capacity, UErrorCode* error) {
        uenum_reset(choices.get(), error);
        return uloc_acceptLanguage(output, capacity, &accepted, &input, 1, choices.get(), error);
    });
    return accepted == ULOC_ACCEPT_FAILED ? std::string{} : matched;
}

bool supported_collation(const std::string& id, const std::string& collation) {
    if (collation.empty() || collation == "standard" || collation == "search") return false;
    UErrorCode status = U_ZERO_ERROR;
    Enumeration values(ucol_getKeywordValuesForLocale("collation", id.c_str(), false, &status), &uenum_close);
    check_icu(status);
    while (const char* value = uenum_next(values.get(), nullptr, &status)) {
        if (collation == value) return true;
    }
    check_icu(status);
    return false;
}

void validate_collation(const std::string& value) {
    std::size_t length = 0;
    for (const char character : value) {
        if (character == '-') {
            if (length < 3 || length > 8) throw std::runtime_error("Invalid collation type.");
            length = 0;
        } else if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9')) {
            ++length;
        } else throw std::runtime_error("Invalid collation type.");
    }
    if (length < 3 || length > 8) throw std::runtime_error("Invalid collation type.");
}

Collator make_collator(const std::vector<std::string>& locales, const CollationOptions& options) {
    // Canonicalize every requested tag before selection: an invalid later
    // entry still throws even when an earlier locale is supported.
    std::vector<std::string> requested;
    for (const auto& locale : locales) requested.push_back(locale_id(locale));
    const auto matcher = options.locale_matcher.value_or("best fit");
    if (matcher != "lookup" && matcher != "best fit") throw std::runtime_error("Invalid locale matcher.");
    const auto usage = options.usage.value_or("sort");
    if (usage != "sort" && usage != "search") throw std::runtime_error("Invalid collation usage.");
    if (options.collation) validate_collation(*options.collation);
    if (options.case_first && *options.case_first != "upper" && *options.case_first != "lower" && *options.case_first != "false")
        throw std::runtime_error("Invalid collation caseFirst.");
    std::string id = uloc_getDefault();
    std::string selected;
    for (const auto& locale : requested) {
        const auto matched = match_locale(locale, matcher == "lookup");
        if (matched.empty()) continue;
        id = matched;
        selected = locale;
        break;
    }
    // Only ECMA-402's supported Unicode extension keys affect a Collator.
    for (const auto* key : {"colnumeric", "colcasefirst"}) {
        const auto value = keyword(selected, key);
        const bool valid = std::string_view(key) == "colnumeric" ? value == "yes" || value == "no"
            : value == "upper" || value == "lower" || value == "no";
        if (valid) set_keyword(id, key, value);
    }
    const auto collation = options.collation ? std::string(uloc_toLegacyType("co", options.collation->c_str())) : keyword(selected, "collation");
    if (usage == "search") set_keyword(id, "collation", "search");
    else if (supported_collation(id, collation)) set_keyword(id, "collation", collation);
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
    if (options.case_first) ucol_setAttribute(collator.get(), UCOL_CASE_FIRST,
        *options.case_first == "upper" ? UCOL_UPPER_FIRST : *options.case_first == "lower" ? UCOL_LOWER_FIRST : UCOL_OFF, &status);
    if (options.ignore_punctuation) ucol_setAttribute(collator.get(), UCOL_ALTERNATE_HANDLING,
        *options.ignore_punctuation ? UCOL_SHIFTED : UCOL_NON_IGNORABLE, &status);
    // Ignore punctuation and spaces, retaining the significance of symbols.
    ucol_setMaxVariable(collator.get(), UCOL_REORDER_CODE_PUNCTUATION, &status);
    check_icu(status);
    return collator;
}

// Sorting repeatedly uses the same locale/options. Keep bounded per-thread
// state: ICU collators are mutable objects and must not cross worker realms.
UCollator* cached_collator(const std::vector<std::string>& locales, const CollationOptions& options) {
    struct Entry { std::vector<std::string> locales; CollationOptions options; Collator collator; };
    thread_local std::deque<Entry> cache;
    for (const auto& entry : cache) if (entry.locales == locales && entry.options == options) return entry.collator.get();
    auto collator = make_collator(locales, options);
    if (cache.size() == 8) cache.pop_front();
    cache.push_back({locales, options, std::move(collator)});
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
    const std::vector<std::string>& locales, const CollationOptions& options) {
    const auto* collator = cached_collator(locales, options);
    const auto a = js::string_code_units(left), b = js::string_code_units(right);
    return static_cast<double>(ucol_strcoll(collator, a.data(), icu_length(a.size()), b.data(), icu_length(b.size())));
}

}
