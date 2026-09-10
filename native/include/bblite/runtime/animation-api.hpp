#pragma once
// Included within namespace bbl by runtime.hpp.

PropertyAnimationManager create_animation_manager(
    PropertyAnimationManagerOptions options = {});
PropertyAnimationClip create_property_animation_clip(
    std::string name,
    std::vector<PropertyAnimationTrack> tracks,
    float frame_rate);
PropertyAnimationGroup create_property_animation_group(
    PropertyAnimationManager manager,
    Engine& engine,
    std::vector<PropertyAnimationTarget> targets,
    PropertyAnimationClip clip,
    PropertyAnimationGroupOptions options);
void set_animation_weight(
    PropertyAnimationGroup group,
    float weight);
void enable_animation_blending(
    PropertyAnimationManager manager);
void enable_property_animation_blending(
    PropertyAnimationManager manager);
void cross_fade_animation_groups(
    PropertyAnimationManager manager,
    Engine& engine,
    AnimationWeightFadeTarget from_group,
    AnimationWeightFadeTarget to_group,
    float duration_ms,
    float to_weight);
void start_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine);
void stop_animation_manager(PropertyAnimationManager manager);
PropertyAnimationManager create_animation_manager(
    Engine& engine,
    PropertyAnimationManagerOptions options = {});
void add_animation_groups(
    PropertyAnimationManager manager,
    Engine& engine,
    const std::vector<AnimationGroupHandle>& groups);
void update_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine,
    double delta_ms);
bool update_weighted_gltf_animation_groups(
    Engine& engine, PropertyAnimationManagerRecord& manager, double delta_ms);
void tick_animation_group_reference(
    Engine& engine, const AnimationGroupReference& group, double delta_ms);
void seek_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine,
    float time);
void go_to_frame(
    PropertyAnimationGroup group,
    Engine& engine,
    float frame);
void play_animation(PropertyAnimationGroup group);
void pause_animation(PropertyAnimationGroup group);
void stop_animation(PropertyAnimationGroup group);
