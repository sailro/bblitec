#pragma once

#include <bblite/runtime.hpp>
#include <cstring>
#include <stdexcept>

namespace bbl::pal {

/** Borrow task/cache inputs without changing the identities held by the pin. */
template<class Upload>
void prepare_temporal_scene_uniforms(
    FrameTaskRecord& task, Engine& engine, CameraRecord* camera,
    double target_width, double target_height, double canvas_width, double canvas_height,
    Upload&& upload) {
    if (!task.source_scene) throw std::runtime_error("Temporal source has no retained scene.");
    if (!task.scene_uniforms) task.scene_uniforms = upstream::create_persistent_scene_uniforms();
    auto& storage = *task.scene_uniforms;
    if (storage.clean.size() * sizeof(float) != sizeof(upstream::SceneUniforms) ||
        storage.drawn.size() != storage.clean.size()) {
        throw std::runtime_error("Temporal source scene UBO does not match its pinned block layout.");
    }
    const auto scene = Scene::from_state(task.source_scene);
    struct SourceInput {
        SceneUniformCache& cache;
        double width, height;
        bool canvas_size;
    } source{storage.cache, target_width, target_height, task.render.canvas_size};
    struct EngineInput { double width, height; } dimensions{canvas_width, canvas_height};
    struct SceneInput {
        std::uint64_t fog_identity, environment_identity;
        double exposure, contrast;
    } inputs{scene.state->fog_identity, scene.state->environment_identity,
        scene.environment.exposure, scene.environment.contrast};
    upstream::write_pass_scene_ubo(source, dimensions, inputs, camera,
        [](CameraRecord* value) { return upstream::scene_camera_change_key(*value); },
        [&](SourceInput&, double aspect) {
            const auto block = pinned_scene_block(scene, engine, *camera,
                upstream::build_view_projection(*camera, aspect));
            std::memcpy(storage.clean.data(), &block, sizeof(block));
            upload(storage.clean.data(), sizeof(block));
            std::memcpy(storage.drawn.data(), storage.clean.data(), sizeof(block));
        });
}

inline upstream::SceneUniforms temporal_clean_scene_block(const PersistentSceneUniforms& source) {
    upstream::SceneUniforms block{};
    if (source.clean.size() * sizeof(float) != sizeof(block)) {
        throw std::runtime_error("Temporal clean scene UBO does not match its pinned block layout.");
    }
    std::memcpy(&block, source.clean.data(), sizeof(block));
    return block;
}

/** CPU shadow follows a successful write; the clean packing scratch stays untouched. */
template<class Upload>
void advance_temporal_jitter(TaaPostProcessState& state, PersistentSceneUniforms& source,
    double width, double height, Upload&& upload) {
    upstream::advance_taa_jitter(state, source, width, height,
        [&](PersistentSceneUniforms& target, double offset, const auto& values) {
            const auto bytes = values.size() * sizeof(float);
            const auto byte_offset = static_cast<std::size_t>(offset);
            if (byte_offset + bytes > target.drawn.size() * sizeof(float)) {
                throw std::runtime_error("Temporal jitter write exceeds its retained source UBO.");
            }
            upload(byte_offset, values.data(), bytes);
            std::memcpy(reinterpret_cast<std::uint8_t*>(target.drawn.data()) + byte_offset, values.data(), bytes);
        });
}

} // namespace bbl::pal
