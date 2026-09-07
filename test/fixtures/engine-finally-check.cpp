#define main generated_main
#include "finally.hpp"
#undef main
#include <cassert>

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void defer_start_continuation(Engine& engine, std::function<void()> callback) {
    engine.deferred_callbacks.push_back(std::move(callback));
}
void start_engine(Engine& engine) {
    assert(engine.deferred_callbacks.size() == 1);
    auto callbacks = std::move(engine.deferred_callbacks);
    engine.deferred_callbacks.clear();
    callbacks.front()();
    assert(engine.deferred_callbacks.empty());
}
}

int main() {
    assert(generated_main() == 0);
    unsigned cleanups = 0;
    {
        auto action = bbl::js::finally([&] { ++cleanups; });
        action.run();
        action.run();
        assert(cleanups == 1);
    }
    assert(cleanups == 1);
    try {
        auto action = bbl::js::finally([&] { ++cleanups; throw std::runtime_error("cleanup"); });
        action.run();
    } catch (const std::runtime_error&) {}
    assert(cleanups == 2);
}
