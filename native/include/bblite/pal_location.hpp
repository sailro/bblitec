#pragma once

#include <bblite/js_search_params.hpp>

namespace bbl::pal {

/** The query component of the application's special (HTTP/HTTPS) URL. */
inline std::string location_query(std::string_view input) {
    auto scalar = js::search_params_detail::scalar_string(std::string(input));
    if (scalar.empty())
        return {};
    std::string output = "?";
    std::string_view query(scalar);
    if (query.starts_with('?'))
        query.remove_prefix(1);
    for (const unsigned char byte : query) {
        if (byte == '\t' || byte == '\r' || byte == '\n')
            continue;
        if (byte <= 0x20 || byte > 0x7e || byte == '"' || byte == '#' || byte == '<' ||
            byte == '>' || byte == '\'')
            js::search_params_detail::append_percent_encoded(output, byte);
        else
            output.push_back(static_cast<char>(byte));
    }
    return output == "?" ? std::string{} : output;
}

/** Navigation commits at realm replacement; callbacks still read their current URL. */
struct WindowLocation {
    std::optional<std::string> current_search;
    std::optional<std::string> pending_search;

    const std::string& search(const std::string& initial) {
        if (!current_search)
            current_search = location_query(initial);
        return *current_search;
    }
    void navigate(const std::string& value) { pending_search = location_query(value); }
    void commit_reload() {
        if (pending_search) {
            current_search = std::move(pending_search);
            pending_search.reset();
        }
    }
};

} // namespace bbl::pal
