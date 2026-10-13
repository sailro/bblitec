// The web platform lowered libraries reach (bblite/web_platform.hpp): its seam
// as native/src/pal_web_platform.cpp defines it over the native services
// (fetch, image decoding, timers and tasks), and its calls over the runtime's
// own objects, run against test/web-platform.test.ts's local server. Each line
// it prints is one observation the test compares with the web platform's.

#include <bblite/gpu.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/web_platform.hpp>
#include <webp/encode.h>

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

using namespace bbl;
namespace web = bbl::web_platform;

// pal.cpp's clock reports a build's stamp; a fixture has none of its own.
const char* bbl::pal::bblite_build_stamp() { return "web-platform-check"; }

namespace {

/** A texture recording the device's write. */
struct RecordingTexture final : GpuObject {
    std::vector<std::uint8_t> bytes;
    GpuTextureWriteLayout layout;
    GpuWriteExtent extent;
    void write_texture_bytes(std::span<const std::uint8_t> data, const GpuTextureWriteLayout& at,
                             const GpuWriteExtent& written) override {
        bytes.assign(data.begin(), data.end());
        layout = at;
        extent = written;
    }
};

/** A 16-byte buffer recording the device's writes. */
struct RecordingBuffer final : GpuObject {
    std::vector<std::uint8_t> bytes = std::vector<std::uint8_t>(16, 0);
    std::optional<std::size_t> buffer_capacity() const override { return bytes.size(); }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> data) override {
        std::copy(data.begin(), data.end(), bytes.begin() + static_cast<std::ptrdiff_t>(offset));
    }
};

struct RecordingDevice final : GpuDevice {};

std::vector<std::uint8_t> encode_lossless(const std::vector<std::uint8_t>& rgba, int width,
                                          int height) {
    WebPConfig config;
    assert(WebPConfigInit(&config));
    config.lossless = 1;
    config.exact = 1;
    WebPPicture picture;
    assert(WebPPictureInit(&picture));
    picture.use_argb = 1;
    picture.width = width;
    picture.height = height;
    assert(WebPPictureImportRGBA(&picture, rgba.data(), width * 4));
    WebPMemoryWriter writer;
    WebPMemoryWriterInit(&writer);
    picture.writer = WebPMemoryWrite;
    picture.custom_ptr = &writer;
    assert(WebPEncode(&config, &picture));
    std::vector<std::uint8_t> bytes(writer.mem, writer.mem + writer.size);
    WebPMemoryWriterClear(&writer);
    WebPPictureFree(&picture);
    return bytes;
}

std::string bytes_text(const std::vector<std::uint8_t>& bytes) {
    std::string text;
    for (const auto byte : bytes)
        text += (text.empty() ? "" : ",") + std::to_string(byte);
    return text;
}

/** What a rejected or thrown error is: its name and message. */
std::string described(const js::Error& error) {
    return js::error_name(error) +
           (js::is_dom_exception(static_cast<std::exception_ptr>(error)) ? "(dom)" : "") + ":" +
           js::error_message(error);
}

js::Promise<js::PromiseVoid> fetches(std::string base, std::vector<std::string>& lines) {
    // A streamed body read chunk by chunk, each its own Uint8Array, into one Blob.
    const auto response = co_await web::fetch(js::Url("/stream", base), web::RequestInit{});
    const auto body = web::response_body(response);
    assert(web::response_body(response) == body);
    const auto reader = web::readable_stream_get_reader(body);
    js::Array<js::TypedArray<std::uint8_t>> chunks;
    for (;;) {
        const auto part = co_await web::reader_read(reader);
        if (part.done) {
            assert(!part.value);
            break;
        }
        chunks.push_back(*part.value);
    }
    web::reader_release_lock(reader);
    const auto text = co_await js::blob_text(js::Blob::from_parts(chunks, "text/plain"));
    lines.push_back("stream " + std::to_string(web::response_ok(response)) + " " +
                    std::to_string(static_cast<int>(web::response_status(response))) + " " +
                    web::response_url(response) + " " +
                    web::response_header(response, "X-Chunks").value_or("none") + " " +
                    web::response_header(response, "missing").value_or("none") + " " + text);

    const auto missing = co_await web::fetch(base + "/missing", web::RequestInit{});
    lines.push_back("missing " + std::to_string(web::response_ok(missing)) + " " +
                    std::to_string(static_cast<int>(web::response_status(missing))));
    co_await web::readable_stream_cancel(web::response_body(missing));

    const auto redirected = co_await web::fetch(base + "/moved", web::RequestInit{});
    lines.push_back("redirect " + web::response_url(redirected));
    co_await web::reader_cancel(web::readable_stream_get_reader(web::response_body(redirected)));

    // An abort before the head rejects with the default AbortError.
    const auto early = js::AbortController::create();
    const auto hanging = web::fetch(base + "/hang", web::RequestInit{early.signal()});
    static_cast<void>(
        web::set_timeout(js::Callback<void()>([early] { web::abort(early, js::Error{}); }), 30));
    try {
        static_cast<void>(co_await hanging);
        lines.push_back("early fulfilled");
    } catch (...) {
        lines.push_back("early " + described(std::current_exception()));
    }

    // An abort with a reason while the body streams errors the pending read.
    const auto middle = js::AbortController::create();
    const auto slow = co_await web::fetch(base + "/slow", web::RequestInit{middle.signal()});
    const auto slow_reader = web::readable_stream_get_reader(web::response_body(slow));
    const auto head = co_await web::reader_read(slow_reader);
    const auto next = web::reader_read(slow_reader);
    web::abort(middle, js::make_error("RangeError", "stop"));
    try {
        static_cast<void>(co_await next);
        lines.push_back("middle fulfilled");
    } catch (...) {
        lines.push_back("middle " + std::to_string(head.value->size()) + " " +
                        described(std::current_exception()));
    }

    // An already aborted signal rejects with its reason before any transfer.
    const auto aborted = js::AbortController::create();
    aborted.abort(js::make_error("TypeError", "gone"));
    try {
        static_cast<void>(
            co_await web::fetch(base + "/stream", web::RequestInit{aborted.signal()}));
        lines.push_back("aborted fulfilled");
    } catch (...) {
        lines.push_back("aborted " + described(std::current_exception()));
    }
    co_return js::PromiseVoid{};
}

js::Promise<js::PromiseVoid> images(std::vector<std::string>& lines) {
    const std::vector<std::uint8_t> rgba{255, 0,  0,  255, 0,  255, 0,  128, 0,  0,  255, 0,
                                         10,  20, 30, 255, 40, 50,  60, 255, 70, 80, 90,  1};
    const auto webp = encode_lossless(rgba, 3, 2);
    js::Array<js::TypedArray<std::uint8_t>> chunks;
    chunks.push_back(js::TypedArray<std::uint8_t>(webp.begin(), webp.begin() + 7));
    chunks.push_back(js::TypedArray<std::uint8_t>(webp.begin() + 7, webp.end()));
    const auto blob = js::Blob::from_parts(chunks, "image/webp");
    const auto options = [](js::Nullable<std::string> premultiply, js::Nullable<std::string> space,
                            js::Nullable<std::string> orientation) {
        return pal::ImageBitmapOptionsInit{std::move(premultiply), std::move(space),
                                           std::move(orientation)};
    };
    const auto bitmap = co_await web::create_image_bitmap(
        blob, pal::image_bitmap_options(options("none", "none", "none")));
    lines.push_back("bitmap " + std::to_string(blob.size() == webp.size()) + " " +
                    std::to_string(static_cast<int>(bitmap.width())) + "x" +
                    std::to_string(static_cast<int>(bitmap.height())));

    RecordingDevice device;
    const auto texture = std::make_shared<RecordingTexture>();
    web::copy_external_image_to_texture(device, {bitmap, false}, {texture, false}, {3, 2, 1});
    lines.push_back("copy " + std::to_string(texture->bytes == rgba) + " " +
                    std::to_string(texture->layout.offset) + " " +
                    std::to_string(texture->layout.bytes_per_row.value_or(0)) + " " +
                    std::to_string(texture->layout.rows_per_image.value_or(0)) + " " +
                    std::to_string(texture->extent.width) + "x" +
                    std::to_string(texture->extent.height));
    const auto refused = [&](const char* name, web::CopyExternalImageSource source,
                             web::CopyExternalImageDestination destination, GpuExtent3D size) {
        try {
            web::copy_external_image_to_texture(device, source, destination, size);
            lines.push_back(std::string(name) + " copied");
        } catch (const std::runtime_error&) {
            lines.push_back(std::string(name) + " refused");
        }
    };
    refused("flip", {bitmap, true}, {texture, false}, {3, 2, 1});
    refused("premultiplied", {bitmap, false}, {texture, true}, {3, 2, 1});
    refused("outside", {bitmap, false}, {texture, false}, {4, 2, 1});

    // The one decode policy.
    const auto policy = [&](const char* name, pal::ImageBitmapOptionsInit init) {
        try {
            lines.push_back(std::string(name) + " premultiply=" +
                            std::to_string(pal::image_bitmap_options(init).premultiply));
        } catch (...) {
            lines.push_back(std::string(name) + " " + described(std::current_exception()));
        }
    };
    policy("premultiply", options("premultiply", "none", std::nullopt));
    policy("from-image", options("none", "none", "from-image"));
    policy("default-alpha", options(std::nullopt, "none", "none"));
    policy("color", options("none", "default", "none"));
    policy("orientation", options("none", "none", "flipY"));

    const std::string plain = "plain";
    js::Array<js::TypedArray<std::uint8_t>> text_chunks;
    text_chunks.push_back(js::TypedArray<std::uint8_t>(plain.begin(), plain.end()));
    try {
        static_cast<void>(co_await web::create_image_bitmap(js::Blob::from_parts(text_chunks, ""),
                                                            pal::ImageBitmapOptions{}));
        lines.push_back("undecodable fulfilled");
    } catch (...) {
        lines.push_back("undecodable " + js::error_name(std::current_exception()));
    }
    bitmap.close();
    lines.push_back("closed " + std::to_string(static_cast<int>(bitmap.width())));

    // queue.writeBuffer with each source kind, whole and in ranges.
    using Source = std::variant<js::ArrayBuffer, js::TypedArray<float>,
                                js::TypedArray<std::uint32_t>, js::TypedArray<std::uint8_t>>;
    const auto buffer = std::make_shared<RecordingBuffer>();
    const std::vector<std::uint32_t> words{0x04030201u, 0x08070605u, 0x0c0b0a09u};
    gpu_queue_write_buffer(device, buffer, 0,
                           Source(js::TypedArray<std::uint32_t>(words.begin(), words.end())), 1, 2);
    const std::vector<std::uint8_t> raw{0xaa, 0xbb, 0xcc, 0xdd};
    gpu_queue_write_buffer(device, buffer, 8, Source(js::ArrayBuffer(raw)), 1, 2);
    const std::vector<float> one{1.0f};
    gpu_queue_write_buffer(device, buffer, 12,
                           Source(js::TypedArray<float>(one.begin(), one.end())));
    lines.push_back("write " + bytes_text(buffer->bytes));
    co_return js::PromiseVoid{};
}

void decoders(std::vector<std::string>& lines) {
    const auto streaming = web::text_decoder({});
    const std::vector<std::uint8_t> first{0xef, 0xbb, 0xbf, 'a', 0xc3};
    const std::vector<std::uint8_t> second{0xa9, 'b', 0xe2};
    const auto head =
        web::text_decode(streaming, js::TypedArray<std::uint8_t>(first.begin(), first.end()),
                         web::TextDecodeOptions{true});
    const auto tail =
        web::text_decode(streaming, js::TypedArray<std::uint8_t>(second.begin(), second.end()),
                         web::TextDecodeOptions{true});
    const auto end = js::text_decode(streaming);
    lines.push_back("decode [" + head + "][" + tail + "][" + end + "]");
    const auto keep = web::text_decoder(web::TextDecoderOptions{false, true});
    lines.push_back(
        "bom [" +
        web::text_decode(keep, js::TypedArray<std::uint8_t>(first.begin(), first.begin() + 4), {}) +
        "]");
    const auto fatal = web::text_decoder(web::TextDecoderOptions{true, {}});
    try {
        static_cast<void>(web::text_decode(
            fatal, js::TypedArray<std::uint8_t>(second.begin(), second.begin() + 1), {}));
        lines.push_back("fatal decoded");
    } catch (...) {
        lines.push_back("fatal " + js::error_name(std::current_exception()));
    }
}

void aborts(std::vector<std::string>& lines) {
    const auto controller = js::AbortController::create();
    const auto& signal = controller.signal();
    std::string heard;
    const js::Callback<void()> once([&] { heard += "once;"; });
    const js::Callback<void()> kept([&] { heard += "kept;"; });
    signal.add_abort_listener(once, web::once(web::AddEventListenerOptions{true}));
    signal.add_abort_listener(kept, web::once({}));
    const bool before = signal.aborted();
    web::abort(controller, js::Error{});
    web::abort(controller, js::make_error("Error", "second"));
    lines.push_back("abort " + std::to_string(before) + " " + std::to_string(signal.aborted()) +
                    " " + heard + " " + described(*signal.reason()));
    const auto reasoned = js::AbortController::create();
    web::abort(reasoned, js::make_error("RangeError", "why"));
    lines.push_back("reason " + described(*reasoned.signal().reason()));
}

js::Promise<js::PromiseVoid> timers(std::vector<std::string>& lines) {
    auto order = std::make_shared<std::string>();
    const double started = web::performance_now();
    static_cast<void>(web::set_timeout(js::Callback<void()>([order] { *order += "timeout;"; }), 0));
    const double canceled =
        web::set_timeout(js::Callback<void()>([order] { *order += "canceled;"; }), 0);
    web::clear_timeout(canceled);
    web::clear_timeout(0);
    web::queue_microtask(js::Callback<void()>([order] { *order += "microtask;"; }));
    *order += "sync;";
    const js::Promise<js::PromiseVoid> resolve;
    static_cast<void>(web::set_timeout(
        js::Callback<void()>([resolve] { resolve.resolve(js::PromiseVoid{}); }), 20));
    co_await resolve;
    const double elapsed = web::performance_now() - started;
    lines.push_back("timers " + *order + " " + std::to_string(elapsed >= 19));
    co_return js::PromiseVoid{};
}

js::Promise<js::PromiseVoid> run(std::string base, std::vector<std::string>& lines) {
    decoders(lines);
    aborts(lines);
    co_await timers(lines);
    co_await fetches(base, lines);
    co_await images(lines);
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    assert(argc == 2);
    std::vector<std::string> lines;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run(argv[1], lines)
                                  .then(js::Callback<void(js::PromiseVoid)>(
                                            [&](js::PromiseVoid) { loop.close(); }),
                                        js::Callback<void(js::Error)>([&](js::Error error) {
                                            failure = described(error);
                                            loop.close();
                                        })));
        });
    }
    for (const auto& line : lines)
        std::cout << line << "\n";
    if (!failure.empty()) {
        std::cout << "failed " << failure << "\n";
        return 1;
    }
    return 0;
}
