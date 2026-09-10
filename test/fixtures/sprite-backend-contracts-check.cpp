#define BBLITE_FLOATING_ORIGIN 0
#include <bblite/runtime.hpp>
#include <algorithm>
#include <cassert>
#include <cstring>
#include <memory>

struct Buffer { std::vector<float> data; };
struct Resource { Resource* layout = nullptr; unsigned groups = 0; bool released = false; };
using Uint32 = std::uint32_t;
using SDL_GPUBuffer = Buffer;
using SDL_GPUDevice = Resource;
using SDL_GPUCommandBuffer = Resource;
using SDL_GPURenderPass = Resource;
using SDL_GPUGraphicsPipeline = Resource;
using SDL_GPUTexture = Resource;
using SDL_GPUSampler = Resource;
using WGPUDevice = Resource*;
using WGPUQueue = Resource*;
using WGPUBuffer = Buffer*;
using WGPURenderPipeline = Resource*;
using WGPUShaderModule = Resource*;
using WGPUTexture = Resource*;
using WGPUTextureView = Resource*;
using WGPUSampler = Resource*;
using WGPUBindGroup = Resource*;
using WGPUBindGroupLayout = Resource*;
using WGPURenderPassEncoder = Resource*;
using SDL_GPUTextureFormat = int;
using SDL_GPUSampleCount = int;
using WGPUTextureFormat = int;
constexpr int SDL_GPU_TEXTUREFORMAT_INVALID = 0, SDL_GPU_SAMPLECOUNT_1 = 1, WGPUTextureFormat_Undefined = 0;
constexpr int SDL_GPU_BUFFERUSAGE_VERTEX = 1, SDL_GPU_INDEXELEMENTSIZE_16BIT = 2;
constexpr int WGPUBufferUsage_Vertex = 1, WGPUBufferUsage_CopyDst = 2, WGPUIndexFormat_Uint16 = 2;
constexpr int WGPUBufferUsage_Index = 4, SDL_GPU_BUFFERUSAGE_INDEX = 4;
struct SDL_GPUBufferCreateInfo { int usage; Uint32 size; };
struct WGPUBufferDescriptor { int usage; std::uint64_t size; };
struct WGPUBindGroupEntry { unsigned binding = 0; Buffer* buffer = nullptr; std::size_t size = 0; };
struct WGPUBindGroupDescriptor { Resource* layout; unsigned entryCount; const WGPUBindGroupEntry* entries; };
#define WGPU_BUFFER_DESCRIPTOR_INIT {}
#define WGPU_BIND_GROUP_ENTRY_INIT {}
#define WGPU_BIND_GROUP_DESCRIPTOR_INIT {}
struct SDL_GPUTextureSamplerBinding { Resource* texture; Resource* sampler; };
struct SDL_GPUBufferBinding { Buffer* buffer; Uint32 offset; };

namespace capture {
struct Write { Buffer* buffer; std::size_t offset; std::vector<float> values; };
std::vector<std::unique_ptr<Buffer>> buffers;
std::vector<std::unique_ptr<Resource>> resources;
unsigned pipelines = 0, pipeline_releases = 0, atlas_fetches = 0;
std::vector<Buffer*> released, draws;
std::vector<Write> writes;
std::vector<Resource*> textures;
Buffer* bound = nullptr;
bool fail_allocate = false, fail_write = false;
float fx_seconds = 0;
unsigned texture_uploads = 0;
Buffer* allocate(std::size_t bytes) {
    if (fail_allocate) return nullptr;
    auto buffer = std::make_unique<Buffer>();
    buffer->data.resize(bytes / sizeof(float));
    buffers.push_back(std::move(buffer));
    return buffers.back().get();
}
void write(Buffer* buffer, std::size_t offset, const void* data, std::size_t bytes) {
    if (fail_write) throw std::runtime_error("fixture upload failed");
    assert(buffer && offset + bytes <= buffer->data.size() * sizeof(float));
    std::vector<float> values(bytes / sizeof(float));
    std::memcpy(values.data(), data, bytes);
    writes.push_back({buffer, offset, std::move(values)});
    std::memcpy(reinterpret_cast<char*>(buffer->data.data()) + offset, data, bytes);
}
void reset() { released.clear(); draws.clear(); writes.clear(); textures.clear(); texture_uploads = 0; }
Resource* resource() { resources.push_back(std::make_unique<Resource>()); return resources.back().get(); }
}

SDL_GPUBuffer* SDL_CreateGPUBuffer(SDL_GPUDevice*, const SDL_GPUBufferCreateInfo* info) { return capture::allocate(info->size); }
void SDL_ReleaseGPUBuffer(SDL_GPUDevice*, SDL_GPUBuffer* buffer) { if (buffer) capture::released.push_back(buffer); }
WGPUBuffer wgpuDeviceCreateBuffer(WGPUDevice, const WGPUBufferDescriptor* descriptor) { return capture::allocate(static_cast<std::size_t>(descriptor->size)); }
void wgpuBufferRelease(WGPUBuffer buffer) { if (buffer) capture::released.push_back(buffer); }
WGPUBindGroup wgpuDeviceCreateBindGroup(WGPUDevice, const WGPUBindGroupDescriptor* descriptor) {
    auto* group = capture::resource(); group->layout = descriptor->layout;
    assert(group->layout && !group->layout->released); ++group->layout->groups; return group;
}
void wgpuBindGroupRelease(WGPUBindGroup group) {
    assert(!group->released && group->layout && !group->layout->released && group->layout->groups > 0);
    group->released = true; --group->layout->groups;
}
void wgpuBindGroupLayoutRelease(WGPUBindGroupLayout layout) {
    assert(!layout->released && layout->groups == 0); layout->released = true;
}
void wgpuRenderPipelineRelease(WGPURenderPipeline pipeline) {
    assert(!pipeline->released); pipeline->released = true; ++capture::pipeline_releases;
}
void wgpuQueueWriteBuffer(WGPUQueue, WGPUBuffer buffer, std::uint64_t offset, const void* data, std::size_t bytes) { capture::write(buffer, static_cast<std::size_t>(offset), data, bytes); }
void SDL_BindGPUGraphicsPipeline(SDL_GPURenderPass*, SDL_GPUGraphicsPipeline*) {}
void SDL_PushGPUVertexUniformData(SDL_GPUCommandBuffer*, Uint32, const void*, Uint32) {}
void SDL_BindGPUFragmentSamplers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUTextureSamplerBinding* values, Uint32 count) {
    assert(first == 0);
    for (Uint32 i = 0; i < count; ++i) capture::textures.push_back(values[i].texture);
}
void SDL_BindGPUVertexBuffers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUBufferBinding* values, Uint32 count) {
    assert(first == 0 && count == 1); capture::bound = values[0].buffer;
}
void SDL_BindGPUIndexBuffer(SDL_GPURenderPass*, const SDL_GPUBufferBinding*, int) {}
void SDL_DrawGPUIndexedPrimitives(SDL_GPURenderPass*, Uint32 indices, Uint32 count, Uint32, int, Uint32) {
    assert(indices == 6 && count > 0); capture::draws.push_back(capture::bound);
}
void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) {}
void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, Uint32, WGPUBindGroup, Uint32, const Uint32*) {}
void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, Uint32 slot, WGPUBuffer buffer, std::uint64_t, std::uint64_t) {
    assert(slot == 0); capture::bound = buffer;
}
void wgpuRenderPassEncoderSetIndexBuffer(WGPURenderPassEncoder, WGPUBuffer, int, std::uint64_t, std::uint64_t) {}
void wgpuRenderPassEncoderDrawIndexed(WGPURenderPassEncoder, Uint32 indices, Uint32 count, Uint32, int, Uint32) {
    assert(indices == 6 && count > 0); capture::draws.push_back(capture::bound);
}

namespace bbl::upstream {
constexpr unsigned sprite_fx_ubo_bytes = 16, billboard_system_ubo_bytes = 16;
constexpr std::array<std::uint16_t, 6> billboard_index_data{};
template<class Params> void build_sprite_fx_ubo(float seconds, const Params&, std::array<float, 4>& output) {
    capture::fx_seconds = seconds; output[0] = seconds;
}
void build_sprite_layer_ubo(const Sprite2DLayerRecord&, float width, float height, std::array<float, 16>& output) {
    output[0] = width; output[1] = height;
}
void build_billboard_system_ubo(const BillboardSystemRecord&, std::array<float, 4>&) {}
void billboard_upload_instances(const BillboardSystemRecord& system, const std::array<float, 16>&, std::vector<float>& output) {
    output = system.instance_data;
}
}

namespace bbl {
#include "mutations.hpp"
}

namespace bbl::pal {
struct OwnedSdlPipeline {
    Resource* value = nullptr;
    Resource* get() const { return value; }
    explicit operator bool() const { return value != nullptr; }
    void reset() { if (value) { wgpuRenderPipelineRelease(value); value = nullptr; } }
};
template<class Record> struct FixtureRecord : Record {
    explicit FixtureRecord(Resource* = nullptr) {}
    FixtureRecord& operator=(Record record) { static_cast<Record&>(*this) = std::move(record); return *this; }
};
struct DawnSampledTexture { std::uint64_t uploaded_version = 0; };
struct PinnedStageSlots { std::vector<std::string> textures; };
struct GpuBufferUploadBatch {
    void update(Buffer* buffer, std::size_t offset, const void* data, std::size_t bytes) { capture::write(buffer, offset, data, bytes); }
};
[[noreturn]] void gpu_error(const char* message) { throw std::runtime_error(message); }
[[noreturn]] void dawn_error(const char* message) { throw std::runtime_error(message); }
void upload_2d_texture_into(Resource*, Resource*, const std::uint8_t*, std::size_t, Uint32, Uint32, const char*) { ++capture::texture_uploads; }
void update_dawn_extra_texture(Resource*, DawnSampledTexture& gpu, const PixelsTexture& texture) {
    ++capture::texture_uploads; gpu.uploaded_version = texture.version;
}
void push_stage_uniform(Resource*, int, const void*, std::size_t) {}
void update_buffer(Resource*, Buffer* buffer, const void* data, std::size_t bytes) { capture::write(buffer, 0, data, bytes); }
#include "records.hpp"
struct DawnMipGenerator {};
PinnedStageSlots fragment_slots{{"atlasTex"}};
std::string sprite_fragment_shader_name(Uint32) { return "fixture"; }
PinnedStageSlots read_pinned_stage_slots(const std::string&) { return fragment_slots; }
int stage_uniform_slot(const PinnedStageSlots&, const char* name) { return std::string_view(name) == "fx" ? 1 : 0; }
OwnedSdlPipeline create_sprite_layer_pipeline(Resource*, const Sprite2DLayerRecord&, const PinnedStageSlots&, int, int, int) {
    ++capture::pipelines; return {capture::resource()};
}
std::array<Resource*,4> create_dawn_sprite_layer_layouts(Resource*, Uint32, std::size_t) {
    return {capture::resource(), capture::resource(), capture::resource(), capture::resource()};
}
Resource* create_dawn_sprite_layer_pipeline(Resource*, const std::array<Resource*,4>&, const SpriteBlendDescriptor&,
    const SpriteLayerPipelinePlan&, Uint32, int, int, Uint32) { ++capture::pipelines; return capture::resource(); }
Buffer* dawn_sprite_uniform_buffer(Resource*, std::uint64_t size = 64) { return capture::allocate(static_cast<std::size_t>(size)); }
Buffer* upload_buffer(Resource*, int, const void*, std::size_t bytes) { return capture::allocate(bytes); }
void append_dawn_texture_pair(std::vector<WGPUBindGroupEntry>& entries, Resource*, Resource*) { entries.resize(entries.size() + 2); }
void append_dawn_texture_pair(std::vector<WGPUBindGroupEntry>& entries, const DawnSampledTexture&) { entries.resize(entries.size() + 2); }
DawnSampledTexture upload_dawn_extra_texture(Resource*, Resource*, const PixelsTexture& texture) { return {texture.version}; }
void release_dawn_extra_textures(std::vector<DawnSampledTexture>& extras) { extras.clear(); }
void append_sprite_fragment_textures(Resource*, std::vector<SDL_GPUTextureSamplerBinding>& textures,
    const std::vector<PixelsTexture>& extras, const char*) {
    for (std::size_t i = 0; i < extras.size(); ++i) textures.push_back({capture::resource(),capture::resource()});
}
void release_sprite_fragment_textures(Resource*, std::vector<SDL_GPUTextureSamplerBinding>& textures) { textures.clear(); }
SpriteAtlasGpu& sprite_atlas_gpu(Resource*, Engine&, SpriteAtlasHandle handle, const std::vector<Resource*>&, std::vector<SpriteAtlasGpu>& atlases) {
    for (auto& atlas : atlases) if (atlas.atlas.value == handle.value) return atlas;
    ++capture::atlas_fetches; atlases.emplace_back(); auto& atlas = atlases.back(); atlas.atlas = handle;
    atlas.texture = capture::resource(); atlas.sampler = capture::resource(); return atlas;
}
const DawnSpriteAtlasBinding& ensure_dawn_sprite_atlas_binding(Resource*, Resource*, DawnMipGenerator&, Engine&, SpriteAtlasHandle handle,
    const std::vector<Resource*>&, const std::vector<Resource*>&, std::vector<DawnSpriteAtlasBinding>& atlases) {
    for (auto& atlas : atlases) if (atlas.handle.value == handle.value) return atlas;
    ++capture::atlas_fetches; atlases.emplace_back(); auto& atlas = atlases.back(); atlas.handle = handle;
    atlas.texture = capture::resource(); atlas.view = capture::resource(); atlas.sampler = capture::resource(); return atlas;
}
const DawnSpriteAtlasBinding& find_dawn_sprite_atlas_binding(const std::vector<DawnSpriteAtlasBinding>& atlases, SpriteAtlasHandle handle) {
    for (const auto& atlas : atlases) if (atlas.handle.value == handle.value) return atlas;
    throw std::runtime_error("Missing fixture atlas");
}
void release_dawn_sprite_atlas_bindings(std::vector<DawnSpriteAtlasBinding>& atlases) { atlases.clear(); }
inline void release_dawn_sprite_layer_resources(Resource*, DawnSpriteLayerResources&) noexcept;
void release_dawn_sprite_layer(DawnSpriteLayer& layer) { release_dawn_sprite_layer_resources(nullptr, layer); }
#include "functions.hpp"
}

void check_pipeline_cache() {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine;
    engine.sprite_layers.resize(3);
    for (auto& layer : engine.sprite_layers) {
        layer.depth_mode = Sprite2DDepthMode::test_write; layer.atlas = {0}; layer.pipeline_version = 1;
        layer.custom_shader = 0; layer.visible = false;
    }
    auto& base = engine.sprite_layers[0];
    const auto same = base;
    for (auto mutate : std::vector<std::function<void(Sprite2DLayerRecord&)>>{
        [](auto& value) { value.depth_mode = Sprite2DDepthMode::test; },
        [](auto& value) { value.alpha_to_coverage = !value.alpha_to_coverage; },
        [](auto& value) { value.uv_scroll = !value.uv_scroll; },
        [](auto& value) { ++value.instance_floats_per_sprite; },
        [](auto& value) { ++value.custom_shader; },
        [](auto& value) { value.blend.enabled = !value.blend.enabled; },
        [](auto& value) { value.blend.color.src = value.blend.color.src == SpriteBlendFactor::zero ? SpriteBlendFactor::one : SpriteBlendFactor::zero; },
        [](auto& value) { value.blend.alpha.dst = value.blend.alpha.dst == SpriteBlendFactor::zero ? SpriteBlendFactor::one : SpriteBlendFactor::zero; }}) {
        auto changed = same; mutate(changed); assert(!sprite_scene_pipeline_compatible(same, changed));
    }
    auto cosmetic = same; cosmetic.order = 17; cosmetic.visible = true; cosmetic.count = 3;
    assert(sprite_scene_pipeline_compatible(same, cosmetic));
    engine.sprite_layers[1].depth_mode = Sprite2DDepthMode::test;
    capture::pipelines = 0; capture::pipeline_releases = 0;
    auto sdl = create_scene_sprite_pass(nullptr, engine, {{0},{1},{2}}, {}, 0, 0, 4);
    DawnMipGenerator mips;
    auto dawn = create_dawn_scene_sprite_pass(nullptr, nullptr, mips, engine, {{0},{1},{2}}, {}, {}, 0, 0, 4);
    assert(capture::pipelines == 4 && capture::atlas_fetches == 2);
    assert(sdl.layers[0].pipeline == sdl.layers[2].pipeline && sdl.layers[0].pipeline != sdl.layers[1].pipeline);
    assert(sdl.layers[0].owned_pipeline && !sdl.layers[2].owned_pipeline);
    assert(dawn.layers[0].pipeline == dawn.layers[2].pipeline && dawn.layers[0].group_layouts == dawn.layers[2].group_layouts);
    assert(dawn.layers[0].owns_pipeline && dawn.layers[0].owns_group_layouts && !dawn.layers[2].owns_pipeline && !dawn.layers[2].owns_group_layouts);
    sdl.layers[0].elapsed_ms = 123.25; dawn.layers[0].elapsed_ms = 123.25;
    sdl.layers[2].elapsed_ms = 99.75; dawn.layers[2].elapsed_ms = 99.75;
    GpuBufferUploadBatch uploads;
    upload_scene_sprite_pass(nullptr, engine, sdl, 0, uploads);
    sync_dawn_scene_sprite_pass_pipelines(nullptr, nullptr, engine, dawn);
    assert(capture::pipelines == 4 && capture::pipeline_releases == 0);
    engine.sprite_layers[0].depth_mode = Sprite2DDepthMode::test; ++engine.sprite_layers[0].pipeline_version;
    upload_scene_sprite_pass(nullptr, engine, sdl, 0, uploads);
    sync_dawn_scene_sprite_pass_pipelines(nullptr, nullptr, engine, dawn);
    assert(capture::pipelines == 8 && capture::pipeline_releases == 4);
    assert(sdl.layers[0].pipeline == sdl.layers[1].pipeline && sdl.layers[0].pipeline != sdl.layers[2].pipeline);
    assert(dawn.layers[0].pipeline == dawn.layers[1].pipeline && dawn.layers[0].pipeline != dawn.layers[2].pipeline);
    assert(sdl.layers[0].elapsed_ms == 123.25 && dawn.layers[0].elapsed_ms == 123.25);
    assert(sdl.layers[2].elapsed_ms == 99.75 && dawn.layers[2].elapsed_ms == 99.75);
    release_dawn_scene_sprite_pass_resources(nullptr, dawn);
    assert(dawn.layers.empty() && dawn.atlases.empty() && capture::pipeline_releases == 6);
    for (auto& layer : sdl.layers) release_sprite_layer_resources(nullptr, layer);
    assert(capture::pipeline_releases == 8);
    engine.sprite_layers[0].depth_mode = Sprite2DDepthMode::none;
    try { create_scene_sprite_pass(nullptr, engine, {{0}}, {}, 0, 0, 1); assert(false); } catch (const std::runtime_error&) {}
    try { create_dawn_scene_sprite_pass(nullptr, nullptr, mips, engine, {{0}}, {}, {}, 0, 0, 1); assert(false); } catch (const std::runtime_error&) {}
    try { create_sprite_renderer(engine, SpriteRendererOptions{.layers = {{1}}}); assert(false); } catch (const std::runtime_error&) {}
    assert(engine.sprite_renderers.empty());
    const auto renderer = create_sprite_renderer(engine, SpriteRendererOptions{.layers = {{0}}});
    try { add_sprite_renderer_layer(engine, renderer, {1}); assert(false); } catch (const std::runtime_error&) {}
    engine.sprite_layers[1].depth_mode = Sprite2DDepthMode::none;
    add_sprite_renderer_layer(engine, renderer, {1}); add_sprite_renderer_layer(engine, renderer, {1});
    assert(engine.sprite_renderers[0].layers.size() == 2 && engine.sprite_renderers[0].layers_version == 1);
    auto& touched = engine.sprite_layers[0];
    touched.version = 0; touched.dirty_sprite_begin = invalid_handle; touched.dirty_sprite_end = 0;
    touch_sprite_instances(touched, 2, 3); touch_sprite_instances(touched, 0, 1);
    assert(touched.dirty_sprite_begin == 0 && touched.dirty_sprite_end == 3 && touched.version == 2);
}

template<class Gpu, class Upload, class Record>
void check_layer(Gpu& gpu, bbl::Engine& engine, Upload upload, Record record) {
    using namespace bbl;
    auto& layer = engine.sprite_layers[0];
    layer.instance_floats_per_sprite = 1;
    layer.instance_data = {10, 20, 30, 40};
    layer.count = 4; layer.version = 1; layer.custom_shader = 1;
    gpu.elapsed_ms = 4294967296.0;
    layer.visible = false;
    capture::reset(); upload(.25);
    assert(gpu.elapsed_ms == 4294967296.0 && !gpu.instances && capture::writes.empty());
    layer.visible = true; layer.count = 0; upload(.25);
    assert(gpu.elapsed_ms == 4294967296.0 && !gpu.instances);
    layer.count = 4; upload(.25); record();
    assert(gpu.elapsed_ms == 4294967296.25 && gpu.instance_buffer_bytes == 16 && gpu.uploaded_version == 1);
    assert((gpu.instances->data == std::vector<float>{10,20,30,40}));
    assert(capture::fx_seconds == static_cast<float>(4294967296.25 / 1000.0));
    assert(layer.dirty_sprite_reset_version == 1 && layer.dirty_sprite_begin == invalid_handle);
    auto* original = gpu.instances;
    capture::reset(); upload(.25);
    assert(gpu.instances == original && gpu.elapsed_ms == 4294967296.5);
    assert(std::none_of(capture::writes.begin(), capture::writes.end(), [&](const auto& write) { return write.buffer == original; }));
    layer.instance_data[2] = 90; ++layer.version;
    layer.dirty_sprite_begin = 2; layer.dirty_sprite_end = 3;
    capture::reset(); upload(.25);
    const auto write = std::find_if(capture::writes.begin(), capture::writes.end(), [&](const auto& item) { return item.buffer == original; });
    assert(write != capture::writes.end() && write->offset == 8 && write->values == std::vector<float>{90});
    assert((gpu.instances->data == std::vector<float>{10,20,90,40}));
    const std::array<float, 4> sorted{40,90,20,10};
    engine.sprite_y_sort_hook.stage = [&](Sprite2DLayerRecord&, Uint32 begin, Uint32 end) {
        assert(begin == 0 && end == 4); return SpriteInstanceUpload{sorted.data(), 1, 3};
    };
    ++layer.version; layer.dirty_sprite_begin = 0; layer.dirty_sprite_end = 4;
    capture::reset(); upload(.25);
    const auto sorted_write = std::find_if(capture::writes.begin(), capture::writes.end(), [&](const auto& item) { return item.buffer == original; });
    assert(sorted_write != capture::writes.end() && sorted_write->offset == 4 && (sorted_write->values == std::vector<float>{90,20}));
    engine.sprite_y_sort_hook.stage = {};
    layer.instance_data.push_back(50); layer.count = 5; ++layer.version;
    capture::fail_allocate = true; capture::reset();
    try { upload(.25); assert(false); } catch (const std::runtime_error&) {}
    assert(gpu.instances == original && gpu.instance_buffer_bytes == 16 && capture::released.empty());
    capture::fail_allocate = false; upload(.25);
    assert(gpu.instances != original && gpu.instance_buffer_bytes == 20 && capture::released == std::vector<Buffer*>{original});
    assert(gpu.instances->data == layer.instance_data);
    ++layer.version; layer.dirty_sprite_begin = 0; layer.dirty_sprite_end = 1;
    const auto before_version = gpu.uploaded_version;
    capture::fail_write = true;
    try { upload(.25); assert(false); } catch (const std::runtime_error&) {}
    assert(gpu.uploaded_version == before_version && layer.dirty_sprite_begin == 0);
    capture::fail_write = false; upload(.25);
    assert(gpu.uploaded_version == layer.version && layer.dirty_sprite_begin == invalid_handle);
}

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    check_pipeline_cache();
    Engine engine;
    engine.sprite_layers.resize(1);
    SpriteLayerGpu sdl;
    GpuBufferUploadBatch batch;
    sdl.fx_block_slot = 1;
    check_layer(sdl, engine,
        [&](double dt) { upload_sprite_layer_gpu(nullptr, engine, {0}, sdl, dt, batch); },
        [&] { record_sprite_layer_gpu(nullptr, nullptr, engine.sprite_layers[0], sdl, 640, 480); });
    engine.sprite_layers[0] = Sprite2DLayerRecord{};
    DawnSpriteLayer dawn;
    dawn.layer_uniforms = capture::allocate(64); dawn.fx_uniforms = capture::allocate(16);
    check_layer(dawn, engine,
        [&](double dt) { upload_dawn_sprite_layer(nullptr, nullptr, engine, {0}, dawn, 640, 480, dt); }, [] {});

    Resource atlas, noise, mask;
    const std::vector<SDL_GPUTextureSamplerBinding> textures{{&atlas,nullptr},{&noise,nullptr},{&mask,nullptr}};
    sdl.bound_textures = select_sprite_fragment_textures({{"maskTex", "atlasTex"}}, textures, {"noise", "mask"}, "fixture");
    capture::reset(); record_sprite_layer_gpu(nullptr, nullptr, engine.sprite_layers[0], sdl, 640, 480);
    assert((capture::textures == std::vector<Resource*>{&mask,&atlas}));
    assert(select_sprite_fragment_textures({{}}, textures, {"noise", "mask"}, "fixture").empty());
    for (const auto& slots : std::vector<PinnedStageSlots>{{{"missingTex"}}, {{"atlasTex"}}}) {
        try { select_sprite_fragment_textures(slots, textures, {"noise"}, "fixture"); assert(false); } catch (const std::runtime_error&) {}
    }
    try { select_sprite_fragment_textures({{"missingTex"}}, textures, {"noise", "mask"}, "fixture"); assert(false); } catch (const std::runtime_error&) {}

    engine.sprite_layers.resize(5);
    SceneSpritePass scene_sdl;
    DawnSceneSpritePass scene_dawn;
    for (Uint32 index = 0; index < 5; ++index) {
        auto& layer = engine.sprite_layers[index];
        layer.count = 1; layer.visible = true; layer.depth_mode = Sprite2DDepthMode::test_write;
        layer.order = 100.0f - static_cast<float>(index);
        scene_sdl.handles.push_back({index}); scene_dawn.handles.push_back({index});
        scene_sdl.layers.emplace_back(); scene_dawn.layers.emplace_back();
        auto* buffer = capture::allocate(4);
        scene_sdl.layers.back().instances = buffer; scene_dawn.layers.back().instances = buffer;
    }
    engine.sprite_layers[1].visible = false; engine.sprite_layers[2].count = 0;
    engine.sprite_layers[3].depth_mode = Sprite2DDepthMode::test;
    const std::vector<Buffer*> wanted{scene_sdl.layers[0].instances, scene_sdl.layers[4].instances};
    capture::reset(); record_scene_sprite_pass(nullptr, nullptr, engine, scene_sdl, Sprite2DDepthMode::test_write, 640, 480);
    assert(capture::draws == wanted);
    capture::reset(); record_dawn_scene_sprite_pass(nullptr, engine, scene_dawn, Sprite2DDepthMode::test_write);
    assert(capture::draws == wanted);
    capture::reset(); record_dawn_scene_sprite_pass(nullptr, engine, scene_dawn, Sprite2DDepthMode::test);
    assert(capture::draws == std::vector<Buffer*>{scene_dawn.layers[3].instances});

    Scene scene;
    engine.billboard_systems.resize(1);
    auto& system = engine.billboard_systems[0];
    system.count = 1; system.visible = true; system.instance_version = 1;
    system.instance_data = {1,2,3,4}; system.custom_shader = 1;
    BillboardPass billboard; billboard.system = {0}; billboard.instances = capture::allocate(16); billboard.fx_block_slot = 1;
    billboard.elapsed_ms = 4294967296.0; billboard.bound_textures = sdl.bound_textures;
    DawnBillboardPass dawn_billboard; dawn_billboard.system = {0}; dawn_billboard.instances = capture::allocate(16);
    dawn_billboard.vertex_uniforms = capture::allocate(128); dawn_billboard.fragment_uniforms = capture::allocate(16);
    dawn_billboard.fx_uniforms = capture::allocate(16); dawn_billboard.elapsed_ms = 4294967296.0;
    const std::array<float, 16> view{};
    for (unsigned frame = 1; frame <= 4; ++frame) {
        capture::reset(); upload_billboard_pass(nullptr, scene, engine, billboard, view, .25);
        record_billboard_pass(nullptr, nullptr, engine, billboard, view, view);
        assert(billboard.elapsed_ms == 4294967296.0 + frame * .25);
        assert(capture::fx_seconds == static_cast<float>(billboard.elapsed_ms / 1000.0));
        assert(capture::writes.size() == (frame == 1 ? 1u : 0u));
        assert((capture::textures == std::vector<Resource*>{&mask,&atlas}));
        capture::reset(); upload_dawn_billboard_pass(nullptr, scene, engine, dawn_billboard, view, view, .25);
        assert(dawn_billboard.elapsed_ms == billboard.elapsed_ms);
        assert(capture::fx_seconds == static_cast<float>(dawn_billboard.elapsed_ms / 1000.0));
        assert(capture::writes.size() == (frame == 1 ? 4u : 3u));
    }
}
