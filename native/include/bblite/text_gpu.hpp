#pragma once

#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>

#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>

namespace bbl {

/**
 * The WebGPU surface the pinned text path speaks, as generated code lowered
 * from the pin calls it: `device.createBuffer(descriptor)` is
 * `device->create_buffer(descriptor)` with the pin's own descriptor, and
 * `device.queue.writeBuffer(...)` carries the pin's offsets. Each backend
 * implements the device and its encoders with WebGPU's semantics.
 */

/** A GPU object a text device created: a buffer, texture, view, bind group
 *  or layout, pipeline or render bundle. Generated code holds it by
 *  identity; only the backend that created it looks inside. */
struct TextGpuObject {
    /** `GPUBuffer.size`, in bytes; zero for every other object. */
    double size = 0;
    TextGpuObject() = default;
    TextGpuObject(const TextGpuObject&) = delete;
    TextGpuObject& operator=(const TextGpuObject&) = delete;
    virtual ~TextGpuObject() = default;
    /** `GPUBuffer.destroy()` / `GPUTexture.destroy()`. */
    virtual void destroy() {}
    /** `GPUTexture.createView()`. */
    virtual std::shared_ptr<TextGpuObject> create_view() {
        throw std::runtime_error("Text GPU object has no texture view.");
    }
};
using TextGpuHandle = std::shared_ptr<TextGpuObject>;

struct TextBufferDescriptor {
    std::optional<std::string> label;
    double size = 0;
    double usage = 0;
};
struct TextExtent3D {
    double width = 0;
    double height = 1;
    double depth_or_array_layers = 1;
};
struct TextTextureDescriptor {
    std::optional<std::string> label;
    std::string format;
    TextExtent3D size;
    double usage = 0;
};
struct TextBufferBinding {
    TextGpuHandle buffer;
    std::optional<double> offset;
    std::optional<double> size;
};
/** `GPUBindingResource`: a buffer binding, or a view or sampler. */
using TextBindingResource = std::variant<TextBufferBinding, TextGpuHandle>;
struct TextBindGroupEntry {
    double binding = 0;
    TextBindingResource resource;
};
struct TextBindGroupDescriptor {
    std::optional<std::string> label;
    TextGpuHandle layout;
    js::Array<TextBindGroupEntry> entries;
};
struct TextTexelCopyTextureInfo {
    TextGpuHandle texture;
};
struct TextTexelCopyBufferLayout {
    std::optional<double> offset;
    std::optional<double> bytes_per_row;
    std::optional<double> rows_per_image;
};
struct TextRenderBundleEncoderDescriptor {
    js::Array<std::string> color_formats;
    std::optional<double> sample_count;
};
struct TextRenderPassColorAttachment {
    TextGpuHandle view;
    std::optional<Color4d> clear_value;
    std::string load_op;
    std::string store_op;
};
struct TextRenderPassDescriptor {
    js::Array<TextRenderPassColorAttachment> color_attachments;
};

/** `GPURenderPassEncoder` and `GPURenderBundleEncoder`. */
struct TextGpuEncoder {
    TextGpuEncoder() = default;
    TextGpuEncoder(const TextGpuEncoder&) = delete;
    TextGpuEncoder& operator=(const TextGpuEncoder&) = delete;
    virtual ~TextGpuEncoder() = default;
    virtual void set_pipeline(const TextGpuHandle& pipeline) = 0;
    virtual void set_vertex_buffer(double slot, const TextGpuHandle& buffer) = 0;
    virtual void set_bind_group(double index, const TextGpuHandle& group) = 0;
    virtual void draw(double vertices, double instances, double first_vertex,
                      double first_instance) = 0;
    /** `GPURenderBundleEncoder.finish()`. */
    virtual TextGpuHandle finish() {
        throw std::runtime_error("Text pass encoder cannot finish a render bundle.");
    }
    /** `GPURenderPassEncoder.executeBundles(bundles)`. */
    virtual void execute_bundles(const js::Array<TextGpuHandle>&) {
        throw std::runtime_error("Text bundle encoder cannot execute bundles.");
    }
    /** `GPURenderPassEncoder.end()`. */
    virtual void end() { throw std::runtime_error("Text bundle encoder has no pass to end."); }
};
using TextGpuEncoderHandle = std::shared_ptr<TextGpuEncoder>;

/** `GPUCommandEncoder`, as far as the standalone text renderer uses it. */
struct TextGpuCommandEncoder {
    TextGpuCommandEncoder() = default;
    TextGpuCommandEncoder(const TextGpuCommandEncoder&) = delete;
    TextGpuCommandEncoder& operator=(const TextGpuCommandEncoder&) = delete;
    virtual ~TextGpuCommandEncoder() = default;
    virtual TextGpuEncoderHandle begin_render_pass(const TextRenderPassDescriptor& descriptor) = 0;
};
using TextGpuCommandEncoderHandle = std::shared_ptr<TextGpuCommandEncoder>;

/** The pin's `TextPipelineDeviceCache`: the backend's layout and quad. */
struct TextPipelineDeviceCache {
    TextGpuHandle bind_group_layout;
    TextGpuHandle quad_vertex_buffer;
};
using TextPipelineDeviceCacheHandle = std::shared_ptr<TextPipelineDeviceCache>;
/** The pin's `TextPipelineSet`. */
struct TextPipelineSet {
    TextGpuHandle pipeline;
    TextGpuHandle variant_pipeline;
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

/** `GPUDevice` and its queue, plus the pin's per-device text pipeline cache. */
struct TextGpuDevice {
    TextGpuDevice() = default;
    TextGpuDevice(const TextGpuDevice&) = delete;
    TextGpuDevice& operator=(const TextGpuDevice&) = delete;
    virtual ~TextGpuDevice() = default;
    virtual TextGpuHandle create_buffer(const TextBufferDescriptor& descriptor) = 0;
    virtual TextGpuHandle create_texture(const TextTextureDescriptor& descriptor) = 0;
    virtual TextGpuHandle create_bind_group(const TextBindGroupDescriptor& descriptor) = 0;
    virtual TextGpuEncoderHandle
    create_render_bundle_encoder(const TextRenderBundleEncoderDescriptor& descriptor) = 0;
    /** `GPUQueue.writeBuffer(buffer, bufferOffset, data, dataOffset, size)`. */
    virtual void write_buffer(const TextGpuHandle& buffer, double buffer_offset,
                              const js::ArrayBuffer& data, double data_offset, double size) = 0;
    /** `GPUQueue.writeTexture(destination, data, dataLayout, size)`. */
    virtual void write_texture(const TextTexelCopyTextureInfo& destination,
                               const js::ArrayBuffer& data, const TextTexelCopyBufferLayout& layout,
                               const TextExtent3D& size) = 0;
    /** `getOrCreateTextPipeline(engine, format, sampleCount, depthStencilFormat, depthWrite,
     *  owner, depthCompare)`. */
    virtual TextPipelineSet text_pipeline(const std::string& format, double sample_count,
                                          const std::optional<std::string>& depth_stencil_format,
                                          bool depth_write,
                                          const std::shared_ptr<const void>& owner,
                                          const std::string& depth_compare) = 0;
    /** `getTextPipelineCache(engine)`. */
    virtual TextPipelineDeviceCacheHandle text_pipeline_cache() = 0;
};
using TextGpuDeviceHandle = std::shared_ptr<TextGpuDevice>;

struct TextRendererState;
using TextRenderer = std::shared_ptr<TextRendererState>;

struct TextSurfaceCanvas {
    double width = 0;
    double height = 0;
};
struct TextSurfaceTarget {
    /** `scRT._colorView`: this frame's swapchain view. */
    TextGpuHandle color_view;
};
/**
 * The engine's primary surface as the pin's text path reads it (the pin's
 * `EngineContext` is its own first `SurfaceContext`). The backend points it
 * at its device, the drawable size, the swapchain view and the frame's
 * command encoder before it runs the lowered text work.
 */
struct TextSurface {
    TextGpuDeviceHandle device;
    TextGpuCommandEncoderHandle current_encoder;
    TextSurfaceCanvas canvas;
    std::string format;
    TextSurfaceTarget sc_rt;
    js::Array<TextRenderer> rendering_contexts;
};
using TextSurfaceHandle = std::shared_ptr<TextSurface>;

/** A source colour, as the pin's `GPUColorDict` stores it. */
[[nodiscard]] inline Color4d text_color(const Color4& color) {
    return {color.r, color.g, color.b, color.a};
}

/** The standalone text renderers registered on the engine. */
[[nodiscard]] inline std::size_t text_renderer_count(const Engine& engine) {
    return engine.text_surface ? engine.text_surface->rendering_contexts.size() : 0;
}

/** Whether a standalone text renderer is registered on the engine. */
[[nodiscard]] inline bool has_text_renderers(const Engine& engine) {
    return text_renderer_count(engine) != 0;
}

/** The engine's text surface, created on first use. */
inline const TextSurfaceHandle& text_surface(Engine& engine) {
    if (!engine.text_surface)
        engine.text_surface = std::make_shared<TextSurface>();
    return engine.text_surface;
}

} // namespace bbl
