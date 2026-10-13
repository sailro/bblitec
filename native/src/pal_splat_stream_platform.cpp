// The splat-stream library's web platform (bblite/splat_stream_platform.hpp
// and the loader's additions in bblite/splat_stream_runtime.hpp), defined over
// the native services: WHATWG URL (js_url.hpp), AbortController/AbortSignal
// and DOMException (js_abort.hpp, js_error.hpp), fetch with streamed bodies
// (pal_http.hpp), Blob and createImageBitmap (js_file.hpp,
// pal_image_bitmap.hpp), the Encoding Standard decoder (js_text_codec.hpp),
// the WebGPU subset's texture writes (gpu.hpp) and the realm's event loop.

#include <bblite/gpu.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/js_error.hpp>
#include <bblite/js_file.hpp>
#include <bblite/js_text_codec.hpp>
#include <bblite/js_url.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_http.hpp>
#include <bblite/pal_image_bitmap.hpp>
#include <bblite/splat_stream_platform.hpp>
#include <bblite/splat_stream_runtime.hpp>

#include <algorithm>
#include <cctype>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::splat_stream_platform {

struct UrlState {
    js::Url url;
};
struct AbortSignalState {
    js::AbortSignal signal;
};
struct AbortControllerState {
    js::AbortController controller;
    AbortSignal signal;
};
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
struct BlobState {
    js::Blob blob;
};
struct ImageBitmapState {
    pal::ImageBitmap bitmap;
};
struct TextDecoderState {
    js::TextDecoder decoder;
};

namespace {

/**
 * A platform promise seen as the library's: the same promise (its identity
 * and reaction order), its result wrapped once, so every read of the value
 * names one object.
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

std::string ascii_lowercase(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return text;
}

} // namespace

// ── URL ────────────────────────────────────────────────────────────────

Url url_parse(const std::string& input) {
    return std::make_shared<UrlState>(UrlState{js::Url(input)});
}
Url url_parse(const std::string& input, const std::string& base) {
    return std::make_shared<UrlState>(UrlState{js::Url(input, std::string_view(base))});
}
std::string url_href(const Url& url) { return url->url.href(); }
std::string url_protocol(const Url& url) { return url->url.protocol(); }
std::string url_pathname(const Url& url) { return url->url.pathname(); }
void url_set_pathname(const Url& url, const std::string& pathname) {
    url->url.set_pathname(pathname);
}

// ── DOMException ───────────────────────────────────────────────────────

js::Error dom_exception(const std::string& message, const std::string& name) {
    return js::Error(std::make_exception_ptr(js::make_dom_exception(message, name)));
}
bool is_dom_exception(const js::Error& error) {
    return js::is_dom_exception(static_cast<std::exception_ptr>(error));
}

// ── AbortController / AbortSignal ──────────────────────────────────────

AbortSignal abort_signal_of(const js::AbortSignal& signal) {
    if (!signal)
        throw std::runtime_error("The splat stream's abort signal is absent.");
    return std::make_shared<AbortSignalState>(AbortSignalState{signal});
}
AbortController abort_controller_create() {
    auto controller = js::AbortController::create();
    return std::make_shared<AbortControllerState>(
        AbortControllerState{controller, abort_signal_of(controller.signal())});
}
AbortSignal abort_controller_signal(const AbortController& controller) {
    return controller->signal;
}
void abort_controller_abort(const AbortController& controller, const js::Error& reason) {
    controller->controller.abort(
        static_cast<std::exception_ptr>(reason) ? std::optional<js::Error>(reason) : std::nullopt);
}
bool abort_signal_aborted(const AbortSignal& signal) { return signal->signal.aborted(); }
js::Error abort_signal_reason(const AbortSignal& signal) {
    return signal->signal.reason().value_or(js::Error{});
}
void abort_signal_add_event_listener(const AbortSignal& signal, const std::string& type,
                                     const js::Callback<void()>& listener,
                                     const js::Nullable<AddEventListenerOptions>& options) {
    if (type != "abort")
        throw std::logic_error("The splat stream listens to abort events only.");
    signal->signal.add_abort_listener(listener, options && options->once.value_or(false));
}
void abort_signal_remove_event_listener(const AbortSignal& signal, const std::string& type,
                                        const js::Callback<void()>& listener) {
    if (type != "abort")
        throw std::logic_error("The splat stream listens to abort events only.");
    signal->signal.remove_abort_listener(listener);
}

// ── fetch ──────────────────────────────────────────────────────────────

js::Promise<Response> fetch(const std::string& url, const RequestInit& init) {
    return wrapped<Response>(pal::fetch_http(url, pal::HttpRequest{"GET", {}, std::nullopt},
                                             init.signal ? init.signal->signal : js::AbortSignal{}),
                             [](const pal::HttpResponse& response) {
                                 return std::make_shared<ResponseState>(
                                     ResponseState{response, nullptr});
                             });
}
js::Promise<Response> fetch(const Url& url, const RequestInit& init) {
    return fetch(url->url.href(), init);
}
bool response_ok(const Response& response) { return pal::http_response_ok(response->response); }
double response_status(const Response& response) { return response->response->status; }
std::string response_url(const Response& response) { return response->response->url; }
js::Nullable<std::string> response_header(const Response& response, const std::string& name) {
    return response->response->headers.get(name);
}
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
        // Each chunk is its own Uint8Array.
        return ReadResult{false,
                          js::TypedArray<std::uint8_t>(part.value.begin(), part.value.end())};
    });
}
js::Promise<js::PromiseVoid> reader_cancel(const Reader& reader) { return reader->reader.cancel(); }
void reader_release_lock(const Reader& reader) { reader->reader.release_lock(); }

// ── Blob and images ────────────────────────────────────────────────────

Blob blob_create(const js::Array<js::TypedArray<std::uint8_t>>& chunks,
                 const BlobPropertyBag& options) {
    std::vector<js::ArrayBuffer> parts;
    parts.reserve(chunks.size());
    for (const auto& chunk : chunks) {
        std::vector<std::uint8_t> bytes(chunk.size());
        for (std::size_t index = 0; index < chunk.size(); ++index)
            bytes[index] = chunk.load(index);
        parts.emplace_back(std::move(bytes));
    }
    return std::make_shared<BlobState>(
        BlobState{js::Blob::from_parts(parts, options.type.value_or(std::string()))});
}
js::Promise<std::string> blob_text(const Blob& blob) { return js::blob_text(blob->blob); }

js::Promise<ImageBitmap> create_image_bitmap(const Blob& blob, const ImageBitmapOptions& options) {
    const auto none = [](const js::Nullable<std::string>& value, const char* member) {
        if (value && *value != "none" && *value != "default")
            throw std::runtime_error(std::string("createImageBitmap ") + member +
                                     " other than \"none\" is not supported natively.");
    };
    none(options.color_space_conversion, "colorSpaceConversion");
    none(options.image_orientation, "imageOrientation");
    const bool premultiply = options.premultiply_alpha.value_or("default") == "premultiply";
    return wrapped<ImageBitmap>(
        pal::create_image_bitmap(blob->blob, {premultiply}), [](const pal::ImageBitmap& bitmap) {
            return std::make_shared<ImageBitmapState>(ImageBitmapState{bitmap});
        });
}
double image_bitmap_width(const ImageBitmap& bitmap) { return bitmap->bitmap.width(); }
double image_bitmap_height(const ImageBitmap& bitmap) { return bitmap->bitmap.height(); }
void image_bitmap_close(const ImageBitmap& bitmap) { bitmap->bitmap.close(); }

/**
 * `queue.copyExternalImageToTexture({ source: bitmap, flipY }, { texture,
 * premultipliedAlpha }, size)`: the bitmap's decoded RGBA8 rows written to the
 * texture's origin, as WebGPU copies an unflipped, unconverted source.
 */
void copy_external_image_to_texture(GpuDevice& device, const CopyExternalImageSource& source,
                                    const CopyExternalImageDestination& destination,
                                    const GpuExtent3D& size) {
    const auto& bitmap = source.source->bitmap;
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

// ── TextDecoder ────────────────────────────────────────────────────────

TextDecoder text_decoder_create() {
    return std::make_shared<TextDecoderState>(
        TextDecoderState{js::make_text_decoder(false, false)});
}
TextDecoder text_decoder_create(const std::string& label,
                                const js::Nullable<TextDecoderOptions>& options) {
    // The Encoding Standard's labels of UTF-8, after ASCII whitespace is trimmed.
    const auto first = label.find_first_not_of("\t\n\f\r ");
    const auto last = label.find_last_not_of("\t\n\f\r ");
    const auto trimmed = ascii_lowercase(
        first == std::string::npos ? std::string() : label.substr(first, last - first + 1));
    if (trimmed != "utf-8" && trimmed != "utf8" && trimmed != "unicode-1-1-utf-8" &&
        trimmed != "unicode11utf8" && trimmed != "unicode20utf8" && trimmed != "x-unicode20utf8")
        throw js::NamedError("RangeError", "The splat stream decodes UTF-8 only.");
    return std::make_shared<TextDecoderState>(
        TextDecoderState{js::make_text_decoder(options && options->fatal.value_or(false),
                                               options && options->ignore_bom.value_or(false))});
}
std::string text_decoder_decode(const TextDecoder& decoder,
                                const js::TypedArray<std::uint8_t>& bytes) {
    return js::text_decode(decoder->decoder, bytes);
}
std::string text_decoder_decode(const TextDecoder& decoder,
                                const js::TypedArray<std::uint8_t>& bytes,
                                const js::Nullable<TextDecodeOptions>& options) {
    return js::text_decode(decoder->decoder, bytes, options && options->stream.value_or(false));
}
std::string text_decoder_flush(const TextDecoder& decoder) {
    return js::text_decode(decoder->decoder);
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

} // namespace bbl::splat_stream_platform
