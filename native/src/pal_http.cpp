#include <bblite/pal_http.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#ifdef _WIN32
#include "pal_win32_text.hpp"
#include <winhttp.h>
#else
#include <curl/curl.h>
#endif

namespace bbl::pal {
namespace {
constexpr std::size_t maximum_body = 32u * 1024u * 1024u;

bool token_character(unsigned char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9') || std::string_view("!#$%&'*+-.^_`|~").find(static_cast<char>(character)) != std::string_view::npos;
}

void validate_request(const std::string& url, const HttpRequest& request) {
    if ((!url.starts_with("http://") && !url.starts_with("https://")) || url.find('\0') != std::string::npos)
        throw std::runtime_error("fetch requires an absolute HTTP(S) URL.");
    const auto authority_start = url.find("://") + 3;
    const auto authority_end = url.find_first_of("/?#", authority_start);
    if (url.substr(authority_start, authority_end - authority_start).find('@') != std::string::npos)
        throw std::runtime_error("fetch URLs cannot contain credentials.");
    if (request.method.empty() || !std::all_of(request.method.begin(), request.method.end(), token_character))
        throw std::runtime_error("Invalid HTTP method.");
    if ((request.method == "GET" || request.method == "HEAD") && request.body.has_value())
        throw std::runtime_error("GET and HEAD requests cannot have a body.");
    if (request.body && request.body->size() > maximum_body) throw std::runtime_error("HTTP request body exceeds 32 MiB.");
    for (const auto& [name, value] : request.headers) {
        if (name.empty() || !std::all_of(name.begin(), name.end(), token_character) ||
            std::any_of(value.begin(), value.end(), [](unsigned char character) { return character == '\r' || character == '\n' || character == 0; }))
            throw std::runtime_error("Invalid HTTP header.");
    }
}

#ifdef _WIN32
std::wstring wide(const std::string& value) {
    auto result = utf8_to_wide(value);
    if (!result) throw std::runtime_error("Invalid UTF-8 in HTTP request.");
    return std::move(*result);
}

std::string narrow(const wchar_t* value, int length) {
    const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length, nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("HTTP URL conversion failed.");
    std::string result(static_cast<std::size_t>(count), '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length, result.data(), count, nullptr, nullptr))
        throw std::runtime_error("HTTP URL conversion failed.");
    return result;
}

void require(BOOL success) {
    if (!success) throw std::runtime_error("HTTP transport failed (Windows error " + std::to_string(GetLastError()) + ").");
}

struct InternetHandle {
    HINTERNET value;
    explicit InternetHandle(HINTERNET handle) : value(handle) { require(value != nullptr); }
    ~InternetHandle() { WinHttpCloseHandle(value); }
    InternetHandle(const InternetHandle&) = delete;
    InternetHandle& operator=(const InternetHandle&) = delete;
};
#endif
} // namespace

/** WHATWG UTF-8 replacement decoding, including initial BOM removal. */
std::string decode_http_text(const std::vector<std::uint8_t>& bytes) {
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

HttpResponseData perform_http_request(const std::string& url, HttpRequest request, std::stop_token stop) {
    std::string normalized = request.method;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char character) { return static_cast<char>(std::toupper(character)); });
    if (normalized == "DELETE" || normalized == "GET" || normalized == "HEAD" || normalized == "OPTIONS" || normalized == "POST" || normalized == "PUT") request.method = normalized;
    if (normalized == "CONNECT" || normalized == "TRACE" || normalized == "TRACK") throw std::runtime_error("This HTTP method is forbidden by fetch.");
    validate_request(url, request);
    const bool content_type = std::any_of(request.headers.begin(), request.headers.end(), [](const auto& header) {
        std::string name = header.first;
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
        return name == "content-type";
    });
    if (request.body && !content_type) request.headers.emplace_back("Content-Type", "text/plain;charset=UTF-8");
    if (stop.stop_requested()) throw std::runtime_error("HTTP request canceled.");
    HttpResponseData response;
#ifdef _WIN32
    const auto address = wide(url);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
    require(WinHttpCrackUrl(address.c_str(), static_cast<DWORD>(address.size()), 0, &parts));
    if (parts.dwUserNameLength || parts.dwPasswordLength) throw std::runtime_error("fetch URLs cannot contain credentials.");
    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    if (const auto fragment = path.find(L'#'); fragment != std::wstring::npos) path.resize(fragment);
    if (path.empty()) path = L"/";
    InternetHandle session(WinHttpOpen(L"bblitec/native", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    require(WinHttpSetTimeouts(session.value, 5000, 5000, 5000, 5000));
    InternetHandle connection(WinHttpConnect(session.value, host.c_str(), parts.nPort, 0));
    InternetHandle message(WinHttpOpenRequest(connection.value, wide(request.method).c_str(), path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0));
    DWORD disabled = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    require(WinHttpSetOption(message.value, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled)));
    std::wstring headers;
    for (const auto& [name, value] : request.headers) {
        headers += wide(name) + L": " + wide(value) + L"\r\n";
    }
    const auto length = static_cast<DWORD>(request.body ? request.body->size() : 0);
    require(WinHttpSendRequest(message.value, headers.c_str(), static_cast<DWORD>(headers.size()),
        request.body ? const_cast<char*>(request.body->data()) : nullptr, length, length, 0));
    require(WinHttpReceiveResponse(message.value, nullptr));
    DWORD status = 0, status_length = sizeof(status);
    require(WinHttpQueryHeaders(message.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_length, WINHTTP_NO_HEADER_INDEX));
    response.status = static_cast<double>(status);
    DWORD url_length = 0;
    WinHttpQueryOption(message.value, WINHTTP_OPTION_URL, nullptr, &url_length);
    if (!url_length) throw std::runtime_error("HTTP response has no URL.");
    std::vector<wchar_t> final_url(url_length / sizeof(wchar_t));
    require(WinHttpQueryOption(message.value, WINHTTP_OPTION_URL, final_url.data(), &url_length));
    response.url = narrow(final_url.data(), static_cast<int>(std::char_traits<wchar_t>::length(final_url.data())));
    std::array<std::uint8_t, 16384> chunk;
    for (;;) {
        if (stop.stop_requested()) throw std::runtime_error("HTTP request canceled.");
        DWORD read = 0;
        require(WinHttpReadData(message.value, chunk.data(), static_cast<DWORD>(chunk.size()), &read));
        if (!read) break;
        if (read > maximum_body - response.body.size()) throw std::runtime_error("HTTP response body exceeds 32 MiB.");
        response.body.insert(response.body.end(), chunk.begin(), chunk.begin() + read);
    }
#else
    struct CurlGlobal { CurlGlobal() { if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) throw std::runtime_error("HTTP initialization failed."); } ~CurlGlobal() { curl_global_cleanup(); } };
    static const CurlGlobal initialized;
    static_cast<void>(initialized);
    const std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> client(curl_easy_init(), curl_easy_cleanup);
    if (!client) throw std::runtime_error("HTTP client allocation failed.");
    auto option = [&](CURLoption name, auto value) { if (curl_easy_setopt(client.get(), name, value) != CURLE_OK) throw std::runtime_error("HTTP client option failed."); };
    option(CURLOPT_URL, url.c_str());
    option(CURLOPT_PROTOCOLS_STR, "http,https");
    option(CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
    option(CURLOPT_FOLLOWLOCATION, 1L);
    option(CURLOPT_MAXREDIRS, 20L);
    option(CURLOPT_NOSIGNAL, 1L);
    option(CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    option(CURLOPT_TIMEOUT_MS, 30000L);
    option(CURLOPT_USERAGENT, "bblitec/native");
    curl_slist* raw_headers = nullptr;
    struct Headers { curl_slist*& value; ~Headers() { curl_slist_free_all(value); } } headers{raw_headers};
    for (const auto& [name, value] : request.headers) {
        auto* appended = curl_slist_append(raw_headers, (name + (value.empty() ? ";" : ": " + value)).c_str());
        if (!appended) throw std::bad_alloc();
        raw_headers = appended;
    }
    if (request.body) {
        option(CURLOPT_POSTFIELDS, request.body->data());
        option(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(request.body->size()));
    }
    if (request.method == "POST") option(CURLOPT_POST, 1L);
    else if (request.method != "GET" && request.method != "HEAD") option(CURLOPT_CUSTOMREQUEST, request.method.c_str());
    if (request.method == "HEAD") option(CURLOPT_NOBODY, 1L);
    option(CURLOPT_HTTPHEADER, raw_headers);
    option(CURLOPT_WRITEFUNCTION, +[](char* data, std::size_t size, std::size_t count, void* target) -> std::size_t {
        auto& body = *static_cast<std::vector<std::uint8_t>*>(target);
        if (count && size > (maximum_body - body.size()) / count) return 0;
        const auto length = size * count;
        try { body.insert(body.end(), data, data + length); return length; } catch (...) { return 0; }
    });
    option(CURLOPT_WRITEDATA, &response.body);
    option(CURLOPT_NOPROGRESS, 0L);
    option(CURLOPT_XFERINFOFUNCTION, +[](void* data, curl_off_t, curl_off_t, curl_off_t, curl_off_t) { return static_cast<std::stop_token*>(data)->stop_requested() ? 1 : 0; });
    option(CURLOPT_XFERINFODATA, &stop);
    const auto performed = curl_easy_perform(client.get());
    if (performed != CURLE_OK) throw std::runtime_error(std::string("HTTP transport failed: ") + curl_easy_strerror(performed));
    long status = 0;
    char* final_url = nullptr;
    if (curl_easy_getinfo(client.get(), CURLINFO_RESPONSE_CODE, &status) != CURLE_OK ||
        curl_easy_getinfo(client.get(), CURLINFO_EFFECTIVE_URL, &final_url) != CURLE_OK || !final_url) throw std::runtime_error("HTTP response metadata unavailable.");
    response.status = static_cast<double>(status);
    response.url = final_url;
#endif
    return response;
}
} // namespace bbl::pal
