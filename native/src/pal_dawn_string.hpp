#pragma once

#include <webgpu/webgpu.h>
#include <string>

namespace bbl::pal {

inline std::string view_text(WGPUStringView view) {
    if (!view.data)
        return {};
    return view.length == WGPU_STRLEN ? std::string(view.data)
                                      : std::string(view.data, view.length);
}

} // namespace bbl::pal
