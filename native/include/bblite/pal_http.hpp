#pragma once

#include <bblite/pal_fetch_response.hpp>
#include <stop_token>

namespace bbl::pal {

struct HttpRequest {
    std::string method = "GET";
    std::vector<std::pair<std::string, std::string>> headers;
    std::optional<std::string> body;
};

HttpResponseData perform_http_request(const std::string& url, HttpRequest request,
                                      std::stop_token stop);

inline js::Promise<HttpResponse> fetch_http(std::string url, HttpRequest request) {
    struct Completion final : CompletionEvent {
        HttpResponseData response;
        std::exception_ptr error;
        explicit Completion(std::uint64_t id) : CompletionEvent(id) {}
    };
    js::Promise<HttpResponse> result;
    auto& loop = EventLoop::current();
    auto job = std::make_shared<std::jthread>();
    const auto id = loop.register_completion(
        [result, job](std::unique_ptr<ExternalEvent> event) {
            auto* completion = dynamic_cast<Completion*>(event.get());
            if (!completion)
                throw std::logic_error("Incorrect HTTP completion payload.");
            if (completion->error)
                result.reject(completion->error);
            else
                result.resolve(js::make_ref<HttpResponseData>(std::move(completion->response)));
        },
        [job] { job->request_stop(); });
    try {
        *job = std::jthread([inbox = loop.inbox(), id, url = std::move(url),
                             request = std::move(request)](std::stop_token stop) mutable {
            auto completion = std::make_unique<Completion>(id);
            try {
                completion->response = perform_http_request(url, std::move(request), stop);
            } catch (...) {
                completion->error = std::current_exception();
            }
            inbox->post(std::move(completion));
        });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}

} // namespace bbl::pal
