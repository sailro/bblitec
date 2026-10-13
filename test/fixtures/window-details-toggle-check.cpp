#define WINDOW_HOST_PROGRAM "../../artifacts/window-details-toggle/program.hpp"
#include "window-host-fixture.hpp"

/**
 * Three clicks on the summary through the Window display, one press or release per few
 * presentations so the realm publishes each disclosure before the next click. The point hits
 * the program's summary at any display scale up to 2.
 */
void window_host::presented(int presentation) {
    if (presentation % 4 != 0)
        return;
    const int step = presentation / 4 - 1;
    if (step == 0)
        return move(60, 60);
    if (step >= 1 && step <= 6)
        return button(step % 2 == 1, 60, 60);
}

int main() {
    assert(generated_main() == 0);
    // Each summary click reaches the realm's details once, open state first: open (o) with the
    // listener's output and status writes, close (c), open again with the status hidden.
    if (window_host::final_log != "o1.00sco3.00h") {
        std::fprintf(stderr, "details toggle Window trace: %s\n", window_host::final_log.c_str());
        return 1;
    }
}
