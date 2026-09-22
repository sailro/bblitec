#pragma once
#include <bblite/pal_compute_uniform.hpp>
#include <bblite/pal_compute_uniform_arena.hpp>

namespace bbl {
/** Borrowed numeric array access for synchronous uniform setters. */
class UniformNumericView {
    const void* owner_;
    double (*read_)(const void*, std::size_t);
    std::size_t size_;

public:
    template <class T>
    explicit UniformNumericView(const T& value) : owner_(&value), size_(value.size()) {
        read_ = [](const void* owner, std::size_t index) -> double {
            const auto& array = *static_cast<const T*>(owner);
            if constexpr (requires { array.load(index); })
                return static_cast<double>(array.load(index));
            else
                return static_cast<double>(array[index]);
        };
    }
    double operator[](std::size_t index) const {
        return index < size_ ? read_(owner_, index) : std::numeric_limits<double>::quiet_NaN();
    }
    std::size_t size() const { return size_; }
};
struct ComputeUniformWriter {
    std::shared_ptr<ComputeUniformArena> arena;
    std::shared_ptr<const ComputeUniformLayout> layout;
    double slot = 0;
    double base_offset = 0;
    js::TypedArray<float> f32;
    js::TypedArray<std::uint32_t> u32;
    js::TypedArray<std::int32_t> i32;
    js::DataView data_view;
    std::optional<js::DataView> f16_scratch;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(arena);
        visitor(layout);
    }
};
std::shared_ptr<ComputeUniformWriter>
create_compute_uniform_writer(const std::shared_ptr<ComputeUniformArena>&, double,
                              const std::shared_ptr<const ComputeUniformLayout>&);
void set_compute_uniform_f32(const std::shared_ptr<ComputeUniformWriter>&, const std::string&,
                             double);
void set_compute_uniform_u32(const std::shared_ptr<ComputeUniformWriter>&, const std::string&,
                             double);
void set_compute_uniform_i32(const std::shared_ptr<ComputeUniformWriter>&, const std::string&,
                             double);
void set_compute_uniform_vector(const std::shared_ptr<ComputeUniformWriter>&, const std::string&,
                                UniformNumericView);
void set_compute_uniform_matrix(const std::shared_ptr<ComputeUniformWriter>&, const std::string&,
                                UniformNumericView);
inline auto compute_uniform_writer_arena(const std::shared_ptr<ComputeUniformWriter>& writer) {
    return writer->arena;
}
inline auto compute_uniform_writer_layout(const std::shared_ptr<ComputeUniformWriter>& writer) {
    return writer->layout;
}
inline double compute_uniform_writer_slot(const std::shared_ptr<ComputeUniformWriter>& writer) {
    return writer->slot;
}
} // namespace bbl
