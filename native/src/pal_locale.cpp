#include <bblite/pal_locale.hpp>
#include <bblite/js_data.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <deque>
#include <limits>

#ifdef _WIN32
#include <icu.h>
#else
#include <unicode/ucal.h>
#include <unicode/ucol.h>
#include <unicode/udat.h>
#include <unicode/udatpg.h>
#include <unicode/uloc.h>
#include <unicode/ulistformatter.h>
#include <unicode/unorm2.h>
#include <unicode/uenum.h>
#include <unicode/unum.h>
#include <unicode/unumberformatter.h>
#include <unicode/unumsys.h>
#include <unicode/upluralrules.h>
#include <unicode/ustring.h>
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

/**
 * ICU's buffer protocol: `fill(output, capacity, status)` writes into a first
 * buffer of `capacity` units and, when ICU reports an overflow, into one sized
 * from the length it returned.
 */
template <typename Char, typename Fill>
std::basic_string<Char> icu_buffer(Fill fill, std::size_t capacity = 64) {
    std::basic_string<Char> result(capacity, Char{});
    UErrorCode status = U_ZERO_ERROR;
    auto length = fill(result.data(), icu_length(result.size()), &status);
    if (status == U_BUFFER_OVERFLOW_ERROR) {
        result.resize(static_cast<std::size_t>(length) + 1);
        status = U_ZERO_ERROR;
        length = fill(result.data(), icu_length(result.size()), &status);
    }
    check_icu(status);
    result.resize(static_cast<std::size_t>(length));
    return result;
}

/** Unicode language identifiers exclude BCP 47 extlangs and legacy/private-only tags. */
bool unicode_language_prefix(std::string_view tag) {
    const auto letters = [](std::string_view part) {
        return std::all_of(part.begin(), part.end(), [](char ch) {
            return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
        });
    };
    const auto digits = [](std::string_view part) {
        return std::all_of(part.begin(), part.end(),
                           [](char ch) { return ch >= '0' && ch <= '9'; });
    };
    const auto next = [&]() {
        const auto separator = tag.find('-');
        const auto part = tag.substr(0, separator);
        tag = separator == std::string_view::npos ? std::string_view{} : tag.substr(separator + 1);
        return part;
    };
    auto part = next();
    if (!letters(part) ||
        !((part.size() >= 2 && part.size() <= 3) || (part.size() >= 5 && part.size() <= 8)))
        return false;
    part = next();
    if (part.size() == 4 && letters(part))
        part = next();
    if ((part.size() == 2 && letters(part)) || (part.size() == 3 && digits(part)))
        part = next();
    // ICU validates the complete tag, including each variant's characters,
    // duplicates and extension grammar. Only its broader base grammar differs.
    while (!part.empty() && part.size() != 1) {
        if (!((part.size() >= 5 && part.size() <= 8) ||
              (part.size() == 4 && part.front() >= '0' && part.front() <= '9')))
            return false;
        part = next();
    }
    return true;
}

std::string locale_id(const std::string& locale) {
    if (!unicode_language_prefix(locale))
        throw std::runtime_error("Invalid language tag.");
    const auto length = icu_length(locale.size());
    int32_t parsed = 0;
    auto result = icu_buffer<char>([&](char* output, int32_t capacity, UErrorCode* status) {
        return uloc_forLanguageTag(locale.c_str(), output, capacity, &parsed, status);
    });
    if (length == 0 || parsed != length)
        throw std::runtime_error("Invalid language tag.");
    return result;
}

using IcuCollator = std::unique_ptr<UCollator, decltype(&ucol_close)>;
using Enumeration = std::unique_ptr<UEnumeration, decltype(&uenum_close)>;

std::string keyword(const std::string& id, const char* key) {
    return icu_buffer<char>([&](char* output, int32_t capacity, UErrorCode* status) {
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
    auto base = icu_buffer<char>([&](char* output, int32_t capacity, UErrorCode* status) {
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
    auto matched = icu_buffer<char>([&](char* output, int32_t capacity, UErrorCode* error) {
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

/** SetNumberFormatDigitOptions with roundingPriority "auto" and standard notation. */
struct DigitSettings {
    int32_t minimum_integer = 1;
    bool significant = false;
    int32_t minimum = 0;
    int32_t maximum = 3;
};

DigitSettings digit_settings(const std::optional<double>& minimum_integer_digits,
                             const std::optional<double>& minimum_fraction_digits,
                             const std::optional<double>& maximum_fraction_digits,
                             const std::optional<double>& minimum_significant_digits,
                             const std::optional<double>& maximum_significant_digits,
                             int32_t default_maximum_fraction) {
    DigitSettings digits;
    digits.minimum_integer = digit_option(minimum_integer_digits, 1, 21, 1);
    digits.significant = minimum_significant_digits || maximum_significant_digits;
    digits.maximum = default_maximum_fraction;
    if (digits.significant) {
        digits.minimum = digit_option(minimum_significant_digits, 1, 21, 1);
        digits.maximum = digit_option(maximum_significant_digits, digits.minimum, 21, 21);
    } else if (minimum_fraction_digits || maximum_fraction_digits) {
        const auto fraction = [](const std::optional<double>& value) -> std::optional<int32_t> {
            if (!value)
                return std::nullopt;
            return digit_option(value, 0, 100, 0);
        };
        const auto lower = fraction(minimum_fraction_digits);
        const auto upper = fraction(maximum_fraction_digits);
        if (!lower) {
            digits.minimum = std::min(digits.minimum, *upper);
            digits.maximum = *upper;
        } else if (!upper) {
            digits.minimum = *lower;
            digits.maximum = std::max(digits.maximum, *lower);
        } else if (*lower > *upper) {
            throw std::runtime_error("Number format fraction digits are out of range.");
        } else {
            digits.minimum = *lower;
            digits.maximum = *upper;
        }
    }
    return digits;
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
    const auto digits =
        digit_settings(options.minimum_integer_digits, options.minimum_fraction_digits,
                       options.maximum_fraction_digits, options.minimum_significant_digits,
                       options.maximum_significant_digits, style == "percent" ? 0 : 3);
    const auto minimum_integer = digits.minimum_integer;
    const bool significant = digits.significant;
    const auto minimum = digits.minimum, maximum = digits.maximum;
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

std::string format_double(const UNumberFormat* format, double value) {
    return js::string_from_code_units(
        icu_buffer<char16_t>([&](UChar* output, int32_t capacity, UErrorCode* status) {
            return unum_formatDouble(format, value, output, capacity, nullptr, status);
        }));
}

} // namespace

std::string format_number(double value, const std::vector<std::string>& locales,
                          const NumberFormatOptions& options) {
    thread_local LocaleCache<NumberFormatOptions, IcuNumberFormat> cache;
    return format_double(cache.get(locales, options, open_number_format), value);
}

NumberFormat make_number_format(const std::vector<std::string>& locales,
                                const NumberFormatOptions& options) {
    auto format = open_number_format(locales, options);
    return js::make_ref<NumberFormatState>(std::shared_ptr<void>(
        format.release(), [](void* value) { unum_close(static_cast<UNumberFormat*>(value)); }));
}

std::string number_format_format(const NumberFormat& format, double value) {
    return format_double(static_cast<const UNumberFormat*>(format->get()), value);
}

PluralRules make_plural_rules(const std::vector<std::string>& locales,
                              const PluralRulesOptions& options) {
    const auto id = resolve_locale(locales, options.locale_matcher).id;
    const auto type = options.type.value_or("cardinal");
    if (type != "cardinal" && type != "ordinal")
        throw std::runtime_error("Invalid plural rules type.");
    const auto digits =
        digit_settings(options.minimum_integer_digits, options.minimum_fraction_digits,
                       options.maximum_fraction_digits, options.minimum_significant_digits,
                       options.maximum_significant_digits, 3);
    // ResolvePlural selects over the number its digit options format, rounding half away from zero.
    std::string skeleton = "rounding-mode-half-up";
    if (digits.minimum_integer > 1)
        skeleton +=
            " integer-width/*" + std::string(static_cast<std::size_t>(digits.minimum_integer), '0');
    if (digits.significant)
        skeleton += " " + std::string(static_cast<std::size_t>(digits.minimum), '@') +
                    std::string(static_cast<std::size_t>(digits.maximum - digits.minimum), '#');
    else if (digits.maximum == 0)
        skeleton += " precision-integer";
    else
        skeleton += " ." + std::string(static_cast<std::size_t>(digits.minimum), '0') +
                    std::string(static_cast<std::size_t>(digits.maximum - digits.minimum), '#');
    const std::u16string skeleton_units(skeleton.begin(), skeleton.end());
    UErrorCode status = U_ZERO_ERROR;
    std::shared_ptr<void> rules(
        uplrules_openForType(
            id.c_str(), type == "ordinal" ? UPLURAL_TYPE_ORDINAL : UPLURAL_TYPE_CARDINAL, &status),
        [](void* value) { uplrules_close(static_cast<UPluralRules*>(value)); });
    check_icu(status);
    std::shared_ptr<void> numbers(
        unumf_openForSkeletonAndLocale(skeleton_units.data(), icu_length(skeleton_units.size()),
                                       id.c_str(), &status),
        [](void* value) { unumf_close(static_cast<UNumberFormatter*>(value)); });
    check_icu(status);
    return js::make_ref<PluralRulesState>(std::move(rules), std::move(numbers));
}

std::string plural_rules_select(const PluralRules& rules, double value) {
    if (!std::isfinite(value))
        return "other";
    UErrorCode status = U_ZERO_ERROR;
    const std::unique_ptr<UFormattedNumber, decltype(&unumf_closeResult)> formatted(
        unumf_openResult(&status), &unumf_closeResult);
    check_icu(status);
    unumf_formatDouble(static_cast<const UNumberFormatter*>(rules->numbers()), value,
                       formatted.get(), &status);
    check_icu(status);
    return js::string_from_code_units(
        icu_buffer<char16_t>([&](UChar* output, int32_t capacity, UErrorCode* error) {
            return uplrules_selectFormatted(static_cast<const UPluralRules*>(rules->get()),
                                            formatted.get(), output, capacity, error);
        }));
}

ListFormat make_list_format(const std::vector<std::string>& locales,
                            const ListFormatOptions& options) {
    const auto id = resolve_locale(locales, options.locale_matcher).id;
    const auto type = options.type.value_or("conjunction");
    const auto style = options.style.value_or("long");
    if (type != "conjunction" && type != "disjunction" && type != "unit")
        throw std::runtime_error("Invalid list format type.");
    if (style != "long" && style != "short" && style != "narrow")
        throw std::runtime_error("Invalid list format style.");
    UErrorCode status = U_ZERO_ERROR;
    std::shared_ptr<void> format(
        ulistfmt_openForType(id.c_str(),
                             type == "conjunction"   ? ULISTFMT_TYPE_AND
                             : type == "disjunction" ? ULISTFMT_TYPE_OR
                                                     : ULISTFMT_TYPE_UNITS,
                             style == "long"    ? ULISTFMT_WIDTH_WIDE
                             : style == "short" ? ULISTFMT_WIDTH_SHORT
                                                : ULISTFMT_WIDTH_NARROW,
                             &status),
        [](void* value) { ulistfmt_close(static_cast<UListFormatter*>(value)); });
    check_icu(status);
    return js::make_ref<ListFormatState>(std::move(format));
}

std::string list_format_format(const ListFormat& format, const js::Array<std::string>& values) {
    std::vector<std::u16string> units;
    units.reserve(values.size());
    for (const auto& value : values)
        units.push_back(js::string_code_units(value));
    std::vector<const UChar*> strings;
    std::vector<int32_t> lengths;
    for (const auto& text : units) {
        strings.push_back(text.data());
        lengths.push_back(icu_length(text.size()));
    }
    const auto* list = static_cast<const UListFormatter*>(format->get());
    return js::string_from_code_units(
        icu_buffer<char16_t>([&](UChar* output, int32_t capacity, UErrorCode* status) {
            return ulistfmt_format(list, strings.data(), lengths.data(), icu_length(units.size()),
                                   output, capacity, status);
        }));
}

namespace {

/** One component option: its value's skeleton letters, or a throw for a value outside `allowed`. */
std::string component_skeleton(const std::optional<std::string>& value, const char* name,
                               std::initializer_list<std::pair<const char*, const char*>> allowed) {
    if (!value)
        return {};
    for (const auto& [option, letters] : allowed)
        if (*value == option)
            return letters;
    throw std::runtime_error(std::string("Invalid date-time option ") + name + ".");
}

using IcuDateFormat = std::unique_ptr<UDateFormat, decltype(&udat_close)>;

struct DateFormatKey {
    DateTimeFormatOptions options;
    DateTimeComponents components;
    bool operator==(const DateFormatKey&) const = default;
};

/**
 * The pattern format the options select, in the requested zone (the host's
 * by default) and the proleptic Gregorian calendar; throws on invalid options.
 */
IcuDateFormat open_date_format(const std::vector<std::string>& locales,
                               const DateFormatKey& format_key) {
    const auto& [options, components] = format_key;
    auto [id, selected] = resolve_locale(locales, options.locale_matcher);
    // ECMA-402 reads the calendar and numbering system extension keys.
    for (const auto* key : {"calendar", "numbers"}) {
        const auto value = keyword(selected, key);
        if (!value.empty())
            set_keyword(id, key, value);
    }
    auto weekday = component_skeleton(options.weekday, "weekday",
                                      {{"narrow", "EEEEE"}, {"short", "EEE"}, {"long", "EEEE"}});
    const auto era = component_skeleton(options.era, "era",
                                        {{"narrow", "GGGGG"}, {"short", "G"}, {"long", "GGGG"}});
    auto year = component_skeleton(options.year, "year", {{"numeric", "y"}, {"2-digit", "yy"}});
    auto month = component_skeleton(options.month, "month",
                                    {{"numeric", "M"},
                                     {"2-digit", "MM"},
                                     {"narrow", "MMMMM"},
                                     {"short", "MMM"},
                                     {"long", "MMMM"}});
    auto day = component_skeleton(options.day, "day", {{"numeric", "d"}, {"2-digit", "dd"}});
    const char* hour_letter = !options.hour12 ? "j" : *options.hour12 ? "h" : "H";
    auto hour = component_skeleton(options.hour, "hour", {{"numeric", "1"}, {"2-digit", "2"}});
    auto minute =
        component_skeleton(options.minute, "minute", {{"numeric", "m"}, {"2-digit", "mm"}});
    auto second =
        component_skeleton(options.second, "second", {{"numeric", "s"}, {"2-digit", "ss"}});
    // ToDateTimeOptions: with none of the required components, add the defaults.
    const bool has_date = !weekday.empty() || !year.empty() || !month.empty() || !day.empty();
    const bool has_time = !hour.empty() || !minute.empty() || !second.empty();
    const bool needs_defaults = components == DateTimeComponents::date   ? !has_date
                                : components == DateTimeComponents::time ? !has_time
                                                                         : !has_date && !has_time;
    if (needs_defaults && components != DateTimeComponents::time)
        year = "y", month = "M", day = "d";
    if (needs_defaults && components != DateTimeComponents::date)
        hour = "1", minute = "m", second = "s";
    if (!hour.empty())
        hour = std::string(hour == "2" ? 2 : 1, hour_letter[0]);
    const auto skeleton = era + year + month + weekday + day + hour + minute + second;
    const std::u16string skeleton_units(skeleton.begin(), skeleton.end());
    UErrorCode status = U_ZERO_ERROR;
    const std::unique_ptr<UDateTimePatternGenerator, decltype(&udatpg_close)> generator(
        udatpg_open(id.c_str(), &status), &udatpg_close);
    check_icu(status);
    auto pattern = icu_buffer<char16_t>([&](UChar* output, int32_t capacity, UErrorCode* error) {
        return udatpg_getBestPatternWithOptions(
            generator.get(), skeleton_units.data(), icu_length(skeleton_units.size()),
            UDATPG_MATCH_HOUR_FIELD_LENGTH, output, capacity, error);
    });
    // V8 spells CLDR's narrow no-break space before a day period as a space.
    std::replace(pattern.begin(), pattern.end(), static_cast<char16_t>(0x202F), u' ');
    std::u16string zone;
    if (options.time_zone) {
        const auto requested = js::string_code_units(*options.time_zone);
        // This ICU call takes no preflight: a zone ID fits a fixed buffer.
        UBool system = false;
        zone.assign(128, u'\0');
        const auto length =
            ucal_getCanonicalTimeZoneID(requested.data(), icu_length(requested.size()), zone.data(),
                                        icu_length(zone.size()), &system, &status);
        if (U_FAILURE(status) || !system)
            throw std::runtime_error("Invalid time zone specified.");
        zone.resize(static_cast<std::size_t>(length));
    } else
        zone = js::string_code_units(*js::make_date_time_format());
    IcuDateFormat format(udat_open(UDAT_PATTERN, UDAT_PATTERN, id.c_str(), zone.data(),
                                   icu_length(zone.size()), pattern.data(),
                                   icu_length(pattern.size()), &status),
                         &udat_close);
    check_icu(status);
    // ECMA-402 time values use the proleptic Gregorian calendar.
    const std::unique_ptr<UCalendar, decltype(&ucal_close)> calendar(
        ucal_clone(udat_getCalendar(format.get()), &status), &ucal_close);
    check_icu(status);
    UErrorCode change = U_ZERO_ERROR;
    ucal_setGregorianChange(calendar.get(), -8.64e15, &change);
    if (U_SUCCESS(change))
        udat_setCalendar(format.get(), calendar.get());
    return format;
}

} // namespace

std::string format_date_time(const js::Date& date, const std::vector<std::string>& locales,
                             const DateTimeFormatOptions& options, DateTimeComponents components) {
    const double time = *date;
    if (std::isnan(time))
        return "Invalid Date";
    // A cached format keeps the host zone it opened in, as local time does.
    thread_local LocaleCache<DateFormatKey, IcuDateFormat> cache;
    const auto* format = cache.get(locales, DateFormatKey{options, components}, open_date_format);
    return js::string_from_code_units(
        icu_buffer<char16_t>([&](UChar* output, int32_t capacity, UErrorCode* status) {
            return udat_format(format, time, output, capacity, nullptr, status);
        }));
}

std::string locale_string_case(const std::string& value, const std::vector<std::string>& locales,
                               bool upper) {
    // Chromium validates only the first requested tag for case conversion and
    // passes its primary language to ICU, without region or extension keywords.
    const auto requested =
        locales.empty() ? std::string(uloc_getDefault()) : locale_id(locales.front());
    const auto locale = icu_buffer<char>([&](char* output, int32_t capacity, UErrorCode* status) {
        return uloc_getLanguage(requested.c_str(), output, capacity, status);
    });
    const auto input = js::string_code_units(value);
    const auto length = icu_length(input.size());
    const auto convert = upper ? &u_strToUpper : &u_strToLower;
    return js::string_from_code_units(icu_buffer<char16_t>(
        [&](UChar* output, int32_t capacity, UErrorCode* status) {
            return convert(output, capacity, input.data(), length, locale.c_str(), status);
        },
        input.size()));
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
    return js::string_from_code_units(icu_buffer<char16_t>(
        [&](UChar* output, int32_t capacity, UErrorCode* error) {
            return unorm2_normalize(normalizer, input.data(), length, output, capacity, error);
        },
        input.size()));
}

double local_time_zone_offset(double utc_milliseconds) {
    // One calendar per thread, opened in the zone Intl.DateTimeFormat resolves
    // when the thread first reads local time, and the last offset it answered:
    // a date's getters read one time value in turn.
    struct ZoneCalendar {
        std::unique_ptr<UCalendar, decltype(&ucal_close)> calendar{nullptr, &ucal_close};
        double time = std::numeric_limits<double>::quiet_NaN();
        double offset = 0.0;
    };
    thread_local ZoneCalendar cache;
    if (utc_milliseconds == cache.time)
        return cache.offset;
    UErrorCode status = U_ZERO_ERROR;
    if (!cache.calendar) {
        const auto id = js::string_code_units(*js::make_date_time_format());
        cache.calendar.reset(
            ucal_open(id.data(), icu_length(id.size()), "", UCAL_GREGORIAN, &status));
        check_icu(status);
    }
    ucal_setMillis(cache.calendar.get(), utc_milliseconds, &status);
    const auto standard = ucal_get(cache.calendar.get(), UCAL_ZONE_OFFSET, &status);
    const auto daylight = ucal_get(cache.calendar.get(), UCAL_DST_OFFSET, &status);
    check_icu(status);
    cache.time = utc_milliseconds;
    cache.offset = static_cast<double>(standard) + static_cast<double>(daylight);
    return cache.offset;
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
