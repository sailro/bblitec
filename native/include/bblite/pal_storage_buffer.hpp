#pragma once

#include <cstdint>
#include <cstddef>
#include <memory>
#include <optional>
#include <span>
#include <string>

namespace bbl {
struct Engine;
}

namespace bbl::pal {
struct StorageReadback;
struct StorageReadbackDescriptor;
struct StorageReadbackState;

/** WebGPU role bits retained by the source descriptor before backend adaptation. */
enum class StorageBufferRole : std::uint32_t {
    copy_src = 4,
    index = 16,
    vertex = 32,
    uniform = 64,
    storage = 128,
    indirect = 256,
};

struct StorageBufferDescriptor {
    std::size_t byte_length = 0;
    std::uint32_t roles = 0;
    std::string label;
};

/** GPU handles and byte transport; source validation belongs to generated code. */
struct StorageBufferAllocation {
    virtual ~StorageBufferAllocation() = default;
    virtual void destroy() = 0;
    virtual void write(std::size_t offset, std::span<const std::uint8_t> bytes) = 0;
};

class OffscreenRun;

/** The generated lifetime methods own each role allocation through the same engine record. */
struct StorageBufferOwner {
    virtual ~StorageBufferOwner() = default;
    std::weak_ptr<Engine> engine;
    std::shared_ptr<OffscreenRun> device;
    std::shared_ptr<StorageBufferAllocation> allocation;
    std::shared_ptr<StorageReadbackState> readback_state;
    virtual void update(Engine&, std::uint32_t slot, std::span<const std::uint8_t>,
                        double offset) = 0;
    virtual void dispose(Engine&, std::uint32_t slot) = 0;
};

} // namespace bbl::pal
