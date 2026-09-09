#define BBLITE_GPU_INSTANCING 1
#define BBLITE_GPU_INSTANCE_COLORS 1
#define BBLITE_PBR_VARIANTS 1
#include <bblite/runtime.hpp>
#include <SDL3/SDL.h>
#include <webgpu/webgpu.h>
#include <cassert>
#include "features.hpp"
#include "expected.hpp"
struct SDL_GPUBuffer { unsigned id; };
struct WGPUBufferImpl { unsigned id; };
std::vector<unsigned> bound;
unsigned instances_drawn = 0, pipeline_binds = 0;
extern "C" void SDLCALL SDL_BindGPUVertexBuffers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUBufferBinding* bindings, Uint32 count) {
    assert(first == 0);
    for (Uint32 index = 0; index < count; ++index) { assert(bindings[index].offset == 0); bound.push_back(bindings[index].buffer->id); }
}
extern "C" void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, uint32_t slot, WGPUBuffer buffer, uint64_t offset, uint64_t size) {
    assert(slot == bound.size() && offset == 0 && size == WGPU_WHOLE_SIZE); bound.push_back(buffer->id);
}
extern "C" void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) { ++pipeline_binds; }
extern "C" void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, uint32_t, WGPUBindGroup, size_t count, const uint32_t*) { assert(count == 0); }
extern "C" void wgpuRenderPassEncoderSetIndexBuffer(WGPURenderPassEncoder, WGPUBuffer, WGPUIndexFormat format, uint64_t offset, uint64_t size) {
    assert(format == WGPUIndexFormat_Uint32 && offset == 0 && size == WGPU_WHOLE_SIZE);
}
extern "C" void wgpuRenderPassEncoderDrawIndexed(WGPURenderPassEncoder, uint32_t count, uint32_t instances, uint32_t first, int32_t base, uint32_t first_instance) {
    assert(count == 6 && first == 0 && base == 0 && first_instance == 0); instances_drawn = instances;
}
namespace bbl::pal {
enum class VertexInputStream : std::uint32_t { vertex, instance_matrix, instance_color };
constexpr std::array vertex_streams{VertexInputStream::vertex, VertexInputStream::instance_matrix, VertexInputStream::instance_color};
template<class Function, class... Args> void count_gpu_draw(Function function, Args... args) { function(args...); }
struct SdlMesh { SDL_GPUBuffer* vertices; SDL_GPUBuffer* pinned_instances; SDL_GPUBuffer* instance_colors; };
struct DawnMesh { WGPUBuffer instances; WGPUBuffer pinned_instances; WGPUBuffer instance_colors; unsigned instance_count = 7; };
#include "bindings.hpp"
}
int main() {
    using namespace bbl; using namespace bbl::pal;
    SDL_GPUBuffer vertices{1}, matrices{2}, colors{3}; SdlMesh sdl{&vertices, &matrices, &colors};
    WGPUBufferImpl dawn_vertices{1}, dawn_matrices{2}, dawn_colors{3}, standard_matrices{4};
    DawnMesh dawn{&standard_matrices, &dawn_matrices, &dawn_colors};
    Engine engine; engine.meshes.resize(1); auto& record = engine.meshes[0];
    for (bool explicit_pool : {false, true}) for (bool pool : {false, true}) for (bool colored : {false, true}) {
        record.thin_instanced = pool && explicit_pool;
        record.instance_matrices.resize(pool && !explicit_pool ? 1 : 0);
        record.instance_colors.assign(colored ? 4 : 0, .5f);
        const auto key = features(engine);
        assert(key == expected_features[2 * static_cast<unsigned>(pool) + static_cast<unsigned>(colored)]);
        std::vector<unsigned> expected{1}; if (pool) expected.push_back(2); if (pool && colored) expected.push_back(3);
        bound.clear(); sdl_bind(engine, sdl); assert(bound == expected);
        bound.clear(); WGPURenderPipeline pipeline = nullptr;
        encode_variant_draw(nullptr, nullptr, pipeline, nullptr, nullptr, &dawn_vertices,
            instance_streams_for(record, dawn, InstanceMatrixSource::pinned), &dawn_vertices, 6);
        assert(bound == expected && instances_drawn == (pool ? 7u : 1u));
        const auto standard = instance_streams_for(record, dawn, InstanceMatrixSource::standard);
        assert(standard.matrices == (pool ? &standard_matrices : nullptr));
    }
    assert(pipeline_binds == 0);
}
