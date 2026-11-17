#include <bblite/features/has_image_decoder.hpp>

#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <SDL3/SDL.h>
#if BBLITE_HAS_IMAGE_DECODER
#include <SDL3_image/SDL_image.h>
#endif

#include <bblite/js_search_params.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

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

EncodedImage encode_image(std::span<const std::uint8_t> rgba, int width, int height,
                          const std::string& type, std::optional<double> quality) {
#if BBLITE_HAS_IMAGE_DECODER
    std::string mime = type;
    std::transform(mime.begin(), mime.end(), mime.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    const bool jpeg = mime == "image/jpeg";
    std::vector<std::uint8_t> pixels(rgba.begin(), rgba.end());
    if (jpeg)
        // JPEG has no alpha: the image composites onto opaque black.
        for (std::size_t offset = 0; offset + 3 < pixels.size(); offset += 4) {
            const std::uint32_t alpha = pixels[offset + 3];
            for (std::size_t channel = 0; channel < 3; ++channel)
                pixels[offset + channel] = static_cast<std::uint8_t>(
                    (static_cast<std::uint32_t>(pixels[offset + channel]) * alpha + 127u) / 255u);
            pixels[offset + 3] = 255;
        }
    using Surface = std::unique_ptr<SDL_Surface, decltype(&SDL_DestroySurface)>;
    const Surface surface{
        SDL_CreateSurfaceFrom(width, height, SDL_PIXELFORMAT_RGBA32, pixels.data(), width * 4),
        SDL_DestroySurface};
    if (!surface)
        throw std::runtime_error(std::string("Unable to wrap canvas pixels: ") + SDL_GetError());
    using Stream = std::unique_ptr<SDL_IOStream, decltype(&SDL_CloseIO)>;
    const Stream stream{SDL_IOFromDynamicMem(), SDL_CloseIO};
    if (!stream)
        throw std::runtime_error(std::string("Unable to open an image stream: ") + SDL_GetError());
    bool saved = false;
    {
        std::lock_guard lock(image_decoder_mutex());
        saved = jpeg ? IMG_SaveJPG_IO(surface.get(), stream.get(), false,
                                      quality && *quality >= 0.0 && *quality <= 1.0
                                          ? static_cast<int>(*quality * 100.0 + 0.5)
                                          : 92)
                     : IMG_SavePNG_IO(surface.get(), stream.get(), false);
    }
    if (!saved)
        throw std::runtime_error(std::string("Unable to encode canvas pixels: ") + SDL_GetError());
    const Sint64 size = SDL_GetIOSize(stream.get());
    std::vector<std::uint8_t> encoded(size > 0 ? static_cast<std::size_t>(size) : 0);
    if (SDL_SeekIO(stream.get(), 0, SDL_IO_SEEK_SET) < 0 ||
        SDL_ReadIO(stream.get(), encoded.data(), encoded.size()) != encoded.size())
        throw std::runtime_error(std::string("Unable to read encoded pixels: ") + SDL_GetError());
    return {jpeg ? "image/jpeg" : "image/png", std::move(encoded)};
#else
    (void)rgba;
    (void)width;
    (void)height;
    (void)type;
    (void)quality;
    throw std::runtime_error("This scene was built without image encoding.");
#endif
}

std::string encode_image_data_url(std::span<const std::uint8_t> rgba, int width, int height,
                                  const std::string& type, std::optional<double> quality) {
    // A canvas without pixels has no image to encode.
    if (width <= 0 || height <= 0)
        return "data:,";
    const EncodedImage image = encode_image(rgba, width, height, type, quality);
    return "data:" + image.type + ";base64," + js::bytes_to_base64(image.bytes);
}

} // namespace bbl::pal
