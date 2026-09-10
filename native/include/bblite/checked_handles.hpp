#pragma once

#include <cstddef>
#if defined(BBLITE_CHECKED_HANDLES) && BBLITE_CHECKED_HANDLES
#include <source_location>
#include <stdexcept>
#include <string>
#endif

namespace bbl {

template <typename Records, typename Handle>
decltype(auto) handle_at(Records& records, Handle handle
#if defined(BBLITE_CHECKED_HANDLES) && BBLITE_CHECKED_HANDLES
    , const std::source_location& site = std::source_location::current()
#endif
) {
    const auto index = static_cast<std::size_t>(handle.value);
#if defined(BBLITE_CHECKED_HANDLES) && BBLITE_CHECKED_HANDLES
    if (index >= records.size()) {
        throw std::out_of_range("Native handle " + std::to_string(index) +
            " exceeds record count " + std::to_string(records.size()) +
            " at " + site.file_name() + ":" + std::to_string(site.line()));
    }
#endif
    return records[index];
}

} // namespace bbl
