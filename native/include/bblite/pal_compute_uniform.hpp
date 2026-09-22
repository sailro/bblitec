#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace bbl {
/** Layout data produced by the pinned WGSL uniform-layout factory. */
struct ComputeUniformFieldSlot {
    std::string type;
    double offset;
    double byte_length;
    double element_count;
    double row_count;
    double column_stride;
    double scalar;
    double kind;
};
struct ComputeUniformLayout {
    double byte_length;
    std::vector<std::pair<std::string, ComputeUniformFieldSlot>> fields;
};
inline double
compute_uniform_layout_byte_length(const std::shared_ptr<const ComputeUniformLayout>& layout) {
    return layout->byte_length;
}
} // namespace bbl
