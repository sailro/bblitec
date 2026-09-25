// The frame loop's bodies (pal_gpu_frame.hpp): the run options, the frame
// boundaries, and the benchmark, CPU and memory profile lines. It reads only
// activation macros, so it compiles once for every scene whose macros agree.
#include <bblite/features/device_recovery.hpp>
#include <bblite/features/has_audio.hpp>
#include <bblite/features/workers.hpp>

#include "pal_gpu_frame.hpp"

namespace bbl::pal {

bool registered_scene_set_changed(const Engine& engine,
                                  const std::vector<std::shared_ptr<Scene>>& planned) {
    if (engine.scenes().size() != planned.size())
        return true;
    for (std::size_t i = 0; i < planned.size(); ++i) {
        const std::shared_ptr<Scene>& current = engine.scenes()[i];
        if (static_cast<bool>(current) != static_cast<bool>(planned[i])) {
            return true;
        }
        if (current && !current->shares_identity(*planned[i]))
            return true;
    }
    return false;
}

bool request_renderer_restart_if_scene_set_changed(
    Engine& engine, const std::vector<std::shared_ptr<Scene>>& planned) {
#if BBLITE_DEVICE_RECOVERY
    if (engine.device_recovery && engine.device_recovery->requested)
        return true;
#endif
    if (!registered_scene_set_changed(engine, planned))
        return false;
    engine.renderer_restart_requested = !engine.scenes().empty();
    return true;
}

FrameOptions read_frame_options() {
    FrameOptions options;
    options.screenshot_path = environment_variable("BBLITE_SCREENSHOT");
    options.id_buffer_path = environment_variable("BBLITE_ID_BUFFER");
    options.cluster_buffer_path = environment_variable("BBLITE_CLUSTER_BUFFER");
    options.shader_directory = environment_variable("BBLITE_GPU_SHADER_DIR");
    options.copy_task_filter = environment_variable("BBLITE_COPY_TASK");
    options.render_capture_path = environment_variable("BBLITE_RENDER_CAPTURE");
#if !BBLITE_VISUAL_CAPTURE
    if (!options.screenshot_path.empty() || !options.id_buffer_path.empty() ||
        !options.cluster_buffer_path.empty() || !options.render_capture_path.empty()) {
        throw std::runtime_error(
            "Visual capture is disabled in this build (BBLITE_VISUAL_CAPTURE=OFF).");
    }
#endif
    options.gpu_debug = environment_variable("BBLITE_GPU_DEBUG") == "1";
    options.test_pass = environment_variable("BBLITE_TEST_PASS") == "1";
    options.single_sample = environment_variable("BBLITE_MSAA") == "1";
    options.capture_ui = environment_variable("BBLITE_CAPTURE_UI") != "0";
    options.background_flag = environment_variable("BBLITE_BACKGROUND");
    options.ground_flag = environment_variable("BBLITE_GROUND");
    options.screenshot_frame = frame_option_number("BBLITE_SCREENSHOT_FRAME");
    options.max_frames = frame_option_number("BBLITE_MAX_FRAMES");
    options.benchmark_frames = frame_option_number("BBLITE_BENCHMARK_FRAMES");
    options.benchmark_requested = !environment_variable("BBLITE_BENCHMARK_FRAMES").empty();
    const std::string seek = environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    options.animation_seek_seconds = seek.empty() ? 0.0 : std::strtod(seek.c_str(), nullptr);
    const std::string frame_delta = environment_variable("BBLITE_FRAME_DELTA_MS");
    options.frame_delta_ms = frame_delta.empty() ? 0.0 : std::strtod(frame_delta.c_str(), nullptr);
#if BBLITE_WORKERS
    // A worker renders into a leased canvas. The Window owns presentation,
    // screenshots and process lifetime for all of its canvases together.
    if (OffscreenRun::current()) {
        options.screenshot_path.clear();
        options.max_frames = 0;
        options.benchmark_frames = 0;
        options.benchmark_requested = false;
    }
#endif
    return options;
}

void apply_animation_seek(const FrameOptions& options, const Scene& scene) {
    if (options.animation_seek_seconds == 0.0)
        return;
    for (const auto& seek : scene.animation_seekers) {
        seek(options.animation_seek_seconds);
    }
}

void run_animation_frame_callbacks(Engine& engine) {
    engine.animation_frame_after_render = false;
    engine.animation_frame_timestamp_ms = performance_milliseconds();
    const auto persistent_callbacks = engine.animation_frame_callbacks;
    auto once_callbacks = std::move(engine.animation_frame_once_callbacks);
    engine.animation_frame_once_callbacks.clear();
    for (const auto& callback : persistent_callbacks) {
        callback(engine.animation_frame_timestamp_ms);
    }
    for (const auto& callback : once_callbacks) {
        callback(engine.animation_frame_timestamp_ms);
    }
}

double advance_frame(Engine& engine, Scene& scene, FrameClock& frame_clock, double frame_delta_ms) {
    if (engine.stopped) {
        engine.current_delta_ms = 0.0;
        return 0.0;
    }
    const double delta_ms = frame_clock.advance(frame_delta_ms);
    engine.current_delta_ms = delta_ms;
    run_animation_frame_callbacks(engine);
    const double scene_delta_ms = scene_callback_delta(scene, delta_ms);
    // The scene callback API is the engine's float delta.
    const float callback_delta_ms = static_cast<float>(scene_delta_ms);
    // A callback may dispose its own scene while it is running. Snapshot the
    // dispatch list so clearing SceneState::before_render cannot destroy the
    // currently executing std::function (or invalidate the next iterator).
    const auto root_callbacks = scene.before_render;
    for (const auto& callback : root_callbacks) {
        callback(callback_delta_ms);
    }
    if (scene.state->process_material_groups)
        scene.state->process_material_groups(scene);
    // Every other registered scene's own callbacks. A swapchain overlay
    // layer is a second SceneContext with its own `_beforeRender` list --
    // the utility layer's camera forwarding and each gizmo's follow live
    // there -- and upstream runs a scene's callbacks as part of rendering
    // it, so a layer that is drawn is a layer whose callbacks ran.
    const auto registered_scenes = engine.scenes();
    for (const std::shared_ptr<Scene>& registered : registered_scenes) {
        if (!registered || registered->shares_identity(scene))
            continue;
        const auto registered_delta_ms =
            static_cast<float>(scene_callback_delta(*registered, delta_ms));
        const auto callbacks = registered->before_render;
        for (const auto& callback : callbacks) {
            callback(registered_delta_ms);
        }
        if (registered->state->process_material_groups)
            registered->state->process_material_groups(*registered);
    }
    return scene_delta_ms;
}

double advance_frame(Engine& engine, FrameClock& frame_clock, double frame_delta_ms) {
    if (engine.stopped) {
        engine.current_delta_ms = 0.0;
        return 0.0;
    }
    const double delta_ms = frame_clock.advance(frame_delta_ms);
    engine.current_delta_ms = delta_ms;
    run_animation_frame_callbacks(engine);
    return delta_ms;
}

double advance_frame(Engine& engine, FrameGraphContext& context, FrameClock& frame_clock,
                     double frame_delta_ms) {
    if (engine.stopped) {
        engine.current_delta_ms = 0.0;
        return 0.0;
    }
    const double delta_ms = frame_clock.advance(frame_delta_ms);
    engine.current_delta_ms = delta_ms;
    run_animation_frame_callbacks(engine);
    const float callback_delta_ms = static_cast<float>(delta_ms);
    for (const auto& callback : context.updates) {
        callback(callback_delta_ms);
    }
    return delta_ms;
}

void finish_frame(Engine& engine) {
    if (engine.drain_material_jobs)
        engine.drain_material_jobs(engine);
#if BBLITE_DEVICE_RECOVERY
    complete_device_recovery(engine);
#endif
    js::collect_at_frame_boundary();
    if (engine.stopped)
        return;
    engine.animation_frame_after_render = true;
    auto once_callbacks = std::move(engine.post_render_animation_frame_once_callbacks);
    engine.post_render_animation_frame_once_callbacks.clear();
    if (engine.post_render_animation_frame_callbacks_armed) {
        for (const auto& callback : engine.post_render_animation_frame_callbacks) {
            callback(engine.animation_frame_timestamp_ms);
        }
        for (const auto& callback : once_callbacks) {
            callback(engine.animation_frame_timestamp_ms);
        }
    } else {
        // `startEngine` resolves after this initial render; source following
        // its await cannot have registered a callback for this RAF turn.
        engine.post_render_animation_frame_callbacks_armed = true;
    }
    run_deferred_callbacks(engine);
    run_timeout_callbacks(engine);
    run_interval_callbacks(engine);
#if BBLITE_HAS_AUDIO
    audio_collect_finished();
#endif
}

void report_benchmark(std::vector<double> samples, const char* backend, const std::string& driver) {
    if (samples.empty())
        return;
    std::sort(samples.begin(), samples.end());
    double sum = 0.0;
    for (const double sample : samples)
        sum += sample;
    const std::size_t p95_index = std::min(
        samples.size() - 1, static_cast<std::size_t>(std::ceil(samples.size() * 0.95)) - 1);
    const std::ios_base::fmtflags flags = std::cout.flags();
    const std::streamsize precision = std::cout.precision();
    std::cout << std::fixed << std::setprecision(3) << "Babylon Lite " << backend
              << " benchmark | driver=" << driver << " | frames=" << samples.size()
              << " | average=" << (sum / samples.size())
              << " ms | median=" << samples[samples.size() / 2]
              << " ms | p95=" << samples[p95_index] << " ms | min=" << samples.front()
              << " ms | max=" << samples.back() << " ms\n";
    std::cout.flags(flags);
    std::cout.precision(precision);
}

void print_cpu_frame_profile(long frame, double total_ms, double acquire_ms, double update_ms,
                             double upload_ms, const std::optional<double>& write_ms,
                             double encode_submit_ms, std::size_t render_items,
                             std::size_t draw_commands) {
    std::ostringstream line;
    line << std::fixed << std::setprecision(3) << "[cpu][frame] frame=" << frame
         << " total_ms=" << total_ms << " acquire_ms=" << acquire_ms << " update_ms=" << update_ms
         << " upload_ms=" << upload_ms;
    if (write_ms.has_value())
        line << " write_ms=" << *write_ms;
    line << " encode_submit_ms=" << encode_submit_ms << " render_items=" << render_items
         << " draw_commands=" << draw_commands << '\n';
    std::fputs(line.str().c_str(), stderr);
}

void MemoryProfile::print(long frame, const bbl::Engine& engine, std::size_t scene_meshes,
                          std::size_t gpu_meshes, std::size_t shared_geometries,
                          std::size_t shared_geometry_bytes) const {
    std::size_t live_geometries = 0;
    std::size_t geometry_bytes = 0;
    for (const bbl::ModelGeometry& geometry : engine.geometries) {
        if (geometry.vertices.empty())
            continue;
        ++live_geometries;
        geometry_bytes += geometry.vertices.size() * sizeof(bbl::ModelVertex) +
                          geometry.indices.size() * sizeof(std::uint32_t);
        for (const auto* targets :
             {&geometry.morph_positions, &geometry.morph_normals, &geometry.morph_tangents}) {
            for (const std::vector<Vec3>& target : *targets) {
                geometry_bytes += target.size() * sizeof(Vec3);
            }
        }
    }
    constexpr double mb = 1024.0 * 1024.0;
    std::ostringstream line;
    line << std::fixed << std::setprecision(1) << "[mem][frame] engine=" << stream_
         << " frame=" << frame << " working_set_mb=" << bbl::pal::process_working_set_bytes() / mb
         << " mesh_records=" << engine.meshes.size() - engine.free_mesh_slots.size()
         << " scene_meshes=" << scene_meshes << " transform_node_records="
         << engine.transform_nodes.size() - engine.free_transform_node_slots.size()
         << " gc_nodes=" << bbl::js::managed_node_count()
         << " gc_allocations=" << bbl::js::gc::registry.total_allocations
         << " geometry_records=" << engine.geometries.size() - engine.free_geometry_slots.size()
         << " live_geometries=" << live_geometries << " geometry_mb=" << geometry_bytes / mb
         << " gpu_meshes=" << gpu_meshes << " shared_geometries=" << shared_geometries
         << " shared_geometry_mb=" << shared_geometry_bytes / mb << '\n';
    std::fputs(line.str().c_str(), stderr);
}

void reject_unsupported_frame_options(const FrameOptions& options, const char* backend,
                                      bool supports_single_sample, bool supports_copy_task) {
    if (options.single_sample && !supports_single_sample) {
        throw std::runtime_error(std::string("BBLITE_MSAA is not supported by the ") + backend +
                                 " backend; run the single-sample diagnostic through a scene "
                                 "renderer that supports it.");
    }
    if (!options.copy_task_filter.empty() && !supports_copy_task) {
        throw std::runtime_error(std::string("BBLITE_COPY_TASK is not supported by the ") +
                                 backend +
                                 " backend; the geometry copy-task diagnostic runs through a "
                                 "scene renderer that supports it.");
    }
}

} // namespace bbl::pal
