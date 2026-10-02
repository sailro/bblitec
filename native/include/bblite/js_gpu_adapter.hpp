#pragma once

#include <bblite/js_data.hpp>
#include <bblite/pal_gpu_adapter.hpp>

namespace bbl::pal {

using GpuAdapterInfoHandle = js::Ref<GpuAdapterInfo>;
struct GpuAdapterRecord {
    GpuAdapterInfoHandle info;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(info); }
};
using GpuAdapterHandle = js::Ref<GpuAdapterRecord>;

} // namespace bbl::pal
