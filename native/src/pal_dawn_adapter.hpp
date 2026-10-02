#pragma once

#include <bblite/pal_gpu_adapter.hpp>
#include <webgpu/webgpu.h>
#include <cstring>
#include <stdexcept>

namespace bbl::pal {

inline GpuAdapterInfo dawn_adapter_info(WGPUAdapter adapter) {
    struct Info {
        WGPUAdapterInfo value = WGPU_ADAPTER_INFO_INIT;
        ~Info() { wgpuAdapterInfoFreeMembers(value); }
    } info;
    if (wgpuAdapterGetInfo(adapter, &info.value) != WGPUStatus_Success)
        throw std::runtime_error("Dawn adapter information is unavailable.");
    const auto copy = [](WGPUStringView value) {
        return value.data
                   ? std::string(value.data, value.length == WGPU_STRLEN ? std::strlen(value.data)
                                                                         : value.length)
                   : std::string{};
    };
    return {copy(info.value.vendor), copy(info.value.architecture), copy(info.value.device),
            copy(info.value.description)};
}

} // namespace bbl::pal
