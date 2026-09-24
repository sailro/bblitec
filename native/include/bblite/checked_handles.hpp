#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#if BBLITE_CHECKED_HANDLES
#include <source_location>
#endif

namespace bbl {

#if BBLITE_CHECKED_HANDLES
using HandleSite = std::source_location;
[[nodiscard]] inline std::string handle_site_suffix(const HandleSite& site) {
    return std::string(" at ") + site.file_name() + ":" + std::to_string(site.line());
}
#else
/** Without BBLITE_CHECKED_HANDLES a refusal does not name its call site. */
struct HandleSite {};
[[nodiscard]] inline std::string handle_site_suffix(const HandleSite&) { return {}; }
#endif

[[noreturn]] inline void refuse_handle_index(std::size_t index, std::size_t count,
                                             const HandleSite& site) {
    throw std::out_of_range("Native handle " + std::to_string(index) + " exceeds record count " +
                            std::to_string(count) + handle_site_suffix(site));
}

[[noreturn]] inline void refuse_retired_mesh_handle(std::size_t index,
                                                    std::uint32_t handle_generation,
                                                    std::uint32_t slot_generation,
                                                    const HandleSite& site) {
    throw std::out_of_range("mesh handle refers to a retired mesh: slot " + std::to_string(index) +
                            " was issued at generation " + std::to_string(handle_generation) +
                            " and now holds a later mesh at generation " +
                            std::to_string(slot_generation) + handle_site_suffix(site));
}

/**
 * `records[handle.value]`, refused in every build when the handle names no
 * record: an index past the table, or -- for a handle type whose records
 * carry a slot generation (`MeshHandle`) -- a handle issued for a retired
 * mesh whose slot a later mesh now holds. JavaScript would still reach the
 * retired object; the index would silently reach the later one. Under
 * BBLITE_CHECKED_HANDLES the refusal also names the call site.
 */
template <typename Records, typename Handle>
decltype(auto) handle_at(Records& records, Handle handle
#if BBLITE_CHECKED_HANDLES
                         ,
                         const HandleSite& site = HandleSite::current()
#endif
) {
#if !BBLITE_CHECKED_HANDLES
    constexpr HandleSite site{};
#endif
    const auto index = static_cast<std::size_t>(handle.value);
    if (index >= records.size()) [[unlikely]] {
        refuse_handle_index(index, records.size(), site);
    }
    if constexpr (requires { handle.generation == records[index].generation; }) {
        if (handle.generation != records[index].generation) [[unlikely]] {
            refuse_retired_mesh_handle(index, handle.generation, records[index].generation, site);
        }
    }
    return records[index];
}

} // namespace bbl
