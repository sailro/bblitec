#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <iostream>
#include <stdexcept>

#define main generated_main
#include "program.hpp"
#undef main

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void mark_mesh_runtime_transform(Engine&, MeshHandle) {}
}

int main() {
    if (generated_main() != 0) return 1;
    // A callback group adapts its private track, leaving a shared source
    // clip usable by a subsequent native mesh group.
    bbl::Engine engine;
    engine.meshes.emplace_back();
    const auto manager = bbl::create_animation_manager(engine);
    const auto clip = bbl::create_property_animation_clip("shared", {{
        bbl::PropertyAnimationPath::position,
        bbl::PropertyAnimationComponent::x,
        bbl::PropertyAnimationInterpolation::linear,
        false, {{0.0f, {0.0f}}, {1.0f, {10.0f}}}}}, 10.0f);
    double scalar = 0.0;
    const auto data_group = bbl::create_property_animation_group(manager, engine,
        {{bbl::PropertyAnimationTargetKind::callback, 0u,
            [&scalar](float value) { scalar = value; }, &scalar, "x"}},
        clip, {0.0f, 1.0f, 1.0f, false});
    const auto mesh_group = bbl::create_property_animation_group(manager, engine,
        {{bbl::PropertyAnimationTargetKind::mesh, 0u, {}}},
        clip, {0.0f, 1.0f, 1.0f, false});
    bbl::go_to_frame(data_group, engine, 5.0f);
    bbl::go_to_frame(mesh_group, engine, 5.0f);
    if (scalar != 5.0 || engine.meshes[0].position.x != 5.0 ||
        clip.tracks[0].path != bbl::PropertyAnimationPath::position) {
        throw std::runtime_error("Callback binding mutated the shared native clip");
    }
    std::cout << "property-animation-data-check: ok\n";
}
