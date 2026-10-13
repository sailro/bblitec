#pragma once

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/pal_fetch_response.hpp>
#include <bblite/pal_native_job.hpp>
#include <bblite/pal_packaged_responses.hpp>
#include <array>

namespace bbl::pal {

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
