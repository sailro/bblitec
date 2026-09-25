#pragma once

#include <bblite/pal_iteration.hpp>
#include <SDL3/SDL.h>
#if defined(SDL_PLATFORM_WINDOWS) || defined(SDL_PLATFORM_MACOS) || defined(SDL_PLATFORM_LINUX)
#ifndef SDL_MAIN_HANDLED
#define SDL_MAIN_HANDLED
#endif
#include <SDL3/SDL_main.h>
#endif
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace bbl::pal {

/** SDL owns event string pointers only for delivery; queued input retains them. */
class QueuedSdlEvent {
    SDL_Event event_;
    std::vector<std::optional<std::string>> strings_;
    std::vector<const char*> pointers_;
    void retain(const char* value) {
        strings_.push_back(value ? std::optional<std::string>(value) : std::nullopt);
    }

public:
    explicit QueuedSdlEvent(const SDL_Event& event) : event_(event) {
        switch (event.type) {
        case SDL_EVENT_TEXT_INPUT:
            retain(event.text.text);
            break;
        case SDL_EVENT_TEXT_EDITING:
            retain(event.edit.text);
            break;
        case SDL_EVENT_TEXT_EDITING_CANDIDATES:
            for (int i = 0; i < event.edit_candidates.num_candidates; ++i)
                retain(event.edit_candidates.candidates[i]);
            break;
        case SDL_EVENT_DROP_BEGIN:
        case SDL_EVENT_DROP_FILE:
        case SDL_EVENT_DROP_TEXT:
        case SDL_EVENT_DROP_COMPLETE:
        case SDL_EVENT_DROP_POSITION:
            retain(event.drop.source);
            retain(event.drop.data);
            break;
        case SDL_EVENT_CLIPBOARD_UPDATE:
            for (int i = 0; i < event.clipboard.num_mime_types; ++i)
                retain(event.clipboard.mime_types[i]);
            break;
        default:
            break;
        }
    }
    SDL_Event value() {
        pointers_.clear();
        for (const auto& value : strings_)
            pointers_.push_back(value ? value->c_str() : nullptr);
        switch (event_.type) {
        case SDL_EVENT_TEXT_INPUT:
            event_.text.text = pointers_[0];
            break;
        case SDL_EVENT_TEXT_EDITING:
            event_.edit.text = pointers_[0];
            break;
        case SDL_EVENT_TEXT_EDITING_CANDIDATES:
            event_.edit_candidates.candidates = pointers_.data();
            break;
        case SDL_EVENT_DROP_BEGIN:
        case SDL_EVENT_DROP_FILE:
        case SDL_EVENT_DROP_TEXT:
        case SDL_EVENT_DROP_COMPLETE:
        case SDL_EVENT_DROP_POSITION:
            event_.drop.source = pointers_[0];
            event_.drop.data = pointers_[1];
            break;
        case SDL_EVENT_CLIPBOARD_UPDATE:
            event_.clipboard.mime_types = pointers_.data();
            break;
        default:
            break;
        }
        return event_;
    }
};

struct SdlApplication {
    Iteration<int> frames;
    std::exception_ptr failure;
    int result = 0;
    std::mutex events_mutex;
    std::deque<QueuedSdlEvent> events;
    std::optional<QueuedSdlEvent> delivered;
    bool iterating = false;
    explicit SdlApplication(Iteration<int> sequence) : frames(std::move(sequence)) {}
    void fail(std::exception_ptr error) {
        std::lock_guard lock(events_mutex);
        if (!failure)
            failure = std::move(error);
    }
};
inline thread_local SdlApplication* active_sdl_application = nullptr;

/** Callback mode drains delivered events without pumping the OS inside a frame. */
inline bool poll_sdl_event(SDL_Event* event) {
    auto* app = active_sdl_application;
    if (!app)
        return SDL_PollEvent(event);
    std::lock_guard lock(app->events_mutex);
    app->delivered.reset();
    if (app->events.empty())
        return false;
    app->delivered.emplace(std::move(app->events.front()));
    app->events.pop_front();
    *event = app->delivered->value();
    return true;
}

/** Capture and benchmark runs retain their explicit, deterministic iteration loop. */
inline int run_sdl_application(Iteration<int> frames, bool interactive) {
#if defined(SDL_PLATFORM_WINDOWS) || defined(SDL_PLATFORM_MACOS) || defined(SDL_PLATFORM_LINUX)
    if (interactive) {
        if (active_sdl_application)
            throw std::logic_error("Nested SDL application callbacks.");
        SdlApplication app(std::move(frames));
        struct Binding {
            explicit Binding(SdlApplication& value) { active_sdl_application = &value; }
            ~Binding() { active_sdl_application = nullptr; }
        } binding(app);
        const auto status = SDL_EnterAppMainCallbacks(
            0, nullptr,
            [](void** state, int, char**) -> SDL_AppResult {
                *state = active_sdl_application;
                return SDL_APP_CONTINUE;
            },
            [](void* state) -> SDL_AppResult {
                auto& current = *static_cast<SdlApplication*>(state);
                if (current.iterating)
                    return SDL_APP_CONTINUE;
                current.iterating = true;
                try {
                    const bool pending = current.frames.advance();
                    current.iterating = false;
                    if (pending)
                        return SDL_APP_CONTINUE;
                    current.result = current.frames.result();
                    return current.result == 0 ? SDL_APP_SUCCESS : SDL_APP_FAILURE;
                } catch (...) {
                    current.iterating = false;
                    current.fail(std::current_exception());
                    return SDL_APP_FAILURE;
                }
            },
            [](void* state, SDL_Event* event) -> SDL_AppResult {
                auto& current = *static_cast<SdlApplication*>(state);
                try {
                    std::lock_guard lock(current.events_mutex);
                    current.events.emplace_back(*event);
                    return SDL_APP_CONTINUE;
                } catch (...) {
                    current.fail(std::current_exception());
                    return SDL_APP_FAILURE;
                }
            },
            [](void* state, SDL_AppResult) {
                // All native frame owners die before SDL performs its final SDL_Quit.
                static_cast<SdlApplication*>(state)->frames.reset();
            });
        if (app.failure)
            std::rethrow_exception(app.failure);
        return app.result != 0 ? app.result : status;
    }
#else
    (void)interactive;
#endif
    while (frames.advance()) {
    }
    return frames.result();
}

} // namespace bbl::pal
