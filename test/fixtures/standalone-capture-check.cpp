#define BBLITE_HAS_TEXT_RENDERER 0
#define BBLITE_HAS_UI 0
#define BBLITE_HAS_SPRITE_RENDERER 1
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include "pal_sdl_gpu_commands.hpp"
#include "pal_dawn_resources.hpp"
#include <cassert>
#include <deque>

struct SDL_GPUTexture { SDL_GPUTextureCreateInfo info{}; bool released = false; };
struct SDL_GPUCommandBuffer { bool consumed = false; };
struct SDL_GPURenderPass {};
struct SDL_GPUCopyPass {};
struct SDL_GPUBuffer { std::vector<std::uint8_t> bytes; };
struct SDL_GPUTransferBuffer { std::vector<std::uint8_t> bytes; bool mapped = false; bool released = false; };
struct WGPUTextureImpl {};
struct WGPUTextureViewImpl {};
struct WGPUCommandEncoderImpl {};
struct WGPUCommandBufferImpl {};
struct WGPURenderPassEncoderImpl {};

namespace {
std::deque<SDL_GPUTexture> textures;
SDL_GPUTexture swapchain_texture;
SDL_GPUCommandBuffer sdl_command;
SDL_GPURenderPass sdl_pass;
WGPUTextureImpl dawn_texture;
WGPUTextureViewImpl dawn_view, dawn_msaa_view, dawn_target_view;
WGPUCommandEncoderImpl dawn_encoder;
WGPUCommandBufferImpl dawn_command;
WGPURenderPassEncoderImpl dawn_pass;
SDL_GPUCopyPass sdl_copy;
std::deque<SDL_GPUTransferBuffer> transfers;
std::deque<WGPUTextureImpl> dawn_render_textures;
std::vector<WGPUTextureDescriptor> dawn_texture_descriptors;
std::vector<WGPUTexture> dawn_released_textures;
unsigned pass_creations = 0, pass_releases = 0, copied_regions = 0;
std::vector<std::uint32_t> updated_renderers;
SDL_GPUBuffer sprite_buffer{{0, 0, 0, 0}};
bool surface_available = true;
Uint32 surface_width = 320, surface_height = 180;
std::vector<SDL_GPUColorTargetInfo> sdl_targets;
std::vector<SDL_GPUBlitInfo> blits;
std::vector<WGPURenderPassColorAttachment> dawn_targets;
unsigned readbacks = 0, submissions = 0, presentations = 0;
SDL_GPUTexture* readback_texture = nullptr;
}

extern "C" SDL_GPUTexture* SDLCALL SDL_CreateGPUTexture(SDL_GPUDevice*, const SDL_GPUTextureCreateInfo* info) {
    textures.push_back({*info}); return &textures.back();
}
extern "C" void SDLCALL SDL_ReleaseGPUTexture(SDL_GPUDevice*, SDL_GPUTexture* texture) {
    assert(texture && !texture->released); texture->released = true;
}
extern "C" SDL_GPUCommandBuffer* SDLCALL SDL_AcquireGPUCommandBuffer(SDL_GPUDevice*) {
    sdl_command = {}; return &sdl_command;
}
extern "C" bool SDLCALL SDL_WaitAndAcquireGPUSwapchainTexture(
    SDL_GPUCommandBuffer*, SDL_Window*, SDL_GPUTexture** texture, Uint32* width, Uint32* height) {
    *texture = surface_available ? &swapchain_texture : nullptr;
    *width = surface_width; *height = surface_height; return true;
}
extern "C" bool SDLCALL SDL_SubmitGPUCommandBuffer(SDL_GPUCommandBuffer* command) {
    assert(!command->consumed); command->consumed = true; ++submissions; return true;
}
extern "C" bool SDLCALL SDL_CancelGPUCommandBuffer(SDL_GPUCommandBuffer* command) {
    assert(!command->consumed); command->consumed = true; return true;
}
extern "C" SDL_GPURenderPass* SDLCALL SDL_BeginGPURenderPass(
    SDL_GPUCommandBuffer*, const SDL_GPUColorTargetInfo* targets, Uint32 count, const SDL_GPUDepthStencilTargetInfo*) {
    assert(count == 1); sdl_targets.push_back(*targets); return &sdl_pass;
}
extern "C" void SDLCALL SDL_EndGPURenderPass(SDL_GPURenderPass*) {}
extern "C" void SDLCALL SDL_BlitGPUTexture(SDL_GPUCommandBuffer*, const SDL_GPUBlitInfo* blit) { blits.push_back(*blit); }
extern "C" SDL_GPUTransferBuffer* SDLCALL SDL_CreateGPUTransferBuffer(SDL_GPUDevice*, const SDL_GPUTransferBufferCreateInfo* info) {
    transfers.emplace_back(std::vector<std::uint8_t>(info->size)); return &transfers.back();
}
extern "C" void SDLCALL SDL_ReleaseGPUTransferBuffer(SDL_GPUDevice*, SDL_GPUTransferBuffer* buffer) {
    assert(!buffer->mapped && !buffer->released); buffer->released = true;
}
extern "C" void* SDLCALL SDL_MapGPUTransferBuffer(SDL_GPUDevice*, SDL_GPUTransferBuffer* buffer, bool cycle) {
    assert(cycle && !buffer->mapped && !buffer->released); buffer->mapped = true; return buffer->bytes.data();
}
extern "C" void SDLCALL SDL_UnmapGPUTransferBuffer(SDL_GPUDevice*, SDL_GPUTransferBuffer* buffer) {
    assert(buffer->mapped); buffer->mapped = false;
}
extern "C" SDL_GPUCopyPass* SDLCALL SDL_BeginGPUCopyPass(SDL_GPUCommandBuffer*) { return &sdl_copy; }
extern "C" void SDLCALL SDL_EndGPUCopyPass(SDL_GPUCopyPass*) {}
extern "C" void SDLCALL SDL_UploadToGPUBuffer(SDL_GPUCopyPass*, const SDL_GPUTransferBufferLocation* source,
    const SDL_GPUBufferRegion* destination, bool cycle) {
    assert(!source->transfer_buffer->mapped && !source->transfer_buffer->released && source->offset % 4 == 0);
    if (cycle) std::fill(destination->buffer->bytes.begin(), destination->buffer->bytes.end(), 0);
    assert(destination->offset + destination->size <= destination->buffer->bytes.size());
    std::memcpy(destination->buffer->bytes.data() + destination->offset,
        source->transfer_buffer->bytes.data() + source->offset, destination->size);
    ++copied_regions;
}
extern "C" WGPUTexture wgpuDeviceCreateTexture(WGPUDevice, const WGPUTextureDescriptor* descriptor) {
    dawn_texture_descriptors.push_back(*descriptor); dawn_render_textures.emplace_back(); return &dawn_render_textures.back();
}
extern "C" void wgpuSurfaceGetCurrentTexture(WGPUSurface, WGPUSurfaceTexture* target) {
    target->texture = surface_available ? &dawn_texture : nullptr;
}
extern "C" WGPUCommandEncoder wgpuDeviceCreateCommandEncoder(WGPUDevice, const WGPUCommandEncoderDescriptor*) { return &dawn_encoder; }
extern "C" WGPURenderPassEncoder wgpuCommandEncoderBeginRenderPass(WGPUCommandEncoder, const WGPURenderPassDescriptor* descriptor) {
    assert(descriptor->colorAttachmentCount == 1); dawn_targets.push_back(*descriptor->colorAttachments); return &dawn_pass;
}
extern "C" void wgpuRenderPassEncoderEnd(WGPURenderPassEncoder) {}
extern "C" WGPUCommandBuffer wgpuCommandEncoderFinish(WGPUCommandEncoder, const WGPUCommandBufferDescriptor*) { return &dawn_command; }
extern "C" WGPUTextureView wgpuTextureCreateView(WGPUTexture, const WGPUTextureViewDescriptor*) { return &dawn_view; }
extern "C" void wgpuQueueSubmit(WGPUQueue, std::size_t count, const WGPUCommandBuffer*) { assert(count == 1); ++submissions; }
extern "C" WGPUStatus wgpuSurfacePresent(WGPUSurface) { ++presentations; return WGPUStatus_Success; }
extern "C" void wgpuTextureRelease(WGPUTexture texture) { dawn_released_textures.push_back(texture); }
extern "C" void wgpuTextureViewRelease(WGPUTextureView) {}
extern "C" void wgpuCommandEncoderRelease(WGPUCommandEncoder) {}
extern "C" void wgpuCommandBufferRelease(WGPUCommandBuffer) {}
extern "C" void wgpuRenderPassEncoderRelease(WGPURenderPassEncoder) {}
extern "C" void wgpuBufferRelease(WGPUBuffer) {}

namespace bbl::pal {
struct TextGpuCapture;
#include "capture-options.hpp"
void CaptureGate::maybe_write_standalone_render_capture(const char*, const Engine&, std::uint32_t, std::uint32_t, long, TextGpuCapture*) {}
[[noreturn]] void gpu_error(const char* operation) { throw std::runtime_error(operation); }
[[noreturn]] void dawn_error(const std::string& operation) { throw std::runtime_error(operation); }
#include "buffer-batch.hpp"
SDL_GPUSampleCount gpu_sample_count_from(std::uint32_t samples) {
    assert(samples == 4); return SDL_GPU_SAMPLECOUNT_4;
}
struct Pass { SpriteRendererHandle renderer; };
using DawnEffectPass = Pass;
using SpritePass = Pass;
using DawnSpritePass = Pass;
void record_effect_pass(SDL_GPUCommandBuffer*, SDL_GPURenderPass*, Engine&, Pass&, EffectWrapperHandle) {}
void record_dawn_effect_pass(WGPURenderPassEncoder, const Pass&) {}
void record_sprite_pass(SDL_GPUCommandBuffer*, SDL_GPURenderPass*, Engine&, Pass&, std::uint32_t, std::uint32_t) {}
void record_dawn_sprite_pass(WGPURenderPassEncoder, Engine&, Pass&) {}
void release_sprite_pass(SDL_GPUDevice*, Pass&) { ++pass_releases; }
void release_dawn_sprite_pass(Pass&) { ++pass_releases; }
Pass create_sprite_pass(SDL_GPUDevice*, Engine&, SpriteRendererHandle handle, const std::vector<SDL_GPUTexture*>&, SDL_GPUTextureFormat) {
    ++pass_creations; return {handle};
}
Pass create_dawn_sprite_pass(WGPUDevice, WGPUQueue, int&, Engine&, SpriteRendererHandle handle,
    const std::vector<WGPUTexture>&, const std::vector<WGPUTextureView>&, WGPUTextureFormat) {
    ++pass_creations; return {handle};
}
void run_sprite_renderer_before_update(Engine&, SpriteRendererHandle handle, double) { updated_renderers.push_back(handle.value); }
void sync_sprite_pass_layers(SDL_GPUDevice*, Engine&, Pass&, const std::vector<SDL_GPUTexture*>&) {}
void upload_sprite_pass(SDL_GPUDevice*, Engine&, Pass& pass, double, GpuBufferUploadBatch& uploads) {
    const auto value = static_cast<std::uint8_t>(pass.renderer.value + 1);
    uploads.update(&sprite_buffer, pass.renderer.value, &value, 1);
}
void save_texture_png(SDL_GPUDevice*, SdlGpuCommand& command, SDL_GPUTexture* texture, SDL_GPUTextureFormat,
    std::uint32_t, std::uint32_t, const std::string&) {
    ++readbacks; readback_texture = texture; assert(command.submit());
}
struct DawnDevice {
    WGPUDevice device = nullptr; WGPUQueue queue = nullptr; WGPUSurface surface = nullptr;
    WGPUTextureFormat surface_format = WGPUTextureFormat_RGBA8Unorm;
    std::string uncaptured_error;
};
struct DawnSurfaceCapture { DawnBuffer readback; };
DawnSurfaceCapture begin_dawn_surface_capture(WGPUDevice, WGPUCommandEncoder, WGPUTexture texture, std::uint32_t, std::uint32_t) {
    assert(texture == &dawn_texture); ++readbacks; return {};
}
void finish_dawn_surface_capture(DawnDevice&, DawnSurfaceCapture&, std::uint32_t, std::uint32_t, const std::string&) {}

struct Context {
    Engine engine;
    FrameOptions frame_options;
    CaptureGate captures{frame_options, 5, &engine};
    long frame = 0;
    std::uint32_t width = 320, height = 180, samples = 1;
    double delta_ms = 0;
    std::vector<Pass> passes;
    bool canvas_only = true, capture_ui = false;
    void discard_frame() {}
    Context() {
        engine.effect_renderers.emplace_back();
        engine.registered_effect_renderers.push_back(EffectRendererHandle{0});
        engine.sprite_renderers.emplace_back();
    }
};
struct SdlContext : Context {
    SDL_GPUDevice* device = nullptr;
    SDL_Window* window = nullptr;
    SDL_GPUTextureFormat swapchain_format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* resolve = nullptr;
    SDL_GPUTexture* swapchain = nullptr;
    std::uint32_t color_width = 0, color_height = 0;
    bool capture_run = false, capture_frame = false;
    SdlGpuCommand command{nullptr};
    std::vector<SDL_GPUTexture*> render_textures;
    std::unique_ptr<GpuBufferUploadBatch> buffer_uploads = std::make_unique<GpuBufferUploadBatch>(device);
};
struct DawnContext : Context {
    DawnDevice state;
    WGPUSurfaceTexture surface_texture{};
    DawnTexture surface;
    DawnTextureView surface_view;
    WGPUTextureView msaa_view = &dawn_msaa_view;
    DawnCommandEncoder encoder;
    std::vector<WGPUTextureView> render_texture_views;
    std::vector<WGPUTexture> render_textures;
    int mips = 0;
};
#include "SdlEffect.hpp"
#include "SdlSprite.hpp"
#include "DawnEffect.hpp"
#include "DawnSprite.hpp"
}

using namespace bbl;
using namespace bbl::pal;

void reset_observations() {
    sdl_targets.clear(); dawn_targets.clear(); blits.clear();
    readbacks = submissions = presentations = 0; readback_texture = nullptr;
}

template <typename Renderer>
void configure(Renderer& renderer, bool capture) {
    renderer.frame_options.screenshot_frame = 1;
    if (capture) renderer.frame_options.screenshot_path = "capture.png";
    renderer.passes.push_back({SpriteRendererHandle{0}});
}

void check_sdl() {
    for (const bool capture : {false, true}) for (const unsigned samples : {1u, 4u}) {
        SdlEffect renderer;
        configure(renderer, capture);
        renderer.capture_run = renderer.captures.requested(); renderer.samples = samples;
        const auto allocated = textures.size();
        for (long frame = 0; frame < 3; ++frame) {
            reset_observations(); renderer.frame = frame;
            assert(renderer.acquire()); renderer.synchronize(); renderer.encode(); renderer.present();
            assert(textures.size() - allocated == static_cast<std::size_t>(capture) + (samples > 1));
            SDL_GPUTexture* destination = capture ? renderer.resolve : &swapchain_texture;
            assert(sdl_targets.size() == 1);
            const auto target = sdl_targets.front();
            assert(target.texture == (samples > 1 ? renderer.color : destination));
            assert(target.resolve_texture == (samples > 1 ? destination : nullptr));
            assert(target.store_op == (samples > 1 ? SDL_GPU_STOREOP_RESOLVE : SDL_GPU_STOREOP_STORE));
            assert(blits.size() == static_cast<std::size_t>(capture));
            if (capture) assert(blits[0].source.texture == renderer.resolve && blits[0].destination.texture == &swapchain_texture);
            assert(readbacks == static_cast<unsigned>(capture && frame == 1) && submissions == 1);
            if (readbacks) assert(readback_texture == renderer.resolve);
        }
        if (renderer.color) SDL_ReleaseGPUTexture(nullptr, renderer.color);
        if (renderer.resolve) SDL_ReleaseGPUTexture(nullptr, renderer.resolve);
    }
    for (bool capture : {false, true}) {
        SdlSprite renderer;
        configure(renderer, capture); renderer.capture_run = renderer.captures.requested();
        const auto allocated = textures.size();
        for (long frame = 0; frame < 3; ++frame) {
            reset_observations(); renderer.frame = frame;
            assert(renderer.acquire()); renderer.encode(); renderer.present();
            assert(textures.size() - allocated == static_cast<std::size_t>(capture));
            assert(sdl_targets.size() == 2);
            for (const auto& target : sdl_targets) assert(target.texture == (capture ? renderer.color : &swapchain_texture));
            assert(blits.size() == static_cast<std::size_t>(capture));
            assert(readbacks == static_cast<unsigned>(capture && frame == 1) && submissions == 1);
            if (readbacks) assert(readback_texture == renderer.color);
        }
        // A sprite's explicit render texture takes precedence over the surface capture target.
        renderer.canvas_only = false;
        renderer.engine.sprite_renderers[0].has_target = true;
        renderer.engine.sprite_renderers[0].target = SpriteRenderTextureHandle{0};
        SDL_GPUTexture explicit_target;
        renderer.render_textures.push_back(&explicit_target);
        reset_observations(); assert(renderer.acquire()); renderer.encode(); renderer.present();
        assert(sdl_targets.size() == 1 && sdl_targets[0].texture == &explicit_target);
        SDL_GPUTexture* previous = renderer.color;
        surface_width += 1;
        assert(renderer.acquire()); renderer.command.submit();
        assert((renderer.color != previous) == capture);
        if (capture) assert(previous->released && renderer.color->info.width == surface_width);
        surface_width -= 1;
        if (renderer.color) SDL_ReleaseGPUTexture(nullptr, renderer.color);
    }
}

template <typename Renderer>
void check_dawn(bool effect) {
    for (bool capture : {false, true}) for (unsigned samples : {1u, 4u}) for (bool ui : {false, true}) {
        Renderer renderer;
        configure(renderer, capture); renderer.samples = samples; renderer.capture_ui = ui;
        for (long frame = 0; frame < 3; ++frame) {
            reset_observations(); renderer.frame = frame;
            assert(renderer.acquire()); renderer.encode(); renderer.present();
            assert(dawn_targets.size() == (effect ? 1u : 2u));
            for (const auto& target : dawn_targets) {
                assert(target.view == (effect && samples > 1 ? &dawn_msaa_view : &dawn_view));
                assert(target.resolveTarget == (effect && samples > 1 ? &dawn_view : nullptr));
            }
            assert(readbacks == static_cast<unsigned>(capture && frame == 1));
            assert(submissions == 1 && presentations == 1);
            assert(!renderer.encoder && !renderer.surface && !renderer.surface_view);
        }
        if constexpr (std::is_same_v<Renderer, DawnSprite>) {
            renderer.canvas_only = false;
            renderer.engine.sprite_renderers[0].has_target = true;
            renderer.engine.sprite_renderers[0].target = SpriteRenderTextureHandle{0};
            renderer.render_texture_views.push_back(&dawn_target_view);
            reset_observations(); assert(renderer.acquire()); renderer.encode(); renderer.present();
            assert(dawn_targets.size() == 1 && dawn_targets[0].view == &dawn_target_view);
        }
    }
}

template <typename Renderer>
void check_registration() {
    Renderer renderer;
    auto& engine = renderer.engine;
    engine.sprite_renderers.emplace_back();
    engine.registered_sprite_renderers = {SpriteRendererHandle{1}, SpriteRendererHandle{0}};
    pass_creations = pass_releases = 0;
    renderer.sync_renderer_passes();
    assert(pass_creations == 2 && pass_releases == 0 && renderer.passes[0].renderer.value == 1);
    renderer.sync_renderer_passes();
    assert(pass_creations == 2 && pass_releases == 0);
    engine.registered_sprite_renderers = {SpriteRendererHandle{0}, SpriteRendererHandle{1}};
    renderer.sync_renderer_passes();
    assert(pass_creations == 4 && pass_releases == 2 && renderer.passes[0].renderer.value == 0);
    engine.registered_sprite_renderers.clear();
    renderer.sync_renderer_passes();
    assert(renderer.passes.empty() && pass_releases == 4);

    engine.sprite_render_textures.emplace_back();
    engine.sprite_render_textures[0].width = 20;
    engine.sprite_render_textures[0].height = 30;
    renderer.sync_render_textures();
    const auto texture = renderer.render_textures[0];
    assert(texture);
    renderer.sync_render_textures();
    assert(renderer.render_textures[0] == texture);
    if constexpr (std::is_same_v<Renderer, SdlSprite>) {
        assert(texture->info.width == 20 && texture->info.height == 30);
        assert(texture->info.usage == (SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER));
    } else {
        assert(renderer.render_texture_views[0]);
        const auto& descriptor = dawn_texture_descriptors.back();
        assert(descriptor.size.width == 20 && descriptor.size.height == 30);
        assert(descriptor.usage == (WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding));
    }
    engine.sprite_render_textures[0].disposed = true;
    renderer.sync_render_textures();
    assert(!renderer.render_textures[0]);
    if constexpr (std::is_same_v<Renderer, SdlSprite>) assert(texture->released);
    else assert(!renderer.render_texture_views[0] && dawn_released_textures.back() == texture);
}

void check_batched_uploads() {
    const auto first_transfer = transfers.size();
    {
        SdlSprite renderer;
        renderer.engine.sprite_renderers.emplace_back();
        renderer.engine.registered_sprite_renderers = {SpriteRendererHandle{0}, SpriteRendererHandle{1}};
        for (unsigned frame = 0; frame < 3; ++frame) {
            reset_observations(); updated_renderers.clear(); copied_regions = 0;
            renderer.synchronize();
            assert(updated_renderers == std::vector<std::uint32_t>({0, 1}));
            assert(submissions == 1 && copied_regions == 2);
            assert(sprite_buffer.bytes == std::vector<std::uint8_t>({1, 2, 0, 0}));
            assert(transfers.size() == first_transfer + 1 && !transfers.back().released);
        }
        renderer.engine.registered_sprite_renderers.clear();
        reset_observations(); renderer.synchronize();
        assert(submissions == 0);
    }
    assert(transfers.back().released);
}

int main() {
    check_sdl();
    check_dawn<DawnEffect>(true);
    check_dawn<DawnSprite>(false);
    check_registration<SdlSprite>();
    check_registration<DawnSprite>();
    check_batched_uploads();
    surface_available = false;
    SdlEffect sdl_effect; SdlSprite sdl_sprite; DawnEffect dawn_effect; DawnSprite dawn_sprite;
    assert(!sdl_effect.acquire() && !sdl_sprite.acquire() && !dawn_effect.acquire() && !dawn_sprite.acquire());
}
