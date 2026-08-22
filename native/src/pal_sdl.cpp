// SDL implementation of the platform abstraction layer: image decode, and
// the engine entry point that dispatches to a GPU backend.
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER
#include <bblite/pal_image.hpp>
#endif

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>

#include <SDL3/SDL.h>
#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER
#include <SDL3_image/SDL_image.h>
#endif

namespace bbl {

#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER
pal::DecodedImage pal::decode_image(const ts::ArrayBuffer& buffer) {
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
enum class RendererKind { scene, sprites, effects };

RendererKind renderer_kind(const Engine& engine) {
    if (!engine.registered_scenes.empty()) return RendererKind::scene;
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
        case RendererKind::scene: break;
    }
    return pal::run_dawn_engine(engine);
}

} // namespace

void pal::run_engine(Engine& engine) {
    const RendererKind kind = renderer_kind(engine);
    // bblitec requires a GPU. A backend that reaches its device and fails
    // throws, and the throw propagates: there is no software path to
    // degrade into, so a failure is the answer rather than a condition to
    // route around. Returning false means only that this build compiled
    // the backend out, which is what makes trying the next one correct.
    if (pal::environment_variable("BBLITE_GPU_BACKEND") == "dawn") {
        if (run_dawn(engine, kind)) return;
        throw std::runtime_error(
            std::string(renderer_name(kind)) +
            " was asked for Dawn (BBLITE_GPU_BACKEND=dawn), which this "
            "build does not compile (BBLITE_BACKEND=DAWN or BOTH).");
    }
    if (run_sdl_gpu(engine, kind)) return;
    if (run_dawn(engine, kind)) return;
    // Unreachable in a configure-valid build: BBLITE_BACKEND compiles at
    // least one backend, and CMake refuses every other value.
    throw std::runtime_error(
        std::string(renderer_name(kind)) +
        " requires a GPU backend, and this build compiled none that can "
        "draw it (BBLITE_BACKEND selects SDL_GPU, DAWN or BOTH).");
}

} // namespace bbl
