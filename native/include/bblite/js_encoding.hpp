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
            if (byte < 0x80u) { result.push_back(static_cast<char>(byte)); continue; }
            if (byte >= 0xc2u && byte <= 0xdfu) needed = 1;
            else if (byte >= 0xe0u && byte <= 0xefu) {
                needed = 2;
                if (byte == 0xe0u) lower = 0xa0u;
                if (byte == 0xedu) upper = 0x9fu;
            } else if (byte >= 0xf0u && byte <= 0xf4u) {
                needed = 3;
                if (byte == 0xf0u) lower = 0x90u;
                if (byte == 0xf4u) upper = 0x8fu;
            } else result += "\xef\xbf\xbd";
        } else if (byte < lower || byte > upper) {
            needed = seen = 0; lower = 0x80u; upper = 0xbfu;
            result += "\xef\xbf\xbd"; // Reprocess this byte as a lead byte.
        } else {
            ++i; lower = 0x80u; upper = 0xbfu;
            if (++seen == needed) {
                result.append(bytes.substr(start, i - start));
                needed = seen = 0;
            }
        }
    }
    if (needed) result += "\xef\xbf\xbd";
    return result;
}

} // namespace bbl::js
