// SDL implementation of the platform abstraction layer: image decode, and
// the engine entry point that dispatches to a GPU backend.
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_async_engine.hpp>
#endif
#if BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <stdexcept>
#include <string>
#include <array>
#include <cmath>

#include <SDL3/SDL.h>
#include "pal_window.hpp"
#include "pal_gpu_dispatch.hpp"

namespace bbl {

#if BBLITE_HAS_GAMEPAD
struct PlatformGamepadState {
    struct Gamepad {
        explicit Gamepad(GamepadHandle value) : handle(value), buttons(17), axes(4) {
            for (std::size_t index = 0; index < buttons.size(); ++index) {
                buttons[index] = GamepadButtonHandle{handle, static_cast<std::uint32_t>(index)};
            }
        }

        GamepadHandle handle{};
        js::Array<GamepadButtonHandle> buttons;
        js::Array<double> axes;
        bool axes_initialized = false;
    };

    std::vector<std::optional<Gamepad>> slots;
};

namespace {

PlatformGamepadState& gamepad_state(Engine& engine) {
    if (!engine.platform_gamepad_state) {
        engine.platform_gamepad_state = std::make_shared<PlatformGamepadState>();
    }
    return *engine.platform_gamepad_state;
}

PlatformGamepadState::Gamepad* cached_gamepad(Engine& engine, GamepadHandle handle) {
    if (!engine.platform_gamepad_state)
        return nullptr;
    for (auto& entry : engine.platform_gamepad_state->slots) {
        if (entry && entry->handle.instance_id == handle.instance_id) {
            return &*entry;
        }
    }
    return nullptr;
}

SDL_Gamepad* opened_gamepad(GamepadHandle handle) {
    if (handle.instance_id == invalid_handle)
        return nullptr;
    const SDL_JoystickID instance_id = static_cast<SDL_JoystickID>(handle.instance_id);
    SDL_Gamepad* gamepad = SDL_GetGamepadFromID(instance_id);
    return gamepad ? gamepad : SDL_OpenGamepad(instance_id);
}

/** Browser standard-mapping button order, excluding the two trigger axes. */
SDL_GamepadButton standard_gamepad_button(std::uint32_t index) {
    switch (index) {
    case 0:
        return SDL_GAMEPAD_BUTTON_SOUTH;
    case 1:
        return SDL_GAMEPAD_BUTTON_EAST;
    case 2:
        return SDL_GAMEPAD_BUTTON_WEST;
    case 3:
        return SDL_GAMEPAD_BUTTON_NORTH;
    case 4:
        return SDL_GAMEPAD_BUTTON_LEFT_SHOULDER;
    case 5:
        return SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER;
    case 8:
        return SDL_GAMEPAD_BUTTON_BACK;
    case 9:
        return SDL_GAMEPAD_BUTTON_START;
    case 10:
        return SDL_GAMEPAD_BUTTON_LEFT_STICK;
    case 11:
        return SDL_GAMEPAD_BUTTON_RIGHT_STICK;
    case 12:
        return SDL_GAMEPAD_BUTTON_DPAD_UP;
    case 13:
        return SDL_GAMEPAD_BUTTON_DPAD_DOWN;
    case 14:
        return SDL_GAMEPAD_BUTTON_DPAD_LEFT;
    case 15:
        return SDL_GAMEPAD_BUTTON_DPAD_RIGHT;
    case 16:
        return SDL_GAMEPAD_BUTTON_GUIDE;
    default:
        return SDL_GAMEPAD_BUTTON_INVALID;
    }
}

} // namespace

js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine& engine) {
    int count = 0;
    SDL_JoystickID* ids = SDL_GetGamepads(&count);
    std::vector<std::uint32_t> connected;
    connected.reserve(static_cast<std::size_t>(std::max(0, count)));
    for (int index = 0; index < count; ++index) {
        const std::uint32_t instance_id = static_cast<std::uint32_t>(ids[index]);
        if (opened_gamepad({instance_id, invalid_handle})) {
            connected.push_back(instance_id);
        }
    }
    SDL_free(ids);

    PlatformGamepadState& state = gamepad_state(engine);
    for (auto& entry : state.slots) {
        if (entry && std::find(connected.begin(), connected.end(), entry->handle.instance_id) ==
                         connected.end()) {
            entry.reset();
        }
    }
    for (const std::uint32_t instance_id : connected) {
        const auto existing =
            std::find_if(state.slots.begin(), state.slots.end(), [instance_id](const auto& entry) {
                return entry && entry->handle.instance_id == instance_id;
            });
        if (existing != state.slots.end())
            continue;
        auto available = std::find_if(state.slots.begin(), state.slots.end(),
                                      [](const auto& entry) { return !entry; });
        if (available == state.slots.end()) {
            state.slots.emplace_back();
            available = std::prev(state.slots.end());
        }
        const std::uint32_t stable_index =
            static_cast<std::uint32_t>(std::distance(state.slots.begin(), available));
        available->emplace(GamepadHandle{instance_id, stable_index});
    }
    while (!state.slots.empty() && !state.slots.back()) {
        state.slots.pop_back();
    }

    js::Array<js::Nullable<GamepadHandle>> result(state.slots.size());
    for (std::size_t index = 0; index < state.slots.size(); ++index) {
        if (state.slots[index])
            result[index] = state.slots[index]->handle;
    }
    return result;
}

double gamepad_index(Engine&, GamepadHandle gamepad) { return static_cast<double>(gamepad.index); }

js::Array<double> gamepad_axes(Engine& engine, GamepadHandle handle) {
    std::array<double, 4> values{};
    SDL_Gamepad* gamepad = opened_gamepad(handle);
    constexpr std::array<SDL_GamepadAxis, 4> axes{
        SDL_GAMEPAD_AXIS_LEFTX,
        SDL_GAMEPAD_AXIS_LEFTY,
        SDL_GAMEPAD_AXIS_RIGHTX,
        SDL_GAMEPAD_AXIS_RIGHTY,
    };
    if (gamepad) {
        for (std::size_t index = 0; index < axes.size(); ++index) {
            const double raw = static_cast<double>(SDL_GetGamepadAxis(gamepad, axes[index]));
            values[index] = std::clamp(raw / 32767.0, -1.0, 1.0);
        }
    }
    PlatformGamepadState::Gamepad* cached = cached_gamepad(engine, handle);
    if (!cached)
        return js::Array<double>(values.begin(), values.end());
    if (!cached->axes_initialized ||
        !std::equal(values.begin(), values.end(), cached->axes.begin())) {
        cached->axes = js::Array<double>(values.begin(), values.end());
        cached->axes_initialized = true;
    }
    return cached->axes;
}

js::Array<GamepadButtonHandle> gamepad_buttons(Engine& engine, GamepadHandle gamepad) {
    if (PlatformGamepadState::Gamepad* cached = cached_gamepad(engine, gamepad)) {
        return cached->buttons;
    }
    return PlatformGamepadState::Gamepad(gamepad).buttons;
}

bool gamepad_button_pressed(Engine&, GamepadButtonHandle button) {
    SDL_Gamepad* gamepad = opened_gamepad(button.gamepad);
    if (!gamepad)
        return false;
    if (button.index == 6 || button.index == 7) {
        const SDL_GamepadAxis trigger =
            button.index == 6 ? SDL_GAMEPAD_AXIS_LEFT_TRIGGER : SDL_GAMEPAD_AXIS_RIGHT_TRIGGER;
        return SDL_GetGamepadAxis(gamepad, trigger) > 0;
    }
    const SDL_GamepadButton mapped = standard_gamepad_button(button.index);
    return mapped != SDL_GAMEPAD_BUTTON_INVALID && SDL_GetGamepadButton(gamepad, mapped);
}
#endif

namespace {

// Which rendering context the engine holds. A SpriteRenderer and an
// EffectRenderer each register on the engine rather than on a scene, so a
// scene registering one and no SceneContext generates no render plan and
// draws from that context's own translation unit instead.
enum class RendererKind { scene, sprites, canvas, effects, frame_graph, text };

RendererKind renderer_kind(const Engine& engine) {
    if (!engine.registered_text_renderers.empty())
        return RendererKind::text;
    if (!engine.registered_scenes.empty())
        return RendererKind::scene;
    if (!engine.registered_frame_graph_contexts.empty()) {
        return RendererKind::frame_graph;
    }
    if (!engine.registered_effect_renderers.empty()) {
        return RendererKind::effects;
    }
    if (bbl::has_sprite_renderers(engine)) {
        return RendererKind::sprites;
    }
#if BBLITE_HAS_UI
    if (engine.primary_canvas.value < engine.ui_elements.size()) {
        return RendererKind::canvas;
    }
#endif
    return RendererKind::scene;
}

const char* renderer_name(RendererKind kind) {
    switch (kind) {
    case RendererKind::sprites:
        return "A sprite renderer";
    case RendererKind::text:
        return "A text renderer";
    case RendererKind::canvas:
        return "A Canvas2D surface";
    case RendererKind::effects:
        return "An effect renderer";
    case RendererKind::frame_graph:
        return "A frame graph";
    case RendererKind::scene:
        break;
    }
    return "A scene";
}

[[noreturn]] void refuse_uncompiled_renderer(RendererKind kind, const pal::GpuBackend& backend) {
    throw std::runtime_error(std::string(renderer_name(kind)) + " is not compiled for the " +
                             std::string(backend.name) + " backend.");
}

#if !BBLITE_WORKERS
void run_renderer(Engine& engine, RendererKind kind, const pal::GpuBackend& backend) {
    void (*context)(Engine&) = nullptr;
    switch (kind) {
    case RendererKind::sprites:
    case RendererKind::text:
    case RendererKind::canvas:
        context = backend.run_2d;
        break;
    case RendererKind::effects:
        context = backend.run_effects;
        break;
    case RendererKind::frame_graph:
        context = backend.run_frame_graph;
        break;
    case RendererKind::scene:
        if (!backend.run_scene || !backend.run_scene(engine))
            refuse_uncompiled_renderer(kind, backend);
        return;
    }
    if (!context)
        refuse_uncompiled_renderer(kind, backend);
    context(engine);
}
#else
js::Promise<js::PromiseVoid> run_realm_frames(std::shared_ptr<Engine> engine,
                                              js::Promise<js::PromiseVoid> ready) {
    try {
        for (;;) {
            const auto kind = renderer_kind(*engine);
            if (kind != RendererKind::scene)
                throw std::runtime_error(std::string(renderer_name(kind)) +
                                         " does not yet support realm animation tasks.");
            engine->renderer_restart_requested = false;
            const pal::GpuBackend& backend = pal::selected_gpu_backend();
            if (!backend.run_scene)
                refuse_uncompiled_renderer(kind, backend);
            auto driver = backend.run_scene(*engine);
            driver.ready().observe(
                [ready](const js::PromiseVoid&) { ready.resolve(js::PromiseVoid{}); },
                [](std::exception_ptr) {}); // The finished result owns the error path below.
            driver.start();
            if (!(co_await driver.finished()))
                refuse_uncompiled_renderer(kind, backend);
            if (!engine->renderer_restart_requested)
                break;
        }
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        if (ready.pending())
            ready.reject(std::current_exception());
        else
            pal::EventLoop::current().post(
                [error = std::current_exception()] { std::rethrow_exception(error); });
    }
    co_return js::PromiseVoid{};
}
#endif

} // namespace

void pal::run_engine(Engine& engine) {
    require_runtime_execution("renderer or input execution");
#if BBLITE_WORKERS
    static_cast<void>(engine);
    throw std::logic_error("A Worker-enabled application must use asynchronous engine startup.");
#else
    SdlWindowRun window_run;
#if BBLITE_HAS_AUDIO
    // Finish this engine's audio before releasing its window services.
    struct AudioRunEnd {
        Engine& engine;
        ~AudioRunEnd() {
            if (engine.audio_session)
                engine.audio_session->finish();
        }
    } audio_run_end{engine};
#endif
    for (;;) {
        const RendererKind kind = renderer_kind(engine);
        if (pal::OffscreenRun::current()) {
            if (kind != RendererKind::scene) {
                throw std::runtime_error(
                    "Offscreen presentation currently supports scene renderers only.");
            }
#if BBLITE_HAS_UI
            throw std::runtime_error(
                "Offscreen presentation does not yet support a retained UI runtime.");
#endif
        }
        engine.renderer_restart_requested = false;
        try {
            run_renderer(engine, kind, pal::selected_gpu_backend());
#if BBLITE_DEVICE_RECOVERY
            if (engine.device_recovery && engine.device_recovery->requested)
                begin_device_recovery(engine);
#endif
        } catch (const std::exception& error) {
            static_cast<void>(error);
#if BBLITE_DEVICE_RECOVERY
            if (dynamic_cast<const GpuTransportError*>(&error))
                report_gpu_error(engine, error.what());
            if (engine.device_recovery && engine.device_recovery->recovering)
                fail_device_recovery(engine, error.what());
#endif
            throw;
        }
        if (!engine.renderer_restart_requested)
            return;
    }
#endif
}

#if BBLITE_WORKERS
js::Promise<js::PromiseVoid> pal::start_realm_engine(std::shared_ptr<Engine> engine) {
    if (engine->device_disposed)
        throw std::runtime_error("Cannot start an engine with a disposed GPU device.");
    engine->stopped = false;
    js::Promise<js::PromiseVoid> ready;
    run_realm_frames(std::move(engine), ready);
    return ready;
}
#endif

} // namespace bbl
