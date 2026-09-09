#include "pal_window_presenter.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_dawn_offscreen.hpp"
#include "pal_sprite_ui_dawn.hpp"
#include <deque>

namespace bbl::pal {
namespace {
class DawnWindowPresenter final : public WindowPresenter {
  public:
    explicit DawnWindowPresenter(SDL_Window* window) {
        EngineOptions engine;
        if (!SDL_GetWindowSizeInPixels(window, &engine.width, &engine.height)) dawn_error(SDL_GetError());
        create_dawn_device(engine, {}, state_, {window, &errors_});
        shared_.emplace(state_);
    }
    ~DawnWindowPresenter() override {
        try {
            for (auto& flight : in_flight_) wait_for(state_.instance, flight.future);
        } catch (const std::exception& error) {
            // Shutdown may already be unwinding a GPU error. Retain the image
            // leases until the failed device is destroyed, and never throw
            // from cleanup or hide the failure.
            SDL_LogError(SDL_LOG_CATEGORY_RENDER, "Window GPU shutdown: %s", error.what());
            wgpuDeviceDestroy(state_.device);
        }
        in_flight_.clear();
        bindings_.clear();
        release_sprite_ui_dawn_resources(ui_);
    }
    OffscreenDevice& device() override { return *shared_; }

    bool can_present() override {
        errors_.check();
        retire_frames();
        return in_flight_.size() < 3;
    }
    bool present(std::span<const WindowCanvasFrame> frames, const UiRenderFrame& ui, const std::string& capture) override {
        std::erase_if(bindings_, [](const auto& entry) { return entry.second->image.expired(); });
        int w = 0, h = 0;
        if (!SDL_GetWindowSizeInPixels(state_.window, &w, &h)) dawn_error(SDL_GetError());
        if (w <= 0 || h <= 0) return false;
        const auto width = static_cast<std::uint32_t>(w), height = static_cast<std::uint32_t>(h);
        if (width != state_.surface_width || height != state_.surface_height) configure_dawn_surface(state_, width, height);
        WGPUSurfaceTexture target = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(state_.surface, &target);
        DawnTexture acquired_texture{target.texture};
        if (target.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal && target.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            if (target.status == WGPUSurfaceGetCurrentTextureStatus_Timeout || target.status == WGPUSurfaceGetCurrentTextureStatus_Outdated) return false;
            dawn_error("Window surface acquisition failed.");
        }
        DawnTextureView view{create_dawn_texture_view(target.texture, nullptr)};
        DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state_.device, nullptr)};
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = view;
        attachment.loadOp = WGPULoadOp_Clear;
        attachment.storeOp = WGPUStoreOp_Store;
        attachment.clearValue = {0, 0, 0, 1};
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = 1;
        descriptor.colorAttachments = &attachment;
        DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
        wgpuRenderPassEncoderEnd(pass);
        pass.reset();
        const auto external_texture = [&](std::uint64_t id) -> const SpriteUiDawnTexture* {
            const auto texture = std::find_if(ui.textures.begin(), ui.textures.end(), [&](const auto& value) { return value.id == id; });
            if (texture == ui.textures.end() || texture->external_canvas == invalid_handle) return nullptr;
            const auto found = std::find_if(frames.begin(), frames.end(), [&](const auto& frame) { return frame.element.value == texture->external_canvas; });
            if (found == frames.end()) return nullptr;
            auto& binding = bindings_[found->frame.image.get()];
            if (!binding) binding = std::make_unique<SamplingBinding>(state_, ui_, found->frame.image);
            return &binding->texture;
        };
        render_sprite_ui_dawn_frame(state_, encoder, target.texture, view, ui_, ui, external_texture);
        DawnSurfaceCapture snapshot;
        if (!capture.empty()) snapshot = begin_dawn_surface_capture(state_.device, encoder, target.texture, width, height);
        DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
        submit_dawn_command(state_.queue, command);
        command.reset();
        if (!capture.empty()) {
            finish_dawn_surface_capture(state_, snapshot, width, height, capture);
        } else {
            WGPUQueueWorkDoneCallbackInfo callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
            callback.mode = WGPUCallbackMode_WaitAnyOnly;
            callback.callback = [](WGPUQueueWorkDoneStatus status, WGPUStringView message, void* errors, void*) {
                if (status != WGPUQueueWorkDoneStatus_Success) static_cast<SharedDawnErrors*>(errors)->report("Window submit: " + view_text(message));
            };
            callback.userdata1 = &errors_;
            in_flight_.push_back({wgpuQueueOnSubmittedWorkDone(state_.queue, callback), {frames.begin(), frames.end()}});
        }
        wgpuSurfacePresent(state_.surface);
        // Presentation may wait for the display. Release work completed during
        // that wait before waking producers for their next animation frame.
        retire_frames();
        errors_.check();
        return true;
    }
  private:
    void retire_frames() {
        while (!in_flight_.empty()) {
            WGPUFutureWaitInfo info{};
            info.future = in_flight_.front().future;
            const auto status = wgpuInstanceWaitAny(state_.instance, 1, &info, 0);
            if (status == WGPUWaitStatus_TimedOut) break;
            if (status != WGPUWaitStatus_Success) dawn_error("Window fence poll failed.");
            in_flight_.pop_front();
        }
    }
    struct SamplingBinding {
        SamplingBinding(DawnDevice& state, SpriteUiDawnResources& ui, const std::shared_ptr<OffscreenImage>& source) : image(source) {
            const auto* native = dynamic_cast<DawnOffscreenImage*>(source.get());
            if (!native) dawn_error("Window received an incompatible canvas GPU image.");
            try {
                texture.view = create_dawn_texture_view(native->texture, nullptr);
                texture.group = create_sprite_ui_dawn_texture_group(state, ui, texture.view, ui.sampler);
                texture.nearest_group = create_sprite_ui_dawn_texture_group(state, ui, texture.view, ui.nearest_sampler);
            } catch (...) { texture.release(); throw; }
        }
        ~SamplingBinding() { texture.release(); }
        // Native bind groups retain GPU objects without leasing a pool image.
        std::weak_ptr<OffscreenImage> image;
        SpriteUiDawnTexture texture;
    };
    struct InFlight { WGPUFuture future; std::vector<WindowCanvasFrame> leases; };
    SharedDawnErrors errors_;
    DawnDevice state_;
    std::optional<DawnOffscreenDevice> shared_;
    SpriteUiDawnResources ui_;
    std::unordered_map<OffscreenImage*, std::unique_ptr<SamplingBinding>> bindings_;
    std::deque<InFlight> in_flight_;
};
} // namespace
std::shared_ptr<WindowPresenter> create_window_dawn_presenter(SDL_Window* window) { return std::make_shared<DawnWindowPresenter>(window); }
} // namespace bbl::pal
