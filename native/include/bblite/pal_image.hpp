#pragma once

#include <bblite/js_data.hpp>

#include <cstdint>
#include <vector>

namespace bbl::pal {

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

DecodedImage decode_image(const js::ArrayBuffer& buffer);

} // namespace bbl::pal
