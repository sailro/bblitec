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
 * Whether `handle` names a record of `records`: an index inside the table
 * and -- for a handle type whose records carry a slot generation
 * (`MeshHandle`) -- issued for the slot's current occupant rather than for a
 * retired mesh whose slot a later mesh now holds.
 */
template <typename Records, typename Handle>
[[nodiscard]] bool handle_names_record(const Records& records, Handle handle) {
    const auto index = static_cast<std::size_t>(handle.value);
    if (index >= records.size()) {
        return false;
    }
    if constexpr (requires { handle.generation == records[index].generation; }) {
        return handle.generation == records[index].generation;
    } else {
        return true;
    }
}

/** The refusal `handle_at` raises for a handle `handle_names_record` rejects. */
template <typename Records, typename Handle>
[[noreturn]] void refuse_handle(const Records& records, Handle handle, const HandleSite& site) {
    const auto index = static_cast<std::size_t>(handle.value);
    if constexpr (requires { handle.generation == records[index].generation; }) {
        if (index < records.size()) {
            refuse_retired_mesh_handle(index, handle.generation, records[index].generation, site);
        }
    }
    refuse_handle_index(index, records.size(), site);
}

/**
 * `records[handle.value]`, refused in every build when the handle names no
 * record (`handle_names_record`). JavaScript would still reach a retired
 * mesh's object; the index would silently reach the later occupant. Under
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
    // Static: a local whose address reaches the refusal would give every
    // function inlining this one a stack-protector cookie.
    static constexpr HandleSite site{};
#endif
    if (!handle_names_record(records, handle)) [[unlikely]] {
        refuse_handle(records, handle, site);
    }
    return records[static_cast<std::size_t>(handle.value)];
}

/**
 * The record `handle` names, or null where `handle_at` would refuse: for a
 * lookup whose absent record is an expected state -- an unset camera, a
 * draw without a material -- rather than a broken handle.
 */
template <typename Records, typename Handle>
[[nodiscard]] auto* handle_find(Records& records, Handle handle) {
    return handle_names_record(records, handle) ? &records[static_cast<std::size_t>(handle.value)]
                                                : nullptr;
}

} // namespace bbl
