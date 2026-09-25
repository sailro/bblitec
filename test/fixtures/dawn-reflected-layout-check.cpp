#include <webgpu/webgpu.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pal {

[[noreturn]] inline void dawn_error(const std::string& message) {
    throw std::runtime_error(message);
}

/** The sidecars a case deploys, by `<stem><suffix>`. */
std::map<std::string, std::string> deployed;

inline std::vector<std::uint8_t> read_dawn_shader_file(const std::string& base_name,
                                                       std::string_view suffix) {
    const auto found = deployed.find(base_name + std::string(suffix));
    if (found == deployed.end())
        throw std::runtime_error("missing " + base_name + std::string(suffix));
    return {found->second.begin(), found->second.end()};
}

#include "reflected-layout.hpp"

} // namespace bbl::pal

using namespace bbl::pal;

static void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

template <typename Run> static void refuses(Run&& run, const char* message) {
    try {
        run();
    } catch (const std::runtime_error&) {
        return;
    }
    throw std::runtime_error(message);
}

static const WGPUBindGroupLayoutEntry& at(const std::vector<WGPUBindGroupLayoutEntry>& entries,
                                          std::uint32_t binding) {
    const auto found = std::find_if(entries.begin(), entries.end(),
                                    [&](const auto& entry) { return entry.binding == binding; });
    require(found != entries.end(), "binding absent");
    return *found;
}

int main() {
    // Separate stage files: each binding is visible to the stage declaring
    // it, a group neither declares lays out empty, and the rows sort.
    deployed = {
        {"sprite.vert.slots", "@entry mainVertex\nb0 L\n@binding 1 0 L uniform\n"},
        {"sprite.frag.slots",
         "@entry mainFragment\r\nb0 L\r\ns0 atlasSamp\r\nt0 atlasTex\r\n"
         "@binding 3 0 L uniform\r\n@binding 2 1 atlasSamp sampler filtering\r\n"
         "@binding 2 0 atlasTex texture float 2d single\r\n"},
    };
    const std::array<DawnLayoutStage, 2> sprite{
        {{"sprite.vert", WGPUShaderStage_Vertex}, {"sprite.frag", WGPUShaderStage_Fragment}}};
    require(dawn_reflected_layout_entries(sprite, 0).empty(), "group 0 is empty");
    require(dawn_reflected_group_count(sprite) == 4, "one past the highest declared group");
    const auto vertex_group = dawn_reflected_layout_entries(sprite, 1);
    require(vertex_group.size() == 1 && at(vertex_group, 0).visibility == WGPUShaderStage_Vertex &&
                at(vertex_group, 0).buffer.type == WGPUBufferBindingType_Uniform,
            "vertex uniform");
    const auto textures = dawn_reflected_layout(sprite, 2);
    require(textures.size() == 2 && textures[0].entry.binding == 0 &&
                textures[1].entry.binding == 1,
            "sorted texture pair");
    require(textures[0].name == "atlasTex" && textures[1].name == "atlasSamp",
            "each binding carries the name its module declares");
    require(textures[0].entry.texture.sampleType == WGPUTextureSampleType_Float &&
                textures[0].entry.texture.viewDimension == WGPUTextureViewDimension_2D &&
                textures[0].entry.visibility == WGPUShaderStage_Fragment,
            "filterable texture");
    require(textures[1].entry.sampler.type == WGPUSamplerBindingType_Filtering,
            "filtering sampler");

    // One module under both stems: every binding is visible to both, a
    // texture one stage samples is filterable for both, and no vertex stage
    // sees a resource the shader may write.
    deployed = {
        {"whole.vert.slots", "@binding 0 0 u uniform\n@binding 0 1 t texture unfilterable-float 2d "
                             "single\n@binding 0 2 w storage read_write\n@binding 0 3 d texture "
                             "depth 2d-array single\n@binding 0 4 c sampler comparison\n"},
        {"whole.frag.slots", "@binding 0 0 u uniform\n@binding 0 1 t texture float 2d single\n"
                             "@binding 0 2 w storage read_write\n@binding 0 3 d texture depth "
                             "2d-array single\n@binding 0 4 c sampler comparison\n"},
    };
    const std::array<DawnLayoutStage, 2> whole{
        {{"whole.vert", WGPUShaderStage_Vertex}, {"whole.frag", WGPUShaderStage_Fragment}}};
    const auto both = dawn_reflected_layout_entries(whole, 0);
    require(at(both, 0).visibility == (WGPUShaderStage_Vertex | WGPUShaderStage_Fragment),
            "shared uniform");
    require(at(both, 1).texture.sampleType == WGPUTextureSampleType_Float, "sampled wins");
    require(at(both, 2).visibility == WGPUShaderStage_Fragment &&
                at(both, 2).buffer.type == WGPUBufferBindingType_Storage,
            "writable storage stays out of the vertex stage");
    require(at(both, 3).texture.sampleType == WGPUTextureSampleType_Depth &&
                at(both, 3).texture.viewDimension == WGPUTextureViewDimension_2DArray,
            "depth array");
    require(at(both, 4).sampler.type == WGPUSamplerBindingType_Comparison, "comparison sampler");

    // The binding model: a dynamic offset on a buffer, and a format that
    // does not filter on a texture and its sampler.
    deployed = {
        {"splat.vert.slots", "@binding 1 0 u uniform\n@binding 1 1 e sampler filtering\n"
                             "@binding 1 2 F texture float 2d single\n@binding 1 6 sh texture uint "
                             "2d single\n"},
    };
    const std::array<DawnLayoutStage, 1> splat{{{"splat.vert", WGPUShaderStage_Vertex}}};
    const auto modelled =
        dawn_reflected_layout_entries(splat, 1,
                                      {.dynamic_offsets = dawn_binding_bit(0),
                                       .unfilterable = dawn_binding_bit(1) | dawn_binding_bit(2)});
    require(at(modelled, 0).buffer.hasDynamicOffset, "dynamic offset");
    require(at(modelled, 1).sampler.type == WGPUSamplerBindingType_NonFiltering,
            "non-filtering sampler");
    require(at(modelled, 2).texture.sampleType == WGPUTextureSampleType_UnfilterableFloat,
            "unfilterable texture");
    require(at(modelled, 6).texture.sampleType == WGPUTextureSampleType_Uint, "uint texture");
    refuses(
        [&] { dawn_reflected_layout_entries(splat, 1, {.dynamic_offsets = dawn_binding_bit(2)}); },
        "a dynamic offset on a texture refuses");
    refuses([&] { dawn_reflected_layout_entries(splat, 1, {.unfilterable = dawn_binding_bit(5)}); },
            "a model naming an undeclared binding refuses");

    // Refusals: stages disagreeing on a binding's resource or its name, a
    // writable resource only a vertex stage declares, a storage texture, and
    // a malformed line.
    deployed = {
        {"a.vert.slots", "@binding 0 0 u uniform\n@binding 0 1 w storage read_write\n"},
        {"a.frag.slots", "@binding 0 0 u storage read\n"},
        {"n.vert.slots", "@binding 0 0 u uniform\n"},
        {"n.frag.slots", "@binding 0 0 v uniform\n"},
        {"b.frag.slots", "@binding 0 0 w storage-texture write-only rgba8unorm 2d\n"},
        {"c.frag.slots", "@binding 0 x u uniform\n"},
        {"d.frag.slots", "@binding 0 0 uniform\n"},
    };
    const std::array<DawnLayoutStage, 2> disagreeing{
        {{"a.vert", WGPUShaderStage_Vertex}, {"a.frag", WGPUShaderStage_Fragment}}};
    refuses([&] { dawn_reflected_layout_entries(disagreeing, 0); }, "disagreeing stages refuse");
    const std::array<DawnLayoutStage, 2> renamed{
        {{"n.vert", WGPUShaderStage_Vertex}, {"n.frag", WGPUShaderStage_Fragment}}};
    refuses([&] { dawn_reflected_layout_entries(renamed, 0); }, "differently named stages refuse");
    const std::array<DawnLayoutStage, 1> vertex_only{{{"a.vert", WGPUShaderStage_Vertex}}};
    refuses([&] { dawn_reflected_layout_entries(vertex_only, 0); },
            "a vertex-only writable binding refuses");
    const std::array<DawnLayoutStage, 1> storage_texture{{{"b.frag", WGPUShaderStage_Fragment}}};
    refuses([&] { dawn_reflected_layout_entries(storage_texture, 0); },
            "a storage texture refuses");
    const std::array<DawnLayoutStage, 1> malformed{{{"c.frag", WGPUShaderStage_Fragment}}};
    refuses([&] { dawn_reflected_layout_entries(malformed, 0); }, "a malformed line refuses");
    const std::array<DawnLayoutStage, 1> unnamed{{{"d.frag", WGPUShaderStage_Fragment}}};
    refuses([&] { dawn_reflected_layout_entries(unnamed, 0); }, "an unnamed line refuses");
    return 0;
}
