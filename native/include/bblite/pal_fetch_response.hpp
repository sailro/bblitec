#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
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
    if (bytes.empty()) return {};
    std::string_view input(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    if (input.starts_with("\xef\xbb\xbf")) input.remove_prefix(3);
    return js::decode_utf8(input);
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
