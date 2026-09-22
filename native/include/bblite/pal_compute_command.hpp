#pragma once
#include <bblite/pal_offscreen.hpp>
#include <limits>
#include <cmath>

namespace bbl::pal {
struct ComputeCommandEncoder;
struct ComputeMipmapPassEncoder {
    ComputeCommandEncoder* owner = nullptr;
    std::shared_ptr<ComputeMipmapLevel> level;
    bool pipeline_set = false, binding_set = false;
    void set_pipeline(const std::shared_ptr<ComputeMipmapLevel>& value) {
        if (value != level)
            throw std::runtime_error("Mipmap pipeline does not match its prepared level.");
        pipeline_set = true;
    }
    void set_bind_group(std::uint32_t index, const std::shared_ptr<ComputeMipmapLevel>& value) {
        if (index != 0 || value != level)
            throw std::runtime_error("Mipmap binding does not match its prepared level.");
        binding_set = true;
    }
    void draw(std::uint32_t vertices);
    void end();
};
struct ComputePassEncoder {
    ComputeCommandEncoder* owner = nullptr;
    ComputeDispatch current;
    void set_pipeline(std::shared_ptr<ComputePipeline> pipeline) {
        current.pipeline = std::move(pipeline);
    }
    void set_bind_group(std::uint32_t group, std::shared_ptr<ComputeBindGroup> binding) {
        if (current.groups.size() <= group)
            current.groups.resize(static_cast<std::size_t>(group) + 1);
        current.groups[group] = {std::move(binding), {}};
    }
    template <class Offsets>
    void set_bind_group(std::uint32_t group, std::shared_ptr<ComputeBindGroup> binding,
                        const Offsets& offsets) {
        set_bind_group(group, std::move(binding));
        for (const auto value : offsets) {
            if (value < 0 || value > std::numeric_limits<std::uint32_t>::max() ||
                std::trunc(value) != value)
                throw std::runtime_error("Compute offset exceeds the GPU API range.");
            current.groups[group].dynamic_offsets.push_back(static_cast<std::uint32_t>(value));
        }
    }
    void dispatch(std::uint32_t x, std::uint32_t y, std::uint32_t z);
    void end();
};
/** Retain commands until source queue.submit; buffer writes remain live until submission. */
struct ComputeCommandEncoder {
    explicit ComputeCommandEncoder(std::shared_ptr<OffscreenDevice> value)
        : device(std::move(value)) {}
    std::shared_ptr<OffscreenDevice> device;
    std::vector<ComputeCommand> commands;
    bool pass_active = false, finished = false;
    ComputePassEncoder begin_compute_pass(const std::string&) {
        if (pass_active || finished)
            throw std::runtime_error("Compute command encoder is not recordable.");
        pass_active = true;
        return {this, {}};
    }
    ComputeMipmapPassEncoder begin_mipmap_pass(std::shared_ptr<ComputeMipmapLevel> level) {
        if (pass_active || finished || !level)
            throw std::runtime_error("Mipmap command encoder is not recordable.");
        pass_active = true;
        return {this, std::move(level)};
    }
    void finish() {
        if (pass_active || finished)
            throw std::runtime_error("Compute command encoder cannot finish.");
        finished = true;
    }
    void submit() {
        if (!finished)
            throw std::runtime_error("Compute command encoder must finish before submission.");
        device->submit_compute_commands(commands);
        commands.clear();
    }
};
inline void ComputeMipmapPassEncoder::draw(std::uint32_t vertices) {
    if (!owner || !owner->pass_active || !pipeline_set || !binding_set)
        throw std::runtime_error("Mipmap pass is not ready to draw.");
    owner->commands.emplace_back(ComputeMipmapDraw{level, vertices});
}
inline void ComputeMipmapPassEncoder::end() {
    if (!owner || !owner->pass_active)
        throw std::runtime_error("Mipmap pass has ended.");
    owner->pass_active = false;
    owner = nullptr;
}
inline void ComputePassEncoder::dispatch(std::uint32_t x, std::uint32_t y, std::uint32_t z) {
    if (!owner || !owner->pass_active)
        throw std::runtime_error("Compute pass is not recordable.");
    current.workgroups = {x, y, z};
    owner->commands.push_back(current);
}
inline void ComputePassEncoder::end() {
    if (!owner || !owner->pass_active)
        throw std::runtime_error("Compute pass has ended.");
    owner->pass_active = false;
    owner = nullptr;
}
inline std::uint32_t compute_api_dimension(double value) {
    if (value < 0 || value > std::numeric_limits<std::uint32_t>::max() ||
        std::trunc(value) != value)
        throw std::runtime_error("Compute workgroup dimension exceeds the GPU API range.");
    return static_cast<std::uint32_t>(value);
}
} // namespace bbl::pal
