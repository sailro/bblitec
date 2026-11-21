// Count the Dawn groups the real draw-cache path builds, without a device.
#include <bblite/runtime.hpp>
#include <array>
#include <cassert>
#include <map>
#include <span>

using namespace bbl;

namespace bbl::upstream {
struct PbrVariantEntry {
    std::uint32_t material_ubo_bytes = 4;
};
constexpr std::array<PbrVariantEntry, 2> pbr_variants{};
struct MeshUniforms {
    float data;
};
struct PinnedVariantBinding {
    std::string_view name;
};
} // namespace bbl::upstream

std::span<const upstream::PinnedVariantBinding> pbr_variant_rows(std::size_t variant) {
    static constexpr upstream::PinnedVariantBinding ao[]{{"ssaoVisibilityTexture"}};
    return variant == 0 ? std::span{ao, 1u} : std::span{ao, 0u};
}
using WGPUBuffer = int*;
struct WGPUBufferDescriptor {
    std::uint64_t size;
    unsigned usage;
};
#define WGPU_BUFFER_DESCRIPTOR_INIT                                                                \
    {                                                                                              \
    }
constexpr unsigned WGPUBufferUsage_Uniform = 1, WGPUBufferUsage_CopyDst = 2;
int token;
WGPUBuffer wgpuDeviceCreateBuffer(int, const WGPUBufferDescriptor*) { return &token; }
void wgpuBufferRelease(WGPUBuffer) {}
void wgpuBindGroupRelease(int*) {}
struct DawnBuffer {
    WGPUBuffer value;
    explicit operator bool() const { return value != nullptr; }
    WGPUBuffer release() { return value; }
};
void dawn_error(const char* message) { throw std::runtime_error(message); }
struct DawnState {
    int device = 1;
    struct Target {
        std::uint32_t allocation;
    };
    std::vector<Target> render_targets;
};
struct DawnDrawState {
    explicit DawnDrawState(DawnState&) {}
    std::size_t group_key = ~std::size_t{};
    int *group = nullptr, *mesh_uniforms = nullptr, *material_uniforms = nullptr,
        *mesh_opacity_uniforms = nullptr;
    std::optional<int> material_upload;
    std::vector<std::uint32_t> plugin_texture_allocations;
};
struct DawnMesh {
    std::map<std::uint32_t, DawnDrawState> pinned_states;
};
struct ShaderPassMatrices {
    bool ibl;
};
std::uint64_t output_version = 1;
struct DawnTaskOutputOwners {
    static DawnTaskOutputOwners of(Engine&, TaskHandle) { return {}; }
    struct Binding {
        std::uint64_t version;
    };
    Binding plugin(DawnState&, Engine&, const MaterialRecord&, const ShaderPassMatrices* pass) {
        assert(pass && pass->ibl); // A pass that doesn't bind SSAO must never prepare it.
        return {output_version};
    }
};
bool refresh_area_light_group(DawnState&, DawnDrawState&, const Scene&) { return false; }
void release_held_groups(DawnDrawState&) {}
bool restore_held_group(DawnDrawState&, std::size_t, const std::vector<std::uint32_t>&, bool) {
    return false;
}
void hold_current_group(DawnDrawState& draw, bool) { draw.group = nullptr; }
std::nullptr_t area_light_emission_of(const DawnDrawState&) { return nullptr; }
int groups;
template <typename... Args> int* build_pinned_draw_group(Args&&...) {
    ++groups;
    return &token;
}

#include "draw-cache.hpp"

int main() {
    Engine engine;
    Scene scene;
    MaterialRecord material;
    auto& plugin = material.plugin_textures.emplace_back();
    plugin.texture_name = "ssaoVisibilityTexture";
    plugin.data.render_source = std::make_shared<RenderTextureData>();
    plugin.data.render_source->engine = &engine;
    plugin.data.render_source->reference.source = RenderTextureSource::task_output;
    DawnState state;
    DawnMesh ibl_mesh, non_ibl_mesh;
    const auto frame = [&] {
        const ShaderPassMatrices ibl{true}, non_ibl{false};
        ensure_pinned_draw_bindings(state, ibl_mesh, 0, 0, &material, true, scene, &ibl);
        ensure_pinned_draw_bindings(state, non_ibl_mesh, 0, 1, &material, true, scene, &non_ibl);
    };
    frame();
    frame();
    assert(groups == 2);
    ++output_version;
    frame();
    frame();
    assert(groups == 3);
}
