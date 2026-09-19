#include <cassert>
#include <cstdlib>
#include <exception>
#include <memory>
#include <new>
#include <optional>
#include <stdexcept>
#include <variant>

std::size_t allocations = 0;
void* operator new(std::size_t size) {
    if (void* memory = std::malloc(size ? size : 1)) {
        ++allocations;
        return memory;
    }
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }

#include "load-promise.hpp"

struct Rejection : std::runtime_error {
    explicit Rejection(std::shared_ptr<int> token)
        : std::runtime_error("retained rejection"), identity(std::move(token)) {}
    std::shared_ptr<int> identity;
};

int main() {
    const auto before = allocations;
    GltfLoadPromise<int> value{42};
    auto copy = value;
    value = {};
    assert(copy && copy.get() == 42);
    assert(allocations == before);
    auto image = std::make_shared<int>(7);
    const auto image_allocations = allocations;
    auto settled = GltfLoadPromise<std::shared_ptr<int>>::settle([&] { return image; });
    auto shared = settled;
    settled = {};
    assert(shared.get() == image);
    assert(allocations == image_allocations);
    const auto identity = std::make_shared<int>(9);
    const auto failure = std::make_exception_ptr(Rejection(identity));
    auto rejected = GltfLoadPromise<int>::settle([&]() -> int { std::rethrow_exception(failure); });
    const auto error_allocations = allocations;
    auto retained = rejected;
    rejected = {};
    assert(allocations == error_allocations);
    bool caught = false;
    try {
        (void)retained.get();
    } catch (const Rejection& error) {
        assert(error.identity == identity);
        caught = true;
    }
    assert(caught);
    bool absent = false;
    try {
        (void)value.get();
    } catch (const std::runtime_error&) {
        absent = true;
    }
    assert(absent);
}
