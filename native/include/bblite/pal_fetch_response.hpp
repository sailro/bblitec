#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>

namespace bbl::pal {

/** Transport records contain no realm-owned objects. */
struct HttpResponseData {
    double status = 0;
    std::string url;
    std::vector<std::uint8_t> body;
    bool consumed = false;
};
using HttpResponse = js::Ref<HttpResponseData>;

/** WHATWG UTF-8 replacement decoding, including initial BOM removal. */
inline std::string decode_http_text(const std::vector<std::uint8_t>& bytes) {
    std::string result;
    result.reserve(bytes.size());
    for (std::size_t index = 0; index < bytes.size();) {
        const auto start = index;
        const auto first = bytes[index++];
        if (first < 0x80) { result.push_back(static_cast<char>(first)); continue; }
        unsigned remaining = first >= 0xc2 && first <= 0xdf ? 1u :
            first >= 0xe0 && first <= 0xef ? 2u : first >= 0xf0 && first <= 0xf4 ? 3u : 0u;
        bool valid = remaining != 0;
        auto lower = first == 0xe0 ? 0xa0 : first == 0xf0 ? 0x90 : 0x80;
        auto upper = first == 0xed ? 0x9f : first == 0xf4 ? 0x8f : 0xbf;
        while (remaining && index < bytes.size() && bytes[index] >= lower && bytes[index] <= upper) {
            ++index;
            --remaining;
            lower = 0x80;
            upper = 0xbf;
        }
        valid = valid && remaining == 0;
        if (!valid) result += "\xef\xbf\xbd";
        else if (!(start == 0 && index == 3 && first == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf))
            result.append(reinterpret_cast<const char*>(bytes.data() + start), index - start);
    }
    return result;
}

inline bool http_response_ok(const HttpResponse& response) { return response->status >= 200 && response->status < 300; }

inline std::vector<std::uint8_t> consume_http_body(const HttpResponse& response) {
    if (response->consumed) throw std::runtime_error("Response body has already been consumed.");
    response->consumed = true;
    return std::move(response->body);
}

inline js::Promise<std::string> http_response_text(const HttpResponse& response) {
    try {
        const auto bytes = consume_http_body(response);
        return js::Promise<std::string>::resolved(decode_http_text(bytes));
    } catch (...) { return js::Promise<std::string>::rejected(std::current_exception()); }
}

inline js::Promise<js::ArrayBuffer> http_response_buffer(const HttpResponse& response) {
    try { return js::Promise<js::ArrayBuffer>::resolved(js::ArrayBuffer(consume_http_body(response))); }
    catch (...) { return js::Promise<js::ArrayBuffer>::rejected(std::current_exception()); }
}

} // namespace bbl::pal
