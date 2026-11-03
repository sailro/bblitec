#pragma once

// IndexedDB's JavaScript half: `indexedDB.open`, its connection, object stores keyed out of line,
// readonly/readwrite transactions, get/put/delete, and a cursor over a store. Like Web Storage it
// is a host service with no Babylon declaration behind it; its records live in the PAL's SQLite
// files (pal_indexed_db.hpp), as the browsers keep theirs.
//
// Requests settle as the browser's do: each in its own later task, firing its `success` or
// `error` handler, with a microtask checkpoint after every handler. A transaction starts once the
// task that created it ends, runs its requests in order, and commits when the last one has
// settled and its handlers queued no more; `complete` then fires. A request that fails fires its
// `error` handler, then the transaction's, and aborts the transaction; a handler that throws
// aborts it too. A readwrite transaction's writes stay in the transaction, read back by its own
// requests, until its commit writes them as one SQLite transaction, so an abort or a failed
// write leaves the stored records as they were.
//
// A value is stored as its structured clone (pal_clone_storage.hpp), taken when `put` is called,
// and reads back as a dynamic value (js_json.hpp): records, arrays, strings, numbers, booleans,
// null, undefined and Blobs. Keys are numbers and strings, ordered as IndexedDB orders them.

#include <bblite/js_data.hpp>
#include <bblite/js_file.hpp>
#include <bblite/js_json.hpp>
#include <bblite/js_structured_clone.hpp>
#include <bblite/pal_clone_storage.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_indexed_db.hpp>

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <deque>
#include <functional>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::js {

// ── Stored values ─────────────────────────────────────────────────────

/**
 * A dynamic value's clone: records, arrays, primitives and Blobs, read back as a dynamic value
 * of the same shape. IndexedDB is its consumer; a record field holding a dynamic value (a key
 * typed `IDBValidKey`) clones through it too.
 */
template <> struct CloneCodec<JsonValue> {
    static pal::CloneId write(pal::CloneWriter& writer, const JsonValue& value) {
        switch (value.kind()) {
        case JsonValue::Kind::undefined:
            return writer.add(pal::CloneUndefined{});
        case JsonValue::Kind::null:
            return writer.add(pal::CloneNull{});
        case JsonValue::Kind::boolean:
            return writer.add(value.truthy());
        case JsonValue::Kind::number:
            return writer.add(value.to_number());
        case JsonValue::Kind::string:
            return writer.add(value.string_value());
        case JsonValue::Kind::array: {
            pal::CloneArray array;
            const auto count = static_cast<std::size_t>(value.length());
            array.elements.reserve(count);
            for (std::size_t index = 0; index < count; ++index)
                array.elements.push_back(write(writer, value.at(static_cast<double>(index))));
            return writer.add(std::move(array));
        }
        case JsonValue::Kind::object:
            break;
        }
        if (value.instance_of<Blob>())
            return clone_write(writer, value.asserted_instance<Blob>());
        pal::CloneObject object;
        for (const auto& key : value.own_keys())
            object.properties.emplace_back(key, write(writer, value.get(key)));
        return writer.add(std::move(object));
    }

    static JsonValue read(pal::CloneReader& reader, pal::CloneId id) {
        return std::visit(
            [&](const auto& node) -> JsonValue {
                using Node = std::decay_t<decltype(node)>;
                if constexpr (std::is_same_v<Node, pal::CloneUndefined>)
                    return {};
                else if constexpr (std::is_same_v<Node, pal::CloneNull>)
                    return JsonValue::null_value();
                else if constexpr (std::is_same_v<Node, bool>)
                    return JsonValue::from_boolean(node);
                else if constexpr (std::is_same_v<Node, double>)
                    return JsonValue::from_number(node);
                else if constexpr (std::is_same_v<Node, std::string>)
                    return JsonValue::from_string(node);
                else if constexpr (std::is_same_v<Node, pal::CloneArray>) {
                    JsonValue::Array elements;
                    elements.reserve(node.elements.size());
                    for (const auto element : node.elements)
                        elements.push_back(read(reader, element));
                    return JsonValue::from_array(std::move(elements));
                } else if constexpr (std::is_same_v<Node, pal::CloneObject>) {
                    JsonValue::Object entries;
                    entries.reserve(node.properties.size());
                    for (const auto& [name, property] : node.properties)
                        entries.emplace_back(name, read(reader, property));
                    return JsonValue::from_object(std::move(entries));
                } else if constexpr (std::is_same_v<Node, pal::CloneBlob>)
                    return JsonValue::from_native(clone_read<Blob>(reader, id));
                else
                    throw pal::DataCloneError(
                        "A stored Map, Set, Date, buffer or view has no native dynamic value.");
            },
            reader.node(id));
    }
};

[[nodiscard]] inline JsonValue idb_read_value(const std::string& stored) {
    pal::CloneReader reader(pal::deserialize_from_storage(stored));
    return clone_read<JsonValue>(reader, reader.root());
}

// ── Keys ──────────────────────────────────────────────────────────────

/**
 * An IndexedDB key as bytes whose order is the keys' order: a number (`-0` is `0`, NaN is no key)
 * as a tag and the IEEE 754 bits made sortable, before a string as a tag and its UTF-16 code
 * units big-endian, compared unit by unit as IndexedDB compares strings.
 */
class IdbKey {
public:
    /** `value` as a key, or a DataError DOMException for what is not one. */
    [[nodiscard]] static std::string encode(const JsonValue& value) {
        std::string bytes;
        if (value.is_number() && !std::isnan(value.to_number())) {
            const double number = value.to_number() == 0 ? 0.0 : value.to_number();
            auto bits = std::bit_cast<std::uint64_t>(number);
            bits = bits >> 63 ? ~bits : bits | (std::uint64_t{1} << 63);
            bytes.push_back(kNumber);
            for (int shift = 56; shift >= 0; shift -= 8)
                bytes.push_back(static_cast<char>(bits >> shift));
            return bytes;
        }
        if (value.is_string()) {
            bytes.push_back(kString);
            for (const char16_t unit : string_code_units(value.string_value())) {
                bytes.push_back(static_cast<char>(unit >> 8));
                bytes.push_back(static_cast<char>(unit & 0xffu));
            }
            return bytes;
        }
        std::rethrow_exception(
            dom_exception_error("Native IndexedDB keys are numbers and strings.", "DataError"));
    }
    [[nodiscard]] static JsonValue decode(std::string_view bytes) {
        if (bytes.size() == 9 && bytes[0] == kNumber) {
            std::uint64_t bits = 0;
            for (std::size_t index = 1; index < 9; ++index)
                bits = bits << 8 | static_cast<unsigned char>(bytes[index]);
            bits = bits >> 63 ? bits & ~(std::uint64_t{1} << 63) : ~bits;
            return JsonValue::from_number(std::bit_cast<double>(bits));
        }
        if (!bytes.empty() && bytes[0] == kString && bytes.size() % 2 == 1) {
            std::u16string units;
            for (std::size_t index = 1; index < bytes.size(); index += 2)
                units.push_back(
                    static_cast<char16_t>(static_cast<unsigned char>(bytes[index]) << 8 |
                                          static_cast<unsigned char>(bytes[index + 1])));
            return JsonValue::from_string(string_from_code_units(units));
        }
        throw pal::DataCloneError("A stored IndexedDB key is malformed.");
    }

private:
    static constexpr char kNumber = 0x10;
    static constexpr char kString = 0x30;
};

namespace detail {

/** One database's committed version and stores, shared by every connection in the process. */
struct IdbDatabaseState {
    std::string name;
    std::uint64_t version = 0;
    std::vector<std::string> stores;
};

/** The process's databases, each read from its file on first open. */
[[nodiscard]] inline std::shared_ptr<IdbDatabaseState> idb_database(const std::string& name) {
    static std::mutex mutex;
    static std::map<std::string, std::shared_ptr<IdbDatabaseState>, std::less<>> databases;
    const std::scoped_lock lock(mutex);
    if (const auto found = databases.find(name); found != databases.end())
        return found->second;
    auto metadata = pal::open_indexed_db(name);
    auto state = std::make_shared<IdbDatabaseState>();
    state->name = name;
    state->version = metadata.version;
    state->stores = std::move(metadata.stores);
    std::ranges::sort(state->stores);
    return databases.emplace(name, std::move(state)).first->second;
}

[[nodiscard]] inline Error idb_error(std::string message, std::string name) {
    return Error(dom_exception_error(std::move(message), std::move(name)));
}

using IdbHandler = Callback<void()>;

/** Runs one event handler as its own callback, the microtask checkpoint after it; false if it threw. */
[[nodiscard]] inline bool idb_fire(const IdbHandler& handler) {
    if (!handler)
        return true;
    bool returned = false;
    pal::EventLoop::current().dispatch_callback([handler, &returned] {
        handler();
        returned = true;
    });
    return returned;
}

/** An `error` attribute: null until a failure sets one. */
[[nodiscard]] inline Nullable<Error> idb_error_attribute(const std::optional<Error>& error) {
    return error ? Nullable<Error>(*error) : Nullable<Error>();
}

/** A request's settled state and its two handlers. */
struct IdbRequestState {
    bool done = false;
    std::optional<Error> error;
    IdbHandler onsuccess, onerror;
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(error);
        visitor(onsuccess);
        visitor(onerror);
    }
};

/** A get, put, delete or openCursor request's state: its result once it settles. */
template <typename Result> struct IdbResultState : IdbRequestState {
    Result result{};
    void gc_trace(const TraceVisitor& visitor) const {
        IdbRequestState::gc_trace(visitor);
        visitor(result);
    }
};

/** What every request object shares over its state: `error`, the two handlers, identity. */
template <typename State> class IdbRequestHandle {
public:
    [[nodiscard]] Nullable<Error> error() const { return idb_error_attribute(state_->error); }
    void set_onsuccess(IdbHandler handler) const { state_->onsuccess = std::move(handler); }
    void set_onerror(IdbHandler handler) const { state_->onerror = std::move(handler); }
    [[nodiscard]] State& state() const { return *state_; }
    [[nodiscard]] std::weak_ptr<State> weak() const { return state_; }
    [[nodiscard]] const void* identity() const { return state_.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

protected:
    IdbRequestHandle() : state_(make_gc_shared<State>()) {}
    explicit IdbRequestHandle(std::shared_ptr<State> state) : state_(std::move(state)) {}

private:
    std::shared_ptr<State> state_;
};

struct IdbTransactionState;

struct IdbConnectionState {
    std::shared_ptr<IdbDatabaseState> database;
    bool closed = false;
    /** The open request's upgrade transaction while it runs: the one time stores are created. */
    std::shared_ptr<IdbTransactionState> upgrade;
};

struct IdbTransactionState {
    std::shared_ptr<IdbConnectionState> connection;
    std::vector<std::string> scope;
    bool writes = false;
    bool finished = false;
    /** The version an upgrade transaction commits. */
    std::optional<std::uint64_t> version;
    std::vector<std::string> created;
    /** The records this transaction wrote, by store and key; absent is a deletion. */
    pal::IndexedDbChanges::Records changes;
    std::deque<std::function<void()>> pending;
    std::optional<Error> error;
    IdbHandler oncomplete, onerror, onabort;
    /** Runs after a commit or an abort: an upgrade's open request settles there. */
    std::function<void(bool committed)> finished_callback;
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(error);
        visitor(oncomplete);
        visitor(onerror);
        visitor(onabort);
    }

    [[nodiscard]] const std::string& name() const { return connection->database->name; }
    void require_active() const {
        if (finished)
            std::rethrow_exception(
                dom_exception_error("The transaction has finished.", "TransactionInactiveError"));
    }
    void require_store(std::string_view store) const {
        if (std::ranges::find(scope, store) == scope.end())
            std::rethrow_exception(dom_exception_error(
                "No object store named '" + std::string(store) + "' in this transaction.",
                "NotFoundError"));
    }

    [[nodiscard]] std::optional<std::string> read(const std::string& store,
                                                  const std::string& key) const {
        if (const auto written = changes.find(store); written != changes.end())
            if (const auto found = written->second.find(key); found != written->second.end())
                return found->second;
        return pal::read_indexed_db(name(), store, key);
    }
    /** The first record after `after`: the stored one or this transaction's, whichever is first. */
    [[nodiscard]] std::optional<std::pair<std::string, std::string>>
    next(const std::string& store, std::optional<std::string> after) const {
        const auto written = changes.find(store);
        const auto* own = written == changes.end() ? nullptr : &written->second;
        for (;;) {
            auto stored = pal::next_indexed_db(name(), store, after);
            std::optional<std::pair<std::string, std::string>> mine;
            if (own)
                for (auto found = after ? own->upper_bound(*after) : own->begin();
                     found != own->end(); ++found)
                    if (found->second) {
                        mine.emplace(found->first, *found->second);
                        break;
                    }
            // A stored record this transaction deleted or rewrote yields to its own state.
            if (stored && own && own->contains(stored->first) &&
                (!mine || stored->first < mine->first)) {
                after = stored->first;
                continue;
            }
            if (!stored || (mine && mine->first <= stored->first))
                return mine;
            return stored;
        }
    }

    /** Queues `operation` after the transaction's other requests. */
    void enqueue(std::function<void()> operation) {
        require_active();
        pending.push_back(std::move(operation));
    }
    static void schedule(const std::shared_ptr<IdbTransactionState>& self) {
        pal::EventLoop::current().post([self] { step(self); });
    }
    /** Runs the next request in its own task, or commits once none is left. */
    static void step(const std::shared_ptr<IdbTransactionState>& self) {
        if (self->finished)
            return;
        if (self->pending.empty()) {
            commit(self);
            return;
        }
        auto operation = std::move(self->pending.front());
        self->pending.pop_front();
        operation();
        if (!self->finished)
            schedule(self);
    }
    static void commit(const std::shared_ptr<IdbTransactionState>& self) {
        auto& database = *self->connection->database;
        if (self->writes) {
            // The commit takes the writes and created stores: no request reads them after it,
            // and the connection's store names are the database's own from here on.
            pal::IndexedDbChanges committed;
            committed.version = self->version;
            committed.created_stores = std::exchange(self->created, {});
            committed.records = std::exchange(self->changes, {});
            try {
                pal::commit_indexed_db(database.name, committed);
            } catch (...) {
                abort(self, Error(std::current_exception()));
                return;
            }
            if (self->version)
                database.version = *self->version;
            database.stores.insert(database.stores.end(),
                                   std::make_move_iterator(committed.created_stores.begin()),
                                   std::make_move_iterator(committed.created_stores.end()));
            std::ranges::sort(database.stores);
        }
        self->finished = true;
        static_cast<void>(idb_fire(self->oncomplete));
        if (self->finished_callback)
            self->finished_callback(true);
    }
    static void abort(const std::shared_ptr<IdbTransactionState>& self, Error error) {
        if (self->finished)
            return;
        self->finished = true;
        self->pending.clear();
        self->changes.clear();
        self->error = std::move(error);
        static_cast<void>(idb_fire(self->onabort));
        if (self->finished_callback)
            self->finished_callback(false);
    }
    /** Settles `request` through `run`; a failure fires the error handlers and aborts. */
    template <typename State, typename Run>
    static void settle(const std::shared_ptr<IdbTransactionState>& self, State& state, Run run) {
        state.done = true;
        state.error.reset();
        try {
            run();
        } catch (...) {
            state.error = Error(std::current_exception());
            static_cast<void>(idb_fire(state.onerror));
            static_cast<void>(idb_fire(self->onerror));
            abort(self, *state.error);
            return;
        }
        if (!idb_fire(state.onsuccess))
            abort(self, idb_error("A request's success handler threw.", "AbortError"));
    }
};

struct IdbCursorState {
    std::shared_ptr<IdbTransactionState> transaction;
    std::string store;
    std::optional<std::string> key;
    JsonValue value;
    /** Queues the opening request's next settlement. */
    std::function<void()> advance;
    void gc_trace(const TraceVisitor& visitor) const { visitor(value); }
};

} // namespace detail

using IdbHandler = detail::IdbHandler;

/** `DOMStringList`: `objectStoreNames`, sorted as the standard sorts it. */
class DomStringList {
public:
    DomStringList() = default;
    explicit DomStringList(std::vector<std::string> names) : names_(std::move(names)) {}
    [[nodiscard]] bool contains(const std::string& name) const {
        return std::ranges::find(names_, name) != names_.end();
    }
    [[nodiscard]] double length() const { return static_cast<double>(names_.size()); }
    [[nodiscard]] Nullable<std::string> item(double index) const {
        if (!(index >= 0) || index >= static_cast<double>(names_.size()))
            return {};
        return Nullable<std::string>{names_[static_cast<std::size_t>(index)]};
    }

private:
    std::vector<std::string> names_;
};

/** A request object: its settled result type and its handlers. */
template <typename Result>
class IdbRequestOf : public detail::IdbRequestHandle<detail::IdbResultState<Result>> {
    using Handle = detail::IdbRequestHandle<detail::IdbResultState<Result>>;

public:
    IdbRequestOf() = default;
    explicit IdbRequestOf(std::shared_ptr<detail::IdbResultState<Result>> state)
        : Handle(std::move(state)) {}

    [[nodiscard]] Result result() const {
        const auto& state = this->state();
        if (!state.done)
            std::rethrow_exception(
                dom_exception_error("The request has not finished.", "InvalidStateError"));
        return state.result;
    }
};

/** `IDBCursorWithValue` over one store, in key order. */
class IdbCursor {
public:
    IdbCursor() = default;
    explicit IdbCursor(std::shared_ptr<detail::IdbCursorState> state) : state_(std::move(state)) {}
    [[nodiscard]] JsonValue value() const { return state_->value; }
    [[nodiscard]] JsonValue primary_key() const { return IdbKey::decode(*state_->key); }
    [[nodiscard]] JsonValue key() const { return primary_key(); }
    /** `cursor.continue()`: the opening request settles again at the next key, or with null. */
    void advance() const {
        state_->transaction->require_active();
        state_->advance();
    }
    [[nodiscard]] const void* identity() const { return state_.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

private:
    std::shared_ptr<detail::IdbCursorState> state_;
};

/** `IDBRequest` for get, put and delete: the read value, or the written key. */
using IdbRequest = IdbRequestOf<JsonValue>;
/** `IDBRequest` for openCursor: the cursor at a record, or null after the last. */
using IdbCursorRequest = IdbRequestOf<Nullable<IdbCursor>>;

/** `IDBObjectStore`, reached through its transaction. */
class IdbObjectStore {
public:
    IdbObjectStore() = default;
    IdbObjectStore(std::shared_ptr<detail::IdbTransactionState> transaction, std::string name)
        : transaction_(std::move(transaction)), name_(std::move(name)) {}

    [[nodiscard]] const std::string& name() const { return name_; }

    [[nodiscard]] IdbRequest get(const JsonValue& key) const {
        transaction_->require_active();
        return queue([key = IdbKey::encode(key)](auto& transaction, const std::string& store,
                                                 JsonValue& result) {
            const auto stored = transaction.read(store, key);
            result = stored ? idb_read_value(*stored) : JsonValue{};
        });
    }

    /** `store.put(value, key)`: the value's clone is taken now, as the call takes it. */
    template <typename T> [[nodiscard]] IdbRequest put(const T& value, const JsonValue& key) const {
        // A string literal or pointer is a string to the program.
        if constexpr (!std::is_class_v<T> && std::is_convertible_v<const T&, std::string_view>) {
            return put(std::string(value), key);
        } else {
            require_writes();
            auto stored = IdbKey::encode(key);
            pal::CloneWriter writer;
            const auto root = clone_write(writer, value);
            return queue([key = std::move(stored),
                          bytes = pal::serialize_for_storage(std::move(writer).finish(root))](
                             auto& transaction, const std::string& store, JsonValue& result) {
                transaction.changes[store].insert_or_assign(key, bytes);
                result = IdbKey::decode(key);
            });
        }
    }

    /** `store.delete(key)`. */
    [[nodiscard]] IdbRequest remove(const JsonValue& key) const {
        require_writes();
        return queue([key = IdbKey::encode(key)](auto& transaction, const std::string& store,
                                                 JsonValue& result) {
            transaction.changes[store].insert_or_assign(key, std::nullopt);
            result = JsonValue{};
        });
    }

    /** `store.openCursor()`: each record in key order, read live as the cursor advances. */
    [[nodiscard]] IdbCursorRequest open_cursor() const {
        IdbCursorRequest request;
        auto cursor = make_gc_shared<detail::IdbCursorState>();
        cursor->transaction = transaction_;
        cursor->store = name_;
        // A queued step holds its request, as a transaction holds its pending requests; the
        // cursor holds it weakly, since the request's result holds the cursor.
        const auto step = [](IdbCursorRequest request, std::weak_ptr<detail::IdbCursorState> weak) {
            return [request = std::move(request), weak = std::move(weak)] {
                const auto at = weak.lock();
                if (!at)
                    return;
                auto& transaction = at->transaction;
                detail::IdbTransactionState::settle(transaction, request.state(), [&] {
                    const auto next = transaction->next(at->store, at->key);
                    if (!next) {
                        request.state().result = Nullable<IdbCursor>();
                        return;
                    }
                    at->key = next->first;
                    at->value = idb_read_value(next->second);
                    request.state().result = Nullable<IdbCursor>(IdbCursor(at));
                });
            };
        };
        cursor->advance = [step, weak_request = request.weak(), weak = std::weak_ptr(cursor)] {
            const auto state = weak_request.lock();
            const auto at = weak.lock();
            if (!state || !at)
                return;
            state->done = false;
            at->transaction->enqueue(step(IdbCursorRequest(state), weak));
        };
        transaction_->enqueue(step(request, cursor));
        request.state().result = Nullable<IdbCursor>(IdbCursor(std::move(cursor)));
        return request;
    }

private:
    void require_writes() const {
        transaction_->require_active();
        if (!transaction_->writes)
            std::rethrow_exception(
                dom_exception_error("The transaction is read-only.", "ReadOnlyError"));
    }
    template <typename Run> [[nodiscard]] IdbRequest queue(Run run) const {
        IdbRequest request;
        transaction_->enqueue(
            [transaction = transaction_, request, store = name_, run = std::move(run)] {
                detail::IdbTransactionState::settle(transaction, request.state(), [&] {
                    run(*transaction, store, request.state().result);
                });
            });
        return request;
    }

public:
    void gc_trace(const TraceVisitor& visitor) const { visitor(transaction_); }

private:
    std::shared_ptr<detail::IdbTransactionState> transaction_;
    std::string name_;
};

/** `IDBTransaction`. */
class IdbTransaction {
public:
    IdbTransaction() = default;
    explicit IdbTransaction(std::shared_ptr<detail::IdbTransactionState> state)
        : state_(std::move(state)) {}
    [[nodiscard]] IdbObjectStore object_store(const std::string& name) const {
        state_->require_active();
        state_->require_store(name);
        return IdbObjectStore(state_, name);
    }
    [[nodiscard]] Nullable<Error> error() const {
        return detail::idb_error_attribute(state_->error);
    }
    void set_oncomplete(IdbHandler handler) const { state_->oncomplete = std::move(handler); }
    void set_onerror(IdbHandler handler) const { state_->onerror = std::move(handler); }
    void set_onabort(IdbHandler handler) const { state_->onabort = std::move(handler); }
    [[nodiscard]] const void* identity() const { return state_.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

private:
    std::shared_ptr<detail::IdbTransactionState> state_;
};

/** `IDBDatabase`: one connection. */
class IdbDatabase {
public:
    IdbDatabase() = default;
    explicit IdbDatabase(std::shared_ptr<detail::IdbConnectionState> state)
        : state_(std::move(state)) {}

    [[nodiscard]] const std::string& name() const { return state_->database->name; }
    [[nodiscard]] double version() const {
        const auto& upgrade = state_->upgrade;
        return static_cast<double>(upgrade ? *upgrade->version : state_->database->version);
    }
    [[nodiscard]] DomStringList object_store_names() const {
        auto names = state_->database->stores;
        if (const auto& upgrade = state_->upgrade)
            names.insert(names.end(), upgrade->created.begin(), upgrade->created.end());
        std::ranges::sort(names);
        return DomStringList(std::move(names));
    }
    /**
     * `db.createObjectStore(name)`, only while `upgradeneeded` runs: `put` gives the keys. The
     * store belongs to the upgrade transaction, which can already write it.
     */
    IdbObjectStore create_object_store(const std::string& name) const {
        const auto& upgrade = state_->upgrade;
        if (!upgrade || upgrade->finished)
            std::rethrow_exception(
                dom_exception_error("Object stores are created only while the database upgrades.",
                                    "InvalidStateError"));
        if (std::ranges::find(upgrade->scope, name) != upgrade->scope.end())
            std::rethrow_exception(dom_exception_error(
                "An object store named '" + name + "' already exists.", "ConstraintError"));
        upgrade->created.push_back(name);
        upgrade->scope.push_back(name);
        return IdbObjectStore(upgrade, name);
    }
    [[nodiscard]] IdbTransaction transaction(const bbl::js::Array<std::string>& names,
                                             const std::string& mode = "readonly") const {
        return transaction(std::vector<std::string>(names.begin(), names.end()), mode);
    }
    /** `db.transaction(stores, mode)` over one store name or a list of them. */
    [[nodiscard]] IdbTransaction transaction(const std::vector<std::string>& names,
                                             const std::string& mode = "readonly") const {
        if (state_->closed)
            std::rethrow_exception(
                dom_exception_error("The connection is closed.", "InvalidStateError"));
        if (state_->upgrade)
            std::rethrow_exception(dom_exception_error(
                "A transaction cannot start while the database upgrades.", "InvalidStateError"));
        if (mode != "readonly" && mode != "readwrite")
            throw NamedError("TypeError", "The transaction mode '" + mode + "' is not valid.");
        if (names.empty())
            std::rethrow_exception(dom_exception_error(
                "A transaction needs at least one object store.", "InvalidAccessError"));
        auto state = make_gc_shared<detail::IdbTransactionState>();
        state->connection = state_;
        state->writes = mode == "readwrite";
        const auto& stores = state_->database->stores;
        for (const auto& name : names) {
            if (std::ranges::find(stores, name) == stores.end())
                std::rethrow_exception(
                    dom_exception_error("No object store named '" + name + "'.", "NotFoundError"));
            state->scope.push_back(name);
        }
        // The transaction starts once the task creating it ends: an empty one commits then.
        detail::IdbTransactionState::schedule(state);
        return IdbTransaction(std::move(state));
    }
    [[nodiscard]] IdbTransaction transaction(const std::string& name,
                                             const std::string& mode = "readonly") const {
        return transaction(std::vector<std::string>{name}, mode);
    }
    void close() const { state_->closed = true; }
    [[nodiscard]] const void* identity() const { return state_.get(); }

private:
    std::shared_ptr<detail::IdbConnectionState> state_;
};

namespace detail {

/** An open request's state: the connection, from `upgradeneeded` on, and two more handlers. */
struct IdbOpenState : IdbRequestState {
    std::optional<IdbDatabase> result;
    IdbHandler onupgradeneeded, onblocked;
    void gc_trace(const TraceVisitor& visitor) const {
        IdbRequestState::gc_trace(visitor);
        visitor(onupgradeneeded);
        visitor(onblocked);
    }
};

} // namespace detail

/** `IDBOpenDBRequest`: its result is the connection, from the time `upgradeneeded` fires. */
class IdbOpenRequest : public detail::IdbRequestHandle<detail::IdbOpenState> {
public:
    IdbOpenRequest() = default;
    [[nodiscard]] IdbDatabase result() const {
        if (!state().result)
            std::rethrow_exception(
                dom_exception_error("The request has not finished.", "InvalidStateError"));
        return *state().result;
    }
    void set_onupgradeneeded(IdbHandler handler) const {
        state().onupgradeneeded = std::move(handler);
    }
    void set_onblocked(IdbHandler handler) const { state().onblocked = std::move(handler); }
};

/** `indexedDB`. */
struct IdbFactory {
    /**
     * `indexedDB.open(name, version)`. In a later task: a higher version than the stored one
     * fires `upgradeneeded` inside an upgrade transaction whose commit fires `success`; a lower
     * one fires `error` (VersionError). Without a version the database opens at its own, a new
     * one at version 1.
     */
    [[nodiscard]] IdbOpenRequest open(const std::string& name,
                                      std::optional<double> version = std::nullopt) const {
        if (version &&
            (!(*version >= 1) || *version != std::floor(*version) || *version > 9007199254740991.0))
            throw NamedError("TypeError", "An IndexedDB version is a positive integer.");
        IdbOpenRequest request;
        pal::EventLoop::current().post(
            [request, name, version] { run_open(request, name, version); });
        return request;
    }

private:
    static void run_open(const IdbOpenRequest& request, const std::string& name,
                         std::optional<double> version) {
        auto& state = request.state();
        const auto fail = [&state](Error error) {
            state.done = true;
            state.result.reset();
            state.error = std::move(error);
            static_cast<void>(detail::idb_fire(state.onerror));
        };
        std::shared_ptr<detail::IdbDatabaseState> database;
        try {
            database = detail::idb_database(name);
        } catch (...) {
            fail(Error(std::current_exception()));
            return;
        }
        const std::uint64_t requested = version ? static_cast<std::uint64_t>(*version)
                                                : std::max<std::uint64_t>(database->version, 1);
        if (requested < database->version) {
            fail(detail::idb_error("The requested version is lower than the database's.",
                                   "VersionError"));
            return;
        }
        auto connection = std::make_shared<detail::IdbConnectionState>();
        connection->database = database;
        state.result = IdbDatabase(connection);
        if (requested == database->version) {
            state.done = true;
            static_cast<void>(detail::idb_fire(state.onsuccess));
            return;
        }
        auto upgrade = make_gc_shared<detail::IdbTransactionState>();
        upgrade->connection = connection;
        upgrade->writes = true;
        upgrade->version = requested;
        upgrade->scope = database->stores;
        connection->upgrade = upgrade;
        upgrade->finished_callback = [request, connection](bool committed) {
            auto& settled = request.state();
            connection->upgrade.reset();
            settled.done = true;
            if (committed) {
                static_cast<void>(detail::idb_fire(settled.onsuccess));
                return;
            }
            settled.result.reset();
            settled.error = detail::idb_error("The database upgrade was aborted.", "AbortError");
            static_cast<void>(detail::idb_fire(settled.onerror));
        };
        state.done = true;
        if (!detail::idb_fire(state.onupgradeneeded)) {
            detail::IdbTransactionState::abort(
                upgrade, detail::idb_error("The upgrade handler threw.", "AbortError"));
            return;
        }
        state.done = false;
        detail::IdbTransactionState::schedule(upgrade);
    }
};

} // namespace bbl::js
