#pragma once

#include <bblite/text_gpu.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <span>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>
#include "pal_text_capture.hpp"

namespace bbl::pal {

enum class TextBindingRole { uniform, curves, bands, metadata, styles };

inline const char* text_binding_role_name(TextBindingRole role) {
    switch (role) {
    case TextBindingRole::uniform:
        return "uniform";
    case TextBindingRole::curves:
        return "curves";
    case TextBindingRole::bands:
        return "bands";
    case TextBindingRole::metadata:
        return "metadata";
    case TextBindingRole::styles:
        return "styles";
    }
    throw std::runtime_error("Unknown text resource role.");
}

inline std::uint32_t text_gpu_u32(std::size_t value) {
    if (value > std::numeric_limits<std::uint32_t>::max())
        throw std::runtime_error("Text resource extent exceeds the native API's 32-bit range.");
    return static_cast<std::uint32_t>(value);
}

/** A WebGPU count or offset the pin passes as a number: a non-negative integer. */
inline std::size_t text_gpu_size(double value) {
    if (!std::isfinite(value) || value < 0 || std::trunc(value) != value ||
        value >= static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
        throw std::runtime_error("Text GPU extent is not a WebGPU size.");
    return static_cast<std::size_t>(value);
}

/** `data[offset, offset + size)` of a written ArrayBuffer, as WebGPU validates it. */
inline std::span<const std::uint8_t> text_gpu_bytes(const js::ArrayBuffer& data, double offset,
                                                    double size) {
    const auto start = text_gpu_size(offset), count = text_gpu_size(size);
    if (start > data.byte_length() || count > data.byte_length() - start)
        throw std::runtime_error("Text GPU write exceeds its source ArrayBuffer.");
    return {data.data() + start, count};
}

/** GPUBufferUsage / GPUTextureUsage bits the text path creates with. */
inline constexpr std::uint32_t text_buffer_usage_vertex = 0x20, text_buffer_usage_uniform = 0x40,
                               text_buffer_usage_storage = 0x80, text_texture_usage_binding = 0x04;
[[nodiscard]] inline bool text_usage_has(double usage, std::uint32_t bit) {
    return (static_cast<std::uint32_t>(text_gpu_size(usage)) & bit) != 0;
}

/**
 * The capture role of a resource the pin created, by its own label; a
 * render capture names resources the way the browser observation does.
 */
inline std::string_view text_resource_role(const bbl::js::Nullable<std::string>& label) {
    const std::string_view name = label ? std::string_view(*label) : std::string_view();
    if (name == "text-renderable-ubo" || name == "text-layer-ubo")
        return "uniform";
    if (name == "text-instance" || name == "text-layer-instances")
        return "instances";
    if (name == "text-styles")
        return "styles";
    if (name == "text-glyph-metadata")
        return "metadata";
    if (name == "text-slug-curves")
        return "curves";
    if (name == "text-slug-bands")
        return "bands";
    throw std::runtime_error("Unmapped text GPU resource label: " + std::string(name));
}

/** A recorded `GPURenderBundle`: the commands a pass replays. */
struct TextRenderBundle : TextGpuObject {
    enum class Op { pipeline, vertex_buffer, bind_group, draw };
    struct Command {
        Op op;
        double slot = 0;
        TextGpuHandle resource;
        std::array<double, 4> draw{};
    };
    std::vector<Command> commands;
};

/** `GPURenderBundleEncoder`: records commands into a bundle. */
struct TextBundleRecorder final : TextGpuEncoder {
    std::shared_ptr<TextRenderBundle> bundle = std::make_shared<TextRenderBundle>();
    void set_pipeline(const TextGpuHandle& pipeline) override {
        bundle->commands.push_back({TextRenderBundle::Op::pipeline, 0, pipeline, {}});
    }
    void set_vertex_buffer(double slot, const TextGpuHandle& buffer) override {
        bundle->commands.push_back({TextRenderBundle::Op::vertex_buffer, slot, buffer, {}});
    }
    void set_bind_group(double index, const TextGpuHandle& group) override {
        bundle->commands.push_back({TextRenderBundle::Op::bind_group, index, group, {}});
    }
    void draw(double vertices, double instances, double first_vertex,
              double first_instance) override {
        bundle->commands.push_back({TextRenderBundle::Op::draw,
                                    0,
                                    nullptr,
                                    {vertices, instances, first_vertex, first_instance}});
    }
    TextGpuHandle finish() override {
        if (!bundle)
            throw std::runtime_error("Text render bundle encoder already finished.");
        return std::exchange(bundle, nullptr);
    }
};

/** `pass.executeBundles(bundles)`: each bundle's commands, in order, on `pass`. */
inline void replay_text_bundles(TextGpuEncoder& pass, const js::Array<TextGpuHandle>& bundles) {
    for (const auto& handle : bundles) {
        const auto bundle = std::dynamic_pointer_cast<TextRenderBundle>(handle);
        if (!bundle)
            throw std::runtime_error("Text pass executes an object that is not a render bundle.");
        for (const auto& command : bundle->commands) {
            switch (command.op) {
            case TextRenderBundle::Op::pipeline:
                pass.set_pipeline(command.resource);
                break;
            case TextRenderBundle::Op::vertex_buffer:
                pass.set_vertex_buffer(command.slot, command.resource);
                break;
            case TextRenderBundle::Op::bind_group:
                pass.set_bind_group(command.slot, command.resource);
                break;
            case TextRenderBundle::Op::draw:
                pass.draw(command.draw[0], command.draw[1], command.draw[2], command.draw[3]);
                break;
            }
        }
    }
}

// Resource names come from the composed WGSL reflection, including SDL's
// compacted stage sidecars. The backend only maps those names to native leases.
inline TextBindingRole text_binding_role(std::string_view name) {
    if (name == "tu")
        return TextBindingRole::uniform;
    if (name == "ct")
        return TextBindingRole::curves;
    if (name == "bt")
        return TextBindingRole::bands;
    if (name == "gm")
        return TextBindingRole::metadata;
    if (name == "sty")
        return TextBindingRole::styles;
    throw std::runtime_error("Unmapped text shader resource: " + std::string(name));
}

/** Source text owners may outlive a renderer run; retire their device leases first. */
class TextResourceRetirement {
public:
    template <class Resource> void track(const std::shared_ptr<Resource>& resource) {
        std::erase_if(resources_, [](const Entry& entry) { return entry.resource.expired(); });
        resources_.push_back({resource, [](const std::shared_ptr<void>& value) {
                                  std::static_pointer_cast<Resource>(value)->retire();
                              }});
    }

    void retire() noexcept {
        for (const auto& entry : resources_) {
            if (const auto value = entry.resource.lock())
                entry.release(value);
        }
        resources_.clear();
    }

    std::size_t tracked_resource_count() const noexcept { return resources_.size(); }

private:
    struct Entry {
        std::weak_ptr<void> resource;
        void (*release)(const std::shared_ptr<void>&);
    };
    std::vector<Entry> resources_;
};

} // namespace bbl::pal
