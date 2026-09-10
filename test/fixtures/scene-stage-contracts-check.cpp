#define BBLITE_HAS_SPRITE_RENDERER 1
#define BBLITE_HAS_BILLBOARDS 1
#include <bblite/runtime.hpp>
#include "pal_sdl_gpu_commands.hpp"
#include "pal_dawn_resources.hpp"
#include <cassert>
#include <tuple>

struct SDL_GPUTexture { int id; };
struct SDL_GPURenderPass {};
struct WGPUTextureImpl {};
struct WGPUTextureViewImpl { int id; };
struct WGPURenderPassEncoderImpl {};
struct Attachment { int id; bool clear; double red; };
std::vector<Attachment> attachments;
std::vector<std::string> draws;
SDL_GPURenderPass sdl_pass;
WGPURenderPassEncoderImpl dawn_pass;
extern "C" SDL_GPURenderPass* SDLCALL SDL_BeginGPURenderPass(SDL_GPUCommandBuffer*,
    const SDL_GPUColorTargetInfo* colors, Uint32 count, const SDL_GPUDepthStencilTargetInfo* depth) {
    assert(count == 1 && !depth && colors->store_op == SDL_GPU_STOREOP_STORE);
    attachments.push_back({colors->texture->id, colors->load_op == SDL_GPU_LOADOP_CLEAR, colors->clear_color.r});
    return &sdl_pass;
}
extern "C" void SDLCALL SDL_EndGPURenderPass(SDL_GPURenderPass* pass) { assert(pass == &sdl_pass); draws.push_back("end"); }
extern "C" WGPURenderPassEncoder wgpuCommandEncoderBeginRenderPass(WGPUCommandEncoder, const WGPURenderPassDescriptor* descriptor) {
    assert(descriptor->colorAttachmentCount == 1 && !descriptor->depthStencilAttachment);
    const auto& color = descriptor->colorAttachments[0];
    assert(color.storeOp == WGPUStoreOp_Store);
    attachments.push_back({color.view->id, color.loadOp == WGPULoadOp_Clear, color.clearValue.r});
    return &dawn_pass;
}
extern "C" void wgpuRenderPassEncoderEnd(WGPURenderPassEncoder pass) { assert(pass == &dawn_pass); draws.push_back("end"); }
extern "C" void wgpuRenderPassEncoderRelease(WGPURenderPassEncoder pass) { assert(pass == &dawn_pass); }
extern "C" void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) {}
extern "C" void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, uint32_t, WGPUBindGroup, size_t, const uint32_t*) {}
extern "C" void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, uint32_t, WGPUBuffer, uint64_t, uint64_t) {}
extern "C" void wgpuRenderPassEncoderSetIndexBuffer(WGPURenderPassEncoder, WGPUBuffer, WGPUIndexFormat, uint64_t, uint64_t) {}
extern "C" void wgpuRenderPassEncoderDrawIndexed(WGPURenderPassEncoder, uint32_t count, uint32_t instances, uint32_t, int32_t, uint32_t) {
    assert(count == 6 && instances == 1); draws.push_back("ground");
}

namespace bbl::upstream {
enum class RenderStage { skybox, opaque, transparent, ground };
// Image processing belongs to the generated shader contract, outside this attachment test.
double inverse_image_processed_channel(double value, double, double, bool) { return value; }
}
namespace bbl::pal {
enum class SkyboxLayer { solid, environment, image };
constexpr std::array skybox_stage_order{SkyboxLayer::solid, SkyboxLayer::environment, SkyboxLayer::image};
void record_scene_sprite_pass(SDL_GPUCommandBuffer*, SDL_GPURenderPass*, Engine&, int, Sprite2DDepthMode mode, unsigned, unsigned) {
    draws.push_back(mode == Sprite2DDepthMode::test_write ? "sprite-opaque" : "sprite-transparent");
}
void record_dawn_scene_sprite_pass(WGPURenderPassEncoder, Engine&, int, Sprite2DDepthMode mode) {
    draws.push_back(mode == Sprite2DDepthMode::test_write ? "sprite-opaque" : "sprite-transparent");
}
void record_sprite_pass(SDL_GPUCommandBuffer*, SDL_GPURenderPass*, Engine&, int pass, unsigned, unsigned) { draws.push_back(std::to_string(pass)); }
void record_dawn_sprite_pass(WGPURenderPassEncoder, Engine&, int pass) { draws.push_back(std::to_string(pass)); }
struct Stages {
    Engine engine;
    Scene scene;
    unsigned width = 640, height = 480;
    struct Plan {
        std::vector<upstream::RenderStage> stages{upstream::RenderStage::skybox, upstream::RenderStage::opaque,
            upstream::RenderStage::transparent, upstream::RenderStage::ground};
        struct { int opaque = 1, transparent = 2; } draw_lists;
    } render_plan;
    static void draw_render_list(int list) { draws.push_back(list == 1 ? "opaque" : "transparent"); }
    static void draw_skybox() { draws.push_back("skybox"); }
    static void draw_ground() { draws.push_back("ground"); }
    static void draw_billboards(BillboardDepthMode mode) { draws.push_back(mode == BillboardDepthMode::cutout ? "billboard-cutout" : "billboard-transparent"); }
};
struct SdlStages : Stages {
    SDL_GPUCommandBuffer* command = nullptr;
    SDL_GPURenderPass* pass = nullptr;
    struct { SDL_GPUSampleCount sample_count = SDL_GPU_SAMPLECOUNT_4; SDL_GPUTexture* msaa_color; SDL_GPUTexture* color; } state;
    SDL_GPUTexture* swapchain = nullptr;
    SDL_GPUTexture* visible_color = nullptr;
    bool capture_frame = false, transmission_enabled = false, has_scene_sprite_pass = true;
    std::vector<int> overlay_plans;
    int scene_sprite_pass = 0;
    std::vector<int> sprite_passes{10,20,30};
    std::vector<SDL_GPUTexture*> sprite_render_textures;
#include "SdlStages.hpp"
#include "color-target.hpp"
};
struct DawnStages : Stages {
    WGPURenderPassEncoder pass = nullptr;
    WGPUCommandEncoder encoder = nullptr;
    struct {
        bool has_scene_sprite_pass = true;
        int scene_sprite_pass = 0;
        std::vector<int> sprite_passes{10,20,30};
        std::vector<WGPUTextureView> sprite_render_texture_views;
    } state;
    WGPUTextureView surface_view = nullptr;
    WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
    WGPUTexture capture_source = nullptr;
#include "DawnStages.hpp"
};
struct Graph {
    struct { struct { bool scene_stages = true; } render; } task;
    struct Lists { int opaque = 1, transparent = 2; } draw_lists;
    int draw_matrix = 0, task_matrix = 0, task_view = 0, task_camera = 0, task_aspect = 0;
    struct Matrices { int* view; } draw_pass_matrices{&task_view}, task_pass_matrices{&task_view};
    static void draw_list(int list) { draws.push_back(list == 1 ? "opaque" : "transparent"); }
    static void draw_task_billboards(BillboardDepthMode mode) { Stages::draw_billboards(mode); }
};
struct SdlGraph : Graph {
    int task_pass = 0, graph_scene = 0, graph_meshes = 0;
    struct { int grid_pipeline = 0, grid_double_sided_pipeline = 0, grid_transparent_pipeline = 0,
        grid_transparent_double_sided_pipeline = 0, shader_pipelines = 0, shader_a2c_pipelines = 0; } state;
    std::vector<int> task_draw_lists{1}; MeshHandle handle{0};
    bool ground = true;
    static void draw_task_skyboxes(int, int, int, int) { draws.push_back("skybox"); }
    void draw_task_ground(int, int, int) { if (ground) draws.push_back("ground"); }
    static void draw_task_billboards(int, BillboardDepthMode mode, int, int) { Graph::draw_task_billboards(mode); }
    template<class... Args> void draw_scene(Args... args) {
        graph_mesh_stages(std::get<sizeof...(Args) - 1>(std::tuple{args...}));
    }
#include "SdlGraphStages.hpp"
};
struct DawnGraph : Graph {
    WGPURenderPassEncoder task_pass = nullptr; unsigned samples = 4;
    WGPURenderPipeline bound_pipeline = nullptr; bool pass_has_depth = true;
    struct { Lists draw_lists; WGPUBindGroup pinned_frame_group = nullptr; int view_projection = 0; } render_task;
    struct { bool ground_enabled = true; WGPURenderPipeline ground_pipeline = nullptr;
        WGPUBindGroup ground_scene_group = nullptr, ground_texture_group = nullptr, ground_material_group = nullptr;
        WGPUBuffer ground_vertices = nullptr, ground_indices = nullptr; } state;
    static void draw_list_into(WGPURenderPassEncoder, int list, unsigned, WGPURenderPipeline&, bool, WGPUBindGroup, bool, std::uint32_t, int) { draw_list(list); }
    template<class Function, class... Args> static void count_gpu_draw(Function fn, Args... args) { fn(args...); }
#include "DawnGraphStages.hpp"
};
}

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    SDL_GPUTexture msaa{1}, resolved{2}, swapchain{3}, offscreen{4};
    SdlStages sdl; sdl.state.msaa_color = &msaa; sdl.state.color = &resolved; sdl.swapchain = &swapchain;
    for (bool sampled : {false, true}) for (bool transmission : {false, true})
        for (bool captured : {false, true}) for (bool overlay : {false, true}) {
            sdl.state.sample_count = sampled ? SDL_GPU_SAMPLECOUNT_4 : SDL_GPU_SAMPLECOUNT_1;
            sdl.transmission_enabled = transmission; sdl.capture_frame = captured;
            sdl.overlay_plans.resize(overlay ? 1 : 0);
            const auto target = sdl.color_target();
            assert(target.load_op == SDL_GPU_LOADOP_CLEAR);
            assert(target.texture == (sampled ? &msaa : transmission || captured ? &resolved : &swapchain));
            assert(target.resolve_texture == (sampled ? transmission || captured ? &resolved : &swapchain : nullptr));
            assert(target.store_op == (!sampled ? SDL_GPU_STOREOP_STORE : transmission || overlay ? SDL_GPU_STOREOP_RESOLVE_AND_STORE : SDL_GPU_STOREOP_RESOLVE));
        }
    DawnStages dawn;
    for (bool sprites : {true, false}) {
        sdl.has_scene_sprite_pass = dawn.state.has_scene_sprite_pass = sprites;
        std::vector<std::string> expected{"skybox", "opaque"};
        if (sprites) expected.push_back("sprite-opaque");
        expected.insert(expected.end(), {"billboard-cutout", "transparent"});
        if (sprites) expected.push_back("sprite-transparent");
        expected.insert(expected.end(), {"ground", "billboard-transparent"});
        draws.clear(); sdl.stages(); assert(draws == expected);
        draws.clear(); dawn.stages(); assert(draws == expected);
    }
    WGPUTextureViewImpl surface{3}, target{4};
    WGPUTextureImpl screenshot;
    sdl.visible_color = &swapchain; sdl.sprite_render_textures = {&offscreen};
    dawn.surface_view = &surface; dawn.state.sprite_render_texture_views = {&target}; dawn.surface_texture.texture = &screenshot;
    const auto setup = [](Engine& engine) {
        engine.sprite_renderers.resize(3);
        engine.registered_sprite_renderers = {SpriteRendererHandle{2}, SpriteRendererHandle{0}, SpriteRendererHandle{1}};
        engine.sprite_renderers[2].clear = false;
        engine.sprite_renderers[0].clear = true; engine.sprite_renderers[0].clear_value.r = .25;
        engine.sprite_renderers[0].has_target = true; engine.sprite_renderers[0].target = SpriteRenderTextureHandle{0};
        engine.sprite_renderers[1].clear = false;
    };
    setup(sdl.engine); setup(dawn.engine);
    for (bool is_dawn : {false, true}) {
        draws = {"scene"}; attachments.clear();
        if (is_dawn) dawn.sprites(); else sdl.sprites();
        assert((draws == std::vector<std::string>{"scene", "30", "end", "10", "end", "20", "end"}));
        assert(attachments.size() == 3 && attachments[0].id == 3 && attachments[1].id == 4 && attachments[2].id == 3);
        assert(!attachments[0].clear && attachments[1].clear && !attachments[2].clear && attachments[1].red == .25);
    }
    assert(dawn.capture_source == &screenshot);
    for (bool scene_stages : {false, true}) for (bool ground : {false, true}) {
        SdlGraph sdl_graph; DawnGraph dawn_graph;
        sdl_graph.task.render.scene_stages = dawn_graph.task.render.scene_stages = scene_stages;
        sdl_graph.ground = dawn_graph.state.ground_enabled = ground;
        std::vector<std::string> expected{"opaque"};
        if (scene_stages) expected.push_back("billboard-cutout");
        expected.push_back("transparent");
        if (scene_stages && ground) expected.push_back("ground");
        if (scene_stages) expected.push_back("billboard-transparent");
        draws.clear(); dawn_graph.graph(); assert(draws == expected);
        if (scene_stages) expected.insert(expected.begin(), "skybox");
        draws.clear(); sdl_graph.graph(); assert(draws == expected);
    }
}
