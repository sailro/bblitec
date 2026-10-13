#pragma once

/**
 * Packaged responses by URL: what a fetch from library code receives for a
 * URL the program packaged. Generation registers each call site's packaged
 * candidates (absolute URLs, fragment removed) with the deployment base; the
 * web platform's `fetch` consults the realm's table before HTTP, resolving a
 * relative request against that base.
 */

#include <bblite/js_url.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_fetch_response.hpp>
#include <bblite/pal_native_job.hpp>

#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace bbl::pal {

/** A native job reads the selected file; a read failure rejects the response promise. */
inline js::Promise<HttpResponse> fetch_packaged(std::string url, std::string path) {
    return run_native_job<HttpResponse>([path = std::move(path)] { return read_binary_file(path); },
                                        [url = std::move(url)](std::vector<std::uint8_t> body) {
                                            return make_buffered_response(200, url,
                                                                          std::move(body));
                                        });
}

struct PackagedResponses {
    /** The deployment URL relative requests resolve against. */
    std::string base;
    /** The packaged file's path (`asset_path` of its output) by absolute URL. */
    std::unordered_map<std::string, std::string> outputs;
};

/** The realm's table. */
[[nodiscard]] inline PackagedResponses& packaged_responses() {
    thread_local PackagedResponses table;
    return table;
}

/** `url` resolved against `base`, its fragment removed (a fetch never sends one). */
[[nodiscard]] inline std::string packaged_response_key(std::string_view url,
                                                       std::string_view base) {
    std::string href = js::Url(url, base).href();
    if (const auto hash = href.find('#'); hash != std::string::npos)
        href.erase(hash);
    return href;
}

/** Register a call site's packaged candidates, `{url, file path}` each. */
inline void register_packaged_responses(
    std::string_view base,
    std::initializer_list<std::pair<std::string_view, std::string_view>> entries) {
    auto& table = packaged_responses();
    table.base = std::string(base);
    for (const auto& [url, path] : entries)
        table.outputs.insert_or_assign(packaged_response_key(url, base), std::string(path));
}

/** A packaged response: the absolute URL it answers as, and the file it reads. */
struct PackagedResponse {
    std::string url;
    std::string path;
};

/** What the program packaged for `url`; nothing when it packaged none or `url` does not parse. */
[[nodiscard]] inline std::optional<PackagedResponse> packaged_response(const std::string& url) {
    const auto& table = packaged_responses();
    if (table.outputs.empty())
        return std::nullopt;
    std::string key;
    try {
        key = packaged_response_key(url, table.base);
    } catch (const js::NamedError&) {
        // A URL that does not parse selects nothing; a fetch leaves it to HTTP to reject.
        return std::nullopt;
    }
    const auto found = table.outputs.find(key);
    if (found == table.outputs.end())
        return std::nullopt;
    return PackagedResponse{std::move(key), found->second};
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
