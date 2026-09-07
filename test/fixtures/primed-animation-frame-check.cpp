#define main generated_main
#include "primed.hpp"
#undef main
#include <cassert>

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void start_engine(Engine& engine) {
    assert(engine.animation_frame_callbacks.empty());
    for (int frame = 0; frame < 2; ++frame) {
        assert(engine.animation_frame_once_callbacks.size() == 1);
        auto callbacks = std::move(engine.animation_frame_once_callbacks);
        engine.animation_frame_once_callbacks.clear();
        callbacks.front()(static_cast<double>(frame));
    }
    assert(engine.animation_frame_once_callbacks.empty());
}
}

int main() {
    const auto initial = bbl::js::managed_node_count();
    assert(generated_main() == 0);
    bbl::js::collect_cycles();
    assert(bbl::js::managed_node_count() == initial);
}
