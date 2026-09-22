#pragma once

#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>

namespace bbl {
/** Retained source UBO views; callbacks may keep the array and offset map. */
struct MaterialPluginUniformState {
    js::F32Array data;
    js::Map<std::string, double> offsets;
};
} // namespace bbl
