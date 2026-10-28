#pragma once

// The lowered MeshLoD library (upstream_mesh_lod.hpp) on the device under
// test: a statue primitive loaded from memory with GPU selection, then frame
// after frame one instance's selection queued and its update batch flushed
// into a subset encoder inside the engine's frame scope, so the pin's readback
// reaches its post-submit hook and the scheduler streams the pages it demands.
// Each frame prints its selected-cluster count and resident pages, which the
// test compares across backends; before the last frame the inputs the passes
// read are written out for the pin's own CPU model of the selection
// (runMeshLoDGpuSelection), which the test runs on them.

#include "fixture-files.hpp"
#include "fixture-require.hpp"
#include "pal_webgpu_usage.hpp"

#include <bblite/pal_frame_post_submit.hpp>
#include <bblite/pal_http.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/upstream_mesh_lod.hpp>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

// The web platform's leaves an in-memory load never reaches, and its clock.
namespace bbl::pal {
double performance_milliseconds() {
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
void perform_http_transfer(const std::string& url, HttpRequest, HttpExchange&) {
    throw std::runtime_error("the MeshLoD check fetches nothing: " + url);
}
DecodedImage decode_image(std::span<const std::uint8_t>) {
    throw std::runtime_error("the MeshLoD check decodes no image");
}
} // namespace bbl::pal

namespace mesh_lod_check {

using webgpu_fixture::require;
namespace js = bbl::js;
namespace BU = bbl::pal::webgpu_buffer_usage;

/** Frames the check runs: the statue's demanded pages are resident well before. */
constexpr int FRAMES = 40;
/** Words of one packed instance record (mesh-lod-selection-gpu.ts INSTANCE_WORDS). */
constexpr std::size_t INSTANCE_WORDS = 32;

inline js::Promise<std::vector<std::uint32_t>>
read_words(bbl::GpuDevice& device, const bbl::GpuHandle& source, double bytes) {
    bbl::GpuBufferDescriptor descriptor;
    descriptor.size = bytes;
    descriptor.usage = BU::copy_dst | BU::map_read;
    const auto readback = device.create_buffer(descriptor);
    const auto encoder = device.create_command_encoder();
    encoder->copy_buffer_to_buffer(source, 0, readback, 0, bytes);
    device.submit(js::Array<bbl::GpuHandle>{encoder->finish()});
    auto& mapping = bbl::gpu_buffer_mapping(readback);
    co_await mapping.map_async(bbl::gpu_map_mode_read, {}, {});
    const auto range = mapping.get_mapped_range({}, {});
    std::vector<std::uint32_t> words(range.byte_length() / 4);
    std::memcpy(words.data(), range.data(), words.size() * 4);
    mapping.unmap();
    readback->destroy();
    co_return words;
}

inline js::Promise<js::PromiseVoid> sleep(double milliseconds) {
    js::Promise<js::PromiseVoid> promise;
    bbl::pal::EventLoop::current().set_timeout([promise] { promise.resolve(js::PromiseVoid{}); },
                                               milliseconds);
    return promise;
}

/** `count` words of `words` (a vector, or a typed array view read through `load`). */
template <class Words>
void write_words(const std::string& path, const Words& words, std::size_t count) {
    std::ofstream file(path, std::ios::binary);
    for (std::size_t index = 0; index < count; ++index) {
        std::uint32_t word = 0;
        if constexpr (requires { words.load(index); })
            word = words.load(index);
        else
            word = words[index];
        file.write(reinterpret_cast<const char*>(&word), sizeof(word));
    }
    require(static_cast<bool>(file), "writing " + path);
}

/** The asset at `path` streamed by GPU selection; the model's inputs written under `dump`. */
inline js::Promise<js::PromiseVoid> check_selection(std::shared_ptr<bbl::GpuDevice> device,
                                                    std::string path, std::string dump) {
    const auto owner = std::make_shared<bbl::Engine>();
    bbl::Engine& engine = *owner;
    engine.webgpu_device = device;
    bbl::MeshLoDLoadOptions options;
    options.selection_mode = std::string("gpu");
    const auto asset = co_await bbl::load_mesh_lo_d(
        bbl::StoredEngine(owner), js::ArrayBuffer(bbl::pal::read_binary_file(path)), options);
    require(asset->state == "ready", "the asset loads ready");
    const auto runtime = asset->runtime;
    // One instance over a plain PBR record, selected for one scene pass.
    engine.materials.push_back(bbl::MaterialRecord{});
    const auto instance = bbl::create_mesh_lo_d_instance(
        asset, bbl::library::pbr_material(bbl::StoredEngine(owner), bbl::MaterialHandle{0}),
        std::nullopt);
    namespace gpu = bbl::mesh_lod_selection_gpu_detail;
    const auto batch = gpu::get_mesh_lo_d_update_batch(
        std::make_shared<bbl::GpuRenderTargetSignature>(bbl::GpuRenderTargetSignature{
            "rgba8unorm", std::string("depth24plus-stencil8"), {}, 1}));
    const auto instances =
        gpu::create_mesh_lo_d_gpu_instance_state(static_cast<double>(runtime->groups.size()));
    const auto state = gpu::create_mesh_lo_d_gpu_batch_state();
    // A camera 1.5 extents in front of the statue, culling by cone only.
    const auto& meta = asset->metadata;
    bbl::MeshLoDGpuFrameParams frame;
    frame.camera_pos = {(meta.bounds_min[0] + meta.bounds_max[0]) / 2,
                        (meta.bounds_min[1] + meta.bounds_max[1]) / 2,
                        meta.bounds_min[2] - 1.5 * (meta.bounds_max[2] - meta.bounds_min[2])};
    frame.vertical_fov = 0.8;
    frame.near = 0.1;
    frame.target_width = 1280;
    frame.target_height = 720;
    frame.view_projection = js::Array<double>(16, 0.0);
    frame.frustum_cull = false;
    frame.screen_space_error = 1;
    frame.lod_hysteresis = 0;
    frame.level_count = runtime->header.level_count;
    for (int index = 0; index < FRAMES; ++index) {
        if (index == FRAMES - 1) {
            // The model's inputs, as this frame's passes read them: the tables
            // the asset buffers were packed from, the page-state mirror, the
            // instance record and the prior bitset before this frame updates it.
            const auto words = static_cast<std::size_t>(instances->words_per_instance);
            const auto prior =
                co_await read_words(*device, instances->prior_state_buffer, words * 4);
            const auto nodes = gpu::pack_hierarchy_nodes(runtime->hierarchy_nodes);
            const auto groups = gpu::pack_groups(runtime->groups);
            const auto clusters = gpu::pack_clusters(runtime->clusters);
            const auto refs = gpu::pack_group_page_refs(runtime->group_page_refs);
            const auto& pages = runtime->gpu_selection->page_state_data;
            write_words(dump + "/nodes", nodes, nodes.size());
            write_words(dump + "/groups", groups, groups.size());
            write_words(dump + "/clusters", clusters, clusters.size());
            write_words(dump + "/refs", refs, refs.size());
            write_words(dump + "/pages", pages, pages.size());
            write_words(dump + "/instances", instances->scratch_u32, INSTANCE_WORDS);
            write_words(dump + "/prior", prior, words);
            std::ofstream params(dump + "/params.json");
            params.precision(17);
            params << "{\"cameraPos\":[" << frame.camera_pos[0] << "," << frame.camera_pos[1] << ","
                   << frame.camera_pos[2] << "],\"verticalFov\":" << frame.vertical_fov
                   << ",\"near\":" << frame.near << ",\"targetWidth\":" << frame.target_width
                   << ",\"targetHeight\":" << frame.target_height
                   << ",\"screenSpaceError\":" << frame.screen_space_error
                   << ",\"lodHysteresis\":" << frame.lod_hysteresis
                   << ",\"levelCount\":" << frame.level_count << ",\"wordsPerInstance\":" << words
                   << ",\"nodeCount\":" << runtime->hierarchy_nodes.size()
                   << ",\"groupCount\":" << runtime->groups.size()
                   << ",\"clusterCount\":" << runtime->clusters.size()
                   << ",\"pageCount\":" << runtime->gpu->pages.size()
                   << ",\"maxSelected\":" << state->selected_capacity << "}\n";
            require(static_cast<bool>(params), "writing the model's parameters");
        }
        bbl::FramePostSubmitScope scope(engine);
        batch->reset();
        const auto handles = gpu::queue_mesh_lo_d_gpu_selection(
            bbl::StoredEngine(owner), batch, runtime, instances, state,
            js::Array<std::shared_ptr<bbl::MeshLoDInstance>>{instance}, frame);
        require(handles != nullptr, "a visible instance queues a selection");
        const auto encoder = device->create_command_encoder();
        engine.current_encoder = encoder;
        batch->flush_engine = bbl::StoredEngine(owner);
        batch->flush();
        engine.current_encoder.reset();
        device->submit(js::Array<bbl::GpuHandle>{encoder->finish()});
        scope.submitted();
        const auto control = co_await read_words(*device, handles->control_buffer, 16);
        int resident = 0;
        for (const auto& page : runtime->gpu->pages)
            resident += page->state == "gpu-resident";
        std::printf("frame%d %u %d\n", index, control[0], resident);
        co_await sleep(20);
    }
    bbl::dispose_mesh_lo_d_asset(asset);
    co_return js::PromiseVoid{};
}

} // namespace mesh_lod_check
