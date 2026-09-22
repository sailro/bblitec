#pragma once

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/pal_fetch_response.hpp>
#include <array>

namespace bbl::pal {

struct PackagedFetchEntry {
    std::string_view key;
    std::string_view url;
    std::string_view output;
};

/** Snapshot the selection before yielding; file failures reject the response promise. */
inline js::Promise<HttpResponse> fetch_packaged(std::string url, std::string path) {
    js::Promise<HttpResponse> result;
    EventLoop::current().post([result, url = std::move(url), path = std::move(path)] {
        try {
            result.resolve(js::make_ref<HttpResponseData>(
                HttpResponseData{200, url, read_binary_file(path), false}));
        } catch (...) {
            result.reject(std::current_exception());
        }
    });
    return result;
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
