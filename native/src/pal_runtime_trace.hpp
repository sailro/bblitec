// Opt-in diagnostics shared by the native frame loops.  The trace observes
// portable runtime state only; it is deliberately independent of generated
// scene code and of any one demo.
#pragma once

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <cmath>
#include <iostream>
#include <string>
#include <string_view>

namespace bbl::pal {

inline bool runtime_trace_enabled() {
    static const bool enabled = [] {
        const std::string text =
            environment_variable("BBLITE_RUNTIME_TRACE");
        if (text.empty()) return false;
        return text != "0" && text != "false" && text != "off";
    }();
    return enabled;
}

inline void trace_keyboard_event(
    std::string_view code,
    bool down,
    bool repeat) {
    if (!runtime_trace_enabled()) return;
    std::cerr
        << "[bblite trace] input keyboard code=" << code
        << " state=" << (down ? "down" : "up")
        << " repeat=" << (repeat ? 1 : 0)
        << '\n';
}

struct CameraTraceState {
    bool initialized = false;
    double alpha = 0.0;
    double beta = 0.0;
    double radius = 0.0;
    Vec3d target{};
};

inline void trace_camera_state(
    const CameraRecord& camera,
    CameraTraceState& state,
    long frame) {
    if (!runtime_trace_enabled()) return;
    constexpr double epsilon = 1e-7;
    const bool changed =
        !state.initialized ||
        std::abs(camera.alpha - state.alpha) > epsilon ||
        std::abs(camera.beta - state.beta) > epsilon ||
        std::abs(camera.radius - state.radius) > epsilon ||
        std::abs(camera.target.x - state.target.x) > epsilon ||
        std::abs(camera.target.y - state.target.y) > epsilon ||
        std::abs(camera.target.z - state.target.z) > epsilon;
    if (!changed) return;
    std::cerr
        << "[bblite trace] camera frame=" << frame
        << " kind="
        << (camera.kind == CameraKind::free ? "free" : "arc-rotate")
        << " alpha=" << camera.alpha
        << " beta=" << camera.beta
        << " radius=" << camera.radius
        << " target=(" << camera.target.x << ','
        << camera.target.y << ',' << camera.target.z << ")\n";
    state.initialized = true;
    state.alpha = camera.alpha;
    state.beta = camera.beta;
    state.radius = camera.radius;
    state.target = camera.target;
}

inline void trace_scene_topology(
    const Scene& scene,
    const Engine& engine,
    std::size_t previous_items,
    std::size_t current_items,
    std::size_t shader_items,
    long frame) {
    if (!runtime_trace_enabled()) return;
    std::cerr
        << "[bblite trace] topology frame=" << frame
        << " version=" << scene.mesh_membership_version
        << " scene-meshes=" << scene.meshes.size()
        << " render-items=" << previous_items << "->" << current_items
        << " shader-items=" << shader_items;
    if (!scene.meshes.empty()) {
        const MeshHandle handle = scene.meshes.back();
        if (handle.value < engine.meshes.size()) {
            std::cerr
                << " last-mesh=\""
                << engine.meshes[handle.value].name
                << '\"';
        }
    }
    std::cerr << '\n';
}

} // namespace bbl::pal
