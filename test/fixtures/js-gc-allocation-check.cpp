#include <bblite/js_gc.hpp>

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <limits>

using namespace bbl::js;

struct alignas(4096) Aligned {
    static inline int alive = 0;
    int value;
    std::array<std::byte, 4096 - sizeof(int)> padding{};
    explicit Aligned(int input) : value(input) { ++alive; }
    ~Aligned() { --alive; }
};

void aligned_owners() {
    for (int iteration = 0; iteration < 4; ++iteration) {
        std::vector<std::shared_ptr<Aligned>> owners;
        for (int index = 0; index < 128; ++index) {
            auto owner = make_gc_shared<Aligned>(index);
            assert(reinterpret_cast<std::uintptr_t>(owner.get()) % alignof(Aligned) == 0);
            owners.push_back(std::move(owner));
        }
        assert(Aligned::alive == 128);
        auto owner = owners.back();
        std::weak_ptr<Aligned> weak = owner;
        std::shared_ptr<int> alias(owner, &owner->value);
        owners.clear();
        owner.reset();
        assert(Aligned::alive == 1 && *alias == 127 && !weak.expired());
        alias.reset();
        assert(Aligned::alive == 0 && weak.expired());
        weak.reset();
    }
}

void allocation_overflow() {
    detail::RecycledBlockAllocator<std::uint64_t, std::uint64_t> allocator;
    bool refused = false;
    try {
        const auto count = std::numeric_limits<std::size_t>::max() / sizeof(std::uint64_t) + 1;
        auto* memory = allocator.allocate(count);
        allocator.deallocate(memory, count);
    } catch (const std::bad_alloc&) {
        refused = true;
    }
    assert(refused);
}

void recycled_blocks() {
    detail::RecycledBlockAllocator<std::uint64_t, std::uint64_t> allocator;
    auto* first = allocator.allocate(1);
    allocator.deallocate(first, 1);
    auto* reused = allocator.allocate(1);
    assert(reused == first);
    allocator.deallocate(reused, 1);
    auto* multiple = allocator.allocate(8);
    for (std::size_t index = 0; index < 8; ++index)
        std::construct_at(multiple + index, index);
    for (std::size_t index = 0; index < 8; ++index)
        assert(multiple[index] == index);
    allocator.deallocate(multiple, 8);
    detail::RecycledBlockAllocator<Aligned, std::uint64_t> rebound(allocator);
    auto* aligned = rebound.allocate(1);
    assert(reinterpret_cast<std::uintptr_t>(aligned) % alignof(Aligned) == 0);
    std::construct_at(aligned, 42);
    assert(aligned->value == 42 && Aligned::alive == 1);
    std::destroy_at(aligned);
    rebound.deallocate(aligned, 1);
    assert(Aligned::alive == 0);
    // Large ordinary blocks may also require allocator-specific deallocation.
    for (int iteration = 0; iteration < 4; ++iteration) {
        auto large = make_gc_shared<std::array<std::byte, 8192>>();
        large->back() = std::byte{42};
        assert(large->back() == std::byte{42});
    }
}

int main() {
    allocation_overflow();
    aligned_owners();
    recycled_blocks();
    std::puts("gc-allocation: ok");
}
