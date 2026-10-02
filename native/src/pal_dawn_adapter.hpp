#pragma once

#include "pal_dawn_string.hpp"
#include <bblite/pal_gpu_adapter.hpp>
#include <stdexcept>

namespace bbl::pal {

inline GpuAdapterInfo dawn_adapter_info(WGPUAdapter adapter) {
    struct Info {
        WGPUAdapterInfo value = WGPU_ADAPTER_INFO_INIT;
        ~Info() { wgpuAdapterInfoFreeMembers(value); }
    } info;
    if (wgpuAdapterGetInfo(adapter, &info.value) != WGPUStatus_Success)
        throw std::runtime_error("Dawn adapter information is unavailable.");
    return {view_text(info.value.vendor), view_text(info.value.architecture),
            view_text(info.value.device), view_text(info.value.description)};
}

} // namespace bbl::pal
