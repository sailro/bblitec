// IndexedDB's platform half: one SQLite database per IndexedDB database, under the per-user
// storage root's `indexeddb` directory, as the browsers keep theirs (Firefox and WebKit always,
// Chromium since its SQLite backing store). Compiled only into a program that reaches it
// (`storage:indexeddb`), so every other executable links no SQLite.
//
// A record is a (store, key, value) row: the key is the order-preserving byte form
// js_indexed_db.hpp encodes, so SQLite's memcmp BLOB order is IndexedDB's key order, and the value
// is a stored structured clone. A commit is one SQLite transaction; a failure rolls it back and
// throws, leaving the file as it was.

#include <bblite/pal.hpp>
#include <bblite/pal_indexed_db.hpp>

#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

#include <sqlite3.h>

#include "pal_storage_root.hpp"

namespace bbl::pal {

namespace {

/** The layout this file writes; a database another layout wrote refuses rather than misreads. */
constexpr int kSchemaVersion = 1;

constexpr std::string_view kSchema = R"sql(
CREATE TABLE IF NOT EXISTS database (version INTEGER NOT NULL);
INSERT INTO database (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM database);
CREATE TABLE IF NOT EXISTS stores (name TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS records (
    store TEXT NOT NULL,
    key BLOB NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (store, key)
) WITHOUT ROWID;
)sql";

// The statements a connection runs per request or commit, each prepared once and kept with it.
constexpr std::string_view kRead = "SELECT value FROM records WHERE store = ?1 AND key = ?2";
constexpr std::string_view kFirst =
    "SELECT key, value FROM records WHERE store = ?1 ORDER BY key LIMIT 1";
constexpr std::string_view kNext =
    "SELECT key, value FROM records WHERE store = ?1 AND key > ?2 ORDER BY key LIMIT 1";
constexpr std::string_view kPut =
    "INSERT OR REPLACE INTO records (store, key, value) VALUES (?1, ?2, ?3)";
constexpr std::string_view kDelete = "DELETE FROM records WHERE store = ?1 AND key = ?2";
constexpr std::string_view kCreateStore = "INSERT INTO stores (name) VALUES (?1)";
constexpr std::string_view kSetVersion = "UPDATE database SET version = ?1";

[[noreturn]] void refuse(std::string_view operation, std::string_view reason) {
    throw std::runtime_error("IndexedDB storage could not " + std::string(operation) + ": " +
                             std::string(reason) + ".");
}

[[noreturn]] void fail(sqlite3* database, std::string_view operation) {
    refuse(operation, database ? sqlite3_errmsg(database) : "out of memory");
}

class Statement {
public:
    /** A `kept` statement serves many uses, which SQLITE_PREPARE_PERSISTENT tells SQLite. */
    Statement(sqlite3* database, std::string_view sql, bool kept = false) : database_(database) {
        const auto flags = static_cast<unsigned>(kept ? SQLITE_PREPARE_PERSISTENT : 0);
        if (sqlite3_prepare_v3(database, sql.data(), static_cast<int>(sql.size()), flags,
                               &statement_, nullptr) != SQLITE_OK)
            fail(database, "prepare a statement");
    }
    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;
    ~Statement() { sqlite3_finalize(statement_); }

    Statement& bind(int index, std::string_view text) {
        check(sqlite3_bind_text(statement_, index, text.data(), static_cast<int>(text.size()),
                                SQLITE_TRANSIENT));
        return *this;
    }
    Statement& bind_blob(int index, std::string_view bytes) {
        check(sqlite3_bind_blob(statement_, index, bytes.data(), static_cast<int>(bytes.size()),
                                SQLITE_TRANSIENT));
        return *this;
    }
    Statement& bind(int index, std::int64_t value) {
        check(sqlite3_bind_int64(statement_, index, value));
        return *this;
    }
    /** Steps once: true while a row is available. */
    bool step() {
        const int result = sqlite3_step(statement_);
        if (result == SQLITE_ROW)
            return true;
        if (result != SQLITE_DONE)
            fail(database_, "run a statement");
        return false;
    }
    /** Runs a statement that yields no row, then readies it for its next bindings. */
    void run() {
        step();
        reset();
    }
    /** Releases what the statement read and the values bound to it. */
    void reset() {
        sqlite3_reset(statement_);
        sqlite3_clear_bindings(statement_);
    }
    [[nodiscard]] std::string column_bytes(int index) const {
        const auto* data = static_cast<const char*>(sqlite3_column_blob(statement_, index));
        return std::string(data ? data : "",
                           static_cast<std::size_t>(sqlite3_column_bytes(statement_, index)));
    }
    [[nodiscard]] std::string column_text(int index) const {
        const auto* data = reinterpret_cast<const char*>(sqlite3_column_text(statement_, index));
        return std::string(data ? data : "",
                           static_cast<std::size_t>(sqlite3_column_bytes(statement_, index)));
    }
    [[nodiscard]] std::int64_t column_int(int index) const {
        return sqlite3_column_int64(statement_, index);
    }

private:
    void check(int result) const {
        if (result != SQLITE_OK)
            fail(database_, "bind a statement parameter");
    }
    sqlite3* database_;
    sqlite3_stmt* statement_ = nullptr;
};

/** A kept statement borrowed for one use, reset when the use ends so no read stays open. */
class StatementUse {
public:
    explicit StatementUse(Statement& statement) : statement_(statement) {}
    StatementUse(const StatementUse&) = delete;
    StatementUse& operator=(const StatementUse&) = delete;
    ~StatementUse() { statement_.reset(); }
    Statement* operator->() const { return &statement_; }

private:
    Statement& statement_;
};

void execute(sqlite3* database, std::string_view sql, std::string_view operation) {
    char* message = nullptr;
    if (sqlite3_exec(database, std::string(sql).c_str(), nullptr, nullptr, &message) == SQLITE_OK)
        return;
    const std::string reason = message ? message : sqlite3_errmsg(database);
    sqlite3_free(message);
    refuse(operation, reason);
}

struct CloseDatabase {
    void operator()(sqlite3* database) const { sqlite3_close(database); }
};

/** One database file's connection, and the statements it keeps for the process. */
class Connection {
public:
    explicit Connection(const std::filesystem::path& path) {
        const auto utf8 = path.u8string();
        sqlite3* opened = nullptr;
        const int result = sqlite3_open_v2(
            reinterpret_cast<const char*>(utf8.c_str()), &opened,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr);
        database_.reset(opened);
        if (result != SQLITE_OK)
            fail(opened, "open its database file");
        const auto stored = [opened] {
            Statement schema_version(opened, "PRAGMA user_version");
            schema_version.step();
            return schema_version.column_int(0);
        }();
        if (stored != 0 && stored != kSchemaVersion)
            throw std::runtime_error("An IndexedDB database file has an unknown layout.");
        execute(opened, kSchema, "create its tables");
        execute(opened, "PRAGMA user_version = " + std::to_string(kSchemaVersion),
                "mark its layout");
    }

    [[nodiscard]] sqlite3* database() const { return database_.get(); }
    /** `sql`, prepared on its first use and kept, for one use at a time. */
    [[nodiscard]] StatementUse use(std::string_view sql) {
        return StatementUse(statements_.try_emplace(sql, database(), sql, true).first->second);
    }

private:
    std::unique_ptr<sqlite3, CloseDatabase> database_;
    // Declared after the database, so each kept statement is finalized before it closes.
    std::map<std::string_view, Statement, std::less<>> statements_;
};

/** Connections by database name, opened on first use and kept for the process. */
struct Connections {
    std::mutex mutex;
    std::map<std::string, Connection, std::less<>> open;
};

Connections& connections() {
    static Connections instance;
    return instance;
}

/** The open connection to `name`'s file; the caller holds `connections().mutex`. */
Connection& connection(const std::string& name) {
    auto& all = connections().open;
    if (const auto found = all.find(name); found != all.end())
        return found->second;
    const auto path = detail::storage_directory("indexeddb", "IndexedDB") /
                      (detail::encode_storage_name(name, "An IndexedDB database name") + ".sqlite");
    return all.try_emplace(name, path).first->second;
}

} // namespace

IndexedDbMetadata open_indexed_db(const std::string& name) {
    require_runtime_execution("external storage input");
    const std::scoped_lock lock(connections().mutex);
    auto* database = connection(name).database();
    IndexedDbMetadata metadata;
    Statement version(database, "SELECT version FROM database");
    if (version.step())
        metadata.version = static_cast<std::uint64_t>(version.column_int(0));
    Statement stores(database, "SELECT name FROM stores ORDER BY name");
    while (stores.step())
        metadata.stores.push_back(stores.column_text(0));
    return metadata;
}

std::optional<std::string> read_indexed_db(const std::string& name, const std::string& store,
                                           const std::string& key) {
    require_runtime_execution("external storage input");
    const std::scoped_lock lock(connections().mutex);
    const auto read = connection(name).use(kRead);
    read->bind(1, store).bind_blob(2, key);
    if (!read->step())
        return std::nullopt;
    return read->column_bytes(0);
}

std::optional<std::pair<std::string, std::string>>
next_indexed_db(const std::string& name, const std::string& store,
                const std::optional<std::string>& after) {
    require_runtime_execution("external storage input");
    const std::scoped_lock lock(connections().mutex);
    const auto next = connection(name).use(after ? kNext : kFirst);
    next->bind(1, store);
    if (after)
        next->bind_blob(2, *after);
    if (!next->step())
        return std::nullopt;
    return std::pair{next->column_bytes(0), next->column_bytes(1)};
}

void commit_indexed_db(const std::string& name, const IndexedDbChanges& changes) {
    require_runtime_execution("external storage output");
    const std::scoped_lock lock(connections().mutex);
    auto& opened = connection(name);
    auto* database = opened.database();
    execute(database, "BEGIN IMMEDIATE", "begin a transaction");
    try {
        if (changes.version)
            opened.use(kSetVersion)->bind(1, static_cast<std::int64_t>(*changes.version)).run();
        if (!changes.created_stores.empty()) {
            const auto create = opened.use(kCreateStore);
            for (const auto& store : changes.created_stores)
                create->bind(1, store).run();
        }
        const auto put = opened.use(kPut);
        const auto remove = opened.use(kDelete);
        for (const auto& [store, records] : changes.records)
            for (const auto& [key, value] : records)
                if (value)
                    put->bind(1, store).bind_blob(2, key).bind_blob(3, *value).run();
                else
                    remove->bind(1, store).bind_blob(2, key).run();
        execute(database, "COMMIT", "commit a transaction");
    } catch (...) {
        sqlite3_exec(database, "ROLLBACK", nullptr, nullptr, nullptr);
        throw;
    }
}

} // namespace bbl::pal
