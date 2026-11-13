#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/runtime.hpp>

namespace bbl {

/** `rebuildMaterial` outside setup (generated material_rebuild.cpp): the pin's completion. */
js::Nullable<js::Promise<js::PromiseVoid>>
rebuild_material(Engine& engine, Scene& scene, MaterialHandle material, bool rebuild_views);

} // namespace bbl
