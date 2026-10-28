#pragma once

#include <bblite/joining_thread.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
#include <bblite/js_promise.hpp>

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <limits>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace bbl::pal {

/** A response's header list: names lowercased, in arrival order. Immutable once shared. */
struct HttpHeaderList {
    std::vector<std::pair<std::string, std::string>> entries;
};

/** The header-name case fold (ASCII lowercase). */
[[nodiscard]] inline std::string http_header_name(std::string_view name) {
    return js::string_lower(std::string(name));
}

/**
 * A forbidden request-header name (the Fetch Standard's list): a request drops the field rather
 * than send it, as a browser's does.
 */
[[nodiscard]] inline bool http_forbidden_request_header(std::string_view name) {
    const auto key = http_header_name(name);
    constexpr std::string_view forbidden[] = {"accept-charset",
                                              "accept-encoding",
                                              "access-control-request-headers",
                                              "access-control-request-method",
                                              "connection",
                                              "content-length",
                                              "cookie",
                                              "cookie2",
                                              "date",
                                              "dnt",
                                              "expect",
                                              "host",
                                              "keep-alive",
                                              "origin",
                                              "referer",
                                              "set-cookie",
                                              "te",
                                              "trailer",
                                              "transfer-encoding",
                                              "upgrade",
                                              "via"};
    return key.starts_with("proxy-") || key.starts_with("sec-") ||
           std::find(std::begin(forbidden), std::end(forbidden), key) != std::end(forbidden);
}

/** A header name the Fetch Standard admits: an HTTP token. */
[[nodiscard]] inline bool http_header_name_valid(std::string_view name) {
    constexpr std::string_view punctuation = "!#$%&'*+-.^_`|~";
    return !name.empty() && std::all_of(name.begin(), name.end(), [&](char unit) {
        const auto byte = static_cast<unsigned char>(unit);
        return (byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'z') ||
               (byte >= 'A' && byte <= 'Z') || punctuation.find(unit) != std::string_view::npos;
    });
}

/** A header value normalized (HTTP whitespace trimmed), or nothing where it holds NUL, CR or LF. */
[[nodiscard]] inline std::optional<std::string> http_header_value(std::string_view value) {
    constexpr std::string_view whitespace = "\t\n\r ";
    const auto first = value.find_first_not_of(whitespace);
    if (first == std::string_view::npos)
        return std::string();
    value = value.substr(first, value.find_last_not_of(whitespace) - first + 1);
    if (value.find_first_of(std::string_view("\0\r\n", 3)) != std::string_view::npos)
        return std::nullopt;
    return std::string(value);
}

/**
 * A Headers object: a response's (immutable guard) or one a program constructs (`new
 * Headers(init)`, no guard). `get` is case-insensitive and joins repeated fields with ", ", as
 * the Fetch Standard's header list does. Copies share one object.
 */
class HttpHeaders {
public:
    HttpHeaders() = default;
    explicit HttpHeaders(std::shared_ptr<const HttpHeaderList> list) : list_(std::move(list)) {}

    /** `new Headers()`: an empty list the program may change. */
    [[nodiscard]] static HttpHeaders mutable_list() {
        HttpHeaders headers;
        headers.mutable_ = std::make_shared<HttpHeaderList>();
        headers.list_ = headers.mutable_;
        return headers;
    }

    [[nodiscard]] js::Nullable<std::string> get(std::string_view name) const {
        const auto key = http_header_name(name);
        std::optional<std::string> combined;
        for (const auto& [field, value] : list().entries) {
            if (field != key)
                continue;
            if (combined)
                *combined += ", " + value;
            else
                combined = value;
        }
        return combined ? js::Nullable<std::string>(std::move(*combined))
                        : js::Nullable<std::string>();
    }
    [[nodiscard]] bool has(std::string_view name) const {
        const auto key = http_header_name(name);
        return std::any_of(list().entries.begin(), list().entries.end(),
                           [&](const auto& entry) { return entry.first == key; });
    }
    /** `headers.set(name, value)`: the first field takes the value, later ones are removed. */
    void set(std::string_view name, std::string_view value) {
        auto [key, normalized] = validated("set", name, value);
        auto& entries = writable("set").entries;
        const auto first = std::find_if(entries.begin(), entries.end(),
                                        [&](const auto& entry) { return entry.first == key; });
        if (first == entries.end()) {
            entries.emplace_back(std::move(key), std::move(normalized));
            return;
        }
        first->second = std::move(normalized);
        entries.erase(std::remove_if(std::next(first), entries.end(),
                                     [&](const auto& entry) { return entry.first == key; }),
                      entries.end());
    }
    /** `headers.append(name, value)`. */
    void append(std::string_view name, std::string_view value) {
        auto [key, normalized] = validated("append", name, value);
        writable("append").entries.emplace_back(std::move(key), std::move(normalized));
    }
    /** `headers.delete(name)`. */
    void remove(std::string_view name) {
        if (!http_header_name_valid(name))
            throw js::NamedError("TypeError",
                                 "Failed to execute 'delete' on 'Headers': Invalid name");
        const auto key = http_header_name(name);
        auto& entries = writable("delete").entries;
        entries.erase(std::remove_if(entries.begin(), entries.end(),
                                     [&](const auto& entry) { return entry.first == key; }),
                      entries.end());
    }
    /** `new Headers(this)`: a list the program may change, with these fields in order. */
    [[nodiscard]] HttpHeaders copy() const {
        auto headers = mutable_list();
        for (const auto& [name, value] : entries())
            headers.append(name, value);
        return headers;
    }
    /** The list in order, as a request sends it. */
    [[nodiscard]] const std::vector<std::pair<std::string, std::string>>& entries() const {
        return list().entries;
    }
    [[nodiscard]] const void* get() const noexcept { return list_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(list_); }
    [[nodiscard]] friend bool operator==(const HttpHeaders& left, const HttpHeaders& right) {
        return left.list_ == right.list_;
    }

private:
    const HttpHeaderList& list() const {
        if (!list_)
            throw std::runtime_error("Headers receiver is absent.");
        return *list_;
    }
    HttpHeaderList& writable(const char* operation) {
        if (!mutable_)
            throw js::NamedError("TypeError", std::string("Failed to execute '") + operation +
                                                  "' on 'Headers': Headers are immutable");
        return *mutable_;
    }
    static std::pair<std::string, std::string>
    validated(const char* operation, std::string_view name, std::string_view value) {
        if (!http_header_name_valid(name))
            throw js::NamedError("TypeError", std::string("Failed to execute '") + operation +
                                                  "' on 'Headers': Invalid name");
        auto normalized = http_header_value(value);
        if (!normalized)
            throw js::NamedError("TypeError", std::string("Failed to execute '") + operation +
                                                  "' on 'Headers': Invalid value");
        return {http_header_name(name), std::move(*normalized)};
    }
    std::shared_ptr<const HttpHeaderList> list_;
    std::shared_ptr<HttpHeaderList> mutable_;
};

/** What the transport learns before the body: status, final URL and headers. */
struct HttpResponseHead {
    double status = 0;
    std::string url;
    std::shared_ptr<const HttpHeaderList> headers = std::make_shared<HttpHeaderList>();
};

/**
 * The thread-safe exchange between one transfer's transport thread and its realm. The transport
 * delivers the head, then body chunks, then the end or a failure; the realm polls, taking every
 * queued chunk as one, and, when it needs more, registers one completion the transport posts at
 * its next delivery. The end or failure is the realm's only in a task such a completion runs, as
 * the Fetch standard queues it as a task. A queue holding `high_water` bytes of chunk storage
 * blocks the transport until the realm reads (backpressure). `cancel` (either side, any thread)
 * discards queued bytes, wakes a blocked transport and ends what the transport reports.
 */
class HttpExchange {
public:
    static constexpr std::size_t high_water = 8u * 1024u * 1024u;

    HttpExchange(std::shared_ptr<EventLoop::Inbox> inbox, std::uint64_t head_completion)
        : inbox_(std::move(inbox)), head_completion_(head_completion) {}

    /** Transport: the platform wake a cancellation also runs (set before the transport starts). */
    void set_wake(std::function<void()> wake) {
        std::lock_guard lock(mutex_);
        wake_ = std::move(wake);
    }

    // Transport side.
    void deliver_head(HttpResponseHead head) {
        std::lock_guard lock(mutex_);
        if (head_ || failure_)
            return;
        head_ = std::move(head);
        post_locked(head_completion_);
    }
    /** Queue a chunk; false once canceled (the transport then stops). */
    bool push(std::vector<std::uint8_t> chunk) {
        std::unique_lock lock(mutex_);
        space_.wait(lock, [&] { return canceled_ || queued_ < high_water; });
        if (canceled_)
            return false;
        queued_ += chunk.capacity();
        chunks_.push_back(std::move(chunk));
        post_locked(std::exchange(waiting_, 0));
        return true;
    }
    void finish() {
        std::lock_guard lock(mutex_);
        finished_ = true;
        post_locked(std::exchange(waiting_, 0));
    }
    void fail(std::string message) {
        std::lock_guard lock(mutex_);
        if (finished_ || failure_ || canceled_)
            return;
        failure_ = std::move(message);
        post_locked(head_ ? std::exchange(waiting_, 0) : head_completion_);
    }
    [[nodiscard]] bool canceled() const {
        std::lock_guard lock(mutex_);
        return canceled_;
    }

    // Realm side.
    /** The head once delivered, or the failure before it. */
    [[nodiscard]] std::optional<HttpResponseHead> take_head(std::string& failure) {
        std::lock_guard lock(mutex_);
        if (head_)
            return std::move(head_);
        failure = failure_.value_or("HTTP transport ended without a response.");
        return std::nullopt;
    }
    enum class Poll { chunk, pending, done, failed };
    /**
     * The queued chunks, else, in a task a transport completion runs (`delivery_task`), the end or
     * failure. A poll elsewhere reports `pending` instead, so that an abort in the realm's current
     * task wins over an end or failure the realm has not yet observed.
     */
    Poll poll(std::vector<std::uint8_t>& chunk, std::string& failure, bool delivery_task) {
        std::lock_guard lock(mutex_);
        if (!chunks_.empty()) {
            // The queued chunks arrived in order: one read delivers them together.
            if (chunks_.size() == 1) {
                chunk = std::move(chunks_.front());
            } else {
                std::size_t size = 0;
                for (const auto& queued : chunks_)
                    size += queued.size();
                chunk.clear();
                chunk.reserve(size);
                for (const auto& queued : chunks_)
                    chunk.insert(chunk.end(), queued.begin(), queued.end());
            }
            chunks_.clear();
            queued_ = 0;
            space_.notify_all();
            return Poll::chunk;
        }
        if (!delivery_task)
            return Poll::pending;
        if (failure_) {
            failure = *failure_;
            return Poll::failed;
        }
        return finished_ ? Poll::done : Poll::pending;
    }
    /** Post `completion` at the transport's next delivery (or now, if one is ready). */
    void wait(std::uint64_t completion) {
        std::lock_guard lock(mutex_);
        if (!chunks_.empty() || finished_ || failure_ || canceled_)
            post_locked(completion);
        else
            waiting_ = completion;
    }
    void cancel() {
        std::function<void()> wake;
        {
            std::lock_guard lock(mutex_);
            if (canceled_)
                return;
            canceled_ = true;
            chunks_.clear();
            queued_ = 0;
            wake = wake_;
        }
        space_.notify_all();
        if (wake)
            wake();
    }

private:
    void post_locked(std::uint64_t completion) {
        if (completion)
            inbox_->post(std::make_unique<CompletionEvent>(completion));
    }

    mutable std::mutex mutex_;
    std::condition_variable space_;
    std::shared_ptr<EventLoop::Inbox> inbox_;
    std::uint64_t head_completion_;
    std::optional<HttpResponseHead> head_;
    std::deque<std::vector<std::uint8_t>> chunks_;
    std::size_t queued_ = 0;
    bool finished_ = false;
    std::optional<std::string> failure_;
    bool canceled_ = false;
    std::uint64_t waiting_ = 0;
    std::function<void()> wake_;
};

/**
 * Joins finished or canceled transport threads off the realm thread: a cancellation never waits
 * for a transfer to notice it. Process exit joins the threads still queued.
 */
class HttpTransportReaper {
public:
    static HttpTransportReaper& instance() {
        static HttpTransportReaper reaper;
        return reaper;
    }
    void reap(JoiningThread thread) {
        {
            std::lock_guard lock(mutex_);
            pending_.push_back(std::move(thread));
        }
        wake_.notify_one();
    }
    ~HttpTransportReaper() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        wake_.notify_one();
        run_teardown("HTTP transport reaper join", [&] { worker_.join(); });
    }

private:
    HttpTransportReaper() : worker_([this] { run(); }) {}
    void run() {
        std::unique_lock lock(mutex_);
        for (;;) {
            wake_.wait(lock, [&] { return stopping_ || !pending_.empty(); });
            if (pending_.empty())
                return;
            auto thread = std::move(pending_.front());
            pending_.pop_front();
            lock.unlock();
            thread = JoiningThread();
            lock.lock();
        }
    }
    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<JoiningThread> pending_;
    bool stopping_ = false;
    std::thread worker_;
};

/** A transfer's transport thread; destroying it cancels the exchange and hands the thread to the
 * reaper, so no realm thread waits for a transfer to stop. */
struct HttpTransport {
    std::shared_ptr<HttpExchange> exchange;
    JoiningThread thread;
    HttpTransport() = default;
    HttpTransport(const HttpTransport&) = delete;
    HttpTransport& operator=(const HttpTransport&) = delete;
    ~HttpTransport() {
        if (exchange)
            exchange->cancel();
        HttpTransportReaper::instance().reap(std::move(thread));
    }
};

/** A byte stream read's `{ done, value }`; `value` is meaningful only while not done. */
struct BodyReadResult {
    bool done = true;
    js::U8Array value;
};

/**
 * The byte transformation behind a transform stream (`pal_compression.hpp`): a written chunk and
 * the end of input append the chunks they produce; invalid input throws the TypeError that
 * errors the stream.
 */
class ByteTransformer {
public:
    ByteTransformer() = default;
    ByteTransformer(const ByteTransformer&) = delete;
    ByteTransformer& operator=(const ByteTransformer&) = delete;
    virtual ~ByteTransformer() = default;
    virtual void transform(std::span<const std::uint8_t> input,
                           std::deque<std::vector<std::uint8_t>>& output) = 0;
    virtual void flush(std::deque<std::vector<std::uint8_t>>& output) = 0;
};

struct HttpBodyState;

/**
 * `controller` of a program's underlying source (`ReadableStreamDefaultController`): it
 * enqueues a chunk, closes the stream once its queue drains, or errors it. Copies share it.
 */
class BodyStreamController {
public:
    BodyStreamController() = default;
    explicit BodyStreamController(std::shared_ptr<HttpBodyState> state) : state_(std::move(state)) {}
    /** `controller.enqueue(chunk)`: a TypeError once closing or no longer readable. */
    void enqueue(js::U8Array chunk) const;
    /** `controller.close()`: a TypeError once closing or no longer readable. */
    void close() const;
    /** `controller.error(reason)`. */
    void error(js::Error reason) const;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(state_); }

private:
    std::shared_ptr<HttpBodyState> state_;
};

/**
 * A program's underlying source (`new ReadableStream({ pull, cancel })`): its pull and cancel
 * algorithms and the chunks its controller enqueued that no read took yet. The stream pulls once
 * started and again whenever a read waits on an empty queue, never while a pull's promise is
 * pending: the default strategy, a high-water mark of one chunk.
 */
struct BodyPullSource {
    js::Callback<js::Promise<js::PromiseVoid>(BodyStreamController)> pull;
    js::Callback<js::Promise<js::PromiseVoid>(js::Nullable<js::Error>)> cancel;
    std::deque<js::U8Array> queue;
    bool started = false;
    bool pulling = false;
    bool pull_again = false;
    bool close_requested = false;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(pull);
        visitor(cancel);
        for (const auto& chunk : queue)
            visitor(chunk);
    }
};

/**
 * A transform stream's readable side: its transformer (absent once flushed), the stream piped
 * into its writable side (absent until `pipeThrough` and after the pipe ends) and output not yet
 * read. The pipe reads its source only while a read of this side waits for output.
 */
struct ByteTransformSide {
    std::unique_ptr<ByteTransformer> transformer;
    std::shared_ptr<HttpBodyState> source;
    std::deque<std::vector<std::uint8_t>> output;
    bool pulling = false;
};

/**
 * A ReadableStream<Uint8Array>'s state, owned by the realm. Its source is the whole body (a
 * packaged response, a Blob), a transfer's exchange or a transform's output. The stream is
 * readable, then closed (end, cancel) or errored (transport failure, abort, invalid transform
 * input); reads are served in request order.
 */
struct HttpBodyState {
    enum class Phase { readable, closed, errored };
    Phase phase = Phase::readable;
    std::optional<std::vector<std::uint8_t>> whole;
    std::shared_ptr<HttpTransport> transport;
    std::optional<ByteTransformSide> transform;
    std::shared_ptr<BodyPullSource> pull;
    std::optional<js::Error> error;
    bool disturbed = false;
    bool locked = false;
    std::deque<js::Promise<BodyReadResult>> reads;
    std::uint64_t waiting = 0;
    js::AbortSignal signal;
    js::AbortSignal::AlgorithmId algorithm = 0;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(reads);
        visitor(error);
        visitor(signal);
        visitor(pull);
        if (transform)
            visitor(transform->source);
    }
};

namespace http_detail {
inline void close(HttpBodyState& state);
inline void pump(const std::shared_ptr<HttpBodyState>& state, bool delivery_task);
inline void settle_reads(HttpBodyState& state) {
    auto reads = std::move(state.reads);
    state.reads.clear();
    for (auto& read : reads) {
        if (state.phase == HttpBodyState::Phase::errored)
            read.reject(*state.error);
        else
            read.resolve(BodyReadResult{});
    }
}
/**
 * End the source's realm ties: the abort algorithm, the transport (joined later) and a transform's
 * pipe, which cancels the stream piped into it and releases that stream's lock.
 */
inline void release_source(HttpBodyState& state) {
    if (state.algorithm) {
        state.signal.remove_algorithm(state.algorithm);
        state.algorithm = 0;
    }
    if (state.transport && state.transport->exchange)
        state.transport->exchange->cancel();
    state.whole.reset();
    if (state.pull)
        state.pull->queue.clear();
    if (state.transform) {
        state.transform->transformer.reset();
        state.transform->output.clear();
        if (const auto source = std::exchange(state.transform->source, nullptr)) {
            source->disturbed = true;
            close(*source);
            source->locked = false;
        }
    }
}
inline void close(HttpBodyState& state) {
    if (state.phase != HttpBodyState::Phase::readable)
        return;
    state.phase = HttpBodyState::Phase::closed;
    release_source(state);
    settle_reads(state);
}
inline void error(HttpBodyState& state, js::Error reason) {
    if (state.phase != HttpBodyState::Phase::readable)
        return;
    state.phase = HttpBodyState::Phase::errored;
    state.error = std::move(reason);
    release_source(state);
    settle_reads(state);
}
inline js::Error type_error(std::string message) {
    return std::make_exception_ptr(js::NamedError("TypeError", std::move(message)));
}
/** One read of `body`: its next chunk, `{ done: true }` at its end, or its error. */
inline js::Promise<BodyReadResult> read_body(const std::shared_ptr<HttpBodyState>& body) {
    body->disturbed = true;
    if (body->phase == HttpBodyState::Phase::closed)
        return js::Promise<BodyReadResult>::resolved(BodyReadResult{});
    if (body->phase == HttpBodyState::Phase::errored)
        return js::Promise<BodyReadResult>::rejected(*body->error);
    js::Promise<BodyReadResult> read;
    body->reads.push_back(read);
    pump(body, false);
    return read;
}
/**
 * A transform's source delivered `part`: transform its chunk, or at its end flush the transformer
 * and release the source (the pipe closes the writable side). A transformer failure errors the
 * readable side, which cancels the source.
 */
inline void transform_part(const std::shared_ptr<HttpBodyState>& state,
                           const BodyReadResult& part) {
    if (!state->transform)
        return;
    auto& transform = *state->transform;
    transform.pulling = false;
    if (state->phase != HttpBodyState::Phase::readable || !transform.transformer)
        return;
    try {
        if (part.done) {
            const auto transformer = std::move(transform.transformer);
            transformer->flush(transform.output);
            if (const auto source = std::exchange(transform.source, nullptr))
                source->locked = false;
        } else {
            transform.transformer->transform(
                std::span<const std::uint8_t>(part.value.data(), part.value.size()),
                transform.output);
        }
    } catch (...) {
        error(*state, std::current_exception());
        return;
    }
    pump(state, false);
}
/** Read `transform`'s source once; the source's error errors the readable side, `state`. */
inline void pull_transform_source(const std::shared_ptr<HttpBodyState>& state,
                                  ByteTransformSide& transform) {
    transform.pulling = true;
    read_body(transform.source)
        .observe(js::make_closure(std::tuple{state},
                                  [](auto& captured, const BodyReadResult& part) {
                                      transform_part(std::get<0>(captured), part);
                                  }),
                 js::make_closure(std::tuple{state}, [](auto& captured, std::exception_ptr reason) {
                     const auto& current = std::get<0>(captured);
                     if (current->transform)
                         current->transform->pulling = false;
                     error(*current, reason);
                 }));
}
/**
 * A program's source asked for its next chunk when the stream wants one (`ReadableStream
 * DefaultControllerCallPullIfNeeded`): started, not closing, a read waiting or the queue under
 * its one chunk; a pull settling while another was asked for pulls again.
 */
inline void call_pull_if_needed(const std::shared_ptr<HttpBodyState>& state) {
    const auto source = state->pull;
    if (!source || !source->started || source->close_requested ||
        state->phase != HttpBodyState::Phase::readable ||
        (state->reads.empty() && !source->queue.empty()))
        return;
    if (source->pulling) {
        source->pull_again = true;
        return;
    }
    source->pulling = true;
    js::Promise<js::PromiseVoid> pulled;
    try {
        pulled = source->pull(BodyStreamController(state));
    } catch (...) {
        pulled = js::Promise<js::PromiseVoid>::rejected(std::current_exception());
    }
    pulled.observe(js::make_closure(std::tuple{state},
                                    [](auto& captured, const js::PromiseVoid&) {
                                        const auto& current = std::get<0>(captured);
                                        const auto& settled = current->pull;
                                        settled->pulling = false;
                                        if (std::exchange(settled->pull_again, false))
                                            call_pull_if_needed(current);
                                    }),
                   js::make_closure(std::tuple{state}, [](auto& captured, std::exception_ptr reason) {
                       error(*std::get<0>(captured), reason);
                   }));
}

/**
 * Serve queued reads from the source; wait on the transport when it has nothing yet. Only a
 * `delivery_task` (the task a transport completion runs) ends or errors the stream, and only
 * before it delivers a chunk: the end or failure is its own task after that chunk's. A
 * transform's readable side serves its output, then pulls its source, then closes once flushed.
 */
inline void pump(const std::shared_ptr<HttpBodyState>& state, bool delivery_task) {
    while (!state->reads.empty() && state->phase == HttpBodyState::Phase::readable) {
        if (const auto& source = state->pull) {
            if (!source->queue.empty()) {
                auto read = std::move(state->reads.front());
                state->reads.pop_front();
                auto chunk = std::move(source->queue.front());
                source->queue.pop_front();
                read.resolve(BodyReadResult{false, std::move(chunk)});
                continue;
            }
            if (source->close_requested)
                close(*state);
            else
                call_pull_if_needed(state);
            return;
        }
        if (state->transform) {
            auto& transform = *state->transform;
            if (!transform.output.empty()) {
                auto read = std::move(state->reads.front());
                state->reads.pop_front();
                auto chunk = std::move(transform.output.front());
                transform.output.pop_front();
                read.resolve(BodyReadResult{false, js::U8Array(js::ArrayBuffer(std::move(chunk)))});
                continue;
            }
            if (!transform.transformer)
                close(*state);
            else if (transform.source && !transform.pulling)
                pull_transform_source(state, transform);
            return;
        }
        std::vector<std::uint8_t> chunk;
        std::string failure;
        auto poll = HttpExchange::Poll::done;
        if (state->whole) {
            chunk = std::move(*state->whole);
            state->whole.reset();
            poll = chunk.empty() ? HttpExchange::Poll::done : HttpExchange::Poll::chunk;
        } else if (state->transport && state->transport->exchange) {
            poll = state->transport->exchange->poll(chunk, failure, delivery_task);
        }
        if (poll == HttpExchange::Poll::chunk) {
            auto read = std::move(state->reads.front());
            state->reads.pop_front();
            read.resolve(BodyReadResult{false, js::U8Array(js::ArrayBuffer(std::move(chunk)))});
            delivery_task = false;
            continue;
        }
        if (poll == HttpExchange::Poll::done) {
            close(*state);
            return;
        }
        if (poll == HttpExchange::Poll::failed) {
            error(*state, type_error(failure));
            return;
        }
        if (state->waiting)
            return;
        auto& loop = EventLoop::current();
        const std::weak_ptr<HttpBodyState> weak = state;
        state->waiting = loop.register_completion([weak](std::unique_ptr<ExternalEvent>) {
            if (const auto current = weak.lock()) {
                current->waiting = 0;
                pump(current, true);
            }
        });
        state->transport->exchange->wait(state->waiting);
        return;
    }
}
} // namespace http_detail

/** A ReadableStream<Uint8Array>: one response's body. Copies share the stream. */
class BodyStream {
public:
    BodyStream() = default;
    explicit BodyStream(std::shared_ptr<HttpBodyState> state) : state_(std::move(state)) {}

    /** `stream.locked`. */
    [[nodiscard]] bool locked() const { return state().locked; }
    /**
     * `stream.cancel(reason)`: rejects while locked; closes the stream and stops its transfer,
     * or cancels a program's source with `reason`.
     */
    js::Promise<js::PromiseVoid> cancel(js::Nullable<js::Error> reason = std::nullopt) const;
    /** `stream.getReader()`: throws TypeError while another reader holds the lock. */
    [[nodiscard]] class BodyReader get_reader() const;
    /**
     * `stream.pipeThrough(transform)`: locks and disturbs this stream, which feeds the transform as
     * its readable side (the result) is read. A locked stream or writable side throws TypeError; a
     * transform whose readable side already ended cancels this stream instead.
     */
    [[nodiscard]] BodyStream pipe_through(const class ByteTransformStream& transform) const;

    [[nodiscard]] const std::shared_ptr<HttpBodyState>& shared_state() const { return state_; }
    [[nodiscard]] const void* get() const noexcept { return state_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(state_); }
    [[nodiscard]] friend bool operator==(const BodyStream& left, const BodyStream& right) {
        return left.state_ == right.state_;
    }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(state_); }

private:
    HttpBodyState& state() const {
        if (!state_)
            throw std::runtime_error("ReadableStream receiver is absent.");
        return *state_;
    }
    std::shared_ptr<HttpBodyState> state_;
};

/** A ReadableStreamDefaultReader<Uint8Array>. Copies share the reader. */
class BodyReader {
public:
    BodyReader() = default;
    explicit BodyReader(BodyStream stream)
        : state_(js::make_gc_shared<State>(State{std::move(stream), false})) {}

    /** `reader.read()`: the next chunk, `{ done: true }` at the end, or the stream's error. */
    [[nodiscard]] js::Promise<BodyReadResult> read() const {
        try {
            stream_state();
            return http_detail::read_body(state().stream.shared_state());
        } catch (...) {
            return js::Promise<BodyReadResult>::rejected(std::current_exception());
        }
    }
    /** `reader.cancel(reason)`. */
    [[nodiscard]] js::Promise<js::PromiseVoid>
    cancel(js::Nullable<js::Error> reason = std::nullopt) const {
        try {
            stream_state();
            return cancel_stream(state().stream.shared_state(), std::move(reason));
        } catch (...) {
            return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
        }
    }
    /** `reader.releaseLock()`: pending reads reject with a TypeError; the stream unlocks. */
    void release_lock() const {
        auto& reader = state();
        if (reader.released)
            return;
        auto& body = *reader.stream.shared_state();
        reader.released = true;
        body.locked = false;
        auto reads = std::move(body.reads);
        body.reads.clear();
        for (auto& read : reads)
            read.reject(http_detail::type_error("The reader's lock was released."));
    }

    /**
     * Close or reuse: shared by `reader.cancel()` and `stream.cancel()`. A program's source is
     * canceled too, the cancel settling as its cancel algorithm does.
     */
    static js::Promise<js::PromiseVoid> cancel_stream(const std::shared_ptr<HttpBodyState>& body,
                                                      js::Nullable<js::Error> reason) {
        body->disturbed = true;
        if (body->phase == HttpBodyState::Phase::errored)
            return js::Promise<js::PromiseVoid>::rejected(*body->error);
        const bool readable = body->phase == HttpBodyState::Phase::readable;
        http_detail::close(*body);
        if (readable && body->pull && body->pull->cancel)
            try {
                return body->pull->cancel(std::move(reason));
            } catch (...) {
                return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
            }
        return js::Promise<js::PromiseVoid>::resolved({});
    }

    [[nodiscard]] const void* get() const noexcept { return state_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(state_); }
    [[nodiscard]] friend bool operator==(const BodyReader& left, const BodyReader& right) {
        return left.state_ == right.state_;
    }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(state_); }

private:
    struct State {
        BodyStream stream;
        bool released = false;
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(stream); }
    };
    State& state() const {
        if (!state_)
            throw std::runtime_error("ReadableStreamDefaultReader receiver is absent.");
        return *state_;
    }
    HttpBodyState& stream_state() const {
        auto& reader = state();
        if (reader.released)
            throw js::NamedError("TypeError", "The reader's lock was released.");
        return *reader.stream.shared_state();
    }
    std::shared_ptr<State> state_;
};

inline js::Promise<js::PromiseVoid> BodyStream::cancel(js::Nullable<js::Error> reason) const {
    try {
        if (state().locked)
            throw js::NamedError("TypeError", "A locked ReadableStream cannot be canceled.");
        return BodyReader::cancel_stream(state_, std::move(reason));
    } catch (...) {
        return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
    }
}

inline BodyReader BodyStream::get_reader() const {
    auto& body = state();
    if (body.locked)
        throw js::NamedError("TypeError", "ReadableStream is locked to a reader.");
    body.locked = true;
    return BodyReader(*this);
}

/**
 * A CompressionStream or DecompressionStream (`pal_compression.hpp` makes them): the readable
 * side its transformer feeds and `pipeThrough` sources. Copies share the stream.
 */
class ByteTransformStream {
public:
    ByteTransformStream() = default;
    explicit ByteTransformStream(std::unique_ptr<ByteTransformer> transformer)
        : readable_(js::make_gc_shared<HttpBodyState>()) {
        readable_->transform.emplace().transformer = std::move(transformer);
    }

    /** `transform.readable`: the same stream on every read. */
    [[nodiscard]] BodyStream readable() const { return BodyStream(state()); }

    [[nodiscard]] const std::shared_ptr<HttpBodyState>& state() const {
        if (!readable_)
            throw std::runtime_error("Transform stream receiver is absent.");
        return readable_;
    }
    [[nodiscard]] const void* get() const noexcept { return readable_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(readable_); }
    [[nodiscard]] friend bool operator==(const ByteTransformStream& left,
                                         const ByteTransformStream& right) {
        return left.readable_ == right.readable_;
    }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(readable_); }

private:
    std::shared_ptr<HttpBodyState> readable_;
};

inline BodyStream BodyStream::pipe_through(const ByteTransformStream& transform) const {
    auto& source = state();
    const auto& readable = transform.state();
    if (!readable->transform)
        throw std::runtime_error("Transform stream receiver is absent.");
    if (source.locked)
        throw js::NamedError("TypeError", "Failed to execute 'pipeThrough' on 'ReadableStream': "
                                          "Cannot pipe a locked stream");
    auto& side = *readable->transform;
    if (side.source)
        throw js::NamedError("TypeError", "Failed to execute 'pipeThrough' on 'ReadableStream': "
                                          "parameter 1's 'writable' is locked");
    source.disturbed = true;
    if (readable->phase != HttpBodyState::Phase::readable || !side.transformer) {
        // The pipe finds its destination closed or errored: it cancels the source.
        http_detail::close(source);
        return BodyStream(readable);
    }
    source.locked = true;
    side.source = state_;
    http_detail::pump(readable, false);
    return BodyStream(readable);
}

inline void BodyStreamController::enqueue(js::U8Array chunk) const {
    auto& state = *state_;
    if (state.phase != HttpBodyState::Phase::readable || state.pull->close_requested)
        throw js::NamedError("TypeError", "The ReadableStream cannot enqueue a chunk.");
    state.pull->queue.push_back(std::move(chunk));
    http_detail::pump(state_, false);
    http_detail::call_pull_if_needed(state_);
}

inline void BodyStreamController::close() const {
    auto& state = *state_;
    if (state.phase != HttpBodyState::Phase::readable || state.pull->close_requested)
        throw js::NamedError("TypeError", "The ReadableStream cannot be closed.");
    state.pull->close_requested = true;
    if (state.pull->queue.empty())
        http_detail::close(state);
}

inline void BodyStreamController::error(js::Error reason) const {
    http_detail::error(*state_, std::move(reason));
}

/**
 * `new ReadableStream({ pull, cancel })` over byte chunks: the program's source, started on
 * the next microtask as its absent start algorithm settles.
 */
[[nodiscard]] inline BodyStream make_pull_stream(
    js::Callback<js::Promise<js::PromiseVoid>(BodyStreamController)> pull,
    js::Callback<js::Promise<js::PromiseVoid>(js::Nullable<js::Error>)> cancel) {
    auto state = js::make_gc_shared<HttpBodyState>();
    state->pull = js::make_gc_shared<BodyPullSource>();
    state->pull->pull = std::move(pull);
    state->pull->cancel = std::move(cancel);
    EventLoop::current().queue_microtask([state] {
        state->pull->started = true;
        http_detail::call_pull_if_needed(state);
    });
    return BodyStream(std::move(state));
}

/** A ReadableStream over bytes already in memory (`blob.stream()`): one chunk, then its end. */
[[nodiscard]] inline BodyStream whole_body_stream(std::vector<std::uint8_t> bytes) {
    auto state = js::make_gc_shared<HttpBodyState>();
    state->whole = std::move(bytes);
    return BodyStream(std::move(state));
}

/** Buffered reads (text, json, arrayBuffer) of a fetched response keep their native bound. */
inline constexpr std::size_t maximum_buffered_body = 32u * 1024u * 1024u;

/** A Response. Transport data stays in the exchange; the realm holds the body state. */
struct HttpResponseData {
    double status = 0;
    std::string url;
    HttpHeaders headers;
    /** Absent for a null-body status or a HEAD request. */
    std::optional<BodyStream> body;
    /**
     * `new Response(stream)`: a buffered read has no bound beyond memory and, as Chromium's, rejects
     * a body stream error as TypeError "Failed to fetch".
     */
    bool constructed = false;
    /**
     * `response.statusText`: a constructed response's; the native transport keeps no reason
     * phrase, so a fetched one's is empty, as an HTTP/2 response's is.
     */
    std::string status_text;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(body); }
};
using HttpResponse = js::Ref<HttpResponseData>;

/** A null body status (Fetch Standard) has no body stream. */
[[nodiscard]] inline bool http_null_body_status(double status) {
    return status == 101 || status == 103 || status == 204 || status == 205 || status == 304;
}

/** A response over its whole body, already read (a packaged file). */
[[nodiscard]] inline HttpResponse make_buffered_response(double status, std::string url,
                                                         std::vector<std::uint8_t> body,
                                                         HttpHeaders headers = {}) {
    return js::make_ref<HttpResponseData>(HttpResponseData{
        status, std::move(url),
        headers ? std::move(headers) : HttpHeaders(std::make_shared<HttpHeaderList>()),
        whole_body_stream(std::move(body)), false, std::string()});
}

/** `new Response(body, init)`'s `{ status, statusText, headers }`. */
struct HttpResponseInit {
    double status = 200;
    std::string status_text;
    /** Copied into the response's own Headers object. */
    js::Nullable<HttpHeaders> headers;
};

/**
 * `new Response(stream, init)`: the init's status (200), status text and a copy of its headers,
 * with `stream` itself as the body. A locked or disturbed stream, or a status outside 200-599,
 * throws TypeError; a null-body status takes no body.
 */
[[nodiscard]] inline HttpResponse make_stream_response(const BodyStream& body,
                                                       HttpResponseInit init = {}) {
    const auto& state = body.shared_state();
    if (!state)
        throw std::runtime_error("ReadableStream receiver is absent.");
    if (init.status < 200 || init.status > 599)
        throw js::NamedError("RangeError", "Failed to construct 'Response': The status provided "
                                           "is outside the range [200, 599].");
    if (http_null_body_status(init.status))
        throw js::NamedError("TypeError", "Failed to construct 'Response': Response with null "
                                          "body status cannot have body");
    if (state->locked || state->disturbed)
        throw js::NamedError("TypeError", "Failed to construct 'Response': Response body object "
                                          "should not be disturbed or locked");
    auto headers = init.headers ? init.headers->copy() : HttpHeaders::mutable_list();
    return js::make_ref<HttpResponseData>(HttpResponseData{
        init.status, std::string(), std::move(headers), body, true, std::move(init.status_text)});
}

/** WHATWG UTF-8 replacement decoding, including initial BOM removal. */
inline std::string decode_http_text(const std::vector<std::uint8_t>& bytes) {
    if (bytes.empty())
        return {};
    return js::decode_utf8_removing_bom(
        std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
}

inline bool http_response_ok(const HttpResponse& response) {
    return response->status >= 200 && response->status < 300;
}

/** `response.bodyUsed`. */
inline bool http_response_body_used(const HttpResponse& response) {
    return response->body && response->body->shared_state()->disturbed;
}

/** `response.body`: the same stream object on every read, or null. */
inline js::Nullable<BodyStream> http_response_body(const HttpResponse& response) {
    return response->body ? js::Nullable<BodyStream>(*response->body) : js::Nullable<BodyStream>();
}

/** "Consume body": every chunk, once; an unusable (locked or disturbed) body rejects. */
inline js::Promise<std::vector<std::uint8_t>> consume_http_body(HttpResponse response) {
    std::vector<std::uint8_t> bytes;
    if (!response->body)
        co_return bytes;
    const auto& stream = *response->body;
    if (stream.shared_state()->disturbed || stream.locked())
        throw js::NamedError("TypeError", "Response body has already been consumed.");
    const auto reader = stream.get_reader();
    const auto maximum =
        response->constructed ? (std::numeric_limits<std::size_t>::max)() : maximum_buffered_body;
    for (;;) {
        BodyReadResult part;
        try {
            part = co_await reader.read();
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            if (!response->constructed)
                throw;
            throw js::NamedError("TypeError", "Failed to fetch");
        }
        if (part.done)
            break;
        if (part.value.size() > maximum - bytes.size()) {
            static_cast<void>(reader.cancel());
            throw js::NamedError("TypeError", "HTTP response body exceeds 32 MiB.");
        }
        bytes.insert(bytes.end(), part.value.begin(), part.value.end());
    }
    co_return bytes;
}

inline js::Promise<std::string> http_response_text(const HttpResponse& response) {
    return consume_http_body(response).then(
        [](const std::vector<std::uint8_t>& bytes) { return decode_http_text(bytes); });
}

inline js::Promise<js::ArrayBuffer> http_response_buffer(const HttpResponse& response) {
    return consume_http_body(response).then(
        [](const std::vector<std::uint8_t>& bytes) { return js::ArrayBuffer(bytes); });
}

} // namespace bbl::pal
