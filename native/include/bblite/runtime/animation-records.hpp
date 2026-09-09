#pragma once
// Included within namespace bbl by runtime.hpp.

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

struct PropertyAnimationTarget {
    PropertyAnimationTargetKind kind =
        PropertyAnimationTargetKind::mesh;
    std::uint32_t index = 0;
    js::Callback<void(float)> write_scalar;
    // A plain-data writer retains this owner through its managed closure.
    // The mixer keys the pin's resolved (object, property) pair.
    const void* object_identity = nullptr;
    std::string property{};
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(write_scalar); }
};

enum class PropertyAnimationInterpolation {
    linear,
    step,
};

struct PropertyAnimationKey {
    float time = 0.0f;
    std::array<float, 4> value{};
};

struct PropertyAnimationTrack {
    PropertyAnimationPath path = PropertyAnimationPath::position;
    PropertyAnimationComponent component =
        PropertyAnimationComponent::whole_lane;
    PropertyAnimationInterpolation interpolation =
        PropertyAnimationInterpolation::linear;
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
    float duration = 0.0f;
    float frame_rate = 60.0f;
};

struct PropertyAnimationGroupRecord {
    std::vector<PropertyAnimationTarget> targets;
    PropertyAnimationClip clip;
    float from_time = 0.0f;
    float to_time = 0.0f;
    float current_time = 0.0f;
    float speed_ratio = 1.0f;
    bool loop = true;
    bool playing = true;
    /** `AnimationGroup.weight`: the mixer's contribution, default 1. */
    float weight = 1.0f;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(targets); }
};

using PropertyAnimationGroup =
    std::shared_ptr<PropertyAnimationGroupRecord>;

/** A property or glTF group whose public weight a fade job updates. */
enum class AnimationWeightFadeTargetKind {
    property,
    gltf,
};

struct AnimationWeightFadeTarget {
    AnimationWeightFadeTargetKind kind =
        AnimationWeightFadeTargetKind::property;
    PropertyAnimationGroup property_group;
    AnimationGroupHandle gltf_group{};
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(property_group); }

    static AnimationWeightFadeTarget from_property(
        PropertyAnimationGroup group) {
        AnimationWeightFadeTarget target;
        target.property_group = std::move(group);
        return target;
    }

    static AnimationWeightFadeTarget from_gltf(
        AnimationGroupHandle group) {
        AnimationWeightFadeTarget target;
        target.kind = AnimationWeightFadeTargetKind::gltf;
        target.gltf_group = group;
        return target;
    }
};

/**
 * One manager-owned weight tween. The fade scheduler is a pre-update
 * phase, separate from the category mixer which consumes the resulting
 * weights; enabling a property or glTF mixer therefore remains explicit.
 */
struct PropertyAnimationWeightFade {
    AnimationWeightFadeTarget target;
    float from = 0.0f;
    float to = 0.0f;
    float duration_ms = 0.0f;
    float elapsed_ms = 0.0f;
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
    PropertyAnimationPath property =
        PropertyAnimationPath::position;
    PropertyAnimationComponent component =
        PropertyAnimationComponent::whole_lane;
    std::array<float, 4> values{};
    /** The track's own rotation-channel flag, as the pin's bucket keeps it. */
    bool quaternion = false;
    bool contested = false;
    bool active = false;
    bool has_reference = false;
    std::array<float, 4> reference{
        0.0f, 0.0f, 0.0f, 1.0f};
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(target); }
};

/**
 * One clip a manager blends this tick, as the weighted glTF mixer reads
 * it: which clip of the owning asset, and at what weight. The clip state
 * lives inside the asset's own animation runtime, so the manager hands
 * the list across rather than reaching into it.
 */
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
struct PropertyAnimationManagerRecord;
using AnimationManagerPreUpdate = std::function<void(
    Engine&,
    PropertyAnimationManagerRecord&,
    float)>;

struct PropertyAnimationManagerRecord {
    /** The engine inferred from the first attached group or scene. */
    Engine* engine = nullptr;
    std::vector<PropertyAnimationGroup> groups;
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
    AnimationCategoryHandler category_handler =
        AnimationCategoryHandler::none;
    /** The mixers' per-manager scratch, upstream's `scratchByManager`. */
    std::vector<PropertyAnimationBucket> buckets;
    std::vector<BlendedClip> blend_scratch;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(groups);
        visitor(weight_fades);
        visitor(buckets);
        visitor(on_update);
    }
};

using PropertyAnimationManager =
    std::shared_ptr<PropertyAnimationManagerRecord>;

struct PropertyAnimationManagerOptions {
    double fixed_delta_ms = 0.0;
    js::Callback<void(double)> on_update;
};

struct PropertyAnimationGroupOptions {
    float from_time = 0.0f;
    float to_time = 0.0f;
    float speed_ratio = 1.0f;
    bool loop = true;
};
