#define WINDOW_HOST_PROGRAM "../../artifacts/runtime-selectors-window/program.hpp"
#include "window-host-fixture.hpp"

/**
 * One gesture per few presentations, so the display's update publishes the
 * pointer state each gesture leaves before the next one's listeners read it.
 * Window points hit the program's region, target and done boxes at any
 * display scale up to 2.
 */
void window_host::presented(int presentation) {
    if (presentation % 4 != 0)
        return;
    switch (presentation / 4 - 1) {
    case 0:
        return move(60, 60);
    case 1:
        return button(true, 60, 60);
    case 2:
        return button(false, 60, 60);
    case 3:
        return move(900, 60);
    case 4:
        return button(true, 900, 60);
    case 5:
        return move(905, 62, SDL_BUTTON_LMASK);
    case 6:
        return button(false, 905, 62);
    case 7:
        return move(60, 700);
    case 8:
        return button(true, 60, 700);
    case 9:
        return button(false, 60, 700);
    default:
        return;
    }
}

int main() {
    assert(generated_main() == 0);
    // The press on the region sees it hovered (P); the press on the target sees it and its
    // container hovered, not yet active (D); the pressed drag sees it active (M); the press
    // on the done box sees nothing hovered or active since the pointer left (E).
    if (window_host::final_log != "PRthacDrTHaCMrTHACErthac") {
        std::fprintf(stderr, "runtime selector Window trace: %s\n", window_host::final_log.c_str());
        return 1;
    }
}
