#pragma once
#include <bblite/pal_gpu_storage_buffer.hpp>
#include <unordered_set>

namespace bbl {
struct UniformBuffer;
struct UniformBufferRegistry {
    std::weak_ptr<Engine> engine;
    std::unordered_set<std::shared_ptr<UniformBuffer>> buffers;
};
struct UniformBuffer {
    std::weak_ptr<Engine> engine;
    std::weak_ptr<UniformBufferRegistry> registry;
    std::shared_ptr<pal::OffscreenRun> run;
    std::shared_ptr<pal::StorageBufferAllocation> allocation;
    std::optional<js::U8Array> data;
    double byte_length = 0;
    bool destroyed = false;
};
std::shared_ptr<UniformBuffer> create_uniform_buffer(std::shared_ptr<Engine>, StorageBufferSource,
                                                     std::optional<std::string> label = {});
std::shared_ptr<pal::StorageBufferAllocation>
get_uniform_buffer_handle(const std::shared_ptr<Engine>&, const std::shared_ptr<UniformBuffer>&);
void update_uniform_buffer(const std::shared_ptr<Engine>&, const std::shared_ptr<UniformBuffer>&,
                           std::span<const std::uint8_t>, double offset = 0);
void dispose_uniform_buffer(const std::shared_ptr<UniformBuffer>&);
void dispose_uniform_buffers(const std::shared_ptr<UniformBufferRegistry>&);
inline double uniform_buffer_byte_length(const std::shared_ptr<UniformBuffer>& buffer) {
    return buffer->byte_length;
}
inline bool uniform_buffer_destroyed(const std::shared_ptr<UniformBuffer>& buffer) {
    return buffer->destroyed;
}
} // namespace bbl
