#include <bblite/js_callback.hpp>

#include <cassert>
#include <iostream>
#include <vector>

int main() {
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
