// SDL implementation of the platform abstraction layer: image decode, and
// the engine entry point that dispatches to a GPU backend.
#include <bblite/features/device_recovery.hpp>
#include <bblite/features/gpu_retirement.hpp>
#include <bblite/features/has_audio.hpp>
#include <bblite/features/has_gamepad.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/text_gpu.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_dom_events.hpp>
#if BBLITE_GPU_RETIREMENT && !BBLITE_WORKERS
#include <bblite/pal_source_gpu_run.hpp>
#endif
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
#include <mutex>
#include <optional>
#include <vector>

#include <SDL3/SDL.h>
#include "pal_gamepads.hpp"
#include "pal_window.hpp"
#include "pal_gpu_dispatch.hpp"
#include "pal_sdl_application.hpp"
#include "pal_gpu_frame.hpp"

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

/**
 * The Window's gamepads (W3C Gamepad `navigator.[[gamepads]]`): each slot's
 * SDL instance, kept from SDL's device events and hidden until a gamepad user
 * gesture. The thread that polls SDL writes them; a realm reads them.
 */
struct WindowGamepads {
    std::mutex mutex;
    std::vector<std::optional<std::uint32_t>> slots;
    bool exposed = false;
};

WindowGamepads& window_gamepads() {
    static WindowGamepads gamepads;
    return gamepads;
}

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

/** The standard mapping's buttons; the triggers are its buttons 6 and 7. */
bool is_standard_gamepad_button(SDL_GamepadButton button) {
    for (std::uint32_t index = 0; index <= 16; ++index)
        if (button != SDL_GAMEPAD_BUTTON_INVALID && standard_gamepad_button(index) == button)
            return true;
    return false;
}

/** A gamepad user gesture: a standard button or trigger pressed, or a stick past half its travel. */
bool is_gamepad_gesture(const SDL_Event& event) {
    if (event.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN)
        return is_standard_gamepad_button(static_cast<SDL_GamepadButton>(event.gbutton.button));
    if (event.type != SDL_EVENT_GAMEPAD_AXIS_MOTION)
        return false;
    const auto axis = static_cast<SDL_GamepadAxis>(event.gaxis.axis);
    if (axis == SDL_GAMEPAD_AXIS_LEFT_TRIGGER || axis == SDL_GAMEPAD_AXIS_RIGHT_TRIGGER)
        return event.gaxis.value > 0;
    return std::abs(static_cast<double>(event.gaxis.value) / 32767.0) > 0.5;
}

std::uint32_t gamepad_event_instance(const SDL_Event& event) {
    if (event.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN)
        return static_cast<std::uint32_t>(event.gbutton.which);
    if (event.type == SDL_EVENT_GAMEPAD_AXIS_MOTION)
        return static_cast<std::uint32_t>(event.gaxis.which);
    return static_cast<std::uint32_t>(event.gdevice.which);
}

} // namespace

std::vector<GamepadConnection> apply_gamepad_event(const SDL_Event& event) {
    auto& gamepads = window_gamepads();
    const std::lock_guard lock(gamepads.mutex);
    auto& slots = gamepads.slots;
    const std::uint32_t instance = gamepad_event_instance(event);
    const auto found = std::ranges::find(slots, std::optional{instance});
    const auto announce = [&](std::size_t index, bool connected) {
        return GamepadConnection{GamepadHandle{*slots[index], static_cast<std::uint32_t>(index)},
                                 connected};
    };
    std::vector<GamepadConnection> connections;
    if (event.type == SDL_EVENT_GAMEPAD_ADDED) {
        if (found != slots.end() || !opened_gamepad({instance, invalid_handle}))
            return connections;
        auto free = std::ranges::find(slots, std::optional<std::uint32_t>{});
        if (free == slots.end())
            free = slots.emplace(slots.end());
        *free = instance;
        if (gamepads.exposed)
            connections.push_back(
                announce(static_cast<std::size_t>(std::distance(slots.begin(), free)), true));
    } else if (event.type == SDL_EVENT_GAMEPAD_REMOVED) {
        if (found == slots.end())
            return connections;
        if (gamepads.exposed)
            connections.push_back(
                announce(static_cast<std::size_t>(std::distance(slots.begin(), found)), false));
        found->reset();
        while (!slots.empty() && !slots.back())
            slots.pop_back();
    } else if (!gamepads.exposed && found != slots.end() && is_gamepad_gesture(event)) {
        // The first gesture exposes every connected pad, in slot order.
        gamepads.exposed = true;
        for (std::size_t index = 0; index < slots.size(); ++index)
            if (slots[index])
                connections.push_back(announce(index, true));
    }
    return connections;
}

js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine& engine) {
    std::vector<std::optional<std::uint32_t>> slots;
    {
        auto& gamepads = window_gamepads();
        const std::lock_guard lock(gamepads.mutex);
        slots = gamepads.slots;
        // Hidden pads read as empty slots.
        if (!gamepads.exposed)
            std::ranges::fill(slots, std::nullopt);
    }
    PlatformGamepadState& state = gamepad_state(engine);
    state.slots.resize(slots.size());
    js::Array<js::Nullable<GamepadHandle>> result(slots.size());
    for (std::size_t index = 0; index < slots.size(); ++index) {
        auto& cached = state.slots[index];
        if (!slots[index]) {
            cached.reset();
            continue;
        }
        if (!cached || cached->handle.instance_id != *slots[index])
            cached.emplace(GamepadHandle{*slots[index], static_cast<std::uint32_t>(index)});
        result[index] = cached->handle;
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
    if (bbl::has_text_renderers(engine))
        return RendererKind::text;
    if (!engine.scenes().empty())
        return RendererKind::scene;
    if (!engine.frame_graph_contexts().empty()) {
        return RendererKind::frame_graph;
    }
    if (!engine.effect_renderer_contexts().empty()) {
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

#if BBLITE_DEVICE_RECOVERY
/** A renderer failure reaches the GPU error listeners and fails a recovery in flight. */
void settle_renderer_failure(Engine& engine, const std::exception& error) {
    if (dynamic_cast<const GpuTransportError*>(&error))
        report_gpu_error(engine, error.what());
    if (engine.device_recovery && engine.device_recovery->recovering)
        fail_device_recovery(engine, error.what());
}
#endif

/** The backend's driver for `kind`, presenting to its window or an application realm's endpoint. */
pal::SceneRun run_renderer(Engine& engine, RendererKind kind, const pal::GpuBackend& backend) {
    pal::SceneRun (*context)(Engine&) = nullptr;
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
        context = backend.run_scene;
        break;
    }
    if (!context)
        refuse_uncompiled_renderer(kind, backend);
    return context(engine);
}

#if BBLITE_WORKERS
/** Rejects the first-frame promise, or reports a later failure as the realm's uncaught error. */
void deliver_realm_frame_failure(js::Promise<js::PromiseVoid>& ready, std::exception_ptr failure) {
    if (ready.pending())
        ready.reject(failure);
    else
        pal::EventLoop::current().post([failure] { std::rethrow_exception(failure); });
}

js::Promise<js::PromiseVoid> run_realm_frames(std::shared_ptr<Engine> engine,
                                              js::Promise<js::PromiseVoid> ready) {
    try {
        for (;;) {
            const auto kind = renderer_kind(*engine);
            // The engine holds a registered FrameGraphContext by address, and
            // the realm entry that declares it returns at the first frame.
            if (kind == RendererKind::frame_graph)
                throw std::runtime_error(
                    "A frame graph does not yet support realm animation tasks: the engine holds "
                    "its registered FrameGraphContext by address, past the realm entry's return.");
            engine->renderer_restart_requested = false;
            const pal::GpuBackend& backend = pal::selected_gpu_backend();
            auto driver = run_renderer(*engine, kind, backend);
            driver.ready().observe(
                [ready](const js::PromiseVoid&) { ready.resolve(js::PromiseVoid{}); },
                [](std::exception_ptr) {}); // The finished result owns the error path below.
            driver.start();
            if (!(co_await driver.finished()))
                refuse_uncompiled_renderer(kind, backend);
#if BBLITE_DEVICE_RECOVERY
            // The producer's renderer released its resources on the Window
            // host's shared device; the next run rebuilds them.
            if (engine->device_recovery && engine->device_recovery->requested)
                begin_device_recovery(*engine);
#endif
            if (!engine->renderer_restart_requested)
                break;
        }
    } catch (const pal::WorkerTerminated&) {
        throw;
#if BBLITE_DEVICE_RECOVERY
    } catch (const std::exception& error) {
        // A throwing recovery callback escapes as this activation's rejection.
        settle_renderer_failure(*engine, error);
        deliver_realm_frame_failure(ready, std::current_exception());
#endif
    } catch (...) {
        deliver_realm_frame_failure(ready, std::current_exception());
    }
    co_return js::PromiseVoid{};
}
#endif

} // namespace

#if !BBLITE_WORKERS
static pal::Iteration<int> run_engine_iterations(Engine& engine) {
    pal::SdlWindowRun window_run;
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
#if BBLITE_HAS_UI
        if (pal::OffscreenRun::current())
            throw std::runtime_error(
                "Offscreen presentation does not yet support a retained UI runtime.");
#endif
        engine.renderer_restart_requested = false;
        try {
            auto renderer = run_renderer(engine, kind, pal::selected_gpu_backend());
            while (renderer.advance())
                co_yield true;
            if (!renderer.result())
                refuse_uncompiled_renderer(kind, pal::selected_gpu_backend());
#if BBLITE_DEVICE_RECOVERY
            if (engine.device_recovery && engine.device_recovery->requested)
                begin_device_recovery(engine);
#endif
        } catch (const std::exception& error) {
            static_cast<void>(error);
#if BBLITE_DEVICE_RECOVERY
            settle_renderer_failure(engine, error);
#endif
            throw;
        }
        if (!engine.renderer_restart_requested) {
#if BBLITE_GPU_RETIREMENT
            if (engine.scenes().empty())
                flush_frame_gpu_retirements(engine);
#endif
            // The page unloads once its frames end, however they end.
            dispatch_page_lifecycle(engine,
                                    [](auto& callback, const auto& payload) { callback(payload); });
            co_return 0;
        }
    }
}
#endif

void pal::run_engine(Engine& engine) {
    require_runtime_execution("renderer or input execution");
#if BBLITE_WORKERS
    static_cast<void>(engine);
    throw std::logic_error("A Worker-enabled application must use asynchronous engine startup.");
#else
    auto frames = run_engine_iterations(engine);
#if BBLITE_GPU_RETIREMENT
    if (engine.source_gpu_host_closed)
        throw std::runtime_error("Cannot restart an engine after its SDL application host closed.");
    frames = source_gpu_iterations(engine, std::move(frames));
    const auto before_shutdown = [&engine] {
        engine.source_gpu_loop.reset();
        engine.source_gpu_device.reset();
        engine.source_gpu_host_closed = true;
    };
    const int result =
        run_sdl_application(std::move(frames), read_frame_options().interactive(), before_shutdown);
#else
    const int result = run_sdl_application(std::move(frames), read_frame_options().interactive());
#endif
    if (result != 0)
        throw std::runtime_error("SDL application callbacks failed.");
#endif
}

#if BBLITE_WORKERS
// Declared by pal_async_engine.hpp, the realm engine's header.
void pal::bind_engine_webgpu_device(Engine& engine) {
    const pal::GpuBackend& backend = pal::selected_gpu_backend();
    if (!backend.bind_webgpu_device)
        throw std::runtime_error(std::string(backend.name) +
                                 " provides no engine WebGPU device in this build.");
    backend.bind_webgpu_device(engine);
}
#endif

#if BBLITE_WORKERS
js::Promise<js::PromiseVoid> pal::start_realm_engine(std::shared_ptr<Engine> engine) {
    if (engine->device_disposed)
        throw std::runtime_error("Cannot start an engine with a disposed GPU device.");
    const auto options = read_frame_options();
    // The capture clock holds until the engine's first rendered frame.
    if (options.frame_delta_ms > 0)
        pal::EventLoop::current().use_fixed_animation_time(options.frame_delta_ms,
                                                           /*held=*/true);
    engine->stopped = false;
    js::Promise<js::PromiseVoid> ready;
    run_realm_frames(std::move(engine), ready);
    return ready;
}
#endif

} // namespace bbl
