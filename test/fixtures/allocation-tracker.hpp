#pragma once

#include <cstdlib>
#include <limits>
#include <new>

// Include in one fixture translation unit: these replace its allocation functions.
std::size_t allocation_count = 0;
std::size_t outstanding_allocations = 0;
std::size_t allocation_failure_at = std::numeric_limits<std::size_t>::max();

void* operator new(std::size_t size) {
    if (allocation_count == allocation_failure_at)
        throw std::bad_alloc();
    if (void* memory = std::malloc(size ? size : 1)) {
        ++allocation_count;
        ++outstanding_allocations;
        return memory;
    }
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* memory) noexcept {
    if (memory)
        --outstanding_allocations;
    std::free(memory);
}
void operator delete[](void* memory) noexcept { ::operator delete(memory); }
void operator delete(void* memory, std::size_t) noexcept { ::operator delete(memory); }
void operator delete[](void* memory, std::size_t) noexcept { ::operator delete(memory); }
