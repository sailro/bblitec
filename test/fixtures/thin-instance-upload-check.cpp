#define BBLITE_PBR_VARIANTS 1
#define BBLITE_GPU_INSTANCING 1
#define BBLITE_GPU_INSTANCE_COLORS 1
#define BBLITE_HAS_PICKING 1
#include <bblite/runtime.hpp>
#include <algorithm>
#include <cassert>
#include <cstring>
#include <deque>

namespace bbl {
struct Buffer {
    std::vector<float> data;
    std::size_t written = 0;
    bool released = false;
    bool pick_reference = false;
};
using SDL_GPUBuffer = Buffer;
using WGPUBuffer = Buffer*;
constexpr unsigned SDL_GPU_BUFFERUSAGE_VERTEX = 1, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ = 2;
constexpr unsigned WGPUBufferUsage_Vertex = 1, WGPUBufferUsage_Storage = 2;
struct State { int device = 0, queue = 0; };
std::deque<Buffer> buffers;
unsigned writes = 0, releases = 0;

Buffer* allocate(const void* data, std::size_t bytes) {
    assert(bytes % sizeof(float) == 0);
    auto& buffer = buffers.emplace_back();
    buffer.data.resize(bytes / sizeof(float));
    if (data) std::memcpy(buffer.data.data(), data, bytes);
    buffer.written = bytes;
    return &buffer;
}
void release(Buffer* buffer) {
    if (!buffer) return;
    assert(!buffer->released && !buffer->pick_reference);
    buffer->released = true;
    ++releases;
}
void update(Buffer* buffer, const void* data, std::size_t bytes) {
    assert(buffer && !buffer->released && bytes <= buffer->data.size() * sizeof(float));
    std::memcpy(buffer->data.data(), data, bytes);
    buffer->written = bytes;
    ++writes;
}
void SDL_ReleaseGPUBuffer(int, Buffer* buffer) { release(buffer); }
void wgpuBufferRelease(Buffer* buffer) { release(buffer); }
Buffer* create_buffer(State&, unsigned, const void* data, std::size_t bytes) { return allocate(data, bytes); }
void wgpuQueueWriteBuffer(int, Buffer* buffer, std::size_t offset, const void* data, std::size_t bytes) {
    assert(offset == 0); update(buffer, data, bytes);
}
struct Uploads {
    Buffer* upload(unsigned, const void* data, std::size_t bytes) { return allocate(data, bytes); }
    void update(Buffer* buffer, const void* data, std::size_t bytes) { bbl::update(buffer, data, bytes); }
};
struct UploadedMesh {
    Buffer* instances = nullptr;
    Buffer* pinned_instances = nullptr;
    Buffer* instance_colors = nullptr;
    std::uint32_t instance_capacity = 0, instance_count = 0;
    std::uint64_t instance_version = 0;
    void release_thin_pick_group() { if (instances) instances->pick_reference = false; }
};
}

#include "updates.hpp"

int main() {
    using namespace bbl;
    for (const auto sync : {update_sdl_gpu, update_dawn}) {
        for (const bool aliases : {false, true}) {
            buffers.clear(); writes = releases = 0;
            MeshRecord mesh;
            mesh.thin_instanced = true;
            mesh.instance_matrices.resize(4);
            for (std::size_t row = 0; row < 4; ++row)
                for (std::size_t lane = 0; lane < 16; ++lane)
                    mesh.instance_matrices[row][lane] = static_cast<float>(row * 16 + lane + 1);
            mesh.instance_colors = {.25f, .5f, .75f, 1};
            mesh.instance_count = 3;
            mesh.instance_version = 1;
            UploadedMesh gpu;
            gpu.instances = allocate(nullptr, 2 * 16 * sizeof(float));
            gpu.pinned_instances = aliases ? gpu.instances : allocate(nullptr, 2 * 16 * sizeof(float));
            gpu.instance_colors = allocate(nullptr, 2 * 4 * sizeof(float));
            gpu.instance_capacity = 2;
            auto* old_instances = gpu.instances;
            auto* old_pinned = gpu.pinned_instances;
            auto* old_colors = gpu.instance_colors;
            if (sync == update_dawn) old_instances->pick_reference = true;
            sync(mesh, gpu);
            assert(releases == (aliases ? 2u : 3u) && writes == 0);
            assert(old_instances->released && old_pinned->released && old_colors->released);
            assert(gpu.instance_capacity == 4 && gpu.instance_count == 3 && gpu.instance_version == 1);
            assert(gpu.instances->data.size() == 64 && gpu.pinned_instances->data.size() == 64);
            assert(gpu.instance_colors->data.size() == 16 && gpu.instance_colors->data[0] == .25f);
            for (std::size_t lane = 4; lane < 16; ++lane) assert(gpu.instance_colors->data[lane] == 1);
            for (std::size_t row = 0; row < 4; ++row) {
                for (std::size_t lane = 0; lane < 16; ++lane) {
                    const float value = mesh.instance_matrices[row][lane];
                    assert(gpu.instances->data[row * 16 + lane] == value);
                    const bool mirror = (lane % 4 == 0) != (lane / 4 == 0);
                    assert(gpu.pinned_instances->data[row * 16 + lane] == (mirror ? -value : value));
                }
            }
            const auto allocations = buffers.size();
            sync(mesh, gpu);
            assert(writes == 0 && buffers.size() == allocations);
            mesh.instance_count = 2;
            mesh.instance_version = 2;
            mesh.instance_colors.assign(8, .125f);
            mesh.instance_matrices[0][12] = 99;
            sync(mesh, gpu);
            assert(writes == 3 && buffers.size() == allocations && gpu.instance_count == 2);
            assert(gpu.instances->written == 32 * sizeof(float) && gpu.instances->data[12] == 99);
            assert(gpu.pinned_instances->written == 32 * sizeof(float) && gpu.pinned_instances->data[12] == -99);
            assert(gpu.instance_colors->written == 8 * sizeof(float) && gpu.instance_colors->data[7] == .125f);
            mesh.instance_count = 0;
            mesh.instance_version = 3;
            sync(mesh, gpu);
            assert(writes == 3 && gpu.instance_count == 0 && gpu.instance_version == 3);
            mesh.instance_count = 99;
            mesh.instance_version = 4;
            sync(mesh, gpu);
            assert(writes == 5 && gpu.instance_count == 4 && gpu.instance_version == 4);

            // A newly attached pool has no previous native stream or pick group.
            UploadedMesh fresh;
            mesh.instance_version = 5;
            sync(mesh, fresh);
            assert(fresh.instances && fresh.pinned_instances && !fresh.instance_colors);
            assert(fresh.instance_capacity == 4 && fresh.instance_count == 4);
            assert(fresh.instance_version == 5);
            mesh.thin_instanced = false;
            mesh.instance_version = 6;
            const auto before = writes;
            sync(mesh, fresh);
            assert(writes == before && fresh.instance_version == 5);
        }
    }
}
