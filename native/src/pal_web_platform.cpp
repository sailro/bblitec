// The web platform seam (bblite/web_platform.hpp) over the native services:
// fetch with streamed bodies (pal_http.hpp), image decoding on the native
// workers (pal_image_bitmap.hpp), and the realm event loop's timers and
// microtasks. Everything else the lowered libraries reach is the runtime's own
// objects, spelled by src/lowering/web-platform-schema.ts.

#include <bblite/js_promise.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_http.hpp>
#include <bblite/pal_image_bitmap.hpp>
#include <bblite/pal_packaged_responses.hpp>
#include <bblite/web_platform.hpp>

#include <memory>
#include <optional>
#include <string>
#include <utility>

namespace bbl::web_platform {

struct ReadableStreamState {
    pal::BodyStream stream;
};
struct ReaderState {
    pal::BodyReader reader;
};
struct ResponseState {
    pal::HttpResponse response;
    /** `response.body`: one stream object, created on the first read. */
    ReadableStream body;
};

namespace {

/**
 * A platform promise seen as the seam's: the same promise (its identity and
 * reaction order), its result wrapped once, so every read of the value names
 * one object.
 */
template <class Result, class Source, class Wrap>
js::Promise<Result> wrapped(const js::Promise<Source>& source, Wrap wrap) {
    auto made = std::make_shared<std::optional<Result>>();
    return js::Promise<Result>::view(source, [made, wrap](const Source& value) {
        if (!*made)
            *made = wrap(value);
        return **made;
    });
}

} // namespace

// ── fetch ──────────────────────────────────────────────────────────────

namespace {

/** The library's view of an application response: one object per response. */
Response response_of(const pal::HttpResponse& response) {
    return std::make_shared<ResponseState>(ResponseState{response, nullptr});
}

} // namespace

js::Promise<pal::HttpResponse> fetch_response(const std::string& url,
                                              const js::Nullable<RequestInit>& init) {
    pal::HttpRequest request;
    if (init && init->headers)
        request.headers = init->headers->entries();
    return pal::fetch_deployed(url, std::move(request), init ? init->signal : js::AbortSignal{});
}

js::Promise<Response> fetch(const std::string& url, const RequestInit& init) {
    return wrapped<Response>(fetch_response(url, init), response_of);
}

js::Callback<js::Promise<Response>(std::string, js::Nullable<RequestInit>)>
fetch_function(ApplicationFetch fetch) {
    return js::Callback<js::Promise<Response>(std::string, js::Nullable<RequestInit>)>(
        [fetch](std::string url, js::Nullable<RequestInit> init) {
            return wrapped<Response>(fetch(std::move(url), std::move(init)), response_of);
        });
}
bool response_ok(const Response& response) { return pal::http_response_ok(response->response); }
double response_status(const Response& response) { return response->response->status; }
std::string response_status_text(const Response& response) {
    return response->response->status_text;
}
js::Promise<js::ArrayBuffer> response_array_buffer(const Response& response) {
    return pal::http_response_buffer(response->response);
}
std::string response_url(const Response& response) { return response->response->url; }
pal::HttpHeaders response_headers(const Response& response) { return response->response->headers; }
ReadableStream response_body(const Response& response) {
    if (!response->body) {
        const auto body = pal::http_response_body(response->response);
        if (!body)
            return nullptr;
        response->body = std::make_shared<ReadableStreamState>(ReadableStreamState{*body});
    }
    return response->body;
}
js::Promise<js::PromiseVoid> readable_stream_cancel(const ReadableStream& stream) {
    return stream->stream.cancel();
}
Reader readable_stream_get_reader(const ReadableStream& stream) {
    return std::make_shared<ReaderState>(ReaderState{stream->stream.get_reader()});
}
js::Promise<ReadResult> reader_read(const Reader& reader) {
    return wrapped<ReadResult>(reader->reader.read(), [](const pal::BodyReadResult& part) {
        if (part.done)
            return ReadResult{true, std::nullopt};
        // The chunk's own bytes, viewed rather than copied.
        return ReadResult{
            false, js::TypedArray<std::uint8_t>(part.value.buffer(),
                                                static_cast<double>(part.value.byte_offset()),
                                                static_cast<double>(part.value.size()))};
    });
}
js::Promise<js::PromiseVoid> reader_cancel(const Reader& reader) { return reader->reader.cancel(); }
void reader_release_lock(const Reader& reader) { reader->reader.release_lock(); }

// ── Images ─────────────────────────────────────────────────────────────

js::Promise<pal::ImageBitmap> create_image_bitmap(const js::Blob& blob,
                                                  pal::ImageBitmapOptions options) {
    return pal::create_image_bitmap(blob, options);
}

// ── Timers and tasks ───────────────────────────────────────────────────

double set_timeout(const js::Callback<void()>& callback, double milliseconds) {
    return static_cast<double>(
        pal::EventLoop::current().set_timeout([callback] { callback(); }, milliseconds));
}
void clear_timeout(double id) {
    if (id >= 1)
        pal::EventLoop::current().clear_timer(static_cast<pal::EventLoop::TimerId>(id));
}
void queue_microtask(const js::Callback<void()>& callback) {
    pal::EventLoop::current().queue_microtask([callback] { callback(); });
}
double performance_now() { return pal::performance_milliseconds(); }

} // namespace bbl::web_platform
