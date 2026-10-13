#pragma once

#include <bblite/pal_fetch_response.hpp>

namespace bbl::pal {

struct HttpRequest {
    std::string method = "GET";
    std::vector<std::pair<std::string, std::string>> headers;
    std::optional<std::string> body;
};

/**
 * Run one HTTP(S) transfer on the calling (transport) thread, delivering its head, body chunks
 * and end or failure to `exchange` until it ends or `exchange` is canceled. Connections are
 * pooled per process: WinHTTP shares one asynchronous session (6 connections per server, HTTP/2
 * where the OS supports it); libcurl shares its connection, DNS and TLS session caches.
 */
void perform_http_transfer(const std::string& url, HttpRequest request, HttpExchange& exchange);

namespace http_detail {
/** The realm side of one fetch until its head arrives. */
struct PendingFetch {
    js::Promise<HttpResponse> result;
    std::shared_ptr<HttpTransport> transport;
    bool head_method = false;
    js::AbortSignal signal;
    js::AbortSignal::AlgorithmId algorithm = 0;
    bool settled = false;
};
/** Where a fetch's abort algorithm acts: the pending fetch, then its body. Weak only, so the
 * algorithm the signal keeps retains no realm object. */
struct AbortRoute {
    std::weak_ptr<PendingFetch> fetch;
    std::weak_ptr<HttpBodyState> body;
};
} // namespace http_detail

/**
 * `fetch(url, { method, headers, body, signal })` over native transport. The promise fulfills
 * with the head (status, URL, headers) while the body streams; transport failures reject with a
 * TypeError. An aborted `signal` rejects with its reason before any transfer; aborting later
 * rejects a pending fetch, or errors a readable body, with the reason, and cancels the transfer.
 */
inline js::Promise<HttpResponse> fetch_http(std::string url, HttpRequest request,
                                            js::AbortSignal signal = {}) {
    if (signal && signal.aborted())
        return js::Promise<HttpResponse>::rejected(*signal.reason());
    auto& loop = EventLoop::current();
    auto pending = std::make_shared<http_detail::PendingFetch>();
    const auto route = std::make_shared<http_detail::AbortRoute>();
    route->fetch = pending;
    pending->head_method = request.method == "HEAD" || request.method == "head";
    pending->signal = signal;
    pending->transport = std::make_shared<HttpTransport>();
    const auto finish_abort = [](http_detail::PendingFetch& fetch) {
        if (fetch.algorithm) {
            fetch.signal.remove_algorithm(fetch.algorithm);
            fetch.algorithm = 0;
        }
    };
    const auto head = loop.register_completion(
        [pending, route, finish_abort](std::unique_ptr<ExternalEvent>) {
            if (pending->settled)
                return;
            pending->settled = true;
            std::string failure;
            auto received = pending->transport->exchange->take_head(failure);
            if (!received) {
                finish_abort(*pending);
                pending->transport.reset();
                pending->result.reject(http_detail::type_error(failure));
                return;
            }
            auto state = js::make_gc_shared<HttpBodyState>();
            state->transport = std::move(pending->transport);
            const bool null_body = pending->head_method || http_null_body_status(received->status);
            if (null_body) {
                finish_abort(*pending);
                state->phase = HttpBodyState::Phase::closed;
                state->transport->exchange->cancel();
            } else {
                // The abort algorithm now errors the body instead of the fetch.
                state->signal = pending->signal;
                state->algorithm = std::exchange(pending->algorithm, 0);
                route->body = state;
            }
            auto response = js::make_ref<HttpResponseData>(
                HttpResponseData{received->status, std::move(received->url),
                                 HttpHeaders(std::move(received->headers)),
                                 null_body ? std::optional<BodyStream>()
                                           : std::optional<BodyStream>(BodyStream(state)),
                                 false});
            pending->result.resolve(std::move(response));
        },
        [pending] {
            if (pending->transport && pending->transport->exchange)
                pending->transport->exchange->cancel();
        });
    auto exchange = std::make_shared<HttpExchange>(loop.inbox(), head);
    pending->transport->exchange = exchange;
    if (signal)
        pending->algorithm = signal.add_algorithm([route, head, &loop](const js::Error& reason) {
            if (const auto fetch = route->fetch.lock(); fetch && !fetch->settled) {
                fetch->settled = true;
                fetch->algorithm = 0;
                const auto transport = std::move(fetch->transport);
                loop.cancel_completion(head);
                fetch->result.reject(reason);
                return;
            }
            if (const auto body = route->body.lock()) {
                body->algorithm = 0;
                http_detail::error(*body, reason);
            }
        });
    try {
        pending->transport->thread =
            JoiningThread([exchange, url = std::move(url), request = std::move(request)]() mutable {
                try {
                    perform_http_transfer(url, std::move(request), *exchange);
                } catch (const std::exception& error) {
                    exchange->fail(error.what());
                } catch (...) {
                    exchange->fail("HTTP transport failed.");
                }
            });
    } catch (...) {
        finish_abort(*pending);
        loop.cancel_completion(head);
        pending->result.reject(std::current_exception());
    }
    return pending->result;
}

} // namespace bbl::pal
