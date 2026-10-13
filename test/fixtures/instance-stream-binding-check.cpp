#define BBLITE_GPU_INSTANCING 1
#define BBLITE_GPU_INSTANCE_COLORS 1
#define BBLITE_PBR_VARIANTS 1
#define BBLITE_GPU_DEFORMATION 0
#include <bblite/runtime.hpp>
#include <SDL3/SDL.h>
#include <webgpu/webgpu.h>
#include <cassert>
#include "features.hpp"
#include "expected.hpp"
struct SDL_GPUBuffer {
    unsigned id;
    std::array<std::uint32_t, 5> arguments{};
};
struct WGPUBufferImpl {
    unsigned id;
    std::array<std::uint32_t, 5> arguments{};
};
std::vector<unsigned> bound;
unsigned instances_drawn = 0, pipeline_binds = 0;
bool forbid_count_read = false;
SDL_GPUBuffer* sdl_indirect = nullptr;
WGPUBuffer dawn_indirect = nullptr;
extern "C" void SDLCALL SDL_DrawGPUIndexedPrimitivesIndirect(SDL_GPURenderPass*,
                                                             SDL_GPUBuffer* args, Uint32 offset,
                                                             Uint32 count) {
    assert(offset == 0 && count == 1);
    sdl_indirect = args;
}
extern "C" void wgpuRenderPassEncoderDrawIndexedIndirect(WGPURenderPassEncoder, WGPUBuffer args,
                                                         uint64_t offset) {
    assert(offset == 0);
    dawn_indirect = args;
}
extern "C" void SDLCALL SDL_BindGPUIndexBuffer(SDL_GPURenderPass*, const SDL_GPUBufferBinding*,
                                               SDL_GPUIndexElementSize) {}
extern "C" void SDLCALL SDL_DrawGPUIndexedPrimitives(SDL_GPURenderPass*, Uint32 count,
                                                     Uint32 instances, Uint32 first, Sint32 base,
                                                     Uint32 first_instance) {
    assert(count == 6 && first == 0 && base == 0 && first_instance == 0);
    instances_drawn = instances;
}
extern "C" void SDLCALL SDL_BindGPUVertexBuffers(SDL_GPURenderPass*, Uint32 first,
                                                 const SDL_GPUBufferBinding* bindings,
                                                 Uint32 count) {
    assert(first == 0);
    for (Uint32 index = 0; index < count; ++index) {
        assert(bindings[index].offset == 0);
        bound.push_back(bindings[index].buffer->id);
    }
}
extern "C" void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, uint32_t slot,
                                                     WGPUBuffer buffer, uint64_t offset,
                                                     uint64_t size) {
    assert(slot == bound.size() && offset == 0 && size == WGPU_WHOLE_SIZE);
    bound.push_back(buffer->id);
}
extern "C" void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) {
    ++pipeline_binds;
}
extern "C" void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, uint32_t, WGPUBindGroup,
                                                  size_t count, const uint32_t*) {
    assert(count == 0);
}
extern "C" void wgpuRenderPassEncoderSetIndexBuffer(WGPURenderPassEncoder, WGPUBuffer,
                                                    WGPUIndexFormat format, uint64_t offset,
                                                    uint64_t size) {
    assert(format == WGPUIndexFormat_Uint32 && offset == 0 && size == WGPU_WHOLE_SIZE);
}
extern "C" void wgpuRenderPassEncoderDrawIndexed(WGPURenderPassEncoder, uint32_t count,
                                                 uint32_t instances, uint32_t first, int32_t base,
                                                 uint32_t first_instance) {
    assert(count == 6 && first == 0 && base == 0 && first_instance == 0);
    instances_drawn = instances;
}
namespace bbl::pal {
enum class VertexInputStream : std::uint32_t { vertex, instance_matrix, instance_color };
constexpr std::array vertex_streams{VertexInputStream::vertex, VertexInputStream::instance_matrix,
                                    VertexInputStream::instance_color};
template <class Function, class... Args> void count_gpu_draw(Function function, Args... args) {
    function(args...);
}
struct SdlMesh {
    SDL_GPUBuffer* vertices;
    SDL_GPUBuffer* instances;
    SDL_GPUBuffer* instance_colors;
    SDL_GPUBuffer* indices = nullptr;
    unsigned index_count = 6;
    SDL_GPUBuffer* indirect_args = nullptr;
    std::shared_ptr<ThinInstancePoolData> thin_pool = nullptr;
    unsigned instance_count() const {
        assert(!forbid_count_read);
        return thin_pool ? gpu_u32(gpu_size(thin_pool->count)) : 1;
    }
};
struct DawnMesh {
    WGPUBuffer instances;
    WGPUBuffer instance_colors;
    WGPUBuffer indirect_args = nullptr;
    std::shared_ptr<ThinInstancePoolData> thin_pool = nullptr;
    unsigned instance_count() const {
        assert(!forbid_count_read);
        return thin_pool ? gpu_u32(gpu_size(thin_pool->count)) : 1;
    }
};
#include "bindings.hpp"
} // namespace bbl::pal
int main() {
    using namespace bbl;
    using namespace bbl::pal;
    SDL_GPUBuffer vertices{1}, matrices{2}, colors{3};
    SdlMesh sdl{&vertices, &matrices, &colors};
    WGPUBufferImpl dawn_vertices{1}, dawn_matrices{2}, dawn_colors{3};
    DawnMesh dawn{&dawn_matrices, &dawn_colors};
    Engine engine;
    engine.meshes.resize(1);
    auto& record = engine.meshes[0];
    for (bool pool : {false, true})
        for (bool colored : {false, true}) {
            record.thin_instances = pool ? std::make_shared<ThinInstancePoolData>() : nullptr;
            if (pool) {
                record.thin_instances->count = 7;
                if (colored)
                    record.thin_instances->colors = js::F32Array(4);
            }
            sdl.thin_pool = dawn.thin_pool = record.thin_instances;
            const auto key = features(engine);
            assert(key == expected_features[2 * static_cast<unsigned>(pool) +
                                            static_cast<unsigned>(colored)]);
            std::vector<unsigned> expected{1};
            if (pool)
                expected.push_back(2);
            if (pool && colored)
                expected.push_back(3);
            bound.clear();
            sdl_bind(engine, sdl);
            assert(bound == expected);
            bound.clear();
            WGPURenderPipeline pipeline = nullptr;
            encode_variant_draw(nullptr, nullptr, pipeline, nullptr, nullptr, &dawn_vertices,
                                instance_streams_for(record, dawn), &dawn_vertices, 6);
            assert(bound == expected && instances_drawn == (pool ? 7u : 1u));
            // Every family reads the one instance stream: the pin's
            // matrices, composed under the mesh world in the vertex stage.
            assert(instance_streams_for(record, dawn).matrices ==
                   (pool ? &dawn_matrices : nullptr));
        }
    assert(pipeline_binds == 0);
    // A matrix pool only repeats a node graph that actually consumes it.
    for (const auto& view :
         {upstream::node_plain, upstream::node_instanced, upstream::NodeVariantEntry{0, 1, true}}) {
        const bool instanced = node_variant_instanced(view);
        const bool matrix_layout = view.attribute_count > 1;
        std::vector<SDL_GPUVertexAttribute> sdl_attributes;
        VariantVertexAttributes dawn_attributes;
        for (std::size_t i = 0; i < view.attribute_count; ++i) {
            const auto& input = upstream::node_variant_attributes[view.first_attribute + i];
            assert(append_variant_attribute(input.name, input.location, sdl_attributes));
            assert(append_variant_attribute(input.name, input.location, dawn_attributes));
            if (const auto* row = upstream::pinned_instance_attribute(input.name)) {
                assert(sdl_attributes.back().buffer_slot == 1 &&
                       sdl_attributes.back().offset == row->offset);
                assert(dawn_attributes.instance_matrix.back().offset == row->offset);
            }
        }
        std::array<SDL_GPUVertexBufferDescription, vertex_streams.size()> sdl_layouts{};
        std::array<WGPUVertexBufferLayout, vertex_streams.size()> dawn_layouts{};
        assert(fill_variant_vertex_buffers(sdl_attributes, sdl_layouts) ==
               (matrix_layout ? 2u : 1u));
        assert(fill_variant_vertex_layouts(dawn_attributes, dawn_layouts) ==
               (matrix_layout ? 2u : 1u));
        assert(sdl_layouts[1].input_rate == SDL_GPU_VERTEXINPUTRATE_INSTANCE);
        assert(dawn_layouts[1].stepMode == WGPUVertexStepMode_Instance);
        assert(sdl_layouts[1].pitch == upstream::pinned_instance_group_stride("ti-matrix"));
        assert(dawn_layouts[1].arrayStride == sdl_layouts[1].pitch);
        record.thin_instances = std::make_shared<ThinInstancePoolData>();
        record.thin_instances->count = 7;
        sdl.thin_pool = dawn.thin_pool = record.thin_instances;
        bound.clear();
        node_sdl_draw(engine, sdl, view);
        const std::vector<unsigned> expected =
            instanced ? std::vector<unsigned>{1, 2} : std::vector<unsigned>{1};
        assert(bound == expected && instances_drawn == (instanced ? 7u : 1u));
        bound.clear();
        WGPURenderPipeline pipeline = nullptr;
        encode_variant_draw(nullptr, nullptr, pipeline, nullptr, nullptr, &dawn_vertices,
                            instanced ? instance_streams_for(record, dawn) : InstanceStreams{},
                            &dawn_vertices, 6);
        assert(bound == expected && instances_drawn == (instanced ? 7u : 1u));
    }
    // Encoding retains the argument buffer. The queue reads its current words
    // at submission, including zero, without consulting the pool's CPU count.
    SDL_GPUBuffer sdl_args{4, {6, 9, 0, 0, 0}};
    WGPUBufferImpl dawn_args{4, {6, 9, 0, 0, 0}};
    sdl.indirect_args = &sdl_args;
    dawn.indirect_args = &dawn_args;
    record.thin_instances->count = std::numeric_limits<double>::quiet_NaN();
    forbid_count_read = true;
    bound.clear();
    node_sdl_draw(engine, sdl, upstream::node_instanced);
    assert(sdl_indirect == &sdl_args);
    bound.clear();
    WGPURenderPipeline pipeline = nullptr;
    encode_variant_draw(nullptr, nullptr, pipeline, nullptr, nullptr, &dawn_vertices,
                        instance_streams_for(record, dawn), &dawn_vertices, 6);
    assert(dawn_indirect == &dawn_args);
    sdl_args.arguments[1] = dawn_args.arguments[1] = 0;
    assert(sdl_indirect->arguments[1] == 0 && dawn_indirect->arguments[1] == 0);
    sdl_args.arguments[1] = dawn_args.arguments[1] = 5;
    assert(sdl_indirect->arguments[1] == 5 && dawn_indirect->arguments[1] == 5);
    forbid_count_read = false;
    record.thin_instances->count = 7;
    sdl.indirect_args = nullptr;
    dawn.indirect_args = nullptr;
    sdl_indirect = nullptr;
    dawn_indirect = nullptr;
    bound.clear();
    node_sdl_draw(engine, sdl, upstream::node_instanced);
    assert(sdl_indirect == nullptr && instances_drawn == 7);
    bound.clear();
    encode_variant_draw(nullptr, nullptr, pipeline, nullptr, nullptr, &dawn_vertices,
                        instance_streams_for(record, dawn), &dawn_vertices, 6);
    assert(dawn_indirect == nullptr && instances_drawn == 7);
}
