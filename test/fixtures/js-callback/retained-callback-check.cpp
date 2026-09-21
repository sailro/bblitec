#include <bblite/js_callback.hpp>
#include "../allocation-tracker.hpp"

#include <cassert>
#include <iostream>
#include <vector>

void recursive_callback_lifetime() {
    using Function = bbl::js::Callback<void(int)>;
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
    assert(outward.identity() == owner->identity());
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
        if (depth > 0)
            bbl::js::retain_callback(weak.lock())(depth - 1);
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

void retained_body_survives_owner_replacement() {
    using Function = bbl::js::Callback<void()>;
    auto owner = bbl::js::make_gc_shared<Function>();
    auto payload = std::make_shared<int>(7);
    std::weak_ptr<int> weak_payload = payload;
    *owner = Function{[payload, &owner, &weak_payload] {
        auto observation = weak_payload;
        *owner = {};
        bbl::js::collect_cycles();
        const auto live = observation.lock();
        assert(live && *live == 7);
    }};
    auto outward = bbl::js::retain_callback(owner);
    payload.reset();
    outward();
    outward(); // Replacing the cell must not invalidate an existing function value.
    outward = {};
    assert(weak_payload.expired());
}

void prepared_invocation_retains_once() {
    using Function = bbl::js::Callback<int(int)>;
    bbl::js::gc::Node* node = nullptr;
    const auto baseline = bbl::js::managed_node_count();
    {
        Function callback{[&](int value) {
            assert(node->owners() == 1);
            bbl::js::collect_cycles();
            return value + 1;
        }};
        node = bbl::js::gc::registry.nodes.back();
        assert(node->owners() == 1);
        const auto allocations = allocation_count;
        const auto invocation = bbl::js::snapshot_callback(callback);
        assert(node->owners() == 2);
        assert(allocation_count == allocations);
        callback = {};
        assert(node->owners() == 1);
        assert(invocation(7) == 8);
        assert(node->owners() == 1);
    }
    assert(bbl::js::managed_node_count() == baseline);
    assert(!Function{}.snapshot());
    bool failed = false;
    try {
        Function{static_cast<int (*)(int)>(nullptr)}.snapshot()(0);
    } catch (const std::bad_function_call&) {
        failed = true;
    }
    assert(failed);
}

void native_invocation_snapshot() {
    int (*function)(int) = +[](int value) { return value + 1; };
    const auto allocations = allocation_count;
    const auto selected = bbl::js::snapshot_callback(function);
    function = nullptr;
    assert(selected && selected(7) == 8);
    assert(allocation_count == allocations);
    const auto absent = bbl::js::snapshot_callback(function);
    assert(!absent);
    bool failed = false;
    try {
        (void)absent(0);
    } catch (const std::bad_function_call&) {
        failed = true;
    }
    assert(failed);
    int value = 1;
    auto reference = bbl::js::snapshot_callback(+[](int& input) noexcept -> int& { return input; });
    reference(value) = 9;
    assert(value == 9);
    const auto lambda = bbl::js::snapshot_callback([](int input) { return input * 2; });
    assert(lambda(3) == 6);
}

int main() {
    recursive_callback_lifetime();
    recursive_callback_allocations();
    retained_body_survives_owner_replacement();
    identity_erasure_shares_captures();
    identity_erasure_retains_recursive_owner();
    prepared_invocation_retains_once();
    native_invocation_snapshot();
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
        for (const auto& callback : snapshot)
            callback(0.25);
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
