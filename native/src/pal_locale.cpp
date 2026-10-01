#include <bblite/pal_locale.hpp>
#include <bblite/js_data.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <deque>

#ifdef _WIN32
#include <icu.h>
#else
#include <unicode/ucol.h>
#include <unicode/uloc.h>
#include <unicode/unorm2.h>
#include <unicode/uenum.h>
#include <unicode/unum.h>
#include <unicode/unumsys.h>
#endif

namespace bbl::pal {
namespace {

void check_icu(UErrorCode status) {
    if (U_FAILURE(status))
        throw std::runtime_error(u_errorName(status));
}

int32_t icu_length(std::size_t size) {
    if (size > static_cast<std::size_t>(INT32_MAX))
        throw std::runtime_error("String exceeds ICU's length limit.");
    return static_cast<int32_t>(size);
}

template <typename Fill> std::string icu_string(Fill fill) {
    UErrorCode status = U_ZERO_ERROR;
    const auto length = fill(nullptr, 0, &status);
    if (status != U_BUFFER_OVERFLOW_ERROR)
        check_icu(status);
    std::string result(static_cast<std::size_t>(length) + 1, '\0');
    status = U_ZERO_ERROR;
    fill(result.data(), icu_length(result.size()), &status);
    check_icu(status);
    result.resize(static_cast<std::size_t>(length));
    return result;
}

std::string locale_id(const std::string& locale) {
    const auto length = icu_length(locale.size());
    int32_t parsed = 0;
    auto result = icu_string([&](char* output, int32_t capacity, UErrorCode* status) {
        return uloc_forLanguageTag(locale.c_str(), output, capacity, &parsed, status);
    });
    if (length == 0 || parsed != length)
        throw std::runtime_error("Invalid language tag.");
    return result;
}

using IcuCollator = std::unique_ptr<UCollator, decltype(&ucol_close)>;
using Enumeration = std::unique_ptr<UEnumeration, decltype(&uenum_close)>;

std::string keyword(const std::string& id, const char* key) {
    return icu_string([&](char* output, int32_t capacity, UErrorCode* status) {
        return uloc_getKeywordValue(id.c_str(), key, output, capacity, status);
    });
}

void set_keyword(std::string& id, const char* key, const std::string& value) {
    id.resize(id.size() + std::strlen(key) + value.size() + 3, '\0');
    UErrorCode status = U_ZERO_ERROR;
    const auto length = uloc_setKeywordValue(key, value.empty() ? nullptr : value.c_str(),
                                             id.data(), icu_length(id.size()), &status);
    check_icu(status);
    id.resize(static_cast<std::size_t>(length));
}

const std::vector<const char*>& available_locales() {
    static const auto available = [] {
        std::vector<const char*> locales;
        for (int32_t index = 0; index < uloc_countAvailable(); ++index)
            locales.push_back(uloc_getAvailable(index));
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
            if (std::find(available.begin(), available.end(), base) != available.end())
                return base;
            const auto separator = base.rfind('_');
            if (separator == std::string::npos)
                break;
            base.resize(separator);
        }
        return {};
    }
    UErrorCode status = U_ZERO_ERROR;
    Enumeration choices(
        uenum_openCharStringsEnumeration(available.data(), icu_length(available.size()), &status),
        &uenum_close);
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
    if (collation.empty() || collation == "standard" || collation == "search")
        return false;
    UErrorCode status = U_ZERO_ERROR;
    Enumeration values(ucol_getKeywordValuesForLocale("collation", id.c_str(), false, &status),
                       &uenum_close);
    check_icu(status);
    while (const char* value = uenum_next(values.get(), nullptr, &status)) {
        if (collation == value)
            return true;
    }
    check_icu(status);
    return false;
}

void validate_collation(const std::string& value) {
    std::size_t length = 0;
    for (const char character : value) {
        if (character == '-') {
            if (length < 3 || length > 8)
                throw std::runtime_error("Invalid collation type.");
            length = 0;
        } else if ((character >= 'a' && character <= 'z') ||
                   (character >= 'A' && character <= 'Z') ||
                   (character >= '0' && character <= '9')) {
            ++length;
        } else
            throw std::runtime_error("Invalid collation type.");
    }
    if (length < 3 || length > 8)
        throw std::runtime_error("Invalid collation type.");
}

/** The ICU locale a request list resolves to, and the requested tag that selected it. */
struct ResolvedLocale {
    std::string id;
    std::string selected;
};

ResolvedLocale resolve_locale(const std::vector<std::string>& locales,
                              const std::optional<std::string>& locale_matcher) {
    // Canonicalize every requested tag before selection: an invalid later
    // entry still throws even when an earlier locale is supported.
    std::vector<std::string> requested;
    for (const auto& locale : locales)
        requested.push_back(locale_id(locale));
    const auto matcher = locale_matcher.value_or("best fit");
    if (matcher != "lookup" && matcher != "best fit")
        throw std::runtime_error("Invalid locale matcher.");
    for (const auto& locale : requested) {
        auto matched = match_locale(locale, matcher == "lookup");
        if (!matched.empty())
            return {std::move(matched), locale};
    }
    return {uloc_getDefault(), {}};
}

IcuCollator open_collator(const std::vector<std::string>& locales,
                          const CollationOptions& options) {
    auto [id, selected] = resolve_locale(locales, options.locale_matcher);
    const auto usage = options.usage.value_or("sort");
    if (usage != "sort" && usage != "search")
        throw std::runtime_error("Invalid collation usage.");
    if (options.collation)
        validate_collation(*options.collation);
    if (options.case_first && *options.case_first != "upper" && *options.case_first != "lower" &&
        *options.case_first != "false")
        throw std::runtime_error("Invalid collation caseFirst.");
    // Only ECMA-402's supported Unicode extension keys affect a Collator.
    for (const auto* key : {"colnumeric", "colcasefirst"}) {
        const auto value = keyword(selected, key);
        const bool valid = std::string_view(key) == "colnumeric"
                               ? value == "yes" || value == "no"
                               : value == "upper" || value == "lower" || value == "no";
        if (valid)
            set_keyword(id, key, value);
    }
    const auto collation = options.collation
                               ? std::string(uloc_toLegacyType("co", options.collation->c_str()))
                               : keyword(selected, "collation");
    if (usage == "search")
        set_keyword(id, "collation", "search");
    else if (supported_collation(id, collation))
        set_keyword(id, "collation", collation);
    UErrorCode status = U_ZERO_ERROR;
    IcuCollator collator(ucol_open(id.c_str(), &status), &ucol_close);
    check_icu(status);
    const auto sensitivity = options.sensitivity.value_or("variant");
    const auto strength = sensitivity == "base" || sensitivity == "case" ? UCOL_PRIMARY
                          : sensitivity == "accent"                      ? UCOL_SECONDARY
                                                                         : UCOL_TERTIARY;
    if (sensitivity != "base" && sensitivity != "case" && sensitivity != "accent" &&
        sensitivity != "variant")
        throw std::runtime_error("Invalid collation sensitivity.");
    ucol_setAttribute(collator.get(), UCOL_STRENGTH, strength, &status);
    ucol_setAttribute(collator.get(), UCOL_CASE_LEVEL, sensitivity == "case" ? UCOL_ON : UCOL_OFF,
                      &status);
    ucol_setAttribute(collator.get(), UCOL_NORMALIZATION_MODE, UCOL_ON, &status);
    if (options.numeric)
        ucol_setAttribute(collator.get(), UCOL_NUMERIC_COLLATION,
                          *options.numeric ? UCOL_ON : UCOL_OFF, &status);
    if (options.case_first)
        ucol_setAttribute(collator.get(), UCOL_CASE_FIRST,
                          *options.case_first == "upper"   ? UCOL_UPPER_FIRST
                          : *options.case_first == "lower" ? UCOL_LOWER_FIRST
                                                           : UCOL_OFF,
                          &status);
    if (options.ignore_punctuation)
        ucol_setAttribute(collator.get(), UCOL_ALTERNATE_HANDLING,
                          *options.ignore_punctuation ? UCOL_SHIFTED : UCOL_NON_IGNORABLE, &status);
    // Ignore punctuation and spaces, retaining the significance of symbols.
    ucol_setMaxVariable(collator.get(), UCOL_REORDER_CODE_PUNCTUATION, &status);
    check_icu(status);
    return collator;
}

using IcuNumberFormat = std::unique_ptr<UNumberFormat, decltype(&unum_close)>;

/** ECMA-402 DefaultNumberOption: absent is `fallback`, otherwise an integer in range. */
int32_t digit_option(const std::optional<double>& value, int32_t minimum, int32_t maximum,
                     int32_t fallback) {
    if (!value)
        return fallback;
    if (std::isnan(*value) || *value < minimum || *value > maximum)
        throw std::runtime_error("Number format digit option is out of range.");
    return static_cast<int32_t>(std::floor(*value));
}

/** A numbering system ECMA-402 admits: one ICU knows with a simple digit mapping. */
bool simple_numbering_system(const std::string& name) {
    UErrorCode status = U_ZERO_ERROR;
    const std::unique_ptr<UNumberingSystem, decltype(&unumsys_close)> system(
        unumsys_openByName(name.c_str(), &status), &unumsys_close);
    return U_SUCCESS(status) && system && !unumsys_isAlgorithmic(system.get());
}

IcuNumberFormat open_number_format(const std::vector<std::string>& locales,
                                   const NumberFormatOptions& options) {
    auto [id, selected] = resolve_locale(locales, options.locale_matcher);
    // The only Unicode extension key ECMA-402 gives a NumberFormat is nu.
    const auto numbers = keyword(selected, "numbers");
    if (!numbers.empty() && simple_numbering_system(numbers))
        set_keyword(id, "numbers", numbers);
    const auto style = options.style.value_or("decimal");
    if (style == "currency" || style == "unit")
        throw std::runtime_error("Number format style '" + style + "' is not supported natively.");
    if (style != "decimal" && style != "percent")
        throw std::runtime_error("Invalid number format style.");
    // SetNumberFormatDigitOptions with roundingPriority "auto" and standard notation.
    const auto minimum_integer = digit_option(options.minimum_integer_digits, 1, 21, 1);
    const bool significant =
        options.minimum_significant_digits || options.maximum_significant_digits;
    int32_t minimum = 0, maximum = style == "percent" ? 0 : 3;
    if (significant) {
        minimum = digit_option(options.minimum_significant_digits, 1, 21, 1);
        maximum = digit_option(options.maximum_significant_digits, minimum, 21, 21);
    } else if (options.minimum_fraction_digits || options.maximum_fraction_digits) {
        const auto fraction = [](const std::optional<double>& value) -> std::optional<int32_t> {
            if (!value)
                return std::nullopt;
            return digit_option(value, 0, 100, 0);
        };
        const auto lower = fraction(options.minimum_fraction_digits);
        const auto upper = fraction(options.maximum_fraction_digits);
        if (!lower) {
            minimum = std::min(minimum, *upper);
            maximum = *upper;
        } else if (!upper) {
            minimum = *lower;
            maximum = std::max(maximum, *lower);
        } else if (*lower > *upper) {
            throw std::runtime_error("Number format fraction digits are out of range.");
        } else {
            minimum = *lower;
            maximum = *upper;
        }
    }
    // GetBooleanOrStringNumberFormatOption: "true"/"false" strings select the default.
    auto grouping = options.use_grouping.value_or("auto");
    if (grouping == "true" || grouping == "false")
        grouping = "auto";
    if (!grouping.empty() && grouping != "always" && grouping != "auto" && grouping != "min2")
        throw std::runtime_error("Invalid number format useGrouping.");
    UErrorCode status = U_ZERO_ERROR;
    IcuNumberFormat format(unum_open(style == "percent" ? UNUM_PERCENT : UNUM_DECIMAL, nullptr, 0,
                                     id.c_str(), nullptr, &status),
                           &unum_close);
    check_icu(status);
    auto* handle = format.get();
    // ECMA-402 rounds half away from zero; ICU's default is half even.
    unum_setAttribute(handle, UNUM_ROUNDING_MODE, UNUM_ROUND_HALFUP);
    unum_setAttribute(handle, UNUM_MIN_INTEGER_DIGITS, minimum_integer);
    unum_setAttribute(handle, UNUM_SIGNIFICANT_DIGITS_USED, significant ? 1 : 0);
    unum_setAttribute(handle, significant ? UNUM_MAX_SIGNIFICANT_DIGITS : UNUM_MAX_FRACTION_DIGITS,
                      maximum);
    unum_setAttribute(handle, significant ? UNUM_MIN_SIGNIFICANT_DIGITS : UNUM_MIN_FRACTION_DIGITS,
                      minimum);
    unum_setAttribute(handle, UNUM_GROUPING_USED, grouping.empty() ? 0 : 1);
    // A DecimalFormat groups from the first separator; "auto" and "min2" read the locale.
    if (!grouping.empty())
        unum_setAttribute(handle, UNUM_MINIMUM_GROUPING_DIGITS,
                          grouping == "always" ? 1
                          : grouping == "auto" ? -2 /* UNUM_MINIMUM_GROUPING_DIGITS_AUTO */
                                               : -3 /* UNUM_MINIMUM_GROUPING_DIGITS_MIN2 */);
    return format;
}

// Sorting and formatting repeatedly use the same locale/options. Keep bounded
// per-thread state: ICU collators and formatters are mutable objects and must
// not cross worker realms.
template <typename Options, typename Handle> class LocaleCache {
public:
    template <typename Open>
    auto* get(const std::vector<std::string>& locales, const Options& options, Open open) {
        for (const auto& entry : entries_)
            if (entry.locales == locales && entry.options == options)
                return entry.handle.get();
        auto handle = open(locales, options);
        if (entries_.size() == 8)
            entries_.pop_front();
        entries_.push_back({locales, options, std::move(handle)});
        return entries_.back().handle.get();
    }

private:
    struct Entry {
        std::vector<std::string> locales;
        Options options;
        Handle handle;
    };
    std::deque<Entry> entries_;
};

UCollator* cached_collator(const std::vector<std::string>& locales,
                           const CollationOptions& options) {
    thread_local LocaleCache<CollationOptions, IcuCollator> cache;
    return cache.get(locales, options, open_collator);
}

} // namespace

std::string format_number(double value, const std::vector<std::string>& locales,
                          const NumberFormatOptions& options) {
    thread_local LocaleCache<NumberFormatOptions, IcuNumberFormat> cache;
    const auto* format = cache.get(locales, options, open_number_format);
    UErrorCode status = U_ZERO_ERROR;
    std::u16string output(32, u'\0');
    auto length = unum_formatDouble(format, value, output.data(), icu_length(output.size()),
                                    nullptr, &status);
    if (status == U_BUFFER_OVERFLOW_ERROR) {
        output.resize(static_cast<std::size_t>(length));
        status = U_ZERO_ERROR;
        length = unum_formatDouble(format, value, output.data(), length, nullptr, &status);
    }
    check_icu(status);
    output.resize(static_cast<std::size_t>(length));
    return js::string_from_code_units(output);
}

std::string normalize_string(const std::string& value, const std::string& form) {
    UErrorCode status = U_ZERO_ERROR;
    const auto* normalizer = form == "NFC"    ? unorm2_getNFCInstance(&status)
                             : form == "NFD"  ? unorm2_getNFDInstance(&status)
                             : form == "NFKC" ? unorm2_getNFKCInstance(&status)
                             : form == "NFKD" ? unorm2_getNFKDInstance(&status)
                                              : nullptr;
    if (!normalizer)
        throw std::runtime_error("Invalid normalization form.");
    check_icu(status);
    const auto input = js::string_code_units(value);
    const auto length = icu_length(input.size());
    std::u16string output(input.size(), u'\0');
    const auto size =
        unorm2_normalize(normalizer, input.data(), length, output.data(), length, &status);
    if (status == U_BUFFER_OVERFLOW_ERROR) {
        output.resize(static_cast<std::size_t>(size));
        status = U_ZERO_ERROR;
        unorm2_normalize(normalizer, input.data(), length, output.data(), size, &status);
    }
    check_icu(status);
    output.resize(static_cast<std::size_t>(size));
    return js::string_from_code_units(output);
}

namespace {

double collate(const UCollator* collator, const std::string& left, const std::string& right) {
    const auto a = js::string_code_units(left), b = js::string_code_units(right);
    return static_cast<double>(
        ucol_strcoll(collator, a.data(), icu_length(a.size()), b.data(), icu_length(b.size())));
}

} // namespace

Collator make_collator(const std::vector<std::string>& locales, const CollationOptions& options) {
    // The constructor resolves its locale and options, throwing where they
    // are invalid; the collator it opens serves every compare.
    auto collator = open_collator(locales, options);
    return js::make_ref<CollatorState>(std::shared_ptr<void>(
        collator.release(), [](void* value) { ucol_close(static_cast<UCollator*>(value)); }));
}

double collator_compare(const Collator& collator, const std::string& left,
                        const std::string& right) {
    return collate(static_cast<const UCollator*>(collator->get()), left, right);
}

double compare_strings(const std::string& left, const std::string& right,
                       const std::vector<std::string>& locales, const CollationOptions& options) {
    return collate(cached_collator(locales, options), left, right);
}

} // namespace bbl::pal
