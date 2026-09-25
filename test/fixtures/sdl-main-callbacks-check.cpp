#include "pal_sdl_application.hpp"
#include "pal_gpu_frame.hpp"
#include <cassert>
#include <cstring>

using namespace bbl::pal;
static int callback_entries = 0, polls = 0, iterations = 0;
static bool resource_alive = false, force_quit = false, send_text = false;
static SDL_AppIterate_func active_iterator = nullptr;
static void* callback_state = nullptr;

bool SDL_PollEvent(SDL_Event*) {
    ++polls;
    return false;
}

int SDL_EnterAppMainCallbacks(int argc, char** argv, SDL_AppInit_func init,
                              SDL_AppIterate_func iterate, SDL_AppEvent_func event,
                              SDL_AppQuit_func quit) {
    ++callback_entries;
    void* state = nullptr;
    auto result = init(&state, argc, argv);
    active_iterator = iterate;
    callback_state = state;
    if (send_text) {
        char text[] = "source";
        SDL_Event input{};
        input.type = SDL_EVENT_TEXT_INPUT;
        input.text.text = text;
        assert(event(state, &input) == SDL_APP_CONTINUE);
        text[0] = 'X';
    }
    while (result == SDL_APP_CONTINUE) {
        // SDL calls this same iterator from Win32's live-resize modal loop.
        result = iterate(state);
        if (force_quit)
            break;
    }
    quit(state, result);
    active_iterator = nullptr;
    assert(!resource_alive); // SDL_Quit follows AppQuit, after native owners unwind.
    return result == SDL_APP_FAILURE ? 1 : 0;
}

Iteration<int> application(bool fail) {
    struct Resource {
        Resource() {
            assert(!resource_alive);
            resource_alive = true;
        }
        ~Resource() { resource_alive = false; }
    } resource;
    for (int frame = 0; frame < 3; ++frame) {
        ++iterations;
        if (active_iterator) {
            const auto before = iterations;
            assert(active_iterator(callback_state) == SDL_APP_CONTINUE);
            assert(iterations == before);
        }
        SDL_Event event;
        const bool got = poll_sdl_event(&event);
        if (send_text && frame == 0) {
            assert(got && std::strcmp(event.text.text, "source") == 0);
            assert(!poll_sdl_event(&event));
        } else
            assert(!got);
        if (fail && frame == 1)
            throw std::runtime_error("frame failed");
        co_yield true;
    }
    co_return 0;
}

int main() {
    FrameOptions options;
    assert(options.interactive());
    options.test_pass = true;
    assert(!options.interactive());
    options = {};
    options.max_frames = 10;
    assert(!options.interactive());
    options = {};
    options.benchmark_requested = true;
    assert(!options.interactive());
    options = {};
    options.screenshot_path = "capture.png";
    assert(!options.interactive());
    send_text = true;
    assert(run_sdl_application(application(false), true) == 0);
    assert(iterations == 3 && callback_entries == 1 && polls == 0);
    assert(active_sdl_application == nullptr);
    send_text = false;
    iterations = callback_entries = 0;
    assert(run_sdl_application(application(false), false) == 0);
    assert(iterations == 3 && callback_entries == 0 && polls == 3);
    bool threw = false;
    try {
        run_sdl_application(application(true), true);
    } catch (const std::runtime_error& error) {
        threw = std::strcmp(error.what(), "frame failed") == 0;
    }
    assert(threw && !resource_alive && active_sdl_application == nullptr);
    force_quit = true;
    iterations = 0;
    assert(run_sdl_application(application(false), true) == 0);
    assert(iterations == 1 && !resource_alive);

    char first[] = "one", second[] = "two";
    const char* candidates[] = {first, second};
    SDL_Event event{};
    event.type = SDL_EVENT_TEXT_EDITING_CANDIDATES;
    event.edit_candidates.num_candidates = 2;
    event.edit_candidates.candidates = candidates;
    QueuedSdlEvent queued(event);
    first[0] = 'X';
    second[0] = 'X';
    auto moved = std::move(queued);
    const auto retained = moved.value();
    assert(std::strcmp(retained.edit_candidates.candidates[0], "one") == 0);
    assert(std::strcmp(retained.edit_candidates.candidates[1], "two") == 0);
}
