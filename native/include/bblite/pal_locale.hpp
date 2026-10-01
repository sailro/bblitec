#pragma once

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
[[nodiscard]] double compare_strings(const std::string& left, const std::string& right,
                                     const std::vector<std::string>& locales,
                                     const CollationOptions& options);

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

} // namespace bbl::pal
