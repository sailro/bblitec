#pragma once
// Included within namespace bbl by runtime.hpp.

enum class PickedNodeKind : std::uint8_t {
    none,
    mesh,
    splat_mesh,
    // A billboard sprite is not a node at all: the pin leaves
    // `pickedMesh` null for it and hangs a `_spritePick` payload on the
    // info instead, which is what `pickBillboardSprite` reads back.
    billboard_sprite,
};

/**
 * The pin's `Ray`, which only a DETAILED pick produces
 * (`gpu-picker.ts`: `info.ray = detailed ? pickRay : null`). The pin's
 * `createPickingRay` is what fills it, and the detailed CPU solve reads
 * its direction to decide whether a surface normal faces the pick.
 */
struct PickRay {
    std::array<double, 3> origin{};
    std::array<double, 3> direction{};
    double length = 0.0;
};

/**
 * What the detailed pass read out of its third attachment, before the
 * pin's CPU solve runs over it.
 *
 * Transport between the backend's one-pixel pass and the generated
 * continuation: the backend owns the readback and the space its vertex
 * stream was in, and `populateDetailedMeshInfo` -- which is Babylon
 * behaviour and therefore generated -- owns everything derived from it.
 */
struct PickDetailReadback {
    /** `@builtin(primitive_index)` of the winning fragment, -1 on a miss. */
    double primitive_index = -1.0;
    /** The interpolated vertex position, in the space the pass drew. */
    std::array<double, 3> point{};
    /**
     * The winning mesh's DRAW-TIME world, which upstream snapshots with
     * `copyDetailedWorldMatrix` before the asynchronous readback for the
     * same reason it is carried here: the scene may move the mesh between
     * the pick and the read.
     */
    std::array<float, 16> world{};
    /**
     * Whether `point` arrived in WORLD space rather than the mesh's own.
     *
     * The pin's pick vertex stage forwards the raw local position, and so
     * does this port's -- but an ordinary mesh's vertex buffer is baked to
     * world here (`transformed_vertices`, the contract in
     * `fidelity.md`'s picking section), so the varying comes back world-
     * space and the continuation maps it back through `world` before the
     * pin's rest-space solve. A mesh whose transform travels as a matrix
     * instead needs no map, and clears this.
     */
    bool world_baked = false;
};

/**
 * The pin's `PickingInfo`, at the slice this port resolves.
 *
 * WHAT WAS HIT, the basic pipeline's reconstructed world point, and the
 * detailed pipeline's own members -- the exact primitive, its barycentric
 * weights and the four normals `populateDetailedMeshInfo` derives.
 * `subMeshId` and `thinInstanceIndex` belong to pipelines this port does
 * not reach and remain outside this record.
 */
struct Engine;
struct PickingInfoState {
    Engine* engine = nullptr;
    std::weak_ptr<const int> engine_lifetime;
    bool hit = false;
    /**
     * WHICH node was hit. Upstream `pickedMesh` is a live reference and
     * `.name` reads it at the moment the scene asks, so the identity is
     * what the pick resolves and the name is read through it -- a scene
     * that picks, renames the node and then reads would otherwise get the
     * name the node had at pick time.
     */
    PickedNodeKind picked_kind = PickedNodeKind::none;
    std::uint32_t picked_index = invalid_handle;
    /**
     * The read-back id's offset inside the range its candidate owns --
     * upstream's `pickId - r.base`, the local id it hands the resolving
     * contributor. A mesh or a cloud owns one id and reads zero here; a
     * billboard system owns `count` of them (`pick-contributor.ts`:
     * "nextId - baseId is the id count this contributor owns"), so this
     * is the sprite's own slot within the system `picked_index` names.
     */
    std::uint32_t picked_range_offset = 0;
    std::optional<std::array<double, 3>> picked_point{};
    /**
     * `createEmptyPickingInfo`'s own detailed defaults: `faceId` is -1
     * ("no primitive"), the weights are zero and every normal is null.
     * A basic pick leaves all of them, which is exactly what upstream's
     * empty record carries when `populateDetailedMeshInfo` never runs.
     */
    double face_id = -1.0;
    double bu = 0.0;
    double bv = 0.0;
    std::optional<PickRay> ray{};
    std::optional<std::array<double, 3>> picked_normal{};
    std::optional<std::array<double, 3>> picked_normal_world{};
    std::optional<std::array<double, 3>> picked_face_normal{};
    std::optional<std::array<double, 3>> picked_face_normal_world{};
    /** The pin's `_normalsInvalid`: a custom vertex world adjustment left
     *  the primitive and weights valid while invalidating CPU normals. */
    bool normals_invalid = false;
    /** The third attachment's readback, on the pick that had one. */
    std::optional<PickDetailReadback> detail{};
};

/** Copies retain the same JavaScript result; each default construction is fresh.
 * Numeric/point payloads remain readable after engine teardown, while queries
 * through a picked mesh require the original engine wrapper to remain alive. */
struct PickingInfo {
    std::shared_ptr<PickingInfoState> state;
    bool& hit;
    PickedNodeKind& picked_kind;
    std::uint32_t& picked_index;
    std::uint32_t& picked_range_offset;
    std::optional<std::array<double, 3>>& picked_point;
    double& face_id;
    double& bu;
    double& bv;
    std::optional<PickRay>& ray;
    std::optional<std::array<double, 3>>& picked_normal;
    std::optional<std::array<double, 3>>& picked_normal_world;
    std::optional<std::array<double, 3>>& picked_face_normal;
    std::optional<std::array<double, 3>>& picked_face_normal_world;
    bool& normals_invalid;
    std::optional<PickDetailReadback>& detail;

    PickingInfo() : PickingInfo(std::make_shared<PickingInfoState>()) {}
    // Copying binds references into a shared state and copies its owner,
    // neither of which can throw; the assignment operators below rely on
    // that, since they destroy and re-place this object.
    PickingInfo(const PickingInfo& other) noexcept : PickingInfo(other.state) {}
    PickingInfo(PickingInfo&& other) noexcept : PickingInfo(std::move(other.state)) {}
    PickingInfo& operator=(const PickingInfo& other) {
        if (this != &other) {
            this->~PickingInfo();
            new (this) PickingInfo(other);
        }
        return *this;
    }
    PickingInfo& operator=(PickingInfo&& other) noexcept {
        if (this != &other) {
            this->~PickingInfo();
            new (this) PickingInfo(std::move(other));
        }
        return *this;
    }
    [[nodiscard]] bool operator==(const PickingInfo& other) const noexcept {
        return state == other.state;
    }
    void bind_engine(Engine& engine);

private:
    explicit PickingInfo(std::shared_ptr<PickingInfoState> shared)
        : state(std::move(shared)),
          hit(state->hit),
          picked_kind(state->picked_kind),
          picked_index(state->picked_index),
          picked_range_offset(state->picked_range_offset),
          picked_point(state->picked_point),
          face_id(state->face_id),
          bu(state->bu),
          bv(state->bv),
          ray(state->ray),
          picked_normal(state->picked_normal),
          picked_normal_world(state->picked_normal_world),
          picked_face_normal(state->picked_face_normal),
          picked_face_normal_world(state->picked_face_normal_world),
          normals_invalid(state->normals_invalid),
          detail(state->detail) {}
};
// The destroy-then-place assignment operators above are only sound while a
// copy cannot throw between the destruction and the placement.
static_assert(std::is_nothrow_copy_constructible_v<PickingInfo>);
static_assert(std::is_nothrow_move_constructible_v<PickingInfo>);

[[nodiscard]] inline Engine& picking_engine(const PickingInfo& info) {
    if (!info.state->engine || info.state->engine_lifetime.expired()) {
        throw std::runtime_error(
            "PickingInfo mesh queries require the original live engine; "
            "queries after engine destruction or relocation are unsupported.");
    }
    return *info.state->engine;
}
