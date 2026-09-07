#include <bblite/runtime.hpp>
#include <bblite/upstream/splat_geometry.hpp>
#include <bblite/upstream/splat_sort.hpp>
#include <cstring>
#include <iostream>
#include <string>

static void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

struct Texture { std::vector<std::uint8_t> bytes; std::size_t slot; };
struct Buffer { bool order; };
struct Recorder {
    std::vector<std::string> events;
    std::size_t fail_slot = 99;
    void texture(Texture* texture, const void* bytes, std::size_t size, std::uint32_t width, std::uint32_t height) {
        require(width == 4 && height == 1 && size == 64, "texture upload layout changed");
        if (texture->slot == fail_slot) throw std::runtime_error("upload failed");
        events.push_back("texture" + std::to_string(texture->slot));
        const auto* data = static_cast<const std::uint8_t*>(bytes);
        texture->bytes.assign(data, data + size);
    }
};
using SDL_GPUDevice = Recorder;
using WGPUQueue = Recorder*;
using WGPUTexture = Texture*;
struct WGPUTexelCopyTextureInfo { Texture* texture; };
#define WGPU_TEXEL_COPY_TEXTURE_INFO_INIT {}
struct WGPUTexelCopyBufferLayout { std::uint32_t bytesPerRow = 0, rowsPerImage = 0; };
struct WGPUExtent3D { std::uint32_t width, height, depthOrArrayLayers; };
static void upload_2d_texture_into(Recorder* recorder, Texture* texture, const void* bytes,
    std::size_t size, std::uint32_t width, std::uint32_t height, const char*) {
    recorder->texture(texture, bytes, size, width, height);
}
static void wgpuQueueWriteTexture(Recorder* recorder, const WGPUTexelCopyTextureInfo* texture,
    const void* bytes, std::size_t size, const WGPUTexelCopyBufferLayout* layout, const WGPUExtent3D* extent) {
    require(layout->bytesPerRow == extent->width * 16 && layout->rowsPerImage == extent->height,
        "Dawn texture row pitch changed");
    require(extent->depthOrArrayLayers == 1, "Dawn texture depth changed");
    recorder->texture(texture->texture, bytes, size, extent->width, extent->height);
}
static void update_buffer(Recorder* recorder, Buffer*, const void*, std::size_t) {
    recorder->events.push_back("order");
}
static void wgpuQueueWriteBuffer(Recorder* recorder, Buffer* buffer, std::uint64_t, const void*, std::size_t) {
    recorder->events.push_back(buffer->order ? "order" : "uniforms");
}

namespace bbl::pal {
struct PassState {
    SplatMeshHandle mesh{};
    std::uint64_t data_version = 0;
    upstream::SplatSortScratch scratch = upstream::create_splat_sort_scratch(3);
    std::vector<std::uint32_t> cpu_order = std::vector<std::uint32_t>(3);
    std::vector<float> order_floats = std::vector<float>(3);
    std::array<float, 4> depth_transform{};
    Buffer* order = nullptr;
};
struct SplatPass : PassState {
    struct Binding { Texture* texture; };
    std::array<Binding, 7> textures{};
    std::array<float, 16> world{};
};
struct DawnSplatPass : PassState {
    std::array<Texture*, 7> textures{};
    Buffer* uniforms = nullptr;
};
#include "pal_update.hpp"
}

template <typename Pass, typename Sync, typename Frame>
static void check(Sync sync, Frame frame) {
    bbl::Engine engine;
    engine.splat_meshes.emplace_back();
    auto& record = engine.splat_meshes.front();
    record.vertex_count = 3;
    record.texture_width = 4;
    record.texture_height = 1;
    record.positions = {0, 0, 3, 0, 0, 1, 0, 0, 2};
    record.centers_rgba.assign(16, 1.0f);
    record.cov_a_rgba.assign(16, 2.0f);
    record.cov_b_rgba.assign(16, 3.0f);
    record.colors_rgba.assign(16, 4.0f);
    Buffer order{true}, uniforms{false};
    Pass pass;
    pass.mesh = bbl::SplatMeshHandle{0};
    pass.order = &order;
    if constexpr (std::is_same_v<Pass, bbl::pal::DawnSplatPass>) pass.uniforms = &uniforms;
    std::array<Texture, 7> textures{};
    for (std::size_t slot = 0; slot < textures.size(); ++slot) {
        textures[slot].slot = slot;
        textures[slot].bytes.assign(64, 0x7d);
        if constexpr (std::is_same_v<Pass, bbl::pal::SplatPass>) pass.textures[slot].texture = &textures[slot];
        else pass.textures[slot] = &textures[slot];
    }
    Recorder recorder;
    frame(recorder, engine, pass);
    require(pass.cpu_order == std::vector<std::uint32_t>({0, 2, 1}), "initial order");
    recorder.events.clear();
    frame(recorder, engine, pass);
    require(std::count(recorder.events.begin(), recorder.events.end(), "order") == 0, "stationary frame sorted again");

    // CPU mutation alone must not publish a new texture or sort order.
    record.positions = {0, 0, 0, 0, 0, 4, 0, 0, 2};
    record.centers_rgba[0] = 17;
    recorder.events.clear();
    sync(recorder, record, pass);
    require(recorder.events.empty(), "uncommitted data uploaded");
    ++record.data_version;
    sync(recorder, record, pass);
    require(recorder.events == std::vector<std::string>({"texture0", "texture1", "texture2", "texture3"}), "payload order/count");
    require(pass.data_version == record.data_version && pass.depth_transform == std::array<float, 4>{}, "update invalidation");
    require(pass.cpu_order == std::vector<std::uint32_t>({0, 2, 1}), "same-turn pick sorted before frame");
    const auto payloads = bbl::upstream::splat_texture_payloads(record);
    for (std::size_t slot = 0; slot < payloads.size(); ++slot) {
        require(std::memcmp(textures[slot].bytes.data(), payloads[slot]->data(), 64) == 0, "payload bytes");
    }
    for (std::size_t slot = 4; slot < textures.size(); ++slot) {
        require(textures[slot].bytes == std::vector<std::uint8_t>(64, 0x7d), "SH changed");
    }
    recorder.events.clear();
    frame(recorder, engine, pass);
    require(pass.cpu_order == std::vector<std::uint32_t>({1, 2, 0}), "updated positions not sorted");
    require(std::count(recorder.events.begin(), recorder.events.end(), "order") == 1, "new version did not re-sort");
    require(std::none_of(recorder.events.begin(), recorder.events.end(), [](const auto& event) { return event.starts_with("texture"); }), "pick refresh repeated at frame");

    // A failed transport must leave its old version and sort snapshot retryable.
    const auto before = pass.depth_transform;
    ++record.data_version;
    recorder.fail_slot = 2;
    bool failed = false;
    try { sync(recorder, record, pass); } catch (const std::runtime_error&) { failed = true; }
    require(failed && pass.data_version + 1 == record.data_version && pass.depth_transform == before, "failed upload consumed version");
    recorder.fail_slot = 99;
    recorder.events.clear();
    frame(recorder, engine, pass);
    require(recorder.events.size() >= 5 && recorder.events[0] == "texture0" && recorder.events[3] == "texture3" && recorder.events[4] == "order", "frame upload precedes order");
    const auto depth = pass.depth_transform;
    recorder.events.clear();
    sync(recorder, record, pass);
    require(recorder.events.empty() && pass.depth_transform == depth, "idle refresh invalidated sort");
    // Keep the pin's zero-kernel/epsilon decision, even after a data update.
    record.scaling = bbl::Vec3{0, 0, 0};
    ++record.data_version;
    recorder.events.clear();
    frame(recorder, engine, pass);
    require(std::count(recorder.events.begin(), recorder.events.end(), "order") == 0,
        "data version bypassed the pinned zero-kernel gate");
}

int main() try {
    const std::array<float, 16> identity{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    check<bbl::pal::SplatPass>(
        [](auto& recorder, const auto& record, auto& pass) { bbl::pal::sync_splat_data(&recorder, record, pass); },
        [&](auto& recorder, const auto& engine, auto& pass) { bbl::pal::upload_splat_pass(&recorder, engine, pass, identity); });
    check<bbl::pal::DawnSplatPass>(
        [](auto& recorder, const auto& record, auto& pass) { bbl::pal::sync_dawn_splat_data(&recorder, record, pass); },
        [&](auto& recorder, const auto& engine, auto& pass) { bbl::pal::upload_dawn_splat_pass(&recorder, engine, pass, identity, identity, std::array<float, 4>{}, 1280, 720); });
    std::cout << "splat-pal-update: ok\n";
} catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
}
