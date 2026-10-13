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
/** The `RequestInit` the pin passes: `{ signal }`. */
struct RequestInit {
    js::AbortSignal signal;
};

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
 * `fetch(url, { signal })`: fulfills once the response head arrives, its body
 * streaming; a network failure rejects with a TypeError; an abort rejects with
 * the signal's reason (and errors a body still streaming).
 */
[[nodiscard]] js::Promise<Response> fetch(const std::string& url, const RequestInit& init);
[[nodiscard]] inline js::Promise<Response> fetch(const js::Url& url, const RequestInit& init) {
    return fetch(url.href(), init);
}
/** `response.ok`, `response.status`, `response.url`. */
[[nodiscard]] bool response_ok(const Response& response);
[[nodiscard]] double response_status(const Response& response);
[[nodiscard]] std::string response_url(const Response& response);
/** `response.headers.get(name)`: null when absent. */
[[nodiscard]] js::Nullable<std::string> response_header(const Response& response,
                                                        const std::string& name);
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
