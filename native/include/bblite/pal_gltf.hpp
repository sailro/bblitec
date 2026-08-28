#pragma once

#include <bblite/ts_runtime.hpp>

#include <bblite/pal_image.hpp>
#include <bblite/pal.hpp>

namespace bbl::pal {

inline ts::Promise<ts::ArrayBuffer> fetch_array_buffer(const std::string& path) {
    return ts::Promise<ts::ArrayBuffer>(ts::ArrayBuffer(read_binary_file(path)));
}

} // namespace bbl::pal
