#pragma once

#include <bblite/js_promise.hpp>
#include <bblite/runtime.hpp>
#include <bblite/pal_canvas.hpp>
#include <bblite/pal_gpu_retirement.hpp>

namespace bbl::pal {

// A DOM canvas can route Window input to its owning engine. OffscreenCanvas
// has no DOM event target; worker input must arrive through source messages.
void bind_canvas_engine(const std::shared_ptr<CanvasElement>& canvas,
                        const std::shared_ptr<Engine>& engine);
inline void bind_canvas_engine(const std::shared_ptr<OffscreenCanvas>&,
                               const std::shared_ptr<Engine>&) {}

/** Optional graphics ownership layered on the renderer-independent realm loop. */
template <typename Canvas>
std::shared_ptr<Engine> create_realm_engine(EngineOptions options,
                                            const std::shared_ptr<Canvas>& canvas) {
    if (!canvas)
        throw InvalidCanvasState("Cannot create an engine on a null canvas.");
    auto context = canvas->rendering_context();
    const auto extent = context->extent();
    options.width = extent.width;
    options.height = extent.height;
    auto engine = std::make_shared<Engine>(bbl::create_engine(std::move(options)));
    engine->realm_owner = engine;
    engine->offscreen_run = std::move(context);
    bind_canvas_engine(canvas, engine);
    EventLoop::current().defer_cleanup([engine] {
        if (engine->dispose_storage_buffers)
            engine->dispose_storage_buffers(*engine);
        if (engine->dispose_compute_textures)
            engine->dispose_compute_textures();
        if (engine->dispose_gpu_retirements)
            engine->dispose_gpu_retirements();
        // Renderer activations have retired first. Drop source callbacks and
        // native resource owners before the last external engine reference.
        *engine = Engine{};
    });
    return engine;
}

js::Promise<js::PromiseVoid> start_realm_engine(std::shared_ptr<Engine> engine);

/** Retain the engine and let its realm service tasks between packaged loads. */
template <bool Cameras = false>
js::Promise<AssetHandle> load_realm_gltf(Engine& engine, std::string path) {
    const auto owner = engine.realm_owner.lock();
    if (!owner)
        throw std::logic_error("An asynchronous asset load requires an owned engine.");
    js::Promise<AssetHandle> result;
    EventLoop::current().post([owner, path = std::move(path), result] {
        try {
            if (owner->device_disposed)
                throw std::runtime_error("Cannot load an asset into a disposed engine.");
            if constexpr (Cameras)
                result.resolve(load_gltf(*owner, path, true));
            else
                result.resolve(load_gltf(*owner, path));
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            result.reject(std::current_exception());
        }
    });
    return result;
}

inline GpuCompletion submitted_gpu_work(const std::shared_ptr<OffscreenRun>& run) {
    struct Completion final : CompletionEvent {
        std::exception_ptr error;
        Completion(std::uint64_t id, std::exception_ptr failure)
            : CompletionEvent(id), error(failure) {}
    };
    struct Pending {
        std::shared_ptr<OffscreenRun> run;
        std::unique_ptr<OffscreenCompletion> operation;
    };
    GpuCompletion result;
    auto& loop = EventLoop::current();
    auto pending = std::make_shared<Pending>(Pending{run, {}});
    const auto id =
        loop.register_completion([result, pending](std::unique_ptr<ExternalEvent> event) {
            auto* completion = dynamic_cast<Completion*>(event.get());
            if (!completion)
                throw std::logic_error("Incorrect GPU completion payload.");
            if (completion->error)
                result.reject(completion->error);
            else
                result.resolve(js::PromiseVoid{});
        });
    try {
        if (!run)
            throw InvalidCanvasState("Engine has no GPU device.");
        pending->operation = run->device().on_submitted_work_done(
            [inbox = loop.inbox(), id](std::exception_ptr error) {
                inbox->post(std::make_unique<Completion>(id, std::move(error)));
            });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}

inline std::shared_ptr<GpuRetirementState> gpu_retirement_state(Engine& engine) {
    if (!engine.gpu_retirements) {
        auto state = std::make_shared<GpuRetirementState>();
        state->submitted_work_done = [run = engine.offscreen_run] {
            return submitted_gpu_work(run);
        };
        engine.gpu_retirements = state;
        engine.flush_gpu_retirements = [state] {
            if (state->flush)
                state->flush(state);
        };
        engine.dispose_gpu_retirements = [state] { dispose_gpu_resource_retirements(state); };
    }
    return engine.gpu_retirements;
}

inline void resize_realm_surface(Engine& engine, std::uint32_t width, std::uint32_t height) {
    if (!engine.offscreen_run)
        throw InvalidCanvasState("Engine has no realm canvas.");
    engine.offscreen_run->resize(width, height);
    engine.options.width = static_cast<int>(width);
    engine.options.height = static_cast<int>(height);
    // GPU attachments are resized by the renderer when its next task starts.
}

} // namespace bbl::pal

namespace bbl {
void set_engine_size(Engine& engine, double width, double height);
}
