#pragma once
#include <bblite/pal_offscreen.hpp>
#include <bblite/pal_ui.hpp>
#include <SDL3/SDL.h>
#include <memory>
#include <span>
#include <string>

namespace bbl::pal {
struct WindowCanvasFrame {
    UiElementHandle element;
    OffscreenFrame frame;
};

/** OS-thread-only consumer. Frames contain native GPU leases, never JS values. */
class WindowPresenter {
  public:
    virtual ~WindowPresenter() = default;
    virtual OffscreenDevice& device() = 0;
    virtual bool can_present() = 0;
    virtual bool present(std::span<const WindowCanvasFrame> frames, const UiRenderFrame& ui, const std::string& capture) = 0;
};
std::shared_ptr<WindowPresenter> create_window_sdl_presenter(SDL_Window* window);
std::shared_ptr<WindowPresenter> create_window_dawn_presenter(SDL_Window* window);
} // namespace bbl::pal
