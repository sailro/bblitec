// Opt-in diagnostics shared by the native frame loops.  The trace observes
// portable runtime state only; it is deliberately independent of generated
// scene code and of any one demo.
#pragma once

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
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

inline long runtime_trace_interval() {
    static const long interval = [] {
        const std::string text =
            environment_variable("BBLITE_RUNTIME_TRACE_INTERVAL");
        if (text.empty()) return 60L;
        const long parsed = std::strtol(text.c_str(), nullptr, 10);
        return std::max(1L, parsed);
    }();
    return interval;
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
    std::size_t shader_geometry_cache,
    std::size_t shader_material_cache,
    long frame) {
    if (!runtime_trace_enabled()) return;
    std::cerr
        << "[bblite trace] topology frame=" << frame
        << " version=" << scene.render_topology_version
        << " scene-meshes=" << scene.meshes.size()
        << " render-items=" << previous_items << "->" << current_items
        << " shader-items=" << shader_items
        << " shader-geometries=" << shader_geometry_cache
        << " shader-materials=" << shader_material_cache;
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

/**
 * Periodic dynamic-state census for interactive scene diagnostics.
 *
 * A changing scene can keep the same draw topology while only rewriting
 * billboard instances.  The ordinary topology trace cannot see that, so this
 * reports the frame delta, instance version, and a compact checksum of each
 * active billboard buffer. It deliberately reads the portable engine records
 * rather than a backend upload buffer, which makes the same trace meaningful
 * on SDL_GPU and Dawn. The first few frames and then one frame per second are
 * enough to show whether callbacks are advancing without flooding stderr.
 */
inline void trace_dynamic_frame(
    const Engine& engine,
    float delta_ms,
    long frame) {
    if (!runtime_trace_enabled()) return;
    if (
        frame > 5 &&
        frame % runtime_trace_interval() != 0) return;

    std::cerr
        << "[bblite trace] dynamic frame=" << frame
        << " delta-ms=" << delta_ms
        << " billboard-systems=" << engine.billboard_systems.size();
    for (std::size_t index = 0;
         index < engine.billboard_systems.size();
         ++index) {
        const BillboardSystemRecord& system =
            engine.billboard_systems[index];
        const std::size_t active = std::min(
            system.instance_data.size(),
            static_cast<std::size_t>(system.count) *
                system.instance_floats_per_sprite);
        double checksum = 0.0;
        for (std::size_t lane = 0; lane < active; ++lane) {
            checksum += static_cast<double>(system.instance_data[lane]) *
                static_cast<double>((lane % 17u) + 1u);
        }
        std::cerr
            << " system[" << index << "]={count=" << system.count
            << ",instance-version=" << system.instance_version
            << ",checksum=" << checksum << '}';
    }
    for (std::size_t index = 0; index < engine.storage_buffers.size(); ++index) {
        const auto& buffer = engine.storage_buffers[index];
        if (buffer.disposed) continue;
        std::cerr << " storage[" << index << "]={label=" << buffer.label
            << ",version=" << buffer.version << ",bytes=" << buffer.bytes.size() << '}';
    }
    for (const auto& drag : engine.edit_gizmos) {
        if (!drag.dragging || drag.attached_node.value >= engine.meshes.size()) continue;
        const auto& node = engine.meshes[drag.attached_node.value];
        std::cerr << " drag={node=" << node.name << ",position=("
            << node.position.x << ',' << node.position.y << ',' << node.position.z << ")}";
    }
    std::cerr << '\n';
}

} // namespace bbl::pal
