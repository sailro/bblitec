#pragma once
// Included within namespace bbl by runtime.hpp.

struct UtilityLayerRecord {
    Scene scene;
    std::shared_ptr<Scene> main_scene;
};

/** One source canvas's gizmo dispatcher; proxies own independent instances. */
struct PointerDragDispatcher {
    Engine* engine = nullptr;
    UtilityLayerHandle layer{};
    GpuPickerHandle picker{};
    std::vector<PointerDragHandle> drags;
    PointerDragHandle active{};
    PointerDragHandle hovered{};
    Vec3d plane_normal{};
    Vec3d plane_point{};
    Vec3d last_point{};
    Vec3d start_point{};
    bool pick_pending = false;
    js::Callback<void()> cleanup;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(cleanup); }
};
void pointer_drag_hover(Engine& engine, PointerDragHandle drag, bool hovered);

inline bool pointer_drag_state(
    const std::shared_ptr<PointerDragDispatcher>& state, unsigned int query) {
    if (!state) return false;
    if (query == 1u) return state->pick_pending;
    return state->active.value != invalid_handle ||
        (query == 2u && state->hovered.value != invalid_handle);
}

std::shared_ptr<PointerDragDispatcher> create_pointer_drag_dispatcher(
    Engine&, UtilityLayerHandle, bool host_canvas);
js::Callback<void()> register_pointer_drag(
    const std::shared_ptr<PointerDragDispatcher>&, PointerDragHandle);
js::Callback<void(js::BorrowedEvent)> pointer_drag_listener(
    const std::shared_ptr<PointerDragDispatcher>&, unsigned int event);
void set_pointer_drag_cleanup(
    const std::shared_ptr<PointerDragDispatcher>&, js::Callback<void()>);

/** A scene-less rendering context that owns only an ordered task graph. */
