import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class AnimationLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerPropertyAnimation(): LoweredSource {
        const propertyModule = "src/animation/property-animation.ts";
        const managerModule = "src/animation/animation-manager.ts";
        const groupModule = "src/animation/animation-group.ts";
        const evaluateModule = "src/animation/evaluate.ts";
        this.context.functionDeclaration(
            propertyModule,
            "createPropertyAnimationClip",
        );
        this.context.functionDeclaration(
            propertyModule,
            "createPropertyAnimationGroup",
        );
        this.context.functionDeclaration(
            managerModule,
            "createAnimationManager",
        );
        this.context.functionDeclaration(
            managerModule,
            "startAnimationManager",
        );
        this.context.functionDeclaration(
            groupModule,
            "goToFrame",
        );
        const { declaration: evaluateSampler } =
            this.context.functionDeclaration(
                evaluateModule,
                "evaluateSampler",
            );
        if (
            !this.context.hasNode(
                evaluateSampler,
                (node) =>
                    ts.isIdentifier(node) &&
                    node.text === "INTERP_STEP",
            )
        ) {
            this.context.contractError(
                evaluateSampler,
                "Expected STEP interpolation handling.",
            );
        }
        if (
            !this.context.hasCall(
                evaluateSampler,
                "quatSlerp",
            )
        ) {
            this.context.contractError(
                evaluateSampler,
                "Expected quaternion slerp interpolation.",
            );
        }

        return {
            modulePath: propertyModule,
            symbolName:
                "createAnimationManager,createPropertyAnimationClip,createPropertyAnimationGroup,startAnimationManager,goToFrame",
            header: "",
            source: `// ${this.context.provenance(
                propertyModule,
                "property animation manager, clips, groups, interpolation, and seeking",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl {
namespace {

std::array<float, 4> normalized_quaternion(
    std::array<float, 4> value) {
    const float length = std::sqrt(
        value[0] * value[0] +
        value[1] * value[1] +
        value[2] * value[2] +
        value[3] * value[3]);
    if (length <= 0.0f) {
        return {0.0f, 0.0f, 0.0f, 1.0f};
    }
    for (float& component : value) component /= length;
    return value;
}

std::array<float, 4> slerp_quaternion(
    std::array<float, 4> left,
    std::array<float, 4> right,
    float amount) {
    float dot =
        left[0] * right[0] +
        left[1] * right[1] +
        left[2] * right[2] +
        left[3] * right[3];
    if (dot < 0.0f) {
        for (float& component : right) component = -component;
        dot = -dot;
    }
    if (dot > 0.9995f) {
        std::array<float, 4> result{};
        for (std::size_t index = 0; index < result.size(); ++index) {
            result[index] =
                left[index] +
                (right[index] - left[index]) * amount;
        }
        return normalized_quaternion(result);
    }
    dot = std::clamp(dot, -1.0f, 1.0f);
    const float theta = std::acos(dot);
    const float sin_theta = std::sin(theta);
    const float left_weight =
        std::sin((1.0f - amount) * theta) / sin_theta;
    const float right_weight =
        std::sin(amount * theta) / sin_theta;
    std::array<float, 4> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] =
            left[index] * left_weight +
            right[index] * right_weight;
    }
    return result;
}

std::array<float, 4> evaluate_track(
    const PropertyAnimationTrack& track,
    float time) {
    if (track.keys.empty()) {
        throw std::runtime_error(
            "Property animation track has no keys.");
    }
    if (
        track.keys.size() == 1 ||
        time <= track.keys.front().time) {
        return track.keys.front().value;
    }
    if (time >= track.keys.back().time) {
        return track.keys.back().value;
    }
    std::size_t right = 1;
    while (
        right < track.keys.size() &&
        track.keys[right].time < time) {
        ++right;
    }
    const std::size_t left = right - 1;
    if (
        track.interpolation ==
        PropertyAnimationInterpolation::step) {
        return time >= track.keys[right].time
            ? track.keys[right].value
            : track.keys[left].value;
    }
    const float span =
        track.keys[right].time -
        track.keys[left].time;
    const float amount =
        span > 0.0f
            ? (time - track.keys[left].time) / span
            : 0.0f;
    if (
        track.path ==
        PropertyAnimationPath::rotation_quaternion) {
        return slerp_quaternion(
            track.keys[left].value,
            track.keys[right].value,
            amount);
    }
    std::array<float, 4> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] =
            track.keys[left].value[index] +
            (
                track.keys[right].value[index] -
                track.keys[left].value[index]) *
                amount;
    }
    return result;
}

void apply_group(
    Engine& engine,
    const PropertyAnimationGroup& group) {
    if (!group || group->target.value >= engine.meshes.size()) {
        throw std::runtime_error(
            "Property animation group has an invalid mesh target.");
    }
    MeshRecord& mesh = engine.meshes[group->target.value];
    for (const PropertyAnimationTrack& track :
         group->clip.tracks) {
        const std::array<float, 4> value =
            evaluate_track(track, group->current_time);
        switch (track.path) {
            case PropertyAnimationPath::position:
                mesh.position = Vec3{
                    value[0], value[1], value[2]};
                break;
            case PropertyAnimationPath::position_x:
                mesh.position.x = value[0];
                break;
            case PropertyAnimationPath::scaling:
                mesh.scaling = Vec3{
                    value[0], value[1], value[2]};
                break;
            case PropertyAnimationPath::rotation_quaternion:
                mesh.rotation_quaternion = Vec4{
                    value[0], value[1], value[2], value[3]};
                mesh.has_rotation_quaternion = true;
                break;
        }
    }
    ++mesh.transform_version;
}

void tick_group(
    Engine& engine,
    const PropertyAnimationGroup& group,
    float delta_ms) {
    if (!group || !group->playing) return;
    group->current_time +=
        delta_ms * 0.001f * group->speed_ratio;
    const float duration =
        group->to_time - group->from_time;
    if (duration <= 0.0f) return;
    if (group->loop) {
        group->current_time =
            group->from_time +
            std::fmod(
                group->current_time - group->from_time,
                duration);
        if (group->current_time < group->from_time) {
            group->current_time += duration;
        }
    } else {
        group->current_time = std::clamp(
            group->current_time,
            group->from_time,
            group->to_time);
    }
    apply_group(engine, group);
}

} // namespace

PropertyAnimationManager create_animation_manager() {
    return std::make_shared<PropertyAnimationManagerRecord>();
}

PropertyAnimationClip create_property_animation_clip(
    std::string name,
    std::vector<PropertyAnimationTrack> tracks,
    float frame_rate) {
    if (tracks.empty()) {
        throw std::runtime_error(
            "createPropertyAnimationClip requires at least one track.");
    }
    if (!(frame_rate > 0.0f)) {
        throw std::runtime_error(
            "Property animation frame rate must be positive.");
    }
    PropertyAnimationClip clip;
    clip.name = std::move(name);
    clip.tracks = std::move(tracks);
    clip.frame_rate = frame_rate;
    for (const PropertyAnimationTrack& track : clip.tracks) {
        if (track.keys.empty()) {
            throw std::runtime_error(
                "Property animation track requires at least one key.");
        }
        clip.duration = std::max(
            clip.duration,
            track.keys.back().time);
    }
    return clip;
}

PropertyAnimationGroup create_property_animation_group(
    PropertyAnimationManager manager,
    MeshHandle target,
    PropertyAnimationClip clip,
    PropertyAnimationGroupOptions options) {
    if (!manager) {
        throw std::runtime_error(
            "Property animation manager is null.");
    }
    if (!(options.to_time > options.from_time)) {
        throw std::runtime_error(
            "Animation play range must have toTime greater than fromTime.");
    }
    auto group =
        std::make_shared<PropertyAnimationGroupRecord>();
    group->target = target;
    group->clip = std::move(clip);
    group->from_time = options.from_time;
    group->to_time = options.to_time;
    group->current_time = options.from_time;
    group->speed_ratio = options.speed_ratio;
    group->loop = options.loop;
    manager->groups.push_back(group);
    return group;
}

void start_animation_manager(
    PropertyAnimationManager manager,
    Scene& scene) {
    if (!manager || !scene.engine) {
        throw std::runtime_error(
            "Animation manager requires a scene engine.");
    }
    if (manager->started) return;
    manager->started = true;
    Engine* engine = scene.engine;
    scene.before_render.push_back(
        [manager, engine](float delta_ms) {
            for (const PropertyAnimationGroup& group :
                 manager->groups) {
                tick_group(*engine, group, delta_ms);
            }
        });
    scene.animation_seekers.push_back(
        [manager, engine](float time) {
            for (const PropertyAnimationGroup& group :
                 manager->groups) {
                if (!group) continue;
                group->current_time = std::clamp(
                    time,
                    group->from_time,
                    group->to_time);
                group->playing = false;
                apply_group(*engine, group);
            }
        });
}

void go_to_frame(
    PropertyAnimationGroup group,
    Engine& engine,
    float frame) {
    if (!group) {
        throw std::runtime_error(
            "Property animation group is null.");
    }
    group->current_time =
        frame / group->clip.frame_rate;
    group->playing = false;
    apply_group(engine, group);
}

} // namespace bbl
`,
        };
    }
}
