#pragma once
#include "pal_sdl_gpu_text.hpp"
#include <bblite/upstream_text_renderer.hpp>

namespace bbl::pal {
struct SdlStandaloneTextOps : SdlTextResourceOps {
    SdlTextRenderer& renderer;
    SDL_GPUTextureFormat format;
    SDL_GPUTexture* target = nullptr;
    SdlRenderPass owned_pass;
    SdlStandaloneTextOps(SdlTextRenderer& renderer,SDL_GPUTextureFormat format)
        : SdlTextResourceOps(renderer.owner),renderer(renderer),format(format) {
        renderer.ensure_quad();sampler=renderer.sampler;
    }
    TextPipelineBinding resolve_text_renderer_pipeline() {
        auto binding=renderer.pipeline(text_pipeline_info(1,false,false,false),format,SDL_GPU_TEXTUREFORMAT_INVALID);
        if(text_weight_installed)binding.variant_pipeline=renderer.pipeline(text_pipeline_info(1,false,false,false,true),format,SDL_GPU_TEXTUREFORMAT_INVALID).pipeline;
        return binding;
    }
    std::shared_ptr<void> text_renderer_quad() { return renderer.quad; }
    void begin_text_renderer_pass(const TextRendererState& renderer) {
        SDL_GPUColorTargetInfo attachment{};
        attachment.texture=target;
        attachment.clear_color={renderer.clear_value.r,renderer.clear_value.g,renderer.clear_value.b,renderer.clear_value.a};
        attachment.load_op=renderer.clear?SDL_GPU_LOADOP_CLEAR:SDL_GPU_LOADOP_LOAD;
        attachment.store_op=SDL_GPU_STOREOP_STORE;
        owned_pass=SDL_BeginGPURenderPass(command,&attachment,1,nullptr);
        pass=owned_pass.get();
        if(!pass)gpu_error("SDL_BeginGPURenderPass text");
    }
    void end_text_renderer_pass() { owned_pass.end();pass=nullptr; }
};
} // namespace bbl::pal
