#pragma once
// Included within namespace bbl by runtime.hpp.

// `UtilityLayerRecord` holds a Scene by value, and Scene is defined after
// Engine; the engine keeps them behind unique_ptr, whose element type may
// be incomplete here and is complete wherever the engine is destroyed.
struct UtilityLayerRecord;

/**
 * `CameraGizmo` (src/gizmo/camera-gizmo.ts), display only.
 *
 * The root follows the attached camera's world translation and rotation
 * every frame; the body node carries the distance scaling separately
 * because the frustum edges are built in literal world units.
 */
struct CameraGizmoRecord {
    /** The layer that built it, which its per-frame follow reads back. */
    UtilityLayerHandle layer{};
    TransformNodeHandle root{};
    MaterialHandle material{};
    MaterialHandle frustum_material{};
    CameraHandle attached_camera{};
    TransformNodeHandle body_outer{};
    bool frustum_built = false;
};

/**
 * `LightGizmo` (src/gizmo/light-gizmo.ts), display only.
 *
 * Which of the position and direction arms the per-frame follow takes is
 * the light TYPE's answer upstream -- a HemisphericLight declares no
 * `position` and a PointLight no `direction` -- so the generated follow
 * asks the record's kind exactly where the pin asks `if (pos)`/`if (dir)`.
 */
struct LightGizmoRecord {
    /** The layer that built it, which its per-frame follow reads back. */
    UtilityLayerHandle layer{};
    TransformNodeHandle root{};
    MaterialHandle material{};
    LightHandle attached_light{};
    bool built = false;
    /** The light TYPE the widget below `root` was built for. */
    LightKind built_kind = LightKind::hemispheric;
};

/**
 * One editing widget (`src/gizmo/axis-drag-gizmo.ts` and its three
 * siblings), as its follow reads it.
 *
 * `attachFollowTarget` copies the attached node's world translation onto
 * the root every frame and scales the root by the gizmo's projected depth
 * along the utility camera's forward axis times the widget's own scale
 * ratio -- which is the pinned `1 / 3` each factory passes, read from the
 * pin rather than restated. The layer and the material a pinned gizmo
 * object also holds are consumed where they are built and never read
 * back, so neither is stored, and neither is the pin's `drag.enabled` --
 * nothing reads it while pointer drag is unreached, and the scene that
 * reaches it will add it back with a reader.
 *
 * The four fields after those are the pin's LOCAL-COORDINATE arm, which a
 * composite scene reaches at load: every widget keeps its own
 * `useLocalCoordinates` flag and the local-frame axis it was built on,
 * and the follow re-orients the root from the attached node's world
 * matrix while the flag is set. `orientation` is which of the pin's two
 * re-orientations the widget uses -- the three that take a shortest-arc
 * `lookAtQuat` of the transformed axis, and the scale widget, whose cube
 * is not roll-symmetric and which therefore composes the node's world
 * rotation onto the orientation baked at creation.
 */
enum class GizmoLocalOrientation : std::uint8_t {
    look_at_world_axis,
    compose_baked_rotation,
};

struct PointerDragDispatcher;

struct EditGizmoRecord {
    TransformNodeHandle root{};
    MeshHandle attached_node{};
    double scale_ratio = 1.0;
    bool use_local_coordinates = false;
    Vec3d local_axis{0.0, 0.0, 1.0};
    std::array<double, 4> baked_rotation{0.0, 0.0, 0.0, 1.0};
    GizmoLocalOrientation orientation =
        GizmoLocalOrientation::look_at_world_axis;
    bool enabled = true;
    bool dragging = false;
    bool hovering = false;
    bool plane_drag = false;
    bool rotation_drag = false;
    MaterialHandle colored_material{};
    MaterialHandle hover_material{};
    std::vector<MeshHandle> visible_meshes;
    std::function<void()> dispose_pointer = []() {};
};

/**
 * One corner of the bounding-box cage: the pin's `buildCornerHandle`
 * returns three thin boxes meeting at the corner, and its `place`
 * callback moves all three from one corner point through the offsets it
 * baked at creation. So the three handles and those offsets travel
 * together, exactly as the closure carries them upstream.
 */
struct BoundingBoxCorner {
    MeshHandle anchor{};
    MeshHandle y_arm{};
    MeshHandle z_arm{};
    Vec3d offsets{};
};

/**
 * `BoundingBoxGizmo` (src/gizmo/bounding-box-gizmo.ts), display only.
 *
 * The cage is the only widget in the family whose per-frame work reads
 * the attached subtree rather than one node's world translation: every
 * frame it recomputes the attached node's world rotation, the bounds of
 * its descendant meshes in the rotation-removed frame, and lays all of
 * its handles out from the two. Each group is a vector because its LENGTH
 * is the pinned build loop's own bound, read from that loop rather than
 * fixed here.
 *
 * The pinned gizmo's remaining members belong to the pointer drag, which
 * this port does not reach (`display-only-editing-gizmo`): the hover
 * material nothing assigns outside a drag callback, the disposer list,
 * and the local bounding diagonal only the rotation drag divides by.
 */
struct BoundingBoxGizmoRecord {
    /** The layer that built it, which its per-frame refresh reads back. */
    UtilityLayerHandle layer{};
    TransformNodeHandle root{};
    MaterialHandle material{};
    MaterialHandle body_material{};
    std::vector<MeshHandle> edges;
    std::vector<BoundingBoxCorner> corners;
    std::vector<MeshHandle> rotators;
    std::vector<MeshHandle> faces;
    MeshHandle body{};
    /** The pin's `faceBoxSize`, which the layout insets the body by. */
    double face_box_size = 0.0;
    /** `attachedNode`, which the pin starts null and this port unset. */
    bool attached = false;
    TransformNodeHandle attached_node{};
};
