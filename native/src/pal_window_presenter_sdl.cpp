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
        : window_(window), device_(SDL_CreateGPUDevice(
              SDL_GPU_SHADERFORMAT_DXIL | SDL_GPU_SHADERFORMAT_SPIRV | SDL_GPU_SHADERFORMAT_MSL,
              environment_variable("BBLITE_GPU_DEBUG") == "1", nullptr), &SDL_DestroyGPUDevice), shared_(device_.get()) {
        if (!device_) gpu_error("SDL_CreateGPUDevice Window");
        if (!SDL_SetGPUAllowedFramesInFlight(device_.get(), 3)) gpu_error("SDL_SetGPUAllowedFramesInFlight Window");
        if (!SDL_ClaimWindowForGPUDevice(device_.get(), window_)) gpu_error("SDL_ClaimWindowForGPUDevice Window");
    }
    ~SdlWindowPresenter() override {
        SDL_WaitForGPUIdle(device_.get());
        in_flight_.clear();
        release_sprite_ui_sdl_resources(device_.get(), ui_);
        composite_.reset();
        SDL_ReleaseWindowFromGPUDevice(device_.get(), window_);
    }
    OffscreenDevice& device() override { return shared_; }

    bool can_present() override {
        while (!in_flight_.empty() && SDL_QueryGPUFence(device_.get(), in_flight_.front().fence.get())) in_flight_.pop_front();
        return in_flight_.size() < 3;
    }
    bool present(std::span<const WindowCanvasFrame> frames, const UiRenderFrame& ui, const std::string& capture) override {
        auto* command = SDL_AcquireGPUCommandBuffer(device_.get());
        if (!command) gpu_error("SDL_AcquireGPUCommandBuffer Window");
        struct Cancel { SDL_GPUCommandBuffer*& command; ~Cancel() { if (command) SDL_CancelGPUCommandBuffer(command); } } cancel{command};
        SDL_GPUTexture* swapchain = nullptr;
        Uint32 width = 0, height = 0;
        if (!SDL_WaitAndAcquireGPUSwapchainTexture(command, window_, &swapchain, &width, &height)) gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture Window");
        if (!swapchain || width == 0 || height == 0) return false;
        const auto format = SDL_GetGPUSwapchainTextureFormat(device_.get(), window_);
        if (!capture.empty() && (!composite_ || width_ != width || height_ != height)) {
            width_ = width; height_ = height;
            composite_ = Texture(create_frame_texture(device_.get(), format, SDL_GPU_SAMPLECOUNT_1, width, height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER), {device_.get()});
        }
        auto* destination = capture.empty() ? swapchain : composite_.get();
        SDL_GPUColorTargetInfo target{};
        target.texture = destination;
        target.load_op = SDL_GPU_LOADOP_CLEAR;
        target.store_op = SDL_GPU_STOREOP_STORE;
        target.clear_color = {0, 0, 0, 1};
        auto* pass = SDL_BeginGPURenderPass(command, &target, 1, nullptr);
        if (!pass) gpu_error("SDL_BeginGPURenderPass Window");
        SDL_EndGPURenderPass(pass);

        const auto external_texture = [&](std::uint64_t id) -> SDL_GPUTexture* {
            const auto texture = std::find_if(ui.textures.begin(), ui.textures.end(), [&](const auto& value) { return value.id == id; });
            if (texture == ui.textures.end() || texture->external_canvas == invalid_handle) return nullptr;
            const auto found = std::find_if(frames.begin(), frames.end(), [&](const auto& frame) { return frame.element.value == texture->external_canvas; });
            if (found == frames.end()) return nullptr;
            const auto* image = dynamic_cast<SdlOffscreenImage*>(found->frame.image.get());
            if (!image) throw std::runtime_error("Window received an incompatible canvas GPU image.");
            return image->texture;
        };
        render_sprite_ui_sdl_frame(device_.get(), command, destination, format, ui_, ui, external_texture);
        if (!capture.empty()) {
            SDL_GPUBlitInfo blit{};
            blit.source = {destination, 0, 0, 0, 0, width, height};
            blit.destination = {swapchain, 0, 0, 0, 0, width, height};
            blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
            blit.filter = SDL_GPU_FILTER_NEAREST;
            SDL_BlitGPUTexture(command, &blit);
            auto* submitted = std::exchange(command, nullptr);
            save_texture_png(device_.get(), submitted, destination, format, width, height, capture);
        } else {
            Fence fence(SDL_SubmitGPUCommandBufferAndAcquireFence(std::exchange(command, nullptr)), {device_.get()});
            if (!fence) gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence Window");
            in_flight_.push_back({std::move(fence), {frames.begin(), frames.end()}});
        }
        return true;
    }
  private:
    using Device = std::unique_ptr<SDL_GPUDevice, decltype(&SDL_DestroyGPUDevice)>;
    using Texture = std::unique_ptr<SDL_GPUTexture, SdlGpuDeleter<SDL_GPUTexture, SDL_ReleaseGPUTexture>>;
    using Fence = std::unique_ptr<SDL_GPUFence, SdlGpuDeleter<SDL_GPUFence, SDL_ReleaseGPUFence>>;
    struct InFlight { Fence fence; std::vector<WindowCanvasFrame> leases; };
    SDL_Window* window_;
    Device device_;
    SdlOffscreenDevice shared_;
    SpriteUiSdlResources ui_;
    Texture composite_{nullptr, {nullptr}};
    std::deque<InFlight> in_flight_;
    Uint32 width_ = 0, height_ = 0;
};
} // namespace
std::shared_ptr<WindowPresenter> create_window_sdl_presenter(SDL_Window* window) { return std::make_shared<SdlWindowPresenter>(window); }
} // namespace bbl::pal
