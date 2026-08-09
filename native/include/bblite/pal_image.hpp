#pragma once

#include <bblite/ts_runtime.hpp>

#include <cstdint>
#include <vector>

namespace bbl::pal {

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

DecodedImage decode_image(const ts::ArrayBuffer& buffer);

} // namespace bbl::pal
