#include <bblite/features/has_image_decoder.hpp>

#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <SDL3/SDL.h>
#if BBLITE_HAS_IMAGE_DECODER
#include <SDL3_image/SDL_image.h>
#endif

#include <algorithm>
#include <memory>
#include <stdexcept>

namespace bbl::pal {
// The greyscale ramp SDL_image synthesises for a palette-less PNG is
// corrected in the vendored overlay port (`native/vcpkg-overlay-ports/
// sdl3-image`, png-grey-ramp-last-index.patch), not here: the dependency
// decodes right rather than the PAL rebuilding its palette afterwards.
DecodedImage decode_image(std::span<const std::uint8_t> bytes) {
#if BBLITE_HAS_IMAGE_DECODER
    SDL_IOStream* stream = SDL_IOFromConstMem(bytes.data(), bytes.size());
    if (!stream)
        throw std::runtime_error(std::string("Unable to open image: ") + SDL_GetError());
    using Surface = std::unique_ptr<SDL_Surface, decltype(&SDL_DestroySurface)>;
    Surface source{nullptr, SDL_DestroySurface};
    {
        // SDL_image's codec initializers mutate process-wide library state.
        std::lock_guard lock(image_decoder_mutex());
        source.reset(IMG_Load_IO(stream, true));
    }
    if (!source)
        throw std::runtime_error(std::string("Unable to decode image: ") + SDL_GetError());
    Surface converted{SDL_ConvertSurface(source.get(), SDL_PIXELFORMAT_RGBA32), SDL_DestroySurface};
    source.reset();
    if (!converted)
        throw std::runtime_error(std::string("Unable to convert image: ") + SDL_GetError());

    DecodedImage result;
    result.width = converted->w;
    result.height = converted->h;
    result.rgba.resize(static_cast<std::size_t>(result.width) * result.height * 4);
    for (int y = 0; y < result.height; ++y) {
        const auto* source_row =
            static_cast<const std::uint8_t*>(converted->pixels) + y * converted->pitch;
        std::copy_n(source_row, static_cast<std::size_t>(result.width) * 4,
                    result.rgba.data() + static_cast<std::size_t>(y) * result.width * 4);
    }
    return result;
#else
    (void)bytes;
    throw std::runtime_error("This scene was built without image decoding.");
#endif
}

} // namespace bbl::pal
