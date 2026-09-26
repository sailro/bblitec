#define BBLITE_GPU_INSTANCE_COLORS 0
#define BBLITE_SHADOW_RECEIVERS 0
#define BBLITE_SOLID_SKYBOX 0
#define BBLITE_IMAGE_SKYBOX 0
#define BBLITE_LOCAL_CUBEMAP 0
#define BBLITE_GPU_DEFORMATION 0
#define BBLITE_GPU_MORPH_STORAGE 0
#define BBLITE_GPU_INSTANCING 0
#define BBLITE_VAT 0
#define BBLITE_PBR_VARIANTS 1
#define BBLITE_STANDARD_VARIANTS 1
#define BBLITE_NODE_VARIANTS 1
#define BBLITE_NODE_GEOMETRY_VARIANTS 1
#define BBLITE_PINNED_MATERIALS 1
// The render capabilities the extracted records and teardown test. The
// state below carries the background arms and none of the optional
// deformation, instancing, shadow-receiver or local-cubemap members.
#define BBLITE_PINNED_BACKGROUNDS 1
#define BBLITE_GPU_MORPH_STORAGE 0
#define BBLITE_VAT 0
#define BBLITE_GPU_DEFORMATION 0
#define BBLITE_GPU_INSTANCING 0
#define BBLITE_GPU_INSTANCE_COLORS 0
#define BBLITE_SHADOW_RECEIVERS 0
#define BBLITE_LOCAL_CUBEMAP 0
#include "pal_dawn_resources.hpp"
#include "pal_owned_gpu_record.hpp"
#include "pal_record_sync.hpp"
#include "pal_texture_upload_cache.hpp"
#include <bblite/node_material.hpp>
#include <algorithm>
#include <array>
#include <cassert>
#include <map>
#include <memory>
#include <string>
#include <tuple>
#include <vector>

struct Resource {
    bool alive = true;
    unsigned references = 1;
    std::vector<Resource*> dependencies;
    virtual ~Resource() = default;
};
#define RESOURCE(Name)                                                                             \
    struct WGPU##Name##Impl : Resource {};
RESOURCE(Buffer)
RESOURCE(Texture)
RESOURCE(TextureView)
RESOURCE(Sampler)
RESOURCE(BindGroup)
RESOURCE(BindGroupLayout)
RESOURCE(PipelineLayout)
RESOURCE(RenderPipeline)
RESOURCE(ShaderModule)
#undef RESOURCE
std::vector<std::unique_ptr<Resource>> allocations;
template <typename T> T make(std::initializer_list<Resource*> dependencies = {}) {
    auto value = std::make_unique<std::remove_pointer_t<T>>();
    value->dependencies = dependencies;
    T result = value.get();
    allocations.push_back(std::move(value));
    return result;
}
void release(Resource* resource) {
    assert(resource && resource->alive);
    if (--resource->references != 0)
        return;
    for (const auto& dependent : allocations) {
        assert(!dependent->alive ||
               std::find(dependent->dependencies.begin(), dependent->dependencies.end(),
                         resource) == dependent->dependencies.end());
    }
    resource->alive = false;
}
#define RELEASE(Name)                                                                              \
    extern "C" void wgpu##Name##Release(WGPU##Name value) { release(value); }
RELEASE(Buffer)
RELEASE(Texture)
RELEASE(TextureView)
RELEASE(Sampler)
RELEASE(BindGroup)
RELEASE(BindGroupLayout)
RELEASE(PipelineLayout)
RELEASE(RenderPipeline)
RELEASE(ShaderModule)
#undef RELEASE
extern "C" void wgpuTextureAddRef(WGPUTexture texture) {
    assert(texture && texture->alive);
    ++texture->references;
}
extern "C" WGPUBindGroupLayout
wgpuDeviceCreateBindGroupLayout(WGPUDevice, const WGPUBindGroupLayoutDescriptor*) {
    return make<WGPUBindGroupLayout>();
}
extern "C" WGPUPipelineLayout
wgpuDeviceCreatePipelineLayout(WGPUDevice, const WGPUPipelineLayoutDescriptor* descriptor) {
    const WGPUPipelineLayout layout = make<WGPUPipelineLayout>();
    layout->dependencies.assign(descriptor->bindGroupLayouts,
                                descriptor->bindGroupLayouts + descriptor->bindGroupLayoutCount);
    return layout;
}

namespace bbl::upstream {
enum class RenderPipelineKind { pbr, standard };
}
namespace bbl::pal {
constexpr std::size_t mesh_texture_slots = 3, npos = static_cast<std::size_t>(-1);
constexpr std::uint32_t invalid_handle = 0xffffffffu;
constexpr std::uint64_t unsynced_bone_palette = static_cast<std::uint64_t>(-1);
inline WGPUStringView string_view(const char* text) { return WGPUStringView{text, WGPU_STRLEN}; }
[[noreturn]] inline void dawn_error(const std::string& message) {
    throw std::runtime_error(message);
}
struct DawnSharedShaderGeometry {
    DawnBuffer vertex_buffer, index_buffer;
    std::size_t users = 0;
};
#include "records.hpp"
#include "release-helpers.hpp"
void release_dawn_mip_generator(int) {}
struct DawnState {
    DawnLayoutCache layouts;
    WGPUDevice device = nullptr;
    int mips = 0;
    void release_render_tasks() {}
    void release_frame_graph_textures() {}
    std::vector<DawnMesh> meshes;
    std::vector<std::vector<DawnMesh>> overlay_meshes;
    using ShaderStorageBuffer = VersionedGpuBuffer<WGPUBuffer>;
    std::vector<ShaderStorageBuffer> shader_storage_buffers;
    std::vector<std::unique_ptr<DawnSharedShaderGeometry>> shared_shader_geometries;
    TextureUploadCache<DawnTexture> shared_material_images;
    std::vector<std::unique_ptr<DawnSharedMaterialTextures>> shared_shader_material_textures;
    std::vector<std::unique_ptr<DawnSharedComposedMaterialTextures>>
        shared_composed_material_textures;
    struct Pipeline {
        WGPURenderPipeline pipeline = nullptr;
    };
    std::map<std::tuple<bool, std::uint32_t, WGPUTextureFormat>, WGPURenderPipeline>
        depth_only_pipelines;
    std::map<int, WGPURenderPipeline> blit_pipelines;
    std::map<int, Pipeline> pipelines;
    WGPURenderPipeline depth_copy_pipeline = nullptr, image_processing_pipeline = nullptr,
                       transmission_grab_pipeline = nullptr;
    WGPUShaderModule depth_copy_module = nullptr, depth_only_module = nullptr,
                     blit_fragment_module = nullptr, blit_vertex_module = nullptr,
                     image_processing_module = nullptr, transmission_grab_module = nullptr,
                     pbr_module = nullptr, vertex_module = nullptr;
    WGPUBindGroup image_processing_group = nullptr, pinned_geometry_frame_group = nullptr,
                  pinned_frame_group = nullptr;
    WGPUBuffer image_processing_params = nullptr, pinned_geometry_scene_uniforms = nullptr,
               pinned_lights_uniforms = nullptr, pinned_scene_uniforms = nullptr,
               view_projection = nullptr;
    WGPUTextureView transmission_color_view = nullptr, brdf_view = nullptr,
                    environment_cube_view = nullptr, normal_flat_view = nullptr,
                    black_cube_view = nullptr, black_view = nullptr, white_view = nullptr,
                    depth_view = nullptr, msaa_color_view = nullptr;
    WGPUTexture transmission_color = nullptr, brdf_texture = nullptr, environment_cube = nullptr,
                normal_flat_texture = nullptr, black_cube = nullptr, black_texture = nullptr,
                white_texture = nullptr, depth = nullptr, msaa_color = nullptr;
    WGPUSampler transmission_sampler = nullptr, transmission_grab_sampler = nullptr,
                nearest_sampler = nullptr, ground_sampler = nullptr, clamp_sampler = nullptr,
                default_sampler = nullptr;
    // The background arms own their resources; teardown clears them first.
    std::vector<int> background_arms;
    struct OverlayFrame {
        WGPUBindGroup frame_group = nullptr;
        WGPUBuffer lights_uniforms = nullptr, scene_uniforms = nullptr;
    };
    std::vector<OverlayFrame> overlay_frames;
    std::map<std::uint32_t, std::map<DawnVariantPipelineKey, WGPURenderPipeline>>
        pinned_variant_pipelines, standard_variant_pipelines, node_variant_pipelines;
    std::vector<WGPUShaderModule> pinned_fragment_modules, pinned_vertex_modules,
        standard_fragment_modules, standard_vertex_modules, node_fragment_modules,
        node_vertex_modules, shader_fragment_modules, shader_vertex_modules;
    std::vector<WGPUTextureView> reflection_cube_views;
    std::vector<WGPUTexture> reflection_cubes;
#include "release-methods.hpp"
};
} // namespace bbl::pal

int main() {
    using namespace bbl::pal;
    for (const bool fail_construction : {false, true}) {
        allocations.clear();
        {
            DawnState state;
            state.default_sampler = make<WGPUSampler>();
            const auto layout =
                state.layouts.group(state.device, {DawnLayoutFamily::diagnostic, 0, 2},
                                    [] { return std::vector<WGPUBindGroupLayoutEntry>{}; });
            const auto pipeline_layout = state.layouts.pipeline(
                state.device, {DawnLayoutFamily::diagnostic}, [&] { return std::vector{layout}; });
            state.pipelines[0].pipeline = make<WGPURenderPipeline>({pipeline_layout});
            const auto texture = make<WGPUTexture>();
            const auto view = make<WGPUTextureView>({texture});
            try {
                DawnMesh mesh(state);
                mesh.owned_textures[0] = texture;
                mesh.owned_views[0] = view;
                mesh.samplers[0] = make<WGPUSampler>();
                mesh.samplers[1] = state.default_sampler;
                mesh.vertices = make<WGPUBuffer>();
                mesh.indices = make<WGPUBuffer>();
                auto& binding = mesh.diagnostic_bindings;
                binding.textures =
                    make<WGPUBindGroup>({view, mesh.samplers[0], state.default_sampler, layout});
                for (auto* draws :
                     {&mesh.pinned_states, &mesh.standard_states, &mesh.node_states}) {
                    DawnDrawState draw(state);
                    draw.mesh_uniforms = make<WGPUBuffer>();
                    draw.group = make<WGPUBindGroup>({view, layout, draw.mesh_uniforms});
                    draws->emplace(0, std::move(draw));
                }
                if (fail_construction)
                    throw std::runtime_error("partial mesh");
                state.meshes.push_back(std::move(mesh));
                mesh.reset();
                assert(texture->alive && view->alive);
            } catch (const std::runtime_error&) {
                assert(fail_construction);
            }
            if (fail_construction) {
                assert(!texture->alive && !view->alive);
            }
            assert(state.default_sampler->alive);
        }
        for (const auto& resource : allocations)
            assert(!resource->alive);
    }
    allocations.clear();
    {
        DawnState state;
        auto geometry = std::make_unique<DawnSharedShaderGeometry>();
        geometry->vertex_buffer = make<WGPUBuffer>();
        geometry->index_buffer = make<WGPUBuffer>();
        geometry->users = 2;
        auto textures = std::make_unique<DawnSharedComposedMaterialTextures>();
        textures->textures[0] = make<WGPUTexture>();
        textures->views[0] = make<WGPUTextureView>({textures->textures[0].get()});
        textures->samplers[0] = make<WGPUSampler>();
        textures->users = 2;
        const auto vertex = geometry->vertex_buffer.get(), index = geometry->index_buffer.get();
        const auto texture = textures->textures[0].get();
        for (int i = 0; i < 2; ++i) {
            DawnMesh mesh(state);
            mesh.owns_geometry_buffers = false;
            mesh.shared_geometry = geometry.get();
            mesh.shared_composed_textures = textures.get();
            mesh.diagnostic_bindings.textures =
                make<WGPUBindGroup>({textures->views[0].get(), textures->samplers[0].get()});
            state.meshes.push_back(std::move(mesh));
        }
        state.shared_shader_geometries.push_back(std::move(geometry));
        state.shared_composed_material_textures.push_back(std::move(textures));
        state.meshes.front().reset();
        state.meshes.front().reset();
        state.prune_shared_shader_geometries();
        state.prune_shared_composed_material_textures();
        assert(state.shared_shader_geometries.front()->users == 1 &&
               state.shared_composed_material_textures.front()->users == 1);
        assert(vertex->alive && index->alive && texture->alive);
        state.release_meshes();
        state.prune_shared_shader_geometries();
        state.prune_shared_composed_material_textures();
        assert(state.shared_shader_geometries.empty() &&
               state.shared_composed_material_textures.empty());
        assert(!vertex->alive && !index->alive && !texture->alive);
    }
    for (const auto& resource : allocations)
        assert(!resource->alive);
    allocations.clear();
    {
        TextureUploadCache<DawnTexture> cache;
        bbl::TextureData data;
        data.bytes = bbl::SharedTextureBytes::Storage{1, 2, 3, 4};
        int uploads = 0;
        const auto upload = [&] {
            ++uploads;
            return DawnTexture{make<WGPUTexture>()};
        };
        auto first = cache.acquire(data, false, {255, 255, 255, 255}, upload);
        auto second = cache.acquire(data, false, {255, 255, 255, 255}, upload);
        assert(first == second && uploads == 1);
        const auto texture = first->get();
        DawnSharedComposedMaterialTextures a, b;
        a.image_leases.push_back(first);
        a.textures[0] = first->retain();
        a.views[0] = make<WGPUTextureView>({texture});
        b.image_leases.push_back(second);
        b.textures[0] = second->retain();
        b.views[0] = make<WGPUTextureView>({texture});
        first.reset();
        second.reset();
        release_dawn_composed_material_textures(a);
        assert(texture->alive);
        release_dawn_composed_material_textures(b);
        assert(!texture->alive);
    }
    for (const auto& resource : allocations)
        assert(!resource->alive);
    allocations.clear();
    {
        const auto buffer = make<WGPUBuffer>();
        auto owner = std::shared_ptr<void>(
            buffer, [](void* value) { release(static_cast<WGPUBuffer>(value)); });
        {
            DawnState state;
            state.shader_storage_buffers.push_back({buffer, 16, 0, owner});
            DawnMesh mesh(state);
            mesh.diagnostic_bindings.textures = make<WGPUBindGroup>({buffer});
            state.meshes.push_back(std::move(mesh));
        }
        assert(buffer->alive);
        owner.reset();
        assert(!buffer->alive);
    }
}
