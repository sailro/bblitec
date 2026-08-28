// SDL implementation of the platform abstraction layer: image decode, and
// the engine entry point that dispatches to a GPU backend.
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#if defined(BBLITE_HAS_AUDIO) && BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif
#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER
#include <bblite/pal_image.hpp>
#endif

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>

#include <SDL3/SDL.h>
#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER
#include <SDL3_image/SDL_image.h>
#endif

namespace bbl {

#if BBLITE_HAS_PBR_RENDERER || BBLITE_HAS_SPRITE_RENDERER
namespace {

/** Whether these bytes are a PNG carrying a palette (`PLTE`) of its own. */
bool png_carries_palette(const js::ArrayBuffer& buffer) {
    static constexpr std::array<std::uint8_t, 8> signature{
        0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    const std::uint8_t* bytes =
        static_cast<const std::uint8_t*>(buffer.data());
    const std::size_t size = buffer.byte_length();
    if (
        size < signature.size() ||
        !std::equal(signature.begin(), signature.end(), bytes)) {
        return false;
    }
    // Walk the chunk list: 4-byte big-endian length, 4-byte type, payload,
    // 4-byte CRC. `PLTE` precedes the first `IDAT`, so the scan stops there.
    std::size_t offset = signature.size();
    while (offset + 8 <= size) {
        const std::uint32_t length =
            (static_cast<std::uint32_t>(bytes[offset]) << 24) |
            (static_cast<std::uint32_t>(bytes[offset + 1]) << 16) |
            (static_cast<std::uint32_t>(bytes[offset + 2]) << 8) |
            static_cast<std::uint32_t>(bytes[offset + 3]);
        const char* type = reinterpret_cast<const char*>(bytes + offset + 4);
        if (std::memcmp(type, "PLTE", 4) == 0) return true;
        if (std::memcmp(type, "IDAT", 4) == 0) return false;
        offset += 12 + static_cast<std::size_t>(length);
    }
    return false;
}

/**
 * Correct the ramp SDL_image synthesises for a palette-less PNG.
 *
 * A greyscale PNG has no `PLTE`, so SDL_image expands it to an indexed
 * surface over a ramp it builds itself -- and builds it as
 * `(i * 255) / ncolors` (SDL3_image `IMG_libpng.c`), where the last entry
 * has to land on 255. At eight bits that maps grey 146 to 145 and tops the
 * ramp out at 254, so every greyscale image decoded here comes back up to a
 * level dark: measured on scene 4, whose heightmap is greyscale and whose
 * terrain sat one displacement step low across most of the mesh.
 *
 * The indices are the file's own sample values, so where the file carries
 * no palette the ramp is derivable rather than a guess -- which is why this
 * only touches that case. It is also self-retiring: recomputing the ramp
 * SDL_image should have built is a no-op once SDL_image builds it.
 */
void correct_synthetic_grey_ramp(
    SDL_Surface* surface,
    const js::ArrayBuffer& buffer) {
    SDL_Palette* palette = SDL_GetSurfacePalette(surface);
    if (!palette || palette->ncolors < 2) return;
    if (png_carries_palette(buffer)) return;
    const int last = palette->ncolors - 1;
    for (int index = 0; index <= last; ++index) {
        const auto value =
            static_cast<std::uint8_t>((index * 255) / last);
        palette->colors[index].r = value;
        palette->colors[index].g = value;
        palette->colors[index].b = value;
    }
}

} // namespace

pal::DecodedImage pal::decode_image(const js::ArrayBuffer& buffer) {
    SDL_IOStream* stream = SDL_IOFromConstMem(buffer.data(), buffer.byte_length());
    if (!stream) throw std::runtime_error(std::string("Unable to open image: ") + SDL_GetError());
    SDL_Surface* source = IMG_Load_IO(stream, true);
    if (!source) throw std::runtime_error(std::string("Unable to decode image: ") + SDL_GetError());
    correct_synthetic_grey_ramp(source, buffer);
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
#if defined(BBLITE_HAS_AUDIO) && BBLITE_HAS_AUDIO
    // A requested audio capture renders when the run ends, however it
    // ends -- the same seam CaptureGate takes a screenshot at. A build
    // that reached no audio compiles none of this, and never parses the
    // audio contract at all.
    struct AudioCaptureOnExit {
        ~AudioCaptureOnExit() { pal::audio_render_pending_captures(); }
    } audio_capture_on_exit;
#endif
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
