#pragma once

/**
 * Packaged responses by URL: what a fetch from library code receives for a
 * URL the program packaged. Generation resolves each candidate's absolute,
 * fragment-free URL and emits one constant table per candidate set, which a
 * call site registers with its realm once; the web platform's `fetch`
 * consults the realm's tables before HTTP, resolving a relative request
 * against the deployment base.
 */

#include <bblite/js_url.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_fetch_response.hpp>
#include <bblite/pal_native_job.hpp>

#include <algorithm>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pal {

/**
 * One packaged candidate: the key a site selects it by, the absolute URL a
 * fetch of it answers as (fragment removed), and the asset output it reads.
 */
struct PackagedFetchEntry {
    std::string_view key;
    std::string_view url;
    std::string_view output;
};

/** A native job reads the selected file; a read failure rejects the response promise. */
inline js::Promise<HttpResponse> fetch_packaged(std::string url, std::string path) {
    return run_native_job<HttpResponse>([path = std::move(path)] { return read_binary_file(path); },
                                        [url = std::move(url)](std::vector<std::uint8_t> body) {
                                            return make_buffered_response(200, url,
                                                                          std::move(body));
                                        });
}

/** The program's asset path of an entry's output (`bbl::asset_path`). */
using PackagedAssetPath = std::string (*)(const std::string& output);

struct PackagedResponses {
    /** The deployment URL relative requests resolve against. */
    std::string base;
    PackagedAssetPath asset_path = nullptr;
    /** The registered sites' constant tables. */
    std::vector<std::span<const PackagedFetchEntry>> tables;
};

/** The realm's tables. */
[[nodiscard]] inline PackagedResponses& packaged_responses() {
    thread_local PackagedResponses realm;
    return realm;
}

/**
 * Register a site's constant table with the realm; a site's guard calls this
 * once per realm, and a table two sites share is kept once.
 */
inline bool register_packaged_responses(std::string_view base, PackagedAssetPath asset_path,
                                        std::span<const PackagedFetchEntry> entries) {
    auto& realm = packaged_responses();
    realm.base = std::string(base);
    realm.asset_path = asset_path;
    if (std::ranges::none_of(realm.tables,
                             [&](const auto& table) { return table.data() == entries.data(); }))
        realm.tables.push_back(entries);
    return true;
}

/** `url` resolved against `base`, its fragment removed (a fetch never sends one). */
[[nodiscard]] inline std::string packaged_response_key(std::string_view url,
                                                       std::string_view base) {
    std::string href = js::Url(url, base).href();
    if (const auto hash = href.find('#'); hash != std::string::npos)
        href.erase(hash);
    return href;
}

/** A packaged response: the absolute URL it answers as, and the file it reads. */
struct PackagedResponse {
    std::string url;
    std::string path;
};

/** What the program packaged for `url`; nothing when it packaged none or `url` does not parse. */
[[nodiscard]] inline std::optional<PackagedResponse> packaged_response(const std::string& url) {
    const auto& realm = packaged_responses();
    if (realm.tables.empty())
        return std::nullopt;
    std::string key;
    try {
        key = packaged_response_key(url, realm.base);
    } catch (const js::NamedError&) {
        // A URL that does not parse selects nothing; a fetch leaves it to HTTP to reject.
        return std::nullopt;
    }
    for (const auto& table : realm.tables)
        for (const auto& entry : table)
            if (entry.url == key)
                return PackagedResponse{std::move(key),
                                        realm.asset_path(std::string(entry.output))};
    return std::nullopt;
}

/** The packaged response for `url`, or nothing when the program packaged none. */
[[nodiscard]] inline std::optional<js::Promise<HttpResponse>>
fetch_registered_packaged(const std::string& url) {
    auto packaged = packaged_response(url);
    if (!packaged)
        return std::nullopt;
    return fetch_packaged(std::move(packaged->url), std::move(packaged->path));
}

} // namespace bbl::pal
