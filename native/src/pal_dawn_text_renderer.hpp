#pragma once
#include "pal_dawn_text.hpp"
#include <bblite/upstream_text_renderer.hpp>

namespace bbl::pal {
struct DawnStandaloneTextOps : DawnTextResourceOps {
    DawnTextRenderer& renderer;
    WGPUTextureFormat format;
    WGPUCommandEncoder encoder = nullptr;
    WGPUTextureView target = nullptr;
    DawnRenderPass owned_pass;
    DawnStandaloneTextOps(DawnTextRenderer& renderer,WGPUTextureFormat format)
        : DawnTextResourceOps(renderer.owner),renderer(renderer),format(format) { renderer.ensure_layout(); }
    TextPipelineBinding resolve_text_renderer_pipeline() {
        auto binding=renderer.pipeline(text_pipeline_info(1,false,false,false),format,WGPUTextureFormat_Undefined);
        if(text_weight_installed)binding.variant_pipeline=renderer.pipeline(text_pipeline_info(1,false,false,false,true),format,WGPUTextureFormat_Undefined).pipeline;
        return binding;
    }
    std::shared_ptr<void> text_renderer_quad() { return renderer.quad; }
    void begin_text_renderer_pass(const TextRendererState& renderer) {
        WGPURenderPassColorAttachment attachment=WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view=target;
        attachment.clearValue={renderer.clear_value.r,renderer.clear_value.g,renderer.clear_value.b,renderer.clear_value.a};
        attachment.loadOp=renderer.clear?WGPULoadOp_Clear:WGPULoadOp_Load;
        attachment.storeOp=WGPUStoreOp_Store;
        WGPURenderPassDescriptor descriptor=WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount=1;descriptor.colorAttachments=&attachment;
        owned_pass=wgpuCommandEncoderBeginRenderPass(encoder,&descriptor);
        pass=owned_pass.get();
    }
    void end_text_renderer_pass() { wgpuRenderPassEncoderEnd(pass);owned_pass.reset();pass=nullptr; }
};
} // namespace bbl::pal
