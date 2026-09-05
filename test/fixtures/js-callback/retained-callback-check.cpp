#include <bblite/js_callback.hpp>

#include <cassert>
#include <cstdlib>
#include <iostream>
#include <new>
#include <vector>

std::size_t allocation_count = 0;

void* operator new(std::size_t size) {
    if (void* memory = std::malloc(size ? size : 1)) {
        ++allocation_count;
        return memory;
    }
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

template <typename Function>
void recursive_callback_lifetime() {
    auto owner = std::make_shared<Function>();
    std::weak_ptr<Function> weak = owner;
    Function escaped;
    int calls = 0;
    bool disposing = false;
    *owner = Function{[weak, &escaped, &calls, &disposing](int depth) {
        ++calls;
        if (depth > 0) {
            bbl::js::retain_callback(weak.lock())(depth - 1);
        } else if (disposing) {
            escaped = Function{};
            // The invocation retains itself until its stack frame returns.
            assert(!weak.expired());
        } else {
            escaped = bbl::js::retain_callback(weak.lock());
        }
        assert(!weak.expired());
    }};
    Function outward = bbl::js::retain_callback(owner);
    if constexpr (requires { outward.identity(); }) {
        assert(outward.identity() == owner->identity());
    }
    outward(3);
    assert(calls == 4);
    outward = Function{};
    owner.reset();
    assert(!weak.expired());
    disposing = true;
    escaped(1);
    assert(calls == 6);
    assert(weak.expired());
}

void recursive_callback_allocations() {
    using Function = bbl::js::Callback<void(int)>;
    auto owner = std::make_shared<Function>();
    std::weak_ptr<Function> weak = owner;
    int calls = 0;
    *owner = Function{[weak, &calls](int depth) {
        ++calls;
        if (depth > 0) bbl::js::retain_callback(weak.lock())(depth - 1);
    }};
    const std::size_t before = allocation_count;
    Function outward = bbl::js::retain_callback(owner);
    outward(64);
    assert(calls == 65);
    assert(allocation_count == before);
}

void identity_erasure_shares_captures() {
    bbl::js::Callback<int()> callback{[count = 0]() mutable { return ++count; }};
    auto first = callback.body();
    auto second = callback.body();
    assert(callback() == 1);
    assert(first() == 2);
    assert(second() == 3);
    callback = {};
    assert(first() == 4);
    second = {};
    assert(first() == 5);
    assert(!bbl::js::Callback<void()>{}.body());
}

void identity_erasure_retains_recursive_owner() {
    using Function = bbl::js::Callback<void(int)>;
    auto owner = std::make_shared<Function>();
    std::weak_ptr<Function> weak = owner;
    std::function<void(int)> escaped;
    int calls = 0;
    *owner = Function{[weak, &escaped, &calls](int depth) {
        ++calls;
        if (depth > 0) {
            bbl::js::retain_callback(weak.lock())(depth - 1);
        } else {
            escaped = {};
        }
        assert(!weak.expired());
    }};
    Function outward = bbl::js::retain_callback(owner);
    escaped = outward.body();
    outward = {};
    owner.reset();
    assert(!weak.expired());
    escaped(3);
    assert(calls == 4);
    assert(weak.expired());
}

int main() {
    recursive_callback_lifetime<std::function<void(int)>>();
    recursive_callback_lifetime<bbl::js::Callback<void(int)>>();
    recursive_callback_allocations();
    identity_erasure_shares_captures();
    identity_erasure_retains_recursive_owner();
    using Callback = bbl::js::Callback<void(double)>;
    std::vector<Callback> callbacks;
    int steps = 0;
    callbacks.emplace_back([&, accumulator = 0.0](double delta) mutable {
        accumulator += delta;
        while (accumulator >= 1.0) {
            ++steps;
            accumulator -= 1.0;
        }
    });
    for (int frame = 0; frame < 8; ++frame) {
        const auto snapshot = callbacks;
        assert(snapshot.front() == callbacks.front());
        for (const auto& callback : snapshot) callback(0.25);
    }
    assert(steps == 2);

    int calls = 0;
    callbacks.clear();
    callbacks.emplace_back([&, local = 0](double) mutable {
        callbacks.clear();
        calls = ++local;
    });
    const auto snapshot = callbacks;
    snapshot.front()(0);
    snapshot.front()(0);
    assert(callbacks.empty());
    assert(calls == 2);
    std::cout << "retained-callback-check: ok\n";
}
