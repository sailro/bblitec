#pragma once

#include <bblite/pal.hpp>
#include <bblite/ts_runtime.hpp>

namespace bbl::pal {

inline ts::Promise<ts::ArrayBuffer> fetch_array_buffer(const std::string& path) {
    return ts::Promise<ts::ArrayBuffer>(ts::ArrayBuffer(read_binary_file(path)));
}

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

DecodedImage decode_image(const ts::ArrayBuffer& buffer);

} // namespace bbl::pal
