#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>

namespace bbl::js {
namespace search_params_detail {
// Web IDL USVString conversion replaces unpaired UTF-16 surrogates.
inline std::string scalar_string(const std::string& text) {
    auto units = string_code_units(text);
    for (std::size_t i = 0; i < units.size(); ++i) {
        if (units[i] >= 0xd800u && units[i] <= 0xdbffu && i + 1 < units.size() &&
            units[i + 1] >= 0xdc00u && units[i + 1] <= 0xdfffu) {
            ++i;
            continue;
        }
        if (units[i] >= 0xd800u && units[i] <= 0xdfffu)
            units[i] = 0xfffdu;
    }
    return string_from_code_units(units);
}

inline std::string decode(std::string_view input) {
    const auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9')
            return c - '0';
        if (c >= 'a' && c <= 'f')
            return c - 'a' + 10;
        if (c >= 'A' && c <= 'F')
            return c - 'A' + 10;
        return -1;
    };
    std::string bytes;
    for (std::size_t i = 0; i < input.size(); ++i) {
        if (input[i] == '+')
            bytes.push_back(' ');
        else if (input[i] == '%' && i + 2 < input.size() && hex(input[i + 1]) >= 0 &&
                 hex(input[i + 2]) >= 0) {
            bytes.push_back(static_cast<char>(16 * hex(input[i + 1]) + hex(input[i + 2])));
            i += 2;
        } else
            bytes.push_back(input[i]);
    }
    return decode_utf8(bytes);
}

inline void append_percent_encoded(std::string& output, unsigned char byte) {
    constexpr char hex[] = "0123456789ABCDEF";
    output.push_back('%');
    output.push_back(hex[byte >> 4]);
    output.push_back(hex[byte & 15]);
}

inline std::string encode(std::string_view input) {
    std::string output;
    for (const unsigned char byte : input) {
        if (byte == ' ')
            output.push_back('+');
        else if ((byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
                 (byte >= '0' && byte <= '9') || byte == '*' || byte == '-' || byte == '.' ||
                 byte == '_')
            output.push_back(static_cast<char>(byte));
        else
            append_percent_encoded(output, byte);
    }
    return output;
}
} // namespace search_params_detail

/** String-initialized URLSearchParams retain the ordered query list across aliases. */
class SearchParams {
    using Entries = std::vector<std::pair<std::string, std::string>>;
    std::shared_ptr<Entries> entries_;

public:
    SearchParams() = default;
    explicit SearchParams(const std::string& input) : entries_(make_gc_shared<Entries>()) {
        const auto text = search_params_detail::scalar_string(input);
        std::string_view remaining(text);
        if (remaining.starts_with('?'))
            remaining.remove_prefix(1);
        while (!remaining.empty()) {
            const auto end = remaining.find('&');
            const auto field = remaining.substr(0, end);
            if (!field.empty()) {
                const auto equals = field.find('=');
                entries_->emplace_back(
                    search_params_detail::decode(field.substr(0, equals)),
                    equals == std::string_view::npos
                        ? ""
                        : search_params_detail::decode(field.substr(equals + 1)));
            }
            if (end == std::string_view::npos)
                break;
            remaining.remove_prefix(end + 1);
        }
    }
    const void* get() const noexcept { return entries_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(entries_); }
    bool operator==(const SearchParams& other) const noexcept { return entries_ == other.entries_; }
    void gc_trace(const TraceVisitor& visitor) const { visitor(entries_); }
    Nullable<std::string> get(const std::string& key) const {
        if (!entries_)
            throw std::runtime_error("URLSearchParams receiver is absent.");
        const auto name = search_params_detail::scalar_string(key);
        for (const auto& [candidate, value] : *entries_)
            if (candidate == name)
                return value;
        return std::nullopt;
    }
    bool has(const std::string& key) const { return get(key).has_value(); }
    bool has(const std::string& key, const std::string& value) const {
        if (!entries_)
            throw std::runtime_error("URLSearchParams receiver is absent.");
        const auto name = search_params_detail::scalar_string(key),
                   expected = search_params_detail::scalar_string(value);
        return std::any_of(entries_->begin(), entries_->end(), [&](const auto& item) {
            return item.first == name && item.second == expected;
        });
    }
    void set(const std::string& key, const std::string& value) const {
        if (!entries_)
            throw std::runtime_error("URLSearchParams receiver is absent.");
        const auto name = search_params_detail::scalar_string(key);
        const auto replacement = search_params_detail::scalar_string(value);
        auto first = std::find_if(entries_->begin(), entries_->end(),
                                  [&](const auto& item) { return item.first == name; });
        if (first == entries_->end()) {
            entries_->emplace_back(name, replacement);
            return;
        }
        first->second = replacement;
        entries_->erase(std::remove_if(std::next(first), entries_->end(),
                                       [&](const auto& item) { return item.first == name; }),
                        entries_->end());
    }
    std::string to_string() const {
        if (!entries_)
            throw std::runtime_error("URLSearchParams receiver is absent.");
        std::string result;
        for (const auto& [key, value] : *entries_) {
            if (!result.empty())
                result.push_back('&');
            result += search_params_detail::encode(key);
            result.push_back('=');
            result += search_params_detail::encode(value);
        }
        return result;
    }
};
} // namespace bbl::js
