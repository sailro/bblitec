#pragma once

// The web platform pinned libraries reach once the record model lowers them
// (src/lowering/web-platform-schema.ts), over the runtime's own objects: a URL
// is a js::Url, an AbortController/AbortSignal the js_abort.hpp ones, a
// DOMException js_error.hpp's, a TextDecoder js_text_codec.hpp's, a Blob
// js_file.hpp's and an ImageBitmap pal_image_bitmap.hpp's. The dictionaries the
// pin builds as literals are declared here.
//
// Only fetch with its response and body stream, image decoding, and the timers
// and task queue are a seam: declared here, defined over the native services by
// native/src/pal_web_platform.cpp, or by a deterministic test fixture
// (test/fixtures/splat-stream-transport-check.cpp).

#include <bblite/gpu.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/js_callback.hpp>
#include <bblite/js_error.hpp>
#include <bblite/js_file.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/js_text_codec.hpp>
#include <bblite/js_url.hpp>
#include <bblite/pal_fetch_response.hpp>
#include <bblite/pal_image_bitmap.hpp>

#include <cstdint>
#include <exception>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>

namespace bbl::web_platform {

// ── Dictionaries ───────────────────────────────────────────────────────

/** `{ once }` of `signal.addEventListener("abort", listener, options)`. */
struct AddEventListenerOptions {
    js::Nullable<bool> once;
};
/** `{ fatal, ignoreBOM }` of `new TextDecoder(label, options)`. */
struct TextDecoderOptions {
    js::Nullable<bool> fatal;
    js::Nullable<bool> ignore_bom;
};
/** `{ stream }` of `decoder.decode(input, options)`. */
struct TextDecodeOptions {
    js::Nullable<bool> stream;
};
/** `{ type }` of `new Blob(parts, options)`. */
struct BlobPropertyBag {
    js::Nullable<std::string> type;
};
/** `{ source, flipY }` of `queue.copyExternalImageToTexture`. */
struct CopyExternalImageSource {
    pal::ImageBitmap source;
    js::Nullable<bool> flip_y;
};
/** `{ texture, premultipliedAlpha }` of `queue.copyExternalImageToTexture`. */
struct CopyExternalImageDestination {
    GpuHandle texture;
    js::Nullable<bool> premultiplied_alpha;
};
/**
 * The `RequestInit` the pin passes: `{ headers, signal, credentials }`, its headers a Headers
 * object. The native transport keeps no ambient credentials (no cookie jar or HTTP
 * authentication cache), so every credentials mode sends what `"omit"` sends.
 */
struct RequestInit {
    js::AbortSignal signal;
    js::Nullable<pal::HttpHeaders> headers{};
    js::Nullable<std::string> credentials{};
};

/** `init.signal`: absent when the request set none. */
[[nodiscard]] inline js::Nullable<js::AbortSignal> request_signal(const RequestInit& init) {
    return init.signal ? js::Nullable<js::AbortSignal>(init.signal)
                       : js::Nullable<js::AbortSignal>();
}

/** `new Headers()`: an empty list the program may change. */
[[nodiscard]] inline pal::HttpHeaders make_headers() { return pal::HttpHeaders::mutable_list(); }
/** `new Headers(headers)`: a copy of another Headers object's fields, in order. */
[[nodiscard]] inline pal::HttpHeaders make_headers(const pal::HttpHeaders& init) {
    return init.copy();
}
/** `new Headers([[name, value], ...])`: each pair appended; another length is a TypeError. */
[[nodiscard]] inline pal::HttpHeaders make_headers(const js::Array<js::Array<std::string>>& init) {
    auto headers = make_headers();
    for (const auto& pair : init) {
        if (pair.size() != 2)
            throw js::NamedError("TypeError", "Failed to construct 'Headers': Invalid value");
        headers.append(pair[0], pair[1]);
    }
    return headers;
}
/** `new Headers({ name: value })`: the record's fields appended in order. */
[[nodiscard]] inline pal::HttpHeaders make_headers(const js::Map<std::string, std::string>& init) {
    auto headers = make_headers();
    for (const auto& [name, value] : init)
        headers.append(name, value);
    return headers;
}
/** `new Headers(init)` over a `HeadersInit` union. */
template <class... Forms>
[[nodiscard]] pal::HttpHeaders make_headers(const std::variant<Forms...>& init) {
    return std::visit([](const auto& form) { return make_headers(form); }, init);
}
/** `new Headers(init)` with an optional init: absent is empty. */
template <class Init> [[nodiscard]] pal::HttpHeaders make_headers(const js::Nullable<Init>& init) {
    return init ? make_headers(*init) : make_headers();
}

// ── Calls over the runtime's objects ───────────────────────────────────

/** `controller.abort(reason)`: an absent reason aborts with the default AbortError. */
inline void abort(const js::AbortController& controller, const js::Error& reason) {
    controller.abort(static_cast<std::exception_ptr>(reason) ? std::optional<js::Error>(reason)
                                                             : std::nullopt);
}
/** The `once` of an `addEventListener` options dictionary. */
[[nodiscard]] inline bool once(const js::Nullable<AddEventListenerOptions>& options) {
    return options && options->once.value_or(false);
}
/** `new TextDecoder("utf-8", options)`: the label names UTF-8 (checked at generation). */
[[nodiscard]] inline js::TextDecoder text_decoder(const js::Nullable<TextDecoderOptions>& options) {
    return js::make_text_decoder(options && options->fatal.value_or(false),
                                 options && options->ignore_bom.value_or(false));
}
/** `decoder.decode(input, options)`. */
[[nodiscard]] inline std::string text_decode(const js::TextDecoder& decoder,
                                             const js::TypedArray<std::uint8_t>& input,
                                             const js::Nullable<TextDecodeOptions>& options) {
    return js::text_decode(decoder, input, options && options->stream.value_or(false));
}

/**
 * `queue.copyExternalImageToTexture({ source: bitmap, flipY }, { texture,
 * premultipliedAlpha }, size)`: the bitmap's decoded RGBA8 rows written to the
 * texture's origin, as WebGPU copies an unflipped, unconverted source.
 */
inline void copy_external_image_to_texture(GpuDevice& device, const CopyExternalImageSource& source,
                                           const CopyExternalImageDestination& destination,
                                           const GpuExtent3D& size) {
    const auto& bitmap = source.source;
    if (source.flip_y.value_or(false))
        throw std::runtime_error("copyExternalImageToTexture flipY is not supported natively.");
    if (destination.premultiplied_alpha.value_or(false) != bitmap.premultiplied())
        throw std::runtime_error(
            "copyExternalImageToTexture converts alpha premultiplication only natively "
            "when the bitmap already has the destination's.");
    if (size.width > bitmap.width() || size.height > bitmap.height() ||
        size.depth_or_array_layers != 1)
        throw std::runtime_error("copyExternalImageToTexture copies outside its source bitmap.");
    const auto& pixels = bitmap.pixels();
    device.write_texture(GpuTexelCopyTextureInfo{destination.texture},
                         std::span<const std::uint8_t>(pixels->data(), pixels->size()),
                         GpuTexelCopyBufferLayout{0.0, bitmap.width() * 4, bitmap.height()}, size);
}

// ── The seam: fetch, image decoding, timers and tasks ──────────────────

struct ResponseState;
using Response = std::shared_ptr<ResponseState>;
struct ReadableStreamState;
using ReadableStream = std::shared_ptr<ReadableStreamState>;
struct ReaderState;
using Reader = std::shared_ptr<ReaderState>;

/** `ReadableStreamReadResult<Uint8Array>`: `value` is present while not `done`. */
struct ReadResult {
    bool done = false;
    js::Nullable<js::TypedArray<std::uint8_t>> value;
};

/**
 * `fetch(url, { headers, signal })`: fulfills once the response head arrives, its body
 * streaming; a network failure rejects with a TypeError; an abort rejects with the signal's
 * reason (and errors a body still streaming). A URL the program packaged
 * (`pal_packaged_responses.hpp`) is its packaged file instead, a single `Range` of it as a
 * static file server answers one.
 */
[[nodiscard]] js::Promise<Response> fetch(const std::string& url, const RequestInit& init);
[[nodiscard]] inline js::Promise<Response> fetch(const js::Url& url, const RequestInit& init) {
    return fetch(url.href(), init);
}
/** The same request, its response the application's (`pal::HttpResponse`); no init is empty. */
[[nodiscard]] js::Promise<pal::HttpResponse> fetch_response(std::string url,
                                                            const js::Nullable<RequestInit>& init);
/**
 * An application function of `typeof fetch`'s signature as a library's fetch: each
 * response it settles with is the library's view of that one object.
 */
using ApplicationFetch =
    js::Callback<js::Promise<pal::HttpResponse>(std::string, js::Nullable<RequestInit>)>;
[[nodiscard]] js::Callback<js::Promise<Response>(std::string, js::Nullable<RequestInit>)>
fetch_function(ApplicationFetch fetch);
/** `response.ok`, `response.status`, `response.statusText`, `response.url`. */
[[nodiscard]] bool response_ok(const Response& response);
[[nodiscard]] double response_status(const Response& response);
[[nodiscard]] std::string response_status_text(const Response& response);
[[nodiscard]] std::string response_url(const Response& response);
/** `response.arrayBuffer()`: the whole body, within the buffered-body bound. */
[[nodiscard]] js::Promise<js::ArrayBuffer> response_array_buffer(const Response& response);
/** `response.headers`: the response's own Headers object (immutable guard). */
[[nodiscard]] pal::HttpHeaders response_headers(const Response& response);
/** `response.body`: the same stream every read; null for a bodiless response. */
[[nodiscard]] ReadableStream response_body(const Response& response);
/** `body.cancel()`. */
[[nodiscard]] js::Promise<js::PromiseVoid> readable_stream_cancel(const ReadableStream& stream);
/** `body.getReader()`: a TypeError when the stream is locked. */
[[nodiscard]] Reader readable_stream_get_reader(const ReadableStream& stream);
/** `reader.read()`: the next chunk, each its own Uint8Array, or `done`. */
[[nodiscard]] js::Promise<ReadResult> reader_read(const Reader& reader);
/** `reader.cancel()`. */
[[nodiscard]] js::Promise<js::PromiseVoid> reader_cancel(const Reader& reader);
/** `reader.releaseLock()`. */
void reader_release_lock(const Reader& reader);

/** `createImageBitmap(blob, options)`: the decoded image, or a rejection. */
[[nodiscard]] js::Promise<pal::ImageBitmap> create_image_bitmap(const js::Blob& blob,
                                                                pal::ImageBitmapOptions options);

/** `setTimeout(callback, milliseconds)`: its timer id. */
double set_timeout(const js::Callback<void()>& callback, double milliseconds);
/** `clearTimeout(id)`. */
void clear_timeout(double id);
/** `queueMicrotask(callback)`. */
void queue_microtask(const js::Callback<void()>& callback);
/** `performance.now()`. */
[[nodiscard]] double performance_now();

} // namespace bbl::web_platform
