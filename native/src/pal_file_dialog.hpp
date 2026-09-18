#pragma once

#include <bblite/pal.hpp>
#include "pal_file_io.hpp"

namespace bbl::pal::detail {

inline constexpr std::size_t maximum_selected_file_bytes = 64u * 1024u * 1024u;

inline std::vector<std::string> file_dialog_extensions(std::string_view pattern) {
    if (pattern == "*.*" || pattern == "*") return {};
    std::vector<std::string> extensions;
    for (std::size_t begin = 0; begin <= pattern.size();) {
        const auto separator = pattern.find(';', begin);
        const auto item = pattern.substr(begin, separator == std::string_view::npos ? separator : separator - begin);
        if (!item.starts_with("*.") || item.size() <= 2 ||
            item.substr(2).find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string_view::npos) {
            throw std::runtime_error("Native file dialog received an invalid extension filter.");
        }
        extensions.emplace_back(item.substr(2));
        if (separator == std::string_view::npos) break;
        begin = separator + 1;
    }
    return extensions;
}

inline SelectedFileSnapshot selected_file_snapshot(const std::filesystem::path& path) {
    const auto name = path.filename().u8string();
    if (name.empty()) throw std::runtime_error("The selected file has no stable display name.");
    return {
        .bytes = read_binary_file_bounded(path, maximum_selected_file_bytes, "selected file"),
        .display_name = std::string(reinterpret_cast<const char*>(name.data()), name.size()),
    };
}

}
