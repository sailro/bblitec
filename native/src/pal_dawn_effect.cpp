// The Dawn frame driver for a scene that registers effect renderers and no
// `SceneContext`.
//
// The drawing is not here — it is in `pal_dawn_effect.hpp`, as the two halves
// of a rendering context, so the frame-graph task composes the same pass into
// a scene's own frame. What is here is only what an engine owns: the window,
// the device, the frame loop, the capture and the present. This translation
// unit exists because a scene registering no `SceneContext` generates no
// camera math and no render plan, so `pal_dawn.cpp` cannot be compiled for it
// at all.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_platform_events.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"
#include "pal_frame_session.hpp"

#if BBLITE_HAS_DAWN && BBLITE_HAS_EFFECT_RENDERER
#include "pal_dawn_effect.hpp"
#endif

namespace bbl::pal {

#if BBLITE_HAS_DAWN && BBLITE_HAS_EFFECT_RENDERER

namespace {
class DawnEffectRun : public FrameSession {
    DawnDevice state;
    std::vector<DawnEffectPass> passes;
    DawnTexture msaa_texture;
    DawnTextureView msaa_view;
    DawnTexture surface;
    DawnTextureView surface_view;
    DawnCommandEncoder encoder;
    WGPUSurfaceTexture surface_texture{};
    std::uint32_t width = 0, height = 0, samples = 1;
    void recreate_msaa_target() {
        msaa_view.reset();
        msaa_texture.reset();
        msaa_view = nullptr;
        msaa_texture = nullptr;
        if (samples == 1) return;
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.usage = WGPUTextureUsage_RenderAttachment;
        descriptor.size = {width, height, 1};
        descriptor.format = state.surface_format;
        descriptor.sampleCount = samples;
        msaa_texture = wgpuDeviceCreateTexture(state.device, &descriptor);
        if (!msaa_texture) {
            dawn_error("effect MSAA target creation failed.");
        }
        msaa_view = create_dawn_texture_view(msaa_texture, nullptr);
    }
public:
    static constexpr FrameAcquirePhase acquire_phase = FrameAcquirePhase::before_uploads;
    explicit DawnEffectRun(Engine& target) : FrameSession(target) {}
    ~DawnEffectRun() {
        encoder.reset();
        surface_view.reset();
        surface.reset();
        for (auto& pass : passes) release_dawn_effect_pass(pass);
        msaa_view.reset();
        msaa_texture.reset();
        state.release();
    }
    void setup() {
        reject_unsupported_frame_options(frame_options, "Dawn effects", true, false);
        if (engine.registered_effect_renderers.empty())
            throw std::runtime_error("Effect renderer requires a registered EffectRenderer.");
        const DeviceOptions device_options = frame_device_options(frame_options);
        create_dawn_device(engine.options, device_options, state);
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);

        width = state.surface_width;
        height = state.surface_height;
        if (width == 0 || height == 0) {
            dawn_error("effect surface has a zero extent.");
        }
        // `createEffectRenderer` renders into an MSAA colour target and
        // resolves into the swapchain when the surface is multisampled, and
        // straight into it when it is not. The count is the generated read
        // of the pin's own surface declaration (`msaaSamples === 1 ? 1 :
        // 4`), not a re-typed 4.
        samples = frame_options.single_sample
            ? 1u
            : upstream::preferred_sample_count();

        recreate_msaa_target();

        // Registration order is draw order across renderers, as it is in the
        // pinned `engine._renderingContexts`.
        for (const EffectRendererHandle& handle :
             engine.registered_effect_renderers) {
            const EffectRendererRecord& record =
                handle_at(engine.effect_renderers, handle);
            passes.push_back(create_dawn_effect_pass(
                state,
                engine,
                record.effect,
                state.surface_format,
                samples));
        }
    }
    FramePreparation prepare() {
        poll_platform_events(
            engine, running, frame_options.test_pass);
        input_replay.dispatch(frame, state.window, engine);
        sync_engine_canvas_size(state.window, engine);
        if (resize_dawn_surface(state, engine.options)) {
            width = state.surface_width;
            height = state.surface_height;
            recreate_msaa_target();
        }
        return FramePreparation::ready;
    }
    FramePreparation update() {
        (void)advance_frame(
            engine,
            frame_clock,
            frame_options.frame_delta_ms);
        begin_measurement();
        return FramePreparation::ready;
    }
    bool acquire() {
        surface_texture = {};
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        surface = surface_texture.texture;
        if (!surface_texture.texture) {
            return false;
        }
        surface_view = create_dawn_texture_view(surface_texture.texture, nullptr);
        return true;
    }
    void synchronize() {
        // Every context updates before any records, which is the pinned
        // loop's order.
        for (std::size_t index = 0; index < passes.size(); ++index) {
            const EffectRendererRecord& record =
                engine.effect_renderers
                    [engine.registered_effect_renderers[index].value];
            upload_dawn_effect_pass(
                state.queue,
                engine,
                passes[index],
                record.effect);
        }
    }
    void encode() {
        const auto& first = handle_at(engine.effect_renderers, engine.registered_effect_renderers.front());
        encoder = wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        WGPURenderPassColorAttachment color_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = samples > 1 ? msaa_view : surface_view;
        if (samples > 1) color_attachment.resolveTarget = surface_view;
        color_attachment.loadOp =
            first.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
        color_attachment.storeOp = WGPUStoreOp_Store;
        color_attachment.clearValue = WGPUColor{
            first.clear_color.r,
            first.clear_color.g,
            first.clear_color.b,
            first.clear_color.a};
        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        DawnRenderPass render_pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
        for (const DawnEffectPass& pass : passes) {
            record_dawn_effect_pass(render_pass, pass);
        }
        wgpuRenderPassEncoderEnd(render_pass);
        render_pass.reset();
    }
    void present() {
        const bool capture_frame =
            frame >= frame_options.screenshot_frame &&
            !captures.screenshot_saved &&
            !frame_options.screenshot_path.empty();
        captures.maybe_write_standalone_render_capture(
            "dawn", engine, width, height, frame);
        DawnSurfaceCapture capture{};
        if (capture_frame) {
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
    void report() { FrameSession::report("Dawn", "D3D12"); }
};
} // namespace

bool run_effect_dawn_engine(Engine& engine) {
    DawnEffectRun renderer(engine);
    renderer.setup();
    while (conduct_frame(renderer) != FrameOutcome::stopped) {}
    renderer.report();
    return true;
}
#endif

} // namespace bbl::pal
