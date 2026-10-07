#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>

namespace bbl::js {
namespace search_params_detail {
/** A hexadecimal digit's value, or -1. */
[[nodiscard]] inline int hex_digit(char c) {
    const int digit = radix_digit(c);
    return digit < 16 ? digit : -1;
}

inline std::string decode(std::string_view input) {
    std::string bytes;
    for (std::size_t i = 0; i < input.size(); ++i) {
        if (input[i] == '+')
            bytes.push_back(' ');
        else if (input[i] == '%' && i + 2 < input.size() && hex_digit(input[i + 1]) >= 0 &&
                 hex_digit(input[i + 2]) >= 0) {
            bytes.push_back(
                static_cast<char>(16 * hex_digit(input[i + 1]) + hex_digit(input[i + 2])));
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

namespace uri_detail {
/** The characters `encodeURI` leaves and `decodeURI` keeps escaped: uriReserved and '#'. */
constexpr std::string_view reserved = ";/?:@&=+$,#";

/** ECMAScript Encode: UTF-8 octets outside the unescaped set; unpaired surrogates throw. */
inline std::string encode(std::string_view input, std::string_view extra_unescaped) {
    const auto text = scalar_string(input, true);
    std::string output;
    for (const unsigned char byte : text) {
        if ((byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
            (byte >= '0' && byte <= '9') ||
            std::string_view("-_.!~*'()").find(byte) != std::string_view::npos ||
            extra_unescaped.find(byte) != std::string_view::npos)
            output.push_back(static_cast<char>(byte));
        else
            search_params_detail::append_percent_encoded(output, byte);
    }
    return output;
}

/**
 * ECMAScript Decode: each escape sequence of one UTF-8 encoded code point
 * becomes that code point; an escaped ASCII character in `preserved` keeps
 * its escape. A malformed escape or encoding throws URIError.
 */
inline std::string decode(std::string_view input, std::string_view preserved) {
    const auto malformed = [] { return NamedError("URIError", "URI malformed"); };
    // The octet escaped at `index`, which must be a '%' and two hex digits.
    const auto octet = [&](std::size_t index) -> unsigned {
        if (index + 2 >= input.size() || input[index] != '%')
            throw malformed();
        const int high = search_params_detail::hex_digit(input[index + 1]),
                  low = search_params_detail::hex_digit(input[index + 2]);
        if (high < 0 || low < 0)
            throw malformed();
        return static_cast<unsigned>(high * 16 + low);
    };
    std::string output;
    output.reserve(input.size());
    for (std::size_t index = 0; index < input.size();) {
        if (input[index] != '%') {
            output.push_back(input[index++]);
            continue;
        }
        const unsigned lead = octet(index);
        if (lead < 0x80u) {
            if (preserved.find(static_cast<char>(lead)) != std::string_view::npos)
                output.append(input.substr(index, 3));
            else
                output.push_back(static_cast<char>(lead));
            index += 3;
            continue;
        }
        const unsigned count = lead >= 0xf0u   ? (lead >= 0xf8u ? 0u : 4u)
                               : lead >= 0xe0u ? 3u
                               : lead >= 0xc0u ? 2u
                                               : 0u;
        if (count == 0)
            throw malformed();
        std::string octets(1, static_cast<char>(lead));
        for (unsigned position = 1; position < count; ++position) {
            const unsigned continuation = octet(index + 3 * position);
            if ((continuation & 0xc0u) != 0x80u)
                throw malformed();
            octets.push_back(static_cast<char>(continuation));
        }
        if (!decode_utf8(octets, true))
            throw malformed();
        output += octets;
        index += 3 * count;
    }
    return output;
}
} // namespace uri_detail

/** ECMAScript component encoding uses UTF-8 and rejects unpaired UTF-16 surrogates. */
inline std::string encode_uri_component(std::string_view input) {
    return uri_detail::encode(input, {});
}

/** `encodeURI`: as the component encoding, but URI reserved characters and '#' stay. */
inline std::string encode_uri(std::string_view input) {
    return uri_detail::encode(input, uri_detail::reserved);
}

inline std::string decode_uri_component(std::string_view input) {
    return uri_detail::decode(input, {});
}

/** `decodeURI`: escapes of URI reserved characters and '#' remain escaped. */
inline std::string decode_uri(std::string_view input) {
    return uri_detail::decode(input, uri_detail::reserved);
}

/** String-initialized URLSearchParams retain the ordered query list across aliases. */
class SearchParams {
    using Entries = std::vector<std::pair<std::string, std::string>>;
    std::shared_ptr<Entries> entries_;

public:
    SearchParams() = default;
    explicit SearchParams(const std::string& input) : entries_(make_gc_shared<Entries>()) {
        const auto text = usv_string(input);
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
        const auto name = usv_string(key);
        for (const auto& [candidate, value] : *entries_)
            if (candidate == name)
                return value;
        return std::nullopt;
    }
    bool has(const std::string& key) const { return get(key).has_value(); }
    bool has(const std::string& key, const std::string& value) const {
        if (!entries_)
            throw std::runtime_error("URLSearchParams receiver is absent.");
        const auto name = usv_string(key), expected = usv_string(value);
        return std::any_of(entries_->begin(), entries_->end(), [&](const auto& item) {
            return item.first == name && item.second == expected;
        });
    }
    void set(const std::string& key, const std::string& value) const {
        if (!entries_)
            throw std::runtime_error("URLSearchParams receiver is absent.");
        const auto name = usv_string(key);
        const auto replacement = usv_string(value);
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
