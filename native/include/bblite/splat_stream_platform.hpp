#pragma once

// The web platform the pinned splat-stream library calls, as the lowered
// library (src/lowering/splat-stream-records.ts) spells it. Declarations
// only, typed like the web APIs they stand for: the platform build defines
// them over its native services, a test over deterministic fakes. Every
// object is a handle shared by identity, as the JavaScript object is;
// every call happens on the realm thread, and every promise settles on the
// realm's event loop.

#include <bblite/gpu_object.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>

#include <cstdint>
#include <memory>
#include <string>

namespace bbl {
struct GpuDevice;
struct GpuExtent3D;
} // namespace bbl

namespace bbl::splat_stream_platform {

// ── URL (WHATWG) ───────────────────────────────────────────────────────

struct UrlState;
using Url = std::shared_ptr<UrlState>;

/** `new URL(input)`; a TypeError (`bbl::js::NamedError`) when it does not parse. */
[[nodiscard]] Url url_parse(const std::string& input);
/** `new URL(input, base)`: `input` resolved against `base`. */
[[nodiscard]] Url url_parse(const std::string& input, const std::string& base);
/** `url.href`: the serialized URL. */
[[nodiscard]] std::string url_href(const Url& url);
/** `url.protocol`: the scheme with its colon (`"https:"`). */
[[nodiscard]] std::string url_protocol(const Url& url);
/** `url.pathname`: the percent-encoded path. */
[[nodiscard]] std::string url_pathname(const Url& url);
/** `url.pathname = value`: the path replaced, as the setter parses it. */
void url_set_pathname(const Url& url, const std::string& pathname);

// ── DOMException ───────────────────────────────────────────────────────

/** `new DOMException(message, name)`: an error whose `name` is `name`. */
[[nodiscard]] js::Error dom_exception(const std::string& message, const std::string& name);
/** `error instanceof DOMException`. */
[[nodiscard]] bool is_dom_exception(const js::Error& error);

// ── AbortController / AbortSignal ──────────────────────────────────────

struct AbortSignalState;
using AbortSignal = std::shared_ptr<AbortSignalState>;
struct AbortControllerState;
using AbortController = std::shared_ptr<AbortControllerState>;

/** `new AbortController()`. */
[[nodiscard]] AbortController abort_controller_create();
/** `controller.signal`: the same signal every read. */
[[nodiscard]] AbortSignal abort_controller_signal(const AbortController& controller);
/**
 * `controller.abort(reason)`: once; an empty reason is a DOMException named
 * `AbortError`. Listeners run synchronously, in registration order.
 */
void abort_controller_abort(const AbortController& controller, const js::Error& reason);
/** `signal.aborted`. */
[[nodiscard]] bool abort_signal_aborted(const AbortSignal& signal);
/** `signal.reason`: empty until aborted. */
[[nodiscard]] js::Error abort_signal_reason(const AbortSignal& signal);
/** The `{ once }` options of `addEventListener`. */
struct AddEventListenerOptions {
    js::Nullable<bool> once;
};
/**
 * `signal.addEventListener(type, listener, options)`: only `"abort"` is
 * admitted; a listener already added (by identity) is ignored.
 */
void abort_signal_add_event_listener(const AbortSignal& signal, const std::string& type,
                                     const js::Callback<void()>& listener,
                                     const js::Nullable<AddEventListenerOptions>& options);
/** `signal.removeEventListener(type, listener)`, by the listener's identity. */
void abort_signal_remove_event_listener(const AbortSignal& signal, const std::string& type,
                                        const js::Callback<void()>& listener);

// ── fetch ──────────────────────────────────────────────────────────────

/** The `RequestInit` the pin passes: `{ signal }`. */
struct RequestInit {
    AbortSignal signal;
};

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
 * streaming; a network failure rejects with a TypeError; an abort rejects
 * with the signal's reason (and errors a body still streaming).
 */
[[nodiscard]] js::Promise<Response> fetch(const std::string& url, const RequestInit& init);
[[nodiscard]] js::Promise<Response> fetch(const Url& url, const RequestInit& init);
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

// ── Blob and images ────────────────────────────────────────────────────

struct BlobState;
using Blob = std::shared_ptr<BlobState>;

/** The `{ type }` options of `new Blob`. */
struct BlobPropertyBag {
    js::Nullable<std::string> type;
};
/** `new Blob(chunks, { type })`: the chunks' bytes, copied in order. */
[[nodiscard]] Blob blob_create(const js::Array<js::TypedArray<std::uint8_t>>& chunks,
                               const BlobPropertyBag& options);
/** `blob.text()`: its bytes as UTF-8 text. */
[[nodiscard]] js::Promise<std::string> blob_text(const Blob& blob);

/** The `ImageBitmapOptions` the pin passes (`"none"` for each). */
struct ImageBitmapOptions {
    js::Nullable<std::string> premultiply_alpha;
    js::Nullable<std::string> color_space_conversion;
    js::Nullable<std::string> image_orientation;
};

struct ImageBitmapState;
using ImageBitmap = std::shared_ptr<ImageBitmapState>;

/** `createImageBitmap(blob, options)`: the decoded image, or a rejection. */
[[nodiscard]] js::Promise<ImageBitmap> create_image_bitmap(const Blob& blob,
                                                           const ImageBitmapOptions& options);
/** `bitmap.width`, `bitmap.height`, `bitmap.close()`. */
[[nodiscard]] double image_bitmap_width(const ImageBitmap& bitmap);
[[nodiscard]] double image_bitmap_height(const ImageBitmap& bitmap);
void image_bitmap_close(const ImageBitmap& bitmap);

/** `{ source: bitmap, flipY }` of `copyExternalImageToTexture`. */
struct CopyExternalImageSource {
    ImageBitmap source;
    js::Nullable<bool> flip_y;
};
/** `{ texture, premultipliedAlpha }` of `copyExternalImageToTexture`. */
struct CopyExternalImageDestination {
    GpuHandle texture;
    js::Nullable<bool> premultiplied_alpha;
};
/** `device.queue.copyExternalImageToTexture(source, destination, size)`. */
void copy_external_image_to_texture(GpuDevice& device, const CopyExternalImageSource& source,
                                    const CopyExternalImageDestination& destination,
                                    const GpuExtent3D& size);

// ── TextDecoder ────────────────────────────────────────────────────────

struct TextDecoderState;
using TextDecoder = std::shared_ptr<TextDecoderState>;

/** `new TextDecoder()` (UTF-8, replacement on invalid input). */
[[nodiscard]] TextDecoder text_decoder_create();
/** `decoder.decode(bytes)`. */
[[nodiscard]] std::string text_decoder_decode(const TextDecoder& decoder,
                                              const js::TypedArray<std::uint8_t>& bytes);

// ── Timers and tasks ───────────────────────────────────────────────────

/** `setTimeout(callback, milliseconds)`: its timer id. */
double set_timeout(const js::Callback<void()>& callback, double milliseconds);
/** `clearTimeout(id)`. */
void clear_timeout(double id);
/** `queueMicrotask(callback)`. */
void queue_microtask(const js::Callback<void()>& callback);
/** `performance.now()`. */
[[nodiscard]] double performance_now();

} // namespace bbl::splat_stream_platform
