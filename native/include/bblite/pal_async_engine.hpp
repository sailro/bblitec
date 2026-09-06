#pragma once

#include <bblite/js_promise.hpp>
#include <bblite/runtime.hpp>
#include <bblite/pal_canvas.hpp>

namespace bbl::pal {

// A DOM canvas can route Window input to its owning engine. OffscreenCanvas
// has no DOM event target; worker input must arrive through source messages.
void bind_canvas_engine(const std::shared_ptr<CanvasElement>& canvas, const std::shared_ptr<Engine>& engine);
inline void bind_canvas_engine(const std::shared_ptr<OffscreenCanvas>&, const std::shared_ptr<Engine>&) {}

/** Optional graphics ownership layered on the renderer-independent realm loop. */
template <typename Canvas> std::shared_ptr<Engine> create_realm_engine(EngineOptions options, const std::shared_ptr<Canvas>& canvas) {
    if (!canvas) throw InvalidCanvasState("Cannot create an engine on a null canvas.");
    auto context = canvas->rendering_context();
    const auto extent = context->extent();
    options.width = extent.width;
    options.height = extent.height;
    auto engine = std::make_shared<Engine>(bbl::create_engine(std::move(options)));
    engine->offscreen_run = std::move(context);
    bind_canvas_engine(canvas, engine);
    EventLoop::current().defer_cleanup([engine] {
        // Renderer activations have retired first. Drop source callbacks and
        // native resource owners before the last external engine reference.
        *engine = Engine{};
    });
    return engine;
}

js::Promise<js::PromiseVoid> start_realm_engine(std::shared_ptr<Engine> engine);

inline void resize_realm_surface(Engine& engine, std::uint32_t width, std::uint32_t height) {
    if (!engine.offscreen_run) throw InvalidCanvasState("Engine has no realm canvas.");
    engine.offscreen_run->resize(width, height);
    engine.options.width = static_cast<int>(width);
    engine.options.height = static_cast<int>(height);
    // GPU attachments are resized by the renderer when its next task starts.
}

} // namespace bbl::pal

namespace bbl { void set_engine_size(Engine& engine, double width, double height); }
