#pragma once

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

[[nodiscard]] inline std::vector<std::string> collation_locales(std::nullopt_t) { return {}; }
[[nodiscard]] inline std::vector<std::string> collation_locales(const std::string& locale) {
    return {locale};
}
[[nodiscard]] inline std::vector<std::string>
collation_locales(const js::Array<std::string>& locales) {
    return {locales.begin(), locales.end()};
}
template <typename T>
[[nodiscard]] std::vector<std::string> collation_locales(const std::optional<T>& locales) {
    return locales ? collation_locales(*locales) : std::vector<std::string>{};
}

/** An `Intl.Collator`: the locales and options each `compare` passes to `compare_strings`. */
struct CollatorState {
    std::vector<std::string> locales;
    CollationOptions options;
};
using Collator = js::Ref<CollatorState>;

/** `new Intl.Collator(locales, options)`; throws where `localeCompare` would. */
[[nodiscard]] Collator make_collator(std::vector<std::string> locales, CollationOptions options);
[[nodiscard]] inline double collator_compare(const Collator& collator, const std::string& left,
                                             const std::string& right) {
    return compare_strings(left, right, collator->locales, collator->options);
}

} // namespace bbl::pal
