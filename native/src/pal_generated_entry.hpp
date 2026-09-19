#pragma once

#include <type_traits>

namespace bbl::pal {

template <class Entry> int run_generated_entry(Entry entry, int argc, char** argv) {
    if constexpr (std::is_invocable_r_v<int, Entry, int, char**>)
        return entry(argc, argv);
    else
        return entry();
}

} // namespace bbl::pal
