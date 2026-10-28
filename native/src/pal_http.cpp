#include <bblite/pal_http.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <mutex>
#ifdef _WIN32
#include "pal_win32_text.hpp"
#include <winhttp.h>
#else
#include <curl/curl.h>
#endif

namespace bbl::pal {
namespace {
constexpr std::size_t maximum_request_body = 32u * 1024u * 1024u;
constexpr std::size_t read_size = 64u * 1024u;

void validate_request(const std::string& url, const HttpRequest& request) {
    if ((!url.starts_with("http://") && !url.starts_with("https://")) ||
        url.find('\0') != std::string::npos)
        throw std::runtime_error("fetch requires an absolute HTTP(S) URL.");
    const auto authority_start = url.find("://") + 3;
    const auto authority_end = url.find_first_of("/?#", authority_start);
    if (url.substr(authority_start, authority_end - authority_start).find('@') != std::string::npos)
        throw std::runtime_error("fetch URLs cannot contain credentials.");
    if (!http_header_name_valid(request.method))
        throw std::runtime_error("Invalid HTTP method.");
    if ((request.method == "GET" || request.method == "HEAD") && request.body.has_value())
        throw std::runtime_error("GET and HEAD requests cannot have a body.");
    if (request.body && request.body->size() > maximum_request_body)
        throw std::runtime_error("HTTP request body exceeds 32 MiB.");
    for (const auto& [name, value] : request.headers)
        if (!http_header_name_valid(name) || !http_header_value(value))
            throw std::runtime_error("Invalid HTTP header.");
}

/**
 * Method normalization, the forbidden header fields a browser's request
 * drops, and the request's default Content-Type, as fetch applies them.
 */
void prepare_request(const std::string& url, HttpRequest& request) {
    std::string normalized = request.method;
    std::transform(
        normalized.begin(), normalized.end(), normalized.begin(),
        [](unsigned char character) { return static_cast<char>(std::toupper(character)); });
    if (normalized == "DELETE" || normalized == "GET" || normalized == "HEAD" ||
        normalized == "OPTIONS" || normalized == "POST" || normalized == "PUT")
        request.method = normalized;
    if (normalized == "CONNECT" || normalized == "TRACE" || normalized == "TRACK")
        throw std::runtime_error("This HTTP method is forbidden by fetch.");
    std::erase_if(request.headers,
                  [](const auto& header) { return http_forbidden_request_header(header.first); });
    validate_request(url, request);
    const bool content_type =
        std::any_of(request.headers.begin(), request.headers.end(), [](const auto& header) {
            return http_header_name(header.first) == "content-type";
        });
    if (request.body && !content_type)
        request.headers.emplace_back("Content-Type", "text/plain;charset=UTF-8");
}

/** One `name: value` header line (no line ending) into `list`; other lines are ignored. */
void append_header_line(HttpHeaderList& list, std::string_view line) {
    const auto colon = line.find(':');
    if (colon == std::string_view::npos || colon == 0)
        return;
    const auto name = http_header_value(line.substr(0, colon));
    const auto value = http_header_value(line.substr(colon + 1));
    if (name && value)
        list.entries.emplace_back(http_header_name(*name), *value);
}

#ifdef _WIN32
std::wstring wide(const std::string& value) {
    auto result = utf8_to_wide(value);
    if (!result)
        throw std::runtime_error("Invalid UTF-8 in HTTP request.");
    return std::move(*result);
}

std::string narrow(const wchar_t* value, int length) {
    if (length == 0)
        return {};
    const auto count = WideCharToMultiByte(CP_UTF8, 0, value, length, nullptr, 0, nullptr, nullptr);
    if (!count)
        throw std::runtime_error("HTTP text conversion failed.");
    std::string result(static_cast<std::size_t>(count), '\0');
    if (!WideCharToMultiByte(CP_UTF8, 0, value, length, result.data(), count, nullptr, nullptr))
        throw std::runtime_error("HTTP text conversion failed.");
    return result;
}

[[noreturn]] void transport_failure(DWORD error) {
    if (error == ERROR_WINHTTP_TIMEOUT)
        throw std::runtime_error("HTTP request timed out.");
    throw std::runtime_error("HTTP transport failed (Windows error " + std::to_string(error) +
                             ").");
}

void require(BOOL success) {
    if (!success)
        transport_failure(GetLastError());
}

/** Win32 event ownership. */
struct EventHandle {
    HANDLE value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    EventHandle() {
        if (!value)
            throw std::runtime_error("HTTP transport event creation failed.");
    }
    ~EventHandle() { CloseHandle(value); }
    EventHandle(const EventHandle&) = delete;
    EventHandle& operator=(const EventHandle&) = delete;
};

/**
 * The process's asynchronous WinHTTP session. Requests on it share its connection pool, so
 * sequential and concurrent requests to one origin reuse kept-alive connections.
 */
HINTERNET winhttp_session() {
    static const struct Session {
        HINTERNET value;
        Session()
            : value(WinHttpOpen(L"bblitec/native", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS,
                                WINHTTP_FLAG_ASYNC)) {
            if (!value)
                transport_failure(GetLastError());
            // No progress for 5 s fails a request.
            require(WinHttpSetTimeouts(value, 5000, 5000, 5000, 5000));
            DWORD connections = 6;
            require(WinHttpSetOption(value, WINHTTP_OPTION_MAX_CONNS_PER_SERVER, &connections,
                                     sizeof(connections)));
            // HTTP/2 multiplexes the pool's requests where the OS supports it.
            DWORD protocols = WINHTTP_PROTOCOL_FLAG_HTTP2;
            static_cast<void>(WinHttpSetOption(value, WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL,
                                               &protocols, sizeof(protocols)));
        }
        ~Session() { WinHttpCloseHandle(value); }
    } session;
    return session.value;
}

/**
 * One asynchronous request's callback state. The transport thread starts one operation at a
 * time and waits for its completion event or the exchange's cancel event; closing the request
 * handle cancels an operation in flight, and the state outlives the handle's final
 * HANDLE_CLOSING notification.
 */
struct AsyncRequest {
    EventHandle completed;
    EventHandle closed;
    /** Shared with the exchange's wake, which can still run once this request is gone. */
    std::shared_ptr<EventHandle> canceled = std::make_shared<EventHandle>();
    DWORD status = 0;
    DWORD error = 0;
    DWORD bytes = 0;
    HINTERNET handle = nullptr;

    static void CALLBACK notify(HINTERNET, DWORD_PTR context, DWORD status, LPVOID information,
                                DWORD length) {
        auto* request = reinterpret_cast<AsyncRequest*>(context);
        if (!request)
            return;
        if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) {
            SetEvent(request->closed.value);
            return;
        }
        if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR)
            request->error = static_cast<WINHTTP_ASYNC_RESULT*>(information)->dwError;
        if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE)
            request->bytes = length;
        request->status = status;
        SetEvent(request->completed.value);
    }

    /**
     * Wait for the operation just started; false when the exchange was canceled, also when the
     * operation completed (or failed) as the cancellation arrived.
     */
    bool wait(DWORD expected) {
        const std::array<HANDLE, 2> events{canceled->value, completed.value};
        const auto signaled = WaitForMultipleObjects(static_cast<DWORD>(events.size()),
                                                     events.data(), FALSE, INFINITE);
        if (signaled == WAIT_OBJECT_0)
            return false;
        if (signaled != WAIT_OBJECT_0 + 1)
            transport_failure(GetLastError());
        if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR)
            transport_failure(error);
        if (status != expected)
            throw std::runtime_error("Unexpected HTTP transport notification.");
        return true;
    }

    ~AsyncRequest() {
        if (!handle)
            return;
        // Closing cancels any operation in flight; its notifications end with HANDLE_CLOSING.
        WinHttpCloseHandle(handle);
        WaitForSingleObject(closed.value, INFINITE);
    }
};

struct ConnectHandle {
    HINTERNET value;
    ~ConnectHandle() {
        if (value)
            WinHttpCloseHandle(value);
    }
};

std::shared_ptr<HttpHeaderList> raw_headers(HINTERNET request) {
    DWORD length = 0;
    WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                        WINHTTP_NO_OUTPUT_BUFFER, &length, WINHTTP_NO_HEADER_INDEX);
    auto list = std::make_shared<HttpHeaderList>();
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || length == 0)
        return list;
    std::vector<wchar_t> buffer(length / sizeof(wchar_t) + 1);
    require(WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF,
                                WINHTTP_HEADER_NAME_BY_INDEX, buffer.data(), &length,
                                WINHTTP_NO_HEADER_INDEX));
    const auto text = narrow(buffer.data(), static_cast<int>(length / sizeof(wchar_t)));
    std::string_view rest(text);
    bool status_line = true;
    while (!rest.empty()) {
        const auto end = rest.find("\r\n");
        const auto line = rest.substr(0, end);
        if (!status_line)
            append_header_line(*list, line);
        status_line = false;
        if (end == std::string_view::npos)
            break;
        rest.remove_prefix(end + 2);
    }
    return list;
}
#endif
} // namespace

void perform_http_transfer(const std::string& url, HttpRequest request, HttpExchange& exchange) {
    prepare_request(url, request);
    if (exchange.canceled())
        return;
#ifdef _WIN32
    const auto address = wide(url);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength =
        parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
    require(WinHttpCrackUrl(address.c_str(), static_cast<DWORD>(address.size()), 0, &parts));
    if (parts.dwUserNameLength || parts.dwPasswordLength)
        throw std::runtime_error("fetch URLs cannot contain credentials.");
    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    if (const auto fragment = path.find(L'#'); fragment != std::wstring::npos)
        path.resize(fragment);
    if (path.empty())
        path = L"/";
    const ConnectHandle connection{WinHttpConnect(winhttp_session(), host.c_str(), parts.nPort, 0)};
    if (!connection.value)
        transport_failure(GetLastError());
    // A pending WinHttpReadData writes into `buffer` until its completion or the handle's
    // HANDLE_CLOSING; declared before `state`, it outlives the close that a cancel or a
    // failure performs in ~AsyncRequest. One uninitialized buffer serves every read; each
    // chunk is an exact-size copy of what a read returned.
    const std::unique_ptr<std::uint8_t[]> buffer(new std::uint8_t[read_size]);
    AsyncRequest state;
    exchange.set_wake([event = state.canceled] { SetEvent(event->value); });
    // A cancellation before the wake was installed still stops the transfer here.
    if (exchange.canceled())
        return;
    state.handle =
        WinHttpOpenRequest(connection.value, wide(request.method).c_str(), path.c_str(), nullptr,
                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                           parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    if (!state.handle)
        transport_failure(GetLastError());
    auto context = reinterpret_cast<DWORD_PTR>(&state);
    require(
        WinHttpSetOption(state.handle, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context)));
    if (WinHttpSetStatusCallback(state.handle, &AsyncRequest::notify,
                                 WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS |
                                     WINHTTP_CALLBACK_FLAG_HANDLES,
                                 0) == WINHTTP_INVALID_STATUS_CALLBACK)
        transport_failure(GetLastError());
    DWORD disabled = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    require(WinHttpSetOption(state.handle, WINHTTP_OPTION_DISABLE_FEATURE, &disabled,
                             sizeof(disabled)));
    std::wstring headers;
    for (const auto& [name, value] : request.headers)
        headers += wide(name) + L": " + wide(value) + L"\r\n";
    const auto length = static_cast<DWORD>(request.body ? request.body->size() : 0);
    require(WinHttpSendRequest(
        state.handle, headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
        static_cast<DWORD>(headers.size()),
        request.body ? request.body->data() : WINHTTP_NO_REQUEST_DATA, length, length, context));
    if (!state.wait(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE))
        return;
    require(WinHttpReceiveResponse(state.handle, nullptr));
    if (!state.wait(WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE))
        return;
    HttpResponseHead head;
    DWORD status = 0, status_length = sizeof(status);
    require(WinHttpQueryHeaders(state.handle, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_length,
                                WINHTTP_NO_HEADER_INDEX));
    head.status = static_cast<double>(status);
    DWORD url_length = 0;
    WinHttpQueryOption(state.handle, WINHTTP_OPTION_URL, nullptr, &url_length);
    if (!url_length)
        throw std::runtime_error("HTTP response has no URL.");
    std::vector<wchar_t> final_url(url_length / sizeof(wchar_t) + 1);
    require(WinHttpQueryOption(state.handle, WINHTTP_OPTION_URL, final_url.data(), &url_length));
    head.url = narrow(final_url.data(),
                      static_cast<int>(std::char_traits<wchar_t>::length(final_url.data())));
    head.headers = raw_headers(state.handle);
    exchange.deliver_head(std::move(head));
    for (;;) {
        require(
            WinHttpReadData(state.handle, buffer.get(), static_cast<DWORD>(read_size), nullptr));
        if (!state.wait(WINHTTP_CALLBACK_STATUS_READ_COMPLETE))
            return;
        if (state.bytes == 0)
            break;
        if (!exchange.push(std::vector<std::uint8_t>(buffer.get(), buffer.get() + state.bytes)))
            return;
    }
    exchange.finish();
#else
    /** Process-wide connection, DNS and TLS session caches shared across transfers. */
    struct CurlShare {
        CURLSH* value = nullptr;
        std::array<std::mutex, CURL_LOCK_DATA_LAST> locks;
        CurlShare() {
            if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
                throw std::runtime_error("HTTP initialization failed.");
            value = curl_share_init();
            if (!value)
                throw std::runtime_error("HTTP connection cache allocation failed.");
            const auto share = [&](CURLSHoption option, auto argument) {
                if (curl_share_setopt(value, option, argument) != CURLSHE_OK)
                    throw std::runtime_error("HTTP connection cache option failed.");
            };
            share(
                CURLSHOPT_LOCKFUNC, +[](CURL*, curl_lock_data data, curl_lock_access, void* self) {
                    static_cast<CurlShare*>(self)->locks[static_cast<std::size_t>(data)].lock();
                });
            share(
                CURLSHOPT_UNLOCKFUNC, +[](CURL*, curl_lock_data data, void* self) {
                    static_cast<CurlShare*>(self)->locks[static_cast<std::size_t>(data)].unlock();
                });
            share(CURLSHOPT_USERDATA, static_cast<void*>(this));
            share(CURLSHOPT_SHARE, CURL_LOCK_DATA_CONNECT);
            share(CURLSHOPT_SHARE, CURL_LOCK_DATA_DNS);
            share(CURLSHOPT_SHARE, CURL_LOCK_DATA_SSL_SESSION);
        }
        ~CurlShare() {
            curl_share_cleanup(value);
            curl_global_cleanup();
        }
    };
    static CurlShare shared;
    /**
     * The transfer's own multi handle: `curl_multi_poll` waits on its sockets, and a
     * cancellation wakes that wait at once (`curl_multi_wakeup`, thread-safe). The exchange's
     * wake keeps the handle alive past the transfer.
     */
    struct CurlMulti {
        CURLM* value = curl_multi_init();
        CurlMulti() = default;
        CurlMulti(const CurlMulti&) = delete;
        CurlMulti& operator=(const CurlMulti&) = delete;
        ~CurlMulti() {
            if (value)
                curl_multi_cleanup(value);
        }
    };
    const auto multi = std::make_shared<CurlMulti>();
    if (!multi->value)
        throw std::runtime_error("HTTP transfer allocation failed.");
    exchange.set_wake([multi] { curl_multi_wakeup(multi->value); });
    // A cancellation before the wake was installed still stops the transfer here.
    if (exchange.canceled())
        return;
    const std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> client(curl_easy_init(),
                                                                     curl_easy_cleanup);
    if (!client)
        throw std::runtime_error("HTTP client allocation failed.");
    auto option = [&](CURLoption name, auto value) {
        if (curl_easy_setopt(client.get(), name, value) != CURLE_OK)
            throw std::runtime_error("HTTP client option failed.");
    };
    /** Transfer state the callbacks reach through their user data. */
    struct Transfer {
        HttpExchange& exchange;
        CURL* client;
        HttpHeaderList headers;
        bool head_delivered = false;
        std::optional<std::string> failure;
        void deliver_head() {
            if (head_delivered)
                return;
            head_delivered = true;
            long status = 0;
            char* final_url = nullptr;
            if (curl_easy_getinfo(client, CURLINFO_RESPONSE_CODE, &status) != CURLE_OK ||
                curl_easy_getinfo(client, CURLINFO_EFFECTIVE_URL, &final_url) != CURLE_OK ||
                !final_url)
                throw std::runtime_error("HTTP response metadata unavailable.");
            HttpResponseHead head;
            head.status = static_cast<double>(status);
            head.url = final_url;
            head.headers = std::make_shared<HttpHeaderList>(std::move(headers));
            exchange.deliver_head(std::move(head));
        }
    } transfer{exchange, client.get(), {}, false, std::nullopt};
    option(CURLOPT_SHARE, shared.value);
    option(CURLOPT_URL, url.c_str());
    option(CURLOPT_PROTOCOLS_STR, "http,https");
    option(CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
    option(CURLOPT_FOLLOWLOCATION, 1L);
    option(CURLOPT_MAXREDIRS, 20L);
    option(CURLOPT_NOSIGNAL, 1L);
    option(CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    // No progress for 5 s fails a request; a long body may stream for as long as it moves.
    option(CURLOPT_LOW_SPEED_LIMIT, 1L);
    option(CURLOPT_LOW_SPEED_TIME, 5L);
    option(CURLOPT_USERAGENT, "bblitec/native");
    curl_slist* raw_headers = nullptr;
    struct Headers {
        curl_slist*& value;
        ~Headers() { curl_slist_free_all(value); }
    } headers{raw_headers};
    for (const auto& [name, value] : request.headers) {
        auto* appended =
            curl_slist_append(raw_headers, (name + (value.empty() ? ";" : ": " + value)).c_str());
        if (!appended)
            throw std::bad_alloc();
        raw_headers = appended;
    }
    if (request.body) {
        option(CURLOPT_POSTFIELDS, request.body->data());
        option(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(request.body->size()));
    }
    if (request.method == "POST")
        option(CURLOPT_POST, 1L);
    else if (request.method != "GET" && request.method != "HEAD")
        option(CURLOPT_CUSTOMREQUEST, request.method.c_str());
    if (request.method == "HEAD")
        option(CURLOPT_NOBODY, 1L);
    option(CURLOPT_HTTPHEADER, raw_headers);
    option(
        CURLOPT_HEADERFUNCTION,
        +[](char* data, std::size_t size, std::size_t count, void* target) -> std::size_t {
            auto& state = *static_cast<Transfer*>(target);
            const std::string_view line(data, size * count);
            // Each response of a redirect chain starts with its status line.
            if (line.starts_with("HTTP/"))
                state.headers.entries.clear();
            else
                append_header_line(state.headers, line.substr(0, line.find_first_of("\r\n")));
            return size * count;
        });
    option(CURLOPT_HEADERDATA, &transfer);
    option(
        CURLOPT_WRITEFUNCTION,
        +[](char* data, std::size_t size, std::size_t count, void* target) -> std::size_t {
            auto& state = *static_cast<Transfer*>(target);
            try {
                state.deliver_head();
                if (state.exchange.push(std::vector<std::uint8_t>(data, data + size * count)))
                    return size * count;
            } catch (const std::exception& error) {
                state.failure = error.what();
            } catch (...) {
                state.failure = "HTTP transport failed.";
            }
            return 0;
        });
    option(CURLOPT_WRITEDATA, &transfer);
    if (curl_multi_add_handle(multi->value, client.get()) != CURLM_OK)
        throw std::runtime_error("HTTP transfer start failed.");
    /** Removes the easy handle from the multi handle before either is released. */
    struct Attached {
        CURLM* multi;
        CURL* easy;
        ~Attached() { curl_multi_remove_handle(multi, easy); }
    } attached{multi->value, client.get()};
    for (int running = 1;;) {
        if (curl_multi_perform(multi->value, &running) != CURLM_OK)
            throw std::runtime_error("HTTP transfer failed.");
        if (exchange.canceled())
            return;
        if (!running)
            break;
        if (curl_multi_poll(multi->value, nullptr, 0, 1000, nullptr) != CURLM_OK)
            throw std::runtime_error("HTTP transfer wait failed.");
        if (exchange.canceled())
            return;
    }
    CURLcode performed = CURLE_OK;
    int queued = 0;
    while (const CURLMsg* message = curl_multi_info_read(multi->value, &queued))
        if (message->msg == CURLMSG_DONE && message->easy_handle == client.get())
            performed = message->data.result;
    if (transfer.failure)
        throw std::runtime_error(*transfer.failure);
    if (performed != CURLE_OK)
        throw std::runtime_error(std::string("HTTP transport failed: ") +
                                 curl_easy_strerror(performed));
    transfer.deliver_head();
    exchange.finish();
#endif
}
} // namespace bbl::pal
