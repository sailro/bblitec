#pragma once
#include <bblite/pal_compute_bindings.hpp>

namespace bbl {
namespace pal {
struct ComputePassEncoder;
}
using ComputeOffsets = js::Array<double>;
using ComputeOffsetGroups = js::Array<std::optional<ComputeOffsets>>;
struct ComputeDispatchSize {
    double x = 0;
    std::optional<double> y, z;
};
struct ComputeDispatchOptions {
    ComputeDispatchSize size;
    std::optional<bool> enabled;
};
struct ComputeDispatch {
    std::shared_ptr<ComputeShader> shader;
    std::shared_ptr<ComputeBindingSet> bindings;
    bool enabled = true;
    std::array<double, 3> dimensions{};
    std::optional<ComputeOffsetGroups> dynamic_offsets;
    js::Callback<std::shared_ptr<pal::ComputePipeline>()> get_pipeline;
    js::Callback<js::Promise<js::PromiseVoid>()> prepare_pipeline;
    js::Callback<void(pal::ComputePassEncoder&, const std::shared_ptr<ComputeDispatch>&)> record;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(shader);
        visitor(bindings);
        visitor(dynamic_offsets);
        visitor(get_pipeline);
        visitor(prepare_pipeline);
        visitor(record);
    }
};
std::shared_ptr<ComputeDispatch> create_compute_dispatch(const std::shared_ptr<ComputeShader>&,
                                                         const std::shared_ptr<ComputeBindingSet>&,
                                                         const ComputeDispatchOptions&);
void set_compute_dispatch_size(const std::shared_ptr<ComputeDispatch>&, const ComputeDispatchSize&);
void set_compute_dispatch_dynamic_offset(const std::shared_ptr<ComputeDispatch>&,
                                         const std::string&, double);
inline bool& compute_dispatch_enabled(const std::shared_ptr<ComputeDispatch>& value) {
    return value->enabled;
}
inline std::shared_ptr<ComputeShader>
compute_dispatch_shader(const std::shared_ptr<ComputeDispatch>& value) {
    return value->shader;
}
inline std::shared_ptr<ComputeBindingSet>
compute_dispatch_bindings(const std::shared_ptr<ComputeDispatch>& value) {
    return value->bindings;
}
} // namespace bbl
