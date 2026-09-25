#pragma once
#include "pal_dawn_text.hpp"
#include <bblite/upstream_text_renderer.hpp>

namespace bbl::pal {

/** Point the engine surface at this frame's Dawn device, size and format, then
 *  run every registered text renderer's `_update`, the pin's closure. */
inline void update_dawn_text_renderers(Engine& engine, DawnTextRenderer& text, double width,
                                       double height) {
    const auto& surface = bbl::text_surface(engine);
    surface->device = text.device;
    surface->canvas = {width, height};
    surface->format = dawn_text_format_name(text.device->color_format);
    const auto renderers = surface->rendering_contexts;
    for (std::size_t index = 0; index < renderers.size(); ++index)
        renderers[index]->update();
}

/** Record every registered text renderer's pass into `target` through its `_record`. */
inline void record_dawn_text_renderers(Engine& engine, DawnTextRenderer& text,
                                       WGPUCommandEncoder encoder, WGPUTextureView target) {
    const auto& surface = bbl::text_surface(engine);
    auto view = std::make_shared<DawnTextGpuView>();
    view->target = target;
    surface->sc_rt.color_view = std::move(view);
    surface->current_encoder = text.command_encoder(encoder);
    const auto clear = js::finally([&] {
        surface->current_encoder.reset();
        surface->sc_rt.color_view.reset();
    });
    const auto renderers = surface->rendering_contexts;
    for (std::size_t index = 0; index < renderers.size(); ++index)
        static_cast<void>(renderers[index]->record());
}

} // namespace bbl::pal
