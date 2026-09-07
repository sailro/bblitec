#pragma once

#include "pal_gpu_capture.hpp"

namespace bbl::pal {

struct NodeGpuAttributeCapture {
    std::string name, format;
    std::uint32_t location = 0, slot = 0;
    std::size_t offset = 0, stride = 0;
};
struct NodeGpuPipelineCapture {
    std::uint64_t id = 0;
    std::uint32_t variant = 0, color_target_count = 0, samples = 0;
    // -1 identifies the ordinary color view.
    int geometry_variant = -1;
    bool uses_local_attributes = false;
    std::string topology, cull_mode, front_face;
    std::vector<NodeGpuAttributeCapture> attributes;
};
struct NodeGpuBindingCapture {
    std::uint32_t binding = 0;
    std::string role;
    std::uint64_t resource = 0, view = 0;
};
struct NodeGpuDrawCapture {
    std::uint64_t pipeline = 0, group = 0;
    std::uint64_t vertices = 0, indices = 0, mesh_uniform = 0;
    std::uint32_t mesh = 0, material = 0;
    std::size_t vertex_offset = 0, index_offset = 0;
    std::uint32_t index_count = 0, first_index = 0, instance_count = 1;
    std::int32_t base_vertex = 0;
    std::vector<NodeGpuBindingCapture> bindings;
    // SDL's actual uniform push; Dawn identifies the queue-written buffer.
    std::vector<std::uint8_t> pushed_uniform_bytes;
};

class NodeGpuCapture : public GpuUploadCapture {
public:
    using GpuUploadCapture::GpuUploadCapture;
    const auto& pipelines() const noexcept { return pipelines_; }
    const auto& draws() const noexcept { return draws_; }
    void begin_frame(std::uint64_t frame) {
        if (!enabled()) return;
        GpuUploadCapture::begin_frame(frame);
        draws_.clear();
    }
    void pipeline(NodeGpuPipelineCapture receipt) {
        if (enabled()) pipelines_.push_back(std::move(receipt));
    }
    void draw(NodeGpuDrawCapture receipt) {
        if (enabled()) draws_.push_back(std::move(receipt));
    }
private:
    std::vector<NodeGpuPipelineCapture> pipelines_;
    std::vector<NodeGpuDrawCapture> draws_;
};

} // namespace bbl::pal
