#pragma once
#include <bblite/pal_compute_storage_texture.hpp>
#include <bblite/pal_compute_task.hpp>
#include <bblite/pal_compute_command.hpp>

namespace bbl {
using PreparedComputeMipmaps = std::vector<std::shared_ptr<pal::ComputeMipmapLevel>>;
PreparedComputeMipmaps
prepare_compute_mipmaps(const std::shared_ptr<Engine>& engine,
                        const std::shared_ptr<pal::ComputeTextureAllocation>& texture_allocation,
                        const pal::ComputeTextureDescriptor& texture_descriptor,
                        std::optional<std::uint32_t> face = std::nullopt);
inline PreparedComputeMipmaps
prepare_compute_mipmaps(const std::shared_ptr<Engine>& engine,
                        const std::shared_ptr<ComputeStorageTexture>& texture,
                        std::optional<std::uint32_t> face = std::nullopt) {
    return prepare_compute_mipmaps(engine, texture->allocation, texture->descriptor, face);
}
void record_compute_mipmaps(const std::shared_ptr<pal::ComputeCommandEncoder>& encoder,
                            const PreparedComputeMipmaps& prepared);
std::shared_ptr<ComputeTask> create_compute_storage_texture_mipmaps_task(
    std::string name, const std::vector<std::shared_ptr<ComputeStorageTexture>>& resources);
inline std::shared_ptr<Engine>
compute_mipmap_resource_engine(const std::shared_ptr<ComputeStorageTexture>& resource) {
    const auto registry = resource->registry.lock();
    return registry ? registry->engine.lock() : nullptr;
}
} // namespace bbl
