// The compiler identity fixture needs opaque factory handles, not a renderer.
// These inert factories keep its generated program executable without SDL or
// a desktop window; all object and container operations are the real runtime.
#include <bblite/runtime.hpp>

namespace bbl {
Engine create_engine([[maybe_unused]] EngineOptions options) { return {}; }
MeshHandle create_box(Engine& engine, [[maybe_unused]] BoxOptions options) {
    const auto index = static_cast<std::uint32_t>(engine.meshes.size());
    engine.meshes.emplace_back();
    return {index};
}
} // namespace bbl
