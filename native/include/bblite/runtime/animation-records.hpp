#pragma once
// Included within namespace bbl by runtime.hpp.

struct PropertyAnimationManagerRecord;
struct AnimationGroupOrder {
    std::weak_ptr<PropertyAnimationManagerRecord> manager;
    double order = 0;
};
struct GltfWeightedAnimationRuntimeState;

enum class PropertyAnimationPath {
    position,
    scaling,
    rotation_quaternion,
    camera_alpha,
    record_scalar,
};

/**
 * Which part of its lane a track writes. `whole_lane` is the path that
 * names the lane itself, which `createPropertyWriter` stores through the
 * value's own `set`; the rest name one component, in the pin's own
 * `"xyzw"` order.
 */
enum class PropertyAnimationComponent {
    whole_lane,
    x,
    y,
    z,
    w,
};

/**
 * What a property clip is bound to. Upstream resolves a dotted path
 * against whatever object the caller passed, so the target and the path
 * travel together. Mesh and camera handles use their native lane writers;
 * data objects and accessor records retain scalar callback writers.
 */
enum class PropertyAnimationTargetKind {
    mesh,
    camera,
    callback,
};

struct PropertyAnimationIdentity {
    const void* key = nullptr;
    js::Callback<void()> owner;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(owner); }
};

template <class Owner> struct PropertyAnimationIdentityOwner {
    Owner value;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(value); }
};

template <class Owner> PropertyAnimationIdentity property_animation_identity(Owner owner) {
    const auto* key = owner.get();
    return {key, js::make_closure(PropertyAnimationIdentityOwner<Owner>{std::move(owner)},
                                 [](PropertyAnimationIdentityOwner<Owner>&) {})};
}

struct PropertyAnimationTarget {
    PropertyAnimationTargetKind kind = PropertyAnimationTargetKind::mesh;
    /**
     * A `mesh` target's mesh. The pin keeps animating a mesh
     * `removeFromScene` disposed; the handle's generation leaves a later
     * mesh in its slot unwritten (`current_mesh_record`).
     */
    MeshHandle mesh{};
    /** A `camera` target's camera, or a `callback` target's setter identity. */
    std::uint32_t index = 0;
    // The pinned writer stores one Float32Array sample lane
    // (`target[property] = output[offset]`, property-animation.ts).
    js::Callback<void(float)> write_scalar;
    // Plain-data writers retain the root and resolve the current owner.
    // The mixer keys the pin's resolved (object, property) pair.
    const void* object_identity = nullptr;
    std::string property{};
    js::Callback<PropertyAnimationIdentity()> resolve_object_identity;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(write_scalar);
        visitor(resolve_object_identity);
    }
};

enum class PropertyAnimationInterpolation {
    linear,
    step,
};

/**
 * One key as `createSampler` stores it: the time into the sampler's
 * Float32Array `input`, the value lanes into its Float32Array `output`
 * (property-animation.ts), so both are float here too. Everything the
 * clock and the mixers compute around them is a JavaScript number.
 */
struct PropertyAnimationKey {
    float time = 0.0f;
    std::array<float, 4> value{};
};

struct PropertyAnimationTrack {
    PropertyAnimationPath path = PropertyAnimationPath::position;
    PropertyAnimationComponent component = PropertyAnimationComponent::whole_lane;
    PropertyAnimationInterpolation interpolation = PropertyAnimationInterpolation::linear;
    /**
     * `createPropertyAnimationClip`'s own rotation-channel derivation,
     * which is what `evaluateSampler` slerps on — the path decides it
     * there too, but the flag is what the evaluator reads.
     */
    bool quaternion = false;
    std::vector<PropertyAnimationKey> keys;
};

struct PropertyAnimationClip {
    std::string name;
    std::vector<PropertyAnimationTrack> tracks;
    double duration = 0.0;
    double frame_rate = 60.0;
};

struct PropertyAnimationGroupRecord {
    std::vector<PropertyAnimationTarget> targets;
    PropertyAnimationClip clip;
    double from_time = 0.0;
    double to_time = 0.0;
    double current_time = 0.0;
    double speed_ratio = 1.0;
    bool loop = true;
    bool playing = true;
    bool stopped = false;
    /** `AnimationGroup.weight`: the mixer's contribution, default 1. */
    double weight = 1.0;
    std::weak_ptr<PropertyAnimationManagerRecord> animation_owner;
    AnimationGroupOrder animation_order;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(targets); }
};

using PropertyAnimationGroup = std::shared_ptr<PropertyAnimationGroupRecord>;

/** A property or glTF group whose public weight a fade job updates. */
enum class AnimationWeightFadeTargetKind {
    property,
    gltf,
};

struct AnimationWeightFadeTarget {
    AnimationWeightFadeTargetKind kind = AnimationWeightFadeTargetKind::property;
    PropertyAnimationGroup property_group;
    AnimationGroupHandle gltf_group{};
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(property_group); }

    static AnimationWeightFadeTarget from_property(PropertyAnimationGroup group) {
        AnimationWeightFadeTarget target;
        target.property_group = std::move(group);
        return target;
    }

    static AnimationWeightFadeTarget from_gltf(AnimationGroupHandle group) {
        AnimationWeightFadeTarget target;
        target.kind = AnimationWeightFadeTargetKind::gltf;
        target.gltf_group = group;
        return target;
    }
};

using AnimationGroupReference = AnimationWeightFadeTarget;

/**
 * One manager-owned weight tween. The fade scheduler is a pre-update
 * phase, separate from the category mixer which consumes the resulting
 * weights; enabling a property or glTF mixer therefore remains explicit.
 */
struct PropertyAnimationWeightFade {
    AnimationWeightFadeTarget target;
    double from = 0.0;
    double to = 0.0;
    double duration_ms = 0.0;
    double elapsed_ms = 0.0;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(target); }
};

/**
 * One blended property, the pin's own weighted-mixer bucket. Upstream
 * keys it by the (object, property name) pair each runtime track
 * resolved; a lowered track names the same pair as its target, its lane
 * and the component of it the path selected — `position` lands on the
 * mesh while `position.x` lands on the position vector, so the two are
 * distinct pairs there and distinct keys here. How wide the bucket is
 * follows from the same triple, which is why the pin's mismatched-arity
 * throw has nothing to catch on this side.
 */
struct PropertyAnimationBucket {
    PropertyAnimationTarget target{};
    PropertyAnimationIdentity resolved_identity;
    PropertyAnimationPath property = PropertyAnimationPath::position;
    PropertyAnimationComponent component = PropertyAnimationComponent::whole_lane;
    /** The pin's `values: new F32(arity)` (weighted-pointer-mixer.ts). */
    std::array<float, 4> values{};
    /** The track's own rotation-channel flag, as the pin's bucket keeps it. */
    bool quaternion = false;
    bool contested = false;
    bool active = false;
    bool has_reference = false;
    double total_weight = 0;
    /** `refX`..`refW`, JavaScript numbers. */
    std::array<double, 4> reference{0.0, 0.0, 0.0, 1.0};
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(target); visitor(resolved_identity); }
};

/**
 * Which handler a manager's animation-group category has installed.
 * `setAnimationTaskCategoryHandler` keeps one slot, so the second opt-in
 * replaces the first rather than composing with it.
 */
enum class AnimationCategoryHandler {
    none,
    property_mixer,
    gltf_mixer,
};

struct Engine;
using AnimationManagerPreUpdate =
    std::function<void(Engine&, PropertyAnimationManagerRecord&, double)>;

struct PropertyAnimationManagerRecord {
    /** The engine inferred from the first attached group or scene. */
    Engine* engine = nullptr;
    /** Source options.engine presence; host association alone does not supply it. */
    bool source_engine_present = false;
    std::vector<PropertyAnimationGroup> groups;
    /** Source _animationGroups order, including property and glTF groups. */
    std::vector<AnimationGroupReference> ordered_groups;
    double next_group_order = 0;
    /** Scheduled by crossFadeAnimationGroups, advanced before the mixer. */
    std::vector<PropertyAnimationWeightFade> weight_fades;
    /** The pin's one stable pre-update slot and the hook it preserves. */
    AnimationManagerPreUpdate pre_update;
    AnimationManagerPreUpdate prior_weight_fade_pre_update;
    /**
     * The glTF groups `addAnimationGroups` attached, in attach order.
     * Upstream keeps them in the manager's own `_animationGroups` list and
     * ticks each through its controller; the clips themselves live in the
     * owning asset's runtime, so the handle is what travels here.
     */
    std::vector<AnimationGroupHandle> gltf_groups;
    bool started = false;
    double fixed_delta_ms = 0.0;
    double last_time_ms = 0.0;
    js::Callback<void(double)> on_update;
    std::size_t animation_frame_request = 0;
    /** Installed by `enablePropertyAnimationBlending` / `enableAnimationBlending`. */
    AnimationCategoryHandler category_handler = AnimationCategoryHandler::none;
    /** The mixers' per-manager scratch, upstream's `scratchByManager`. */
    std::vector<PropertyAnimationBucket> buckets;
    std::shared_ptr<GltfWeightedAnimationRuntimeState> source_gltf_animation;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(groups);
        visitor(ordered_groups);
        visitor(weight_fades);
        visitor(buckets);
        visitor(on_update);
    }
};

using PropertyAnimationManager = std::shared_ptr<PropertyAnimationManagerRecord>;

struct PropertyAnimationManagerOptions {
    double fixed_delta_ms = 0.0;
    js::Callback<void(double)> on_update;
    /** Overrides host inference when source options.engine was absent. */
    std::optional<bool> source_engine_present;
};

struct PropertyAnimationGroupOptions {
    double from_time = 0.0;
    double to_time = 0.0;
    double speed_ratio = 1.0;
    bool loop = true;
};
