#pragma once

#include <bblite/features/has_text_renderable.hpp>

#include "pal_dawn_constants.hpp"
#include "pal_dawn_shared.hpp"
#include "pal_dawn_text_resources.hpp"
#include "pal_text_pipeline.hpp"
#if BBLITE_HAS_TEXT_RENDERABLE
#include "pal_text_scene.hpp"
#endif
#include <map>
#include <tuple>

namespace bbl::pal {

using DawnTextShaderLease = DawnTextLease<WGPUShaderModule, wgpuShaderModuleRelease>;
using DawnTextPipelineLayoutLease = DawnTextLease<WGPUPipelineLayout, wgpuPipelineLayoutRelease>;

inline const char* dawn_text_format_name(WGPUTextureFormat format) {
    switch (format) {
    case WGPUTextureFormat_BGRA8Unorm:
        return "bgra8unorm";
    case WGPUTextureFormat_RGBA8Unorm:
        return "rgba8unorm";
    case WGPUTextureFormat_Depth24Plus:
        return "depth24plus";
    case WGPUTextureFormat_Depth24PlusStencil8:
        return "depth24plus-stencil8";
    case WGPUTextureFormat_Depth32Float:
        return "depth32float";
    case WGPUTextureFormat_Depth32FloatStencil8:
        return "depth32float-stencil8";
    default:
        throw std::runtime_error("Unmapped Dawn text target format.");
    }
}

/**
 * The pin's `GPUDevice` for text on Dawn: WebGPU objects over Dawn's own, and
 * the per-device pipeline cache `getOrCreateTextPipeline` reads.
 */
struct DawnTextGpuDevice final : DawnTextGpuResources {
    /** The target formats this device's passes draw into. */
    WGPUTextureFormat color_format = WGPUTextureFormat_Undefined;
    WGPUTextureFormat depth_format = WGPUTextureFormat_Undefined;
    std::shared_ptr<DawnTextGpuLayout> layout;
    std::shared_ptr<DawnTextPipelineLayoutLease> pipeline_layout;
    TextPipelineDeviceCacheHandle cache;
    std::map<std::tuple<const upstream::TextPipelineInfo*, WGPUTextureFormat, WGPUTextureFormat>,
             std::shared_ptr<DawnTextGpuPipeline>>
        pipelines;

    using DawnTextGpuResources::DawnTextGpuResources;

    TextPipelineDeviceCacheHandle text_pipeline_cache() override {
        if (cache)
            return cache;
        auto created = std::make_shared<DawnTextGpuLayout>();
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (const auto& row : upstream::text_binding_layout) {
            WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entry.binding = row.binding;
            entry.visibility = static_cast<WGPUShaderStage>(row.visibility);
            const std::string_view kind(row.kind);
            if (kind == "uniform")
                entry.buffer.type = WGPUBufferBindingType_Uniform;
            else if (kind == "read-only-storage")
                entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            else if (kind == "unfilterable-float") {
                entry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
                entry.texture.viewDimension = WGPUTextureViewDimension_2D;
            } else
                throw std::runtime_error("Unmapped text bind-group layout kind.");
            entries.push_back(entry);
            created->bindings.push_back({row.binding, text_binding_role(row.name)});
        }
        WGPUBindGroupLayoutDescriptor descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        created->layout = retain_dawn_text_resource<DawnTextLayoutLease>(
            owner, wgpuDeviceCreateBindGroupLayout(owner->device, &descriptor),
            "bind-group-layout");
        const WGPUBindGroupLayout group = created->layout->get();
        WGPUPipelineLayoutDescriptor pipeline_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
        pipeline_descriptor.bindGroupLayoutCount = 1;
        pipeline_descriptor.bindGroupLayouts = &group;
        pipeline_layout = retain_dawn_text_resource<DawnTextPipelineLayoutLease>(
            owner, wgpuDeviceCreatePipelineLayout(owner->device, &pipeline_descriptor));
        auto quad = std::make_shared<DawnTextGpuBuffer>();
        quad->size = sizeof(upstream::text_quad_corners);
        WGPUBufferDescriptor quad_info = WGPU_BUFFER_DESCRIPTOR_INIT;
        quad_info.size = sizeof(upstream::text_quad_corners);
        quad_info.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
        quad->lease = retain_dawn_text_resource<DawnTextBufferLease>(
            owner, wgpuDeviceCreateBuffer(owner->device, &quad_info), "quad",
            sizeof(upstream::text_quad_corners));
        wgpuQueueWriteBuffer(owner->queue, quad->lease->get(), 0,
                             upstream::text_quad_corners.data(),
                             sizeof(upstream::text_quad_corners));
        owner->capture.write(
            quad->lease->capture_id, 0u,
            {reinterpret_cast<const std::uint8_t*>(upstream::text_quad_corners.data()),
             sizeof(upstream::text_quad_corners)});
        layout = created;
        cache = std::make_shared<TextPipelineDeviceCache>();
        cache->bind_group_layout = std::move(created);
        cache->quad_vertex_buffer = std::move(quad);
        return cache;
    }

    TextPipelineSet text_pipeline(const std::string& format, double sample_count,
                                  const std::optional<std::string>& depth_stencil_format,
                                  bool depth_write, const std::shared_ptr<const void>& owner_object,
                                  const std::string& depth_compare) override {
        if (format != dawn_text_format_name(color_format))
            throw std::runtime_error("Text pipeline format differs from the Dawn target: " +
                                     format);
        const auto samples = text_gpu_u32(text_gpu_size(sample_count));
        const bool has_depth = depth_stencil_format.has_value();
        if (has_depth && *depth_stencil_format != dawn_text_format_name(depth_format))
            throw std::runtime_error("Text pipeline depth format differs from the Dawn target: " +
                                     *depth_stencil_format);
        if (has_depth && depth_compare != "greater-equal")
            throw std::runtime_error("Unmapped text depth compare: " + depth_compare);
        const bool alpha_to_coverage =
            text_pipeline_alpha_to_coverage(sample_count, depth_write, owner_object);
        TextPipelineSet result;
        result.cache = text_pipeline_cache();
        result.pipeline =
            pipeline(text_pipeline_info(samples, has_depth, depth_write, alpha_to_coverage));
        result.variant_pipeline = text_weight_installed
                                      ? pipeline(text_pipeline_info(samples, has_depth, depth_write,
                                                                    alpha_to_coverage, true))
                                      : result.pipeline;
        return result;
    }

    std::shared_ptr<DawnTextGpuPipeline> pipeline(const upstream::TextPipelineInfo& info) {
        const auto depth_target = info.has_depth ? depth_format : WGPUTextureFormat_Undefined;
        const auto key = std::tuple{&info, color_format, depth_target};
        if (const auto found = pipelines.find(key); found != pipelines.end())
            return found->second;
        auto vertex = retain_dawn_text_resource<DawnTextShaderLease>(
            owner, load_wgsl_module(owner->device, info.vertex_shader));
        auto fragment_module = retain_dawn_text_resource<DawnTextShaderLease>(
            owner, load_wgsl_module(owner->device, info.fragment_shader));
        std::vector<std::vector<WGPUVertexAttribute>> attributes;
        std::vector<WGPUVertexBufferLayout> buffers;
        attributes.reserve(upstream::text_vertex_buffers.size());
        buffers.reserve(upstream::text_vertex_buffers.size());
        for (const auto& source : upstream::text_vertex_buffers) {
            auto& list = attributes.emplace_back();
            for (const auto& attribute : source.attributes) {
                WGPUVertexAttribute target = WGPU_VERTEX_ATTRIBUTE_INIT;
                target.shaderLocation = attribute.location;
                target.offset = attribute.offset;
                const std::string_view format(attribute.format);
                if (format == "float32x2")
                    target.format = WGPUVertexFormat_Float32x2;
                else if (format == "uint32")
                    target.format = WGPUVertexFormat_Uint32;
                else
                    throw std::runtime_error("Unmapped text vertex attribute format.");
                list.push_back(target);
            }
            WGPUVertexBufferLayout target = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
            target.arrayStride = source.stride;
            const std::string_view step(source.step_mode);
            if (step == "vertex")
                target.stepMode = WGPUVertexStepMode_Vertex;
            else if (step == "instance")
                target.stepMode = WGPUVertexStepMode_Instance;
            else
                throw std::runtime_error("Unmapped text vertex step mode.");
            target.attributeCount = list.size();
            target.attributes = list.data();
            buffers.push_back(target);
        }
        WGPUBlendState blend = blend_state_from(info.blend);
        WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
        target.format = color_format;
        target.blend = info.blend_enabled ? &blend : nullptr;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = fragment_module->get();
        fragment.entryPoint = string_view(info.fragment_entry);
        fragment.targetCount = 1;
        fragment.targets = &target;
        WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
        depth.format = depth_target;
        depth.depthCompare = dawn_depth_compare(info.depth_compare);
        depth.depthWriteEnabled = info.depth_write ? WGPUOptionalBool_True : WGPUOptionalBool_False;
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = pipeline_layout->get();
        descriptor.vertex.module = vertex->get();
        descriptor.vertex.entryPoint = string_view(info.vertex_entry);
        descriptor.vertex.bufferCount = buffers.size();
        descriptor.vertex.buffers = buffers.data();
        descriptor.fragment = &fragment;
        descriptor.depthStencil = info.has_depth ? &depth : nullptr;
        if (std::string_view(info.topology) != "triangle-list" ||
            std::string_view(info.cull_mode) != "none" ||
            std::string_view(info.front_face) != "ccw")
            throw std::runtime_error("Unmapped text primitive state.");
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.cullMode = WGPUCullMode_None;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        descriptor.multisample.count = info.sample_count;
        descriptor.multisample.alphaToCoverageEnabled = info.alpha_to_coverage;
        DawnStageConstants vertex_constants(info.vertex_constants),
            fragment_constants(info.fragment_constants);
        vertex_constants.apply(descriptor.vertex);
        fragment_constants.apply(fragment);
        auto created = std::make_shared<DawnTextGpuPipeline>();
        created->pipeline = retain_dawn_text_resource<DawnTextPipelineLease>(
            owner, wgpuDeviceCreateRenderPipeline(owner->device, &descriptor), "pipeline");
        if (owner->capture.enabled())
            created->capture =
                text_pipeline_capture(info, dawn_text_format_name(color_format),
                                      info.has_depth ? dawn_text_format_name(depth_target) : "");
        pipelines.emplace(key, created);
        return created;
    }
};

/** The Dawn text device, and the scene pass that draws the scene's text through it. */
struct DawnTextRenderer {
    std::shared_ptr<DawnTextGpuDevice> device;
#if BBLITE_HAS_TEXT_RENDERABLE
    TextScenePass scene;
#endif
    DawnTextRenderer(WGPUDevice gpu, WGPUQueue queue, bool capture)
        : device(std::make_shared<DawnTextGpuDevice>(gpu, queue, capture)) {}
    // Its resources retire with the Dawn device they belong to, even while
    // the engine surface or a text record still names the device.
    ~DawnTextRenderer() { device->owner->retire(); }
    DawnTextRenderer(const DawnTextRenderer&) = delete;
    DawnTextRenderer& operator=(const DawnTextRenderer&) = delete;
    /** A pass encoder over a render pass the frame opened. */
    std::shared_ptr<DawnTextPassEncoder> borrow_pass(WGPURenderPassEncoder pass) {
        auto encoder = std::make_shared<DawnTextPassEncoder>();
        encoder->owner = device->owner;
        encoder->pass = pass;
        return encoder;
    }
    /** The frame's command encoder for passes the pin begins itself. */
    std::shared_ptr<DawnTextCommandEncoder> command_encoder(WGPUCommandEncoder encoder) {
        auto result = std::make_shared<DawnTextCommandEncoder>();
        result->owner = device->owner;
        result->encoder = encoder;
        return result;
    }
};

} // namespace bbl::pal
