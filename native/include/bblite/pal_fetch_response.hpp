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
#include <mutex>
#include <optional>
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
 * A response's Headers object (immutable guard). `get` is case-insensitive and joins repeated
 * fields with ", ", as the Fetch Standard's header list does. Copies share one object.
 */
class HttpHeaders {
public:
    HttpHeaders() = default;
    explicit HttpHeaders(std::shared_ptr<const HttpHeaderList> list) : list_(std::move(list)) {}

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
    std::shared_ptr<const HttpHeaderList> list_;
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
 * its next delivery. A queue holding `high_water` bytes of chunk storage blocks the transport
 * until the realm reads (backpressure). `cancel` (either side, any thread) discards queued bytes
 * and wakes a blocked transport.
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
        if (finished_ || failure_)
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
    Poll poll(std::vector<std::uint8_t>& chunk, std::string& failure) {
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
 * A response body's ReadableStream state, owned by the realm. Its source is either the whole
 * body (a packaged response) or a transfer's exchange. The stream is readable, then closed (end,
 * cancel) or errored (transport failure, abort); reads are served in request order.
 */
struct HttpBodyState {
    enum class Phase { readable, closed, errored };
    Phase phase = Phase::readable;
    std::optional<std::vector<std::uint8_t>> whole;
    std::shared_ptr<HttpTransport> transport;
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
    }
};

namespace http_detail {
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
/** End the transfer's realm ties: the abort algorithm and the transport (joined later). */
inline void release_source(HttpBodyState& state) {
    if (state.algorithm) {
        state.signal.remove_algorithm(state.algorithm);
        state.algorithm = 0;
    }
    if (state.transport && state.transport->exchange)
        state.transport->exchange->cancel();
    state.whole.reset();
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
/** Serve queued reads from the source; wait on the transport when it has nothing yet. */
inline void pump(const std::shared_ptr<HttpBodyState>& state) {
    while (!state->reads.empty() && state->phase == HttpBodyState::Phase::readable) {
        std::vector<std::uint8_t> chunk;
        std::string failure;
        auto poll = HttpExchange::Poll::done;
        if (state->whole) {
            chunk = std::move(*state->whole);
            state->whole.reset();
            poll = chunk.empty() ? HttpExchange::Poll::done : HttpExchange::Poll::chunk;
        } else if (state->transport && state->transport->exchange) {
            poll = state->transport->exchange->poll(chunk, failure);
        }
        if (poll == HttpExchange::Poll::chunk) {
            auto read = std::move(state->reads.front());
            state->reads.pop_front();
            read.resolve(BodyReadResult{false, js::U8Array(js::ArrayBuffer(std::move(chunk)))});
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
                pump(current);
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
    /** `stream.cancel()`: rejects while locked; closes the stream and stops its transfer. */
    js::Promise<js::PromiseVoid> cancel() const;
    /** `stream.getReader()`: throws TypeError while another reader holds the lock. */
    [[nodiscard]] class BodyReader get_reader() const;

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
            auto& body = stream_state();
            body.disturbed = true;
            if (body.phase == HttpBodyState::Phase::closed)
                return js::Promise<BodyReadResult>::resolved(BodyReadResult{});
            if (body.phase == HttpBodyState::Phase::errored)
                return js::Promise<BodyReadResult>::rejected(*body.error);
            js::Promise<BodyReadResult> read;
            body.reads.push_back(read);
            http_detail::pump(state().stream.shared_state());
            return read;
        } catch (...) {
            return js::Promise<BodyReadResult>::rejected(std::current_exception());
        }
    }
    /** `reader.cancel()`. */
    [[nodiscard]] js::Promise<js::PromiseVoid> cancel() const {
        try {
            stream_state();
            return cancel_stream(state().stream.shared_state());
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

    /** Close or reuse: shared by `reader.cancel()` and `stream.cancel()`. */
    static js::Promise<js::PromiseVoid> cancel_stream(const std::shared_ptr<HttpBodyState>& body) {
        body->disturbed = true;
        if (body->phase == HttpBodyState::Phase::errored)
            return js::Promise<js::PromiseVoid>::rejected(*body->error);
        http_detail::close(*body);
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

inline js::Promise<js::PromiseVoid> BodyStream::cancel() const {
    try {
        if (state().locked)
            throw js::NamedError("TypeError", "A locked ReadableStream cannot be canceled.");
        return BodyReader::cancel_stream(state_);
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

/** A Response. Transport data stays in the exchange; the realm holds the body state. */
struct HttpResponseData {
    double status = 0;
    std::string url;
    HttpHeaders headers;
    /** Absent for a null-body status or a HEAD request. */
    std::optional<BodyStream> body;
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
    auto state = js::make_gc_shared<HttpBodyState>();
    state->whole = std::move(body);
    return js::make_ref<HttpResponseData>(HttpResponseData{
        status, std::move(url),
        headers ? std::move(headers) : HttpHeaders(std::make_shared<HttpHeaderList>()),
        BodyStream(std::move(state))});
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

/** Buffered reads (text, json, arrayBuffer) keep their native bound. */
inline constexpr std::size_t maximum_buffered_body = 32u * 1024u * 1024u;

/** "Consume body": every chunk, once; an unusable (locked or disturbed) body rejects. */
inline js::Promise<std::vector<std::uint8_t>> consume_http_body(HttpResponse response) {
    std::vector<std::uint8_t> bytes;
    if (!response->body)
        co_return bytes;
    const auto& stream = *response->body;
    if (stream.shared_state()->disturbed || stream.locked())
        throw js::NamedError("TypeError", "Response body has already been consumed.");
    const auto reader = stream.get_reader();
    for (;;) {
        const auto part = co_await reader.read();
        if (part.done)
            break;
        if (part.value.size() > maximum_buffered_body - bytes.size()) {
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
