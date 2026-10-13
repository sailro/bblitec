// The splat-stream library's web platform (bblite/splat_stream_platform.hpp
// and the loader's additions in bblite/splat_stream_runtime.hpp) as
// native/src/pal_splat_stream_platform.cpp defines it over the native
// services, run against test/splat-stream-platform.test.ts's local server.
// Each line it prints is one observation the test compares with what the
// web platform does.

#include <bblite/gpu.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/splat_stream_platform.hpp>
#include <bblite/splat_stream_runtime.hpp>
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
namespace sp = bbl::splat_stream_platform;

// pal.cpp's clock reports a build's stamp; a fixture has none of its own.
const char* bbl::pal::bblite_build_stamp() { return "splat-stream-platform-check"; }

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
    return js::error_name(error) + (sp::is_dom_exception(error) ? "(dom)" : "") + ":" +
           js::error_message(error);
}

js::Promise<js::PromiseVoid> url_and_fetch(std::string base, std::vector<std::string>& lines) {
    const auto url = sp::url_parse("chunks/../data.bin?x=1#f", base + "/root/meta.json");
    lines.push_back("url " + sp::url_href(url) + " " + sp::url_protocol(url) + " " +
                    sp::url_pathname(url));
    sp::url_set_pathname(url, "/a b/c%");
    lines.push_back("pathname " + sp::url_pathname(url));
    try {
        static_cast<void>(sp::url_parse("not a url"));
        lines.push_back("invalid parsed");
    } catch (...) {
        lines.push_back("invalid " + js::error_name(std::current_exception()));
    }

    // A streamed body read chunk by chunk, each its own Uint8Array, into a Blob.
    const auto response = co_await sp::fetch(sp::url_parse("/stream", base), sp::RequestInit{});
    const auto body = sp::response_body(response);
    assert(sp::response_body(response) == body);
    const auto reader = sp::readable_stream_get_reader(body);
    js::Array<js::TypedArray<std::uint8_t>> chunks;
    for (;;) {
        const auto part = co_await sp::reader_read(reader);
        if (part.done) {
            assert(!part.value);
            break;
        }
        chunks.push_back(*part.value);
    }
    sp::reader_release_lock(reader);
    const auto text = co_await sp::blob_text(sp::blob_create(chunks, {std::string("text/plain")}));
    lines.push_back("stream " + std::to_string(sp::response_ok(response)) + " " +
                    std::to_string(static_cast<int>(sp::response_status(response))) + " " +
                    sp::response_url(response) + " " +
                    sp::response_header(response, "X-Chunks").value_or("none") + " " +
                    sp::response_header(response, "missing").value_or("none") + " " + text);

    const auto missing = co_await sp::fetch(base + "/missing", sp::RequestInit{});
    lines.push_back("missing " + std::to_string(sp::response_ok(missing)) + " " +
                    std::to_string(static_cast<int>(sp::response_status(missing))));
    co_await sp::readable_stream_cancel(sp::response_body(missing));

    const auto redirected = co_await sp::fetch(base + "/moved", sp::RequestInit{});
    lines.push_back("redirect " + sp::response_url(redirected));
    co_await sp::reader_cancel(sp::readable_stream_get_reader(sp::response_body(redirected)));

    // An abort before the head rejects with the default AbortError.
    const auto early = sp::abort_controller_create();
    const auto hanging =
        sp::fetch(base + "/hang", sp::RequestInit{sp::abort_controller_signal(early)});
    static_cast<void>(sp::set_timeout(
        js::Callback<void()>([early] { sp::abort_controller_abort(early, js::Error{}); }), 30));
    try {
        static_cast<void>(co_await hanging);
        lines.push_back("early fulfilled");
    } catch (...) {
        lines.push_back("early " + described(std::current_exception()));
    }

    // An abort with a reason while the body streams errors the pending read.
    const auto middle = sp::abort_controller_create();
    const auto slow =
        co_await sp::fetch(base + "/slow", sp::RequestInit{sp::abort_controller_signal(middle)});
    const auto slow_reader = sp::readable_stream_get_reader(sp::response_body(slow));
    const auto head = co_await sp::reader_read(slow_reader);
    const auto next = sp::reader_read(slow_reader);
    sp::abort_controller_abort(middle, js::make_error("RangeError", "stop"));
    try {
        static_cast<void>(co_await next);
        lines.push_back("middle fulfilled");
    } catch (...) {
        lines.push_back("middle " + std::to_string(head.value->size()) + " " +
                        described(std::current_exception()));
    }

    // An application signal seen through the library's handle.
    auto application = js::AbortController::create();
    const auto signal = sp::abort_signal_of(application.signal());
    application.abort(js::make_error("TypeError", "gone"));
    lines.push_back("application " + std::to_string(sp::abort_signal_aborted(signal)) + " " +
                    described(sp::abort_signal_reason(signal)));
    try {
        static_cast<void>(co_await sp::fetch(base + "/stream", sp::RequestInit{signal}));
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
    const auto blob = sp::blob_create(chunks, {std::string("image/webp")});
    const auto bitmap = co_await sp::create_image_bitmap(
        blob, {std::string("none"), std::string("none"), std::string("none")});
    lines.push_back("bitmap " + std::to_string(static_cast<int>(sp::image_bitmap_width(bitmap))) +
                    "x" + std::to_string(static_cast<int>(sp::image_bitmap_height(bitmap))));

    RecordingDevice device;
    const auto texture = std::make_shared<RecordingTexture>();
    sp::copy_external_image_to_texture(device, {bitmap, false}, {texture, false}, {3, 2, 1});
    lines.push_back("copy " + std::to_string(texture->bytes == rgba) + " " +
                    std::to_string(texture->layout.offset) + " " +
                    std::to_string(texture->layout.bytes_per_row.value_or(0)) + " " +
                    std::to_string(texture->layout.rows_per_image.value_or(0)) + " " +
                    std::to_string(texture->extent.width) + "x" +
                    std::to_string(texture->extent.height));
    const auto refused = [&](const char* name, sp::CopyExternalImageSource source,
                             sp::CopyExternalImageDestination destination, GpuExtent3D size) {
        try {
            sp::copy_external_image_to_texture(device, source, destination, size);
            lines.push_back(std::string(name) + " copied");
        } catch (const std::runtime_error&) {
            lines.push_back(std::string(name) + " refused");
        }
    };
    refused("flip", {bitmap, true}, {texture, false}, {3, 2, 1});
    refused("premultiplied", {bitmap, false}, {texture, true}, {3, 2, 1});
    refused("outside", {bitmap, false}, {texture, false}, {4, 2, 1});

    js::Array<js::TypedArray<std::uint8_t>> text_chunks;
    const std::string plain = "plain";
    text_chunks.push_back(js::TypedArray<std::uint8_t>(plain.begin(), plain.end()));
    try {
        static_cast<void>(co_await sp::create_image_bitmap(
            sp::blob_create(text_chunks, {}), {std::string("none"), std::string("none"), {}}));
        lines.push_back("undecodable fulfilled");
    } catch (...) {
        lines.push_back("undecodable " + js::error_name(std::current_exception()));
    }
    sp::image_bitmap_close(bitmap);
    lines.push_back("closed " + std::to_string(static_cast<int>(sp::image_bitmap_width(bitmap))));

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
    const auto streaming = sp::text_decoder_create(" UTF8\n", {});
    const std::vector<std::uint8_t> first{0xef, 0xbb, 0xbf, 'a', 0xc3};
    const std::vector<std::uint8_t> second{0xa9, 'b', 0xe2};
    const auto head =
        sp::text_decoder_decode(streaming, js::TypedArray<std::uint8_t>(first.begin(), first.end()),
                                sp::TextDecodeOptions{true});
    const auto tail = sp::text_decoder_decode(
        streaming, js::TypedArray<std::uint8_t>(second.begin(), second.end()),
        sp::TextDecodeOptions{true});
    const auto end = sp::text_decoder_flush(streaming);
    lines.push_back("decode [" + head + "][" + tail + "][" + end + "]");
    const auto keep = sp::text_decoder_create("utf-8", sp::TextDecoderOptions{false, true});
    lines.push_back("bom [" +
                    sp::text_decoder_decode(
                        keep, js::TypedArray<std::uint8_t>(first.begin(), first.begin() + 4)) +
                    "]");
    const auto fatal = sp::text_decoder_create("utf-8", sp::TextDecoderOptions{true, {}});
    try {
        static_cast<void>(sp::text_decoder_decode(
            fatal, js::TypedArray<std::uint8_t>(second.begin(), second.begin() + 1), {}));
        lines.push_back("fatal decoded");
    } catch (...) {
        lines.push_back("fatal " + js::error_name(std::current_exception()));
    }
    try {
        static_cast<void>(sp::text_decoder_create("latin1", {}));
        lines.push_back("label decoded");
    } catch (...) {
        lines.push_back("label " + js::error_name(std::current_exception()));
    }
}

void listeners(std::vector<std::string>& lines) {
    const auto controller = sp::abort_controller_create();
    const auto signal = sp::abort_controller_signal(controller);
    assert(sp::abort_controller_signal(controller) == signal);
    std::string heard;
    const js::Callback<void()> once([&] { heard += "once;"; });
    const js::Callback<void()> removed([&] { heard += "removed;"; });
    const js::Callback<void()> kept([&] { heard += "kept;"; });
    sp::abort_signal_add_event_listener(signal, "abort", once, sp::AddEventListenerOptions{true});
    sp::abort_signal_add_event_listener(signal, "abort", removed, {});
    sp::abort_signal_add_event_listener(signal, "abort", kept, {});
    sp::abort_signal_add_event_listener(signal, "abort", kept, {});
    sp::abort_signal_remove_event_listener(signal, "abort", removed);
    const bool before = sp::abort_signal_aborted(signal);
    sp::abort_controller_abort(controller, js::Error{});
    sp::abort_controller_abort(controller, js::make_error("Error", "second"));
    lines.push_back("listeners " + std::to_string(before) + " " +
                    std::to_string(sp::abort_signal_aborted(signal)) + " " + heard + " " +
                    described(sp::abort_signal_reason(signal)));
    const auto error = sp::dom_exception("quota", "QuotaExceededError");
    lines.push_back("dom " + described(error) + " " +
                    std::to_string(sp::is_dom_exception(js::make_error("Error", "plain"))));
}

js::Promise<js::PromiseVoid> timers(std::vector<std::string>& lines) {
    auto order = std::make_shared<std::string>();
    const double started = sp::performance_now();
    static_cast<void>(sp::set_timeout(js::Callback<void()>([order] { *order += "timeout;"; }), 0));
    const double canceled =
        sp::set_timeout(js::Callback<void()>([order] { *order += "canceled;"; }), 0);
    sp::clear_timeout(canceled);
    sp::clear_timeout(0);
    sp::queue_microtask(js::Callback<void()>([order] { *order += "microtask;"; }));
    *order += "sync;";
    const js::Promise<js::PromiseVoid> resolve;
    static_cast<void>(sp::set_timeout(
        js::Callback<void()>([resolve] { resolve.resolve(js::PromiseVoid{}); }), 20));
    co_await resolve;
    const double elapsed = sp::performance_now() - started;
    lines.push_back("timers " + *order + " " + std::to_string(elapsed >= 19));
    co_return js::PromiseVoid{};
}

js::Promise<js::PromiseVoid> run(std::string base, std::vector<std::string>& lines) {
    decoders(lines);
    listeners(lines);
    co_await timers(lines);
    co_await url_and_fetch(base, lines);
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
