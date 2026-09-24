#include "pal_window_presenter.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_offscreen.hpp"
#include "pal_sprite_ui_sdl.hpp"
#include <deque>

namespace bbl::pal {
namespace {
class SdlWindowPresenter final : public WindowPresenter {
public:
    explicit SdlWindowPresenter(SDL_Window* window)
        : window_(window),
          device_(create_compiled_shader_device(environment_variable("BBLITE_GPU_DEBUG") == "1"),
                  &SDL_DestroyGPUDevice),
          shared_(device_.get()) {
        if (!device_)
            gpu_error("SDL_CreateGPUDevice Window");
        if (!SDL_SetGPUAllowedFramesInFlight(device_.get(), 3))
            gpu_error("SDL_SetGPUAllowedFramesInFlight Window");
        if (!SDL_ClaimWindowForGPUDevice(device_.get(), window_))
            gpu_error("SDL_ClaimWindowForGPUDevice Window");
    }
    ~SdlWindowPresenter() override {
        SDL_WaitForGPUIdle(device_.get());
        in_flight_.clear();
        release_sprite_ui_sdl_resources(device_.get(), ui_);
        composite_.release(device_.get());
        SDL_ReleaseWindowFromGPUDevice(device_.get(), window_);
    }
    OffscreenDevice& device() override { return shared_; }

    void set_display_paced(bool display_paced) override {
        const auto mode = display_paced && SDL_WindowSupportsGPUPresentMode(
                                               device_.get(), window_, SDL_GPU_PRESENTMODE_MAILBOX)
                              ? SDL_GPU_PRESENTMODE_MAILBOX
                              : SDL_GPU_PRESENTMODE_VSYNC;
        if (mode != present_mode_) {
            if (!SDL_SetGPUSwapchainParameters(device_.get(), window_,
                                               SDL_GPU_SWAPCHAINCOMPOSITION_SDR, mode))
                gpu_error("SDL_SetGPUSwapchainParameters Window");
            present_mode_ = mode;
        }
        if (cpu_profile_)
            std::fprintf(stderr, "[window-present] backend=sdl_gpu display_paced=%d mode=%s\n",
                         display_paced, mode == SDL_GPU_PRESENTMODE_MAILBOX ? "mailbox" : "fifo");
    }

    bool can_present() override {
        while (!in_flight_.empty() &&
               SDL_QueryGPUFence(device_.get(), in_flight_.front().fence.get()))
            in_flight_.pop_front();
        return in_flight_.size() < 3;
    }
    bool present(std::span<const WindowCanvasFrame> frames, const UiRenderFrame& ui,
                 const std::string& capture) override {
        const double started = cpu_profile_ ? monotonic_milliseconds() : 0;
        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device_.get())};
        if (!command)
            gpu_error("SDL_AcquireGPUCommandBuffer Window");
        const double command_acquired = cpu_profile_ ? monotonic_milliseconds() : 0;
        SDL_GPUTexture* swapchain = nullptr;
        Uint32 width = 0, height = 0;
        if (!command.acquire_swapchain(window_, &swapchain, &width, &height))
            gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture Window");
        if (!swapchain || width == 0 || height == 0)
            return false;
        const double swapchain_acquired = cpu_profile_ ? monotonic_milliseconds() : 0;
        const auto format = SDL_GetGPUSwapchainTextureFormat(device_.get(), window_);
        const bool readable = !capture.empty() || ui_frame_reads_target(ui);
        const bool target_created = readable && (!composite_.texture || composite_.width != width ||
                                                 composite_.height != height);
        auto* destination =
            composite_.target(device_.get(), swapchain, format, width, height, readable);
        SDL_GPUColorTargetInfo target{};
        target.texture = destination;
        target.load_op = SDL_GPU_LOADOP_CLEAR;
        target.store_op = SDL_GPU_STOREOP_STORE;
        target.clear_color = {0, 0, 0, 1};
        SdlRenderPass pass{SDL_BeginGPURenderPass(command, &target, 1, nullptr)};
        if (!pass)
            gpu_error("SDL_BeginGPURenderPass Window");
        pass.end();
        const double target_prepared = cpu_profile_ ? monotonic_milliseconds() : 0;

        const auto external_texture = [&](std::uint64_t id) -> SDL_GPUTexture* {
            const auto texture = std::find_if(ui.textures.begin(), ui.textures.end(),
                                              [&](const auto& value) { return value.id == id; });
            if (texture == ui.textures.end() || texture->external_canvas == invalid_handle)
                return nullptr;
            const auto found = std::find_if(frames.begin(), frames.end(), [&](const auto& frame) {
                return frame.element.value == texture->external_canvas;
            });
            if (found == frames.end())
                return nullptr;
            const auto* image = dynamic_cast<SdlOffscreenImage*>(found->frame.image.get());
            if (!image)
                throw std::runtime_error("Window received an incompatible canvas GPU image.");
            return image->texture;
        };
        SpriteUiSdlCpuSample ui_sample;
        render_sprite_ui_sdl_frame(device_.get(), command, destination, format, ui_, ui,
                                   external_texture, cpu_profile_ ? &ui_sample : nullptr);
        const double ui_recorded = cpu_profile_ ? monotonic_milliseconds() : 0;
        UiSdlReadableSurface::present(command, destination, swapchain, width, height);
        const double blit_recorded = cpu_profile_ ? monotonic_milliseconds() : 0;
        if (!capture.empty()) {
            save_texture_png(device_.get(), command, destination, format, width, height, capture);
        } else {
            Fence fence(command.submit_with_fence(), {device_.get()});
            if (!fence)
                gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence Window");
            in_flight_.push_back({std::move(fence), {frames.begin(), frames.end()}});
        }
        if (cpu_profile_) {
            const double finished = monotonic_milliseconds();
            if (presented_ % 30 == 0 || finished - started >= 1 || target_created ||
                ui_sample.geometry_buffers_created || ui_sample.pipelines_created ||
                ui_sample.textures_created || ui_sample.textures_released) {
                const auto canvas_sequence = frames.empty() ? 0 : frames.front().frame.sequence;
                std::fprintf(stderr,
                             "[cpu][window-sdl-present] present=%zu canvas=%llu total_ms=%.3f "
                             "command_ms=%.3f swapchain_ms=%.3f target_ms=%.3f ui_ms=%.3f "
                             "resources_ms=%.3f geometry_upload_ms=%.3f texture_upload_ms=%.3f "
                             "upload_cleanup_ms=%.3f record_ms=%.3f blit_ms=%.3f "
                             "submit_capture_ms=%.3f capture=%d target_created=%d "
                             "geometry_buffers_created=%zu pipelines_created=%zu "
                             "textures_created=%zu textures_released=%zu texture_bytes=%zu "
                             "vertex_bytes=%zu index_bytes=%zu draws=%zu segments=%zu "
                             "backdrops=%zu composites=%zu in_flight=%zu\n",
                             presented_, static_cast<unsigned long long>(canvas_sequence),
                             finished - started, command_acquired - started,
                             swapchain_acquired - command_acquired,
                             target_prepared - swapchain_acquired, ui_recorded - target_prepared,
                             ui_sample.resources_ms, ui_sample.geometry_upload_ms,
                             ui_sample.texture_upload_ms, ui_sample.upload_cleanup_ms,
                             ui_sample.record_ms, blit_recorded - ui_recorded,
                             finished - blit_recorded, !capture.empty(), target_created,
                             ui_sample.geometry_buffers_created, ui_sample.pipelines_created,
                             ui_sample.textures_created, ui_sample.textures_released,
                             ui_sample.texture_bytes, ui_sample.vertex_bytes, ui_sample.index_bytes,
                             ui_sample.draws, ui_sample.segments, ui.backdrops.size(),
                             ui.composites.size(), in_flight_.size());
            }
        }
        ++presented_;
        return true;
    }

private:
    using Device = std::unique_ptr<SDL_GPUDevice, decltype(&SDL_DestroyGPUDevice)>;
    using Fence = std::unique_ptr<SDL_GPUFence, SdlGpuDeleter<SDL_GPUFence, SDL_ReleaseGPUFence>>;
    struct InFlight {
        Fence fence;
        std::vector<WindowCanvasFrame> leases;
    };
    SDL_Window* window_;
    Device device_;
    SdlOffscreenDevice shared_;
    SpriteUiSdlResources ui_;
    UiSdlReadableSurface composite_;
    std::deque<InFlight> in_flight_;
    SDL_GPUPresentMode present_mode_ = SDL_GPU_PRESENTMODE_VSYNC;
    const bool cpu_profile_ = environment_variable("BBLITE_CPU_PROFILE") == "1";
    std::size_t presented_ = 0;
};
} // namespace
std::shared_ptr<WindowPresenter> create_window_sdl_presenter(SDL_Window* window) {
    return std::make_shared<SdlWindowPresenter>(window);
}
} // namespace bbl::pal
