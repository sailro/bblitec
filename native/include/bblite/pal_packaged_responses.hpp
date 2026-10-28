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
#include <bblite/pal_http.hpp>
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

/** The inclusive byte span one satisfiable `Range` selects; none for an unsatisfiable one. */
struct PackagedRange {
    std::optional<std::pair<std::size_t, std::size_t>> span;
};

/**
 * `Range` over a `size`-byte file, as a static file server reads it: one `bytes=first-last`,
 * `bytes=first-` or `bytes=-suffix` range, its last byte clamped to the file; nothing (the whole
 * file) for no header, another unit, several ranges or a malformed one.
 */
[[nodiscard]] inline std::optional<PackagedRange> packaged_range(std::string_view header,
                                                                 std::size_t size) {
    constexpr std::string_view unit = "bytes=";
    if (!header.starts_with(unit) || header.find(',') != std::string_view::npos)
        return std::nullopt;
    const auto spec = header.substr(unit.size());
    const auto dash = spec.find('-');
    if (dash == std::string_view::npos)
        return std::nullopt;
    const auto number = [](std::string_view digits) -> std::optional<std::size_t> {
        if (digits.empty() || digits.size() > 15 ||
            digits.find_first_not_of("0123456789") != std::string_view::npos)
            return std::nullopt;
        return static_cast<std::size_t>(std::stoull(std::string(digits)));
    };
    const auto first = spec.substr(0, dash);
    const auto last = spec.substr(dash + 1);
    if (first.empty()) {
        const auto suffix = number(last);
        if (!suffix)
            return std::nullopt;
        if (*suffix == 0 || size == 0)
            return PackagedRange{};
        return PackagedRange{std::pair{size - std::min(*suffix, size), size - 1}};
    }
    const auto start = number(first);
    const auto end = last.empty() ? std::optional<std::size_t>(size - 1) : number(last);
    if (!start || !end || *end < *start)
        return std::nullopt;
    if (*start >= size)
        return PackagedRange{};
    return PackagedRange{std::pair{*start, std::min(*end, size - 1)}};
}

/**
 * A native job reads the selected file; a read failure rejects the response promise. A `range`
 * (`Range` header) the file satisfies answers 206 with its bytes and `Content-Range`, one it
 * cannot 416; without one, or with one a static file server ignores, the whole file answers 200.
 */
inline js::Promise<HttpResponse> fetch_packaged(std::string url, std::string path,
                                                std::string range = {}) {
    return run_native_job<HttpResponse>(
        [path = std::move(path)] { return read_binary_file(path); },
        [url = std::move(url), range = std::move(range)](std::vector<std::uint8_t> body) {
            const auto size = body.size();
            const auto selected = range.empty() ? std::nullopt : packaged_range(range, size);
            if (!selected)
                return make_buffered_response(200, url, std::move(body));
            auto headers = std::make_shared<HttpHeaderList>();
            if (!selected->span) {
                headers->entries.emplace_back("content-range", "bytes */" + std::to_string(size));
                return make_buffered_response(416, url, {}, HttpHeaders(std::move(headers)));
            }
            const auto [first, last] = *selected->span;
            headers->entries.emplace_back("content-range", "bytes " + std::to_string(first) + "-" +
                                                               std::to_string(last) + "/" +
                                                               std::to_string(size));
            headers->entries.emplace_back("content-length", std::to_string(last - first + 1));
            return make_buffered_response(
                206, url,
                std::vector<std::uint8_t>(body.begin() + static_cast<std::ptrdiff_t>(first),
                                          body.begin() + static_cast<std::ptrdiff_t>(last) + 1),
                HttpHeaders(std::move(headers)));
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

/** The packaged response for a URL (defined below). */
[[nodiscard]] inline std::optional<js::Promise<HttpResponse>>
fetch_registered_packaged(const std::string& url, std::string range = {});

/**
 * Register a site's constant table with the realm; a site's guard calls this
 * once per realm, and a table two sites share is kept once.
 */
inline bool register_packaged_responses(std::string_view base, PackagedAssetPath asset_path,
                                        std::span<const PackagedFetchEntry> entries) {
    auto& realm = packaged_responses();
    realm.base = std::string(base);
    realm.asset_path = asset_path;
    packaged_fetch = [](const std::string& url, std::string range) {
        return fetch_registered_packaged(url, std::move(range));
    };
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

/**
 * The packaged response for `url` (its `range` as `fetch_packaged` answers it), or nothing when
 * the program packaged none.
 */
[[nodiscard]] inline std::optional<js::Promise<HttpResponse>>
fetch_registered_packaged(const std::string& url, std::string range) {
    auto packaged = packaged_response(url);
    if (!packaged)
        return std::nullopt;
    return fetch_packaged(std::move(packaged->url), std::move(packaged->path), std::move(range));
}

} // namespace bbl::pal
