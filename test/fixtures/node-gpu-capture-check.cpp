#include "pal_node_capture.hpp"
#include "node-capture-serializer.hpp"
#include <array>
#include <cassert>
#include <fstream>

using namespace bbl::pal;

int main() {
    NodeGpuCapture disabled;
    disabled.begin_frame(8); disabled.pipeline({}); disabled.draw({});
    assert(disabled.pipelines().empty() && disabled.draws().empty() && disabled.frame() == 0);

    NodeGpuCapture capture(true);
    const auto vertices = capture.create_resource("vertices", 256);
    const auto indices = capture.create_resource("indices", 32);
    const std::array<std::uint8_t, 4> vertex_bytes{41, 42, 43, 44};
    capture.write(vertices, 12, vertex_bytes);
    capture.begin_frame(7);
    capture.draw({});
    capture.begin_frame(8);
    for (std::uint32_t view = 0; view < 3; ++view) {
        NodeGpuPipelineCapture pipeline;
        pipeline.id = 200 + view; pipeline.variant = 9;
        pipeline.geometry_variant = static_cast<int>(view) - 1;
        pipeline.color_target_count = std::array<std::uint32_t, 3>{1, 7, 4}[view];
        pipeline.samples = 4; pipeline.uses_local_attributes = view != 0;
        pipeline.topology = "triangle-list"; pipeline.cull_mode = "back"; pipeline.front_face = "ccw";
        pipeline.attributes = {{"position", "float32x3", 2, 0, view ? 48u : 0u, 128}, {"normal", "float32x3", 3, 0, view ? 80u : 12u, 128}};
        capture.pipeline(pipeline);
        pipeline.attributes.clear();
        const auto uniform = capture.create_resource("mesh-ubo", 160);
        std::array<std::uint8_t, 4> bytes{};
        for (std::uint32_t lane = 0; lane < 4; ++lane) bytes[lane] = static_cast<std::uint8_t>(view * 4 + lane + 1);
        capture.write(uniform, 0, bytes);
        NodeGpuDrawCapture draw;
        draw.pipeline = 200 + view; draw.group = 100 + view;
        draw.vertices = vertices; draw.indices = indices; draw.mesh_uniform = uniform;
        draw.mesh = 12; draw.material = 79; draw.vertex_offset = 16; draw.index_offset = 4;
        draw.index_count = 6; draw.first_index = 2; draw.base_vertex = -3;
        draw.bindings = {{4, "albedo-view", 0x100000001ULL, 0x100000002ULL}, {5, "albedo-sampler", 0x100000003ULL, 0}};
        if (view == 2) draw.pushed_uniform_bytes = {21, 22, 23, 24};
        capture.draw(draw);
        draw.bindings.clear(); bytes.fill(255);
    }
    capture.stop();
    capture.begin_frame(9); capture.draw({}); capture.pipeline({});
    std::ofstream stream("capture.json");
    JsonWriter json(stream);
    write_node_gpu_capture(json, capture);
}
