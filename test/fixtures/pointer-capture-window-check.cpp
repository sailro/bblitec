#define WINDOW_HOST_PROGRAM "../../artifacts/pointer-capture-window/program.hpp"
#include "window-host-fixture.hpp"

/** Window points: the program's panel, other and canvas boxes at any display scale up to 2. */
void window_host::presented(int presentation) {
    // One drain receives every gesture.
    if (presentation != 6)
        return;
    // The panel captures, the drag crosses `other`, leaves the window and is released outside.
    move(60, 60);
    button(true, 60, 60);
    move(900, 60, SDL_BUTTON_LMASK);
    move(-50, -50, SDL_BUTTON_LMASK);
    SDL_Event leave{};
    leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
    push(leave);
    button(false, -50, -50);
    move(900, 60);
    // A retained canvas captures through its on<event> handlers.
    move(60, 700);
    button(true, 60, 700);
    move(900, 60, SDL_BUTTON_LMASK);
    button(false, 900, 60);
    // A stored element captures in a capture-phase listener.
    button(true, 900, 60);
    move(60, 60, SDL_BUTTON_LMASK);
    button(false, 60, 60);
}

int main() {
    assert(generated_main() == 0);
    // Motion over the panel; the press captures it (D, h); gotpointercapture before the
    // captured motion over `other` and outside the window (G, m, m); the release outside
    // reaches the panel (W, U) and ends the capture (L); hover then reaches `other` (O, x).
    // The canvas captures (c) and keeps the motion (v) until its release (W, u, O). The
    // stored element refuses a detached capture (I) and an inactive pointer (N), then
    // keeps the motion over the panel (x) until its release (W).
    if (window_host::final_log != "mDhGmmWULOxcvWuOINxW") {
        std::fprintf(stderr, "pointer capture trace: %s\n", window_host::final_log.c_str());
        return 1;
    }
}
