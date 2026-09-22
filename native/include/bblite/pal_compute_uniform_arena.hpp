#pragma once
#include <bblite/pal_compute_task.hpp>
#include <bblite/pal_uniform_buffer.hpp>

namespace bbl {
struct ComputeUniformArena {
    std::shared_ptr<UniformBuffer> buffer;
    std::shared_ptr<ComputeTask> task;
    double slot_byte_length = 0;
    double slot_stride = 0;
    double slot_count = 0;
    double dirty_start = 0;
    double dirty_end = 0;
    bool destroyed = false;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(buffer);
        visitor(task);
    }
};
std::shared_ptr<ComputeUniformArena>
create_compute_uniform_arena(std::shared_ptr<ComputeTask>, double slot_byte_length,
                             double slot_count, std::optional<std::string> label = {});
double compute_uniform_slot_offset(const std::shared_ptr<ComputeUniformArena>&, double slot);
void update_compute_uniform_slot(const std::shared_ptr<ComputeUniformArena>&, double slot,
                                 std::span<const std::uint8_t>, double offset = 0);
void flush_compute_uniform_arena(const std::shared_ptr<ComputeUniformArena>&);
void dispose_compute_uniform_arena(const std::shared_ptr<ComputeUniformArena>&);
inline auto
compute_uniform_arena_slot_byte_length(const std::shared_ptr<ComputeUniformArena>& arena) {
    return arena->slot_byte_length;
}
inline auto compute_uniform_arena_slot_stride(const std::shared_ptr<ComputeUniformArena>& arena) {
    return arena->slot_stride;
}
inline auto compute_uniform_arena_slot_count(const std::shared_ptr<ComputeUniformArena>& arena) {
    return arena->slot_count;
}
inline auto compute_uniform_arena_destroyed(const std::shared_ptr<ComputeUniformArena>& arena) {
    return arena->destroyed;
}
inline auto compute_uniform_arena_buffer(const std::shared_ptr<ComputeUniformArena>& arena) {
    return arena->buffer;
}
} // namespace bbl
