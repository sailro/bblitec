#include "spirv_vertex.hpp"
#include <bblite/runtime.hpp>
#include "pal_sdl_gpu_resources.hpp"
#include <cassert>

static std::vector<SDL_GPUVertexAttribute> pipeline_attributes;
static SDL_GPUShader* pipeline_vertex = nullptr;
static int released_shaders = 0;

SDL_GPUGraphicsPipeline*
SDL_CreateGPUGraphicsPipeline(SDL_GPUDevice*, const SDL_GPUGraphicsPipelineCreateInfo* info) {
    pipeline_vertex = info->vertex_shader;
    pipeline_attributes.clear();
    for (Uint32 index = 0; index < info->vertex_input_state.num_vertex_attributes; ++index)
        pipeline_attributes.push_back(info->vertex_input_state.vertex_attributes[index]);
    return reinterpret_cast<SDL_GPUGraphicsPipeline*>(1);
}
void SDL_ReleaseGPUShader(SDL_GPUDevice*, SDL_GPUShader*) { ++released_shaders; }

int main() {
    // Scalar input at 0, instancing vector at 16; output at 19 and builtin input.
    const std::vector<std::uint32_t> words{
        0x07230203,
        0x00010000,
        0,
        20,
        0,
        (3u << 16) | 22,
        1,
        32,
        (4u << 16) | 23,
        2,
        1,
        4,
        (4u << 16) | 32,
        3,
        1,
        1,
        (4u << 16) | 32,
        4,
        1,
        2,
        (4u << 16) | 32,
        5,
        3,
        2,
        (4u << 16) | 71,
        10,
        30,
        0,
        (4u << 16) | 71,
        11,
        30,
        16,
        (4u << 16) | 71,
        12,
        30,
        19,
        (4u << 16) | 71,
        13,
        11,
        42,
        (4u << 16) | 59,
        3,
        10,
        1,
        (4u << 16) | 59,
        4,
        11,
        1,
        (4u << 16) | 59,
        5,
        12,
        3,
        (4u << 16) | 59,
        3,
        13,
        1,
    };
    auto compacted = words;
    const auto mapping = bbl::shader_tools::compact_spirv_vertex_inputs(compacted);
    assert(mapping.size() == 2 && mapping.at(0) == 0 && mapping.at(16) == 1);
    auto expected = words;
    expected[31] = 1;
    assert(compacted == expected);
    compacted.pop_back();
    try {
        bbl::shader_tools::compact_spirv_vertex_inputs(compacted);
        assert(false);
    } catch (const std::runtime_error&) {
    }

    // Metadata follows the owning shader through moves, and filters only the
    // inputs the compiled vertex stage retained. Outputs never participate.
    using namespace bbl::pal;
    const std::array<SDL_GPUVertexAttribute, 3> inputs{{
        {16, 1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 64},
        {7, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 8},
        {0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT, 0},
    }};
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_input_state.vertex_attributes = inputs.data();
    info.vertex_input_state.num_vertex_attributes = static_cast<Uint32>(inputs.size());
    OwnedSdlShader original{reinterpret_cast<SDL_GPUShader*>(1), {nullptr, {{0, 16}}}};
    auto vertex = std::move(original);
    create_sdl_gpu_graphics_pipeline(nullptr, vertex, &info);
    assert(pipeline_vertex == vertex.get());
    assert(pipeline_attributes.size() == 2);
    assert(pipeline_attributes[0].location == 0 && pipeline_attributes[0].buffer_slot == 0);
    assert(pipeline_attributes[1].location == 1 && pipeline_attributes[1].buffer_slot == 1);
    assert(pipeline_attributes[1].offset == 64);
    assert(inputs[0].location == 16);
    vertex.reset();
    assert(released_shaders == 1);

    // Reused native addresses do not inherit a previous shader's layout.
    OwnedSdlShader direct{reinterpret_cast<SDL_GPUShader*>(1), {nullptr}};
    create_sdl_gpu_graphics_pipeline(nullptr, direct, &info);
    assert(pipeline_attributes.size() == 3 && pipeline_attributes[0].location == 16);
    OwnedSdlShader empty{reinterpret_cast<SDL_GPUShader*>(2), {nullptr, std::vector<Uint32>{}}};
    create_sdl_gpu_graphics_pipeline(nullptr, empty, &info);
    assert(pipeline_attributes.empty());
    OwnedSdlShader missing{reinterpret_cast<SDL_GPUShader*>(3), {nullptr, {{2}}}};
    try {
        create_sdl_gpu_graphics_pipeline(nullptr, missing, &info);
        assert(false);
    } catch (const std::runtime_error&) {
    }
}
