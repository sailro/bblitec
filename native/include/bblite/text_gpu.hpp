#pragma once

#include <bblite/gpu.hpp>
#include <functional>

namespace bbl {

/** The pin's `TextPipelineDeviceCache`: the backend's layout and quad. */
struct TextPipelineDeviceCache {
    GpuHandle bind_group_layout;
    GpuHandle quad_vertex_buffer;
};
using TextPipelineDeviceCacheHandle = std::shared_ptr<TextPipelineDeviceCache>;
/** The pin's `TextPipelineSet`. */
struct TextPipelineSet {
    GpuHandle pipeline;
    GpuHandle variant_pipeline;
    TextPipelineDeviceCacheHandle cache;
};

/**
 * The optional alpha-to-coverage resolver hook (`alpha-to-coverage-hook.ts`):
 * installed by the lowered `setAlphaToCoverage`, read by the backends'
 * pipeline caches. Realm state, as the hook module's.
 */
inline thread_local std::function<bool(const std::shared_ptr<const void>&)>
    text_alpha_to_coverage_resolver;

/** `getOrCreateTextPipeline`'s alpha-to-coverage decision for one owner. */
[[nodiscard]] inline bool
text_pipeline_alpha_to_coverage(double sample_count, bool depth_write,
                                const std::shared_ptr<const void>& owner) {
    return depth_write && sample_count > 1 && owner && text_alpha_to_coverage_resolver &&
           text_alpha_to_coverage_resolver(owner);
}

/** The pinned text pipeline cache, separate from the WebGPU device API. */
struct TextPipelineProvider {
    virtual ~TextPipelineProvider() = default;
    /** `getOrCreateTextPipeline(engine, format, sampleCount, depthStencilFormat, depthWrite,
     *  owner, depthCompare)`. */
    virtual TextPipelineSet
    text_pipeline(const std::string& format, double sample_count,
                  const bbl::js::Nullable<std::string>& depth_stencil_format, bool depth_write,
                  const std::shared_ptr<const void>& owner, const std::string& depth_compare) = 0;
    /** `getTextPipelineCache(engine)`. */
    virtual TextPipelineDeviceCacheHandle text_pipeline_cache() = 0;
};

inline TextPipelineProvider& text_pipelines(const GpuDeviceHandle& device) {
    auto* provider = dynamic_cast<TextPipelineProvider*>(device.get());
    if (!provider)
        throw std::runtime_error("GPU device has no text pipeline provider.");
    return *provider;
}

struct TextSurfaceCanvas {
    double width = 0;
    double height = 0;
};
struct TextSurfaceTarget {
    /** `scRT._colorView`: this frame's swapchain view. */
    GpuHandle color_view;
};
/**
 * The engine's primary surface as the pin's text path reads it (the pin's
 * `EngineContext` is its own first `SurfaceContext`). The backend points it
 * at its device, the drawable size, the swapchain view and the frame's
 * command encoder before it runs the lowered text work.
 */
struct TextSurface {
    Engine* engine = nullptr;
    GpuDeviceHandle device;
    GpuCommandEncoderHandle current_encoder;
    TextSurfaceCanvas canvas;
    std::string format;
    TextSurfaceTarget sc_rt;
};
using TextSurfaceHandle = std::shared_ptr<TextSurface>;

/** A source colour, as the pin's `GPUColorDict` stores it. */
[[nodiscard]] inline Color4d text_color(const Color4& color) {
    return {color.r, color.g, color.b, color.a};
}

/** The standalone text renderers registered on the engine. */
[[nodiscard]] inline std::size_t text_renderer_count(const Engine& engine) {
    return engine.text_renderer_contexts().size();
}

/** Whether a standalone text renderer is registered on the engine. */
[[nodiscard]] inline bool has_text_renderers(const Engine& engine) {
    return text_renderer_count(engine) != 0;
}

/** The engine's text surface, created on first use. */
inline const TextSurfaceHandle& text_surface(Engine& engine) {
    if (!engine.text_surface) {
        engine.text_surface = std::make_shared<TextSurface>();
        engine.text_surface->engine = &engine;
    }
    return engine.text_surface;
}

} // namespace bbl
