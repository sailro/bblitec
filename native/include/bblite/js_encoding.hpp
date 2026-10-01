#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace bbl::js {

/**
 * Encoding Standard UTF-8 decoding, without BOM removal. Well-formed input is
 * returned as it is; each maximal ill-formed subsequence becomes U+FFFD, or,
 * when `fatal`, fails the decode (nullopt).
 */
[[nodiscard]] inline std::optional<std::string> decode_utf8(std::string_view bytes, bool fatal) {
    std::string result;
    // The bytes from `copied` to the sequence being read are well-formed and
    // not yet appended, so valid input is copied once, at the end.
    // A replacement always appends U+FFFD, so an empty result means none.
    std::size_t copied = 0, start = 0;
    const auto replace = [&](std::size_t from) {
        result.append(bytes.substr(copied, from - copied));
        result += "\xef\xbf\xbd";
    };
    unsigned needed = 0, seen = 0, lower = 0x80u, upper = 0xbfu;
    for (std::size_t i = 0; i < bytes.size();) {
        const auto byte = static_cast<unsigned char>(bytes[i]);
        if (!needed) {
            start = i++;
            if (byte < 0x80u)
                continue;
            if (byte >= 0xc2u && byte <= 0xdfu)
                needed = 1;
            else if (byte >= 0xe0u && byte <= 0xefu) {
                needed = 2;
                if (byte == 0xe0u)
                    lower = 0xa0u;
                if (byte == 0xedu)
                    upper = 0x9fu;
            } else if (byte >= 0xf0u && byte <= 0xf4u) {
                needed = 3;
                if (byte == 0xf0u)
                    lower = 0x90u;
                if (byte == 0xf4u)
                    upper = 0x8fu;
            } else {
                if (fatal)
                    return std::nullopt;
                replace(start);
                copied = i;
            }
        } else if (byte < lower || byte > upper) {
            if (fatal)
                return std::nullopt;
            needed = seen = 0;
            lower = 0x80u;
            upper = 0xbfu;
            replace(start);
            copied = i; // Reprocess this byte as a lead byte.
        } else {
            ++i;
            lower = 0x80u;
            upper = 0xbfu;
            if (++seen == needed)
                needed = seen = 0;
        }
    }
    if (needed) {
        if (fatal)
            return std::nullopt;
        // The truncated sequence runs to the end: nothing follows it.
        replace(start);
        return result;
    }
    if (result.empty())
        return std::string(bytes);
    result.append(bytes.substr(copied));
    return result;
}

/** UTF-8 decoding with replacement, without BOM removal. */
[[nodiscard]] inline std::string decode_utf8(std::string_view bytes) {
    return *decode_utf8(bytes, false);
}

/** The Encoding Standard's UTF-8 decode: an initial byte order mark is removed. */
[[nodiscard]] inline std::optional<std::string> decode_utf8_removing_bom(std::string_view bytes,
                                                                         bool fatal) {
    if (bytes.starts_with("\xef\xbb\xbf"))
        bytes.remove_prefix(3);
    return decode_utf8(bytes, fatal);
}

[[nodiscard]] inline std::string decode_utf8_removing_bom(std::string_view bytes) {
    return *decode_utf8_removing_bom(bytes, false);
}

/**
 * The UTF-8 of a WTF-8 string's USVString (Web IDL): a lone surrogate
 * (ED A0..BF xx) becomes U+FFFD, and a high and low surrogate stored apart
 * join into their code point. A string without surrogates is copied as is.
 */
[[nodiscard]] inline std::string usv_string(std::string_view text) {
    const auto unit_at = [&](std::size_t index) -> unsigned {
        if (index + 3 > text.size() || static_cast<unsigned char>(text[index]) != 0xedu ||
            static_cast<unsigned char>(text[index + 1]) < 0xa0u)
            return 0u;
        return 0xd000u | ((static_cast<unsigned char>(text[index + 1]) & 0x3fu) << 6u) |
               (static_cast<unsigned char>(text[index + 2]) & 0x3fu);
    };
    std::string result;
    std::size_t copied = 0;
    bool converted = false;
    for (auto index = text.find('\xed'); index != std::string_view::npos;
         index = text.find('\xed', index)) {
        const unsigned high = unit_at(index);
        if (!high) {
            ++index;
            continue;
        }
        result.append(text.substr(copied, index - copied));
        const unsigned low = high <= 0xdbffu ? unit_at(index + 3) : 0u;
        if (low >= 0xdc00u) {
            const unsigned code = 0x10000u + ((high - 0xd800u) << 10u) + (low - 0xdc00u);
            result.push_back(static_cast<char>(0xf0u | (code >> 18u)));
            result.push_back(static_cast<char>(0x80u | ((code >> 12u) & 0x3fu)));
            result.push_back(static_cast<char>(0x80u | ((code >> 6u) & 0x3fu)));
            result.push_back(static_cast<char>(0x80u | (code & 0x3fu)));
            index += 6;
        } else {
            result += "\xef\xbf\xbd";
            index += 3;
        }
        copied = index;
        converted = true;
    }
    if (!converted)
        return std::string(text);
    result.append(text.substr(copied));
    return result;
}

/** UTF-16 code units to UTF-8, a lone surrogate or odd trailing byte as U+FFFD. */
[[nodiscard]] inline std::string decode_utf16(std::string_view bytes, bool big_endian) {
    const auto unit = [&](std::size_t index) -> unsigned {
        const unsigned first = static_cast<unsigned char>(bytes[index]);
        const unsigned second = static_cast<unsigned char>(bytes[index + 1u]);
        return big_endian ? (first << 8u) | second : (second << 8u) | first;
    };
    const auto append = [](std::string& out, unsigned code) {
        if (code < 0x80u) {
            out.push_back(static_cast<char>(code));
        } else if (code < 0x800u) {
            out.push_back(static_cast<char>(0xc0u | (code >> 6u)));
            out.push_back(static_cast<char>(0x80u | (code & 0x3fu)));
        } else if (code < 0x10000u) {
            out.push_back(static_cast<char>(0xe0u | (code >> 12u)));
            out.push_back(static_cast<char>(0x80u | ((code >> 6u) & 0x3fu)));
            out.push_back(static_cast<char>(0x80u | (code & 0x3fu)));
        } else {
            out.push_back(static_cast<char>(0xf0u | (code >> 18u)));
            out.push_back(static_cast<char>(0x80u | ((code >> 12u) & 0x3fu)));
            out.push_back(static_cast<char>(0x80u | ((code >> 6u) & 0x3fu)));
            out.push_back(static_cast<char>(0x80u | (code & 0x3fu)));
        }
    };
    std::string result;
    result.reserve(bytes.size());
    std::size_t index = 0;
    for (; index + 1u < bytes.size(); index += 2u) {
        const unsigned code = unit(index);
        if (code >= 0xd800u && code <= 0xdbffu && index + 3u < bytes.size()) {
            const unsigned low = unit(index + 2u);
            if (low >= 0xdc00u && low <= 0xdfffu) {
                append(result, 0x10000u + ((code - 0xd800u) << 10u) + (low - 0xdc00u));
                index += 2u;
                continue;
            }
        }
        append(result, code >= 0xd800u && code <= 0xdfffu ? 0xfffdu : code);
    }
    if (index < bytes.size())
        append(result, 0xfffdu);
    return result;
}

/**
 * The Encoding Standard's decode with a UTF-8 fallback: a byte order mark
 * selects UTF-8, UTF-16LE or UTF-16BE and is removed; anything else is UTF-8.
 * `FileReader.readAsText` without an encoding decodes this way.
 */
[[nodiscard]] inline std::string decode_text(std::string_view bytes) {
    if (bytes.starts_with("\xfe\xff"))
        return decode_utf16(bytes.substr(2), true);
    if (bytes.starts_with("\xff\xfe"))
        return decode_utf16(bytes.substr(2), false);
    return decode_utf8_removing_bom(bytes);
}

} // namespace bbl::js
