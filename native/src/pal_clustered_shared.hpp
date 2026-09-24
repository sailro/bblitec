#pragma once

#include <bblite/runtime.hpp>
#include <bblite/upstream/clustered_light.hpp>

namespace bbl::pal {

enum class ClusteredTexture { lights, cells, indices };

/** Which of the pin's writes a backend has uploaded, by their counts. */
struct ClusteredUploads {
    std::uint64_t params = 0;
    std::uint64_t lights = 0;
    std::uint64_t cells = 0;
    std::uint64_t indices = 0;
};

/**
 * The scene's updater, `_clusteredLightUpdater?.(camera, width, height)`:
 * the pin's refresh over the refresh state the container keeps once its
 * build returned, then every write it made that this backend has not
 * uploaded yet -- the params block, and each data texture over the region
 * its `writeDataTexture` stated. A count is published only after its
 * upload succeeded, so a failed one is retried by the next frame.
 */
template <class Params, class Texture>
void sync_clustered_payloads(Engine& engine, ClusteredLightContainer& container,
                             ClusteredUploads& uploaded, CameraHandle camera, double target_width,
                             double target_height, Params&& params, Texture&& texture) {
    if (container.refresh)
        upstream::refresh_clustered_lights(engine, container, *container.refresh, camera,
                                           target_width, target_height);
    if (uploaded.params != container.params_write) {
        params(container.params.data(), container.params.size() * sizeof(std::uint32_t));
        uploaded.params = container.params_write;
    }
    const auto upload = [&](ClusteredTexture slot, const auto& bytes,
                            const ClusteredTextureWrite& write, std::uint64_t& done) {
        if (done == write.version)
            return;
        texture(slot, bytes.data(), bytes.size() * sizeof(bytes[0]), write);
        done = write.version;
    };
    upload(ClusteredTexture::lights, container.light_data, container.light_write, uploaded.lights);
    upload(ClusteredTexture::cells, container.slice_data, container.slice_write, uploaded.cells);
    upload(ClusteredTexture::indices, container.mask_data, container.mask_write, uploaded.indices);
}

} // namespace bbl::pal
