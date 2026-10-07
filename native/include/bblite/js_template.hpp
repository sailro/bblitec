#pragma once

#include <bblite/js_data.hpp>

#include <initializer_list>
#include <string>
#include <unordered_map>

namespace bbl::js {

namespace detail {
/** Each realm's tagged-template strings arrays, by identity, to their `raw` arrays. */
inline std::unordered_map<const void*, Array<std::string>>& template_raw_arrays() {
    static thread_local std::unordered_map<const void*, Array<std::string>> arrays;
    return arrays;
}
} // namespace detail

/**
 * A tagged template site's strings array with its `raw` array. A site
 * creates it once per realm and keeps it, so its identity is the site's.
 */
[[nodiscard]] inline Array<std::string> template_strings(std::initializer_list<std::string> cooked,
                                                         std::initializer_list<std::string> raw) {
    Array<std::string> strings(cooked);
    detail::template_raw_arrays().emplace(strings.identity(), Array<std::string>(raw));
    return strings;
}

/** `strings.raw` of a tagged template's strings array. */
[[nodiscard]] inline Array<std::string> template_raw(const Array<std::string>& strings) {
    const auto& arrays = detail::template_raw_arrays();
    const auto found = arrays.find(strings.identity());
    if (found == arrays.end())
        throw std::runtime_error("A strings array without raw strings read as a template's.");
    return found->second;
}

} // namespace bbl::js
