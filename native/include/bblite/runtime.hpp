#pragma once
#include <bblite/checked_handles.hpp>
#include <bblite/pal_audio_types.hpp>

#include <bblite/js_callback.hpp>
#include <bblite/snapshot_list.hpp>
#include <bblite/dom_event_state.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <list>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace bbl {

struct Engine;
struct DomInput;
/** The first OS language preference, with a hyphenated region when available. */
[[nodiscard]] std::string preferred_language();
[[nodiscard]] std::string native_platform();
[[nodiscard]] double logical_processor_count();
[[nodiscard]] const void* native_navigator_identity();
[[nodiscard]] const void* native_performance_identity();
struct ShadowGeneratorRecord;
struct PropertyAnimationManagerRecord;

namespace pal { class AudioSession; class OffscreenRun; }

namespace js {
template <typename T>
class Array;
template <typename T>
class TypedArray;
using F32Array = TypedArray<float>;
template <typename T>
class Nullable;
template <typename K, typename V>
class Map;
template <std::size_t N>
class Tuple;
class U8Array;
class ArrayBuffer;
class BorrowedEvent;
}

inline constexpr float pi = 3.14159265358979323846f;
// Camera angles are JavaScript numbers upstream, so `Math.PI / 2` reaches
// `Math.cos` as a double and not as its float32 neighbour. The two differ
// enough to matter: `cos` of the double is 6.1e-17 and of the float
// -4.4e-8, which is a whole ulp band in the composed view matrix.
inline constexpr double pi_double = 3.14159265358979323846;
inline constexpr std::uint32_t invalid_handle = std::numeric_limits<std::uint32_t>::max();
inline constexpr std::uint32_t material_family_pbr = 1u << 0;
inline constexpr std::uint32_t material_family_standard = 1u << 1;
inline constexpr std::uint32_t material_family_shader = 1u << 2;
inline constexpr std::uint32_t material_family_grid = 1u << 3;

struct Vec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

// A position the pinned engine keeps as three JavaScript numbers -- the
// camera's, and a node's translation, which at large-world coordinates has
// to survive a float32 grid whose spacing is half a unit.
struct Vec3d {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

// The other positional records generated units keep at JavaScript number
// precision: a node-particle system's 2D lanes and colour, a flow graph's
// vector sockets.
struct Vec2d {
    double x = 0.0;
    double y = 0.0;
};

struct Vec4d {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
    double w = 0.0;
};

struct Color4d {
    double r = 0.0;
    double g = 0.0;
    double b = 0.0;
    double a = 0.0;
};

struct Vec2 {
    float x = 0.0f;
    float y = 0.0f;
};

struct Vec4 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
    float w = 0.0f;
};

struct Color3 {
    float r = 1.0f;
    float g = 1.0f;
    float b = 1.0f;
};

struct Color4 {
    float r = 0.05f;
    float g = 0.06f;
    float b = 0.09f;
    float a = 1.0f;
};

struct EngineOptions {
    std::string title = "Babylon Lite Native";
    int width = 1280;
    int height = 720;
};

/** Browser-neutral keyboard data delivered by the platform event loop. */
struct PlatformKeyboardEvent {
    std::string code{};
    std::string key{};
    bool repeat = false;
    bool shift_key = false;
    bool ctrl_key = false;
    bool alt_key = false;
    bool meta_key = false;
    mutable bool default_prevented = false;
    std::shared_ptr<DomEventState> dom{};

    void prevent_default() const noexcept {
        if (dom && !dom->can_prevent_default()) return;
        default_prevented = true;
    }
    void stop_propagation() const { dom_event_state(*this).stop_propagation(); }
    void stop_immediate_propagation() const { dom_event_state(*this).stop_immediate_propagation(); }
};

/** Browser-neutral mouse data delivered by the platform event loop. */
struct PlatformMouseEvent {
    double button = 0.0;
    double buttons = 0.0;
    double client_x = 0.0;
    double client_y = 0.0;
    double movement_x = 0.0;
    double movement_y = 0.0;
    double delta_y = 0.0;
    mutable bool default_prevented = false;
    std::shared_ptr<DomEventState> dom{};
    std::string pointer_type = "mouse";
    double pointer_id = 1;
    bool is_primary = true;
    bool shift_key = false;
    bool ctrl_key = false;
    bool alt_key = false;
    bool meta_key = false;

    void prevent_default() const noexcept {
        if (dom && !dom->can_prevent_default()) return;
        default_prevented = true;
    }
    void stop_propagation() const { dom_event_state(*this).stop_propagation(); }
    void stop_immediate_propagation() const { dom_event_state(*this).stop_immediate_propagation(); }
};

/**
 * DOM event listeners keyed by JavaScript callback identity.
 *
 * List nodes stay stable while callbacks add or remove listeners. Each
 * dispatch records the next sequence number and ignores later additions;
 * removals tombstone entries until the outermost dispatch finishes. A
 * one-shot listener is tombstoned before invocation, matching DOM reentrancy.
 */
template <typename Signature>
class PlatformEventListeners;

template <typename... Args>
class PlatformEventListeners<void(Args...)> {
  public:
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    using Callback = js::Callback<void(Args...)>;
#else
    using Callback = std::function<void(Args...)>;
#endif

    void add(
        std::size_t identity,
        Callback callback,
        bool once = false) {
        const auto duplicate = std::find_if(
            entries_.begin(),
            entries_.end(),
            [identity](const auto& entry) {
                return entry.active && entry.identity == identity;
            });
        if (duplicate != entries_.end()) return;
        entries_.push_back(Entry{
            identity,
            next_sequence_++,
            std::move(callback),
            true,
            once});
    }

    void remove(std::size_t identity) {
        for (Entry& entry : entries_) {
            if (entry.identity == identity && entry.active) {
                entry.active = false;
                needs_compaction_ = true;
            }
        }
        compact_if_idle();
    }

    void clear() {
        for (Entry& entry : entries_) {
            if (!entry.active) continue;
            entry.active = false;
            needs_compaction_ = true;
        }
        compact_if_idle();
    }

    [[nodiscard]] bool empty() const noexcept { return entries_.empty(); }

#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    void gc_trace(const js::TraceVisitor& visitor) const {
        for (const Entry& entry : entries_) visitor(entry.callback);
    }
#endif

      void dispatch(Args... args) {
          dispatch_with([](Callback& callback, Args... values) { callback(values...); }, args...);
      }

      /** The owning event loop supplies exception reporting and callback cleanup. */
      template <typename Invoke>
      void dispatch_with(Invoke&& invoke, Args... args) {
        dispatch_while([] { return true; }, std::forward<Invoke>(invoke), args...);
      }

      /** A stopped dispatch must not consume a later once-listener. */
      template <typename Continue, typename Invoke>
      void dispatch_while(Continue&& proceed, Invoke&& invoke, Args... args) {
        const std::size_t boundary = next_sequence_;
        ++dispatch_depth_;
        try {
            for (Entry& entry : entries_) {
                if (entry.sequence >= boundary) break;
                if (!entry.active) continue;
                if (!proceed()) break;
                if (entry.once) {
                    entry.active = false;
                    needs_compaction_ = true;
                }
                  invoke(entry.callback, args...);
            }
        } catch (...) {
            --dispatch_depth_;
            compact_if_idle();
            throw;
        }
        --dispatch_depth_;
        compact_if_idle();
    }

  private:
    struct Entry {
        std::size_t identity = 0;
        std::size_t sequence = 0;
        Callback callback;
        bool active = true;
        bool once = false;
    };
    void compact_if_idle() {
        if (dispatch_depth_ != 0 || !needs_compaction_) return;
        std::erase_if(
            entries_,
            [](const Entry& entry) { return !entry.active; });
        needs_compaction_ = false;
    }

    std::list<Entry> entries_;
    std::size_t next_sequence_ = 0;
    std::size_t dispatch_depth_ = 0;
    bool needs_compaction_ = false;
};

/**
 * Stable identity for one node in the scene-created, browser-neutral UI IR.
 * The handle is declared outside the UI feature guard because a materialized
 * module may hold an empty `std::optional<UiElementHandle>` (a browser-only
 * `let element: HTMLCanvasElement | null = null` whose writers the bake
 * erased) in a scene that never reaches the UI runtime; only the UI records
 * below need the feature.
 */
struct UiElementHandle {
    std::uint32_t value = invalid_handle;
    [[nodiscard]] bool operator==(const UiElementHandle&) const = default;
};

/** Opaque URL token for one engine-owned Blob payload. */
struct ObjectUrlHandle {
    std::uint32_t slot = invalid_handle;
    std::uint32_t generation = 0;

    [[nodiscard]] bool operator==(const ObjectUrlHandle&) const = default;
};

struct BrowserFileRecord;

/** Shared handle to one immutable file snapshot returned by the host dialog. */
class BrowserFileHandle {
  public:
    BrowserFileHandle() = default;
    explicit BrowserFileHandle(std::shared_ptr<BrowserFileRecord> record)
        : record_(std::move(record)) {}

    explicit operator bool() const noexcept {
        return static_cast<bool>(record_);
    }
    [[nodiscard]] BrowserFileRecord* get() const noexcept {
        return record_.get();
    }
    [[nodiscard]] bool unique() const noexcept {
        return record_.use_count() == 1;
    }

    [[nodiscard]] friend bool operator==(
        const BrowserFileHandle&,
        const BrowserFileHandle&) = default;

  private:
    std::shared_ptr<BrowserFileRecord> record_;
};

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
/** Last computed retained-layout box exposed as DOMRect's reached surface. */
struct UiClientRect {
    double left = 0.0;
    double top = 0.0;
    double width = 0.0;
    double height = 0.0;
};
#endif

struct MeshHandle {
    std::uint32_t value = invalid_handle;

    // A handle is an id, so comparing ids is exactly the object
    // identity JavaScript compares meshes by.
    [[nodiscard]] bool operator==(
        const MeshHandle&) const = default;
};

struct MaterialHandle {
    std::uint32_t value = invalid_handle;

    [[nodiscard]] bool operator==(const MaterialHandle&) const = default;
};

/** One GPU-readable byte buffer created by the shader-material API. */
struct StorageBufferHandle {
    std::uint32_t value = invalid_handle;
};

/** A browser Gamepad identity backed by one SDL joystick instance. */
struct GamepadHandle {
    std::uint32_t instance_id = invalid_handle;
    std::uint32_t index = invalid_handle;

    [[nodiscard]] bool operator==(const GamepadHandle&) const = default;
};

/** A button in the browser standard-mapping order for one gamepad. */
struct GamepadButtonHandle {
    GamepadHandle gamepad{};
    std::uint32_t index = invalid_handle;

    [[nodiscard]] bool operator==(const GamepadButtonHandle&) const = default;
};

struct PlatformGamepadState;

struct LightHandle {
    std::uint32_t value = invalid_handle;
};

struct CameraHandle {
    std::uint32_t value = invalid_handle;
};

struct TransformNodeHandle {
    std::uint32_t value = invalid_handle;

    // The same identity a MeshHandle carries, for the same reason: the
    // parent setter's child registry looks a node up by the id it is.
    [[nodiscard]] bool operator==(
        const TransformNodeHandle&) const = default;
};

/**
 * One entry in a TransformNode's public traversal list.
 *
 * SceneNode.children is one ordered list upstream: mesh and transform-node
 * entries may interleave, and addToScene observes that exact order.
 */
using TransformNodeChild =
    std::variant<MeshHandle, TransformNodeHandle>;

struct AssetHandle {
    std::uint32_t value = invalid_handle;
    [[nodiscard]] bool operator==(const AssetHandle&) const = default;
};

/** The three concrete native representations admitted by SceneNode. */
using SceneNodeHandle =
    std::variant<MeshHandle, TransformNodeHandle, AssetHandle>;

struct HierarchyInstancePoolHandle {
    std::uint32_t value = invalid_handle;
};

struct AnimationGroupHandle {
    std::uint32_t value = invalid_handle;
};

struct RenderTargetHandle {
    std::uint32_t value = invalid_handle;
};

struct TaskHandle {
    std::uint32_t value = invalid_handle;
};

struct SpriteAtlasHandle {
    std::uint32_t value = invalid_handle;
};

struct Sprite2DLayerHandle {
    std::uint32_t value = invalid_handle;
};

/** The CPU answer returned by the pin's pure 2D sprite hit test. */
struct Sprite2DPickResult {
    Sprite2DLayerHandle layer{};
    std::uint32_t sprite_index = 0;
    double u = 0.0;
    double v = 0.0;
};

struct SpriteRendererHandle {
    std::uint32_t value = invalid_handle;
};

struct SpriteRenderTextureHandle {
    std::uint32_t value = invalid_handle;
};

struct BillboardSystemHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * One skeleton the opt-in bone-control chunk built, one per glTF skin
 * instance (`AssetContainer.skeletons`).
 */
struct SkeletonHandle {
    std::uint32_t value = invalid_handle;
};

/** One joint of a skeleton, addressed by name through `getBoneByName`. */
struct BoneHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * One skeleton a scene built with `createSkeleton`, distinct from the
 * loader-built `SkeletonHandle` above: see `SceneSkeletonRecord`.
 */
struct SceneSkeletonHandle {
    std::uint32_t value = invalid_handle;
};

/** One baked vertex-animation texture (`VatBakeResult`). */
struct VatBake {
    std::uint32_t value = invalid_handle;
};

/**
 * The playback handle `attachVat` returns.
 *
 * Upstream it is a closure bundle over the mesh's own `VatData`; here it
 * names that mesh, so `play`/`update`/`setInstances` are writers over the
 * one record rather than three captured lambdas.
 */
struct VatHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * Where one clip landed in the baked texture: its first row, its frame
 * count, and its native frame rate.
 *
 * The three numbers are the pin's own `VatClip` members, which scene code
 * reads and does arithmetic on -- so they are JavaScript numbers here, the
 * same convention every other scene-visible numeric field takes.
 */
struct VatClipRow {
    std::string name;
    double from_row = 0.0;
    double frame_count = 0.0;
    double fps = 60.0;
};

/**
 * A baked VAT: `frame_count` rows of `bone_count * 4` rgba32float texels,
 * the same per-row layout the live bone palette uses, so row N reproduces
 * the live pose at frame N to full float precision.
 */
struct VatBakeRecord {
    std::uint32_t bone_count = 0;
    std::uint32_t frame_count = 0;
    std::vector<float> data;
    std::vector<VatClipRow> clips;
};

/**
 * `mesh.vat`: which bake this mesh reads and where in it.
 *
 * `settings` is the pin's own 32-byte vertex-visible block --
 * `params = (fromRow, toRow, frameOffset, fps)` then
 * `clock = (elapsedSeconds, 0, 0, 0)`. The versions are what each backend
 * re-uploads on; the instance params are two texels per instance (clip A
 * then clip B), the dual-clip layout the single instanced variant reads.
 */
struct VatData {
    std::uint32_t bake = invalid_handle;
    std::array<float, 8> settings{};
    std::uint64_t settings_version = 1;
    float time = 0.0f;
    std::vector<float> instance_params;
    std::uint32_t instance_texels = 0;
    std::uint64_t instance_version = 0;
};

struct BillboardSpriteHandle {
    BillboardSystemHandle system{};
    std::uint32_t id = invalid_handle;
};

/** Which sprite family a frame animation drives. */
#if !defined(BBLITE_HAS_SPRITE_ANIMATION) || BBLITE_HAS_SPRITE_ANIMATION
#include <bblite/runtime/sprite-animation.hpp>
#endif

struct EffectWrapperHandle {
    std::uint32_t value = invalid_handle;
};

struct EffectRendererHandle {
    std::uint32_t value = invalid_handle;
};

struct SplatMeshHandle {
    std::uint32_t value = invalid_handle;
};

struct ShadowGeneratorHandle {
    std::uint32_t value = invalid_handle;
};

struct ClusteredLightContainerHandle {
    std::uint32_t value = invalid_handle;
};

struct GpuPickerHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * The gizmo family's handles.
 *
 * `createUtilityLayer` builds a SECOND SceneContext over the same engine
 * and registers it after the main one, which is what makes both backends
 * record it as a swapchain overlay layer. The two display gizmos are
 * records rather than plain locals because their per-frame follow reads
 * live state the scene keeps mutating.
 */
struct UtilityLayerHandle {
    std::uint32_t value = invalid_handle;
};

struct CameraGizmoHandle {
    std::uint32_t value = invalid_handle;
};

struct LightGizmoHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * The four EDITING widgets share one handle and one record.
 *
 * Upstream gives each its own module because each builds different
 * geometry and applies a different drag; what the record holds is the
 * same for all four -- the layer, the root the follow drives, the one
 * material the built meshes carry, and the attached node. The generation
 * side keeps them apart, so an axis-drag handle cannot reach a rotation
 * gizmo's attach call.
 */
struct EditGizmoHandle {
    std::uint32_t value = invalid_handle;
};

/** The pointer interaction owned by one editing gizmo. */
struct PointerDragHandle {
    std::uint32_t value = invalid_handle;

    // PointerDrag is an upstream object. Its native handle is the stable
    // engine-owned identity used by strict equality in editor hover state.
    [[nodiscard]] bool operator==(
        const PointerDragHandle&) const = default;
};

/**
 * A composite gizmo: the sub-widget handles the pinned composite holds.
 *
 * `gizmo/composite-gizmos.ts` models `PositionGizmo`, `RotationGizmo` and
 * `ScaleGizmo` as records of already-built sub-gizmos and nothing else --
 * their `attachedNode` mirror is written and never read back -- so this is
 * that list. `local_coordinate_count` is how many of the leading entries
 * the composite's own `set<X>GizmoLocalCoordinates` fans out over: every
 * one for position and rotation, and every axis handle but the trailing
 * central uniform one for scale, which BJS keeps world-aligned. Six slots
 * because the widest composite is the position gizmo's three arrows plus
 * its three optional planar handles.
 */
struct CompositeGizmoHandle {
    std::array<EditGizmoHandle, 6> parts{};
    std::uint32_t part_count = 0;
    std::uint32_t local_coordinate_count = 0;
};

/**
 * The bounding-box gizmo, whose record the per-frame layout mutates.
 *
 * It is its own handle rather than an editing widget's because it holds a
 * cage of meshes rather than one root, and because its attach target is a
 * transform node rather than a mesh.
 */
struct BoundingBoxGizmoHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * Which collection a pick resolved into.
 *
 * Upstream `PickingInfo.pickedMesh` is one object reference whatever was
 * hit, because a mesh and a Gaussian cloud are both SceneNodes there. This
 * port keeps them in separate collections, so the identity is the pair --
 * and the name, which is all the reached slice reads, is resolved once at
 * pick time rather than re-derived at every read.
 */
#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
#include <bblite/runtime/picking-records.hpp>
#endif

/**
 * The picker's own state. The GPU resources it owns live with the renderer
 * -- only the renderer knows how to make them -- so this record carries the
 * scene it picks in and the slot the backend keeps its resources under.
 */
struct SceneState;
struct TextRenderableState;
struct TextLayerState;
struct TextRendererState;
struct TextDataState;
struct NodeInputState;
using NodeInputHandle = std::shared_ptr<NodeInputState>;
struct NodeMaterialInputsState;
struct NodeMaterialGroupState;
#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
struct GpuPickerRecord {
    std::weak_ptr<SceneState> scene;
    bool disposed = false;
    /**
     * The pin's `_detailedPicking`, which `enableDetailedPicking` arms and
     * every later `pickAsync` on this picker reads. It selects a different
     * pinned PIPELINE MODULE upstream, and here a different pipeline and a
     * third attachment, so it belongs to the picker rather than the call.
     */
    bool detailed = false;
};

#endif
/** One light in a clustered container, at the pin's own resolved defaults. */
struct ClusteredLight {
    std::array<double, 3> position{};
    std::array<double, 3> diffuse{};
    double range = 1.0;
    double intensity = 1.0;
    /** Spot only; a point light leaves the cone unset. */
    std::array<double, 3> direction{};
    double angle = 0.0;
    bool spot = false;
};

/**
 * A clustered light field: a large point/spot set binned into screen tiles
 * and depth slices so a PBR fragment can shade hundreds of lights.
 *
 * The sizing fields below are baked when the container is added -- the pin
 * fixes both the light capacity and the point-versus-spot stride there, and
 * its own refresh throws rather than growing either.
 */
struct ClusteredLightContainer {
    double horizontal_tiles = 64.0;
    double vertical_tiles = 64.0;
    double z_slices = 16.0;
    std::vector<ClusteredLight> lights;
    /** Set when any light in the container is a spot. */
    bool has_spots = false;

    std::uint32_t tile_count_x = 1;
    std::uint32_t tile_count_y = 1;
    std::uint32_t slice_count = 1;
    std::uint32_t data_texture_width = 1;
    std::uint32_t light_texels = 1;
    std::uint32_t mask_texels = 1;
    /** The rows each payload occupies, so no backend derives an extent. */
    std::uint32_t light_rows = 1;
    std::uint32_t slice_rows = 1;
    std::uint32_t mask_rows = 1;

    /** Three texels per light once the container holds a spot. */
    [[nodiscard]] std::uint32_t stride() const {
        return has_spots ? 3u : 2u;
    }

    /** The extent one payload's upload covers. */
    struct UploadRegion {
        std::uint32_t width;
        std::uint32_t height;
    };

    /**
     * The pin's own `writeDataTexture` region, so neither backend invents one.
     *
     * A payload that fits in a single row is uploaded only as wide as it is
     * long; past that the rows are full width. Nothing outside the region is
     * read -- the fragment's `textureLoad` never walks past the active texel
     * count -- so this is the pin's rule kept rather than a correctness
     * requirement, and keeping it is what makes a backend's upload comparable
     * to a browser capture of the same frame.
     */
    [[nodiscard]] UploadRegion upload_region(
        std::uint32_t texels,
        std::uint32_t rows) const {
        const std::uint32_t height = std::max(1u, rows);
        return {
            height > 1 ? data_texture_width
                       : std::max(1u, std::min(texels, data_texture_width)),
            height,
        };
    }

    /** The three data-texture payloads and the params block. */
    std::vector<float> light_data;
    std::vector<std::uint32_t> slice_data;
    std::vector<std::uint32_t> mask_data;
    /** Six u32 lanes and two f32 ones: the pin's ArrayBuffer(32), both ways. */
    std::array<std::uint32_t, 8> params{};
    /** Bumped whenever a refresh rewrote a payload. */
    std::uint64_t upload_version = 0;

    /**
     * The pin's own dirty key, in the terms this port has for it.
     *
     * Upstream compares camera identity, `_cameraChangeKey`, the target
     * extent and the effective aspect -- four proxies for one question: does
     * this frame project lights into different tiles than the last did. The
     * two matrices the cull reads answer it directly, and the light half of
     * that key folds away because nothing here can mutate a light after
     * creating it.
     */
    std::array<float, 16> last_view{};
    std::array<float, 16> last_proj{};
    bool binned = false;
};

enum class PrimitiveKind {
    babylon,
    box,
    gltf,
    ground,
    sphere,
    torus,
};

enum class CameraKind {
    arc_rotate,
    free,
    // src/camera/geospatial-camera.ts: a camera that orbits a spherical
    // planet centred at the world origin. Its eye is derived state like the
    // free camera's -- the pin's own `position` -- rather than composed from
    // alpha/beta/radius the way an ArcRotate's is.
    geospatial,
};

enum class LightKind {
    directional,
    hemispheric,
    point,
    spot,
};

enum class MaterialAlphaMode {
    opaque,
    mask,
    blend,
};

/**
 * The record lane a property clip animates.
 *
 * Upstream a path is any dotted string, resolved by
 * `resolvePropertyBinding` against the object the group was bound to: the
 * walk ends on an owner and a final property name, and the writer stores
 * either the whole value or the one component the path named. So a lane is
 * what the port enumerates and a component is carried beside it — the same
 * split the pin makes, rather than one enumerator per spelled path.
 */
enum class GeometryTextureType {
    irradiance,
    world_position,
    local_position,
    reflectivity,
    view_depth,
    normalized_view_depth,
    screenspace_depth,
    view_normal,
    world_normal,
    albedo,
    linear_velocity,
};

enum class GeometryTextureFormat {
    automatic,
    r16_float,
};

struct GeometryTextureDescription {
    GeometryTextureType type = GeometryTextureType::irradiance;
    GeometryTextureFormat format = GeometryTextureFormat::automatic;
};

/**
 * `NormalizedViewport` (src/camera/camera.ts): the fraction of a render
 * target something draws into, with `y` measured from the BOTTOM the way
 * Babylon measures it. One type for every reader, because upstream has one:
 * `resolveCameraViewport` takes `camera?.viewport ?? FULL_VIEWPORT`, and
 * `FULL_VIEWPORT` is this.
 *
 * Doubles for the reason every camera scalar is one -- the pin holds them as
 * JavaScript numbers, and every reader divides or multiplies them before any
 * float32 store or pixel rounding.
 */
struct NormalizedViewport {
    double x = 0.0;
    double y = 0.0;
    double width = 1.0;
    double height = 1.0;
};

/**
 * The pixels a normalized viewport covers on a given target.
 *
 * Which pixels is the pin's question and each frame-graph task answers it its
 * own way -- a copy task rounds its far edges down, a post-process pass rounds
 * them up -- so only the rectangle is shared, never the rounding.
 */
struct PixelViewport {
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::int32_t width = 0;
    std::int32_t height = 0;
};

/**
 * A texture format, as the classes this port's two backends both express.
 *
 * Each backend only translates the class to its API's format constant, so a
 * record naming one says the same thing to both. The geometry attachments
 * choose theirs by lane (`pbr-geometry-output-shader.ts`): reflectivity and
 * albedo pack into rgba8, VIEW_DEPTH keeps full float precision, the
 * normalized and screenspace depths take r16 -- as does any attachment whose
 * description asks for it -- and every other lane is rgba16. A post-process
 * composite names its own instead: the circle-of-confusion map is r16. The
 * screen-space effects name theirs too: a contact-shadow producer writes
 * `r8unorm` occlusion and its temporal history keeps `rg16float`, value in
 * `.r` and view distance in `.g` (`screen-space-temporal.ts`).
 */
enum class TextureFormatClass {
    rgba8_unorm,
    r8_unorm,
    r16_float,
    rg16_float,
    r32_float,
    rgba16_float,
};

/**
 * How a target sized as a fraction of another rounds that fraction.
 *
 * A post-process composite's intermediate takes the pin's
 * `max(1, floor(extent * ratio))`; a screen-space effect's owned targets take
 * `computeScreenSpaceScaledSize`, which rounds to nearest. Both are the pin's
 * own arithmetic, so the record names which one and the backend calls the
 * generated rule rather than restating either.
 */
enum class ScaleRounding {
    floor,
    round,
};

struct RenderTargetOptions {
    std::uint32_t samples = 1;
    bool has_color = true;
    bool has_depth = false;
    bool sampled_depth = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /**
     * A target sized as a fraction of another, rather than in pixels or by the
     * canvas. A post-process composite owns its intermediates and sizes each
     * from its source every time the graph is built, so a window resize moves
     * them with it. `scale_source` must already exist: the composite creates
     * its own intermediates after the source it scales from.
     */
    RenderTargetHandle scale_source{};
    double width_ratio = 1.0;
    double height_ratio = 1.0;
    /** The colour format, when the target does not take the surface's. */
    TextureFormatClass format = TextureFormatClass::rgba8_unorm;
    bool has_format = false;
    /** See `RenderTargetRecord::shadow_map`. */
    bool shadow_map = false;
    /** See `RenderTargetRecord::depth_layers`. */
    std::uint32_t depth_layers = 1;
    /** See `RenderTargetRecord::scale_rounding`. */
    ScaleRounding scale_rounding = ScaleRounding::floor;
};

enum class RenderTextureSource {
    render_target,
    geometry,
    geometry_output,
    /** A geometry task's own depth attachment, aliased by the pin's eager
     *  wrapper target: a later pass binds and loads it rather than owning it. */
    geometry_depth,
};

struct RenderTextureRef {
    RenderTextureSource source = RenderTextureSource::render_target;
    RenderTargetHandle target{};
    TaskHandle task{};
    GeometryTextureType geometry_type = GeometryTextureType::irradiance;
};

struct RenderTaskOptions {
    std::string name;
    RenderTargetHandle target{};
    Color4 clear_color{};
    bool clear = false;
    CameraHandle camera{};
    bool has_camera = false;
    bool canvas_size = false;
    bool auto_mirror = true;
    /**
     * This is the compiler-owned default scene pass. Unlike an arbitrary
     * render task, it must retain the scene renderer's non-mesh stages
     * (skyboxes before the mirrored draw lists and ground after them).
     */
    bool scene_stages = false;
    /**
     * A depth attachment owned by another task, bound instead of the target's
     * own — `geometry_depth` when the scene named one, and the default
     * `render_target` when it did not. The pin marks such a target eager, so
     * the pass loads the depth already in it and neither builds nor disposes
     * it.
     */
    RenderTextureRef depth{};
    /**
     * A single-sample target the colour attachment resolves into at
     * end-of-pass, so an MSAA render can feed a post-process that needs a
     * single-sample source without a separate resolve pass. Only read when
     * the task's own target is multisampled, which is the pin's rule.
     */
    RenderTargetHandle resolve_target{};
    /**
     * The generator this pass renders the shadow map for.
     *
     * The pin builds a `RenderTask` per PCF generator and installs the
     * light-space matrices on a camera facade whose caches it pins
     * (`updateShadowCameraBase`), so the pass reads them straight back
     * instead of composing a perspective from a camera record. There is no
     * such facade here: the task names its generator and the frame builds
     * the pass's scene block from that generator's own biased
     * view-projection.
     */
    ShadowGeneratorHandle shadow_generator{};
    /**
     * Which layer of the target's depth attachment this pass writes.
     *
     * Zero for every pass but a cascaded shadow generator's, whose casters
     * are drawn once per cascade into one layer each of the generator's
     * `depth32float` array. It also selects which fitted cascade's matrices
     * the pass renders through.
     */
    std::uint32_t depth_layer = 0;
};

struct RenderTaskMesh {
    MeshHandle mesh{};
    MaterialHandle material{};
};

struct GeometryTaskOptions {
    std::string name;
    std::uint32_t shader_index = 0;
    std::uint32_t samples = 1;
    std::vector<GeometryTextureDescription> attachments;
    RenderTargetHandle target{};
    bool clear_target = false;
    Color4 target_clear_color{};
};

struct CopyTaskOptions {
    std::string name;
    RenderTextureRef source{};
    RenderTargetHandle target{};
    RenderTargetHandle resolve_target{};
    bool has_viewport = false;
    NormalizedViewport viewport{};
};

/**
 * A WebGPU blend factor, as this runtime's own enumerator, and the four a
 * blend state carries. The operation is always add — the pinned descriptors
 * this port reaches never write another one — so a state is its factors.
 * Generated code names these (the post-process alpha modes) and so does every
 * blending pipeline in both backends, which is why they sit with the records
 * rather than in a PAL header.
 */
enum class BlendFactor {
    one,
    src_alpha,
    one_minus_src_alpha,
};

struct BlendFactors {
    BlendFactor src_color = BlendFactor::one;
    BlendFactor dst_color = BlendFactor::one;
    BlendFactor src_alpha = BlendFactor::one;
    BlendFactor dst_alpha = BlendFactor::one;
};

enum class PostProcessSampling {
    nearest,
    linear,
};

/**
 * A fullscreen pass that samples one texture and writes another.
 *
 * Every post-process effect Babylon Lite ships is this pass with a different
 * composed stage, so the record carries the pass and the effect's parameter
 * vector rather than one struct per effect. `shader_index` selects both the
 * deployed stage pair and the generated uniform writer; passes are numbered in
 * the order generation reached them, a composite's own passes included.
 */
struct PostProcessPassOptions {
    std::string name;
    std::uint32_t shader_index = 0;
    RenderTextureRef source{};
    /** The target the caller named, or an invalid handle for none. */
    RenderTargetHandle target{};
    PostProcessSampling sampling = PostProcessSampling::linear;
    /** The pin's `PostProcessAlphaMode`: 0, 1, 2 or 7. */
    std::uint32_t alpha_mode = 0;
    bool has_viewport = false;
    NormalizedViewport viewport{};
    bool clear = true;
    /** The views the effect binds after the source, in its own order. */
    std::vector<RenderTextureRef> extra_textures;
    /** Read by the effects whose uniforms carry the camera planes. */
    CameraHandle camera{};
    /** The effect's own `params`, in the order its writer reads them. */
    std::vector<double> params;
    /** Resolved at creation: the caller's target, or the pass's own. */
    RenderTargetHandle output_target{};
    /** Set by `updateUniforms`, cleared when a backend rewrites the block. */
    bool uniforms_dirty = true;
};

/** Retained scalar state for the pinned TAA execute/record lifecycle. */
struct TaaPostProcessState {
    double factor;
    bool disable_on_camera_move;
    bool first_update;
    double last_camera_version;
    double halton_index;
    std::vector<float> halton{};
    std::array<float, 16> jitter_scratch{};
    /** Diagnostic completed executions across GPU resource rebuilds. */
    std::uint64_t execution_count = 0;
};

/**
 * The task the scene added, and the passes it records.
 *
 * A plain effect records one. A composite -- depth of field -- records the
 * chain its own factory built, over intermediate targets it owns, and the
 * caller still sees one task: one `addTask`, one `updateUniforms`, one output.
 * So the task holds a list and the single-pass case is a list of one, rather
 * than the composites being a second kind of task beside this one.
 */
struct PostProcessTaskOptions {
    std::string name;
    std::vector<PostProcessPassOptions> passes;
    /** The facade's output, independent of the order its passes execute. */
    std::uint32_t output_pass = 0;
    RenderTargetHandle output_target{};
    std::vector<TaskHandle> source_tasks{};
    std::shared_ptr<TaaPostProcessState> taa{};
};

/**
 * What a composite reads from the scene.
 *
 * Everything else about it -- how many passes, over which intermediates, at
 * which sizes -- was settled at generation by running the pin's own factory,
 * so the generated `create_composite_post_process_task_N` carries the chain
 * and takes only this.
 *
 * The source is a render target rather than any render texture because the
 * composite sizes its own intermediates from it; the pin refuses a source
 * without a format for the same reason.
 */
struct PostProcessCompositeInputs {
    std::string name;
    RenderTargetHandle source{};
    /** The composite's own config textures, in its descriptor's order. */
    std::vector<RenderTextureRef> extra_textures;
    /** The target the caller named, or an invalid handle for none. */
    RenderTargetHandle target{};
    CameraHandle camera{};
    /** Source render tasks, in the composite descriptor's declared order. */
    std::vector<TaskHandle> source_tasks{};
};

/**
 * An `EffectRenderTask`: the same draw, into a target the caller owns.
 *
 * The clear state carries no default here, and neither do its two siblings
 * below: the pin's `clear !== false` and `clearColor ?? opaque black` are
 * asserted at generation and emitted explicitly at every call site, so a
 * default in this file would be a fourth statement of a pinned value that
 * nothing exercises and nothing checks.
 */
struct EffectTaskOptions {
    std::string name;
    EffectWrapperHandle effect{};
    RenderTargetHandle target{};
    bool clear = false;
    Color4 clear_color{};
};

/** Which of the pin's two screen-space producers a task runs. */
enum class ScreenSpaceEffectKind {
    contact_shadows,
    global_illumination,
};

/**
 * The pin's `lightDirection`, which the contact-shadow task keeps by
 * reference and normalizes every frame. A scene that passed a light's own
 * `direction` reads that record live; one that passed a literal keeps the
 * value.
 */
struct ScreenSpaceLightDirection {
    LightHandle light{};
    Vec3d value{};
};

/**
 * The closure state one screen-space task carries between frames: the
 * pin's `execute` locals (`firstFrame`, `lastEnabled`, `accumulatedSamples`,
 * `phaseIndex`, ...) and the temporal owner's previous matrices. Written
 * only by the generated frame function lowered from those bodies.
 */
struct ScreenSpaceTemporalState {
    bool first_frame = true;
    bool pending_reallocation = false;
    /**
     * The pin's `lastEnabled` starts `undefined`, which every read treats
     * as false (`if (lastEnabled)`, `!lastEnabled`), so false is its value.
     */
    bool last_enabled = false;
    /**
     * The pin's `lastResetVersion` starts `undefined`, and `resetVersion
     * !== undefined` is true -- an empty optional compares unequal to any
     * number the same way.
     */
    std::optional<double> last_reset_version;
    double accumulated_samples = 1.0;
    double phase_index = 0.0;
    bool prev_inv_view_proj_null = false;
    std::array<float, 16> prev_view_proj{};
    std::array<float, 16> prev_view{};
    /** The `_depthTexture` / `_colorTexture` identities the pin remembers. */
    std::uint32_t last_depth_allocation = 0;
    std::uint32_t last_color_allocation = 0;
    /** The owned targets' identities the pin's `record` compared sizes by. */
    std::uint32_t seen_raw_allocation = 0;
    std::uint32_t seen_stable_allocation = 0;
    std::uint32_t seen_history_allocation = 0;
};

/**
 * A screen-space contact-shadow or global-illumination task
 * (`screen-space-contact-shadows.ts`, `screen-space-global-illumination.ts`).
 *
 * The pin builds two dedicated pipelines -- a producer that raymarches the
 * depth attachment through a depth-only view, and the shared temporal
 * resolve -- and two ordinary post-process passes, the history copy and the
 * optional composite. The ordinary passes live in the owning
 * `FrameTaskRecord::post_process`; this record holds what the pin keeps on
 * the task object itself: its settings, its owned targets and its temporal
 * state. Settings marked live are sampled every frame, as the pin samples
 * `task.*` inside `execute`.
 */
struct ScreenSpaceTaskOptions {
    std::string name;
    ScreenSpaceEffectKind kind = ScreenSpaceEffectKind::contact_shadows;
    RenderTargetHandle source{};
    /** `config.depthTexture ?? sourceTexture`. */
    RenderTargetHandle depth{};
    /** The composite's target, or an invalid handle for the pass's own. */
    RenderTargetHandle target{};
    CameraHandle camera{};
    ScreenSpaceLightDirection light_direction{};
    /** The pin's clamped `params`, fixed at creation. */
    double resolution_scale = 1.0;
    double temporal_samples = 32.0;
    /** Live settings shared by both kinds. */
    bool enabled = true;
    double intensity = 0.0;
    double step_count = 0.0;
    double thickness = 0.0;
    double bias = 0.0;
    double temporal_weight = 0.0;
    double reset_version = 0.0;
    /** Live contact-shadow settings. */
    std::array<double, 3> tint{};
    double max_distance = 0.0;
    double normal_bias = 0.0;
    double spatial_radius = 0.0;
    /** Live global-illumination settings. */
    double ray_count = 0.0;
    double ray_length = 0.0;
    double fade_start = 0.0;
    double fade_end = 0.0;
    double edge_fade = 0.0;
    double color_bleed_gain = 0.0;
    double color_bleed_max = 0.0;
    /** The deployed producer and resolve stages, by generated table index. */
    std::uint32_t producer_shader = 0;
    std::uint32_t resolve_shader = 0;
    /** The targets the task owns, created and sized from `depth`. */
    RenderTargetHandle raw{};
    RenderTargetHandle stable{};
    RenderTargetHandle history{};
    /** `composite ? composite.outputTexture : owner.stableTexture`. */
    RenderTargetHandle output_target{};
    ScreenSpaceTemporalState state{};
};

/**
 * What a backend tells the generated frame function about this frame.
 *
 * The allocation ids stand in for the `GPUTexture` identities the pin
 * compares: a backend numbers each target's textures when it creates them,
 * so a rebuilt source, depth or owned target reads as a different object
 * exactly where the pin's `identityChanged` would. Zero means never built.
 */
struct ScreenSpaceFrameInputs {
    std::uint32_t depth_width = 0;
    std::uint32_t depth_height = 0;
    std::uint32_t effect_width = 0;
    std::uint32_t effect_height = 0;
    std::uint32_t depth_allocation = 0;
    std::uint32_t color_allocation = 0;
    std::uint32_t raw_allocation = 0;
    std::uint32_t stable_allocation = 0;
    std::uint32_t history_allocation = 0;
};

/**
 * What the generated frame function decided, which the backend encodes in
 * the pin's own order: the identity clear (both temporal targets zeroed
 * once on the enabled-to-disabled transition or a singular view-projection
 * inverse), then the producer, resolve and history-copy passes when the
 * effect runs, then the composite pass whenever the task has one. The two
 * blocks are sized by the pin's constants, which generation asserts.
 */
struct ScreenSpaceFrameDecision {
    bool clear_identity = false;
    bool run_effect = false;
    std::array<float, 48> producer_uniforms{};
    std::array<float, 72> temporal_uniforms{};
};

enum class FrameTaskKind {
    render,
    geometry,
    copy,
    screen_space,
    post_process,
    effect,
};

struct RenderTargetRecord {
    std::uint32_t samples = 1;
    bool has_color = true;
    bool has_depth = false;
    bool sampled_depth = false;
    bool swapchain = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** See `RenderTargetOptions::scale_source`. */
    RenderTargetHandle scale_source{};
    double width_ratio = 1.0;
    double height_ratio = 1.0;
    TextureFormatClass format = TextureFormatClass::rgba8_unorm;
    bool has_format = false;
    /**
     * This target is a shadow generator's own map
     * (`createShadowRenderTarget`), which is the pin's ONE exception to
     * every convention the frame's attachments take: a `depth32float`
     * format sampled through a comparison sampler, standard-Z rather than
     * this port's reverse-Z, and a far clear of 1 rather than 0.
     *
     * The flag says which target it is; the four values it implies are the
     * `shadow_map_depth_*` constants generation emits from the pinned
     * descriptor, so no PAL types one out.
     */
    bool shadow_map = false;
    /**
     * How many array layers this target's DEPTH attachment carries.
     *
     * One for every target but the cascaded shadow map, whose pinned
     * factory allocates `depth32float` at
     * `size.depthOrArrayLayers = numCascades` and renders each cascade into
     * a single-layer view of it. The layer a pass writes rides on the TASK
     * (`RenderTaskOptions::depth_layer`), so the texture keeps one owner and
     * no pass borrows a depth it would then have to not release.
     */
    std::uint32_t depth_layers = 1;
    /** Which pinned rounding sizes this target from `scale_source`. */
    ScaleRounding scale_rounding = ScaleRounding::floor;
    /** Canvas-sized default graph targets inherit their scene's surface. */
    std::optional<UiElementHandle> surface_canvas{};
};

/** The pin's mixed cache tuple, named by its seven identity/value inputs. */
struct SceneUniformCache {
    const void* camera = nullptr;
    std::uint64_t fog = 0;
    double camera_key = 0.0;
    double aspect = 0.0;
    double exposure = 0.0;
    double contrast = 0.0;
    std::uint64_t environment = 0;
};

/** CPU storage survives render-task GPU resource rebuilds. */
struct PersistentSceneUniforms {
    SceneUniformCache cache{};
    std::vector<float> clean{};
    std::vector<float> drawn{};
};

struct FrameTaskRecord {
    FrameTaskKind kind = FrameTaskKind::render;
    RenderTaskOptions render;
    std::vector<RenderTaskMesh> render_meshes;
    GeometryTaskOptions geometry;
    CopyTaskOptions copy;
    /**
     * A post-process task's passes; also a screen-space task's two ordinary
     * passes, the history copy at index 0 and the composite at index 1 when
     * the task composes (`ScreenSpaceTaskOptions`).
     */
    PostProcessTaskOptions post_process;
    EffectTaskOptions effect;
    ScreenSpaceTaskOptions screen_space;
    /** The task retains the scene passed to its factory, independent of registration. */
    std::shared_ptr<SceneState> source_scene{};
    /** Allocated only for a source whose retained UBO is reached by TAA. */
    std::shared_ptr<PersistentSceneUniforms> scene_uniforms{};
};

struct RenderTargetTexture {
    RenderTargetHandle rt{};
    RenderTextureRef texture{};
};

/**
 * A 1x1 texture `createSolidTexture2D` built.
 *
 * The pin writes `Math.round(channel * 255)` into an `rgba8unorm` texel
 * (`solid-texture.ts`), so the byte IS the texture and the float is only how
 * the caller spelled it. `create_solid_texture` performs that rounding once,
 * under the contract `factory-lowerer.ts` asserts against the pinned call,
 * and everything downstream reads the result: no consumer re-derives the
 * formula, which is what kept three spellings of it in the tree.
 */
struct SolidTexture {
    Color4 color{};
    std::array<std::uint8_t, 4> texel{};
    // Solid textures enter StoredTexture's FileTexture arm; share its ID space.
    std::uint64_t identity = 0;
};

struct PbrMaterialOptions {
    SolidTexture base_color{};
    Color4 base_color_factor{1.0f, 1.0f, 1.0f, 1.0f};
    bool has_base_color_texture = false;
    std::shared_ptr<std::vector<double>> source_base_color_factor{};
    SolidTexture orm{};
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    float direct_intensity = 1.0f;
    float environment_intensity = 1.0f;
    float alpha = 1.0f;
    bool alpha_blend = false;
    // Pinned default: the dielectric F0 the PBR material seeds (0.04).
    float reflectance = 0.04f;
    bool unlit = false;
    bool double_sided = false;
    bool specular_aa = false;
    bool skybox_mode = false;
    float transmission_factor = 0.0f;
    // Pinned default: gltf-ext-dielectric.ts treats ior 1.5 as neutral.
    float index_of_refraction = 1.5f;
    float thickness = 0.0f;
    bool use_thickness_as_depth = false;
    bool has_volume = false;
    Color3 attenuation_color{1.0f, 1.0f, 1.0f};
    float attenuation_distance = 1.0f;
    float occlusion_strength = 1.0f;
    float metallic_f0_factor = 1.0f;
    // The pin's `usePhysicalLightFalloff`, whose default is true: a point or
    // spot light attenuates by inverse square, and the spot cone by the
    // physical exponential. False takes the Standard-style linear range and
    // spot exponent instead. Both arms are composed into every punctual
    // fragment; this is the lane that selects one (`_writeMaterialData`).
    bool use_physical_light_falloff = true;
};

struct GridMaterialOptions {
    Color3 main_color{0.0f, 0.0f, 0.0f};
    Color3 line_color{0.0f, 0.5f, 0.5f};
    float grid_ratio = 1.0f;
    Vec3 grid_offset{};
    float major_unit_frequency = 10.0f;
    float minor_unit_visibility = 0.33f;
    float opacity = 1.0f;
    float visibility = 1.0f;
    bool antialias = true;
    bool pre_multiply_alpha = false;
    bool use_max_line = false;
    bool back_face_culling = true;
};

enum class TextureFilter {
    nearest,
    linear,
};

enum class TextureMipmapMode {
    nearest,
    linear,
};

enum class TextureAddressMode {
    repeat,
    clamp,
    mirror,
};

struct TextureSamplerState {
    TextureFilter min_filter = TextureFilter::linear;
    TextureFilter mag_filter = TextureFilter::linear;
    TextureMipmapMode mipmap_mode = TextureMipmapMode::linear;
    TextureAddressMode address_u = TextureAddressMode::repeat;
    TextureAddressMode address_v = TextureAddressMode::repeat;
    float max_anisotropy = 1.0f;
    float max_lod = 1000.0f;
};

/**
 * The pin's `Texture2D` transform properties (`texture-2d.ts`).
 *
 * Upstream these are plain fields on the one `Texture2D` every loader and
 * factory returns, read by `writeUvTransformData` when a material marked by
 * `enableMaterialUvTransform` builds its renderable. A texture nothing marks
 * never has them read, which is why the defaults are the identity rather than
 * a "has transform" flag: the pin has no such flag either.
 */
struct TextureUvTransform {
    // Plain JavaScript numbers upstream, which `writeUvTransformData` reads
    // into a rotation and a scale before its single float32 store -- so they
    // are doubles here for the same reason `CameraRecord`'s scalars are.
    // Rounding them on the record would round one step early.
    double u_scale = 1.0;
    double v_scale = 1.0;
    double u_offset = 0.0;
    double v_offset = 0.0;
    double u_ang = 0.0;
};

/** One mip level of a compressed texture, as its container stores it. */
struct CompressedMipLevel {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::span<const std::uint8_t> bytes;
};

/**
 * A texture whose bytes are already GPU blocks.
 *
 * `ktx-loader.ts` and `basis-loader.ts` both end at
 * `device.queue.writeTexture` over a block-compressed format, with the mip
 * chain the container carries rather than one the engine blits — so nothing
 * here is decoded, and the chain is uploaded as it arrives.
 *
 * `format` is the pin's own WebGPU format name (`bc2-rgba-unorm`), which is
 * what each backend translates: the name is the pinned table's, so a format
 * the pin adds needs no enumerator here. It is a view into the generated
 * format table's static storage, which is the only thing that ever fills it.
 */
struct CompressedTexture {
    std::string_view format{};
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t block_width = 0;
    std::uint32_t block_height = 0;
    std::uint32_t block_bytes = 0;
    // Mip spans share the immutable container across texture/material copies.
    std::shared_ptr<const std::vector<std::uint8_t>> storage;
    std::vector<CompressedMipLevel> mips;
};

/**
 * Immutable-in-practice texture payload with copy-on-write value semantics.
 *
 * Texture objects are freely copied into material slots. Sharing their byte
 * backing keeps those copies O(1), while a later loader mutation still
 * detaches and preserves the old value-shaped behavior.
 */
class SharedTextureBytes {
public:
    using Storage = std::vector<std::uint8_t>;
    using iterator = Storage::iterator;
    using const_iterator = Storage::const_iterator;

    SharedTextureBytes() : storage_(std::make_shared<Storage>()) {}
    SharedTextureBytes(Storage bytes)
        : storage_(std::make_shared<Storage>(std::move(bytes))) {}

    SharedTextureBytes& operator=(Storage bytes) {
        storage_ = std::make_shared<Storage>(std::move(bytes));
        return *this;
    }

    [[nodiscard]] bool empty() const { return storage_->empty(); }
    [[nodiscard]] std::size_t size() const { return storage_->size(); }
    [[nodiscard]] const std::uint8_t* data() const { return storage_->data(); }
    [[nodiscard]] std::uint8_t* data() {
        detach();
        return storage_->data();
    }
    [[nodiscard]] const_iterator begin() const { return storage_->begin(); }
    [[nodiscard]] const_iterator end() const { return storage_->end(); }
    [[nodiscard]] iterator begin() {
        detach();
        return storage_->begin();
    }
    [[nodiscard]] iterator end() {
        detach();
        return storage_->end();
    }
    [[nodiscard]] const std::uint8_t& operator[](std::size_t index) const {
        return (*storage_)[index];
    }
    [[nodiscard]] std::uint8_t& operator[](std::size_t index) {
        detach();
        return (*storage_)[index];
    }

    template <typename Iterator>
    void assign(Iterator first, Iterator last) {
        storage_ = std::make_shared<Storage>(first, last);
    }

    [[nodiscard]] operator const Storage&() const { return *storage_; }

private:
    void detach() {
        if (storage_.use_count() != 1) {
            storage_ = std::make_shared<Storage>(*storage_);
        }
    }

    std::shared_ptr<Storage> storage_;
};

struct TextureData {
    SharedTextureBytes bytes;
    // When both are non-zero, `bytes` are RGBA texels at this size rather
    // than an encoded image. `createTexture2DFromPixels` hands over the
    // caller's own bytes where every loader hands over a file, and the pin
    // has one `Texture2D` for both — so one material slot has to hold
    // either, and the size is what says which.
    std::uint32_t rgba_width = 0;
    std::uint32_t rgba_height = 0;
    TextureUvTransform uv_transform{};
    TextureSamplerState sampler{};
    // The pin's *upload* flip: `loadTexture2D`'s `invertY` option, passed as
    // `flipY` to `copyExternalImageToTexture` (texture-2d.ts). The PALs'
    // shared `decode_uploadable_image` applies it as a row swap.
    bool invert_y = false;
    // `createImageBitmap({ premultiplyAlpha: "premultiply" })` followed by
    // `copyExternalImageToTexture({ premultipliedAlpha: true })` in the pin.
    // The shared decode path applies the same byte transform before upload.
    bool premultiply_alpha = false;
    // The pin's texture-OBJECT `invertY` property, a different thing from
    // the upload flip above: `loadTexture2D` results never carry the
    // property (its option only drives the flipped copy), so every image
    // texture a loader or compiled setter creates leaves this false. The
    // objects that do carry `invertY: true` are the ones whose pixels reach
    // the GPU un-flippable or already top-down — KTX2/Basis and
    // texture-array uploads, and colour render-target textures (rtt.ts;
    // depth RTTs carry false) — and `isStandardUvInverted`
    // (standard-pipeline.ts) reads exactly that property when it decides
    // the Standard UV transform's v flip. Scene 9's browser capture
    // carries `up = [1, 1, 0, 0]` for all 32 materials and Scene 24's for
    // 127 of 128, which is that property evaluating false over `.babylon`
    // textures.
    bool uv_invert_y = false;
    // GPU blocks viewed directly in their shared container storage.
    CompressedTexture compressed{};

    /**
     * Whether this slot carries an image at all.
     *
     * An encoded file and `createTexture2DFromPixels` texels both land in
     * `bytes`; a compressed container's blocks land beside it. So every
     * "does this material have this texture" test asks here rather than
     * testing one field — a second predicate for the same fact is what
     * drifts.
     */
    bool has_image() const {
        return !bytes.empty() || !compressed.mips.empty();
    }
};

struct FileTexture {
    TextureData data{};
    bool srgb = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** JavaScript Texture2D object identity for array search and aliases. */
    std::uint64_t identity = 0;
};

/** Texture2D's per-device URL/options cache, projected onto native samplers. */
inline std::string file_texture_cache_key(
    const std::string& path, const TextureSamplerState& sampler,
    bool invert_y, bool srgb, bool premultiply_alpha) {
    std::string key = path;
    key.push_back('\0');
    for (const auto value : {static_cast<unsigned>(sampler.min_filter), static_cast<unsigned>(sampler.mag_filter),
        static_cast<unsigned>(sampler.mipmap_mode), static_cast<unsigned>(sampler.address_u),
        static_cast<unsigned>(sampler.address_v), static_cast<unsigned>(sampler.max_lod != 0),
        static_cast<unsigned>(invert_y), static_cast<unsigned>(srgb), static_cast<unsigned>(premultiply_alpha)}) {
        key.push_back(static_cast<char>(value));
    }
    return key;
}

/**
 * A texture built from bytes the caller supplied (`pixels-texture.ts`).
 *
 * Unlike a file texture there is nothing to decode: the compiler baked the
 * module's own bytes, so these are the RGBA texels themselves and the size is
 * the caller's rather than an image header's.
 */
struct PixelsTexture {
    SharedTextureBytes rgba;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** Whether the RGBA8 bytes are sampled through the sRGB format view. */
    bool srgb = false;
    /** Object identity shared by copies bound into sprite descriptors. */
    std::uint64_t identity = 0;
    /** Incremented whenever a reached queue write replaces the texels. */
    std::uint64_t version = 1;
    TextureSamplerState sampler{};
    // The `Texture2D` properties a scene writes on the result before binding
    // it: the per-texture transform `enableMaterialUvTransform` reads, and
    // the texture-object `invertY` that both that transform and
    // `isStandardUvInverted` fold.
    TextureUvTransform uv_transform{};
    bool uv_invert_y = false;
};

inline bool operator==(
    const FileTexture& left,
    const FileTexture& right) {
    return left.identity == right.identity;
}

inline bool operator==(
    const PixelsTexture& left,
    const PixelsTexture& right) {
    return left.identity == right.identity;
}

// Texture2D is one upstream interface with multiple reached producers. Plain
// data records therefore need storage that preserves either a decoded file
// texture or caller-supplied pixels without changing the source type.
using StoredTexture = std::variant<FileTexture, PixelsTexture>;

/**
 * One texture a `MaterialPlugin` binds (`plugin-bridge-shared.ts`).
 *
 * `getSamplers()` declares the binding pair and `bindTextures(out)` fills
 * it, so what the record has to carry is the texture payload plus the
 * encoding its view takes -- the same two halves every material slot binds
 * through, without the source dimensions a decoded file also reports. Both
 * reached producers land here: `createTexture2DFromPixels` texels (which
 * `TextureData::rgba_width`/`rgba_height` mark) and a loaded image.
 */
struct MaterialPluginTexture {
    TextureData data{};
    bool srgb = false;
};

struct ModelVertex {
    Vec3 position{};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec4 tangent{1.0f, 0.0f, 0.0f, 1.0f};
    Vec2 uv{};
    Vec2 uv2{};
    Vec3 local_position{};
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    std::array<std::uint16_t, 4> joints{};
    Vec4 weights{};
};

// The flattened line-system geometry `createLineSystemData` produces: the
// concatenated points, one zero normal triple per vertex (the shared mesh
// uploader requires the buffer; the line shader binds no normal), the
// segment index pairs, the optional per-point RGBA, and the per-polyline
// point counts a later `updateLineSystem` validates against.
struct LineSystemData {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<std::uint32_t> indices;
    std::vector<float> colors;
    std::vector<std::uint32_t> line_point_counts;
};

/**
 * Which space a geometry's `vertices[].position` lane is already in.
 *
 * `PrimitiveKind` does not answer this — it says whether a mesh has real
 * geometry rather than parametric dimensions, and `createPlane` and
 * `createMeshFromData` both record `gltf` while keeping local vertices.
 * A consumer that needs each vertex's world position has to compose what
 * is missing, so the producer records what it baked:
 *
 * - `local`: the builder's own vertices, with the node transform still on
 *   the `MeshRecord` (every factory mesh).
 * - `world`: the glTF loader's static arm, which multiplied each position
 *   through the mirrored node world before storing it.
 * - `mirrored_local`: the glTF loader's animated and instanced arms, which
 *   apply the RH-to-LH mirror but leave the node matrix for the draw.
 */
enum class VertexSpace : std::uint8_t {
    local,
    world,
    mirrored_local,
};

/**
 * A primitive's own topology, as the pin's own index
 * (`pbr-primitive-topology.ts`: 1 points, 2 lines, 3 line-strip).
 *
 * A triangle strip is not an enumerator because the loader expands one into
 * the triangle list it describes -- the single non-triangle mode that has an
 * exact triangle-list spelling. `gltf-feature-primitive.ts` keeps the index
 * on the mesh as a ready-made `GPUPrimitiveState`; here it rides the
 * geometry, because that is the record the loader fills and the render plan
 * copies from.
 */
enum class MeshTopology : std::uint8_t {
    triangles,
    points,
    lines,
    line_strip,
};

struct ModelGeometry {
    std::vector<ModelVertex> vertices;
    std::vector<ModelVertex> bind_vertices;
    // Source NORMAL values for a draw that reads raw local attributes.
    // Imported bind_vertices may already normalize/mirror them; keep this
    // optional lane independently, without duplicating the full vertex.
    std::vector<Vec3> local_normals;
    /** The loader reversed source triangles for its baked material convention. */
    bool source_indices_reversed = false;
    std::vector<std::vector<Vec3>> morph_positions;
    // Each morph target's own delta AABB, filled on first use by the
    // shadow header's ensure_morph_target_ranges and then kept. Upstream
    // this is a WeakMap cache keyed on the mesh and invalidated when its
    // positions or target list change; a geometry's deltas cannot change
    // once loaded, so there is nothing here to invalidate. Empty in every
    // scene that never enables morph-target shadows.
    //
    // `mutable` because it is memoization of immutable data and nothing
    // else: the caster collector reads the engine through a const
    // reference -- the fit observes the scene rather than changing it --
    // and folding a delta buffer's own AABB cannot make that observation
    // differ. The alternative is folding it afresh every frame for every
    // target, which is what the pin's cache exists to avoid.
    mutable std::vector<std::array<Vec3, 2>> morph_bounds;
    std::vector<std::vector<Vec3>> morph_normals;
    std::vector<std::vector<Vec3>> morph_tangents;
    std::vector<std::uint32_t> indices;
    VertexSpace vertex_space = VertexSpace::local;
    MeshTopology topology = MeshTopology::triangles;
    bool has_tangents = false;
    /**
     * `mesh._gpu.hasUv` / `hasColor`, which `writeAttributeFlags` puts in
     * the node mesh block's spare lanes for `MeshAttributeExistsBlock`.
     *
     * Every vertex carries all five lanes here, so these say what the
     * SOURCE supplied rather than what the buffer holds: a stream nothing
     * filled is zeros, and the block's whole job is to substitute its own
     * fallback for it instead. The uv default is `true` because the pin's
     * own flag is `hasUv === false ? 0 : 1` — an unset one counts as
     * present, which is what every procedural factory produces.
     */
    bool has_uvs = true;
    bool has_vertex_colors = false;
    bool flat_normals = false;
    Vec3 bounds_min{};
    Vec3 bounds_max{};
    // Where the box above sits in the world. A static primitive bakes its
    // node transform into its vertices, so the two agree; an animated one
    // keeps local vertices and receives its node matrix per frame, which
    // leaves `bounds_*` local. Camera framing needs the world box either
    // way, so the loader records it separately.
    Vec3 world_bounds_min{};
    Vec3 world_bounds_max{};
    /** Bumped after each in-place procedural position upload. */
    std::uint64_t position_version = 0;
    /**
     * Mesh records whose `geometry` names this slot. A factory gives each
     * mesh its own slot; only an imported-root clone copies a record and so
     * shares one. The count is what lets a removal free the slot without
     * scanning every record the engine ever created.
     */
    std::uint32_t owners = 1;
};

/**
 * Returns a vector's storage. `v = {}` picks the initializer-list
 * assignment, which empties the vector and keeps its capacity; swapping
 * with an empty vector is what frees the bytes.
 */
template <typename T>
void release_storage(std::vector<T>& storage) {
    std::vector<T>().swap(storage);
}

/**
 * Frees every array a retired geometry holds, keeping the slot (bounds,
 * topology, versions) so the handle stays valid. Measured on the voxel
 * sprint: 188 retired chunk geometries held 46.7 MB under the assignment
 * form this replaces.
 */
inline void release_geometry_storage(ModelGeometry& geometry) {
    release_storage(geometry.vertices);
    release_storage(geometry.bind_vertices);
    release_storage(geometry.local_normals);
    geometry.source_indices_reversed = false;
    release_storage(geometry.morph_positions);
    release_storage(geometry.morph_bounds);
    release_storage(geometry.morph_normals);
    release_storage(geometry.morph_tangents);
    release_storage(geometry.indices);
}

/**
 * A scene-graph node with a TRS and children, the port's `TransformNode`.
 *
 * Upstream it is not its own type at all: `TransformNode` is a pure alias
 * for `SceneNode`, and `createTransformNode` delegates to
 * `createSceneNode`, so a node carries exactly the transform lanes a mesh
 * carries and composes its local matrix through the same
 * `composeTrsLocalMatrix`. The field names match `MeshRecord` for that
 * reason: one emitted composition serves both.
 */
struct TransformNodeRecord {
    std::string name;
    Vec3d position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    bool has_rotation_quaternion = false;
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    /** The node this one hangs under, or none — `IParentable.parent`. */
    TransformNodeHandle parent{};
    /**
     * The traversal list `node.children` holds. Upstream a direct
     * `child.parent = node` write drives the transform math and leaves
     * `children` alone, so the two are recorded apart here as well.
     */
    std::vector<TransformNodeChild> children;
    /**
     * What the parent SETTER registered, which is the pin's own
     * `_addChild`: the list `invalidate()` recurses into when this node's
     * transform is marked dirty. Kept apart from `children` because
     * upstream keeps them apart -- a scene may write the link without
     * ever pushing the traversal entry, and the transform must still
     * follow.
     */
    std::vector<MeshHandle> parented_meshes;
    std::vector<TransformNodeHandle> parented_nodes;
    /** Bumped by every transform write, which is what re-bakes a child. */
    std::uint64_t transform_version = 0;
};

struct ImportedMeshTrs {
    Vec3 position{};
    Vec3 rotation{};
    Vec3 scaling{1, 1, 1};
};

struct MeshRecord {
    /**
     * The pinned Mesh name: the factory literal (`"sphere"`, `"box"`, …),
     * the caller's string for createMeshFromData, the glTF loader's
     * `json.meshes[node.mesh].name || gltf_mesh_<i>`, or whatever the
     * scene assigned. Scene code finds meshes by it.
     */
    std::string name;
    /**
     * The glTF node wrapper's SceneNode name. A flattened mesh record stands
     * in for both that wrapper and its renderable child, so recursive scene
     * lookup checks this lane before the mesh's independently authored name.
     */
    std::string scene_node_name;
    PrimitiveKind primitive = PrimitiveKind::box;
    // The pin holds a node's translation as three JavaScript numbers, and
    // at large-world coordinates the float32 ULP is half a unit -- enough
    // to move a silhouette before the eye-relative subtraction can recover
    // anything. Rotation and scaling stay float: they are small by
    // construction and every consumer reads them at that width.
    Vec3d position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    Vec3 dimensions{1.0f, 1.0f, 1.0f};
    // `mesh.receiveShadows`. A composition key for the Standard and PBR
    // families, whose variants carry the sampling code -- and a per-draw
    // VALUE for the node family, whose receiver mixes its factor by the
    // `meshU.receivesShadow` lane instead. One record field serves both:
    // the two composed families never read it.
    bool receives_shadows = false;
    // Scene-code boundMin/boundMax replace the corresponding object-local
    // bound carried by the pinned Mesh. Keep each side optional because the
    // public object permits either property to be assigned independently.
    bool has_bounds_min_override = false;
    bool has_bounds_max_override = false;
    Vec3 bounds_min_override{};
    Vec3 bounds_max_override{};
    /**
     * `IParentable.parent`: the node whose world matrix this mesh composes
     * under. Upstream any entity may parent to any other; the reached
     * slice is a mesh under a transform node.
     */
    TransformNodeHandle transform_parent{};
    /**
     * The mesh parent installed by `setParent`, plus the public traversal
     * list that function keeps in sync. Mesh and transform-node handles live
     * in different native tables, so retaining both identities avoids an
     * ambiguous integer handle while covering the pin's shared SceneNode
     * parent surface.
     */
    MeshHandle parent{};
    std::vector<MeshHandle> children;
    /** The world-matrix state's private child registry for dirty pushes. */
    std::vector<MeshHandle> parented_meshes;
    /**
     * Runtime simulation moves this hierarchy every frame. Its immutable
     * local vertices stay on the GPU and the renderer supplies the live
     * world matrix per draw instead of rebaking and re-uploading them.
     */
    bool gpu_world_transform = false;
    /** A static imported mesh restored to its authored local vertex stream. */
    bool live_imported_transform = false;
    /** cloneMeshNode starts a fresh world state over the source local attributes. */
    bool detached_imported_mesh = false;
    std::optional<ImportedMeshTrs> imported_clone_trs;
    MaterialHandle material{};
    std::uint32_t geometry = invalid_handle;
    /**
     * Whether `removeFromScene` retired this record. The pin lets the
     * JavaScript collector drop a removed mesh's arrays; here the removal
     * releases the record's share of its geometry (the bytes themselves
     * once no other record shares the slot), so a later `addToScene` of
     * the same mesh refuses by name rather than drawing nothing or
     * releasing a sharer's geometry twice.
     */
    bool retired = false;
    // Before renderer startup a clone records the runtime handle of its
    // source mesh here. The renderer uses that link while assigning stable
    // creation-order composition rows, then keeps it for clone provenance.
    std::uint32_t feature_source_mesh = invalid_handle;
    // Generated shader-feature tables describe only original meshes, in
    // source creation order. Runtime clone handles can be interleaved with
    // later imports, so every original receives a stable row and every clone
    // inherits its source row before the first render plan is built.
    std::uint32_t composition_feature_row = invalid_handle;
    // A cloned imported root remains an outer scene-node transform. Unlike
    // ordinary mesh TRS this is applied by the draw world after deformation,
    // matching a clone whose mesh retains the source skeleton/morph resource.
    Vec3 outer_position{};
    Vec3 outer_rotation{};
    float baked_world_scale = 1.0f;
    std::uint64_t transform_version = 0;
    bool has_rotation_quaternion = false;
    bool gpu_deformation = false;
    /**
     * Whether this mesh's bone palette rides the pin's own per-bone
     * texture (a composed skeleton variant) rather than the 64-matrix
     * uniform array. The transcribed vertex stage cannot read a palette
     * that large, so the block it would read is left at the identity and
     * the draw takes its deformation from the pinned stage instead.
     */
    bool pinned_bone_palette = false;
    /**
     * Whether the glTF node this record was flattened from carried a
     * `skin` AND the file carried animation: the loader writes it inside
     * its animated branch, so a skinned file with no clips leaves it
     * false where the pin's `mesh.skeleton` would answer the mesh. Both
     * readers -- the first-skinned search and the VAT bake -- want a mesh
     * whose palette some clip poses, so neither can observe the gap; a
     * reader that only wanted the skin binding would have to widen this.
     * Written only in VAT builds, since those two are its only readers.
     */
    bool skinned = false;
    /**
     * Whether this record's palette came from `createSkeleton` in scene
     * code rather than from the glTF pose pass.
     *
     * The pin composes one thing for both -- `finalWorld = mesh.world *
     * influence` -- but the loader folds `invMeshWorld` into every palette
     * entry it writes and leaves the record's TRS at rest, so its draw
     * passes the identity as `mesh.world`. A scene that writes its own
     * bone matrices folds nothing: its palette is the bones alone and its
     * mesh keeps its transform, so the draw passes the record's live world
     * beside the palette and the CPU vertex bake leaves the vertices
     * local. Both readers are in `pal_gpu_shared.hpp`.
     */
    bool scene_skeleton = false;
    /** Scene-authored morph deltas and vertices share native local space. */
    bool scene_morph_targets = false;
    bool has_vertex_alpha = false;
    /**
     * `mesh.vat`. Set by `attachVat`, which also drops the live skeleton --
     * so a record carrying this one deforms from the baked texture and its
     * `bone_matrices` are no longer written or read.
     */
    bool has_vat = false;
    VatData vat;
    /**
     * The front-face state of the geometry as stored by its factory/loader.
     * Runtime parent transforms XOR their live determinant against this
     * baseline; keeping the baseline separate prevents imported geometry
     * whose indices were already reconciled at load from being flipped twice.
     */
    bool authored_clockwise_front_face = false;
    bool clockwise_front_face = false;
    /**
     * Whether the mirrored-mesh watcher has seen this mesh, which is what
     * separates "its sign flipped" from "it was just added": the sign
     * itself is `clockwise_front_face` beside it.
     *
     * The pin keeps this per SCENE, because one mesh may belong to several
     * and a shared record would let the first scene's rebuild hide the flip
     * from the others. No reached scene shares a mesh, so it rides the
     * record here; a scene that did would need the per-scene map.
     */
    bool mirrored_seen = false;
    // Whether the loader stored this mesh's vertices through the native X
    // mirror. Babylon composes its own vertex stage against unmirrored data and
    // carries the mirror in the mesh block's world matrix, so a PAL binding
    // those stages needs the sign to convert between the two.
    bool mirrored_x = false;
    // Optional Mesh.renderOrder. The pinned renderer supplies its family
    // default only when this field was never assigned.
    bool has_render_order = false;
    double render_order = 0.0;
    // Self-visibility (scene-node.ts `visible?: boolean`, undefined = true).
    // No PICK path consults it -- `gpu-picker.ts` filters on `pickable`
    // alone -- which is the mirror of `pickable` below, and why the render
    // plan keeps a hidden mesh and only its draw lists drop one.
    // Written by scene code and by glTF KHR_node_visibility, which
    // materializes the cascade per mesh the way the pinned
    // `setSubtreeVisible` materializes it per node: the extension cascades
    // through the subtree at set time so the render path and the camera
    // bounds only test one boolean.
    bool visible = true;
    // mesh.ts `pickable?: boolean`, undefined = pickable. Read only by the
    // generated `pick_candidate`, which both backends' pick passes ask; no
    // draw path consults it, because a non-pickable mesh still renders.
    bool pickable = true;
    std::vector<std::array<float, 16>> bone_matrices;
    /**
     * Moves with every rewrite of `bone_matrices`; both backends upload
     * the palette texture only when it differs from the version they
     * last streamed, so a still skeleton costs no upload.
     */
    std::uint64_t bone_matrices_version = 0;
    /**
     * The animated node's own world matrix, in this port's convention.
     *
     * A skinned mesh's transform travels inside its palette, so
     * `mesh_world_matrix` answers the identity for one and the record's
     * TRS stays at rest. That is right for every draw -- applying the
     * transform twice is exactly what `pinned_draw_conventions` avoids --
     * and wrong for one reader: the pin's detailed pick transforms the
     * REST normal by `mesh.worldMatrix`, which is this node world and
     * deliberately NOT the skin. Written by the glTF pose pass only for a
     * build whose picker draws the deform projection, and read only
     * there.
     */
    std::array<float, 16> deform_node_world{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::array<float, 16> instance_parent_matrix{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::vector<std::array<float, 16>> instance_matrices;
    // Thin-instance pool state mirroring the pinned ThinInstanceData:
    // instance_matrices holds the fixed capacity pool, instance_count is
    // the active draw count, and instance_version gates the PAL re-upload
    // exactly like morph_weights_version. instance_source aliases the
    // caller's matrix array bound by set_thin_instances; the compiler only
    // accepts named bindings there, and generated main keeps every such
    // binding alive for the whole frame loop, so the pointer cannot
    // dangle. Loader-built instancing (glTF EXT_mesh_gpu_instancing)
    // leaves it null and never bumps the version.
    bool thin_instanced = false;
    bool source_runtime_thin_builder = false;
    std::uint32_t instance_count = 0;
    std::uint64_t instance_version = 0;
    std::vector<float>* instance_source = nullptr;
    // The pool the engine owns rather than aliases: allocated by an
    // `addThinInstance` that found no pool (the pin's own `new F32(capacity
    // * 16)`, which has no caller array to adopt) and again by every growth,
    // where the pin allocates a longer array and repoints `ti.matrices` at
    // it. Growth therefore DETACHES the record from the scene's own array
    // instead of resizing it: the caller keeps its array at its own length,
    // exactly as upstream, and later writes land here. Held through a shared
    // pointer so the alias above survives a `meshes` reallocation, which a
    // runtime mesh append can cause.
    std::shared_ptr<std::vector<float>> owned_instance_source;
    // `ThinInstanceData._gpuCullingEnabled`, the pin's opt-in to compute
    // frustum culling and indirect draws. This port omits the culler and
    // draws every active instance (fidelity: thin-instance-gpu-culling),
    // so the flag records the opt-in and keeps its renderable in the pin's
    // live direct-draw path: it does not enable a native compute culler.
    bool thin_instance_gpu_culling = false;
    // The per-instance RGBA stream `setThinInstanceColors` bound, as the
    // pin's own tightly-packed float4 rows. Empty where the mesh has none.
    std::vector<float> instance_colors;
    std::shared_ptr<js::F32Array> instance_color_source;
    double thin_instance_cull_bounds_pad = 0;
    // `Mesh._linePointCounts`: the polyline sizes a line system was built
    // from, kept because `updateLineSystem` refuses a changed connectivity
    // rather than rewriting a mesh whose segments moved. The flag beside it
    // is the pin's own `mesh._gpu.colorBuffer` test: an update cannot give
    // a line system colours it was not created with.
    std::vector<std::uint32_t> line_point_counts;
    bool line_has_colors = false;
    std::array<float, 4> morph_weights{};
    // Uncapped weights for the storage-buffer morph path; versioned so
    // PAL re-uploads only when the animation evaluator writes them.
    std::vector<float> morph_storage_weights;
    std::uint64_t morph_weights_version = 0;
};

inline bool has_instance_colors(const MeshRecord& mesh) {
    return mesh.instance_color_source || !mesh.instance_colors.empty();
}

inline ModelVertex detached_imported_vertex(const MeshRecord& mesh, const ModelGeometry& geometry, std::size_t index) {
    ModelVertex vertex = geometry.bind_vertices.at(index);
    vertex.position = geometry.vertices.at(index).local_position;
    if (mesh.primitive == PrimitiveKind::gltf) {
        vertex.normal.x = -vertex.normal.x;
        vertex.tangent.x = -vertex.tangent.x;
        vertex.tangent.w = -vertex.tangent.w;
    }
    return vertex;
}

inline void apply_mesh_bound_overrides(
    const MeshRecord& mesh,
    Vec3& minimum,
    Vec3& maximum) {
    if (mesh.has_bounds_min_override) {
        minimum = mesh.bounds_min_override;
    }
    if (mesh.has_bounds_max_override) {
        maximum = mesh.bounds_max_override;
    }
}

// ---------------------------------------------------------------------------
// Sprites (src/sprite/*). A sprite layer is pure data upstream and stays pure
// data here: the Index API writes floats into one interleaved instance buffer.
// A depth:none layer is owned by its SpriteRenderer rendering context; a
// depth-enabled layer attaches as a scene renderable and shares that scene's
// colour/depth pass, exactly as the pin separates the two arms.
// ---------------------------------------------------------------------------

/** shared/sprite-atlas.ts `SpriteFrame`: UVs in [0,1], size in pixels. */
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
#include <bblite/runtime/sprite-atlas-records.hpp>
#endif

enum class DepthCompare {
    never,
    less,
    equal,
    less_equal,
    greater,
    not_equal,
    greater_equal,
    always,
};

/** blend-descriptors.ts / sprite-blend.ts, as the pure data they are. */
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
#include <bblite/runtime/sprite-blend.hpp>
#endif

struct SplatMeshRecord {
    /**
     * A cloud is a SceneNode upstream, so it carries the same name a mesh
     * does -- and a GPU pick resolves to that name, which is the only reader
     * this port has for it.
     */
    std::string name;
    std::uint32_t vertex_count = 0;
    std::uint32_t texture_width = 0;
    std::uint32_t texture_height = 0;
    std::array<float, 3> bound_min{};
    std::array<float, 3> bound_max{};
    /** Splat centres, flat XYZ — the sort's only geometry input. */
    std::vector<float> positions;
    std::vector<float> centers_rgba;
    std::vector<float> cov_a_rgba;
    std::vector<float> cov_b_rgba;
    std::vector<float> colors_rgba;
    // A GaussianSplattingMesh is a SceneNode upstream, so its world matrix
    // is composed from the same TRS every other node's is; the port keeps
    // the same field names because one emitted composition serves both.
    // `build_splat_world` is that composition, and there is no cached
    // matrix here for the same reason the sort has no dirty flag: both
    // re-derive from the record each frame. Scene code writes all three
    // lanes (scene 127 the position, scene 125 all of them before baking
    // them away).
    Vec3 position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    bool has_rotation_quaternion = false;
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    // Retained only when reached. The wrapper shares the source ArrayBuffer
    // backing, so replacement leaves old aliases alive and unmodified. Its
    // indirection keeps the data runtime out of this renderer-wide header.
    std::shared_ptr<js::ArrayBuffer> splats_data;
    // Successful CPU update commits only. PAL refresh hooks must consume this
    // version before source updateData can be admitted after registration.
    std::uint64_t data_version = 0;
    // The spherical-harmonic degree the packaged container parsed to, and
    // the payloads `attachGaussianSplattingMeshSH` packs from it -- one
    // per rgba32uint texture, in binding order after the four above.
    // Upstream reads `mesh.shDegree` off the parse and forks the whole
    // pipeline on it; here the fork happened at generation, so a cloud
    // with none leaves both of these at their empty defaults and the
    // scene compiles no SH pipeline at all.
    std::uint32_t sh_degree = 0;
    std::vector<std::vector<std::uint8_t>> sh_textures;
};

#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
#include <bblite/runtime/sprite-records.hpp>
#endif

struct EffectTextureSlot {
    std::string name;
    SolidTexture texture{};
    bool set = false;
};

/**
 * One `EffectWrapper`: which composed module it draws and what fills the
 * bind group the descriptor declared.
 *
 * The module, the layout and the pipeline state were settled at generation
 * (`upstream::effect_variants`), so what a record carries is only the two
 * things a scene writes after creation -- the uniform bytes and the bound
 * textures.
 */
struct EffectWrapperRecord {
    std::uint32_t variant = 0;
    /** The bytes `setEffectUniforms` wrote into the first uniform slot. */
    std::vector<float> uniform_values;
    /**
     * Set by `setEffectUniforms`, cleared once a backend that owns a uniform
     * buffer has written it -- the same split the post-process passes use
     * between mutating a parameter and uploading the block. SDL_GPU pushes
     * per command buffer and cannot skip; Dawn can.
     */
    bool uniforms_dirty = false;
    std::vector<EffectTextureSlot> textures;
};

/** An `EffectRenderer`: one wrapper drawn to the swapchain each frame. */
struct EffectRendererRecord {
    EffectWrapperHandle effect{};
    bool clear = false;
    Color4 clear_color{};
};

/** The options `createEffectRenderer` takes past the wrapper itself. */
struct EffectRendererOptions {
    bool clear = false;
    Color4 clear_color{};
};

#if !defined(BBLITE_HAS_ANIMATION) || BBLITE_HAS_ANIMATION
#include <bblite/runtime/animation-records.hpp>
#endif

// KHR_texture_transform is per texture slot upstream: gltf-ext-uv-transform.ts
// attaches uScale/vScale/uOffset/vOffset/uAng to each texture wrapper, and each
// sample computes its own UV from that wrapper's fields, so two slots on one
// material may carry different transforms.
struct TextureTransform {
    float u_scale = 1.0f;
    float v_scale = 1.0f;
    float u_offset = 0.0f;
    float v_offset = 0.0f;
    float rotation = 0.0f;
};

struct EnvironmentState;
struct LocalCubemapRecord {
    struct Copy {
        std::uint32_t source, source_mip, source_layer, mip, layer, size;
    };
    std::vector<std::shared_ptr<const EnvironmentState>> environments;
    std::vector<std::uint32_t> uniform_data;
    std::vector<std::uint32_t> grid_data;
    std::unordered_map<std::string, std::vector<float>> material_fields;
    std::vector<Copy> copies;
    std::uint32_t width = 0, mip_count = 0, layers = 0;
    bool overrides_environment = false;
};

struct MaterialRecord {
    std::shared_ptr<LocalCubemapRecord> local_environment;
    /** Material.name, copied from the authored asset when one exists. */
    std::string name;
    Color3 diffuse_color{};
    Color4 base_color_factor{1.0f, 1.0f, 1.0f, 1.0f};
    // Public source arrays are distinct from the packed float render fields.
    // Null means the producer omitted the property; copies retain JS identity.
    std::shared_ptr<std::vector<double>> source_base_color_factor{};
    std::shared_ptr<std::vector<double>> source_diffuse_color{};
    // The family-specific public albedo property retains its original
    // Texture2D producer arm and identity, separately from upload data.
    std::optional<StoredTexture> source_albedo_texture{};
    bool source_colors_registered = false;
    bool source_pbr_group_builder = false;
    // Standard/shader singleton keys and per-node builder closure identities.
    std::uint64_t source_group_builder = 0;
    bool source_gamma_albedo = false;
    // Source control reads retain number precision separately from GPU floats.
    bool source_transmissive = false;
    std::optional<double> source_refraction_intensity;
    // Babylon keeps the material-wide alpha separate from the PBR base-color
    // factor. The fragment multiplies both when the factor field is composed.
    float alpha = 1.0f;
    Color3 emissive_factor{0.0f, 0.0f, 0.0f};
    // `KHR_materials_emissive_strength` folds into the factor above at load,
    // so animating either one needs both kept apart: the fragment reads the
    // product, and a pointer track rewrites whichever half it targets.
    Color3 emissive_base_factor{0.0f, 0.0f, 0.0f};
    float emissive_strength = 1.0f;
    Color3 specular_color{1.0f, 1.0f, 1.0f};
    Color3 ambient_color{};
    float specular_power = 64.0f;
    float diffuse_level = 1.0f;
    float opacity_level = 1.0f;
    float ambient_level = 1.0f;
    float diffuse_u_scale = 1.0f;
    float diffuse_v_scale = 1.0f;
    double standard_uv_offset_x = 0.0;
    double standard_uv_offset_y = 0.0;
    float diffuse_u_offset = 0.0f;
    float diffuse_v_offset = 0.0f;
    // Per-slot glTF texture transforms. Occlusion carries its own because the
    // pin's own occlusion carrier does: `buildDefaultPbrTexturesExt` wraps the
    // occlusion textureInfo separately from the metallic-roughness one, so a
    // material whose occlusion slot declares a transform of its own samples at
    // `occlUV` while the ORM slot keeps `ormUV`. Identical for every corpus
    // material that reaches both, and the pinned pointer registry still maps an
    // animated occlusion transform onto the ORM wrapper.
    TextureTransform base_color_transform{};
    TextureTransform orm_transform{};
    TextureTransform occlusion_transform{};
    bool has_occlusion_transform = false;
    TextureTransform normal_transform{};
    TextureTransform emissive_transform{};
    TextureTransform clearcoat_transform{};
    TextureTransform clearcoat_roughness_transform{};
    TextureTransform clearcoat_normal_transform{};
    TextureTransform sheen_transform{};
    TextureTransform sheen_roughness_transform{};
    TextureTransform iridescence_transform{};
    TextureTransform iridescence_thickness_transform{};
    TextureTransform transmission_transform{};
    TextureTransform thickness_transform{};
    TextureTransform anisotropy_transform{};
    TextureTransform translucency_color_transform{};
    TextureTransform translucency_intensity_transform{};
    TextureTransform metallic_reflectance_transform{};
    TextureTransform reflectance_transform{};
    std::uint32_t diffuse_coord_index = 0;
    std::uint32_t specular_coord_index = 0;
    std::uint32_t ambient_coord_index = 0;
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    float direct_intensity = 1.0f;
    float environment_intensity = 1.0f;
    // Pinned default: the dielectric F0 the PBR material seeds (0.04).
    float reflectance = 0.04f;
    // KHR_materials_specular, through the pinned dielectric reflectance ext:
    // specularFactor scales the dielectric F0 and its grazing weight, and
    // specularColorFactor tints the dielectric reflectance. The fragment reads
    // them as metallicF0Factor / specularWeight / metallicReflectanceColor and
    // composes `dielectricF0 = reflectance * metallicF0Factor`, so the factor
    // is kept apart from the base reflectance rather than folded into it.
    bool has_metallic_reflectance = false;
    float metallic_f0_factor = 1.0f;
    float specular_weight = 1.0f;
    Color3 metallic_reflectance_color{1.0f, 1.0f, 1.0f};
    float normal_texture_scale = 1.0f;
    float transmission_factor = 0.0f;
    // Pinned default: gltf-ext-dielectric.ts treats ior 1.5 as neutral.
    float index_of_refraction = 1.5f;
    float thickness = 0.0f;
    bool use_thickness_as_depth = false;
    Color3 attenuation_color{1.0f, 1.0f, 1.0f};
    float attenuation_distance = 1.0f;
    float dispersion = 0.0f;
    bool has_subsurface = false;
    float subsurface_intensity = 1.0f;
    Color3 subsurface_color{1.0f, 1.0f, 1.0f};
    Color3 subsurface_diffusion_distance{1.0f, 1.0f, 1.0f};
    float subsurface_minimum_thickness = 0.0f;
    float subsurface_maximum_thickness = 1.0f;
    float clearcoat_intensity = 0.0f;
    float clearcoat_roughness = 0.0f;
    // Pinned default: the coat ior the clearcoat layer seeds.
    float clearcoat_index_of_refraction = 1.5f;
    float clearcoat_normal_scale = 1.0f;
    Color3 sheen_color{0.0f, 0.0f, 0.0f};
    float sheen_roughness = 0.0f;
    float sheen_intensity = 1.0f;
    bool shadow_only = false;
    Color3 shadow_only_color{};
    float shadow_only_opacity = 1.0f;
    float shadow_only_falloff = 1.0f;
    // KHR_materials_anisotropy / `setPbrAnisotropy`. The direction is the
    // pin's own `direction ?? [1, 0]`, written beside the intensity into
    // `anisotropyParams` by the extension's own writer.
    float anisotropy_intensity = 1.0f;
    Vec2 anisotropy_direction{1.0f, 0.0f};
    bool has_anisotropy = false;
    // `setPbrLightmap`'s intensity multiplier, the one lightmap quantity
    // that is not composed into the fragment: the pin's own
    // `writeLightmapUBO` reads `material.lightmapLevel ?? 1` every time it
    // runs, so the default here is that fallback. The blend, the UV set,
    // the gamma decode and the V flip are all composition input and carry
    // no lane at all.
    float lightmap_level = 1.0f;
    float lightmap_coord_index = 1.0f;
    bool lightmap_shadowmap = false;
    bool lightmap_texture_srgb = false;
    float iridescence_intensity = 0.0f;
    // Pinned defaults: KHR_materials_iridescence ior 1.3, thickness
    // 100..400 nm (gltf-ext-iridescence.ts).
    float iridescence_index_of_refraction = 1.3f;
    float iridescence_minimum_thickness = 100.0f;
    float iridescence_maximum_thickness = 400.0f;
    bool has_ior = false;
    bool has_volume = false;
    bool skybox_mode = false;
    bool specular_aa = false;
    // `usePhysicalLightFalloff`, the pin's own default-true property. The
    // composed punctual arms carry both falloffs and select on the material
    // UBO's `lightFalloffMode`, which `_writeMaterialData` fills from here.
    bool use_physical_light_falloff = true;
    bool has_occlusion_texture = false;
    // glTF occlusionTexture.strength, which the fragment mixes toward 1. The
    // pin forces its reflectance ext on when this is animated so the mix
    // exists; ours is on the core path, so the value simply rides here.
    float occlusion_strength = 1.0f;
    bool unlit = false;
    // setPbrUnlit's optional linear-RGB tint (src/material/pbr/set-unlit.ts).
    // The pin stores it only when the caller supplies one and the writer
    // reads `_unlitColor ?? [1, 1, 1]`, so an absent tint is the identity
    // this default already is.
    Color3 unlit_color{1.0f, 1.0f, 1.0f};
    bool no_color = false;
    /** Original material copied into a no-colour/ESM view. */
    MaterialHandle source_material{};
    /**
     * An ESM caster view: `createStandardEsmShadowMaterialView` clears the
     * blend bit and sets `ESM_SHADOW_OUTPUT`, so this view writes the
     * exponential depth into a colour attachment rather than nothing.
     */
    bool esm_shadow = false;
    /**
     * Which generator's caster block this view reads. `getEsmShadowView`
     * builds one view per material PER GENERATOR, closing over that
     * generator's own `_shadowParamsUBO`, so the bias and depth scale a
     * caster draw sees are its generator's.
     */
    ShadowGeneratorHandle esm_shadow_generator{};
    bool disable_lighting = false;
    bool has_emissive_render_texture = false;
    // `material.diffuseTexture = <createRenderTargetTexture output>`: the
    // Standard diffuse slot fed by another pass's colour attachment rather
    // than by decoded image bytes.
    bool has_diffuse_render_texture = false;
    // `enableMaterialUvTransform(material)`: the pin's own opt-in mark
    // (`_hasUvTx`), read back by `stdUvTransformExt._meshFeatures` and
    // therefore part of the composed variant key.
    bool has_uv_transform = false;
    // `material.plugins = [...]` on a STANDARD material: the per-signature
    // index the pin's own `registerStdPlugins` pre-bakes into the material's
    // cached `_renderFeatures`, from one, zero for a material carrying none.
    // Standard's feature computation is not extension-extensible, which is
    // why upstream bakes it and why it has to ride the record here — the
    // Standard variant key is the word `standard_material_features` derives.
    // The PBR family needs no such lane: its selector keys by material
    // index, so the composed row already carries the plugin.
    //
    // A byte, because the pin's own `PLUGIN_INDEX_MASK` reserves seven bits
    // for it: a wider field lands after the bool run below and pushes the
    // whole tail across an alignment boundary, costing eight bytes per
    // material rather than none. Generation refuses a mask this cannot hold.
    std::uint8_t plugin_signature_index = 0;
    // The textures that list's plugins bind, in the order
    // `bindPluginTextures` pushes them -- plugin by plugin, and within one
    // plugin in `bindTextures` order, which is the order its `getSamplers`
    // pairs were declared and therefore composed in. The list is per
    // MATERIAL rather than per signature, exactly as the pin's own
    // per-material plugin state is: two materials sharing one plugin shape
    // keep different texture values, and the composed variant they share
    // resolves each binding by name against this list's position.
    std::vector<MaterialPluginTexture> plugin_textures;
    bool double_sided = false;
    // The pin's opacityFromRGB (createStandardMaterial default false; the
    // .babylon loader sets it from opacityTexture.getAlphaFromRGB,
    // load-babylon.ts TEX_SLOTS opacity extra). Feeds OPACITY_FROM_RGB in
    // _computeStandardMaterialFeatures, which selects the composed opacity
    // fragment's dot(opSample.rgb, ...) luminance arm.
    bool opacity_from_rgb = false;
    bool standard_material = false;
    bool shader_material = false;
    // A Babylon NME graph, compiled at generation by the pin's own emitter.
    // Its variant rides `shader_variant` below, which indexes whichever
    // family's table the material belongs to.
    bool node_material = false;
    std::shared_ptr<NodeMaterialInputsState> node_inputs;
    bool grid_material = false;
    bool alpha_to_coverage = false;
    bool shader_alpha_testing = false;
    bool shader_depth_write = true;
    // Index into the material family's own generated variant table -- the
    // shader-variant one (`upstream::shader_variant_info`) or, for a node
    // material, `upstream::node_variants`. Ids are assigned in reach order
    // by the compiler and drive pipeline selection and uniform layout.
    std::uint32_t shader_variant = 0;
    // Flat custom-uniform storage laid out by the variant's reflected
    // member offsets; created (and defaults-applied) by the emitted
    // create_shader_material, written by the emitted offset setters.
    std::vector<float> shader_uniform_values;
    /** Storage slots in the shader's declared order. */
    std::vector<StorageBufferHandle> shader_storage_buffers;
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
    /** CSM receiver textures keyed by shader sampler slot. */
    std::vector<ShadowGeneratorHandle> shader_csm_textures;
#endif
    /** Optional shader material used only by this material's shadow pass. */
    MaterialHandle shadow_caster_material{};
    Color3 grid_main_color{0.0f, 0.0f, 0.0f};
    Color3 grid_line_color{0.0f, 0.5f, 0.5f};
    Vec4 grid_control{1.0f, 10.0f, 0.33f, 1.0f};
    Vec3 grid_offset{};
    float grid_visibility = 1.0f;
    bool grid_antialias = true;
    bool grid_pre_multiply_alpha = false;
    bool grid_use_max_line = false;
    MaterialAlphaMode alpha_mode = MaterialAlphaMode::opaque;
    float alpha_cutoff = 0.5f;
    TextureData base_color_texture;
    /** PBR source slot presence; a factor-baked texture also fills the slot. */
    bool has_public_base_color_texture = false;
    /** Source Standard diffuse Texture2D format; separate from renderer defaults. */
    bool diffuse_texture_srgb = false;
    TextureData metallic_roughness_texture;
    TextureData metallic_reflectance_texture;
    TextureData reflectance_texture;
    TextureData anisotropy_texture;
    TextureData translucency_color_texture;
    TextureData translucency_intensity_texture;
    TextureData normal_texture;
    /** KHR_materials_pbrSpecularGlossiness: RGB specular, A glossiness. */
    TextureData spec_gloss_texture;
    TextureData transmission_texture;
    TextureData thickness_texture;
    TextureData clearcoat_texture;
    TextureData clearcoat_roughness_texture;
    TextureData clearcoat_normal_texture;
    TextureData sheen_color_texture;
    TextureData sheen_roughness_texture;
    TextureData iridescence_texture;
    TextureData iridescence_thickness_texture;
    /** The file texture bound by the PBR or Standard lightmap setter. */
    TextureData lightmap_texture;
    TextureData emissive_texture;
    TextureData opacity_texture;
    TextureData specular_texture;
    TextureData ambient_texture;
    // Standard bump map. The pinned fragment builds a cotangent frame from
    // screen-space derivatives, so no tangent attribute is involved, and it
    // scales the interpolated normal by 1 / level before the frame is built.
    TextureData bump_texture;
    float bump_scale = 1.0f;
    // Dedicated glTF occlusion texture sampled at uv2 (Babylon Lite's
    // pbr-template-ext pair for occlusionTexture.texCoord == 1).
    TextureData occlusion_texture;
    bool occlusion_texture_uv2 = false;
    /** Replacing an admitted texture slot detaches existing animation captures. */
    std::uint64_t orm_texture_generation = 0;
    std::uint64_t occlusion_texture_generation = 0;
    // Texture-less base color baked to the pinned 8-bit sRGB texel
    // (uploadBaseColorFactorTexture); the hardware decode of these
    // bytes is the browser's effective base color.
    std::array<std::uint8_t, 4> base_color_fallback{
        255, 255, 255, 255};
    // The base-colour slot's own texture FORMAT, which upstream keeps on the
    // `Texture2D` rather than on the material: `loadTexture2D` picks
    // `rgba8unorm-srgb` or `rgba8unorm` from its caller's `srgb` option
    // (texture-2d.ts), and the glTF loader passes true for this slot
    // (gltf-pbr-builder.ts) as does the texture-less factor bake, which
    // writes an sRGB texel. False for a scene-code solid texture -- the pin's
    // createSolidTexture2D writes its rounded texel into a 1x1 rgba8unorm
    // sampled without decode -- and false for a `loadTexture2D` result the
    // scene did not ask sRGB for, which is how a gamma-albedo material feeds
    // the decode to its own fragment instead.
    bool base_color_srgb = true;
    // Texture-less metallic/roughness baked to the pinned 8-bit texel
    // (uploadOrmFactorTexture writes [255, roughness, metallic, 255]) with the
    // uniform factors left at one. Keeping the factor in the texel rather than
    // the uniform is what makes an animated factor behave: the pointer writer
    // multiplies the uniform against this texel, so a baked zero stays zero.
    std::array<std::uint8_t, 4> orm_fallback{255, 255, 255, 255};
    RenderTextureRef emissive_render_texture{};
    RenderTextureRef diffuse_render_texture{};
    // The material's own texture slots, in the order the family's variant
    // table declares them: a shader material's `samplers` (`_textureSlots`
    // upstream), or a node graph's `TextureBlock`/`ImageSourceBlock`
    // bindings resolved against the scene's `textures` record. Empty for
    // every other family, and for a program that samples nothing.
    std::vector<FileTexture> shader_textures;
    std::uint32_t reflection_cube = invalid_handle;
    float reflection_level = 1.0f;
    // The pin's 2D reflection slot: the non-cube arm of the same
    // reflectionTexture JSON slot the cube handle above consumes
    // (load-babylon.ts TEX_SLOTS reflectionTexture, `skipIf: isCube`),
    // sampled by the composed std-reflection fragment at computed
    // reflCoords rather than mesh UVs.
    TextureData reflection_texture;
    // writeStdMaterialData's rCm lane: createStandardMaterial seeds 1
    // (spherical, the fragment's `rCm < 1.5` arm); the pin's loader writes
    // 2 only for coordinatesMode === 2 (planar), load-babylon.ts.
    float reflection_coord_mode = 1.0f;
};

inline std::uint32_t material_family_bit(const MaterialRecord& record) {
    if (record.grid_material) return material_family_grid;
    if (record.shader_material) return material_family_shader;
    if (record.standard_material) return material_family_standard;
    return material_family_pbr;
}

// The pin reads `mat.alpha < 1` live when it builds renderables, and the
// PBR transmission extension forces blending regardless of alpha, so the
// mode is a derivation of the two factors it is stored beside. One home
// for that rule: the factor-driven families (Standard, PBR) derive here at
// creation and at every alpha write; a shader, node, or grid material owns
// its mode through its variant flag or opacity control instead, and an
// alpha write leaves it with its factory. A glTF-authored mask mode is
// alpha-testing, not factor-driven, and likewise stays.
inline void derive_material_alpha_mode(MaterialRecord& material) {
    if (material.shader_material || material.node_material ||
        material.grid_material ||
        material.alpha_mode == MaterialAlphaMode::mask) {
        return;
    }
    material.alpha_mode =
        material.alpha < 1.0f ||
                material.transmission_factor > 0.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
}

struct LightRecord {
    LightKind kind = LightKind::directional;
    Vec3 position{};
    Vec3 direction{0.0f, 1.0f, 0.0f};
    float intensity = 1.0f;
    float range = std::numeric_limits<float>::max();
    // cos(angle/2) for a spot cone, which is what the pinned spot light packs
    // into its direction slot. glTF gives the half-angle directly as
    // spot.outerConeAngle, and the pinned loader doubles it into the full
    // cone angle the light stores, so the cosine of the half-angle is the
    // cosine of outerConeAngle.
    float cos_half_angle = 1.0f;
    /**
     * The full cone angle the cosine above was taken of, at the width the
     * pinned factory holds it (a JavaScript number). Shading reads only the
     * cosine; a spot PCF shadow projection reads the angle itself, as the
     * perspective FOV `_computeSpotLightMatrix` builds its volume from. It
     * is written wherever `cos_half_angle` is, so the two never disagree.
     */
    double angle = 0.0;
    // Spot falloff exponent. The pinned Standard lighting function raises the
    // cone cosine to it, so a higher value sharpens the edge. A glTF spot
    // carries no exponent and the PBR path shades cones by inverse-square
    // falloff instead, which never reads this.
    float exponent = 1.0f;
    Color3 diffuse_color{};
    Color3 specular_color{};
    Color3 ground_color{0.0f, 0.0f, 0.0f};
    std::array<float, 16> local_matrix{};
    // The meshes this light applies to, as the pinned engine keeps them: an
    // inclusion list wins outright when it is non-empty, otherwise the
    // exclusion list filters. Empty on both means every mesh, which is what
    // a light created in scene code gets.
    std::vector<std::uint32_t> included_meshes;
    std::vector<std::uint32_t> excluded_meshes;
    /**
     * `light.shadowGenerator`. The pin's `ShadowTask` walks `scene.lights`
     * and renders each light's generator, and `standard-renderable.ts`
     * collects the receiver slots from the same walk, so the generator
     * hangs off the light in both directions.
     */
    ShadowGeneratorHandle shadow_generator{};
};

// `{ x, y }` as src/camera/geospatial-limits.ts holds the pitch-disable
// scale: two JavaScript numbers, so two doubles.
struct GeospatialScale {
    double x = 0.0;
    double y = 0.0;
};

/**
 * `GeospatialLimits` (src/camera/geospatial-limits.ts): the bounds a
 * geospatial camera clamps yaw, pitch and radius against.
 *
 * Every member is a JavaScript number the pinned `createGeospatialLimits`
 * writes -- including the two yaw bounds, which default to -/+Infinity and
 * which a double holds exactly -- so the record is left zero-initialised and
 * the generated factory fills it from the pin's own literal.
 * `pitch_disabled_radius_scale` is the pin's nullable `{ x, y }`: absent is
 * the documented "full pitch at every radius" arm.
 */
struct GeospatialLimits {
    double planet_radius = 0.0;
    double radius_min = 0.0;
    double radius_max = 0.0;
    double pitch_min = 0.0;
    double pitch_max = 0.0;
    double yaw_min = 0.0;
    double yaw_max = 0.0;
    std::optional<GeospatialScale> pitch_disabled_radius_scale;
};

// Every scalar the pinned camera factories hold is a plain JavaScript
// number, and `src/camera/camera.ts` reads them into the view and
// projection writers in that precision. The record therefore keeps
// doubles, and `camera_world_matrix` performs the single store the pinned
// `allocateMat4()` cache performs -- into float32 by default, and into
// float64 under the high-precision matrix a floating-origin engine asks
// for, which is the width `getViewMatrix` then reads the basis back at.
struct CameraRecord {
    double world_matrix_version = 0.0;
    double projection_revision = 0.0;
    double projection_fov = std::numeric_limits<double>::quiet_NaN();
    double projection_near = std::numeric_limits<double>::quiet_NaN();
    double projection_far = std::numeric_limits<double>::quiet_NaN();
    bool limits_installed = false;
    CameraKind kind = CameraKind::arc_rotate;
    Vec3d position{};
    double alpha = -pi_double / 2.0;
    double beta = 1.1;
    double radius = 6.0;
    Vec3d target{};
    Vec3d up_vector{0.0, 1.0, 0.0};
    double fov = 0.8;
    double near_plane = 0.1;
    double far_plane = 1000.0;
    double inertia = 0.9;
    double panning_inertia = 0.9;
    double angular_sensibility = 1000.0;
    double speed = 2.0;
    double free_yaw = 0.0;
    double free_pitch = 0.0;
    double inertial_yaw_offset = 0.0;
    double inertial_pitch_offset = 0.0;
    Vec3d inertial_direction{};
    double panning_sensibility = 50.0;
    double wheel_precision = 3.0;
    double inertial_alpha_offset = 0.0;
    double inertial_beta_offset = 0.0;
    double inertial_radius_offset = 0.0;
    double inertial_panning_x = 0.0;
    double inertial_panning_y = 0.0;
    std::optional<double> lower_alpha_limit;
    std::optional<double> upper_alpha_limit;
    std::optional<double> lower_beta_limit;
    std::optional<double> upper_beta_limit;
    std::optional<double> lower_radius_limit;
    std::optional<double> upper_radius_limit;
    bool controls_enabled = false;
    std::function<bool()> should_handle_pointer_down;
    std::function<bool()> external_drag_active;
    std::function<bool()> external_pick_pending;
    // Orthographic projection state (src/camera/orthographic.ts). The
    // four clip planes stay derived from the half-extent, which is the
    // reached surface: vertically +/-half_height, horizontally scaled by
    // the render target's aspect ratio.
    bool orthographic = false;
    double ortho_half_height = 1.0;
    /**
     * The `_camera` glTF loader feature's naming: `def.name ?? camera<idx>`
     * on an imported camera, the record default (empty) on a scene-created
     * one — matching the pin, whose scene cameras leave `name` unset.
     */
    std::string name;
    /**
     * An imported glTF camera is the pin's FreeCamera parented under its
     * `<name>_fixup` transform: `getWorldMatrix` composes
     * `parent_world × local` through the pinned multiply, so the record
     * carries the fixup node's composed world. The loader writes it — once
     * for a baked (unreachable) node, per pose for a live one.
     */
    bool has_parent_world = false;
    std::array<float, 16> parent_world{};
    /**
     * `camera.viewport` — absent on a camera that draws the whole target,
     * which is every camera the pin does not give one. Both readers ask
     * for it exactly where upstream asks `const v = camera?.viewport`:
     * `upstream::effective_aspect_ratio` scales the target ratio by it,
     * and each backend's scene pass sets the viewport and scissor
     * `upstream::resolve_camera_viewport` resolves it to.
     */
    std::optional<NormalizedViewport> viewport;
    /**
     * Geospatial orientation (src/camera/geospatial-camera.ts). The pinned
     * factory describes a pose by the anchored ECEF `center` it orbits plus
     * `yaw`, `pitch` and `radius`, and derives `_lookAt` from them; the
     * `radius`, `position` and `up_vector` above are the same fields the
     * other two factories write, so only these four and the limits are new.
     * `target` carries the pin's own `center3` (`position + _lookAt`), which
     * is what its local-matrix writer looks towards.
     */
    Vec3d center{};
    double yaw = 0.0;
    double pitch = 0.0;
    Vec3d look_at{};
    GeospatialLimits limits;
};

struct Scene;
struct FrameGraphContext;

// One glTF animation as scene code addresses it, mirroring the group
// src/animation/animation-group.ts builds per clip. The play state lives with
// the clip inside the owning asset's runtime; this record carries what a scene
// reads and the coordinates the operations need to reach it.
struct AnimationGroupRecord {
    std::string name;
    std::uint32_t asset = invalid_handle;
    std::size_t clip = 0;
    /** `AnimationGroup.weight`: what the weighted mixer contributes it at. */
    float weight = 1.0f;
    std::weak_ptr<PropertyAnimationManagerRecord> animation_owner;
};

/**
 * One bone's local-transform override, the pin's own `BoneOverride`
 * (`src/skeleton/bone-control.ts`), at the slice this port reaches.
 *
 * Upstream the mask carries four bits and the record carries the
 * translation, rotation and scale each of the first three replaces.
 * `setBoneVisible` is the one lowered mutator here, so no override this
 * port can build carries anything but the hidden bit -- the lanes arrive
 * with the setters that fill them. The mask itself stays, because the
 * pin's own show arm is written on it: clear the bit, and drop the
 * override once the mask is empty.
 */
struct BoneOverride {
    std::uint32_t mask = 0;
};

/**
 * One joint node of a skeleton, in the skin's own `joints` order.
 *
 * `name` is the glTF node's name, or the pin's `bone_<nodeIndex>`
 * fallback; `node_index` is the key every override is stored under, which
 * is what makes an override reach across skins through the hierarchy.
 */
struct BoneRecord {
    std::string name;
    std::uint32_t node_index = 0;
};

/**
 * A skinned model's skeleton -- one per glTF skin instance, surfaced on
 * `AssetContainer.skeletons` once the scene reached `enableBoneControl`.
 *
 * The overrides themselves live on the owning asset, because upstream's
 * map is asset-wide and one bake refreshes every skinned mesh of the file.
 */
struct SkeletonRecord {
    std::uint32_t asset = invalid_handle;
    std::vector<BoneHandle> bones;
};

/**
 * A skeleton a scene authored in code (`skeleton/create-skeleton.ts`).
 *
 * Upstream this is a GPU resource -- the per-bone rgba32float palette
 * texture plus the joint and weight vertex buffers -- shared by every mesh
 * assigned it, and `updateSkeletonBoneMatrices` rewrites the one texture
 * that all of them sample. Here the palette rides each attached mesh
 * record, which is where both backends' upload already reads it from, so
 * this record holds the shared per-vertex streams and the list of meshes
 * that took them: a live update writes the store here and then every
 * attached record, which is the one texture write upstream performs.
 *
 * It is deliberately NOT `SkeletonRecord` beside it: that one is the
 * opt-in bone-control chunk's per-skin handle over a loaded glTF, whose
 * bones are nodes of an asset hierarchy. These two never meet in one
 * scene, and giving them one handle would let `getBoneByName` be asked
 * for a joint this record does not have.
 */
struct SceneSkeletonRecord {
    /** Four joint indices per vertex, as `createSkeleton` received them. */
    std::vector<std::uint16_t> joints;
    /** Four weights per vertex, in the same order. */
    std::vector<float> weights;
    std::uint32_t bone_count = 0;
    /**
     * The authored palette. Unlike the glTF pose pass's product this is
     * exactly what the scene passed: the pin composes
     * `finalWorld = mesh.world * influence`, and a scene that writes its
     * own bone matrices keeps its mesh transform on the record.
     */
    std::vector<std::array<float, 16>> bone_matrices;
    /** Every mesh `mesh.skeleton = ...` handed this skeleton. */
    std::vector<MeshHandle> meshes;
};

/** One attached `KHR_interactivity` graph; the generated flow-graph unit defines it. */
struct FlowGraphRuntime;

/** One graph a glTF document declares: `container.flowGraphs[index]`. */
struct FlowGraphHandle {
    AssetHandle asset{};
    std::uint32_t index = 0;
};

struct AssetMeshWalks {
    // Absent for producers whose entity list is already their mesh storage.
    std::optional<std::vector<std::size_t>> scene;
    std::vector<std::vector<std::size_t>> collectors;
};

struct GltfAnimationRuntimeState;

struct AssetRecord {
    std::vector<MeshHandle> meshes;
    // Source traversals, separate from loader-order storage.
    // A cloned root shares the indices and maps them to its own mesh handles.
    std::shared_ptr<const AssetMeshWalks> source_mesh_walks{};
    std::vector<LightHandle> lights;
    /**
     * The cameras the `_camera` loader feature instantiated, one per
     * referencing glTF node in node order — `AssetContainer.cameras`.
     */
    std::vector<CameraHandle> cameras;
    // The synthetic root's own transform for a hierarchy clone. The cloned
    // mesh records carry it as `outer_position`/`outer_rotation`; these
    // values preserve absolute assignment and clone-of-clone semantics.
    Vec3 root_position{};
    Vec3 root_rotation{};
    /** Whether the public glTF root's synthetic X mirror was reset to identity. */
    bool root_scaling_reset = false;
    CameraHandle camera{};
    Color4 clear_color{};
    bool has_camera = false;
    bool has_clear_color = false;
    std::function<void(float)> animation_tick;
    std::function<void(float)> animation_seek;
    std::shared_ptr<GltfAnimationRuntimeState> source_animation;
    std::function<void(std::size_t, double, bool)> animation_tick_group;
    js::Callback<void(float)> before_render_hook;
    /**
     * Registers a cloned mesh with the source asset's animation runtime.
     * Babylon Lite clones retain the same skeleton/morph resources, so a
     * hierarchy clone continues to receive the original controller's pose.
     */
    std::function<void(MeshHandle, MeshHandle)> clone_mesh_animation;
    js::Callback<void(Scene&)> scene_setup;
    std::map<std::weak_ptr<SceneState>, js::Callback<void()>, std::owner_less<std::weak_ptr<SceneState>>> scene_cleanups;
    /**
     * `KHR_interactivity`'s view of the file, filled only when the asset
     * carries graphs: `mesh._gltfNodeIndex` per entry of `meshes`, each
     * node's own meshes and children, the glTF material index the pointer
     * accessors name, and the per-node visibility flag the pinned
     * extension materialized and the graph's setter cascades.
     */
    std::vector<std::size_t> mesh_nodes;
    std::vector<std::vector<MeshHandle>> node_meshes;
    std::vector<std::vector<std::size_t>> node_children;
    std::vector<MaterialHandle> materials;
    std::vector<bool> node_visible;
    /**
     * `container.flowGraphs`: the graphs the document declares, in graph
     * order, filled at load; the generated flow-graph unit runs them.
     */
    std::vector<FlowGraphHandle> flow_graphs;
    /**
     * `container.flowGraphRuntimes`: the runtimes the latest addToScene
     * attached for this asset, one per graph in graph order. Assigned per
     * add and kept past the scene's disposal, as the pin keeps its
     * resolved array.
     */
    std::vector<std::shared_ptr<FlowGraphRuntime>> flow_graph_runtimes;
    /**
     * `AssetContainer._gaussianSplats`: the clouds the pinned
     * `KHR_gaussian_splatting` feature contributed, one per GS primitive, in
     * document order. The loader builds them; `scene_setup` registers them,
     * which is where upstream fills the same list.
     */
    std::vector<SplatMeshHandle> gaussian_splats;
    /** This asset's clips, in the document's own animation order. */
    std::vector<AnimationGroupHandle> animation_groups;
    /** Sets one clip's isPlaying, through the loader's own runtime. */
    std::function<void(std::size_t, bool)> set_clip_playing;
    /** Sets one clip's _stopped, which decides whether a seek reaches it. */
    std::function<void(std::size_t, bool)> set_clip_stopped;
    /** Sets one clip's currentTime in seconds. */
    std::function<void(std::size_t, float)> set_clip_time;
    /**
     * Applies one clip at its stored time. The boolean is the pin's own
     * `engine` argument to `goToFrame`: without it a stopped glTF group's
     * controller is not ticked, with it the pose lands anyway.
     */
    std::function<void(std::size_t, bool)> apply_clip_pose;
    /**
     * One clip's duration in seconds. The VAT bake needs it to size the
     * clip's row block -- `round(duration * frameRate) + 1` frames -- and
     * the clip table lives inside the generated loader's own runtime, so
     * this is the reader for it, beside the writers above.
     */
    std::function<float(std::size_t)> clip_duration;
    /** VAT binding lookup over the group's shared glTF skeleton bindings. */
    std::function<bool(MeshHandle)> animation_has_skeleton;
    /** Source goToFrameCpu, which seeks without publishing GPU palettes. */
    std::function<void(std::size_t, double)> animation_cpu_go_to_frame;
    /** Shared CPU bone palette folded into this mesh's native VAT coordinates. */
    std::function<std::vector<std::array<float, 16>>(MeshHandle)> animation_bone_palette;
    /** Sets one clip's loopAnimation, which the weighted mixer reads. */
    std::function<void(std::size_t, bool)> set_clip_loop;
    /** Sets one clip's speedRatio, which its own advance scales by. */
    std::function<void(std::size_t, float)> set_clip_speed_ratio;
    /**
     * Resolves one clip's AnimationGroupMask against the asset's node names
     * and stores the skip flags the channel walk reads (the pin's own
     * resolveAnimationMask).
     */
    std::function<
        void(std::size_t, const std::vector<std::string>&, bool)>
        set_clip_mask;
    // Marks one clip additive at its reference time (the pin's
    // `group._additive = { referenceTime }`); filled by the generated
    // loader only when the additive mixer is compiled in.
    std::function<void(std::size_t, float)> set_clip_additive;
    /**
     * `AssetContainer.skeletons`: the skeletons the opt-in bone-control
     * chunk built for this file, empty for every other scene.
     */
    std::vector<SkeletonHandle> skeletons;
    /**
     * The asset-wide overrides, one slot per glTF node -- the pin keys its
     * `_overrides` map by node index for the same reason, since a single
     * skin is often split across meshes and an override may reach across
     * skins through the hierarchy. A zero mask is an absent entry, which is
     * exactly what the pin's own `delete` leaves behind, and a dense table
     * is what makes its `size() > 0` gate structural: the bake walks these
     * nodes either way.
     */
    std::vector<BoneOverride> bone_overrides;
    /**
     * The pin's eager bake: recompute this file's node hierarchy from rest
     * plus overrides and refresh every skinned mesh's palette. Filled only
     * by a loader compiled with bone control.
     */
    std::function<void()> bake_skeletons;
};

inline std::vector<std::size_t> asset_mesh_indices(std::size_t count, const std::vector<double>& entries) {
    std::vector<std::size_t> indices;
    indices.reserve(entries.size());
    for (const auto number : entries) {
        if (!(number >= 0 && number < static_cast<double>(count)) || std::floor(number) != number)
            throw std::runtime_error("Invalid source mesh walk index.");
        indices.push_back(static_cast<std::size_t>(number));
    }
    return indices;
}

/** Scene registration can select a subset and can visit the same mesh again. */
inline void install_asset_scene_meshes(AssetRecord& asset, const std::vector<double>& entries) {
    auto indices = asset_mesh_indices(asset.meshes.size(), entries);
    auto walks = std::make_shared<AssetMeshWalks>();
    if (asset.source_mesh_walks) walks->collectors = asset.source_mesh_walks->collectors;
    walks->scene = std::move(indices);
    asset.source_mesh_walks = std::move(walks);
}

/** Install validated permutations over a loader's native mesh collection. */
inline void install_asset_mesh_walks(AssetRecord& asset, const std::vector<std::vector<double>>& rows) {
    auto walks = std::make_shared<AssetMeshWalks>();
    if (asset.source_mesh_walks) walks->scene = asset.source_mesh_walks->scene;
    walks->collectors.reserve(rows.size());
    for (const auto& entries : rows) {
        auto& walk = walks->collectors.emplace_back();
        if (entries.empty()) continue;
        if (entries.size() != asset.meshes.size()) throw std::runtime_error("Invalid source mesh walk size.");
        std::vector<bool> seen(asset.meshes.size());
        walk = asset_mesh_indices(asset.meshes.size(), entries);
        for (const auto index : walk) {
            if (seen[index]) throw std::runtime_error("Repeated source mesh walk index.");
            seen[index] = true;
        }
    }
    asset.source_mesh_walks = std::move(walks);
}

struct HierarchyInstancePoolBinding {
    MeshHandle mesh{};
    std::array<float, 16> mesh_world{};
    std::array<float, 16> mesh_world_inverse{};
};

/** Engine-owned state for the pin's fixed-capacity hierarchy instance pool. */
struct HierarchyInstancePoolRecord {
    AssetHandle root{};
    std::uint32_t capacity = 0;
    std::uint32_t count = 0;
    std::vector<MeshHandle> meshes;
    std::vector<HierarchyInstancePoolBinding> bindings;
    std::array<float, 16> scratch{};
};

/**
 * Which pinned generator built a shadow map.
 *
 * The two PCF arms share everything the receiver sees -- the same
 * `depth32float` map, the same comparison sampler, the same
 * `createShadowFragment` binding types -- and differ only in the projection
 * their light-space matrix is fitted with, which is why every consumer that
 * asks about a generator's RESOURCES tests for the ESM arm alone.
 */
#if !defined(BBLITE_HAS_SHADOWS) || BBLITE_HAS_SHADOWS
#include <bblite/runtime/shadow-records.hpp>
#endif

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
enum class UiStyleSelectorKind : std::uint8_t {
    Sequence,
    Class,
    Id,
    CompoundClass,
    ClassDescendantTag,
    IdDescendantClass,
    /** `tag.class`, the element's own tag gated on one of its classes. */
    TagClass,
    /** `tag[attribute="identifier"]`, with a statically validated value. */
    TagAttribute,
    /** `tag > .class`, an immediate parent tag and child class. */
    TagChildClass,
};

enum class UiScrollbarPart : std::uint8_t { None, Scrollbar, Thumb, Track, Button, Corner };
enum class UiMotionPreference : std::uint8_t { Any, Reduce, NoPreference };

enum class UiSelectorTestKind : std::uint8_t {
    Tag, Id, Class, Attribute, Equals, Hover, Active, Focus, FocusVisible, FocusWithin, Disabled, Checked,
    NthChild, NthLastChild, NthOfType, NthLastOfType, OnlyChild, OnlyOfType, Empty, Not, Is, Where, Has,
};
enum class UiSelectorRelation : std::uint8_t { Self, Descendant, Child, Next, Following };
struct UiSelectorStep;
struct UiSelectorTest {
    UiSelectorTestKind kind; std::string name; std::string value;
    std::vector<std::vector<UiSelectorStep>> alternatives{};
    std::int32_t a = 0, b = 0;
};
struct UiSelectorStep { UiSelectorRelation relation; std::vector<UiSelectorTest> tests; };
enum class UiGeneratedPart : std::uint8_t { None, Before, After, Placeholder };
enum class UiContentPartKind : std::uint8_t { Text, Attribute };
struct UiContentPart { UiContentPartKind kind; std::string value; };
struct UiGeneratedContent { bool enabled = false; std::vector<UiContentPart> parts{}; };

/**
 * One compiler-validated stylesheet rule.
 *
 * The typed selector is deliberately smaller than CSS. It is sufficient to
 * serialize an exact RmlUi selector and to inspect private structural
 * adaptation metadata without adding a browser selector engine to the PAL.
 */
struct UiStyleRule {
    UiStyleSelectorKind selector = UiStyleSelectorKind::Class;
    std::string primary;
    std::string secondary;
    std::string tag;
    std::string style;
    /** A negative value means the rule is not inside a max-width query. */
    double max_width = -1.0;
    bool hover = false;
    bool focus_visible = false;
    bool active = false;
    UiScrollbarPart scrollbar = UiScrollbarPart::None;
    UiMotionPreference motion = UiMotionPreference::Any;
    std::vector<UiSelectorStep> sequence{};
    UiGeneratedPart generated = UiGeneratedPart::None;
    std::optional<UiGeneratedContent> content{};
};

/**
 * The retained UI representation produced by DOM lowering.
 *
 * This deliberately contains browser-neutral data only. RmlUi element
 * pointers and SDL_GPU resources belong to the PAL runtime built over it,
 * allowing another backend to consume the same tree later.
 */
struct UiElementRecord {
    struct CanvasPoint {
        double x = 0.0;
        double y = 0.0;
    };
    struct CanvasDrawCommand {
        enum class Kind { Fill, FillRect, Stroke, Blit, Text } kind = Kind::Fill;
        std::vector<CanvasPoint> points;
        std::string color;
        double line_width = 1.0;
        bool closed = false;
        bool round_join = false;
        bool round_cap = false;
        UiElementHandle source{};
        double destination_x = 0.0;
        double destination_y = 0.0;
        double destination_width = 0.0;
        double destination_height = 0.0;
        bool nearest_sampling = false;
        std::string text;
        double font_size = 10.0;
        std::string font_family = "sans-serif";
        std::string text_baseline = "alphabetic";
        std::string shadow_color = "rgba(0,0,0,0)";
        double shadow_blur = 0.0;
    };
    struct CanvasState {
        double width = 300.0;
        double height = 150.0;
        double scale_x = 1.0;
        double scale_y = 1.0;
        std::string fill_style = "#000000";
        std::string stroke_style = "#000000";
        double line_width = 1.0;
        std::string line_join = "miter";
        std::string line_cap = "butt";
        std::vector<CanvasPoint> path;
        bool path_closed = false;
        std::vector<CanvasDrawCommand> draws;
        /** Premultiplied RGBA backing pixels populated by putImageData. */
        std::vector<std::uint8_t> pixels;
        std::uint64_t pixel_revision = 0;
        bool image_smoothing_enabled = true;
        std::string font = "10px sans-serif";
        std::string text_baseline = "alphabetic";
        std::string shadow_color = "rgba(0,0,0,0)";
        double shadow_blur = 0.0;
    };
    std::string tag;
    std::string text;
    /** Static markup assigned through the reached element.innerHTML surface. */
    std::string inner_rml;
    std::unordered_map<std::string, std::string> attributes;
    std::unordered_map<std::string, std::string> style_properties;
    /** Latest write order, one entry per property; empty values remove declarations. */
    std::vector<std::string> style_property_order;
    /** Rules owned by this retained <style> element, in source order. */
    std::vector<UiStyleRule> style_rules;
    UiElementHandle parent{};
    std::vector<UiElementHandle> children;
    /**
     * A compiler-addressable node inside static inner RML. These records do
     * not render a second element; the UI projection binds them to the node
     * carrying the matching data-bbl-node attribute.
     */
    UiElementHandle markup_owner{};
    std::uint32_t markup_node_id = invalid_handle;
    /** Materialized static-markup nodes owned by this element. */
    std::vector<UiElementHandle> markup_children;
    std::vector<std::function<void()>> click_callbacks;
    std::unordered_map<
        std::string,
        std::vector<std::function<void(const PlatformMouseEvent&)>>>
        event_callbacks;
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
    /** Browser-file state exists only for retained <a>/<input> elements. */
    ObjectUrlHandle download_url{};
    BrowserFileHandle selected_file{};
    std::string download_name;
    std::string file_accept;
    std::vector<std::function<void()>> file_change_callbacks;
    bool file_input = false;
#endif
    UiClientRect client_rect{};
    bool client_rect_requested = false;
    std::optional<CanvasState> canvas;
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    bool external_gpu_canvas = false;
#endif
    bool attached_to_root = false;
};

#endif

#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
/** One recyclable object-URL slot. Generation prevents stale-handle reuse. */
struct ObjectUrlRecord {
    std::shared_ptr<const std::vector<std::uint8_t>> bytes;
    std::string mime_type;
    std::uint32_t generation = 1;
    bool active = false;
};

inline constexpr std::size_t maximum_browser_file_snapshots = 4096u;
inline constexpr std::size_t maximum_browser_file_snapshot_bytes =
    256u * 1024u * 1024u;

/** Per-engine accounting shared with snapshots that outlive their input. */
class BrowserFileStorage {
  public:
    explicit BrowserFileStorage(
        std::size_t maximum_bytes = maximum_browser_file_snapshot_bytes)
        : maximum_bytes_(maximum_bytes) {}

    [[nodiscard]] std::size_t retained_bytes() const noexcept {
        return retained_bytes_;
    }
    [[nodiscard]] std::size_t snapshot_count() const noexcept {
        return snapshot_count_;
    }

    void retain(std::size_t bytes) {
        if (snapshot_count_ >= maximum_browser_file_snapshots) {
            throw std::runtime_error(
                "Native selected-file storage exceeds its 4096-live-snapshot bound.");
        }
        if (bytes > maximum_bytes_ - retained_bytes_) {
            throw std::runtime_error(
                "Native selected-file storage exceeds its per-engine aggregate byte bound.");
        }
        retained_bytes_ += bytes;
        ++snapshot_count_;
    }

    void resize(std::size_t old_bytes, std::size_t new_bytes) {
        const std::size_t retained_without_old = retained_bytes_ - old_bytes;
        if (new_bytes > maximum_bytes_ - retained_without_old) {
            throw std::runtime_error(
                "Native selected-file storage exceeds its per-engine aggregate byte bound.");
        }
        retained_bytes_ = retained_without_old + new_bytes;
    }

    void release(std::size_t bytes) noexcept {
        retained_bytes_ -= bytes;
        --snapshot_count_;
    }

  private:
    std::size_t maximum_bytes_ = 0;
    std::size_t retained_bytes_ = 0;
    std::size_t snapshot_count_ = 0;
};

/** Exact bytes consented to at selection time; no pathname is retained. */
struct BrowserFileRecord {
    BrowserFileRecord(
        std::vector<std::uint8_t> selected_bytes,
        std::string selected_display_name,
        std::shared_ptr<BrowserFileStorage> selected_storage)
        : bytes(std::move(selected_bytes)),
          display_name(std::move(selected_display_name)),
          storage(std::move(selected_storage)) {
        if (!storage) {
            throw std::runtime_error(
                "Native selected-file storage is unavailable.");
        }
        storage->retain(bytes.size());
    }
    BrowserFileRecord(const BrowserFileRecord&) = delete;
    BrowserFileRecord& operator=(const BrowserFileRecord&) = delete;
    ~BrowserFileRecord() {
        storage->release(bytes.size());
    }

    void replace(
        std::vector<std::uint8_t> selected_bytes,
        std::string selected_display_name) {
        storage->resize(bytes.size(), selected_bytes.size());
        bytes.swap(selected_bytes);
        display_name.swap(selected_display_name);
    }

    [[nodiscard]] bool belongs_to(
        const std::shared_ptr<BrowserFileStorage>& owner) const noexcept {
        return storage == owner;
    }

    std::vector<std::uint8_t> bytes;
    std::string display_name;

  private:
    std::shared_ptr<BrowserFileStorage> storage;
};
#endif

#if !defined(BBLITE_HAS_GIZMOS) || BBLITE_HAS_GIZMOS
#include <bblite/runtime/gizmo-records.hpp>
#endif

struct AnimationFrameRequestState {
    std::size_t id;
    js::Callback<void(double)> callback;
    bool pending = true;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(callback); }
};

/** Snapshots share cancellation state with the pending request registry. */
struct AnimationFrameRequest {
    Engine* engine;
    std::shared_ptr<AnimationFrameRequestState> state;
    void operator()(double timestamp) const;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(state); }
};

/** A borrowed owner's address is valid only during this wrapper's lifetime.
 * Moving the owner invalidates its old borrows; later operations obtain a new
 * token for the new address. Construction itself allocates nothing. */
class OwnerLifetime {
public:
    OwnerLifetime() = default;
    OwnerLifetime(const OwnerLifetime&) {}
    OwnerLifetime(OwnerLifetime&& other) noexcept { other.token_.reset(); }
    OwnerLifetime& operator=(const OwnerLifetime& other) {
        if (this != &other) token_.reset();
        return *this;
    }
    OwnerLifetime& operator=(OwnerLifetime&& other) noexcept {
        if (this != &other) { token_.reset(); other.token_.reset(); }
        return *this;
    }
    [[nodiscard]] std::weak_ptr<const int> token() {
        if (!token_) token_ = std::make_shared<const int>(0);
        return token_;
    }
private:
    std::shared_ptr<const int> token_;
};

class GpuTransportError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct GpuDeviceIdentity {
    Engine* engine = nullptr;
    std::uint64_t generation = 0;
    friend bool operator==(const GpuDeviceIdentity&, const GpuDeviceIdentity&) = default;
};
/**
 * The identity of a texture a backend published for the device-recovery
 * observers: the device generation it was created under and the
 * allocation ordinal `publish_gpu_texture_identity` hands out. An ordinal
 * rather than the object's address, so the shared record carries no
 * foreign handle and a recycled address cannot alias an older texture.
 * Generated readers compare identities and test `object` for zero, which
 * no published identity carries.
 */
struct GpuTextureIdentity {
    std::uint64_t generation = 0;
    std::uint64_t object = 0;
    friend bool operator==(const GpuTextureIdentity&, const GpuTextureIdentity&) = default;
};
struct EnvironmentIdentity {
    Engine* engine = nullptr;
    std::shared_ptr<SceneState> scene;
    std::uint64_t value = 0;
    friend bool operator==(const EnvironmentIdentity&, const EnvironmentIdentity&) = default;
};
struct DeviceRecoveryRegistration {
    Engine* engine = nullptr;
    bool disabled = false;
    std::function<void()> on_lost;
    std::function<void()> on_recovered;
    std::function<void(const std::string&)> on_failed;
};

using MeshMaterialSceneOwners = std::vector<std::weak_ptr<SceneState>>;

struct Engine {
    std::unordered_map<std::uint32_t, std::shared_ptr<MeshMaterialSceneOwners>> mesh_material_scenes;
    struct DeviceRecoveryState;
    std::shared_ptr<DeviceRecoveryState> device_recovery;
    std::uint64_t device_generation = 1;
    std::uint64_t draw_call_count = 0;
    OwnerLifetime lifetime;
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    std::shared_ptr<pal::OffscreenRun> offscreen_run;
#endif
    /** Generated subsystem state; callbacks hold weak references back to it. */
    std::vector<std::shared_ptr<void>> native_resource_owners;
    std::shared_ptr<pal::AudioSession> audio_session;
    EngineOptions options{};
    /** Logical CSS-pixel extent exposed by renderCanvas.clientWidth/Height. */
    double canvas_client_width = 1280.0;
    double canvas_client_height = 720.0;
    /** SDL window coordinates to browser client coordinates (CSS pixels). */
    double canvas_window_to_client_scale = 1.0;
    /** Retained primary-canvas dataset, including the harness readiness handshake. */
    std::unordered_map<std::string, std::string> canvas_dataset;
    /**
     * `stopEngine`: the pin cancels its animation frame and clears
     * `_renderFn`, so no further frame submits. There is no
     * `requestAnimationFrame` here -- the frame conductor IS the loop --
     * so the same thing is a flag it checks, and a stopped engine is one
     * the conductor leaves after finishing the frame in flight.
     */
    bool stopped = false;
    /**
     * The scene's own capture-readiness conditions, from a bounded
     * multi-frame drain. Every one must hold before a frame loop takes the
     * capture it was asked for.
     */
    std::vector<std::function<bool()>> capture_ready;
    /**
     * `setTimeout(callback, 0)`: callbacks queued to run once, after the
     * frame that queued them. Non-zero waits live in `timeout_callbacks`;
     * zero remains a distinct next-turn queue so a callback queued while it
     * drains cannot run recursively in the same frame.
     */
    std::vector<std::function<void()>> deferred_callbacks;
    std::vector<std::function<void()>> material_continuations;
    void (*drain_material_jobs)(Engine&) = nullptr;
    /**
     * Entry-code continuations waiting for a render boundary. A measured
     * capture cannot precede code after `await startEngine`, and a frame
     * yield inside that continuation re-queues its remainder as a nested
     * continuation -- one elapsed frame per yield -- so the count stays
     * above zero until the innermost part has run.
     */
    std::uint32_t pending_start_continuations = 0;
    /** Browser one-shot timers with non-zero delays. */
    struct TimeoutCallback {
        std::uint64_t id = 0;
        double due_ms = 0.0;
        std::function<void()> callback;
    };
    std::vector<TimeoutCallback> timeout_callbacks;
    std::uint64_t next_timeout_id = 1;
    /**
     * Browser `setInterval` callbacks. They share the frame conductor's
     * double-precision monotonic clock and run at most once per frame; the
     * next due time still advances by whole periods so a late frame does not
     * introduce permanent drift. `clearInterval` marks an entry inactive,
     * including while another due callback is being drained.
     */
    struct IntervalCallback {
        std::uint64_t id = 0;
        double period_ms = 0.0;
        double next_due_ms = 0.0;
        std::function<void()> callback;
        bool active = true;
    };
    std::vector<IntervalCallback> interval_callbacks;
    std::uint64_t next_interval_id = 1;
    /** Platform callbacks with DOM listener identity and removal semantics. */
    std::shared_ptr<DomInput> dom_input;
    PlatformEventListeners<void(const PlatformKeyboardEvent&)>
        key_down_callbacks;
    PlatformEventListeners<void(const PlatformKeyboardEvent&)>
        key_up_callbacks;
    PlatformEventListeners<void()> pointer_down_callbacks;
    PlatformEventListeners<void()> canvas_click_callbacks;
    /** Primary-button canvas press awaiting its matching in-canvas release. */
    bool canvas_click_armed = false;
    PlatformEventListeners<void(const PlatformMouseEvent&)>
        mouse_down_callbacks;
    PlatformEventListeners<void(const PlatformMouseEvent&)>
        mouse_up_callbacks;
    PlatformEventListeners<void(const PlatformMouseEvent&)>
        mouse_move_callbacks;
    PlatformEventListeners<void(const PlatformMouseEvent&)>
        mouse_wheel_callbacks;
    PlatformEventListeners<void(const PlatformMouseEvent&)>
        mouse_cancel_callbacks;
#if defined(BBLITE_HAS_GAMEPAD) && BBLITE_HAS_GAMEPAD
    /** Cached browser property identities; owns no SDL handles. */
    std::shared_ptr<PlatformGamepadState> platform_gamepad_state;
#endif
    /** Browser `window.resize` callbacks, dispatched after canvas size sync. */
    PlatformEventListeners<void()> window_resize_callbacks;
    PlatformEventListeners<void()> pointer_lock_change_callbacks;
    /** Desired and applied equivalents of the browser pointer-lock state. */
    bool pointer_lock_requested = false;
    bool pointer_locked = false;
    /** CSS cursor requested on the engine's browser canvas. */
    std::string canvas_cursor;
    /** Programmatic focus requested by the source render canvas. */
    bool canvas_focused = false;
    PlatformEventListeners<void(bool)> visibility_change_callbacks;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    /** Scene-created DOM after compiler lowering, independent of RmlUi. */
    std::vector<UiElementRecord> ui_elements;
    /** The primary 2D canvas, when this engine is only a platform host. */
    UiElementHandle primary_canvas{};
    /** Retained canvas of the engine's primary GPU surface, when hosted in a page. */
    std::optional<UiElementHandle> surface_canvas;
    UiElementHandle ui_focused_element{};
    std::uint64_t ui_focus_revision = 0;
    bool ui_focus_visible = true;
    /** Direct document children in live DOM attachment order. */
    std::vector<UiElementHandle> ui_root_children;
    struct DocumentRoots {
        UiElementHandle html, head, body;
        [[nodiscard]] bool active() const noexcept { return html.value != invalid_handle; }
    } ui_document_roots;
    /** Audited host-page rules, preceding scene-created sheets in cascade. */
    std::vector<UiStyleRule> ui_host_style_rules;
    /** A realm host can synchronously publish pending edits before a source layout read. */
    UiClientRect (*ui_measure_element)(Engine&, UiElementHandle) = nullptr;
    /** Any tree/text/style/listener mutation invalidates the PAL projection. */
    std::uint64_t ui_revision = 0;
    std::uint64_t ui_style_revision = 0;
#endif
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
    /** Per-engine Blob URL registry; revoked slots are cleared and recycled. */
    std::vector<ObjectUrlRecord> object_urls;
    std::vector<std::uint32_t> free_object_url_slots;
    /** Live input/File/FileList values share reclaimable picker snapshots. */
    std::shared_ptr<BrowserFileStorage> browser_file_storage =
        std::make_shared<BrowserFileStorage>();
#endif
    /**
     * Application-owned `requestAnimationFrame` callbacks registered before
     * `startEngine`. Browser RAF callbacks run in registration order, so these
     * precede the engine-owned render callback.
     */
    SnapshotList<js::Callback<void(double)>> animation_frame_callbacks;
    /**
     * One-shot browser RAF callbacks. The conductor moves this queue before
     * invoking it, so a callback which schedules another RAF naturally runs
     * that continuation on the following frame.
     */
    std::vector<AnimationFrameRequest>
        animation_frame_once_callbacks;
    std::vector<AnimationFrameRequest>
        post_render_animation_frame_once_callbacks;
    std::unordered_map<std::size_t, std::shared_ptr<AnimationFrameRequestState>> animation_frame_requests;
    std::size_t next_animation_frame_request = 1;
    /** The next engine RAF is already queued after this turn's render. */
    bool animation_frame_after_render = false;
    /**
     * Application-owned RAF callbacks registered after `startEngine` has
     * resolved. The engine callback was registered first, so these run after
     * the frame has been submitted and can only affect the following frame.
     */
    std::vector<std::function<void(double)>>
        post_render_animation_frame_callbacks;
    /** The awaited start resolves only after the engine's initial render. */
    bool post_render_animation_frame_callbacks_armed = false;
    /** One double-precision DOMHighResTimeStamp shared by this RAF turn. */
    double animation_frame_timestamp_ms = 0.0;
    /**
     * Every animation manager created with this engine
     * (`createAnimationManager({ engine })`). A manager owns animation time
     * for the groups attached to it, so a measured seek has to reach it;
     * registering scenes attach one seeker per manager, the way an asset
     * added to a scene contributes its own.
     */
#if !defined(BBLITE_HAS_ANIMATION) || BBLITE_HAS_ANIMATION
    std::vector<PropertyAnimationManager> animation_managers;
#endif
    std::vector<MeshRecord> meshes;
    // Every source event that changes draw-list membership: the pin's
    // setMeshVisible epoch (only when a flag actually changes), and a
    // culling-enabled thin-instance pool crossing zero active rows. Matrix or
    // count changes within one membership state touch no draw-list storage.
    std::uint64_t draw_list_epoch = 0;
    /** Whether original meshes and their clones have stable feature rows. */
    bool composition_feature_rows_initialized = false;
    std::vector<MaterialRecord> materials;
    struct StorageBufferRecord {
        std::vector<std::uint8_t> bytes;
        std::uint64_t version = 1;
        bool disposed = false;
        std::string label;
    };
    std::vector<StorageBufferRecord> storage_buffers;
    /** Creation-ordered handles retained for source values that escape scope. */
    std::vector<MaterialHandle> scene_material_slots;
    std::vector<LightRecord> lights;
    std::vector<TransformNodeRecord> transform_nodes;
    // Camera controls and render loops keep references to active records while
    // UI callbacks may construct the next mode's cameras. End insertion must
    // therefore preserve those references until the loop observes the scene
    // replacement and restarts.
    std::deque<CameraRecord> cameras;
    std::vector<ModelGeometry> geometries;
    std::vector<std::array<TextureData, 6>> reflection_cubes;
    std::vector<AssetRecord> assets;
    std::vector<HierarchyInstancePoolRecord> hierarchy_instance_pools;
    std::vector<AnimationGroupRecord> animation_groups;
    /** The VAT payloads `bakeVat` produced, addressed by `VatBake`. */
    std::vector<VatBakeRecord> vat_bakes;
    std::vector<SkeletonRecord> skeletons;
    /** The skeletons scene code built with `createSkeleton`. */
    std::vector<SceneSkeletonRecord> scene_skeletons;
    std::vector<BoneRecord> bones;
    std::vector<RenderTargetRecord> render_targets;
    std::vector<FrameTaskRecord> frame_tasks;
    RenderTargetHandle swapchain_target{};
    /**
     * Stable wrappers for registered JavaScript SceneContext identities.
     * Scene copies share their state, so retaining a wrapper here remains
     * valid after the generated local that registered it leaves scope.
     */
    SnapshotList<std::shared_ptr<Scene>> registered_scenes;
    /**
     * A scene renderer sets this when an application callback replaces its
     * root SceneContext. The PAL dispatcher then rebuilds the backend around
     * the newly registered root instead of letting the current frame retain
     * references into the disposed scene.
     */
    bool renderer_restart_requested = false;
    /** Diagnostic input continues across renderer restarts and scene changes. */
    std::size_t input_replay_next_frame = 0;
    unsigned int input_replay_mouse_buttons = 0u;
    double input_replay_pointer_x = 0.0;
    double input_replay_pointer_y = 0.0;
    std::vector<FrameGraphContext*> registered_frame_graph_contexts;
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    std::vector<SpriteAtlasRecord> sprite_atlases;
    std::vector<Sprite2DLayerRecord> sprite_layers;
#endif
#if !defined(BBLITE_HAS_SPRITE_ANIMATION) || BBLITE_HAS_SPRITE_ANIMATION
    std::vector<SpriteAnimationManagerRecord> sprite_animation_managers;
#endif
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    std::vector<BillboardSystemRecord> billboard_systems;
    std::vector<SpriteRendererRecord> sprite_renderers;
    std::vector<SpriteRenderTextureRecord> sprite_render_textures;
#endif
    std::vector<SplatMeshRecord> splat_meshes;
    /**
     * The clustered light fields this engine holds.
     *
     * Plain records like every other collection here. What is GENERATED is
     * the behaviour over them -- the sizing `addClusteredLightContainer`
     * bakes and the per-frame binning, both from `src/light/clustered.ts`.
     */
    std::vector<ClusteredLightContainer> clustered_light_containers;
    std::vector<EffectWrapperRecord> effect_wrappers;
    std::vector<EffectRendererRecord> effect_renderers;
#if !defined(BBLITE_HAS_SHADOWS) || BBLITE_HAS_SHADOWS
    std::vector<ShadowGeneratorRecord> shadow_generators;
#endif
#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
    std::vector<GpuPickerRecord> gpu_pickers;
#endif
    /**
     * The utility layers this engine holds. Pointer-stable because
     * `registerScene` publishes the address of the scene inside one, and
     * every gizmo follow callback captures it.
     */
#if !defined(BBLITE_HAS_GIZMOS) || BBLITE_HAS_GIZMOS
    std::vector<std::unique_ptr<UtilityLayerRecord>> utility_layers;
    std::vector<CameraGizmoRecord> camera_gizmos;
    std::vector<LightGizmoRecord> light_gizmos;
    std::vector<EditGizmoRecord> edit_gizmos;
    std::weak_ptr<PointerDragDispatcher> canvas_pointer_dispatcher;
    std::vector<BoundingBoxGizmoRecord> bounding_box_gizmos;
#endif
    /**
     * The live renderer's pick pass.
     *
     * A pick renders the scene into a one-pixel target and reads it back,
     * which only the backend that owns the mesh buffers and the cloud's
     * textures can do. The renderer installs this during setup and the
     * generated `gpu_pick` calls it; a build whose loop has not started
     * yet -- or whose backend does not implement picking -- leaves it
     * empty and the pick reports a miss rather than shading something
     * plausible.
     */
    /**
     * The pin's `pickAsync` `filter` option rides the request: the shared
     * candidate collector asks it per mesh and both backends skip their
     * pick sources under it (`pickAsyncImpl`). Null is an unfiltered pick.
     */
#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
    using PickFilter = std::function<bool(MeshHandle)>;
    std::function<PickingInfo(GpuPickerHandle, double, double, const PickFilter*)> pick_hook;
#endif
    // `engine._renderingContexts`, for the sprite half: registration
    // order is draw order across renderers.
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    std::vector<SpriteRendererHandle> registered_sprite_renderers;
#endif
    std::vector<std::shared_ptr<TextRendererState>> registered_text_renderers;
    // The same list for the effect half; an effect renderer is its own
    // rendering context on the engine exactly as a sprite renderer is.
    std::vector<EffectRendererHandle> registered_effect_renderers;
    std::uint64_t next_pixels_texture_identity = 1;
    /**
     * The optional Sprite2D Y-sort extension's hook, empty until a scene
     * reaches `enableSprite2DYSort`. Upstream registers the same record
     * lazily from inside the enabler, so importing (or here, generating)
     * the extension without using it installs nothing.
     */
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    Sprite2DYSortHook sprite_y_sort_hook;
#endif
    std::uint64_t next_file_texture_identity = 1;
    std::unordered_map<std::string, FileTexture> file_texture_cache;
};

inline bool has_sprite_renderers(const Engine& engine) {
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    return !engine.registered_sprite_renderers.empty();
#else
    static_cast<void>(engine);
    return false;
#endif
}

struct Engine::DeviceRecoveryState {
    std::vector<std::shared_ptr<DeviceRecoveryRegistration>> registrations;
    std::vector<std::shared_ptr<DeviceRecoveryRegistration>> in_flight;
    std::unordered_map<std::uint64_t, std::vector<std::function<void(const std::string&)>>> error_listeners;
    std::unordered_map<std::string, std::function<void()>> globals;
    std::unordered_map<const SceneState*, GpuTextureIdentity> environments;
    std::unordered_map<const SceneState*, std::size_t> renderable_counts;
    std::vector<GpuTextureIdentity> shadows;
    GpuTextureIdentity fallback;
    /** The last ordinal `publish_gpu_texture_identity` handed out. */
    std::uint64_t published_textures = 0;
    bool requested = false;
    bool recovering = false;
    bool resources_ready = false;
    bool disposed = false;
};

/**
 * The identity a backend publishes for a texture the device-recovery
 * observers watch: the current device generation and a fresh ordinal. A
 * backend calls it once per texture it publishes and again only when the
 * texture behind an identity changed, so two identities compare equal
 * exactly when the same texture stood behind both.
 */
inline GpuTextureIdentity publish_gpu_texture_identity(Engine& engine) {
    return {engine.device_generation, ++engine.device_recovery->published_textures};
}

inline GpuDeviceIdentity gpu_device_identity(Engine& engine) { return {&engine, engine.device_generation}; }
EnvironmentIdentity environment_identity(const Scene& scene);
GpuTextureIdentity environment_texture_identity(const EnvironmentIdentity& environment);
GpuTextureIdentity fallback_texture_identity(const Engine& engine);
GpuTextureIdentity shadow_texture_identity(const Engine& engine, ShadowGeneratorHandle shadow);
std::size_t scene_renderable_count(const Scene& scene);
void add_gpu_error_listener(GpuDeviceIdentity device, std::function<void(const std::string&)> listener);
void report_gpu_error(Engine& engine, const std::string& error);
void set_canvas_dataset(Engine& engine, std::string key, std::string value);
std::string canvas_dataset(const Engine& engine, const std::string& key);
void set_global_callback(Engine& engine, std::string key, std::function<void()> callback);
std::shared_ptr<DeviceRecoveryRegistration> enable_device_lost_scene_recovery(Engine& engine);
void disable_device_recovery(const std::shared_ptr<DeviceRecoveryRegistration>& registration);
void force_device_loss(Engine& engine);
void begin_device_recovery(Engine& engine);
void complete_device_recovery(Engine& engine);
void fail_device_recovery(Engine& engine, const std::string& error);
void dispose_engine(Engine& engine);

inline std::vector<MeshHandle> asset_mesh_walk(
    const Engine& engine, AssetHandle asset, std::size_t walk_index) {
    const auto& record = engine.assets.at(asset.value);
    if (!record.source_mesh_walks) {
        throw std::runtime_error("Source mesh walk metadata is missing.");
    }
    const auto& indices = record.source_mesh_walks->collectors.at(walk_index);
    if (indices.size() != record.meshes.size()) {
        throw std::runtime_error("Source mesh walk does not cover the loaded mesh set.");
    }
    std::vector<MeshHandle> result;
    result.reserve(indices.size());
    for (const auto index : indices) result.push_back(record.meshes.at(index));
    return result;
}

inline void AnimationFrameRequest::operator()(double timestamp) const {
    if (!state->pending) return;
    state->pending = false;
    engine->animation_frame_requests.erase(state->id);
    state->callback(timestamp);
}

/** Select at registration time: a stored callback can run in either phase. */
inline std::size_t request_animation_frame(Engine& engine, js::Callback<void(double)> callback) {
    const auto state = js::make_gc_shared<AnimationFrameRequestState>(
        AnimationFrameRequestState{engine.next_animation_frame_request++, std::move(callback)});
    engine.animation_frame_requests.emplace(state->id, state);
    auto& callbacks = engine.animation_frame_after_render
        ? engine.post_render_animation_frame_once_callbacks
        : engine.animation_frame_once_callbacks;
    callbacks.push_back({&engine, state});
    return state->id;
}

inline void cancel_animation_frame(Engine& engine, std::size_t id) {
    const auto found = engine.animation_frame_requests.find(id);
    if (found == engine.animation_frame_requests.end()) return;
    found->second->pending = false;
    engine.animation_frame_requests.erase(found);
    const auto matches = [id](const AnimationFrameRequest& request) { return request.state->id == id; };
    std::erase_if(engine.animation_frame_once_callbacks, matches);
    std::erase_if(engine.post_render_animation_frame_once_callbacks, matches);
}

#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
inline void PickingInfo::bind_engine(Engine& engine) {
    state->engine = &engine;
    state->engine_lifetime = engine.lifetime.token();
}

#endif
/** Copy a typed-array view into an engine-owned GPU storage record. */
template <typename Data>
[[nodiscard]] inline StorageBufferHandle create_storage_buffer(
    Engine& engine,
    const Data& data,
    std::string label) {
    using Element = typename Data::value_type;
    Engine::StorageBufferRecord record;
    const std::size_t byte_length = data.size() * sizeof(Element);
    record.bytes.resize(byte_length);
    if (byte_length != 0) {
        std::memcpy(record.bytes.data(), data.data(), byte_length);
    }
    record.label = std::move(label);
    const StorageBufferHandle handle{
        static_cast<std::uint32_t>(engine.storage_buffers.size())};
    engine.storage_buffers.push_back(std::move(record));
    return handle;
}

/** Apply a typed-array byte range update with WebGPU-style bounds checks. */
template <typename Data>
inline void update_storage_buffer(
    Engine& engine,
    StorageBufferHandle handle,
    const Data& data,
    double byte_offset) {
    if (
        handle.value >= engine.storage_buffers.size() ||
        !std::isfinite(byte_offset) ||
        byte_offset < 0.0 ||
        std::floor(byte_offset) != byte_offset) {
        throw std::runtime_error("Invalid storage-buffer update.");
    }
    auto& record = engine.storage_buffers[handle.value];
    if (record.disposed) {
        throw std::runtime_error("Cannot update a disposed storage buffer.");
    }
    using Element = typename Data::value_type;
    const std::size_t offset = static_cast<std::size_t>(byte_offset);
    const std::size_t byte_length = data.size() * sizeof(Element);
    if (offset > record.bytes.size() ||
        byte_length > record.bytes.size() - offset) {
        throw std::runtime_error("Storage-buffer update exceeds its allocation.");
    }
    if (byte_length != 0) {
        std::memcpy(record.bytes.data() + offset, data.data(), byte_length);
    }
    ++record.version;
}

inline void dispose_storage_buffer(
    Engine& engine,
    StorageBufferHandle handle) {
    if (handle.value >= engine.storage_buffers.size()) return;
    auto& record = engine.storage_buffers[handle.value];
    if (record.disposed) return;
    record.disposed = true;
    record.bytes.clear();
    ++record.version;
}

/** Subscribe to the bytes produced by the CSM receiver's own packer. */
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
template <typename Callback>
[[nodiscard]] inline auto on_csm_receiver_update(
    Engine& engine,
    ShadowGeneratorHandle generator,
    Callback callback) {
    if (generator.value >= engine.shadow_generators.size()) {
        throw std::runtime_error("Invalid CSM shadow generator.");
    }
    using Registry = PlatformEventListeners<void(const js::F32Array&)>;
    std::shared_ptr<Registry>& registry =
        engine.shadow_generators[generator.value].csm_receiver_callbacks;
    if (!registry) registry = std::make_shared<Registry>();
    const std::size_t identity = js::next_callback_identity();
    registry->add(identity, std::move(callback));
    std::weak_ptr<Registry> weak_registry = registry;
    return [weak_registry, identity]() {
        if (const std::shared_ptr<Registry> retained = weak_registry.lock()) {
            retained->remove(identity);
        }
    };
}
#endif

/** SDL-backed browser Gamepad surface (implemented by pal_sdl.cpp). */
js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine& engine);
double gamepad_index(Engine& engine, GamepadHandle gamepad);
js::Array<double> gamepad_axes(Engine& engine, GamepadHandle gamepad);
js::Array<GamepadButtonHandle> gamepad_buttons(
    Engine& engine,
    GamepadHandle gamepad);
bool gamepad_button_pressed(
    Engine& engine,
    GamepadButtonHandle button);

/** Public PBR Texture2D slots backed by one material record. */
enum class MaterialTextureSlot : std::uint8_t {
    base_color,
    normal,
    orm,
    emissive,
    occlusion,
    diffuse,
};

enum class MaterialColorSlot { base_color_factor, diffuse_color };

inline void project_material_source_colors(MaterialRecord& material) {
    if (material.source_base_color_factor) {
        const auto& source = *material.source_base_color_factor;
        if (source.size() != 4) throw std::runtime_error("PBR baseColorFactor requires four numeric channels.");
        material.base_color_factor = Color4{static_cast<float>(source[0]), static_cast<float>(source[1]),
            static_cast<float>(source[2]), static_cast<float>(source[3])};
    }
    if (material.source_diffuse_color) {
        const auto& source = *material.source_diffuse_color;
        if (source.size() != 3) throw std::runtime_error("Material diffuseColor requires three numeric channels.");
        material.diffuse_color = Color3{static_cast<float>(source[0]), static_cast<float>(source[1]), static_cast<float>(source[2])};
    }
}

template <typename Array = js::Array<double>>
[[nodiscard]] js::Nullable<Array> material_color(
    const Engine& engine, MaterialHandle material, MaterialColorSlot slot) {
    const auto& record = engine.materials.at(material.value);
    const auto& values = slot == MaterialColorSlot::base_color_factor
        ? record.source_base_color_factor : record.source_diffuse_color;
    return values ? js::Nullable<Array>{Array(values)} : js::Nullable<Array>{};
}

[[nodiscard]] inline bool material_color_has_bound_group(const Engine& engine, MaterialHandle material);

template <typename Array>
inline void set_material_diffuse_color(
    Engine& engine, MaterialHandle material, const Array& values) {
    if (values.size() != 3) {
        throw std::runtime_error("Material diffuseColor requires three numeric channels.");
    }
    auto& record = engine.materials.at(material.value);
    if (record.source_colors_registered || material_color_has_bound_group(engine, material)) {
        throw std::runtime_error("Replacing a registered material color requires per-group UBO snapshots.");
    }
    record.source_diffuse_color = values.retained_storage();
    record.diffuse_color = Color3{static_cast<float>(values[0]),
        static_cast<float>(values[1]), static_cast<float>(values[2])};
}

[[nodiscard]] inline bool material_texture_present(
    const Engine& engine,
    MaterialHandle material,
    MaterialTextureSlot slot) {
    const MaterialRecord& record = engine.materials.at(material.value);
    if (slot == MaterialTextureSlot::base_color) {
        return !record.standard_material && record.has_public_base_color_texture;
    }
    if (slot == MaterialTextureSlot::diffuse) {
        return record.standard_material &&
            (record.base_color_texture.has_image() || record.has_diffuse_render_texture);
    }
    throw std::runtime_error("Material source presence is not represented for this texture slot.");
}

[[nodiscard]] inline StoredTexture material_source_texture(
    const Engine& engine,
    MaterialHandle material,
    MaterialTextureSlot slot) {
    if (!material_texture_present(engine, material, slot)) return FileTexture{};
    const MaterialRecord& record = engine.materials.at(material.value);
    if (!record.source_albedo_texture) {
        throw std::runtime_error("This material texture producer has no retained source identity.");
    }
    return *record.source_albedo_texture;
}

/**
 * Adapt a material-owned texture slot to the source-level Texture2D value.
 *
 * Native material records retain decoded texture data rather than a separate
 * wrapper object. The synthetic high-bit identity keeps repeated reads of one
 * slot strictly equal while remaining disjoint from texture factory objects.
 */
[[nodiscard]] inline FileTexture material_texture(
    const Engine& engine,
    MaterialHandle material,
    MaterialTextureSlot slot) {
    const MaterialRecord& record = engine.materials.at(material.value);
    FileTexture texture;
    switch (slot) {
        case MaterialTextureSlot::base_color:
        case MaterialTextureSlot::diffuse:
            if (slot == MaterialTextureSlot::diffuse && record.has_diffuse_render_texture) {
                throw std::runtime_error("Reading a Standard diffuse render attachment as a retained file texture is not supported.");
            }
            texture.data = record.base_color_texture;
            texture.srgb = slot == MaterialTextureSlot::diffuse
                ? record.diffuse_texture_srgb : record.base_color_srgb;
            if (slot == MaterialTextureSlot::base_color &&
                record.has_public_base_color_texture && !texture.data.has_image()) {
                texture.data.bytes.assign(record.base_color_fallback.begin(), record.base_color_fallback.end());
                texture.data.rgba_width = 1;
                texture.data.rgba_height = 1;
            }
            texture.width = texture.data.rgba_width;
            texture.height = texture.data.rgba_height;
            break;
        case MaterialTextureSlot::normal:
            texture.data = record.normal_texture;
            break;
        case MaterialTextureSlot::orm:
            texture.data = record.metallic_roughness_texture;
            break;
        case MaterialTextureSlot::emissive:
            texture.data = record.emissive_texture;
            texture.srgb = true;
            break;
        case MaterialTextureSlot::occlusion:
            texture.data = record.occlusion_texture;
            break;
    }
    constexpr std::uint64_t material_texture_identity =
        std::uint64_t{1} << 63u;
    texture.identity = material_texture_identity |
        (static_cast<std::uint64_t>(material.value) << 8u) |
        (static_cast<std::uint64_t>(slot) + 1u);
    return texture;
}

/**
 * Finds the topmost visible sprite containing a point in layer-local pixels.
 * Layers and sprites both draw in array order, so picking walks each in the
 * opposite direction. The inverse rotation is pivot-aware through the same
 * normalized coordinates the sprite vertex path uses.
 *
 * `pickSprite2D` asks the optional Y-sort hook for the layer's current draw
 * order first (`pick-sprite-2d.ts`), so a Y-sorted layer is walked in reverse
 * DRAW order and answers with the logical slot that order named. The hook is
 * empty on every layer that never enabled the extension, which is the pin's
 * own `?.drawOrder(layer)` and needs no second detector.
 */
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
[[nodiscard]] inline std::optional<Sprite2DPickResult> pick_sprite_2d(
    const Engine& engine,
    const std::vector<Sprite2DLayerHandle>& layers,
    double x_px,
    double y_px) {
    for (auto layer_it = layers.rbegin(); layer_it != layers.rend(); ++layer_it) {
        if (layer_it->value >= engine.sprite_layers.size()) {
            continue;
        }
        const auto& layer = engine.sprite_layers[layer_it->value];
        if (!layer.visible) {
            continue;
        }
        // The hook sorts the CPU permutation if a same-frame mutation left
        // it stale; nothing here packs or touches the GPU.
        const std::uint32_t* draw_order =
            engine.sprite_y_sort_hook.draw_order
                ? engine.sprite_y_sort_hook.draw_order(layer)
                : nullptr;
        const auto stride = static_cast<std::size_t>(
            layer.instance_floats_per_sprite);
        for (std::uint32_t sprite = layer.count; sprite > 0; --sprite) {
            const auto index =
                draw_order ? draw_order[sprite - 1u] : sprite - 1u;
            const auto base = static_cast<std::size_t>(index) * stride;
            if (base + 8u >= layer.instance_data.size()) {
                continue;
            }
            const double width = layer.instance_data[base + 2u];
            const double height = layer.instance_data[base + 3u];
            // `pickSprite2D`'s own `sizeX <= 0 || sizeY <= 0`: a sprite
            // hidden by a non-positive size is skipped, not just an empty
            // one.
            if (width <= 0.0 || height <= 0.0) {
                continue;
            }
            const double dx = x_px - layer.instance_data[base];
            const double dy = y_px - layer.instance_data[base + 1u];
            const double rotation = layer.instance_data[base + 8u];
            const double cosine = std::cos(rotation);
            const double sine = std::sin(rotation);
            const double local_x = cosine * dx + sine * dy;
            const double local_y = -sine * dx + cosine * dy;
            const double u = local_x / width + layer.pivot.x;
            const double v = local_y / height + layer.pivot.y;
            if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
                return Sprite2DPickResult{*layer_it, index, u, v};
            }
        }
    }
    return std::nullopt;
}

#endif

inline MaterialHandle remember_scene_material(
    Engine& engine,
    std::size_t slot,
    MaterialHandle material) {
    if (engine.scene_material_slots.size() <= slot) {
        engine.scene_material_slots.resize(slot + 1u);
    }
    engine.scene_material_slots[slot] = material;
    return material;
}

/** Stable cache keys for distinct pinned fog/environment objects, across scenes. */
inline std::uint64_t next_scene_uniform_object_identity() {
    static std::atomic<std::uint64_t> next{1};
    return next.fetch_add(1, std::memory_order_relaxed);
}

struct EnvironmentState {
    bool has_irradiance = false;
    float exposure = 1.0f;
    float contrast = 1.0f;
    // Pinned: the DDS environment loader uses LOD generation scale 0.8
    // where the HDR loader uses 1.0 (load-dds-env.ts; docs/fidelity.md).
    float lod_generation_scale = 0.8f;
    float rotation_y = 0.0f;
    bool tone_mapping_enabled = false;
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t specular_width = 0;
    std::uint32_t specular_mip_count = 0;
    std::vector<TextureData> specular_faces;
    bool specular_rgba16f = false;
    TextureData brdf_lut;
    std::uint32_t brdf_lut_width = 0;
    bool brdf_lut_rgba16f = false;
    TextureData ground_texture;
    TextureData skybox_texture;
    std::array<TextureData, 6> image_skybox_faces{};
    float image_skybox_size = 0.0f;
    bool has_image_skybox = false;
    bool has_ground = false;
    bool has_skybox = false;
    // src/loader-env/load-env.ts: the deferred builder pushes
    // buildSolidSkyboxRenderable whenever the scene names no DDS or .env
    // skybox and does not skip one. It shades from the clear colour and
    // shares nothing with the cubemap arms above.
    bool has_solid_skybox = false;
    bool background_enabled_by_default = false;
    bool skybox_uses_environment = false;
    // `enableNoise`, which both background builders take and default to
    // true: the pin composes WGSL_DITHER or WGSL_NO_DITHER in front of the
    // same ground and DDS-skybox fragment bodies and keys its pipeline
    // cache on the flag, so it selects between the two generated variants
    // here. `loadEnvironment` never passes it; only
    // `addDdsEnvironmentBackground` does.
    bool enable_noise = true;
    float ground_size = 15.0f;
    float skybox_size = 20.0f;
    std::uint32_t skybox_width = 0;
    std::uint32_t skybox_mip_count = 0;
    std::uint32_t skybox_data_offset = 0;
    Vec3 ground_position{};
    Vec3 skybox_position{};
    // The pin's own environmentPrimaryColor default literals
    // (load-env.ts: 0.08697355964132344, ..., 0.2122208331110881), stored
    // at the float32 precision the shader uniforms carry.
    Color3 primary_color{0.08697356f, 0.08697356f, 0.21222083f};
};

/**
 * One additional presentation surface created from an engine and a retained
 * canvas. Native owns one operating-system swapchain, but preserving this
 * identity lets the renderer give every registered surface scene its own
 * viewport instead of flattening all cameras onto the primary surface.
 * Copies share the disposal flag, matching the JavaScript object's identity.
 */
struct Surface {
    Engine* engine = nullptr;
    UiElementHandle canvas{};
    std::shared_ptr<bool> disposed = std::make_shared<bool>(false);
};

enum class SceneDeferredFailure { synchronous_throw, promise_rejection };

/** Async wrappers reject after the map has invoked the rest of its batch. */
struct SceneDeferredBuilder {
    js::Callback<void()> callback;
    SceneDeferredFailure failure_mode = SceneDeferredFailure::synchronous_throw;
    template <typename F>
        requires (!std::is_same_v<std::remove_cvref_t<F>, SceneDeferredBuilder>)
    SceneDeferredBuilder(F&& body,
        SceneDeferredFailure mode = SceneDeferredFailure::synchronous_throw)
        : callback(std::forward<F>(body)), failure_mode(mode) {}
    void operator()() const { callback(); }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(callback); }
};

/** A source builder function owns one mesh-list identity per scene. */
using SourceMaterialDrawGuard = bool (*)(MaterialHandle, MaterialHandle, bool);
struct SourceMaterialDraw {
    MeshHandle mesh;
    MaterialHandle material;
    SourceMaterialDrawGuard guard = nullptr;
};
using SourceMaterialOutput = std::shared_ptr<SourceMaterialDraw>;
using SourceMaterialOutputs = std::vector<SourceMaterialOutput>;

struct SourceMaterialGroupState {
    SourceMaterialOutputs outputs;
    std::vector<MeshHandle> meshes;
    bool rebuild_ready = false;
    bool gamma_invalidates = false;
};
using SourceMaterialGroups = js::Map<std::uint64_t, std::shared_ptr<SourceMaterialGroupState>>;

/** The mutable state shared by every native copy of one SceneContext. */
using PbrTransmissionTransaction = std::array<js::Callback<void()>, 2>;

struct SceneState {
    bool source_material_publication = false;
    SourceMaterialOutputs material_outputs;
    bool material_runtime_installed = false;
    std::exception_ptr material_runtime_error;
    Engine* engine = nullptr;
    bool default_render_task = true;
    bool default_render_task_created = false;
    std::uint32_t default_render_task_samples = 4;
    /** Canvas identity when this scene belongs to an auxiliary surface. */
    std::optional<UiElementHandle> surface_canvas;
    /** `disposeScene` is idempotent in the pinned scene lifecycle. */
    bool disposed = false;
    /**
     * `enableMirroredMeshes` opted this scene into runtime winding
     * tracking. The pipeline-side half is installed process-wide upstream
     * and is compiled in here by the same feature, so what this flag
     * carries is only the per-scene watcher.
     */
    bool mirrored_meshes = false;
    Color4 clear_color{};
    CameraHandle camera{};
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    std::vector<TaskHandle> tasks;
    /** Shadow generators retired only after a replacement rebuild succeeds. */
#if !defined(BBLITE_HAS_SHADOWS) || BBLITE_HAS_SHADOWS
    std::vector<ShadowGeneratorHandle> pending_shadow_retirements;
#endif
    std::vector<AnimationGroupHandle> animation_groups;
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    std::vector<BillboardSystemHandle> billboard_systems;
#endif
    // sprite-scene.ts: depth-enabled 2D layers are scene renderables and
    // therefore share this scene's colour, multisample and depth targets.
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    std::vector<Sprite2DLayerHandle> depth_hosted_sprite_layers;
#endif
    // `loadSplat` registers the renderable on the scene it is handed, the
    // way `attachGaussianSplattingMesh` pushes into `_renderables`.
    std::vector<SplatMeshHandle> splat_meshes;
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
    /** Retained text is populated only by the reached text attachment adapter. */
    std::vector<std::shared_ptr<TextRenderableState>> text_renderables;
#endif
    /**
     * The clustered light field this scene was given, if it was given one.
     *
     * `addClusteredLightContainer` stores its container on the scene and
     * stamps every material present, which is what makes the composed
     * fragment read it. Only the handle is here; the container is a
     * generated record.
     */
    ClusteredLightContainerHandle clustered_lights{};
    SnapshotList<js::Callback<void(float)>> before_render;
    std::vector<js::Callback<void()>> disposables;
    /**
     * `scene._flowGraphs` and the coordinator/pointer-bridge state the
     * pin hangs beside it: the attached graphs, whether the per-frame
     * drive is registered, whether `enableFlowGraphPointerPicking` armed
     * the bridge, and the bridge's own teardown while it is installed.
     */
    std::vector<std::shared_ptr<FlowGraphRuntime>> flow_graphs;
    js::Callback<void(float)> flow_graph_tick;
    js::Callback<void()> flow_graph_dispose;
    bool flow_graph_pointer_refresh = false;
    std::function<void()> flow_graph_pointer_cleanup;
    std::vector<js::Callback<void(float)>> animation_seekers;
    /**
     * Whether this scene already contributed the seeker that reaches the
     * engine's animation managers. Registration is idempotent upstream,
     * so the contribution is too.
     */
#if !defined(BBLITE_HAS_ANIMATION) || BBLITE_HAS_ANIMATION
    bool seeks_animation_managers = false;
#endif
    /** The same, for the baked meshes this scene's registration reaches. */
    bool seeks_vat = false;
    std::vector<SceneDeferredBuilder> deferred_builders;
    std::vector<std::shared_ptr<NodeMaterialGroupState>> node_material_groups;
    std::shared_ptr<SourceMaterialGroupState> pbr_material_group;
    std::shared_ptr<SourceMaterialGroups> source_material_groups;
    std::vector<MeshHandle> pbr_material_swap_queue;
    bool material_groups_built = false;
    bool material_group_rebuild_pending = false;
    void (*process_material_groups)(Scene&) = nullptr;
    void (*enqueue_material_group)(Scene&, MeshHandle) = nullptr;
    void (*complete_material_group)(Scene&, MaterialHandle) = nullptr;
    EnvironmentState environment;
    /** `createSceneContext`: fog is null and _envTextures is absent. */
    std::uint64_t fog_identity = 0;
    std::uint64_t environment_identity = 0;
    double fixed_delta_ms = 0.0;
    /** Mesh, light, or shadow changes that require renderer state rebuild. */
    std::uint64_t render_topology_version = 0;
    /** A light/shadow topology mutation awaiting registration or rebuild. */
    bool topology_rebuild_pending = false;
    std::uint32_t material_family_mask = 0;
    bool transmission_enabled = false;
    js::Callback<bool(PbrTransmissionTransaction)> pbr_transmission_transaction;
    float fog_mode = 0.0f;
    float fog_density = 0.0f;
    float fog_start = 0.0f;
    float fog_end = 0.0f;
    Color3 fog_color{};
    /**
     * `scene.clipPlane` as its own scene-UBO lane.
     *
     * The pin holds `ClipPlane | null` and registers `writeClipPlaneUbo`
     * only once `setClipPlane` runs, so a scene that never clips leaves
     * float offsets 88-91 at the zero `_packSceneUniforms` left there.
     * The zero vector is that same state: `dot(worldPosition, vec4(0))`
     * is zero, and the pinned `ClipPlanesBlock` discards on a strictly
     * positive distance — so the absent case needs no second flag.
     */
    Vec4 clip_plane{};
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(before_render);
        visitor(disposables);
        visitor(animation_seekers);
        visitor(deferred_builders);
    }
};

/**
 * A JavaScript SceneContext is an object identity, not a value aggregate.
 *
 * Generated code deliberately uses ordinary C++ value syntax for scene
 * locals, record fields, callback captures, and array elements. The public
 * references preserve that syntax while every copy points at the same state.
 * Assignment reconstructs the lightweight wrapper so it rebinds those
 * references instead of assigning through them into the previously named
 * scene.
 */
struct Scene {
    std::shared_ptr<SceneState> state;
    Engine*& engine;
    std::optional<UiElementHandle>& surface_canvas;
    bool& disposed;
    bool& mirrored_meshes;
    Color4& clear_color;
    CameraHandle& camera;
    std::vector<MeshHandle>& meshes;
    std::vector<LightHandle>& lights;
    std::vector<TaskHandle>& tasks;
#if !defined(BBLITE_HAS_SHADOWS) || BBLITE_HAS_SHADOWS
    std::vector<ShadowGeneratorHandle>& pending_shadow_retirements;
#endif
    std::vector<AnimationGroupHandle>& animation_groups;
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
    std::vector<BillboardSystemHandle>& billboard_systems;
    std::vector<Sprite2DLayerHandle>& depth_hosted_sprite_layers;
#endif
    std::vector<SplatMeshHandle>& splat_meshes;
    ClusteredLightContainerHandle& clustered_lights;
    SnapshotList<js::Callback<void(float)>>& before_render;
    std::vector<js::Callback<void()>>& disposables;
    std::vector<js::Callback<void(float)>>& animation_seekers;
#if !defined(BBLITE_HAS_ANIMATION) || BBLITE_HAS_ANIMATION
    bool& seeks_animation_managers;
#endif
    bool& seeks_vat;
    std::vector<SceneDeferredBuilder>& deferred_builders;
    EnvironmentState& environment;
    double& fixed_delta_ms;
    std::uint64_t& render_topology_version;
    bool& topology_rebuild_pending;
    std::uint32_t& material_family_mask;
    bool& transmission_enabled;
    float& fog_mode;
    float& fog_density;
    float& fog_start;
    float& fog_end;
    Color3& fog_color;
    Vec4& clip_plane;

    Scene()
        : Scene(js::make_gc_shared<SceneState>()) {}

    void gc_trace(const js::TraceVisitor& visitor) const { visitor(state); }

    // Copying binds references into the shared state and copies its owner,
    // neither of which can throw; the assignment operators below rely on
    // that, since they destroy and re-place this object.
    Scene(const Scene& other) noexcept
        : Scene(other.state) {}

    Scene(Scene&& other) noexcept
        : Scene(std::move(other.state)) {}

    Scene& operator=(const Scene& other) {
        if (this != &other) {
            this->~Scene();
            new (this) Scene(other);
        }
        return *this;
    }

    Scene& operator=(Scene&& other) noexcept {
        if (this != &other) {
            this->~Scene();
            new (this) Scene(std::move(other));
        }
        return *this;
    }

    [[nodiscard]] bool shares_identity(const Scene& other) const noexcept {
        return state == other.state;
    }

    /** Rebuild a lightweight Scene wrapper after locking shared state. */
    [[nodiscard]] static Scene from_state(
        std::shared_ptr<SceneState> shared) {
        return Scene(std::move(shared));
    }

private:
    explicit Scene(std::shared_ptr<SceneState> shared)
        : state(std::move(shared)),
          engine(state->engine),
          surface_canvas(state->surface_canvas),
          disposed(state->disposed),
          mirrored_meshes(state->mirrored_meshes),
          clear_color(state->clear_color),
          camera(state->camera),
          meshes(state->meshes),
          lights(state->lights),
          tasks(state->tasks),
#if !defined(BBLITE_HAS_SHADOWS) || BBLITE_HAS_SHADOWS
          pending_shadow_retirements(state->pending_shadow_retirements),
#endif
          animation_groups(state->animation_groups),
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
          billboard_systems(state->billboard_systems),
          depth_hosted_sprite_layers(state->depth_hosted_sprite_layers),
#endif
          splat_meshes(state->splat_meshes),
          clustered_lights(state->clustered_lights),
          before_render(state->before_render),
          disposables(state->disposables),
          animation_seekers(state->animation_seekers),
#if !defined(BBLITE_HAS_ANIMATION) || BBLITE_HAS_ANIMATION
          seeks_animation_managers(state->seeks_animation_managers),
#endif
          seeks_vat(state->seeks_vat),
          deferred_builders(state->deferred_builders),
          environment(state->environment),
          fixed_delta_ms(state->fixed_delta_ms),
          render_topology_version(state->render_topology_version),
          topology_rebuild_pending(state->topology_rebuild_pending),
          material_family_mask(state->material_family_mask),
          transmission_enabled(state->transmission_enabled),
          fog_mode(state->fog_mode),
          fog_density(state->fog_density),
          fog_start(state->fog_start),
          fog_end(state->fog_end),
          fog_color(state->fog_color),
          clip_plane(state->clip_plane) {}
};
// The destroy-then-place assignment operators above are only sound while a
// copy cannot throw between the destruction and the placement.
static_assert(std::is_nothrow_copy_constructible_v<Scene>);
static_assert(std::is_nothrow_move_constructible_v<Scene>);

[[nodiscard]] inline bool material_color_has_bound_group(const Engine& engine, MaterialHandle material) {
    return std::any_of(engine.registered_scenes.begin(), engine.registered_scenes.end(),
        [&](const std::shared_ptr<Scene>& scene) {
            return scene && std::any_of(scene->meshes.begin(), scene->meshes.end(), [&](MeshHandle mesh) {
                return mesh.value < engine.meshes.size() && engine.meshes[mesh.value].material.value == material.value;
            });
        });
}

inline Scene configure_scene_render_defaults(Scene scene, bool enabled, std::uint32_t samples) {
    scene.state->default_render_task = enabled;
    scene.state->default_render_task_samples = samples;
    return scene;
}

/**
 * `UtilityLayer` (src/gizmo/utility-layer.ts): a second SceneContext over
 * the same engine, sharing the main scene's camera by reference and
 * carrying its own light so gizmo materials are lit independently of the
 * scene beneath them. Held by pointer-stable storage because the scene's
 * address is what `registerScene` publishes.
 */
#if !defined(BBLITE_HAS_GIZMOS) || BBLITE_HAS_GIZMOS
#include <bblite/runtime/gizmo-scene.hpp>
#endif

struct FrameGraphContext {
    Engine* engine = nullptr;
    std::vector<TaskHandle> tasks;
    std::vector<js::Callback<void(float)>> updates;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(updates); }
};

// No member defaults: generation fills every field from the pin's own
// factory defaults, so a second copy here could only drift. (The same
// holds for SphereOptions and TorusOptions below.)
struct GroundOptions {
    double width;
    double height;
    std::uint32_t subdivisions;
    Vec2 uv_scale;
};

struct BoxOptions {
    float width = 1.0f;
    float height = 1.0f;
    float depth = 1.0f;
};

struct PlaneOptions {
    float width = 1.0f;
    float height = 1.0f;
};

// The pin halves these as JavaScript numbers before its vertex chain rounds,
// so they are doubles here for the same reason `CameraRecord`'s scalars are.
struct SphereOptions {
    std::uint32_t segments;
    double diameter_x;
    double diameter_y;
    double diameter_z;
};

struct MeshData {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<std::uint32_t> indices;
    std::uint32_t vertex_count = 0;
    std::uint32_t index_count = 0;
};

/**
 * One element of a list, grown to reach it.
 *
 * JavaScript extends an array when you assign past its end, and the pinned
 * ribbon relies on that: it fills `us[p]` for each path without sizing `us`
 * first. A C++ `operator[]` there is out of bounds, so an assignment
 * through this one grows instead -- which is the same array the pin ends
 * up with.
 */
template <typename T>
T& at_grow(std::vector<T>& values, std::size_t index) {
    if (values.size() <= index) {
        values.resize(index + 1);
    }
    return values[index];
}

/**
 * A scene's own row of `{x, y, z}` as the path a builder takes.
 *
 * The data model materializes an annotated `Vec3[]` a scene grew in a loop
 * as its own record type, and the pin's builder wants the record it
 * declares. Templated on the row rather than named per scene, because what
 * makes the two the same is that both spell the pin's three components.
 */
template <typename Points>
std::vector<Vec3d> vec3_path(const Points& points) {
    std::vector<Vec3d> path;
    path.reserve(points.size());
    for (const auto& point : points) {
        if constexpr (requires { point.x; point.y; point.z; }) {
            path.push_back(Vec3d{point.x, point.y, point.z});
        } else {
            path.push_back(Vec3d{point->x, point->y, point->z});
        }
    }
    return path;
}

/** The same, one level up: a scene's rows as a ribbon's path array. */
template <typename Rows>
std::vector<std::vector<Vec3d>> vec3_paths(const Rows& rows) {
    std::vector<std::vector<Vec3d>> paths;
    paths.reserve(rows.size());
    for (const auto& row : rows) {
        paths.push_back(vec3_path(row));
    }
    return paths;
}

/**
 * `RibbonOptions`, as the reached slice resolves it.
 *
 * The path array is the pin's own `Vec3[][]`, carried whole: a ribbon is
 * defined by its paths and there is nothing to resolve about them.
 */
struct RibbonOptions {
    std::vector<std::vector<Vec3d>> path_array;
    bool close_array;
    bool close_path;
};

/**
 * `PolyhedronOptions`, as the reached slice resolves it.
 *
 * The pin's `POLYHEDRA` table is data and the `type` a scene names is a
 * compile-time value, so generation picks the row and this carries that
 * row's own vertex and face lists. One polyhedron therefore costs one
 * table, not fifteen.
 */
struct PolyhedronOptions {
    double size_x;
    double size_y;
    double size_z;
    bool flat;
    std::vector<std::vector<double>> vertex;
    std::vector<std::vector<double>> face;
};

/**
 * `CylinderOptions`, as the reached slice resolves it.
 *
 * `diameter_top` and `diameter_bottom` are the pin's own `??` chain already
 * resolved, so the `diameter` shorthand does not survive here -- and the
 * shorthand is exactly why the zero question travels beside the value.
 */
struct CylinderOptions {
    double height;
    double diameter_top;
    double diameter_bottom;
    double tessellation;
    double subdivisions;
    /**
     * Whether the scene named a zero TOP diameter.
     *
     * The builder clamps a zero to 0.00001 for its ring maths, and asks
     * this separately to decide whether to reuse the previous ring's
     * normals at a cone tip. The pin asks it of the option the scene
     * wrote, so a zero arriving through the `diameter` shorthand answers
     * NO -- which is why the record carries the question and not just the
     * value.
     */
    bool diameter_top_is_zero;
};

/**
 * `CapsuleOptions`, as the reached slice resolves it.
 *
 * The opposite contract to every other builder's record. `createCapsuleData`
 * resolves each option by TRUTHINESS (`options.height ? options.height : 1`)
 * rather than by `??`, so an omitted option and an explicit zero are the
 * same answer upstream. Zero is therefore what an option the scene did not
 * name carries here, and the generated builder applies every default itself
 * -- including the two that fall back to another resolved option rather
 * than to a constant (`radius_top`/`radius_bottom` to `radius`, and each
 * cap to `cap_subdivisions`).
 */
struct CapsuleOptions {
    double height;
    double radius;
    double radius_top;
    double radius_bottom;
    double tessellation;
    double subdivisions;
    double cap_subdivisions;
    double top_cap_subdivisions;
    double bottom_cap_subdivisions;
};

/**
 * `DiscOptions`, as the reached slice resolves it.
 *
 * Every field is written by generation from the pinned factory's own `??`
 * chain, so none carries a default here.
 */
struct DiscOptions {
    double radius;
    double tessellation;
    double arc;
};

struct TorusOptions {
    double diameter;
    double thickness;
    std::uint32_t tessellation;
};

/**
 * `TorusKnotOptions`, as the reached slice resolves it.
 *
 * Every field is written by generation from the pinned factory's own `??`
 * chain, so none carries a default here -- the disc's contract, for the
 * other builder whose whole option set is scalars.
 */
struct TorusKnotOptions {
    double radius;
    double tube;
    double radial_segments;
    double tubular_segments;
    double p;
    double q;
};

struct EnvironmentOptions {
    std::string environment_url;
    std::string ground_texture_url;
    std::string skybox_url;
    float skybox_size = 1000.0f;
    std::string brdf_url;
    // A skybox URL naming the .env itself asks for the environment's own
    // cubemap rather than a separate DDS, which is the pinned loader's
    // `skyboxIsEnv` branch. Decided at compile time from the two URLs.
    bool skybox_uses_environment = false;
    // The pinned `!bgOptions.skipSkybox` arm: no DDS, no .env skybox and no
    // `skipSkybox` leaves the solid-colour cube. Decided at compile time
    // alongside the flag above.
    bool solid_skybox = false;
    // The pinned `!bgOptions.skipGround` arm, which does not consult the
    // texture URL: `buildGroundRenderable` falls back to a 1x1 white texel.
    bool ground = false;
};

struct HdrEnvironmentOptions {
    std::string environment_url;
    std::string brdf_url;
    bool use_cubemap_skybox = false;
    float skybox_size = 0.0f;
    Vec3 skybox_position{};
};

// src/material/pbr/background-dds-environment.ts: the DDS skybox and the
// ground, reached without the .env loader that usually builds them. The
// module takes no skip flags -- both renderables are unconditional -- so
// what crosses is the two URLs, the requested size and the noise flag.
struct DdsEnvironmentBackgroundOptions {
    std::string ground_texture_url;
    std::string skybox_url;
    float skybox_size = 0.0f;
    bool enable_noise = true;
};

// A prefiltered DDS cubemap arrives compiled into the same environment
// package an HDR source produces, so the loader needs only the two paths.
struct DdsEnvironmentOptions {
    std::string environment_url;
    std::string brdf_url;
};

// No defaulted option parameters below: generation always passes a full
// options literal, so an omitted-argument arm would be a dead second
// copy of the pin's defaults waiting for a caller to trust it.
Engine create_engine(EngineOptions options);
Surface create_surface(Engine& engine, UiElementHandle canvas);
void dispose_surface(Surface& surface);
Scene create_scene_context(Engine& engine);
double scene_callback_delta(const Scene& scene, double engine_delta_ms);
Scene create_scene_context(Surface& surface);
FrameGraphContext create_frame_graph_context(Engine& engine);
std::string asset_path(const std::string& relative_path);
MeshHandle create_box(Engine& engine, BoxOptions options);
MeshHandle create_ground(Engine& engine, GroundOptions options);
/**
 * The pinned heightmap ground: the grid above, displaced by an image.
 *
 * `height_map` names the packaged image beside the executable; the pin reads
 * it through a canvas, so what the displacement sees is RGBA8 either way.
 */
MeshHandle create_ground_from_height_map(
    Engine& engine,
    GroundOptions options,
    double min_height,
    double max_height,
    const char* height_map);
MeshHandle create_plane(Engine& engine, PlaneOptions options);
MeshHandle create_sphere(Engine& engine, SphereOptions options);
MeshData create_box_data(double width, double height, double depth);
MeshData create_sphere_data(SphereOptions options);
void attach_morph_target(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    double vertex_count,
    float weight);
void set_morph_target_weights(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& weights);
MeshHandle create_torus(Engine& engine, TorusOptions options);
MeshHandle create_torus_knot(Engine& engine, TorusKnotOptions options);
MeshHandle create_disc(Engine& engine, DiscOptions options);
MeshHandle create_cylinder(Engine& engine, CylinderOptions options);
MeshHandle create_capsule(Engine& engine, CapsuleOptions options);
MeshHandle create_polyhedron(Engine& engine, PolyhedronOptions options);
MeshHandle create_ribbon(Engine& engine, RibbonOptions options);
MeshHandle create_ribbon_mesh(
    Engine& engine,
    RibbonOptions options,
    std::string_view name);
MeshHandle create_extrude_shape(
    Engine& engine,
    const std::vector<Vec3d>& shape,
    const std::vector<Vec3d>& curve,
    double scale,
    double rotation);
MeshHandle create_tube(
    Engine& engine,
    const std::vector<Vec3d>& path_points,
    double radius,
    double tessellation_option);
MeshHandle create_mesh_from_data(
    Engine& engine,
    const std::string& name,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices,
    const std::vector<float>& uvs,
    const std::vector<float>& uvs2,
    const std::vector<float>& tangents,
    const std::vector<float>& colors);
void update_mesh_positions(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& positions,
    double vertex_offset,
    double vertex_count,
    double source_vertex_offset);
// The matrices parameter is a non-const lvalue reference on purpose: the
// record keeps aliasing the caller's array for later per-frame updates
// (the pinned setThinInstances adopts the array by reference), so a
// temporary here would dangle. The compiler only passes named bindings.
void set_thin_instances(
    Engine& engine,
    MeshHandle mesh,
    std::vector<float>& matrices,
    double count);
HierarchyInstancePoolHandle create_hierarchy_instance_pool(
    Engine& engine,
    AssetHandle root,
    double capacity);
double add_hierarchy_instance(
    Engine& engine,
    HierarchyInstancePoolHandle pool,
    const std::vector<float>& matrix);
void set_hierarchy_instance_matrix(
    Engine& engine,
    HierarchyInstancePoolHandle pool,
    double index,
    const std::vector<float>& matrix);
void remove_hierarchy_instance(
    Engine& engine,
    HierarchyInstancePoolHandle pool,
    double index);
void set_hierarchy_instance_count(
    Engine& engine,
    HierarchyInstancePoolHandle pool,
    double count);
void set_thin_instance_count(
    Engine& engine,
    MeshHandle mesh,
    double count);
/**
 * The growing half of the pool, emitted where a scene reaches it.
 *
 * `add_thin_instance` appends at the active count and returns the slot,
 * doubling the pool when the two have met; `remove_thin_instance`
 * swap-removes; `thin_instance_count` is the live `thinInstances.count`
 * read those two are written against.
 */
double add_thin_instance(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& matrix);
void remove_thin_instance(
    Engine& engine,
    MeshHandle mesh,
    double index);
double thin_instance_count(const Engine& engine, MeshHandle mesh);
/** The pinned GPU-culling opt-in; see MeshRecord::thin_instance_gpu_culling. */
void enable_thin_instance_gpu_culling(
    Engine& engine,
    MeshHandle mesh,
    bool enabled);
void set_thin_instance_matrix(
    Engine& engine,
    MeshHandle mesh,
    double index,
    const std::vector<float>& matrix);
void flush_thin_instances(Engine& engine, MeshHandle mesh);
void upload_thin_instance_matrices(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& matrices,
    double count);
void set_thin_instance_colors(
    Engine& engine,
    MeshHandle mesh,
    const js::F32Array& colors);
void set_thin_instance_color(Engine& engine, MeshHandle mesh, double index,
    double r, double g, double b, double a);
void set_thin_instance_cull_bounds_pad(Engine& engine, MeshHandle mesh, double pad);
/** Restore a baked imported mesh's local pivot before replacing its rotation. */
void prepare_imported_mesh_quaternion_write(
    Engine& engine,
    MeshHandle mesh);
/**
 * Mark a mesh's baked transform dirty, including every mesh whose world
 * matrix depends on it through setParent.
 */
void mark_mesh_dirty(Engine& engine, MeshHandle mesh);
/** Keep a runtime-moving mesh subtree local and publish its draw world. */
void mark_mesh_runtime_transform(Engine& engine, MeshHandle mesh);
/** The same one level up, recursing into both of a node's child arms. */
void mark_transform_node_runtime_transform(
    Engine& engine,
    TransformNodeHandle node);
/** Install a mesh quaternion in the coordinate basis its vertices use. */
void set_mesh_rotation_quaternion(
    Engine& engine,
    MeshHandle mesh,
    Vec4 quaternion,
    bool runtime_transform);
void flatten_line_attributes(
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors,
    std::size_t vertex_count,
    std::vector<float>& positions,
    std::vector<float>& out_colors,
    std::vector<std::uint32_t>* line_point_counts,
    std::vector<std::uint32_t>* indices);
LineSystemData create_line_system_data(
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors);
MeshHandle create_line_system(
    Engine& engine,
    const std::string& name,
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors,
    MaterialHandle material);
void update_line_system(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors);
AssetHandle load_gltf(Engine& engine, const std::string& path);
AssetHandle load_gltf(Engine& engine, const std::string& path, bool load_cameras);
// The opt-in bone-control surface (`src/skeleton/bone-control.ts`), defined
// by a generated glTF loader compiled with it. `getBoneByName` answers from
// the skeleton's own name map -- the first joint carrying the name, in joint
// order -- and reports a miss as an invalid handle, which is the `undefined`
// the pin returns. `setBoneVisible` writes the asset-wide override and
// re-bakes, so it works with no animation at all.
BoneHandle get_bone_by_name(
    Engine& engine,
    SkeletonHandle skeleton,
    const std::string& name);
void set_bone_visible(
    Engine& engine,
    SkeletonHandle skeleton,
    BoneHandle bone,
    bool visible);
// The scene-authored skeleton surface (`src/skeleton/create-skeleton.ts`
// and `src/skeleton/update-skeleton-bone-matrices.ts`), defined by the
// generated `upstream/src/skeleton.cpp` when a scene reaches it.
SceneSkeletonHandle create_scene_skeleton(
    Engine& engine,
    const std::vector<std::uint16_t>& joints,
    const std::vector<float>& weights,
    double bone_count,
    const std::vector<float>& bone_data);
void attach_scene_skeleton(
    Engine& engine,
    MeshHandle mesh,
    SceneSkeletonHandle skeleton);
void update_scene_skeleton_bone_matrices(
    Engine& engine,
    SceneSkeletonHandle skeleton,
    const std::vector<float>& bone_data);
AssetHandle load_babylon(Engine& engine, const std::string& path, bool load_camera = true, bool load_textures = true);
std::shared_ptr<const EnvironmentState> load_environment(Scene& scene, EnvironmentOptions options);
std::shared_ptr<LocalCubemapRecord> load_local_cubemap(
    const std::string& path, std::vector<std::shared_ptr<const EnvironmentState>> environments);
void add_dds_environment_background(
    Scene& scene,
    DdsEnvironmentBackgroundOptions options);
void load_hdr_environment(Scene& scene, HdrEnvironmentOptions options);
void load_dds_environment(Scene& scene, DdsEnvironmentOptions options);
MaterialHandle create_standard_material(Engine& engine);
MaterialHandle create_grid_material(
    Engine& engine,
    GridMaterialOptions options);
MaterialHandle create_shader_material(
    Engine& engine,
    std::uint32_t variant);
/**
 * One texture a scene handed `parseNodeMaterialFromSnippet` through its
 * `textures` record, under the binding name it keyed it by.
 *
 * The name travels rather than a slot index because the pin's own join is by
 * name (`options.textures?.[tb._name]`), and which pair a name landed on is
 * the composed graph's answer -- `create_node_material` resolves the two
 * against each other exactly where upstream does.
 */
struct NodeMaterialTexture {
    std::string name;
    StoredTexture texture;
};

NodeMaterialTexture node_material_texture(
    std::string name,
    FileTexture texture);
NodeMaterialTexture node_material_texture(
    std::string name,
    const PixelsTexture& texture);
NodeMaterialTexture node_material_texture(
    std::string name,
    const SolidTexture& texture);
NodeMaterialTexture node_material_texture(
    std::string name,
    const StoredTexture& texture);

MaterialHandle create_node_material(
    Engine& engine,
    std::uint32_t variant,
    std::vector<NodeMaterialTexture> textures);
void queue_node_material_group(Scene& scene, MeshHandle mesh);
void set_shader_uniform_values(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    std::uint32_t count,
    const float* values);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2,
    float v3);
template <typename... Values>
void set_scene_shader_uniform_value(
    Engine& engine,
    std::size_t slot,
    std::uint32_t offset,
    Values... values) {
    if (slot >= engine.scene_material_slots.size() ||
        engine.scene_material_slots[slot].value == invalid_handle) {
        return;
    }
    set_shader_uniform_value(
        engine,
        engine.scene_material_slots[slot],
        offset,
        values...);
}
void set_shader_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    FileTexture texture);
void set_shader_storage_buffer(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    StorageBufferHandle buffer);
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
void set_shader_csm_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    ShadowGeneratorHandle generator);
#endif
void set_shadow_caster_material(
    Engine& engine,
    MaterialHandle material,
    MaterialHandle caster);
void set_shader_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    const PixelsTexture& texture);
void set_shader_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    const StoredTexture& texture);
void set_standard_diffuse_render_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture);
void set_alpha_to_coverage(
    Engine& engine,
    MaterialHandle material,
    bool enabled);
void set_pbr_unlit(
    Engine& engine,
    MaterialHandle material,
    std::optional<Color3> unlit_color = std::nullopt);
void set_pbr_skybox(Engine& engine, MaterialHandle material);
void set_pbr_occlusion_solid_texture(
    Engine& engine,
    MaterialHandle material,
    const SolidTexture& texture);
void set_pbr_clearcoat(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float roughness,
    float index_of_refraction,
    float normal_scale);
void set_pbr_anisotropy(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    Vec2 direction);
void set_pbr_iridescence(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float index_of_refraction,
    float minimum_thickness,
    float maximum_thickness);
void set_pbr_sheen(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    Color3 color,
    float roughness,
    float intensity);
void set_pbr_sheen_texture(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture);
void set_pbr_emissive(
    Engine& engine,
    MaterialHandle material,
    Color3 color);
void set_pbr_metallic_reflectance(
    Engine& engine,
    MaterialHandle material,
    bool has_color,
    Color3 color,
    FileTexture metallic_texture,
    FileTexture reflectance_texture);
// `enable-pbr-lightmap.ts#setPbrLightmap`, past everything the composer
// already settled: what reaches the record is the texture the extension's
// own `bind` hook binds and the level its `writeUbo` reads.
void set_pbr_lightmap(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture,
    float level);
void set_standard_lightmap_texture(Engine& engine, MaterialHandle material, const FileTexture& texture);
void set_pbr_subsurface(
    Engine& engine,
    MaterialHandle material,
    float intensity,
    Color3 color,
    Color3 diffusion_distance,
    float minimum_thickness,
    float maximum_thickness,
    FileTexture thickness_texture);
SolidTexture create_solid_texture(Engine& engine, float r, float g, float b, float a = 1.0f);
FileTexture solid_texture_file(const SolidTexture& texture);
FileTexture load_file_texture(
    Engine& engine,
    const std::string& path,
    TextureSamplerState sampler,
    bool invert_y,
    bool srgb,
    bool premultiply_alpha = false);
// `ktx-loader.ts` loadKtxTexture2D, past the suffix selection generation
// resolved: the container is parsed and its blocks are uploaded as they
// are. `invert_y` is the texture-object property the pin's own loader
// leaves unset here and sets in `basis-loader.ts`, which is what decides
// the Standard UV block's V flip.
FileTexture load_compressed_texture(
    Engine& engine,
    const std::string& path,
    bool invert_y);
void set_material_base_color_file(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture);
void set_material_orm_file(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture);
MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options);
MaterialHandle create_standard_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
MaterialHandle create_standard_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator);
MaterialHandle create_pbr_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator);
MaterialHandle create_node_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator);
MaterialHandle create_pbr_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
MaterialHandle create_node_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
void mark_material_ubo_dirty(Engine& engine, MaterialHandle material);
void set_standard_emissive_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture);
void set_standard_emissive_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture);
void set_standard_diffuse_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    const PixelsTexture& texture);
void set_standard_diffuse_solid_texture(
    Engine& engine,
    MaterialHandle material,
    const SolidTexture& texture);
void set_standard_diffuse_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture);
inline void set_standard_diffuse_texture(
    Engine& engine,
    MaterialHandle material,
    const StoredTexture& texture) {
    std::visit([&](const auto& source) {
        if constexpr (std::is_same_v<std::decay_t<decltype(source)>, FileTexture>) {
            set_standard_diffuse_file_texture(engine, material, source);
        } else {
            set_standard_diffuse_pixels_texture(engine, material, source);
        }
    }, texture);
}
void enable_material_uv_transform(
    Engine& engine,
    MaterialHandle material);
void set_material_plugins(
    Engine& engine,
    MaterialHandle material,
    std::uint8_t signature_index);
// The textures a plugin's `bindTextures` fills its declared bindings with,
// appended in push order. `set_material_plugins` clears the list first, so
// a second `material.plugins = [...]` replaces them the way it replaces the
// plugin list upstream.
void add_material_plugin_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    const PixelsTexture& texture);
void add_material_plugin_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture);
LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
LightHandle create_directional_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
LightHandle create_point_light(Engine& engine, Vec3 position, float intensity = 1.0f);
LightHandle create_spot_light(
    Engine& engine,
    Vec3 position,
    Vec3 direction,
    double angle,
    float exponent,
    float intensity = 1.0f);
// A light's position and direction are ObservableVec3 upstream: writing one
// marks the light's local matrix dirty, and the next read rebuilds it. These
// entry points are that pair — the field write plus the rebuild — and each is
// emitted beside its own kind's factory, so a scene reaching no light of a
// kind links none of them. Only the vectors a reached scene writes are
// lowered; the rest refuse at compile time (src/compiler/assignments.ts).
void set_point_light_position(Engine& engine, LightHandle light, Vec3 position);
void set_directional_light_position(Engine& engine, LightHandle light, Vec3 position);
void set_directional_light_direction(Engine& engine, LightHandle light, Vec3 direction);
// src/scene/transform-node.ts createTransformNode: a SceneNode with the
// pinned factory's own TRS defaults. Its setters take the same shape the
// light vector setters take -- the field write plus the version bump a
// child re-bakes against -- because upstream both are ObservableVec3 writes
// on a node whose world matrix is lazily recomposed.
TransformNodeHandle create_transform_node(
    Engine& engine,
    std::string name,
    Vec3d position,
    Vec4 rotation_quaternion,
    Vec3 scaling);
void set_transform_node_position(
    Engine& engine,
    TransformNodeHandle node,
    Vec3d position,
    bool runtime_transform = false);
void set_transform_node_scaling(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 scaling,
    bool runtime_transform = false);
void set_transform_node_rotation(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 rotation,
    bool runtime_transform = false);
void set_transform_node_rotation_quaternion(
    Engine& engine,
    TransformNodeHandle node,
    Vec4 rotation,
    bool runtime_transform = false);
// `child.parent = node` drives the transform math; `node.children.push`
// only fills the traversal list. Upstream keeps them apart in exactly this
// way, so each is its own entry point.
// src/mesh/enable-mirrored-meshes.ts: the opt-in that installs winding
// reversal from the live world determinant, for the meshes the glTF
// loader's own load-time pass cannot see.
void enable_mirrored_meshes(Scene& scene);
// A bounded multi-frame drain: the scene's own condition, which the frame
// loops consult before they capture. Upstream the wait sits in front of
// `canvas.dataset.ready`, and the harness screenshots on that flag -- so a
// capture taken before the condition holds is a different frame.
void defer_capture_until(Engine& engine, std::function<bool()> ready);
void set_mesh_transform_parent(
    Engine& engine,
    MeshHandle mesh,
    TransformNodeHandle parent);
// The same write where the parent lane a MESH holds is the one taken.
// Upstream `parent` is one nullable SceneNode field; mesh and transform-node
// handles live in different native tables, so it becomes these two overloads
// over the two lanes MeshRecord keeps. Generated under mesh:parenting, the
// feature that owns the mesh parent lane, while the overload above is
// generated with the transform-node factories.
void set_mesh_transform_parent(
    Engine& engine,
    MeshHandle mesh,
    MeshHandle parent);
// `mesh.children.push(child)`, the traversal twin of
// `push_transform_node_child`.
void push_mesh_child(
    Engine& engine,
    MeshHandle mesh,
    MeshHandle child);
// The same setter one level up: a transform node hung under another one.
// `transform_node_world` already composes the chain, and
// `mark_transform_node_dirty` already recurses into `parented_nodes`; this
// is the write that fills that list, so a node moved under a parent
// re-bakes the meshes beneath it.
void set_transform_node_parent(
    Engine& engine,
    TransformNodeHandle node,
    TransformNodeHandle parent);
void push_transform_node_child(
    Engine& engine,
    TransformNodeHandle node,
    MeshHandle child);
void push_transform_node_child(
    Engine& engine,
    TransformNodeHandle node,
    TransformNodeHandle child);
// src/gizmo/*: the display-gizmo family. Every one of these is generated
// into upstream/src/gizmo.cpp from the pinned modules that declare it.
UtilityLayerHandle create_utility_layer(Engine& engine, Scene& main_scene);
void register_utility_layer(Engine& engine, UtilityLayerHandle layer);
Scene& utility_layer_scene(Engine& engine, UtilityLayerHandle layer);
void dispose_utility_layer(Engine& engine, UtilityLayerHandle layer);
CameraGizmoHandle create_camera_gizmo(
    Engine& engine,
    UtilityLayerHandle layer);
void attach_camera_gizmo_to_camera(
    Engine& engine,
    CameraGizmoHandle gizmo,
    CameraHandle camera);
LightGizmoHandle create_light_gizmo(
    Engine& engine,
    UtilityLayerHandle layer);
void attach_light_gizmo_to_light(
    Engine& engine,
    LightGizmoHandle gizmo,
    LightHandle light);
// The four editing widgets. Each takes the axis its pinned body orients
// its root onto, and every option the pin defaults through a `??` as the
// pin's own optional -- the `?? [0.5, 0.5, 0.5]`, `?? 1` and `?? 32`
// behind them stay in the generated body, where the pin writes them.
// Colours and thicknesses arrive as `double` because they are plain
// JavaScript numbers upstream: the builder's own arithmetic runs at that
// width and narrows once, at the store. All four share one attach call
// because the pin's four attach bodies are identical, which generation
// asserts.
EditGizmoHandle create_axis_drag_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d drag_axis,
    std::optional<Vec3d> color,
    std::optional<double> thickness);
EditGizmoHandle create_axis_scale_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d drag_axis,
    std::optional<Vec3d> color,
    std::optional<double> thickness,
    std::optional<bool> uniform_scaling);
EditGizmoHandle create_plane_drag_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d drag_plane_normal,
    std::optional<Vec3d> color);
EditGizmoHandle create_plane_rotation_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d plane_normal,
    std::optional<Vec3d> color,
    std::optional<double> tessellation,
    std::optional<double> thickness);
void attach_gizmo_to_node(
    Engine& engine,
    EditGizmoHandle gizmo,
    MeshHandle node);
// `useLocalCoordinates` on one widget: the flag the pin's follow reads to
// decide whether the root tracks the attached node's world rotation.
void set_edit_gizmo_local_coordinates(
    Engine& engine,
    EditGizmoHandle gizmo,
    bool use_local);
bool pointer_drag_has_collider(
    const Engine& engine,
    PointerDragHandle drag,
    MeshHandle mesh);
// The three composites (`src/gizmo/composite-gizmos.ts`). Each builds its
// sub-widgets through the four factories above with the axis, colour and
// option values its own pinned body passes, so nothing about a composite
// is spelled outside the pin. The two entry points below them are the
// pin's own fan-outs, which is all a composite record is for.
CompositeGizmoHandle create_position_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    std::optional<bool> planar_enabled,
    std::optional<double> thickness);
CompositeGizmoHandle create_rotation_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    std::optional<double> tessellation,
    std::optional<double> thickness);
CompositeGizmoHandle create_scale_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    std::optional<double> thickness);
void attach_composite_gizmo_to_node(
    Engine& engine,
    CompositeGizmoHandle gizmo,
    MeshHandle node);
void set_composite_gizmo_local_coordinates(
    Engine& engine,
    CompositeGizmoHandle gizmo,
    bool use_local);
void dispose_composite_gizmo(
    Engine& engine,
    CompositeGizmoHandle gizmo,
    UtilityLayerHandle layer);
// The bounding-box gizmo (`src/gizmo/bounding-box-gizmo.ts`). Its four
// options are the members the pinned factory defaults through a `??`, and
// each arrives as the pin's own optional so the default stays in the
// generated body. The attach target is a transform node: upstream the
// parameter is a SceneNode over both kinds, and what the cage reads back
// -- the node's world matrix, and the parent chain each candidate mesh is
// tested against -- is one identity here.
BoundingBoxGizmoHandle create_bounding_box_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    std::optional<Vec3d> color,
    std::optional<double> edge_thickness,
    std::optional<double> scale_box_size,
    std::optional<double> rotation_anchor_size);
void attach_bounding_box_gizmo_to_node(
    Engine& engine,
    BoundingBoxGizmoHandle gizmo,
    TransformNodeHandle node);
void set_spot_light_position(Engine& engine, LightHandle light, Vec3 position);
void set_spot_light_direction(Engine& engine, LightHandle light, Vec3 direction);
// The spot cone angle is an accessor upstream rather than a field: its setter
// recomputes the cone cosine `_writeLightUbo` packs. The record holds both, so
// this entry point writes the pair from the pin's own half-angle expression.
void set_spot_light_angle(Engine& engine, LightHandle light, double angle);
CameraHandle create_arc_rotate_camera(Engine& engine, double alpha, double beta, double radius, Vec3d target);
CameraHandle create_free_camera(Engine& engine, Vec3d position, Vec3d target);
CameraHandle create_banked_free_camera(
    Engine& engine,
    Vec3d position,
    Vec3d target,
    Vec3d up);
CameraHandle create_default_camera(Engine& engine, Scene& scene);
// Returns the same camera so the caller can keep using it as the live
// orthographic bounds object the pinned entry point hands back.
CameraHandle enable_orthographic_camera(
    Engine& engine,
    CameraHandle camera,
    double half_height);

RenderTargetHandle create_render_target(
    Engine& engine,
    RenderTargetOptions options);
RenderTargetTexture create_render_target_texture(
    Engine& engine,
    RenderTargetOptions options);
RenderTargetHandle swapchain_render_target(Engine& engine);
TaskHandle create_render_task(
    Engine& engine,
    Scene& scene,
    RenderTaskOptions options);
TaskHandle create_geometry_renderer_task(
    Engine& engine,
    Scene& scene,
    GeometryTaskOptions options);
TaskHandle create_copy_to_texture_task(
    Engine& engine,
    Scene& scene,
    CopyTaskOptions options);
TaskHandle create_post_process_task(
    Engine& engine,
    PostProcessTaskOptions options);
void update_post_process_uniforms(Engine& engine, TaskHandle task);
/**
 * Resolves one pass's `output_target`: the caller's target, or one made from
 * the source's own descriptor at a single sample (the pin's
 * `prepareOutputTarget`). Shared by the post-process and screen-space task
 * factories, which build the same pass.
 */
void resolve_post_process_pass_output(
    Engine& engine,
    PostProcessPassOptions& pass);
RenderTextureRef render_target_texture(RenderTargetHandle target);
RenderTextureRef geometry_task_texture(
    TaskHandle task,
    GeometryTextureType type);
RenderTextureRef geometry_task_output_texture(TaskHandle task);
RenderTextureRef geometry_task_depth_texture(TaskHandle task);
void add_task(Scene& scene, TaskHandle task);
void add_task_at_start(Scene& scene, TaskHandle task);
void add_task(FrameGraphContext& context, TaskHandle task);
void add_task_at_start(FrameGraphContext& context, TaskHandle task);

/**
 * `PcfSpotlightShadowGeneratorConfig`, as the reached slice resolves it.
 *
 * `mapSize` sizes a GPU texture, so it is decided at generation; the rest
 * are the pinned `??` defaults or what the scene passed, at the JavaScript
 * width the pin holds them (a spot's projection near/far reach the
 * perspective volume before any float store).
 */
struct PcfSpotShadowOptions {
    std::uint32_t map_size = 512;
    double bias = 0.0;
    double darkness = 0.0;
    double near_plane = 1.0;
    double far_plane = 10000.0;
};

/**
 * `createEsmDirectionalShadowGenerator`'s options, in its own order.
 *
 * `blur_kernel` is here for the record rather than for a run-time read: the
 * blur fragment's tap table is folded from it at generation, so a value that
 * disagreed with the deployed shader would be a silent fork.
 */
struct EsmDirectionalShadowOptions {
    std::uint32_t map_size = 1024;
    double depth_scale = 50.0;
    double bias = 0.00005;
    std::uint32_t blur_kernel = 1;
    std::uint32_t blur_scale = 2;
    double darkness = 0.0;
    double frustum_edge_falloff = 0.0;
    double ortho_min_z = 1.0;
    double ortho_max_z = 10000.0;
    /**
     * `cfg.forceRefreshEveryFrame ?? false`: disables the pinned
     * render-gate so the map re-renders every frame (break-meshes, whose
     * physics-driven pieces the map must track).
     */
    bool force_refresh_every_frame = false;
    /**
     * Which row of the generated resource table is this generator's.
     * Generation composed one row per ESM factory call, in reach order, so
     * the ordinal is a compile-time value like the three above it.
     */
    std::uint32_t esm_index = 0;
};

/**
 * `PcfDirectionalShadowGeneratorConfig`, as the reached slice resolves it.
 *
 * The spot generator's own three, plus the ortho volume the caster fit
 * projects into — a directional light has no position to project from, so
 * `near`/`far` are replaced by the pair `computeDirectionalLightMatrix`
 * takes. `normalBias` is unreached on the two PCF factories and refuses by
 * name — generation anchors each factory's `?? false` default, so a pin that
 * changes what those factories carry refuses here rather than drifting
 * silently. `forceRefreshEveryFrame` rides into the record, where it
 * disables the pinned render gate: the ESM and CSM factories already carry
 * it (break-meshes reaches those), and the PCF DIRECTIONAL factory carries
 * it for scene 140. The PCF SPOT factory still refuses it, because no
 * corpus scene reaches it there.
 */
struct PcfDirectionalShadowOptions {
    // No initialisers: generation writes every field from the factory's own
    // `??` chain, so a default written here would be a second copy of a
    // pinned constant that nothing can catch drifting. A field the emitter
    // forgets is then a compile error rather than a silent 1024.
    std::uint32_t map_size;
    double bias;
    double darkness;
    double ortho_min_z;
    double ortho_max_z;
    bool force_refresh_every_frame;
};

/**
 * `CsmDirectionalShadowGeneratorConfig`, as the reached slice resolves it.
 *
 * `map_size` and the cascade count size the layered map; the rest ride into
 * the record, where the per-cascade fit and the receiver's own 320-byte
 * block read them. `stabilizeCascades` and `worldSpaceBias` are the two
 * arms this port does not build and refuse by name at generation.
 */
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
struct CsmDirectionalShadowOptions {
    // No initialisers, for the reason above: every field is written from
    // the factory's own `??`.
    std::uint32_t map_size;
    std::uint32_t csm_num_cascades;
    double csm_lambda;
    double csm_cascade_blend_percentage;
    /** `cfg.shadowMaxZ ?? null`, resolved against the camera's far plane. */
    std::optional<double> csm_shadow_max_z;
    double bias;
    double darkness;
    double frustum_edge_falloff;
    /** `cfg.forceRefreshEveryFrame ?? false`: disables the render gate. */
    bool force_refresh_every_frame;
};
#endif

ShadowGeneratorHandle create_pcf_spotlight_shadow_generator(
    Engine& engine,
    LightHandle light,
    PcfSpotShadowOptions options);
ShadowGeneratorHandle create_esm_directional_shadow_generator(
    Engine& engine,
    LightHandle light,
    EsmDirectionalShadowOptions options);
ShadowGeneratorHandle create_pcf_directional_shadow_generator(
    Engine& engine,
    LightHandle light,
    PcfDirectionalShadowOptions options);
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
ShadowGeneratorHandle create_csm_directional_shadow_generator(
    Engine& engine,
    LightHandle light,
    CsmDirectionalShadowOptions options);
#endif
void set_shadow_task_caster_meshes(
    Engine& engine,
    ShadowGeneratorHandle generator,
    std::vector<MeshHandle> caster_meshes);
void enable_morph_target_shadows(
    Engine& engine,
    ShadowGeneratorHandle generator);
void add_render_task_mesh(
    Engine& engine,
    TaskHandle task,
    MeshHandle mesh,
    MaterialHandle material);

void add_to_scene(Scene& scene, MeshHandle mesh);
void add_to_scene(Scene& scene, TransformNodeHandle node);
void add_to_scene(Scene& scene, LightHandle light);
void add_to_scene(Scene& scene, AssetHandle asset);
void add_to_scene(Scene& scene, const SceneNodeHandle& node);
void add_asset_entities(Scene& scene, AssetHandle asset);
AssetHandle clone_asset_root(Engine& engine, AssetHandle asset);
MeshHandle clone_mesh_node(Engine& engine, MeshHandle mesh);
void set_asset_root_position_component(
    Engine& engine,
    AssetHandle asset,
    std::size_t component,
    float value);
void set_asset_root_rotation_component(
    Engine& engine,
    AssetHandle asset,
    std::size_t component,
    float value);
void set_asset_root_position(
    Engine& engine,
    AssetHandle asset,
    Vec3 value);
void set_asset_root_rotation(
    Engine& engine,
    AssetHandle asset,
    Vec3 value);
void reset_asset_root_scaling(Engine& engine, AssetHandle asset);

// A retained SceneNode may be a mesh, a transform node, or an imported root.
Vec3d scene_node_position(Engine& engine, const SceneNodeHandle& node);
Vec3 scene_node_rotation(Engine& engine, const SceneNodeHandle& node);
Vec3 scene_node_scaling(Engine& engine, const SceneNodeHandle& node);
Vec4 scene_node_rotation_quaternion(Engine& engine, const SceneNodeHandle& node);
void set_scene_node_position(Engine& engine, const SceneNodeHandle& node, Vec3d value, bool runtime_transform);
void set_scene_node_rotation(Engine& engine, const SceneNodeHandle& node, Vec3 value, bool runtime_transform);
void set_scene_node_scaling(Engine& engine, const SceneNodeHandle& node, Vec3 value, bool runtime_transform);
void set_scene_node_rotation_quaternion(Engine& engine, const SceneNodeHandle& node, Vec4 value, bool runtime_transform);
void set_scene_node_position_component(Engine& engine, const SceneNodeHandle& node, std::size_t component, double value, bool runtime_transform);
void set_scene_node_rotation_component(Engine& engine, const SceneNodeHandle& node, std::size_t component, float value, bool runtime_transform);
void set_scene_node_scaling_component(Engine& engine, const SceneNodeHandle& node, std::size_t component, float value, bool runtime_transform);
void set_scene_node_rotation_quaternion_component(Engine& engine, const SceneNodeHandle& node, std::size_t component, float value, bool runtime_transform);
void remove_from_scene(Scene& scene, MeshHandle mesh);
void remove_from_scene(Scene& scene, LightHandle light);
void on_before_render(
    Scene& scene,
    js::Callback<void(float)> callback);
void on_scene_dispose(
    Scene& scene,
    js::Callback<void()> callback);
void on_key_down(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformKeyboardEvent&)> callback,
    bool once = false);
void off_key_down(Engine& engine, std::size_t identity);
void on_key_up(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformKeyboardEvent&)> callback,
    bool once = false);
void off_key_up(Engine& engine, std::size_t identity);
void on_pointer_down(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once = false);
void off_pointer_down(Engine& engine, std::size_t identity);
void on_canvas_click(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once = false);
void off_canvas_click(Engine& engine, std::size_t identity);
void on_mouse_down(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once = false);
void off_mouse_down(Engine& engine, std::size_t identity);
void on_mouse_up(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once = false);
void off_mouse_up(Engine& engine, std::size_t identity);
void on_mouse_move(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once = false);
void off_mouse_move(Engine& engine, std::size_t identity);
void on_mouse_wheel(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once = false);
void off_mouse_wheel(Engine& engine, std::size_t identity);
void on_mouse_cancel(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once = false);
void off_mouse_cancel(Engine& engine, std::size_t identity);
void on_window_resize(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once = false);
void off_window_resize(Engine& engine, std::size_t identity);
void on_pointer_lock_change(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once = false);
void off_pointer_lock_change(Engine& engine, std::size_t identity);
void set_canvas_cursor(Engine& engine, std::string cursor);
void focus_canvas(Engine& engine);
void request_pointer_lock(Engine& engine);
void exit_pointer_lock(Engine& engine);
void on_visibility_change(
    Engine& engine,
    std::size_t identity,
    std::function<void(bool)> callback,
    bool once = false);
void off_visibility_change(Engine& engine, std::size_t identity);
#if !defined(BBLITE_HAS_ANIMATION) || BBLITE_HAS_ANIMATION
#include <bblite/runtime/animation-api.hpp>
#endif
void set_animation_weight(
    Engine& engine,
    AnimationGroupHandle group,
    float weight);
void go_to_frame(
    Engine& engine,
    AnimationGroupHandle group,
    float frame,
    bool with_engine);
void play_animation(Engine& engine, AnimationGroupHandle group);
void pause_animation(Engine& engine, AnimationGroupHandle group);
void stop_animation(Engine& engine, AnimationGroupHandle group);
// src/vat/vat-baker.ts: the baked vertex-animation surface. Emitted only
// for a scene that reached mesh:vat, which is the pin's own opt-in --
// bakeVat is the dynamic-import trigger for the whole chunk.
VatBake bake_vat(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<AnimationGroupHandle>& groups);
VatHandle attach_vat(
    Engine& engine,
    MeshHandle mesh,
    VatBake baked,
    const std::string& clip);
void vat_play(
    Engine& engine,
    VatHandle handle,
    const std::string& clip,
    std::optional<double> offset,
    std::optional<double> fps);
void vat_update(
    Engine& engine,
    VatHandle handle,
    double delta_seconds);
void vat_set_instances(
    Engine& engine,
    VatHandle handle,
    const std::vector<float>& params);
// `baked.clips[name]`: the clip's row block. A name the bake does not
// carry answers with a zero `frame_count`, which is the miss every
// optional read in this port already reports through.
VatClipRow vat_clip_row(
    Engine& engine,
    VatBake baked,
    const std::string& clip);
// This port's deterministic-pose entry point for a baked mesh, standing
// for the frozen `play(clip, {offset: round(t*60), fps: 0})` the browser
// harness drives scene 218 into through its ?seekTime query.
void seek_vat(Engine& engine, float seconds);
void set_animation_loop(
    Engine& engine,
    AnimationGroupHandle group,
    bool loop);
void set_animation_speed_ratio(
    Engine& engine,
    AnimationGroupHandle group,
    float speed_ratio);
void set_animation_mask(
    Engine& engine,
    AnimationGroupHandle group,
    const std::vector<std::string>& names,
    bool include);
void set_animation_current_time(
    Engine& engine,
    AnimationGroupHandle group,
    float time);
void set_animation_additive(
    Engine& engine,
    AnimationGroupHandle group,
    float reference_time);
void set_animation_additive_from_frame(
    Engine& engine,
    AnimationGroupHandle group,
    float reference_frame);
void attach_control(Engine& engine, CameraHandle camera);
void write_camera_scalar(CameraRecord& camera, double CameraRecord::*field, double value);
void write_camera_vector_component(CameraRecord& camera, Vec3d CameraRecord::*vector,
    double Vec3d::*component, double value);
void set_camera_vector(CameraRecord& camera, Vec3d CameraRecord::*vector, Vec3d value);
void set_camera_limits(
    Engine& engine,
    CameraHandle camera,
    std::uint32_t present_mask,
    const std::array<double, 6>& limits);
void attach_free_control(Engine& engine, CameraHandle camera);
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
#include <bblite/runtime/sprite-options.hpp>
#endif

// `attachParsedSplat`'s two halves, which the pin keeps apart and this port
// needs apart for the same reason it does: a cloud is BUILT against the
// engine (`createGaussianSplattingMesh`) and REGISTERED against a scene
// (`attachGaussianSplattingMesh`). `loadSplat` performs both at its call
// site; a glTF's `KHR_gaussian_splatting` clouds are built while the file
// loads and registered when `addToScene` runs the container's scene hook.
SplatMeshHandle create_gaussian_splatting_mesh(
    Engine& engine,
    const std::string& name,
    std::vector<std::uint8_t> rows);
void attach_gaussian_splatting_mesh(Scene& scene, SplatMeshHandle splat);
SplatMeshHandle load_splat(Scene& scene, const std::string& path);
js::ArrayBuffer splat_data(const Engine& engine, SplatMeshHandle splat);
void update_splat_data(Engine& engine, SplatMeshHandle splat, const js::ArrayBuffer& buffer);
// `loadSPZ` and `loadSOG`, the pin's second and third splat entry points.
// Each container is loaded at generation exactly as `loadSplat`'s is, so what
// is left of either here is `load_splat` plus the one lane it writes on the
// cloud it attached. Each is defined by the generated splat loader only for a
// scene that reached it.
SplatMeshHandle load_spz(Scene& scene, const std::string& path);
SplatMeshHandle load_sog(Scene& scene, const std::string& path);
// Bakes a cloud's own world matrix into its rows, rebuilds its geometry and
// resets its TRS. Defined by the generated splat bake, which a scene reaches
// through `bakeCurrentTransformIntoVertices`.
void bake_current_transform_into_vertices(
    Engine& engine,
    SplatMeshHandle splat);
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
#include <bblite/runtime/sprite-api.hpp>
#endif

/**
 * The sampler overrides `createTexture2DFromPixels` accepts.
 *
 * Each field carries a "was it named" flag rather than a default, because
 * upstream resolves `options.x ?? default` inside the factory itself — so
 * the defaults live in the generated factory, read off the pin's own
 * expression, and nothing here restates one. `srgb` is a format bit rather
 * than sampler state, and defaults to the pin's false.
 */
struct PixelsTextureOptions {
    TextureFilter min_filter{};
    bool has_min_filter = false;
    TextureFilter mag_filter{};
    bool has_mag_filter = false;
    TextureAddressMode address_u{};
    bool has_address_u = false;
    TextureAddressMode address_v{};
    bool has_address_v = false;
    bool srgb = false;
};

PixelsTexture create_texture_2d_from_pixels(
    Engine& engine,
    const std::string& path,
    double width,
    double height,
    PixelsTextureOptions options = {});
void update_pixels_texture(
    Engine& engine,
    PixelsTexture& texture,
    const js::U8Array& pixels);
PixelsTexture create_texture_2d_from_pixels(
    Engine& engine,
    const js::U8Array& pixels,
    double width,
    double height,
    PixelsTextureOptions options = {});

#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
double add_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer,
    Sprite2DProps props);
void update_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer,
    double index,
    Sprite2DProps props);
void clear_sprite_2d_layer(
    Engine& engine,
    Sprite2DLayerHandle layer);
/** The handle family: a stable id over the moving index above. */
double add_sprite_2d(
    Engine& engine,
    Sprite2DLayerHandle layer,
    Sprite2DProps props);
double sprite_2d_handle_index(
    const Engine& engine,
    Sprite2DLayerHandle layer,
    std::uint32_t sprite_id);
void update_sprite_2d_id(
    Engine& engine,
    Sprite2DLayerHandle layer,
    std::uint32_t sprite_id,
    Sprite2DProps props);
/**
 * sprite-2d-y-sort.ts: enable the layer's optional GPU-order permutation and
 * register the one lazy hook the rest of the sprite path reaches it through.
 * The layer handle is what `enableSprite2DYSort` returns state for, so it is
 * also what the state's own live reads are keyed by here.
 */
Sprite2DLayerHandle enable_sprite_2d_y_sort(
    Engine& engine,
    Sprite2DLayerHandle layer,
    double default_bias);
bool sprite_2d_y_sort_enabled(
    const Engine& engine,
    Sprite2DLayerHandle layer);
void set_sprite_2d_y_sort_bias_id(
    Engine& engine,
    Sprite2DLayerHandle layer,
    std::uint32_t sprite_id,
    double bias);
void set_sprite_2d_frame_id(
    Engine& engine,
    Sprite2DLayerHandle layer,
    std::uint32_t sprite_id,
    double frame);
void remove_sprite_2d_id(
    Engine& engine,
    Sprite2DLayerHandle layer,
    std::uint32_t sprite_id);
bool sprite_2d_id_alive(
    const Engine& engine,
    Sprite2DLayerHandle layer,
    std::uint32_t sprite_id);
#endif

EffectWrapperHandle create_effect_wrapper(
    Engine& engine,
    std::uint32_t variant);
void set_effect_uniforms(
    Engine& engine,
    EffectWrapperHandle effect,
    const std::vector<float>& values);
void set_effect_texture(
    Engine& engine,
    EffectWrapperHandle effect,
    const std::string& name,
    SolidTexture texture);
EffectRendererHandle create_effect_renderer(
    Engine& engine,
    EffectWrapperHandle effect,
    EffectRendererOptions options);
void register_effect_renderer(
    Engine& engine,
    EffectRendererHandle renderer);
TaskHandle create_effect_render_task(
    Engine& engine,
    EffectTaskOptions options);
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
SpriteRendererHandle create_sprite_renderer(
    Engine& engine,
    SpriteRendererOptions options);
void add_sprite_renderer_layer(
    Engine& engine,
    SpriteRendererHandle renderer,
    Sprite2DLayerHandle layer);
bool remove_sprite_renderer_layer(
    Engine& engine,
    SpriteRendererHandle renderer,
    Sprite2DLayerHandle layer);
void dispose_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer);
void unregister_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer);
void register_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer);
/** `renderer._beforeUpdate.push`: one per-frame hook of the renderer's own. */
void sprite_renderer_before_update(
    Engine& engine,
    SpriteRendererHandle renderer,
    std::function<void(double)> callback);
/**
 * sprite-2d.ts `_setSprite2DCount` / `_markSprite2DDirty`: the two
 * internals the pure-2D particle bridge writes a layer's whole live range
 * through, exported by the pin for exactly that caller.
 */
void set_sprite_2d_count(Sprite2DLayerRecord& layer, std::uint32_t count);
void mark_sprite_2d_dirty(
    Sprite2DLayerRecord& layer,
    std::uint32_t lo,
    std::uint32_t hi);

#endif

void register_scene(Scene& scene);
void unregister_scene(Scene& scene);
void dispose_scene(Scene& scene);
void rebuild_scene_renderables(Scene& scene);
void on_frame_graph_update(
    FrameGraphContext& context,
    js::Callback<void(float)> callback);
void register_frame_graph_context(FrameGraphContext& context);
/**
 * `registerSceneWithShadowSupport`: the ordinary registration plus the
 * scene-owned shadow task, which the pin installs ahead of the render task
 * the scene already carries. Upstream keeps the two entry points apart so an
 * ordinary bundle retains no shadow scheduling code at all.
 */
void register_scene_with_shadow_support(Scene& scene);
void enable_scene_transmission(Scene& scene);
void run_pbr_scene_hooks(Scene& scene, const std::vector<MeshHandle>& meshes);
std::optional<bool> run_pbr_rebuild_transaction(Scene& scene, const std::vector<MeshHandle>& meshes,
    bool (*builder)(Scene&, const std::vector<MeshHandle>&));
void set_mesh_material(Engine& engine, MeshHandle mesh, MaterialHandle material);
void set_pbr_gamma_albedo(Engine& engine, MaterialHandle material);
void load_image_skybox(
    Scene& scene,
    std::array<std::string, 6> face_paths,
    float size);
void set_scene_fog(
    Scene& scene,
    float mode,
    float density,
    float start,
    float end,
    Color3 color);
void set_scene_clip_plane(Scene& scene, Vec4 plane);
void start_engine(Engine& engine);
/** `stopEngine`: no further frame submits. */
void stop_engine(Engine& engine);
/** `setTimeout(callback, 0)`; see `Engine::deferred_callbacks`. */
void defer_callback(Engine& engine, std::function<void()> callback);
/** Source following `await startEngine`, completed after the initial render. */
void defer_start_continuation(
    Engine& engine,
    std::function<void()> callback);
/**
 * The same continuation, held at frame boundaries until `resolved` answers
 * yes: source following an `await` on a promise a scene callback resolves.
 */
void defer_start_continuation_until(
    Engine& engine,
    std::function<bool()> resolved,
    std::function<void()> callback);
/** Browser `setTimeout` with a real delay, serviced by the frame conductor. */
double set_timeout(
    Engine& engine,
    std::function<void()> callback,
    double delay_ms);
/** Browser `clearTimeout`; an unknown id is a no-op. */
void clear_timeout(Engine& engine, double id);
/** Browser `setInterval`; callbacks are serviced by the frame conductor. */
double set_interval(
    Engine& engine,
    std::function<void()> callback,
    double period_ms);
/** Browser `clearInterval`. */
void clear_interval(Engine& engine, double id);

/** src/scene/set-parent.ts setParent for the reached scene hierarchy. */
void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    MeshHandle parent);
void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    TransformNodeHandle parent);
void set_asset_root_parent(
    Engine& engine,
    AssetHandle child,
    TransformNodeHandle parent);
/** src/scene/visibility.ts setMeshVisible cascade. */
void set_mesh_visible(
    Engine& engine,
    MeshHandle mesh,
    bool visible);
[[nodiscard]] std::vector<float> mesh_cpu_positions(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] std::vector<float> mesh_cpu_normals(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] std::vector<float> mesh_cpu_uvs(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] std::vector<std::uint32_t> mesh_cpu_indices(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] js::Array<double> mesh_world_matrix_array(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] js::Array<double> mesh_bound_min_array(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] js::Array<double> mesh_bound_max_array(
    const Engine& engine,
    MeshHandle mesh);

#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
/** `createGpuPicker(scene)`. */
GpuPickerHandle create_gpu_picker(Scene& scene);
/** `PickingInfo.pickedMesh.name`, read where the scene asks for it. */
[[nodiscard]] std::string picked_node_name(
    const Engine& engine,
    const PickingInfo& info);
[[nodiscard]] std::string picked_node_name(const PickingInfo& info);
/** A picked scene node asserted to the pinned `Mesh` type. */
[[nodiscard]] MeshHandle picked_mesh(const PickingInfo& info);
/** The basic pick's nullable world point in the plain-data model. */
[[nodiscard]] js::Nullable<js::Tuple<3>> picked_point(
    const PickingInfo& info);
/** Populate basic picking's world-space `pickedPoint` from its depth lane. */
void populate_picked_point(
    PickingInfo& info,
    const std::array<float, 16>& view_projection,
    double sample_x,
    double sample_y,
    double width,
    double height,
    float depth);
/**
 * `createPickingRay(x, y, vp, w, h)` over the pick's own sample, which
 * only a detailed pick asks for. Emitted with the detailed half.
 */
void populate_pick_ray(
    PickingInfo& info,
    const std::array<float, 16>& view_projection,
    double sample_x,
    double sample_y,
    double width,
    double height);
/** `pickAsync(picker, x, y)`, resolved before the call returns. */
PickingInfo gpu_pick(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y);
/** The same pick under the pin's `filter` option; see `Engine::PickFilter`. */
PickingInfo gpu_pick(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y,
    const Engine::PickFilter& filter);
#endif
/**
 * `KHR_interactivity` (the generated flow-graph unit). The loader chains
 * `attach_flow_graphs` onto an interactive asset's scene setup, and
 * `enableFlowGraphPointerPicking` arms the canvas bridge that turns a
 * primary-button tap into a filtered pick and an `event/onSelect`.
 */
void attach_flow_graphs(Scene& scene, AssetHandle asset, const std::string& asset_name);
void enable_flow_graph_pointer_picking(Scene& scene);
/**
 * An interactive asset's node and material accessors, owned by the
 * generated glTF loader beside the tables they read: a node's visibility
 * through the pin's subtree cascade (`scene/visibility.ts`
 * `setSubtreeVisible`), and the base-colour texture transform a
 * `KHR_texture_transform` pointer reads and writes (`path-converter.ts`).
 */
bool gltf_node_visible(const Engine& engine, AssetHandle asset, std::size_t node);
void set_gltf_node_visible(Engine& engine, AssetHandle asset, std::size_t node, bool visible);
TextureTransform& gltf_base_color_transform(Engine& engine, AssetHandle asset, std::size_t material);
#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
/**
 * `enableDetailedPicking(picker)`. Emitted with the detailed half; every
 * later pick on this picker draws the third attachment.
 */
void enable_detailed_picking(Engine& engine, GpuPickerHandle picker);
/**
 * `getPickedNormal(info, useWorldCoordinates)`. Emitted with the detailed
 * half, because it is the only pipeline that fills what it reads.
 */
[[nodiscard]] js::Nullable<js::Tuple<3>> picked_normal(
    const Engine& engine,
    const PickingInfo& info,
    bool use_world_coordinates);
[[nodiscard]] js::Nullable<js::Tuple<3>> picked_normal(
    const PickingInfo& info,
    bool use_world_coordinates);
/** `disposePicker(picker)`. */
void dispose_picker(Engine& engine, GpuPickerHandle picker);
/**
 * `pickBillboardSprite(scene, x, y)`: the same pass through a picker the
 * wrapper makes and disposes itself. Emitted only where a scene reached it.
 */
PickingInfo pick_billboard_sprite(
    Engine& engine,
    Scene& scene,
    double x,
    double y);
/** `PickingInfo.distance`: camera position to the reconstructed point. */
[[nodiscard]] double picked_distance(
    const Scene& scene,
    const PickingInfo& info);
#endif
/**
 * Run and clear everything `setTimeout` queued. Called by the frame
 * conductor after the frame's own callbacks, which is where the browser
 * runs a zero-delay timeout: after the current turn, before the next
 * frame. A callback that queues another is served on the following
 * frame rather than in this drain, exactly as it would be in a browser.
 */
void run_deferred_callbacks(Engine& engine);
/** Run one-shot callbacks due at this frame boundary. */
void run_timeout_callbacks(Engine& engine);
/** Run recurring callbacks due at this frame boundary. */
void run_interval_callbacks(Engine& engine);

} // namespace bbl

#if !defined(BBLITE_HAS_PICKING) || BBLITE_HAS_PICKING
template <>
struct std::hash<bbl::PickingInfo> {
    [[nodiscard]] std::size_t operator()(const bbl::PickingInfo& info) const noexcept {
        return std::hash<const void*>{}(info.state.get());
    }
};
#endif
