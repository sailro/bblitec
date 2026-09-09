#pragma once

#include <bblite/runtime.hpp>
#include <cstring>
#include <stdexcept>

namespace bbl::pal {

inline void validate_temporal_source(const Engine& engine, const FrameTaskRecord& task,
    const CameraRecord* camera, const upstream::RenderDrawLists& draws) {
    if (!task.source_scene || task.render.scene_stages ||
        task.render.shadow_generator.value != invalid_handle) {
        throw std::runtime_error("Temporal source requires an explicit color pass in its owning scene.");
    }
    if (!camera || camera->kind != CameraKind::arc_rotate || camera->orthographic) {
        throw std::runtime_error("Temporal source camera requires tracked ArcRotate perspective transport.");
    }
    if (task.source_scene->clustered_lights.value != invalid_handle || task.source_scene->transmission_enabled) {
        throw std::runtime_error("Temporal source requires preparation for its clustered-light or transmission state.");
    }
    if (bbl::has_sprite_renderers(engine) || !engine.registered_effect_renderers.empty() ||
        !engine.registered_frame_graph_contexts.empty() || !engine.registered_text_renderers.empty()) {
        throw std::runtime_error("Temporal submission requires preparation for the engine's registered renderer or UI contexts.");
    }
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    if (!engine.ui_root_children.empty()) {
        throw std::runtime_error("Temporal submission requires preparation for the engine's retained UI.");
    }
#endif
    for (const auto* list : {&draws.opaque, &draws.transparent}) {
        for (const auto& draw : list->commands) {
            if (draw.item.material_kind != upstream::RenderMaterialKind::standard) {
                throw std::runtime_error("Temporal source requires a prepared Standard material draw adapter.");
            }
        }
    }
}

/** Borrow task/cache inputs without changing the identities held by the pin. */
template<class Upload>
void prepare_temporal_scene_uniforms(
    FrameTaskRecord& task, CameraRecord* camera,
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
            struct PackEngine { bool use_floating_origin; double width, height; } pack_engine{
                BBLITE_FLOATING_ORIGIN != 0, canvas_width, canvas_height};
            struct Fog { double mode, start, end, density; std::array<double, 3> color; };
            struct Environment { double lod_generation_scale; bool has_harmonics; std::array<float, 36> harmonics{}; };
            struct PackScene {
                double exposure, contrast;
                bool tone_mapping_enabled;
                std::optional<Fog> fog{};
                std::optional<std::array<double, 4>> clip_plane{};
                std::optional<Environment> environment{};
                std::optional<double> environment_rotation{};
            } pack_scene{scene.environment.exposure, scene.environment.contrast, scene.environment.tone_mapping_enabled};
            if (scene.state->fog_identity) pack_scene.fog = Fog{scene.fog_mode, scene.fog_start, scene.fog_end,
                scene.fog_density, {scene.fog_color.r, scene.fog_color.g, scene.fog_color.b}};
            // An absent clip plane is already represented by the zero vector;
            // writing its four lanes over the packer's zero fill is identical.
            pack_scene.clip_plane = {scene.clip_plane.x, scene.clip_plane.y, scene.clip_plane.z, scene.clip_plane.w};
            if (scene.state->environment_identity) {
                pack_scene.environment = Environment{scene.environment.lod_generation_scale, scene.environment.has_irradiance};
                pack_scene.environment_rotation = scene.environment.rotation_y;
                for (std::size_t band = 0; band < scene.environment.spherical_harmonics.size(); ++band) {
                    const auto& color = scene.environment.spherical_harmonics[band];
                    auto* values = pack_scene.environment->harmonics.data() + band * 4;
                    values[0] = color.r; values[1] = color.g; values[2] = color.b;
                }
            }
            upstream::pack_scene_uniforms(
                [](CameraRecord& value, double ratio) { return upstream::build_view_projection(value, ratio); },
                [](CameraRecord& value) { return upstream::build_view_matrix(upstream::camera_world_matrix(value)); },
                [](CameraRecord& value) { return upstream::camera_world_matrix(value); },
                storage.clean, pack_engine, pack_scene, *camera, aspect);
            upstream::write_fog_scene_uniforms(storage.clean, pack_scene);
            upstream::write_clip_scene_uniforms(storage.clean, pack_scene);
            if (pack_scene.environment) upstream::write_environment_scene_uniforms(storage.clean, pack_scene);
            const auto bytes = storage.clean.size() * sizeof(float);
            upload(storage.clean.data(), bytes);
            std::memcpy(storage.drawn.data(), storage.clean.data(), bytes);
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
