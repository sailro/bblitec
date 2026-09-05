// SDL implementation of the platform abstraction layer: image decode, and
// the engine entry point that dispatches to a GPU backend.
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#if defined(BBLITE_HAS_AUDIO) && BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif
#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER || \
    BBLITE_HAS_EFFECT_RENDERER
#include <bblite/pal_image.hpp>
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
#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER || \
    BBLITE_HAS_EFFECT_RENDERER
#include <SDL3_image/SDL_image.h>
#endif

namespace bbl {

#if defined(BBLITE_HAS_GAMEPAD) && BBLITE_HAS_GAMEPAD
struct PlatformGamepadState {
    struct Gamepad {
        explicit Gamepad(GamepadHandle value)
            : handle(value), buttons(17), axes(4) {
            for (std::size_t index = 0; index < buttons.size(); ++index) {
                buttons[index] = GamepadButtonHandle{
                    handle, static_cast<std::uint32_t>(index)};
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
        engine.platform_gamepad_state =
            std::make_shared<PlatformGamepadState>();
    }
    return *engine.platform_gamepad_state;
}

PlatformGamepadState::Gamepad* cached_gamepad(
    Engine& engine,
    GamepadHandle handle) {
    if (!engine.platform_gamepad_state) return nullptr;
    for (auto& entry : engine.platform_gamepad_state->slots) {
        if (entry && entry->handle.instance_id == handle.instance_id) {
            return &*entry;
        }
    }
    return nullptr;
}

SDL_Gamepad* opened_gamepad(GamepadHandle handle) {
    if (handle.instance_id == invalid_handle) return nullptr;
    const SDL_JoystickID instance_id =
        static_cast<SDL_JoystickID>(handle.instance_id);
    SDL_Gamepad* gamepad = SDL_GetGamepadFromID(instance_id);
    return gamepad ? gamepad : SDL_OpenGamepad(instance_id);
}

/** Browser standard-mapping button order, excluding the two trigger axes. */
SDL_GamepadButton standard_gamepad_button(std::uint32_t index) {
    switch (index) {
        case 0: return SDL_GAMEPAD_BUTTON_SOUTH;
        case 1: return SDL_GAMEPAD_BUTTON_EAST;
        case 2: return SDL_GAMEPAD_BUTTON_WEST;
        case 3: return SDL_GAMEPAD_BUTTON_NORTH;
        case 4: return SDL_GAMEPAD_BUTTON_LEFT_SHOULDER;
        case 5: return SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER;
        case 8: return SDL_GAMEPAD_BUTTON_BACK;
        case 9: return SDL_GAMEPAD_BUTTON_START;
        case 10: return SDL_GAMEPAD_BUTTON_LEFT_STICK;
        case 11: return SDL_GAMEPAD_BUTTON_RIGHT_STICK;
        case 12: return SDL_GAMEPAD_BUTTON_DPAD_UP;
        case 13: return SDL_GAMEPAD_BUTTON_DPAD_DOWN;
        case 14: return SDL_GAMEPAD_BUTTON_DPAD_LEFT;
        case 15: return SDL_GAMEPAD_BUTTON_DPAD_RIGHT;
        case 16: return SDL_GAMEPAD_BUTTON_GUIDE;
        default: return SDL_GAMEPAD_BUTTON_INVALID;
    }
}

} // namespace

js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine& engine) {
    int count = 0;
    SDL_JoystickID* ids = SDL_GetGamepads(&count);
    std::vector<std::uint32_t> connected;
    connected.reserve(static_cast<std::size_t>(std::max(0, count)));
    for (int index = 0; index < count; ++index) {
        const std::uint32_t instance_id =
            static_cast<std::uint32_t>(ids[index]);
        if (opened_gamepad({instance_id, invalid_handle})) {
            connected.push_back(instance_id);
        }
    }
    SDL_free(ids);

    PlatformGamepadState& state = gamepad_state(engine);
    for (auto& entry : state.slots) {
        if (
            entry &&
            std::find(
                connected.begin(),
                connected.end(),
                entry->handle.instance_id) == connected.end()) {
            entry.reset();
        }
    }
    for (const std::uint32_t instance_id : connected) {
        const auto existing = std::find_if(
            state.slots.begin(),
            state.slots.end(),
            [instance_id](const auto& entry) {
                return entry && entry->handle.instance_id == instance_id;
            });
        if (existing != state.slots.end()) continue;
        auto available = std::find_if(
            state.slots.begin(),
            state.slots.end(),
            [](const auto& entry) { return !entry; });
        if (available == state.slots.end()) {
            state.slots.emplace_back();
            available = std::prev(state.slots.end());
        }
        const std::uint32_t stable_index = static_cast<std::uint32_t>(
            std::distance(state.slots.begin(), available));
        available->emplace(GamepadHandle{instance_id, stable_index});
    }
    while (!state.slots.empty() && !state.slots.back()) {
        state.slots.pop_back();
    }

    js::Array<js::Nullable<GamepadHandle>> result(state.slots.size());
    for (std::size_t index = 0; index < state.slots.size(); ++index) {
        if (state.slots[index]) result[index] = state.slots[index]->handle;
    }
    return result;
}

double gamepad_index(Engine&, GamepadHandle gamepad) {
    return static_cast<double>(gamepad.index);
}

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
            const double raw = static_cast<double>(
                SDL_GetGamepadAxis(gamepad, axes[index]));
            values[index] = std::clamp(raw / 32767.0, -1.0, 1.0);
        }
    }
    PlatformGamepadState::Gamepad* cached = cached_gamepad(engine, handle);
    if (!cached) return js::Array<double>(values.begin(), values.end());
    if (
        !cached->axes_initialized ||
        !std::equal(values.begin(), values.end(), cached->axes.begin())) {
        cached->axes = js::Array<double>(values.begin(), values.end());
        cached->axes_initialized = true;
    }
    return cached->axes;
}

js::Array<GamepadButtonHandle> gamepad_buttons(
    Engine& engine,
    GamepadHandle gamepad) {
    if (PlatformGamepadState::Gamepad* cached =
            cached_gamepad(engine, gamepad)) {
        return cached->buttons;
    }
    return PlatformGamepadState::Gamepad(gamepad).buttons;
}

bool gamepad_button_pressed(Engine&, GamepadButtonHandle button) {
    SDL_Gamepad* gamepad = opened_gamepad(button.gamepad);
    if (!gamepad) return false;
    if (button.index == 6 || button.index == 7) {
        const SDL_GamepadAxis trigger = button.index == 6
            ? SDL_GAMEPAD_AXIS_LEFT_TRIGGER
            : SDL_GAMEPAD_AXIS_RIGHT_TRIGGER;
        return SDL_GetGamepadAxis(gamepad, trigger) > 0;
    }
    const SDL_GamepadButton mapped = standard_gamepad_button(button.index);
    return mapped != SDL_GAMEPAD_BUTTON_INVALID &&
        SDL_GetGamepadButton(gamepad, mapped);
}
#endif

#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER || \
    BBLITE_HAS_EFFECT_RENDERER
// The greyscale ramp SDL_image synthesises for a palette-less PNG is
// corrected in the vendored overlay port (`native/vcpkg-overlay-ports/
// sdl3-image`, png-grey-ramp-last-index.patch), not here: the dependency
// decodes right rather than the PAL rebuilding its palette afterwards.
pal::DecodedImage pal::decode_image(const js::ArrayBuffer& buffer) {
    SDL_IOStream* stream = SDL_IOFromConstMem(buffer.data(), buffer.byte_length());
    if (!stream) throw std::runtime_error(std::string("Unable to open image: ") + SDL_GetError());
    SDL_Surface* source = IMG_Load_IO(stream, true);
    if (!source) throw std::runtime_error(std::string("Unable to decode image: ") + SDL_GetError());
    SDL_Surface* converted = SDL_ConvertSurface(source, SDL_PIXELFORMAT_RGBA32);
    SDL_DestroySurface(source);
    if (!converted) throw std::runtime_error(std::string("Unable to convert image: ") + SDL_GetError());

    pal::DecodedImage result;
    result.width = converted->w;
    result.height = converted->h;
    result.rgba.resize(static_cast<std::size_t>(result.width) * result.height * 4);
    for (int y = 0; y < result.height; ++y) {
        const auto* source_row = static_cast<const std::uint8_t*>(converted->pixels) + y * converted->pitch;
        std::copy_n(
            source_row,
            static_cast<std::size_t>(result.width) * 4,
            result.rgba.data() + static_cast<std::size_t>(y) * result.width * 4);
    }
    SDL_DestroySurface(converted);
    return result;
}
#endif

namespace {

// Which rendering context the engine holds. A SpriteRenderer and an
// EffectRenderer each register on the engine rather than on a scene, so a
// scene registering one and no SceneContext generates no render plan and
// draws from that context's own translation unit instead.
enum class RendererKind { scene, sprites, effects, frame_graph };

RendererKind renderer_kind(const Engine& engine) {
    if (!engine.registered_scenes.empty()) return RendererKind::scene;
    if (!engine.registered_frame_graph_contexts.empty()) {
        return RendererKind::frame_graph;
    }
    if (!engine.registered_effect_renderers.empty()) {
        return RendererKind::effects;
    }
    if (!engine.registered_sprite_renderers.empty()) {
        return RendererKind::sprites;
    }
    return RendererKind::scene;
}

const char* renderer_name(RendererKind kind) {
    switch (kind) {
        case RendererKind::sprites: return "A sprite renderer";
        case RendererKind::effects: return "An effect renderer";
        case RendererKind::frame_graph: return "A frame graph";
        case RendererKind::scene: break;
    }
    return "A scene";
}

// Each entry point is a real function when its backend and its renderer
// are both compiled in, and `pal_gpu.hpp`'s inline stub returning false
// otherwise -- so "did this build compile it" is the only question these
// return values answer.
bool run_sdl_gpu(Engine& engine, RendererKind kind) {
    switch (kind) {
        case RendererKind::sprites:
            return pal::run_sprite_gpu_engine(engine);
        case RendererKind::effects:
            return pal::run_effect_gpu_engine(engine);
        case RendererKind::frame_graph:
            return pal::run_frame_graph_gpu_engine(engine);
        case RendererKind::scene: break;
    }
    return pal::run_gpu_engine(engine);
}

bool run_dawn(Engine& engine, RendererKind kind) {
    switch (kind) {
        case RendererKind::sprites:
            return pal::run_sprite_dawn_engine(engine);
        case RendererKind::effects:
            return pal::run_effect_dawn_engine(engine);
        case RendererKind::frame_graph:
            return pal::run_frame_graph_dawn_engine(engine);
        case RendererKind::scene: break;
    }
    return pal::run_dawn_engine(engine);
}

} // namespace

void pal::run_engine(Engine& engine) {
    SdlWindowRun window_run;
#if defined(BBLITE_HAS_AUDIO) && BBLITE_HAS_AUDIO
    // The audio run ends when the render run ends, however it ends -- the
    // same seam CaptureGate takes a screenshot at: a requested capture
    // renders, then every context closes, so no audio thread outlives the
    // run into static destruction. This closes audio before the engine-run
    // window owner shuts SDL down. A build
    // that reached no audio compiles none of this, and never parses the
    // audio contract at all.
    struct AudioRunEnd {
        ~AudioRunEnd() {
            pal::audio_render_pending_captures();
            pal::audio_close_all_contexts();
        }
    } audio_run_end;
#endif
    for (;;) {
        const RendererKind kind = renderer_kind(engine);
        engine.renderer_restart_requested = false;
        // bblitec requires a GPU. A backend that reaches its device and fails
        // throws, and the throw propagates: there is no software path to
        // degrade into, so a failure is the answer rather than a condition to
        // route around. Returning false means only that this build compiled
        // the backend out, which is what makes trying the next one correct.
        bool ran = false;
        if (pal::environment_variable("BBLITE_GPU_BACKEND") == "dawn") {
            ran = run_dawn(engine, kind);
            if (!ran) {
                throw std::runtime_error(
                    std::string(renderer_name(kind)) +
                    " was asked for Dawn (BBLITE_GPU_BACKEND=dawn), which this "
                    "build does not compile (BBLITE_BACKEND=DAWN or BOTH).");
            }
        } else {
            ran = run_sdl_gpu(engine, kind) || run_dawn(engine, kind);
            if (!ran) {
                // Unreachable in a configure-valid build: BBLITE_BACKEND
                // compiles at least one backend, and CMake refuses every
                // other value.
                throw std::runtime_error(
                    std::string(renderer_name(kind)) +
                    " requires a GPU backend, and this build compiled none "
                    "that can draw it (BBLITE_BACKEND selects SDL_GPU, Dawn "
                    "or BOTH).");
            }
        }
        if (!engine.renderer_restart_requested) return;
    }
}

} // namespace bbl
