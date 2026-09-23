#pragma once
#include <bblite/pal_uniform_buffer.hpp>
#include <bblite/pal_compute_binding.hpp>
#include <bblite/pal_compute_pipeline.hpp>
#include <functional>

namespace bbl {
/** Retains source wrapper identity while projecting the two native buffer representations. */
struct ComputeBufferReference {
    std::shared_ptr<Engine> engine;
    std::optional<StorageBufferHandle> storage;
    std::shared_ptr<UniformBuffer> uniform;
    bool destroyed() const {
        return storage ? engine->storage_buffers.at(storage->value).disposed : uniform->destroyed;
    }
    double byte_length() const {
        return storage ? static_cast<double>(engine->storage_buffers.at(storage->value).byte_length)
                       : uniform->byte_length;
    }
    std::shared_ptr<pal::StorageBufferAllocation> allocation() const {
        if (!storage)
            return uniform->allocation;
        const auto& record = engine->storage_buffers.at(storage->value);
        return record.gpu ? record.gpu->allocation : nullptr;
    }
    bool writable() const { return storage && engine->storage_buffers.at(storage->value).writable; }
    bool registered() const {
        if (storage)
            return engine->storage_buffers.at(storage->value).registered;
        const auto registry = uniform->registry.lock();
        return registry && registry->buffers.contains(uniform);
    }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(engine); }
};
using ComputeBufferReferencePtr = std::shared_ptr<ComputeBufferReference>;
inline ComputeBufferReferencePtr compute_buffer_reference(const std::shared_ptr<Engine>& engine,
                                                          StorageBufferHandle storage) {
    return js::make_gc_shared<ComputeBufferReference>(ComputeBufferReference{engine, storage, {}});
}
inline ComputeBufferReferencePtr
compute_buffer_reference(const std::shared_ptr<UniformBuffer>& uniform) {
    if (!uniform)
        return {};
    return js::make_gc_shared<ComputeBufferReference>(
        ComputeBufferReference{uniform->engine.lock(), {}, uniform});
}
inline ComputeBufferReferencePtr compute_buffer_reference(StorageBufferHandle storage) {
    auto engine = storage.engine.lock();
    if (!engine)
        return {};
    return compute_buffer_reference(engine, storage);
}
struct ComputeBufferRange {
    ComputeBufferReferencePtr buffer;
    std::optional<double> offset, size;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(buffer); }
};
struct ComputeBufferBindingState {
    ComputeBufferReferencePtr buffer;
    double offset = 0;
    std::optional<double> size;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(buffer); }
};
struct ComputeDynamicBindingInfo {
    double alignment = 0, max_offset = 0;
};
struct ComputeResolvedBufferBinding {
    ComputeBufferBindingState state;
    std::optional<ComputeDynamicBindingInfo> dynamic;
};
using ComputeBufferPredicate = std::function<bool(const ComputeBufferReferencePtr&)>;
using ComputeBufferMembership =
    std::function<bool(const std::shared_ptr<Engine>&, const ComputeBufferReferencePtr&)>;
ComputeResolvedBufferBinding
resolve_compute_buffer_binding(const std::shared_ptr<Engine>&, const ComputeBindingDeclPtr&,
                               const ComputeBufferRange&, const ComputeBufferPredicate&,
                               const ComputeBufferPredicate&, bool writable, bool dynamic,
                               double min_binding_size, double max_binding_size, double alignment);
pal::ComputeBufferResource get_compute_buffer_binding_resource(const std::shared_ptr<Engine>&,
                                                               const ComputeBufferBindingState&,
                                                               const ComputeBufferMembership&);
ComputeResolvedBufferBinding resolve_compute_storage_buffer(const std::shared_ptr<Engine>&,
                                                            const ComputeBindingDeclPtr&,
                                                            const ComputeBufferRange&);
ComputeResolvedBufferBinding resolve_compute_uniform_buffer(const std::shared_ptr<Engine>&,
                                                            const ComputeBindingDeclPtr&,
                                                            const ComputeBufferRange&);
pal::ComputeBufferResource get_compute_storage_buffer(const std::shared_ptr<Engine>&,
                                                      const ComputeBufferBindingState&);
pal::ComputeBufferResource get_compute_uniform_buffer(const std::shared_ptr<Engine>&,
                                                      const ComputeBufferBindingState&);
} // namespace bbl
