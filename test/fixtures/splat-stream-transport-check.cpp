// Runs the lowered splat-stream request manager and voxel collision
// (test/splat-stream-transport.test.ts) over deterministic fake definitions of
// bblite/splat_stream_platform.hpp: a virtual clock whose timers fire one per
// event-loop task, a scripted fetch with streamed bodies and aborts, a
// WebP-header image decoder and a logging GPU device. It prints the log the
// pinned modules print under Node over the same fakes written in JavaScript.

#include "splat-stream-transport.hpp"

#include <bblite/pal_event_loop.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

using bbl::js::JsonValue;
using Bytes = bbl::js::TypedArray<std::uint8_t>;

std::string num(double value) {
    if (value == 0.0 && std::signbit(value))
        return "-0";
    return bbl::js::number_to_string(value);
}

std::vector<std::string> events;
void out(std::string line) { events.push_back(std::move(line)); }

JsonValue scenario;

// The virtual clock.
struct Timer {
    double id = 0;
    double due = 0;
    std::function<void()> callback;
};
double now = 0;
double next_timer = 0;
std::vector<Timer> timers;

double schedule(double milliseconds, std::function<void()> callback) {
    const double id = ++next_timer;
    timers.push_back(Timer{id, now + std::max(0.0, milliseconds), std::move(callback)});
    return id;
}
void unschedule(double id) {
    std::erase_if(timers, [id](const Timer& timer) { return timer.id == id; });
}
/** The earliest timer due at or before `limit`, ties by creation. */
bool take_timer(double limit, Timer& taken) {
    auto best = timers.end();
    for (auto timer = timers.begin(); timer != timers.end(); ++timer)
        if (timer->due <= limit && (best == timers.end() || timer->due < best->due ||
                                    (timer->due == best->due && timer->id < best->id)))
            best = timer;
    if (best == timers.end())
        return false;
    taken = std::move(*best);
    timers.erase(best);
    return true;
}

std::vector<std::weak_ptr<const bool>> dom_exceptions;

double number(const JsonValue& value) { return value.to_number(); }
std::size_t count(const JsonValue& value) { return static_cast<std::size_t>(value.length()); }

} // namespace

// ── The platform ──────────────────────────────────────────────────────

namespace bbl::splat_stream_platform {

struct UrlState {
    std::string protocol, host, pathname, search, hash;
};

namespace {
/** The absolute-URL subset the scenarios spell: scheme://host/path?query#hash. */
Url parse_absolute(const std::string& input) {
    const auto colon = input.find("://");
    if (colon == std::string::npos || colon == 0 || input.find(' ') != std::string::npos)
        throw js::NamedError("TypeError", "Invalid URL");
    auto url = std::make_shared<UrlState>();
    url->protocol = input.substr(0, colon + 1);
    const std::string rest = input.substr(colon + 3);
    const auto slash = rest.find_first_of("/?#");
    url->host = rest.substr(0, slash);
    std::string tail = slash == std::string::npos ? "/" : rest.substr(slash);
    if (const auto hash = tail.find('#'); hash != std::string::npos) {
        url->hash = tail.substr(hash);
        tail = tail.substr(0, hash);
    }
    if (const auto query = tail.find('?'); query != std::string::npos) {
        url->search = tail.substr(query);
        tail = tail.substr(0, query);
    }
    url->pathname = tail.empty() ? "/" : tail;
    return url;
}
} // namespace

Url url_parse(const std::string& input) { return parse_absolute(input); }
Url url_parse(const std::string& input, const std::string& base) {
    if (input.find("://") != std::string::npos)
        return parse_absolute(input);
    auto url = std::make_shared<UrlState>(*parse_absolute(base));
    url->pathname = url->pathname.substr(0, url->pathname.rfind('/') + 1) + input;
    url->search.clear();
    url->hash.clear();
    return url;
}
std::string url_href(const Url& url) {
    return url->protocol + "//" + url->host + url->pathname + url->search + url->hash;
}
std::string url_protocol(const Url& url) { return url->protocol; }
std::string url_pathname(const Url& url) { return url->pathname; }
void url_set_pathname(const Url& url, const std::string& pathname) { url->pathname = pathname; }

js::Error dom_exception(const std::string& message, const std::string& name) {
    js::Error error = std::make_exception_ptr(js::NamedError(name, message));
    dom_exceptions.push_back(js::error_identity(error));
    return error;
}
bool is_dom_exception(const js::Error& error) {
    const auto identity = js::error_identity(error);
    return identity && std::any_of(dom_exceptions.begin(), dom_exceptions.end(),
                                   [&](const auto& known) { return known.lock() == identity; });
}

struct AbortSignalState {
    bool aborted = false;
    js::Error reason;
    std::vector<std::shared_ptr<std::pair<js::Callback<void()>, bool>>> listeners;
};
struct AbortControllerState {
    AbortSignal signal = std::make_shared<AbortSignalState>();
};

AbortController abort_controller_create() { return std::make_shared<AbortControllerState>(); }
AbortSignal abort_controller_signal(const AbortController& controller) {
    return controller->signal;
}
void abort_controller_abort(const AbortController& controller, const js::Error& reason) {
    const auto& signal = controller->signal;
    if (signal->aborted)
        return;
    signal->aborted = true;
    signal->reason = static_cast<std::exception_ptr>(reason)
                         ? reason
                         : dom_exception("This operation was aborted", "AbortError");
    const auto snapshot = signal->listeners;
    for (const auto& entry : snapshot) {
        if (std::find(signal->listeners.begin(), signal->listeners.end(), entry) ==
            signal->listeners.end())
            continue;
        if (entry->second)
            std::erase(signal->listeners, entry);
        entry->first();
    }
}
bool abort_signal_aborted(const AbortSignal& signal) { return signal->aborted; }
js::Error abort_signal_reason(const AbortSignal& signal) { return signal->reason; }
void abort_signal_add_event_listener(const AbortSignal& signal, const std::string& type,
                                     const js::Callback<void()>& listener,
                                     const js::Nullable<AddEventListenerOptions>& options) {
    if (type != "abort")
        throw std::logic_error("Only abort listeners are admitted.");
    for (const auto& entry : signal->listeners)
        if (entry->first.identity() == listener.identity())
            return;
    signal->listeners.push_back(std::make_shared<std::pair<js::Callback<void()>, bool>>(
        listener, options && options->once.value_or(false)));
}
void abort_signal_remove_event_listener(const AbortSignal& signal, const std::string& type,
                                        const js::Callback<void()>& listener) {
    if (type != "abort")
        throw std::logic_error("Only abort listeners are admitted.");
    std::erase_if(signal->listeners, [&](const auto& entry) {
        return entry->first.identity() == listener.identity();
    });
}

struct PendingRead {
    double id = 0;
    js::Promise<ReadResult> promise;
};
struct ReadableStreamState {
    std::string url;
    double delay = 0;
    std::vector<Bytes> chunks;
    std::size_t next = 0;
    bool canceled = false;
    bool errored = false;
    js::Error error;
    std::optional<PendingRead> pending;

    void fail(const js::Error& reason) {
        if (errored)
            return;
        errored = true;
        error = reason;
        if (pending) {
            const auto read = *pending;
            pending.reset();
            unschedule(read.id);
            read.promise.reject(reason);
        }
    }
};
struct ReaderState {
    ReadableStream stream;
};
struct ResponseState {
    double status = 0;
    std::string url;
    JsonValue headers;
    ReadableStream body;
};

namespace {
std::map<std::string, double> attempts;

js::Promise<Response> fake_fetch(const std::string& url, const AbortSignal& signal) {
    out("fetch " + url);
    const JsonValue variants = scenario.get("resources").get(url);
    if (!variants.is_array())
        throw std::logic_error("No scripted resource " + url);
    const double attempt = attempts[url]++;
    const JsonValue variant = variants.at(std::min(attempt, variants.length() - 1));
    js::Promise<Response> promise;
    if (signal && signal->aborted) {
        promise.reject(signal->reason);
        return promise;
    }
    auto response = std::make_shared<ResponseState>();
    response->status = number(variant.get("status"));
    response->url = url;
    response->headers = variant.get("headers");
    if (const JsonValue body = variant.get("body"); body.is_array()) {
        auto stream = std::make_shared<ReadableStreamState>();
        stream->url = url;
        stream->delay = number(variant.get("chunk"));
        const auto size = static_cast<std::size_t>(number(variant.get("chunkSize")));
        for (std::size_t start = 0; start < count(body); start += size) {
            Bytes chunk(std::min(size, count(body) - start));
            for (std::size_t index = 0; index < chunk.size(); ++index)
                chunk.store(index, static_cast<std::uint8_t>(
                                       number(body.at(static_cast<double>(start + index)))));
            stream->chunks.push_back(chunk);
        }
        response->body = stream;
    }
    auto settled = std::make_shared<bool>(false);
    if (signal)
        abort_signal_add_event_listener(signal, "abort",
                                        js::Callback<void()>([promise, settled, response, signal] {
                                            if (!*settled) {
                                                *settled = true;
                                                promise.reject(signal->reason);
                                            } else if (response->body) {
                                                response->body->fail(signal->reason);
                                            }
                                        }),
                                        AddEventListenerOptions{true});
    const bool network = variant.get("network").truthy();
    schedule(number(variant.get("head")), [promise, settled, response, network] {
        if (*settled)
            return;
        *settled = true;
        if (network)
            promise.reject(js::make_error("TypeError", "Failed to fetch"));
        else
            promise.resolve(response);
    });
    return promise;
}
} // namespace

js::Promise<Response> fetch(const std::string& url, const RequestInit& init) {
    return fake_fetch(url, init.signal);
}
js::Promise<Response> fetch(const Url& url, const RequestInit& init) {
    return fake_fetch(url_href(url), init.signal);
}
bool response_ok(const Response& response) {
    return response->status >= 200 && response->status <= 299;
}
double response_status(const Response& response) { return response->status; }
std::string response_url(const Response& response) { return response->url; }
js::Nullable<std::string> response_header(const Response& response, const std::string& name) {
    const JsonValue value = response->headers.get(name);
    if (!value.is_string())
        return std::nullopt;
    return value.string_value();
}
ReadableStream response_body(const Response& response) { return response->body; }
js::Promise<js::PromiseVoid> readable_stream_cancel(const ReadableStream& stream) {
    out("body-cancel " + stream->url);
    stream->canceled = true;
    return js::Promise<js::PromiseVoid>::resolved({});
}
Reader readable_stream_get_reader(const ReadableStream& stream) {
    return std::make_shared<ReaderState>(ReaderState{stream});
}
js::Promise<ReadResult> reader_read(const Reader& reader) {
    const auto stream = reader->stream;
    js::Promise<ReadResult> promise;
    if (stream->errored) {
        promise.reject(stream->error);
        return promise;
    }
    const double id = schedule(stream->delay, [promise, stream] {
        stream->pending.reset();
        if (stream->canceled || stream->next >= stream->chunks.size())
            promise.resolve(ReadResult{true, std::nullopt});
        else
            promise.resolve(ReadResult{false, stream->chunks[stream->next++]});
    });
    stream->pending = PendingRead{id, promise};
    return promise;
}
js::Promise<js::PromiseVoid> reader_cancel(const Reader& reader) {
    out("reader-cancel " + reader->stream->url);
    reader->stream->canceled = true;
    return js::Promise<js::PromiseVoid>::resolved({});
}
void reader_release_lock(const Reader& reader) { out("release " + reader->stream->url); }

struct BlobState {
    std::vector<std::uint8_t> bytes;
    std::string type;
};
Blob blob_create(const js::Array<Bytes>& chunks, const BlobPropertyBag& options) {
    auto blob = std::make_shared<BlobState>();
    for (const auto& chunk : chunks)
        for (std::size_t index = 0; index < chunk.size(); ++index)
            blob->bytes.push_back(chunk.load(index));
    blob->type = options.type.value_or("");
    return blob;
}
js::Promise<std::string> blob_text(const Blob& blob) {
    return js::Promise<std::string>::resolved(std::string(blob->bytes.begin(), blob->bytes.end()));
}

struct ImageBitmapState {
    double width = 0;
    double height = 0;
};
js::Promise<ImageBitmap> create_image_bitmap(const Blob& blob, const ImageBitmapOptions& options) {
    out("decode " + std::to_string(blob->bytes.size()) + " " + blob->type + " " +
        options.premultiply_alpha.value_or("undefined") + " " +
        options.color_space_conversion.value_or("undefined") + " " +
        options.image_orientation.value_or("undefined"));
    js::Promise<ImageBitmap> promise;
    const auto& b = blob->bytes;
    if (b.size() < 25 || std::string(b.begin() + 12, b.begin() + 16) != "VP8L") {
        promise.reject(
            dom_exception("The source image could not be decoded.", "InvalidStateError"));
        return promise;
    }
    const std::uint32_t bits =
        b[21] | (b[22] << 8) | (b[23] << 16) | (static_cast<std::uint32_t>(b[24]) << 24);
    auto bitmap = std::make_shared<ImageBitmapState>(
        ImageBitmapState{static_cast<double>((bits & 0x3fff) + 1),
                         static_cast<double>(((bits >> 14) & 0x3fff) + 1)});
    schedule(number(scenario.get("decodeDelay")), [promise, bitmap] { promise.resolve(bitmap); });
    return promise;
}
double image_bitmap_width(const ImageBitmap& bitmap) { return bitmap->width; }
double image_bitmap_height(const ImageBitmap& bitmap) { return bitmap->height; }
void image_bitmap_close(const ImageBitmap& bitmap) {
    out("close " + num(bitmap->width) + "x" + num(bitmap->height));
}
void copy_external_image_to_texture(GpuDevice&, const CopyExternalImageSource& source,
                                    const CopyExternalImageDestination& destination,
                                    const GpuExtent3D& size) {
    const auto flag = [](const js::Nullable<bool>& value) {
        return std::string(value ? (*value ? "true" : "false") : "undefined");
    };
    out("copy " + num(source.source->width) + "x" + num(source.source->height) +
        " flip=" + flag(source.flip_y) + " premultiplied=" + flag(destination.premultiplied_alpha) +
        " size=" + num(size.width) + "x" + num(size.height));
}

struct TextDecoderState {};
TextDecoder text_decoder_create() { return std::make_shared<TextDecoderState>(); }
std::string text_decoder_decode(const TextDecoder&, const js::TypedArray<std::uint8_t>& bytes) {
    std::string text;
    for (std::size_t index = 0; index < bytes.size(); ++index)
        text.push_back(static_cast<char>(bytes.load(index)));
    return text;
}

double set_timeout(const js::Callback<void()>& callback, double milliseconds) {
    out("timeout " + num(milliseconds));
    return schedule(milliseconds, [callback] { callback(); });
}
void clear_timeout(double id) {
    out("clear-timeout");
    unschedule(id);
}
void queue_microtask(const js::Callback<void()>& callback) {
    pal::EventLoop::current().queue_microtask([callback] { callback(); });
}
double performance_now() { return now; }

} // namespace bbl::splat_stream_platform

// ── The GPU device and the driver ─────────────────────────────────────

namespace {

using namespace bbl::splat_stream_platform;

struct FakeObject final : bbl::GpuObject {
    explicit FakeObject(std::string label) : name(std::move(label)) {}
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        out("write " + name + " offset=" + std::to_string(offset) +
            " bytes=" + std::to_string(bytes.size()));
    }
    void destroy() override { out("destroy " + name); }
    std::string name;
};

struct FakeDevice final : bbl::GpuDevice {
    bbl::GpuHandle create_buffer(const bbl::GpuBufferDescriptor& descriptor) override {
        out("buffer size=" + num(descriptor.size) + " usage=" + num(descriptor.usage));
        return std::make_shared<FakeObject>("buffer");
    }
    bbl::GpuHandle create_texture(const bbl::GpuTextureDescriptor& descriptor) override {
        out("texture " + num(descriptor.size.width) + "x" + num(descriptor.size.height) + " " +
            descriptor.format + " usage=" + num(descriptor.usage));
        return std::make_shared<FakeObject>("texture");
    }
};

std::string describe(const bbl::js::Error& error) {
    std::string text = bbl::js::error_name(error) + " " + bbl::js::error_message(error);
    if (is_dom_exception(error))
        text += " dom";
    if (const auto pressure = bbl::pinned::error_instance<bbl::SplatGpuBudgetPressureError>(error))
        text += " required=" + num(pressure->required_bytes);
    if (const auto cause = bbl::js::error_cause(error); static_cast<std::exception_ptr>(cause))
        text += " cause=(" +
                (bbl::js::error_name(cause) == "SyntaxError" ? std::string("SyntaxError")
                                                             : describe(cause)) +
                ")";
    return text;
}

std::string read_file(const char* path) {
    std::ifstream file(path, std::ios::binary);
    std::stringstream text;
    text << file.rdbuf();
    return text.str();
}

bbl::js::Tuple<3> point(const JsonValue& value) {
    return bbl::js::Tuple<3>{number(value.at(0.0)), number(value.at(1.0)), number(value.at(2.0))};
}

bbl::js::Nullable<double> optional_number(const JsonValue& value) {
    return value.is_number() ? bbl::js::Nullable<double>(number(value)) : std::nullopt;
}

struct Driver {
    std::shared_ptr<FakeDevice> device = std::make_shared<FakeDevice>();
    std::shared_ptr<bbl::SplatStreamGpuLedger> ledger;
    std::shared_ptr<bbl::SplatStreamRequestManager> manager;
    std::map<std::string, AbortController> controllers;

    AbortController controller(const std::string& name) {
        auto& found = controllers[name];
        if (!found)
            found = abort_controller_create();
        return found;
    }

    void stats(const std::string& label) const {
        if (!manager)
            return;
        out(label + " stats cpu=" + num(manager->get_cpu_bytes()) + " fetched=" +
            num(manager->get_fetched_bytes()) + " pending=" + num(manager->get_pending_requests()) +
            " queued=" + num(manager->get_queued_files()) +
            " disposed=" + (manager->get_disposed() ? "true" : "false") +
            " ledger=" + num(ledger->resident_bytes) + "," + num(ledger->allocated_bytes) + "," +
            num(ledger->held_bytes));
    }

    void create(const JsonValue& step, const std::string& label) {
        const JsonValue limits = step.get("limits");
        bbl::SplatStreamRequestDependencies dependencies;
        dependencies.device = device;
        const std::string stale = scenario.get("stale").string_value();
        dependencies.is_generation_current = bbl::js::Callback<bool(std::string, double)>(
            [stale](std::string url, double) { return url != stale; });
        if (!(step.get("ledger").is_boolean() && !step.get("ledger").truthy()))
            dependencies.gpu_ledger = ledger;
        if (step.get("reserveGpu").truthy()) {
            const auto shared = ledger;
            dependencies.reserve_gpu_bytes = bbl::js::Callback<bool(std::string, double)>(
                [shared](std::string url, double bytes) {
                    out("reserve-gpu " + url + " " + num(bytes));
                    return shared->try_reserve(bytes);
                });
        }
        manager = bbl::create_splat_stream_request_manager(
            number(limits.at(0.0)), number(limits.at(1.0)), number(limits.at(2.0)),
            number(limits.at(3.0)), dependencies);
        out(label + " created");
    }

    void request(const JsonValue& step) {
        auto request = bbl::js::make_gc_shared<bbl::SplatSourceRequest>();
        const std::string url = step.get("url").string_value();
        request->url = url;
        request->file_id = number(step.get("fileId"));
        request->generation = number(step.get("generation"));
        request->priority = number(step.get("priority"));
        request->distance = optional_number(step.get("distance"));
        const JsonValue intervals = step.get("intervals");
        for (std::size_t index = 0; index < count(intervals); ++index) {
            auto interval = bbl::js::make_gc_shared<bbl::SogInterval>();
            interval->offset = number(intervals.at(static_cast<double>(index)).at(0.0));
            interval->count = number(intervals.at(static_cast<double>(index)).at(1.0));
            request->intervals.push_back(interval);
        }
        if (step.get("signal").is_string())
            request->signal =
                abort_controller_signal(controller(step.get("signal").string_value()));
        static_cast<void>(manager->request(request).then(
            bbl::js::Callback<void(std::shared_ptr<bbl::PreparedSplatSource>)>(
                [url](std::shared_ptr<bbl::PreparedSplatSource> prepared) {
                    out("settle " + url + " ok " + num(prepared->width) + "x" +
                        num(prepared->height) + " count=" + num(prepared->count) +
                        " gpu=" + num(prepared->gpu_bytes) +
                        " textures=" + std::to_string(prepared->textures.size()) +
                        " reserved=" + (prepared->gpu_reserved.value_or(false) ? "true" : "false") +
                        " means=" + num(prepared->means_min.load(0)) + "," +
                        num(prepared->means_max.load(2)));
                }),
            bbl::js::Callback<void(bbl::js::Error)>([url](bbl::js::Error error) {
                out("settle " + url + " error " + describe(error));
            })));
    }

    void collision(const JsonValue& step) {
        const std::string url = step.get("url").string_value();
        AbortSignal signal;
        if (step.get("signal").is_string())
            signal = abort_controller_signal(controller(step.get("signal").string_value()));
        const JsonValue moves = step.get("moves");
        static_cast<void>(
            bbl::load_splat_voxel_collision(url, signal)
                .then(bbl::js::Callback<void(std::shared_ptr<bbl::SplatVoxelCollision>)>(
                          [url, moves](std::shared_ptr<bbl::SplatVoxelCollision> collision) {
                              out("collision " + url + " min=" + num(collision->min[0]) + "," +
                                  num(collision->min[1]) + "," + num(collision->min[2]) +
                                  " max=" + num(collision->max[0]) + "," + num(collision->max[1]) +
                                  "," + num(collision->max[2]) + " resolution=" +
                                  num(collision->resolution) + " depth=" + num(collision->depth) +
                                  " nodes=" + std::to_string(collision->nodes.size()) +
                                  " masks=" + std::to_string(collision->masks.size()));
                              const std::size_t total = moves.is_array() ? count(moves) : 0;
                              for (std::size_t index = 0; index < total; ++index) {
                                  const JsonValue move = moves.at(static_cast<double>(index));
                                  try {
                                      const auto position = bbl::move_splat_voxel_camera(
                                          collision, point(move.get("from")), point(move.get("to")),
                                          optional_number(move.get("radius")));
                                      out("move " + std::to_string(index) + " " + num(position[0]) +
                                          "," + num(position[1]) + "," + num(position[2]));
                                  } catch (...) {
                                      out("move " + std::to_string(index) + " error " +
                                          describe(std::current_exception()));
                                  }
                              }
                          }),
                      bbl::js::Callback<void(bbl::js::Error)>([url](bbl::js::Error error) {
                          out("collision " + url + " error " + describe(error));
                      })));
    }

    void run(const JsonValue& step, std::size_t index) {
        const std::string op = step.get("op").string_value();
        const std::string label = "step " + std::to_string(index) + " " + op;
        out(label + " at " + num(now));
        try {
            if (op == "create")
                create(step, label);
            else if (op == "request")
                request(step);
            else if (op == "promote")
                out(label + " result " +
                    (manager->promote(step.get("url").string_value(),
                                      number(step.get("generation")), number(step.get("priority")),
                                      optional_number(step.get("distance")))
                         ? "true"
                         : "false"));
            else if (op == "cancel")
                manager->cancel(step.get("url").string_value());
            else if (op == "abort")
                abort_controller_abort(controller(step.get("signal").string_value()),
                                       step.get("custom").truthy()
                                           ? bbl::js::make_error("Error", "custom reason")
                                           : bbl::js::Error{});
            else if (op == "dispose")
                manager->dispose();
            else if (op == "collision")
                collision(step);
        } catch (...) {
            out(label + " threw " + describe(std::current_exception()));
        }
        stats(label);
    }
};

} // namespace

int main(int argc, char** argv) {
    if (argc != 2)
        return 2;
    scenario = bbl::js::json_parse(read_file(argv[1]));
    std::vector<std::string> unhandled;
    {
        const bbl::js::RealmScope realm;
        bbl::pal::EventLoop loop;
        loop.on_unhandled_rejection(
            [&](std::exception_ptr error) { unhandled.push_back(describe(error)); });
        Driver driver;
        const JsonValue steps = scenario.get("steps");
        const double horizon = number(scenario.get("horizon"));
        std::size_t step = 0;
        // One task per timer or step, each followed by its microtasks.
        std::function<void()> pump = [&] {
            const bool finished = step >= count(steps);
            const double target =
                finished ? horizon : number(steps.at(static_cast<double>(step)).get("at"));
            Timer timer;
            if (take_timer(target, timer)) {
                now = timer.due;
                timer.callback();
            } else if (finished) {
                loop.close();
                return;
            } else {
                now = target;
                driver.run(steps.at(static_cast<double>(step)), step);
                ++step;
            }
            loop.post(pump);
        };
        loop.run([&] {
            driver.ledger = bbl::create_splat_stream_gpu_ledger(
                number(scenario.get("gpuBytes")),
                bbl::js::Callback<void(bbl::js::Callback<void()>)>(
                    [](bbl::js::Callback<void()> dispose) { dispose(); }));
            loop.post(pump);
        });
        timers.clear();
    }
    for (const auto& line : events)
        std::cout << line << "\n";
    std::sort(unhandled.begin(), unhandled.end());
    for (const auto& line : unhandled)
        std::cout << "unhandled " << line << "\n";
    return 0;
}
