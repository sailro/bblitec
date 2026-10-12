#pragma once

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/pal_fetch_response.hpp>
#include <bblite/pal_native_job.hpp>
#include <array>

namespace bbl::pal {

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

template <std::size_t Count>
js::Promise<HttpResponse> fetch_packaged(const std::string& key,
                                         const std::array<PackagedFetchEntry, Count>& entries) {
    try {
        for (const auto& entry : entries)
            if (entry.key == key)
                return fetch_packaged(std::string(entry.url),
                                      bbl::asset_path(std::string(entry.output)));
        throw std::runtime_error("Unknown packaged asset: " + key);
    } catch (...) {
        return js::Promise<HttpResponse>::rejected(std::current_exception());
    }
}

} // namespace bbl::pal
