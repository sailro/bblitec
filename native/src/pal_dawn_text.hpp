#pragma once

#include "pal_dawn_constants.hpp"
#include "pal_dawn_shared.hpp"
#include "pal_dawn_text_resources.hpp"
#include "pal_text_pipeline.hpp"
#include "pal_text_scene.hpp"
#include <map>
#include <tuple>

namespace bbl::pal {

using DawnTextShaderLease = DawnTextLease<WGPUShaderModule, wgpuShaderModuleRelease>;
using DawnTextPipelineLayoutLease = DawnTextLease<WGPUPipelineLayout, wgpuPipelineLayoutRelease>;

/** One device's text pipeline cache; source records retain their own leases. */
struct DawnTextRenderer {
    std::shared_ptr<DawnTextDevice> owner = std::make_shared<DawnTextDevice>();
    std::shared_ptr<DawnTextLayout> layout;
    std::shared_ptr<DawnTextPipelineLayoutLease> pipeline_layout;
    std::shared_ptr<DawnTextBuffer> quad;
    TextScenePass scene;
    std::map<std::tuple<const upstream::TextPipelineInfo*, WGPUTextureFormat, WGPUTextureFormat>,
        std::shared_ptr<DawnTextPipelineLease>> pipelines;

    DawnTextRenderer(WGPUDevice device, WGPUQueue queue, bool capture) {
        owner->device = device; owner->queue = queue; owner->capture = TextGpuCapture(capture);
    }
    ~DawnTextRenderer() { owner->retire(); }
    DawnTextRenderer(const DawnTextRenderer&) = delete;
    DawnTextRenderer& operator=(const DawnTextRenderer&) = delete;

    void ensure_layout() {
        if (layout) return;
        auto created = std::make_shared<DawnTextLayout>();
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (const auto& row : upstream::text_binding_layout) {
            WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entry.binding = row.binding;
            entry.visibility = static_cast<WGPUShaderStage>(row.visibility);
            const std::string_view kind(row.kind);
            if (kind == "uniform") entry.buffer.type = WGPUBufferBindingType_Uniform;
            else if (kind == "read-only-storage") entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            else if (kind == "unfilterable-float") {
                entry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
                entry.texture.viewDimension = WGPUTextureViewDimension_2D;
            } else throw std::runtime_error("Unmapped text bind-group layout kind.");
            entries.push_back(entry);
            created->bindings.push_back({row.binding, text_binding_role(row.name)});
        }
        WGPUBindGroupLayoutDescriptor descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = entries.size(); descriptor.entries = entries.data();
        created->layout = retain_dawn_text_resource<DawnTextLayoutLease>(owner,
            wgpuDeviceCreateBindGroupLayout(owner->device, &descriptor), "bind-group-layout");
        const WGPUBindGroupLayout group = created->layout->get();
        WGPUPipelineLayoutDescriptor pipeline_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
        pipeline_descriptor.bindGroupLayoutCount = 1; pipeline_descriptor.bindGroupLayouts = &group;
        auto created_pipeline_layout = retain_dawn_text_resource<DawnTextPipelineLayoutLease>(owner,
            wgpuDeviceCreatePipelineLayout(owner->device, &pipeline_descriptor));
        DawnTextResourceOps ops{owner};
        auto created_quad = std::make_shared<DawnTextBuffer>(ops.create_buffer(WGPUBufferUsage_Vertex,
            sizeof(upstream::text_quad_corners), "quad"));
        wgpuQueueWriteBuffer(owner->queue, created_quad->lease->get(), 0,
            upstream::text_quad_corners.data(), sizeof(upstream::text_quad_corners));
        owner->capture.write(created_quad->lease->capture_id, 0u,
            {reinterpret_cast<const std::uint8_t*>(upstream::text_quad_corners.data()), sizeof(upstream::text_quad_corners)});
        layout = std::move(created);
        pipeline_layout = std::move(created_pipeline_layout);
        quad = std::move(created_quad);
    }

    TextPipelineBinding pipeline(const upstream::TextPipelineInfo& info,
        WGPUTextureFormat color_format, WGPUTextureFormat depth_format) {
        ensure_layout();
        const auto key = std::tuple{&info, color_format, depth_format};
        if (const auto found = pipelines.find(key); found != pipelines.end())
            return {found->second, found->second, layout, quad};
        auto vertex = retain_dawn_text_resource<DawnTextShaderLease>(owner,
            load_wgsl_module(owner->device, info.vertex_shader));
        auto fragment_module = retain_dawn_text_resource<DawnTextShaderLease>(owner,
            load_wgsl_module(owner->device, info.fragment_shader));
        std::vector<std::vector<WGPUVertexAttribute>> attributes;
        std::vector<WGPUVertexBufferLayout> buffers;
        attributes.reserve(upstream::text_vertex_buffers.size());
        buffers.reserve(upstream::text_vertex_buffers.size());
        for (const auto& source : upstream::text_vertex_buffers) {
            auto& list = attributes.emplace_back();
            for (const auto& attribute : source.attributes) {
                WGPUVertexAttribute target = WGPU_VERTEX_ATTRIBUTE_INIT;
                target.shaderLocation = attribute.location; target.offset = attribute.offset;
                const std::string_view format(attribute.format);
                if (format == "float32x2") target.format = WGPUVertexFormat_Float32x2;
                else if (format == "uint32") target.format = WGPUVertexFormat_Uint32;
                else throw std::runtime_error("Unmapped text vertex attribute format.");
                list.push_back(target);
            }
            WGPUVertexBufferLayout target = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
            target.arrayStride = source.stride;
            const std::string_view step(source.step_mode);
            if (step == "vertex") target.stepMode = WGPUVertexStepMode_Vertex;
            else if (step == "instance") target.stepMode = WGPUVertexStepMode_Instance;
            else throw std::runtime_error("Unmapped text vertex step mode.");
            target.attributeCount = list.size(); target.attributes = list.data(); buffers.push_back(target);
        }
        WGPUBlendState blend = blend_state_from(info.blend);
        WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
        target.format = color_format; target.blend = info.blend_enabled ? &blend : nullptr;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = fragment_module->get(); fragment.entryPoint = string_view(info.fragment_entry);
        fragment.targetCount = 1; fragment.targets = &target;
        WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
        depth.format = depth_format;
        depth.depthCompare = dawn_depth_compare(info.depth_compare);
        depth.depthWriteEnabled = info.depth_write ? WGPUOptionalBool_True : WGPUOptionalBool_False;
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = pipeline_layout->get();
        descriptor.vertex.module = vertex->get(); descriptor.vertex.entryPoint = string_view(info.vertex_entry);
        descriptor.vertex.bufferCount = buffers.size(); descriptor.vertex.buffers = buffers.data();
        descriptor.fragment = &fragment; descriptor.depthStencil = info.has_depth ? &depth : nullptr;
        if (std::string_view(info.topology) != "triangle-list" || std::string_view(info.cull_mode) != "none" ||
            std::string_view(info.front_face) != "ccw") throw std::runtime_error("Unmapped text primitive state.");
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.cullMode = WGPUCullMode_None; descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        descriptor.multisample.count = info.sample_count;
        descriptor.multisample.alphaToCoverageEnabled = info.alpha_to_coverage;
        DawnStageConstants vertex_constants(info.vertex_constants), fragment_constants(info.fragment_constants);
        vertex_constants.apply(descriptor.vertex); fragment_constants.apply(fragment);
        auto created = retain_dawn_text_resource<DawnTextPipelineLease>(owner,
            wgpuDeviceCreateRenderPipeline(owner->device, &descriptor), "pipeline");
        if (owner->capture.enabled()) created->capture = text_pipeline_capture(info,
            color_format == WGPUTextureFormat_BGRA8Unorm ? "bgra8unorm" : "rgba8unorm", "depth24plus-stencil8");
        pipelines.emplace(key, created);
        // The admitted source installs no variant resolver; the pin aliases it.
        return {created, created, layout, quad};
    }
};

} // namespace bbl::pal
