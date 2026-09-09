#define BBLITE_PBR_VARIANTS 1
#define BBLITE_STANDARD_VARIANTS 1
#define BBLITE_NODE_VARIANTS 1
#define BBLITE_NODE_GEOMETRY_VARIANTS 1
#define BBLITE_PINNED_MATERIALS 1
#include "pal_dawn_resources.hpp"
#include "pal_owned_gpu_record.hpp"
#include <algorithm>
#include <array>
#include <cassert>
#include <map>
#include <memory>
#include <string>
#include <vector>

struct Resource {
    bool alive = true;
    std::vector<Resource*> dependencies;
    virtual ~Resource() = default;
};
#define RESOURCE(Name) struct WGPU##Name##Impl : Resource {};
RESOURCE(Buffer) RESOURCE(Texture) RESOURCE(TextureView) RESOURCE(Sampler)
RESOURCE(BindGroup) RESOURCE(BindGroupLayout) RESOURCE(PipelineLayout) RESOURCE(RenderPipeline) RESOURCE(ShaderModule)
#undef RESOURCE
std::vector<std::unique_ptr<Resource>> allocations;
template <typename T> T make(std::initializer_list<Resource*> dependencies = {}) {
    auto value = std::make_unique<std::remove_pointer_t<T>>();
    value->dependencies = dependencies;
    T result = value.get(); allocations.push_back(std::move(value)); return result;
}
void release(Resource* resource) {
    assert(resource && resource->alive);
    for (const auto& dependent : allocations) {
        assert(!dependent->alive || std::find(dependent->dependencies.begin(), dependent->dependencies.end(), resource) == dependent->dependencies.end());
    }
    resource->alive = false;
}
#define RELEASE(Name) extern "C" void wgpu##Name##Release(WGPU##Name value) { release(value); }
RELEASE(Buffer) RELEASE(Texture) RELEASE(TextureView) RELEASE(Sampler)
RELEASE(BindGroup) RELEASE(BindGroupLayout) RELEASE(PipelineLayout) RELEASE(RenderPipeline) RELEASE(ShaderModule)
#undef RELEASE

namespace bbl::upstream { enum class RenderPipelineKind { pbr, standard }; }
namespace bbl::pal {
constexpr std::size_t mesh_texture_slots = 3, npos = static_cast<std::size_t>(-1);
constexpr std::uint32_t invalid_handle = 0xffffffffu;
constexpr std::uint64_t unsynced_bone_palette = static_cast<std::uint64_t>(-1);
struct DawnSharedShaderGeometry { DawnBuffer vertex_buffer, index_buffer; std::size_t users = 0; };
struct DawnSharedMaterialTextures { std::vector<DawnSampledTexture> textures; std::size_t users = 0; };
using DawnSharedShaderMaterialTextures = DawnSharedMaterialTextures;
struct DawnSharedComposedMaterialTextures {
    std::array<DawnTexture, mesh_texture_slots> textures;
    std::array<DawnTextureView, mesh_texture_slots> views;
    std::array<DawnSampler, mesh_texture_slots> samplers;
    std::size_t users = 0;
};
#include "records.hpp"
#include "release-helpers.hpp"
void release_dawn_mip_generator(int) {}
struct DawnState {
    int mips = 0;
    void release_render_tasks() {}
    void release_frame_graph_textures() {}
    std::vector<DawnMesh> meshes;
    std::vector<std::vector<DawnMesh>> overlay_meshes;
    struct ShaderStorageBuffer { WGPUBuffer buffer = nullptr; };
    std::vector<ShaderStorageBuffer> shader_storage_buffers;
    std::vector<std::unique_ptr<DawnSharedShaderGeometry>> shared_shader_geometries;
    std::vector<std::unique_ptr<DawnSharedMaterialTextures>> shared_shader_material_textures;
    std::vector<std::unique_ptr<DawnSharedComposedMaterialTextures>> shared_composed_material_textures;
    struct Pipeline { WGPURenderPipeline pipeline = nullptr; };
    std::array<std::array<WGPURenderPipeline, 1>, 1> depth_only_pipelines{};
    std::map<int, WGPURenderPipeline> blit_pipelines;
    std::array<std::array<std::map<int, Pipeline>, 1>, 1> task_pipelines;
    std::map<int, Pipeline> shader_shadow_pipelines, pipelines;
    WGPURenderPipeline depth_copy_pipeline = nullptr, image_processing_pipeline = nullptr,
        transmission_grab_pipeline = nullptr, skybox_pipeline = nullptr, ground_pipeline = nullptr;
    WGPUShaderModule depth_copy_module = nullptr, depth_only_module = nullptr, blit_fragment_module = nullptr,
        blit_vertex_module = nullptr, image_processing_fragment_module = nullptr, image_processing_vertex_module = nullptr,
        transmission_grab_fragment_module = nullptr, transmission_grab_vertex_module = nullptr, skybox_module = nullptr,
        skybox_vertex_module = nullptr, ground_module = nullptr, grid_fragment_module = nullptr, grid_vertex_module = nullptr,
        pbr_module = nullptr, vertex_module = nullptr;
    WGPUBindGroup image_processing_group = nullptr, pinned_geometry_frame_group = nullptr, pinned_frame_group = nullptr,
        skybox_material_group = nullptr, skybox_texture_group = nullptr, skybox_scene_group = nullptr,
        ground_material_group = nullptr, ground_texture_group = nullptr, ground_scene_group = nullptr;
    WGPUBuffer image_processing_params = nullptr, pinned_geometry_scene_uniforms = nullptr, pinned_lights_uniforms = nullptr,
        pinned_scene_uniforms = nullptr, skybox_uniforms = nullptr, skybox_matrix = nullptr, skybox_indices = nullptr,
        skybox_vertices = nullptr, ground_uniforms = nullptr, ground_indices = nullptr, ground_vertices = nullptr,
        view_projection = nullptr;
    WGPUTextureView transmission_color_view = nullptr, skybox_texture_view = nullptr, ground_texture_view = nullptr,
        brdf_view = nullptr, environment_cube_view = nullptr, normal_flat_view = nullptr, black_cube_view = nullptr,
        black_view = nullptr, white_view = nullptr, depth_view = nullptr, msaa_color_view = nullptr;
    WGPUTexture transmission_color = nullptr, skybox_texture = nullptr, ground_texture = nullptr, brdf_texture = nullptr,
        environment_cube = nullptr, normal_flat_texture = nullptr, black_cube = nullptr, black_texture = nullptr,
        white_texture = nullptr, depth = nullptr, msaa_color = nullptr;
    WGPUSampler transmission_sampler = nullptr, nearest_sampler = nullptr, ground_sampler = nullptr,
        clamp_sampler = nullptr, default_sampler = nullptr;
    struct OverlayFrame { WGPUBindGroup frame_group = nullptr; WGPUBuffer lights_uniforms = nullptr, scene_uniforms = nullptr; };
    std::vector<OverlayFrame> overlay_frames;
    std::map<std::uint32_t, std::map<std::size_t, WGPURenderPipeline>> pinned_variant_pipelines, standard_variant_pipelines, node_variant_pipelines;
    std::vector<WGPUPipelineLayout> pinned_pipeline_layouts, standard_pipeline_layouts, node_pipeline_layouts, shader_pipeline_layouts;
    std::vector<WGPUBindGroupLayout> pinned_draw_layouts, standard_draw_layouts, node_draw_layouts, mesh_group_layouts;
    std::vector<std::vector<WGPUBindGroupLayout>> shader_group_layouts;
    std::vector<WGPUShaderModule> pinned_fragment_modules, pinned_vertex_modules, standard_fragment_modules,
        standard_vertex_modules, node_fragment_modules, node_vertex_modules, shader_fragment_modules, shader_vertex_modules;
    WGPUBindGroupLayout pinned_frame_layout = nullptr;
    WGPUPipelineLayout mesh_pipeline_layout = nullptr;
    std::vector<WGPUTextureView> reflection_cube_views;
    std::vector<WGPUTexture> reflection_cubes;
#include "release-methods.hpp"
};
}

int main() {
    using namespace bbl::pal;
    for (const bool fail_construction : {false, true}) {
        allocations.clear();
        {
            DawnState state;
            state.default_sampler = make<WGPUSampler>();
            const auto layout = make<WGPUBindGroupLayout>(); state.mesh_group_layouts.push_back(layout);
            state.mesh_pipeline_layout = make<WGPUPipelineLayout>({layout});
            state.pipelines[0].pipeline = make<WGPURenderPipeline>({state.mesh_pipeline_layout});
            const auto texture = make<WGPUTexture>();
            const auto view = make<WGPUTextureView>({texture});
            try {
                DawnMesh mesh(state);
                mesh.owned_textures[0] = texture; mesh.owned_views[0] = view;
                mesh.samplers[0] = make<WGPUSampler>(); mesh.samplers[1] = state.default_sampler;
                mesh.vertices = make<WGPUBuffer>(); mesh.indices = make<WGPUBuffer>();
                auto& binding = mesh.bindings[bbl::upstream::RenderPipelineKind::pbr];
                binding.textures = make<WGPUBindGroup>({view, mesh.samplers[0], state.default_sampler, layout});
                for (auto* draws : {&mesh.pinned_states, &mesh.standard_states, &mesh.node_states}) {
                    DawnDrawState draw(state);
                    draw.mesh_uniforms = make<WGPUBuffer>();
                    draw.group = make<WGPUBindGroup>({view, layout, draw.mesh_uniforms});
                    draws->emplace(0, std::move(draw));
                }
                if (fail_construction) throw std::runtime_error("partial mesh");
                state.meshes.push_back(std::move(mesh));
                mesh.reset();
                assert(texture->alive && view->alive);
            } catch (const std::runtime_error&) { assert(fail_construction); }
            if (fail_construction) { assert(!texture->alive && !view->alive); }
            assert(state.default_sampler->alive);
        }
        for (const auto& resource : allocations) assert(!resource->alive);
    }
    allocations.clear();
    {
        DawnState state;
        auto geometry = std::make_unique<DawnSharedShaderGeometry>();
        geometry->vertex_buffer = make<WGPUBuffer>(); geometry->index_buffer = make<WGPUBuffer>(); geometry->users = 2;
        auto textures = std::make_unique<DawnSharedComposedMaterialTextures>();
        textures->textures[0] = make<WGPUTexture>();
        textures->views[0] = make<WGPUTextureView>({textures->textures[0].get()});
        textures->samplers[0] = make<WGPUSampler>(); textures->users = 2;
        const auto vertex = geometry->vertex_buffer.get(), index = geometry->index_buffer.get();
        const auto texture = textures->textures[0].get();
        for (int i = 0; i < 2; ++i) {
            DawnMesh mesh(state);
            mesh.owns_geometry_buffers = false; mesh.shared_geometry = geometry.get();
            mesh.shared_composed_textures = textures.get();
            mesh.bindings[bbl::upstream::RenderPipelineKind::standard].textures =
                make<WGPUBindGroup>({textures->views[0].get(), textures->samplers[0].get()});
            state.meshes.push_back(std::move(mesh));
        }
        state.shared_shader_geometries.push_back(std::move(geometry));
        state.shared_composed_material_textures.push_back(std::move(textures));
        state.meshes.front().reset(); state.meshes.front().reset();
        state.prune_shared_shader_geometries(); state.prune_shared_composed_material_textures();
        assert(state.shared_shader_geometries.front()->users == 1 && state.shared_composed_material_textures.front()->users == 1);
        assert(vertex->alive && index->alive && texture->alive);
        state.release_meshes();
        state.prune_shared_shader_geometries(); state.prune_shared_composed_material_textures();
        assert(state.shared_shader_geometries.empty() && state.shared_composed_material_textures.empty());
        assert(!vertex->alive && !index->alive && !texture->alive);
    }
    for (const auto& resource : allocations) assert(!resource->alive);
}
