#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>
#include <stop_token>

namespace bbl::pal {

struct HttpRequest {
    std::string method = "GET";
    std::vector<std::pair<std::string, std::string>> headers;
    std::optional<std::string> body;
};

/** Transport records contain no realm-owned objects. */
struct HttpResponseData {
    double status = 0;
    std::string url;
    std::vector<std::uint8_t> body;
    bool consumed = false;
};
using HttpResponse = js::Ref<HttpResponseData>;

HttpResponseData perform_http_request(const std::string& url, HttpRequest request, std::stop_token stop);
std::string decode_http_text(const std::vector<std::uint8_t>& bytes);

inline js::Promise<HttpResponse> fetch_http(std::string url, HttpRequest request) {
    struct Completion final : CompletionEvent {
        HttpResponseData response;
        std::exception_ptr error;
        explicit Completion(std::uint64_t id) : CompletionEvent(id) {}
    };
    js::Promise<HttpResponse> result;
    auto& loop = EventLoop::current();
    auto job = std::make_shared<std::jthread>();
    const auto id = loop.register_completion([result, job](std::unique_ptr<ExternalEvent> event) {
        auto* completion = dynamic_cast<Completion*>(event.get());
        if (!completion) throw std::logic_error("Incorrect HTTP completion payload.");
        if (completion->error) result.reject(completion->error);
        else result.resolve(js::make_ref<HttpResponseData>(std::move(completion->response)));
    }, [job] { job->request_stop(); });
    try {
        *job = std::jthread([inbox = loop.inbox(), id, url = std::move(url), request = std::move(request)](std::stop_token stop) mutable {
            auto completion = std::make_unique<Completion>(id);
            try { completion->response = perform_http_request(url, std::move(request), stop); }
            catch (...) { completion->error = std::current_exception(); }
            inbox->post(std::move(completion));
        });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
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
