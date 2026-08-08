#include <bblite/runtime.hpp>

namespace bbl {

MaterialHandle create_standard_material(Engine& engine) {
    engine.materials.emplace_back();
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
