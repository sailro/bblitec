#pragma once

// IndexedDB's platform half (pal_indexed_db.cpp): each database is one SQLite file under the
// PAL's per-user storage root, as the browsers keep theirs. Records are (store, key, value) rows;
// a key's bytes order as IndexedDB orders keys (js_indexed_db.hpp `IdbKey`), so SQLite's own
// BLOB order is the cursor order. A committed transaction's changes are one SQLite transaction:
// a failure throws and leaves the file as it was.

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pal {

struct IndexedDbMetadata {
    std::uint64_t version = 0;
    std::vector<std::string> stores;
};

/** One committed transaction: a new version, the stores it creates, the records it changes. */
struct IndexedDbChanges {
    /** Each store's changed records by key: the stored clone, or absent for a deletion. */
    using Records =
        std::map<std::string, std::map<std::string, std::optional<std::string>>, std::less<>>;
    std::optional<std::uint64_t> version;
    std::vector<std::string> created_stores;
    Records records;
};

/** The database `name`'s version and stores; a database never opened is version 0. */
IndexedDbMetadata open_indexed_db(const std::string& name);
/** The value stored under `key` in `store`. */
std::optional<std::string> read_indexed_db(const std::string& name, const std::string& store,
                                           const std::string& key);
/** The first record of `store` whose key orders after `after` (or the first one). */
std::optional<std::pair<std::string, std::string>>
next_indexed_db(const std::string& name, const std::string& store,
                const std::optional<std::string>& after);
void commit_indexed_db(const std::string& name, const IndexedDbChanges& changes);

} // namespace bbl::pal
