// The shared Dawn 2D frame driver: sprite renderers or a primary Canvas2D
// surface, with no `SceneContext`.
//
// The drawing is not here — it is in `pal_dawn_sprite.hpp`, as the two
// halves of a rendering context, so the scene renderer composes the same
// pass into its own frame for a HUD over 3D. What is here is only what an
// engine owns: the window, the device, the frame loop, the capture and the
// present. This translation unit exists because a scene registering no
// `SceneContext` generates no camera math and no render plan, so
// `pal_dawn.cpp` cannot be compiled for it at all.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_platform_events.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"
#include "pal_frame_session.hpp"
#if BBLITE_HAS_DAWN && BBLITE_HAS_TEXT_RENDERER
#include "pal_dawn_text_renderer.hpp"
#endif

#if BBLITE_HAS_DAWN && BBLITE_HAS_SPRITE_RENDERER
#include "pal_dawn_sprite.hpp"
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
#include "pal_sprite_ui_dawn.hpp"
#endif

namespace bbl::pal {

#if BBLITE_HAS_DAWN && (BBLITE_HAS_SPRITE_RENDERER || BBLITE_HAS_CANVAS_RENDERER || BBLITE_HAS_TEXT_RENDERER)

namespace {
class DawnSpriteRun : public FrameSession {
    DawnDevice state;
#if BBLITE_HAS_TEXT_RENDERER
    std::unique_ptr<DawnTextRenderer> text_renderer;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
    // The pinned mip generator, for an atlas the loader gave a chain.
    DawnMipGenerator mips;
    std::vector<DawnSpritePass> passes;
    std::vector<WGPUTexture> render_textures;
    std::vector<WGPUTextureView> render_texture_views;
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    UiRmlRuntime* ui_runtime = nullptr;
    SpriteUiDawnResources ui_resources;
#endif
    DawnTexture surface;
    DawnTextureView surface_view;
    DawnCommandEncoder encoder;
    WGPUSurfaceTexture surface_texture{};
    std::uint32_t width = 0, height = 0;
    double delta_ms = 0;
    bool canvas_only = false, capture_ui = false, mem_profile = false;
#if BBLITE_HAS_TEXT_RENDERER
    std::optional<DawnStandaloneTextOps> text_operations;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
    void sync_render_textures() {
        render_textures.resize(
            engine.sprite_render_textures.size(), nullptr);
        render_texture_views.resize(
            engine.sprite_render_textures.size(), nullptr);
        // The one refusal walk covers every disposed record, so it
        // runs once per sync -- at the first disposed record, before
        // any release -- rather than once per record per frame.
        bool disposed_refused = false;
        for (std::size_t index = 0;
             index < engine.sprite_render_textures.size();
             ++index) {
            const SpriteRenderTextureRecord& record =
                engine.sprite_render_textures[index];
            WGPUTexture& texture = render_textures[index];
            WGPUTextureView& view = render_texture_views[index];
            if (record.disposed) {
                if (!disposed_refused) {
                    refuse_disposed_sprite_render_texture_in_use(
                        engine);
                    disposed_refused = true;
                }
                if (view) wgpuTextureViewRelease(view);
                if (texture) wgpuTextureRelease(texture);
                view = nullptr;
                texture = nullptr;
                continue;
            }
            if (texture) continue;
            WGPUTextureDescriptor descriptor =
                WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.dimension = WGPUTextureDimension_2D;
            descriptor.format = state.surface_format;
            descriptor.usage =
                WGPUTextureUsage_RenderAttachment |
                WGPUTextureUsage_TextureBinding;
            descriptor.size = {record.width, record.height, 1};
            texture = wgpuDeviceCreateTexture(
                state.device, &descriptor);
            if (!texture) {
                dawn_error("sprite render texture creation failed.");
            }
            view = create_dawn_texture_view(texture, nullptr);
            if (!view) {
                wgpuTextureRelease(std::exchange(texture, nullptr));
                dawn_error("sprite render texture view creation failed.");
            }
        }
    }
    void sync_renderer_passes() {
        if (sprite_passes_match_registered(engine, passes)) return;
        for (DawnSpritePass& pass : passes) {
            release_dawn_sprite_pass(pass);
        }
        passes.clear();
        for (const SpriteRendererHandle& handle :
             engine.registered_sprite_renderers) {
            passes.push_back(create_dawn_sprite_pass(
                state.device,
                state.queue,
                mips,
                engine,
                handle,
                render_textures,
                render_texture_views,
                state.surface_format));
        }
    }
#endif
    void discard_frame() {
#if BBLITE_HAS_TEXT_RENDERER
        text_operations.reset();
#endif
    }
public:
    static constexpr FrameAcquirePhase acquire_phase = FrameAcquirePhase::before_uploads;
    explicit DawnSpriteRun(Engine& target) : FrameSession(target) {}
    ~DawnSpriteRun() {
        discard_frame();
        encoder.reset();
        surface_view.reset();
        surface.reset();

#if BBLITE_HAS_TEXT_RENDERER
        text_renderer.reset();
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        release_sprite_ui_dawn_resources(ui_resources);
        destroy_ui_rml_runtime(ui_runtime);
        ui_runtime = nullptr;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        for (DawnSpritePass& pass : passes) {
            release_dawn_sprite_pass(pass);
        }
        release_dawn_mip_generator(mips);
        for (WGPUTextureView view : render_texture_views) {
            if (view) wgpuTextureViewRelease(view);
        }
        for (WGPUTexture texture : render_textures) {
            if (texture) wgpuTextureRelease(texture);
        }
#endif
        state.release();
    }
    void setup() {
        reject_unsupported_frame_options(frame_options, "Dawn sprites", true, false);
        canvas_only = !bbl::has_sprite_renderers(engine) && engine.registered_text_renderers.empty();
        if (canvas_only
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            && engine.primary_canvas.value >= engine.ui_elements.size()
#endif
        ) {
            throw std::runtime_error(
                "The 2D frame host requires a sprite renderer or primary Canvas2D surface.");
        }
        const DeviceOptions device_options = frame_device_options(frame_options);
        create_dawn_device(engine.options, device_options, state);
#if BBLITE_HAS_TEXT_RENDERER
        text_renderer=std::make_unique<DawnTextRenderer>(state.device,state.queue,!frame_options.render_capture_path.empty());
#endif
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        ui_runtime = create_ui_rml_runtime(
            engine,
            state.window,
            static_cast<std::uint32_t>(engine.options.width),
            static_cast<std::uint32_t>(engine.options.height));
#endif

#if BBLITE_HAS_SPRITE_RENDERER

        sync_render_textures();
        sync_renderer_passes();
#endif

        width =
            static_cast<std::uint32_t>(engine.options.width);
        height =
            static_cast<std::uint32_t>(engine.options.height);
        if (width == 0 || height == 0) {
            dawn_error("sprite surface has a zero extent.");
        }
        mem_profile = environment_variable("BBLITE_MEM_PROFILE") == "1";
        capture_ui = frame_options.capture_ui || canvas_only;

    }
    FramePreparation prepare() {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        poll_platform_events(
            engine,
            running,
            frame_options.test_pass,
            [&](SDL_Event& event) {
                return handle_ui_rml_event(*ui_runtime, event);
            });
#else
        poll_platform_events(
            engine, running, frame_options.test_pass);
#endif
        sync_engine_canvas_size(state.window, engine);
        if (resize_dawn_surface(state, engine.options)) {
            width = state.surface_width;
            height = state.surface_height;
        }
        input_replay.dispatch(frame, state.window, engine);
        return FramePreparation::ready;
    }
    FramePreparation update() {
        delta_ms = advance_frame(
            engine,
            frame_clock,
            frame_options.frame_delta_ms);
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        // Browser layout observes DOM changes made by this turn's RAF
        // callbacks before painting the frame.
        update_ui_rml_runtime(*ui_runtime, width, height);
#endif
        begin_measurement();
#if BBLITE_HAS_TEXT_RENDERER
        // Text contexts update right after layout and before the sprite
        // contexts, the one slot both hosts give them; the encoder and
        // target they record into arrive once the frame's texture does.
        text_renderer->owner->capture.begin_frame(static_cast<std::uint64_t>(frame));
        auto& text_ops = text_operations.emplace(*text_renderer, state.surface_format);
        for(const auto& renderer:engine.registered_text_renderers)update_text_renderer(*renderer,width,height,state.device,text_ops);
#endif

#if BBLITE_HAS_SPRITE_RENDERER
        sync_render_textures();
        sync_renderer_passes();
#endif
        return FramePreparation::ready;
    }
    bool acquire() {
        surface_texture = {};
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        surface = surface_texture.texture;
        if (!surface_texture.texture) {
            discard_frame();
            return false;
        }
        surface_view = create_dawn_texture_view(surface_texture.texture, nullptr);
        return true;
    }
    void synchronize() {
        // Every context updates before any records, which is the
        // pinned loop's order.
#if BBLITE_HAS_SPRITE_RENDERER
        for (DawnSpritePass& pass : passes) {
            // `spriteRendererUpdate` runs the renderer's own hooks
            // first, so one that moves a sprite or a layer is seen by
            // this frame's mirror rebuild and upload rather than the
            // next one's.
            run_sprite_renderer_before_update(
                engine, pass.renderer, delta_ms);
            // A scene callback may have added, removed or disposed a
            // layer since the last frame; the GPU mirror is addressed
            // by position, so it is rebuilt before anything reads it.
            sync_dawn_sprite_pass_layers(
                state.device,
                state.queue,
                mips,
                engine,
                pass,
                render_textures,
                render_texture_views);
            upload_dawn_sprite_pass(
                state.device,
                state.queue,
                engine,
                pass,
                width,
                height,
                delta_ms);
        }
#endif
    }
    void encode() {
#if BBLITE_HAS_TEXT_RENDERER
        auto& text_ops = *text_operations;
#endif
        encoder = wgpuDeviceCreateCommandEncoder(state.device, nullptr);
#if BBLITE_HAS_TEXT_RENDERER
        text_ops.encoder=encoder;text_ops.target=surface_view;
        for(const auto& renderer:engine.registered_text_renderers)record_text_renderer(*renderer,text_ops);
#endif
        if (canvas_only) {
            WGPURenderPassColorAttachment target = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            target.view = surface_view;
            target.loadOp = WGPULoadOp_Clear;
            target.storeOp = WGPUStoreOp_Store;
            WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            descriptor.colorAttachmentCount = 1;
            descriptor.colorAttachments = &target;
            DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
            wgpuRenderPassEncoderEnd(pass);
            pass.reset();
        }
#if BBLITE_HAS_SPRITE_RENDERER
        for (std::size_t first_index = 0;
             first_index < passes.size();) {
            const SpriteRendererRecord& first_renderer =
                engine.sprite_renderers[
                    passes[first_index].renderer.value];
            WGPUTextureView target_view = surface_view;
            if (first_renderer.has_target) {
                target_view = render_texture_views[
                    first_renderer.target.value];
            }
            const std::size_t end_index =
                sprite_pass_target_run_end(
                    engine, passes, first_index);

            WGPURenderPassColorAttachment color_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color_attachment.view = target_view;
            color_attachment.loadOp = first_renderer.clear
                ? WGPULoadOp_Clear
                : WGPULoadOp_Load;
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                first_renderer.clear_value.r,
                first_renderer.clear_value.g,
                first_renderer.clear_value.b,
                first_renderer.clear_value.a};
            WGPURenderPassDescriptor pass_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &color_attachment;
            DawnRenderPass render_pass{wgpuCommandEncoderBeginRenderPass(
                    encoder,
                    &pass_descriptor)};
            for (
                std::size_t index = first_index;
                index < end_index;
                ++index
            ) {
                record_dawn_sprite_pass(
                    render_pass, engine, passes[index]);
            }
            wgpuRenderPassEncoderEnd(render_pass);
            render_pass.reset();
            first_index = end_index;
        }
#endif
    }
    void present() {
        const bool capture_frame =
            frame >= frame_options.screenshot_frame &&
            !captures.screenshot_saved &&
            !frame_options.screenshot_path.empty();
        captures.maybe_write_standalone_render_capture(
            "dawn", engine, width, height, frame
#if BBLITE_HAS_TEXT_RENDERER
            ,&text_renderer->owner->capture
#endif
        );
        DawnSurfaceCapture capture{};
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        const UiRenderFrame& ui_frame =
            record_ui_rml_frame(*ui_runtime, width, height);
#endif
        if (capture_frame && !capture_ui) {
            capture = begin_dawn_surface_capture(
                state.device,
                encoder,
                surface_texture.texture,
                width,
                height);
        }
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        render_sprite_ui_dawn_frame(
            state,
            encoder,
            surface_texture.texture,
            surface_view,
            ui_resources,
            ui_frame);
#endif
        if (capture_frame && capture_ui) {
            capture = begin_dawn_surface_capture(
                state.device,
                encoder,
                surface_texture.texture,
                width,
                height);
        }

        DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
        submit_dawn_command(state.queue, command);
        command.reset();
        encoder.reset();

        if (capture_frame) {
            finish_dawn_surface_capture(
                state,
                capture,
                width,
                height,
                frame_options.screenshot_path);
            captures.screenshot_saved = true;
        }
        capture.readback.reset();

        wgpuSurfacePresent(state.surface);
        surface_view.reset();
        surface.reset();
        if (!state.uncaptured_error.empty()) {
            dawn_error(state.uncaptured_error);
        }
    }
    void complete() {
        FrameSession::complete([&] {
            if (mem_profile && frame % memory_profile_frames == 0)
                print_memory_frame_profile(frame, engine, 0, 0, 0, 0);
        });
        discard_frame();
    }
    void report() { FrameSession::report("Dawn", "D3D12"); }
};
} // namespace

bool run_sprite_dawn_engine(Engine& engine) {
    DawnSpriteRun renderer(engine);
    renderer.setup();
    while (conduct_frame(renderer) != FrameOutcome::stopped) {}
    renderer.report();
    return true;
}
#endif

} // namespace bbl::pal
