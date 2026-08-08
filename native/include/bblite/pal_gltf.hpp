#pragma once

#include <bblite/pal.hpp>
#include <bblite/ts_runtime.hpp>

namespace bbl {
struct AssetHandle;
}

namespace bbl::pal {

ts::Promise<ts::ArrayBuffer> fetch_array_buffer(const std::string& path);
AssetHandle load_glb(Engine& engine, const ts::ArrayBuffer& buffer, const std::string& path);

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

DecodedImage decode_image(const ts::Blob& blob);

} // namespace bbl::pal
