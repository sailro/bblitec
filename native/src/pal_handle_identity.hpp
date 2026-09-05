#pragma once
#include <atomic>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace bbl::pal {
template <typename Tag, std::uint32_t Limit = std::numeric_limits<std::uint32_t>::max()>
std::uint32_t next_handle_identity() {
    static std::atomic<std::uint32_t> next{1};
    std::uint32_t value = next.load(std::memory_order_relaxed);
    while (value != Limit) {
        if (next.compare_exchange_weak(value, value + 1, std::memory_order_relaxed)) return value;
    }
    throw std::runtime_error("Native handle identity space exhausted.");
}
}
