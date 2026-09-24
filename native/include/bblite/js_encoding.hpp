#pragma once

#include <string>
#include <string_view>

namespace bbl::js {

/** Encoding Standard UTF-8 decoding with replacement, without BOM removal. */
[[nodiscard]] inline std::string decode_utf8(std::string_view bytes) {
    std::string result;
    result.reserve(bytes.size());
    unsigned needed = 0, seen = 0, lower = 0x80u, upper = 0xbfu;
    std::size_t start = 0;
    for (std::size_t i = 0; i < bytes.size();) {
        const auto byte = static_cast<unsigned char>(bytes[i]);
        if (!needed) {
            start = i++;
            if (byte < 0x80u) {
                result.push_back(static_cast<char>(byte));
                continue;
            }
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
            } else
                result += "\xef\xbf\xbd";
        } else if (byte < lower || byte > upper) {
            needed = seen = 0;
            lower = 0x80u;
            upper = 0xbfu;
            result += "\xef\xbf\xbd"; // Reprocess this byte as a lead byte.
        } else {
            ++i;
            lower = 0x80u;
            upper = 0xbfu;
            if (++seen == needed) {
                result.append(bytes.substr(start, i - start));
                needed = seen = 0;
            }
        }
    }
    if (needed)
        result += "\xef\xbf\xbd";
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
    if (bytes.substr(0, 3) == "\xef\xbb\xbf")
        return decode_utf8(bytes.substr(3));
    if (bytes.substr(0, 2) == "\xfe\xff")
        return decode_utf16(bytes.substr(2), true);
    if (bytes.substr(0, 2) == "\xff\xfe")
        return decode_utf16(bytes.substr(2), false);
    return decode_utf8(bytes);
}

} // namespace bbl::js
