#pragma once

#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include <bblite/js_data.hpp>

namespace bbl::pal {

struct CollationOptions {
    std::optional<bool> numeric;
    std::optional<std::string> sensitivity;
    std::optional<std::string> usage;
    std::optional<std::string> locale_matcher;
    std::optional<std::string> collation;
    std::optional<std::string> case_first;
    std::optional<bool> ignore_punctuation;
    bool operator==(const CollationOptions&) const = default;
};

[[nodiscard]] std::string normalize_string(const std::string& value, const std::string& form);
[[nodiscard]] std::string locale_string_case(const std::string& value,
                                             const std::vector<std::string>& locales, bool upper);
[[nodiscard]] double compare_strings(const std::string& left, const std::string& right,
                                     const std::vector<std::string>& locales,
                                     const CollationOptions& options);

/** Milliseconds the host time zone adds to UTC at a time value, daylight saving included. */
[[nodiscard]] double local_time_zone_offset(double utc_milliseconds);

/** A local-time Date getter: the field of LocalTime(t) in the host time zone. */
[[nodiscard]] inline double date_local_field(const js::Date& date, js::DateField field) {
    const double time = *date;
    return std::isnan(time) ? time
                            : js::date_time_field(time + local_time_zone_offset(time), field);
}

/** `Date.prototype.getTimezoneOffset`: (t - LocalTime(t)) in minutes. */
[[nodiscard]] inline double date_time_zone_offset(const js::Date& date) {
    const double time = *date;
    return std::isnan(time) ? time : (time - (time + local_time_zone_offset(time))) / 60000.0;
}

[[nodiscard]] inline std::vector<std::string> requested_locales(std::nullopt_t) { return {}; }
[[nodiscard]] inline std::vector<std::string> requested_locales(const std::string& locale) {
    return {locale};
}
[[nodiscard]] inline std::vector<std::string>
requested_locales(const js::Array<std::string>& locales) {
    return {locales.begin(), locales.end()};
}
template <typename T>
[[nodiscard]] std::vector<std::string> requested_locales(const std::optional<T>& locales) {
    return locales ? requested_locales(*locales) : std::vector<std::string>{};
}

/** The `Intl.NumberFormat` options `Number.prototype.toLocaleString` reads. */
struct NumberFormatOptions {
    std::optional<std::string> locale_matcher;
    std::optional<std::string> style;
    std::optional<double> minimum_integer_digits;
    std::optional<double> minimum_fraction_digits;
    std::optional<double> maximum_fraction_digits;
    std::optional<double> minimum_significant_digits;
    std::optional<double> maximum_significant_digits;
    /** `"always"` for true, empty for a falsy value, otherwise the string given. */
    std::optional<std::string> use_grouping;
    bool operator==(const NumberFormatOptions&) const = default;
};

[[nodiscard]] inline std::optional<std::string> grouping_option(std::nullopt_t) {
    return std::nullopt;
}
[[nodiscard]] inline std::optional<std::string> grouping_option(bool value) {
    return value ? std::string("always") : std::string();
}
[[nodiscard]] inline std::optional<std::string> grouping_option(const std::string& value) {
    return value;
}
template <typename T>
[[nodiscard]] std::optional<std::string> grouping_option(const std::optional<T>& value) {
    return value ? grouping_option(*value) : std::nullopt;
}

/** `Number.prototype.toLocaleString(locales, options)`; throws where it would. */
[[nodiscard]] std::string format_number(double value, const std::vector<std::string>& locales,
                                        const NumberFormatOptions& options);

/** An `Intl.Collator`: the ICU collator its locales and options resolved to, opened once. */
class CollatorState {
public:
    explicit CollatorState(std::shared_ptr<void> collator) : collator_(std::move(collator)) {}
    [[nodiscard]] const void* get() const { return collator_.get(); }

private:
    std::shared_ptr<void> collator_;
};
using Collator = js::Ref<CollatorState>;

/** `new Intl.Collator(locales, options)`; throws where `localeCompare` would. */
[[nodiscard]] Collator make_collator(const std::vector<std::string>& locales,
                                     const CollationOptions& options);
[[nodiscard]] double collator_compare(const Collator& collator, const std::string& left,
                                      const std::string& right);

/** An ICU formatter an Intl object resolved once, at construction. */
class IntlFormatterState {
public:
    explicit IntlFormatterState(std::shared_ptr<void> formatter, std::shared_ptr<void> numbers = {})
        : formatter_(std::move(formatter)), numbers_(std::move(numbers)) {}
    [[nodiscard]] const void* get() const { return formatter_.get(); }
    /** The number formatter a PluralRules applies its digit options with. */
    [[nodiscard]] const void* numbers() const { return numbers_.get(); }

private:
    std::shared_ptr<void> formatter_;
    std::shared_ptr<void> numbers_;
};
struct NumberFormatState : IntlFormatterState {
    using IntlFormatterState::IntlFormatterState;
};
struct PluralRulesState : IntlFormatterState {
    using IntlFormatterState::IntlFormatterState;
};
struct ListFormatState : IntlFormatterState {
    using IntlFormatterState::IntlFormatterState;
};
using NumberFormat = js::Ref<NumberFormatState>;
using PluralRules = js::Ref<PluralRulesState>;
using ListFormat = js::Ref<ListFormatState>;

/** `new Intl.NumberFormat(locales, options)`; throws where `toLocaleString` would. */
[[nodiscard]] NumberFormat make_number_format(const std::vector<std::string>& locales,
                                              const NumberFormatOptions& options);
[[nodiscard]] std::string number_format_format(const NumberFormat& format, double value);

/** The `Intl.PluralRules` options: the rule type and the digit options it formats with. */
struct PluralRulesOptions {
    std::optional<std::string> locale_matcher;
    std::optional<std::string> type;
    std::optional<double> minimum_integer_digits;
    std::optional<double> minimum_fraction_digits;
    std::optional<double> maximum_fraction_digits;
    std::optional<double> minimum_significant_digits;
    std::optional<double> maximum_significant_digits;
};

/** `new Intl.PluralRules(locales, options)` and `select(number)`. */
[[nodiscard]] PluralRules make_plural_rules(const std::vector<std::string>& locales,
                                            const PluralRulesOptions& options);
[[nodiscard]] std::string plural_rules_select(const PluralRules& rules, double value);

struct ListFormatOptions {
    std::optional<std::string> locale_matcher;
    std::optional<std::string> type;
    std::optional<std::string> style;
};

/** `new Intl.ListFormat(locales, options)` and `format(list)`. */
[[nodiscard]] ListFormat make_list_format(const std::vector<std::string>& locales,
                                          const ListFormatOptions& options);
[[nodiscard]] std::string list_format_format(const ListFormat& format,
                                             const js::Array<std::string>& values);

/** The `Intl.DateTimeFormat` component options Date's locale methods read. */
struct DateTimeFormatOptions {
    std::optional<std::string> locale_matcher;
    std::optional<std::string> weekday;
    std::optional<std::string> era;
    std::optional<std::string> year;
    std::optional<std::string> month;
    std::optional<std::string> day;
    std::optional<std::string> hour;
    std::optional<std::string> minute;
    std::optional<std::string> second;
    std::optional<bool> hour12;
    std::optional<std::string> time_zone;
    bool operator==(const DateTimeFormatOptions&) const = default;
};

/** Which components a Date locale method requires and adds when none is given. */
enum class DateTimeComponents { date, time, all };

/**
 * `Date.prototype.toLocaleDateString`/`toLocaleTimeString`/`toLocaleString`:
 * the date in the requested zone (the host's by default), "Invalid Date" for NaN.
 */
[[nodiscard]] std::string format_date_time(const js::Date& date,
                                           const std::vector<std::string>& locales,
                                           const DateTimeFormatOptions& options,
                                           DateTimeComponents components);

} // namespace bbl::pal
