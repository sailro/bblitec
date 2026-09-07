#include <bblite/runtime.hpp>

#include <stdexcept>

namespace {
bbl::Engine* scene_engine = nullptr;
}

namespace bbl {

Engine create_engine(EngineOptions) {
    return {};
}

Scene create_scene_context(Engine& engine) {
    scene_engine = &engine;
    return {};
}

void stop_engine(Engine& engine) {
    if (&engine != scene_engine) {
        throw std::runtime_error("The engine alias copied its scene owner.");
    }
}

} // namespace bbl
