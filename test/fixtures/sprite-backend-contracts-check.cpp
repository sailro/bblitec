#define BBLITE_FLOATING_ORIGIN 0
#include "pal_gpu_billboard_upload.hpp"
#include <bblite/pal_iteration.hpp>
#include <algorithm>
#include <cassert>
#include <cstring>
#include <functional>
#include <memory>

struct Buffer {
    std::vector<float> data;
};
struct Resource {
    Resource* layout = nullptr;
    unsigned groups = 0;
    bool released = false;
};
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
constexpr int SDL_GPU_TEXTUREFORMAT_INVALID = 0, SDL_GPU_SAMPLECOUNT_1 = 1,
              SDL_GPU_SAMPLECOUNT_4 = 4, WGPUTextureFormat_Undefined = 0,
              WGPUTextureFormat_RGBA8Unorm = 1, WGPUTextureFormat_Depth24PlusStencil8 = 2;
constexpr int SDL_GPU_BUFFERUSAGE_VERTEX = 1, SDL_GPU_INDEXELEMENTSIZE_16BIT = 2;
constexpr int WGPUBufferUsage_Vertex = 1, WGPUBufferUsage_CopyDst = 2, WGPUIndexFormat_Uint16 = 2;
constexpr int WGPUBufferUsage_Index = 4, SDL_GPU_BUFFERUSAGE_INDEX = 4;
struct SDL_GPUBufferCreateInfo {
    int usage;
    Uint32 size;
};
struct WGPUBufferDescriptor {
    int usage;
    std::uint64_t size;
};
struct WGPUBindGroupEntry {
    unsigned binding = 0;
    Buffer* buffer = nullptr;
    std::size_t size = 0;
    Resource* textureView = nullptr;
    Resource* sampler = nullptr;
};
using WGPUShaderStage = int;
constexpr WGPUShaderStage WGPUShaderStage_Vertex = 1, WGPUShaderStage_Fragment = 2;
struct WGPUBindGroupDescriptor {
    Resource* layout;
    unsigned entryCount;
    const WGPUBindGroupEntry* entries;
};
#define WGPU_BUFFER_DESCRIPTOR_INIT                                                                \
    {                                                                                              \
    }
#define WGPU_BIND_GROUP_ENTRY_INIT                                                                 \
    {                                                                                              \
    }
#define WGPU_BIND_GROUP_DESCRIPTOR_INIT                                                            \
    {                                                                                              \
    }
struct SDL_GPUTextureSamplerBinding {
    Resource* texture;
    Resource* sampler;
};
struct SDL_GPUBufferBinding {
    Buffer* buffer;
    Uint32 offset;
};

namespace capture {
struct Write {
    Buffer* buffer;
    std::size_t offset;
    std::vector<float> values;
};
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
// Each billboard pass build: its system, the texels it read, and whether its
// plan resolved alpha-to-coverage; and the Dawn atlas chains filled.
std::vector<std::uint32_t> billboard_builds;
std::vector<const std::vector<std::uint8_t>*> billboard_texels;
std::vector<std::vector<std::uint8_t>> billboard_texel_bytes;
std::vector<bool> billboard_coverage;
unsigned mip_fills = 0;
Buffer* allocate(std::size_t bytes) {
    if (fail_allocate)
        return nullptr;
    auto buffer = std::make_unique<Buffer>();
    buffer->data.resize(bytes / sizeof(float));
    buffers.push_back(std::move(buffer));
    return buffers.back().get();
}
void write(Buffer* buffer, std::size_t offset, const void* data, std::size_t bytes) {
    if (fail_write)
        throw std::runtime_error("fixture upload failed");
    assert(buffer && offset + bytes <= buffer->data.size() * sizeof(float));
    std::vector<float> values(bytes / sizeof(float));
    std::memcpy(values.data(), data, bytes);
    writes.push_back({buffer, offset, std::move(values)});
    std::memcpy(reinterpret_cast<char*>(buffer->data.data()) + offset, data, bytes);
}
void reset() {
    released.clear();
    draws.clear();
    writes.clear();
    textures.clear();
    texture_uploads = 0;
}
Resource* resource() {
    resources.push_back(std::make_unique<Resource>());
    return resources.back().get();
}
} // namespace capture

SDL_GPUBuffer* SDL_CreateGPUBuffer(SDL_GPUDevice*, const SDL_GPUBufferCreateInfo* info) {
    return capture::allocate(info->size);
}
void SDL_ReleaseGPUBuffer(SDL_GPUDevice*, SDL_GPUBuffer* buffer) {
    if (buffer)
        capture::released.push_back(buffer);
}
WGPUBuffer wgpuDeviceCreateBuffer(WGPUDevice, const WGPUBufferDescriptor* descriptor) {
    return capture::allocate(static_cast<std::size_t>(descriptor->size));
}
void wgpuBufferRelease(WGPUBuffer buffer) {
    if (buffer)
        capture::released.push_back(buffer);
}
WGPUBindGroup wgpuDeviceCreateBindGroup(WGPUDevice, const WGPUBindGroupDescriptor* descriptor) {
    auto* group = capture::resource();
    group->layout = descriptor->layout;
    assert(group->layout && !group->layout->released);
    ++group->layout->groups;
    return group;
}
void wgpuBindGroupRelease(WGPUBindGroup group) {
    assert(!group->released && group->layout && !group->layout->released &&
           group->layout->groups > 0);
    group->released = true;
    --group->layout->groups;
}
void wgpuBindGroupLayoutRelease(WGPUBindGroupLayout layout) {
    assert(!layout->released && layout->groups == 0);
    layout->released = true;
}
void wgpuRenderPipelineRelease(WGPURenderPipeline pipeline) {
    assert(!pipeline->released);
    pipeline->released = true;
    ++capture::pipeline_releases;
}
void wgpuQueueWriteBuffer(WGPUQueue, WGPUBuffer buffer, std::uint64_t offset, const void* data,
                          std::size_t bytes) {
    capture::write(buffer, static_cast<std::size_t>(offset), data, bytes);
}
void SDL_BindGPUGraphicsPipeline(SDL_GPURenderPass*, SDL_GPUGraphicsPipeline*) {}
void SDL_PushGPUVertexUniformData(SDL_GPUCommandBuffer*, Uint32, const void*, Uint32) {}
void SDL_BindGPUFragmentSamplers(SDL_GPURenderPass*, Uint32 first,
                                 const SDL_GPUTextureSamplerBinding* values, Uint32 count) {
    assert(first == 0);
    for (Uint32 i = 0; i < count; ++i)
        capture::textures.push_back(values[i].texture);
}
void SDL_BindGPUVertexBuffers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUBufferBinding* values,
                              Uint32 count) {
    assert(first == 0 && count == 1);
    capture::bound = values[0].buffer;
}
void SDL_BindGPUIndexBuffer(SDL_GPURenderPass*, const SDL_GPUBufferBinding*, int) {}
void SDL_DrawGPUIndexedPrimitives(SDL_GPURenderPass*, Uint32 indices, Uint32 count, Uint32, int,
                                  Uint32) {
    assert(indices == 6 && count > 0);
    capture::draws.push_back(capture::bound);
}
void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) {}
void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, Uint32, WGPUBindGroup, Uint32,
                                       const Uint32*) {}
void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, Uint32 slot, WGPUBuffer buffer,
                                          std::uint64_t, std::uint64_t) {
    assert(slot == 0);
    capture::bound = buffer;
}
void wgpuRenderPassEncoderSetIndexBuffer(WGPURenderPassEncoder, WGPUBuffer, int, std::uint64_t,
                                         std::uint64_t) {}
void wgpuRenderPassEncoderDrawIndexed(WGPURenderPassEncoder, Uint32 indices, Uint32 count, Uint32,
                                      int, Uint32) {
    assert(indices == 6 && count > 0);
    capture::draws.push_back(capture::bound);
}

namespace bbl::upstream {
constexpr unsigned sprite_fx_ubo_bytes = 16, billboard_system_ubo_bytes = 16;
struct SceneUniforms {
    std::array<float, 16> viewProjection{};
    std::array<float, 16> view{};
};
constexpr std::array<std::uint16_t, 6> billboard_index_data{};
constexpr std::uint32_t billboard_instance_stride_bytes = 64;
template <class Params>
void build_sprite_fx_ubo(float seconds, const Params&, std::array<float, 4>& output) {
    capture::fx_seconds = seconds;
    output[0] = seconds;
}
void build_sprite_layer_ubo(const Sprite2DLayerRecord&, float width, float height,
                            std::array<float, 16>& output) {
    output[0] = width;
    output[1] = height;
}
void build_billboard_system_ubo(const BillboardSystemRecord&, std::array<float, 4>&) {}
void billboard_upload_instances(const BillboardSystemRecord& system, bool,
                                const std::array<float, 16>&, std::vector<float>& output, Vec3d) {
    output = system.instance_data;
}
} // namespace bbl::upstream

namespace bbl {
#include "mutations.hpp"
}
#include "layer-sort.hpp"

namespace {
// spriteRendererUpdate sorts rr._layers in place: a tie after an order
// change keeps the order the previous frame left, where a fresh permutation
// of the registration order would not, and only a reorder moves the GPU
// records (`layers_version`).
void check_layer_sort() {
    using namespace bbl;
    Engine engine;
    engine.sprite_layers.resize(3);
    engine.sprite_layers[0].order = 1.0f;
    engine.sprite_layers[1].order = 1.0f;
    engine.sprite_layers[2].order = 0.0f;
    SpriteRendererRecord renderer;
    renderer.layers = {{0}, {1}, {2}};
    const auto order = [&] {
        std::vector<std::uint32_t> values;
        for (const Sprite2DLayerHandle handle : renderer.layers)
            values.push_back(handle.value);
        return values;
    };
    sort_sprite_renderer_layers(engine, renderer);
    assert((order() == std::vector<std::uint32_t>{2, 0, 1}) && renderer.layers_version == 1);
    sort_sprite_renderer_layers(engine, renderer);
    assert(renderer.layers_version == 1);
    engine.sprite_layers[2].order = 1.0f;
    sort_sprite_renderer_layers(engine, renderer);
    assert((order() == std::vector<std::uint32_t>{2, 0, 1}) && renderer.layers_version == 1);
    engine.sprite_layers[0].order = 0.5f;
    sort_sprite_renderer_layers(engine, renderer);
    assert((order() == std::vector<std::uint32_t>{0, 2, 1}) && renderer.layers_version == 2);
    renderer.layers = {{1}};
    sort_sprite_renderer_layers(engine, renderer);
    assert(renderer.layers_version == 2);
}
} // namespace

namespace bbl::pal {
struct OwnedSdlPipeline {
    Resource* value = nullptr;
    Resource* get() const { return value; }
    explicit operator bool() const { return value != nullptr; }
    void reset() {
        if (value) {
            wgpuRenderPipelineRelease(value);
            value = nullptr;
        }
    }
};
template <class Record> struct FixtureRecord : Record {
    explicit FixtureRecord(Resource* = nullptr) {}
    FixtureRecord& operator=(Record record) {
        static_cast<Record&>(*this) = std::move(record);
        return *this;
    }
};
struct DawnSampledTexture {
    std::uint64_t uploaded_version = 0;
};
struct PinnedStageSlots {
    std::vector<std::string> textures;
    std::vector<std::string> uniforms{};
};
struct PinnedStageBlock {
    const void* data = nullptr;
    std::size_t bytes = 0;
};
template <typename Resolve>
void push_stage_uniforms(Resource*, const PinnedStageSlots& slots, bool, const char*,
                         Resolve resolve) {
    for (std::size_t slot = 0; slot < slots.uniforms.size(); ++slot)
        assert(resolve(slots.uniforms[slot], slot).data);
}
struct DawnLayoutStage {
    std::string_view stem;
    WGPUShaderStage stage;
};
struct DawnReflectedLayoutEntry {
    int entry = 0;
    std::string name;
};
/** The fixture's programs declare their one group last, as the pin's modules do. */
template <std::size_t Count>
std::vector<DawnReflectedLayoutEntry>
dawn_reflected_layout(const std::array<DawnLayoutStage, Count>&, Uint32 group) {
    return group == 0 ? std::vector<DawnReflectedLayoutEntry>{{0, "L"}}
                      : std::vector<DawnReflectedLayoutEntry>{};
}
template <std::size_t Count, typename Serve>
Resource* create_dawn_reflected_group(Resource*, Resource* layout,
                                      const std::array<DawnLayoutStage, Count>&, Uint32,
                                      Serve&& serve) {
    for (const char* name : {"L", "atlasTex", "atlasSamp"}) {
        WGPUBindGroupEntry entry{};
        assert(serve(std::string_view(name), entry));
    }
    const WGPUBindGroupDescriptor descriptor{layout, 0, nullptr};
    return wgpuDeviceCreateBindGroup(nullptr, &descriptor);
}
bool serve_dawn_extra_texture(std::string_view, const std::vector<std::string>&,
                              const std::vector<DawnSampledTexture>&, WGPUBindGroupEntry&) {
    return false;
}
struct GpuBufferUploadBatch {
    void update(Buffer* buffer, std::size_t offset, const void* data, std::size_t bytes) {
        capture::write(buffer, offset, data, bytes);
    }
};
[[noreturn]] void gpu_error(const char* message) { throw std::runtime_error(message); }
[[noreturn]] void dawn_error(const std::string& message) { throw std::runtime_error(message); }
void upload_2d_texture_into(Resource*, Resource*, const std::uint8_t*, std::size_t, Uint32, Uint32,
                            const char*) {
    ++capture::texture_uploads;
}
void update_dawn_extra_texture(Resource*, DawnSampledTexture& gpu, const PixelsTexture& texture) {
    ++capture::texture_uploads;
    gpu.uploaded_version = texture.rgba.version();
}
void push_stage_uniform(Resource*, int, const void*, std::size_t) {}
void push_vertex_stage_uniform(Resource*, int, const void*, std::size_t) {}
void update_buffer(Resource*, Buffer* buffer, const void* data, std::size_t bytes) {
    capture::write(buffer, 0, data, bytes);
}
#include "records.hpp"
struct DawnMipGenerator {};
PinnedStageSlots fragment_slots{{"atlasTex"}};
PinnedStageSlots read_pinned_stage_slots(const std::string&) { return fragment_slots; }
int stage_uniform_slot(const PinnedStageSlots&, const char* name) {
    return std::string_view(name) == "fx" ? 1 : 0;
}
OwnedSdlPipeline create_sprite_layer_pipeline(Resource*, const Sprite2DLayerRecord&, int, int,
                                              int) {
    ++capture::pipelines;
    return {capture::resource()};
}
std::vector<Resource*> create_dawn_sprite_layer_layouts(Resource*, const SpriteLayerPipelinePlan&,
                                                        Uint32) {
    return {capture::resource()};
}
Resource* create_dawn_sprite_layer_pipeline(Resource*, const std::vector<Resource*>&,
                                            const SpriteBlendDescriptor&,
                                            const SpriteLayerPipelinePlan&, Uint32, int, int,
                                            Uint32) {
    ++capture::pipelines;
    return capture::resource();
}
Buffer* dawn_sprite_uniform_buffer(Resource*, std::uint64_t size = 64) {
    return capture::allocate(static_cast<std::size_t>(size));
}
Buffer* upload_buffer(Resource*, int, const void*, std::size_t bytes) {
    return capture::allocate(bytes);
}
DawnSampledTexture upload_dawn_extra_texture(Resource*, Resource*, const PixelsTexture& texture) {
    return {texture.rgba.version()};
}
void release_dawn_extra_textures(std::vector<DawnSampledTexture>& extras) { extras.clear(); }
void append_sprite_fragment_textures(Resource*, std::vector<SDL_GPUTextureSamplerBinding>& textures,
                                     const std::vector<PixelsTexture>& extras, const char*) {
    for (std::size_t i = 0; i < extras.size(); ++i)
        textures.push_back({capture::resource(), capture::resource()});
}
void release_sprite_fragment_textures(Resource*,
                                      std::vector<SDL_GPUTextureSamplerBinding>& textures) {
    textures.clear();
}
SpriteAtlasGpu& sprite_atlas_gpu(Resource*, Engine&, SpriteAtlasHandle handle,
                                 const std::vector<Resource*>&,
                                 std::vector<SpriteAtlasGpu>& atlases) {
    for (auto& atlas : atlases)
        if (atlas.atlas.value == handle.value)
            return atlas;
    ++capture::atlas_fetches;
    atlases.emplace_back();
    auto& atlas = atlases.back();
    atlas.atlas = handle;
    atlas.texture = capture::resource();
    atlas.sampler = capture::resource();
    return atlas;
}
const DawnSpriteAtlasBinding&
ensure_dawn_sprite_atlas_binding(Resource*, Resource*, DawnMipGenerator&, Engine&,
                                 SpriteAtlasHandle handle, const std::vector<Resource*>&,
                                 const std::vector<Resource*>&,
                                 std::vector<DawnSpriteAtlasBinding>& atlases) {
    for (auto& atlas : atlases)
        if (atlas.handle.value == handle.value)
            return atlas;
    ++capture::atlas_fetches;
    atlases.emplace_back();
    auto& atlas = atlases.back();
    atlas.handle = handle;
    atlas.texture = capture::resource();
    atlas.view = capture::resource();
    atlas.sampler = capture::resource();
    return atlas;
}
const DawnSpriteAtlasBinding&
find_dawn_sprite_atlas_binding(const std::vector<DawnSpriteAtlasBinding>& atlases,
                               SpriteAtlasHandle handle) {
    for (const auto& atlas : atlases)
        if (atlas.handle.value == handle.value)
            return atlas;
    throw std::runtime_error("Missing fixture atlas");
}
void release_dawn_sprite_atlas_bindings(std::vector<DawnSpriteAtlasBinding>& atlases) {
    atlases.clear();
}
inline void release_dawn_sprite_layer_resources(Resource*, DawnSpriteLayerResources&) noexcept;
void release_dawn_sprite_layer(DawnSpriteLayer& layer) {
    release_dawn_sprite_layer_resources(nullptr, layer);
}
std::uint32_t atlas_mip_levels(const SpriteAtlasRecord&) { return 1u; }
std::uint32_t gpu_sample_count_value(SDL_GPUSampleCount samples) {
    return static_cast<std::uint32_t>(samples);
}
// The pass builders record what they were handed; the passes they return
// draw their own instance buffer.
template <class Pass>
Pass fixture_billboard_pass(const BillboardPassSource& source,
                            const std::vector<std::uint8_t>& texels) {
    capture::billboard_builds.push_back(source.system.value);
    capture::billboard_texels.push_back(&texels);
    capture::billboard_texel_bytes.push_back(texels);
    capture::billboard_coverage.push_back(source.plan.alpha_to_coverage);
    Pass pass;
    pass.system = source.system;
    pass.instances = capture::allocate(16);
    return pass;
}
BillboardPass create_billboard_pass(SDL_GPUDevice*, const BillboardPassSource& source,
                                    const std::vector<std::uint8_t>& texels, SDL_GPUTextureFormat,
                                    SDL_GPUTextureFormat, SDL_GPUSampleCount) {
    return fixture_billboard_pass<BillboardPass>(source, texels);
}
DawnBillboardPass create_dawn_billboard_pass(WGPUDevice, WGPUQueue,
                                             const BillboardPassSource& source,
                                             const std::vector<std::uint8_t>& texels,
                                             WGPUTextureFormat, WGPUTextureFormat, std::uint32_t) {
    return fixture_billboard_pass<DawnBillboardPass>(source, texels);
}
struct DawnState {
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUTextureFormat frame_color_format = WGPUTextureFormat_Undefined;
    std::uint32_t sample_count = 4;
    std::vector<DawnBillboardPass> billboard_passes;
    std::uint64_t billboard_renderable_version = 0;
};
void generate_mipmaps(DawnState&, WGPUTexture, WGPUTextureFormat, std::uint32_t) {
    ++capture::mip_fills;
}
// A native job: the realm runs one turn while it is pending, then it runs.
Iteration<bool> run_native_preparation(std::vector<std::function<void()>> jobs, bool native) {
    if (native && !jobs.empty())
        co_yield false;
    for (const auto& job : jobs)
        job();
    co_return true;
}
#include "functions.hpp"
} // namespace bbl::pal

void check_pipeline_cache() {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine;
    engine.sprite_layers.resize(3);
    for (auto& layer : engine.sprite_layers) {
        layer.depth_mode = Sprite2DDepthMode::test_write;
        layer.atlas = {0};
        layer.pipeline_version = 1;
        layer.custom_shader = 0;
        layer.visible = false;
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
             [](auto& value) {
                 value.blend.color.src = value.blend.color.src == SpriteBlendFactor::zero
                                             ? SpriteBlendFactor::one
                                             : SpriteBlendFactor::zero;
             },
             [](auto& value) {
                 value.blend.alpha.dst = value.blend.alpha.dst == SpriteBlendFactor::zero
                                             ? SpriteBlendFactor::one
                                             : SpriteBlendFactor::zero;
             }}) {
        auto changed = same;
        mutate(changed);
        assert(!sprite_scene_pipeline_compatible(same, changed));
    }
    auto cosmetic = same;
    cosmetic.order = 17;
    cosmetic.visible = true;
    cosmetic.count = 3;
    assert(sprite_scene_pipeline_compatible(same, cosmetic));
    engine.sprite_layers[1].depth_mode = Sprite2DDepthMode::test;
    capture::pipelines = 0;
    capture::pipeline_releases = 0;
    auto sdl = create_scene_sprite_pass(nullptr, engine, {{0}, {1}, {2}}, {}, 0, 0, 4);
    DawnMipGenerator mips;
    auto dawn = create_dawn_scene_sprite_pass(nullptr, nullptr, mips, engine, {{0}, {1}, {2}}, {},
                                              {}, 0, 0, 4);
    assert(capture::pipelines == 4 && capture::atlas_fetches == 2);
    assert(sdl.layers[0].pipeline == sdl.layers[2].pipeline &&
           sdl.layers[0].pipeline != sdl.layers[1].pipeline);
    assert(sdl.layers[0].owned_pipeline && !sdl.layers[2].owned_pipeline);
    assert(dawn.layers[0].pipeline == dawn.layers[2].pipeline &&
           dawn.layers[0].group_layouts == dawn.layers[2].group_layouts);
    assert(dawn.layers[0].owns_pipeline && dawn.layers[0].owns_group_layouts &&
           !dawn.layers[2].owns_pipeline && !dawn.layers[2].owns_group_layouts);
    sdl.layers[0].elapsed_ms = 123.25;
    dawn.layers[0].elapsed_ms = 123.25;
    sdl.layers[2].elapsed_ms = 99.75;
    dawn.layers[2].elapsed_ms = 99.75;
    GpuBufferUploadBatch uploads;
    upload_scene_sprite_pass(nullptr, engine, sdl, 0, uploads);
    sync_dawn_scene_sprite_pass_pipelines(nullptr, nullptr, engine, dawn);
    assert(capture::pipelines == 4 && capture::pipeline_releases == 0);
    engine.sprite_layers[0].depth_mode = Sprite2DDepthMode::test;
    ++engine.sprite_layers[0].pipeline_version;
    upload_scene_sprite_pass(nullptr, engine, sdl, 0, uploads);
    sync_dawn_scene_sprite_pass_pipelines(nullptr, nullptr, engine, dawn);
    assert(capture::pipelines == 8 && capture::pipeline_releases == 4);
    assert(sdl.layers[0].pipeline == sdl.layers[1].pipeline &&
           sdl.layers[0].pipeline != sdl.layers[2].pipeline);
    assert(dawn.layers[0].pipeline == dawn.layers[1].pipeline &&
           dawn.layers[0].pipeline != dawn.layers[2].pipeline);
    assert(sdl.layers[0].elapsed_ms == 123.25 && dawn.layers[0].elapsed_ms == 123.25);
    assert(sdl.layers[2].elapsed_ms == 99.75 && dawn.layers[2].elapsed_ms == 99.75);
    release_dawn_scene_sprite_pass_resources(nullptr, dawn);
    assert(dawn.layers.empty() && dawn.atlases.empty() && capture::pipeline_releases == 6);
    for (auto& layer : sdl.layers)
        release_sprite_layer_resources(nullptr, layer);
    assert(capture::pipeline_releases == 8);
    engine.sprite_layers[0].depth_mode = Sprite2DDepthMode::none;
    try {
        create_scene_sprite_pass(nullptr, engine, {{0}}, {}, 0, 0, 1);
        assert(false);
    } catch (const std::runtime_error&) {
    }
    try {
        create_dawn_scene_sprite_pass(nullptr, nullptr, mips, engine, {{0}}, {}, {}, 0, 0, 1);
        assert(false);
    } catch (const std::runtime_error&) {
    }
    try {
        create_sprite_renderer(engine, SpriteRendererOptions{.layers = {{1}}});
        assert(false);
    } catch (const std::runtime_error&) {
    }
    assert(engine.sprite_renderers.empty());
    const auto renderer = create_sprite_renderer(engine, SpriteRendererOptions{.layers = {{0}}});
    try {
        add_sprite_renderer_layer(engine, renderer, {1});
        assert(false);
    } catch (const std::runtime_error&) {
    }
    engine.sprite_layers[1].depth_mode = Sprite2DDepthMode::none;
    add_sprite_renderer_layer(engine, renderer, {1});
    add_sprite_renderer_layer(engine, renderer, {1});
    assert(engine.sprite_renderers[0].layers.size() == 2 &&
           engine.sprite_renderers[0].layers_version == 1);
    auto& touched = engine.sprite_layers[0];
    touched.version = 0;
    touched.dirty_sprite_begin = invalid_handle;
    touched.dirty_sprite_end = 0;
    touch_sprite_instances(touched, 2, 3);
    touch_sprite_instances(touched, 0, 1);
    assert(touched.dirty_sprite_begin == 0 && touched.dirty_sprite_end == 3 &&
           touched.version == 2);
}

// The passes follow the systems the scene draws (`billboard_renderables`,
// which `addBillboardSystem`'s deferred builder fills when the scene builds,
// advancing its `renderable_version`) on both backends: setup builds the
// members it finds, a system a registration publishes between setup and the
// first frame -- while Dawn's setup job is still running -- or after it gets a
// pass that draws before the next frame, a frame with no build since follows
// nothing, a kept member keeps its pass, a system added twice gets two, and a
// scene's disposal releases them.
void check_billboard_membership() {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine;
    // Two atlases, each holding the texels its creation took.
    engine.sprite_atlases.resize(2);
    engine.sprite_atlases[0].rgba = share_texels({1, 2, 3, 4});
    engine.sprite_atlases[1].rgba = share_texels({5, 6, 7, 8});
    engine.billboard_systems.resize(4);
    for (auto& system : engine.billboard_systems) {
        system.count = 1;
        system.visible = true;
        system.atlas = {0};
    }
    engine.billboard_systems[2].atlas = {1};
    engine.billboard_systems[3].atlas = {1};
    // A cutout system with alpha-to-coverage: the plan resolves it at four
    // samples only.
    engine.billboard_systems[1].depth_mode = BillboardDepthMode::cutout;
    engine.billboard_systems[1].alpha_to_coverage = true;
    Scene scene;
    auto& members = scene.state->billboard_renderables;
    auto& version = scene.state->renderable_version;
    // register_scene: the deferred builders publish, and the version moves.
    const auto publish = [&](std::initializer_list<std::uint32_t> published) {
        for (const std::uint32_t system : published)
            members.push_back({system});
        ++version;
    };
    const auto systems = [](const auto& passes) {
        std::vector<std::uint32_t> values;
        for (const auto& pass : passes)
            values.push_back(pass.system.value);
        return values;
    };
    const auto draws = [&](const auto& record, const auto& passes) {
        capture::reset();
        for (const auto& pass : passes)
            record(pass);
        std::vector<Buffer*> wanted;
        for (const auto& pass : passes)
            wanted.push_back(pass.instances);
        return capture::draws == wanted;
    };

    // SDL_GPU: one path at setup and in any frame whose scene built since.
    std::vector<BillboardPass> sdl;
    std::uint64_t sdl_version = 0;
    const auto sync_sdl = [&](SDL_GPUSampleCount samples) {
        sync_billboard_passes(nullptr, engine, scene, sdl, sdl_version, 0, 0, samples);
    };
    const auto frame_sdl = [&] {
        if (sdl_version != version)
            sync_sdl(SDL_GPU_SAMPLECOUNT_4);
    };
    const auto record_sdl = [&](const BillboardPass& pass) {
        record_billboard_pass(nullptr, nullptr, engine, pass, bbl::upstream::SceneUniforms{});
    };
    publish({0});
    capture::billboard_builds.clear();
    capture::billboard_texels.clear();
    sync_sdl(SDL_GPU_SAMPLECOUNT_4);
    assert((systems(sdl) == std::vector<std::uint32_t>{0}) && sdl_version == version);
    Buffer* const kept = sdl[0].instances;
    frame_sdl();
    assert(capture::billboard_builds.size() == 1u);
    // Published between setup and the first frame, and after it.
    publish({1});
    frame_sdl();
    assert((systems(sdl) == std::vector<std::uint32_t>{0, 1}) && sdl[0].instances == kept);
    assert(capture::billboard_coverage.back() && draws(record_sdl, sdl));
    publish({2, 1});
    frame_sdl();
    assert((systems(sdl) == std::vector<std::uint32_t>{0, 1, 2, 1}) && sdl[0].instances == kept);
    assert((capture::billboard_builds == std::vector<std::uint32_t>{0, 1, 2, 1}));
    assert(draws(record_sdl, sdl) && sdl_version == version);
    // The realm's records serve the build in place.
    assert(capture::billboard_texels[0] == engine.sprite_atlases[0].rgba.get());
    // Disposal empties the list and moves the version.
    members.clear();
    ++version;
    frame_sdl();
    assert(sdl.empty());
    publish({1});
    sync_sdl(SDL_GPU_SAMPLECOUNT_1);
    assert(!capture::billboard_coverage.back());

    // Dawn: setup runs the same path as a native job, beside the realm.
    DawnState state;
    const auto record_dawn = [&](const DawnBillboardPass& pass) {
        record_dawn_billboard_pass(nullptr, engine, pass, pass.frame_scene);
    };
    members.clear();
    publish({0, 2, 3});
    capture::billboard_builds.clear();
    capture::billboard_texels.clear();
    capture::billboard_texel_bytes.clear();
    capture::mip_fills = 0;
    auto setup = sync_dawn_billboard_passes(state, engine, scene, true);
    assert(setup.advance());
    // A registration publishes a system while the job runs.
    const std::uint64_t setup_version = version;
    publish({1});
    while (setup.advance()) {
    }
    assert((systems(state.billboard_passes) == std::vector<std::uint32_t>{0, 2, 3}));
    // The passes follow the version setup snapshot, so the frame follows again.
    assert(state.billboard_renderable_version == setup_version && setup_version != version);
    // The job shares each atlas's texels rather than copying them.
    assert(capture::billboard_texels[0] == engine.sprite_atlases[0].rgba.get() &&
           capture::billboard_texel_bytes[0] == *engine.sprite_atlases[0].rgba);
    assert(capture::billboard_texels[1] == engine.sprite_atlases[1].rgba.get() &&
           capture::billboard_texels[2] == capture::billboard_texels[1]);
    assert(capture::mip_fills == 3u);
    // The first frame follows, in place.
    Buffer* const dawn_kept = state.billboard_passes[1].instances;
    auto frame = sync_dawn_billboard_passes(state, engine, scene, false);
    assert(!frame.advance());
    assert((systems(state.billboard_passes) == std::vector<std::uint32_t>{0, 2, 3, 1}));
    assert(state.billboard_passes[1].instances == dawn_kept && capture::mip_fills == 4u);
    assert(state.billboard_renderable_version == version);
    // In place too, the build reads the atlas record's shared texels.
    assert(capture::billboard_texels.back() == engine.sprite_atlases[0].rgba.get());
    assert(capture::billboard_coverage.back() && draws(record_dawn, state.billboard_passes));
    members.erase(members.begin());
    ++version;
    auto disposal = sync_dawn_billboard_passes(state, engine, scene, false);
    assert(!disposal.advance());
    assert((systems(state.billboard_passes) == std::vector<std::uint32_t>{2, 3, 1}));
    assert(capture::billboard_builds.size() == 4u);
}

// The depth-hosted layer pass follows the layers the scene draws on both
// backends (`addDepthHostedSpriteLayer` publishes through the deferred
// builders, advancing `renderable_version`): a build that publishes more
// layers appends them beside the drawn ones, which keep their clocks, and
// they share an earlier compatible layer's pipeline; disposal releases it.
void check_scene_sprite_membership() {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine;
    engine.sprite_layers.resize(3);
    for (auto& layer : engine.sprite_layers) {
        layer.depth_mode = Sprite2DDepthMode::test_write;
        layer.atlas = {0};
        layer.pipeline_version = 1;
        layer.custom_shader = 0;
        layer.visible = false;
    }
    engine.sprite_layers[1].depth_mode = Sprite2DDepthMode::test;
    Scene scene;
    auto& members = scene.depth_hosted_sprite_layers;
    auto& version = scene.state->renderable_version;
    const auto publish = [&](std::initializer_list<std::uint32_t> published) {
        for (const std::uint32_t layer : published)
            members.push_back({layer});
        ++version;
    };
    const auto layers = [](const auto& pass) {
        std::vector<std::uint32_t> values;
        for (const Sprite2DLayerHandle handle : pass.handles)
            values.push_back(handle.value);
        return values;
    };
    const auto follow = [&](auto sync, auto& pass, bool& has_pass, std::uint64_t& followed) {
        // Setup, the scene with nothing published: no pass.
        capture::pipelines = 0;
        sync();
        assert(!has_pass && followed == version);
        publish({0});
        sync();
        assert(has_pass && (layers(pass) == std::vector<std::uint32_t>{0}) &&
               capture::pipelines == 1 && followed == version);
        pass.layers[0].elapsed_ms = 5.0;
        publish({1, 2});
        sync();
        assert((layers(pass) == std::vector<std::uint32_t>{0, 1, 2}) &&
               pass.layers[0].elapsed_ms == 5.0 && capture::pipelines == 2);
        assert(pass.layers[2].pipeline == pass.layers[0].pipeline &&
               pass.layers[1].pipeline != pass.layers[0].pipeline);
        // Disposal empties the list and moves the version.
        members.clear();
        ++version;
        sync();
        assert(!has_pass && followed == version);
    };
    SceneSpritePass sdl;
    bool has_sdl = false;
    std::uint64_t sdl_version = 0;
    follow(
        [&] {
            sync_scene_sprite_pass(nullptr, engine, scene, sdl, has_sdl, sdl_version, {}, 0, 0, 4);
        },
        sdl, has_sdl, sdl_version);
    DawnSceneSpritePass dawn;
    DawnMipGenerator mips;
    bool has_dawn = false;
    std::uint64_t dawn_version = 0;
    follow(
        [&] {
            sync_dawn_scene_sprite_pass(nullptr, nullptr, mips, engine, scene, dawn, has_dawn,
                                        dawn_version, {}, {}, 0, 0, 4);
        },
        dawn, has_dawn, dawn_version);
}

template <class Gpu, class Upload, class Record>
void check_layer(Gpu& gpu, bbl::Engine& engine, Upload upload, Record record) {
    using namespace bbl;
    auto& layer = engine.sprite_layers[0];
    layer.instance_floats_per_sprite = 1;
    layer.instance_data = {10, 20, 30, 40};
    layer.count = 4;
    layer.version = 1;
    layer.custom_shader = 1;
    gpu.elapsed_ms = 4294967296.0;
    layer.visible = false;
    capture::reset();
    upload(.25);
    assert(gpu.elapsed_ms == 4294967296.0 && !gpu.instances && capture::writes.empty());
    layer.visible = true;
    layer.count = 0;
    upload(.25);
    assert(gpu.elapsed_ms == 4294967296.0 && !gpu.instances);
    layer.count = 4;
    upload(.25);
    record();
    assert(gpu.elapsed_ms == 4294967296.25 && gpu.instance_buffer_bytes == 16 &&
           gpu.uploaded_version == 1);
    assert((gpu.instances->data == std::vector<float>{10, 20, 30, 40}));
    assert(capture::fx_seconds == static_cast<float>(4294967296.25 / 1000.0));
    assert(layer.dirty_sprite_reset_version == 1 && layer.dirty_sprite_begin == invalid_handle);
    auto* original = gpu.instances;
    capture::reset();
    upload(.25);
    assert(gpu.instances == original && gpu.elapsed_ms == 4294967296.5);
    assert(std::none_of(capture::writes.begin(), capture::writes.end(),
                        [&](const auto& write) { return write.buffer == original; }));
    layer.instance_data[2] = 90;
    ++layer.version;
    layer.dirty_sprite_begin = 2;
    layer.dirty_sprite_end = 3;
    capture::reset();
    upload(.25);
    const auto write = std::find_if(capture::writes.begin(), capture::writes.end(),
                                    [&](const auto& item) { return item.buffer == original; });
    assert(write != capture::writes.end() && write->offset == 8 &&
           write->values == std::vector<float>{90});
    assert((gpu.instances->data == std::vector<float>{10, 20, 90, 40}));
    const std::array<float, 4> sorted{40, 90, 20, 10};
    engine.sprite_y_sort_hook.upload = [&](Sprite2DLayerRecord&,
                                           double version) -> std::optional<SpriteInstanceUpload> {
        assert(version == static_cast<double>(gpu.uploaded_version));
        return SpriteInstanceUpload{reinterpret_cast<const std::uint8_t*>(sorted.data()), 4, 4, 8};
    };
    ++layer.version;
    layer.dirty_sprite_begin = 0;
    layer.dirty_sprite_end = 4;
    capture::reset();
    upload(.25);
    const auto sorted_write =
        std::find_if(capture::writes.begin(), capture::writes.end(),
                     [&](const auto& item) { return item.buffer == original; });
    assert(sorted_write != capture::writes.end() && sorted_write->offset == 4 &&
           (sorted_write->values == std::vector<float>{90, 20}));
    engine.sprite_y_sort_hook.upload = {};
    layer.instance_data.push_back(50);
    layer.count = 5;
    ++layer.version;
    capture::fail_allocate = true;
    capture::reset();
    try {
        upload(.25);
        assert(false);
    } catch (const std::runtime_error&) {
    }
    assert(gpu.instances == original && gpu.instance_buffer_bytes == 16 &&
           capture::released.empty());
    capture::fail_allocate = false;
    upload(.25);
    assert(gpu.instances != original && gpu.instance_buffer_bytes == 20 &&
           capture::released == std::vector<Buffer*>{original});
    assert(gpu.instances->data == layer.instance_data);
    ++layer.version;
    layer.dirty_sprite_begin = 0;
    layer.dirty_sprite_end = 1;
    const auto before_version = gpu.uploaded_version;
    capture::fail_write = true;
    try {
        upload(.25);
        assert(false);
    } catch (const std::runtime_error&) {
    }
    assert(gpu.uploaded_version == before_version && layer.dirty_sprite_begin == 0);
    capture::fail_write = false;
    upload(.25);
    assert(gpu.uploaded_version == layer.version && layer.dirty_sprite_begin == invalid_handle);
}

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    check_layer_sort();
    check_pipeline_cache();
    check_scene_sprite_membership();
    Engine engine;
    engine.sprite_layers.resize(1);
    SpriteLayerGpu sdl;
    GpuBufferUploadBatch batch;
    sdl.fx_block_slot = 1;
    check_layer(
        sdl, engine,
        [&](double dt) { upload_sprite_layer_gpu(nullptr, engine, {0}, sdl, dt, batch); },
        [&] { record_sprite_layer_gpu(nullptr, nullptr, engine.sprite_layers[0], sdl, 640, 480); });
    engine.sprite_layers[0] = Sprite2DLayerRecord{};
    DawnSpriteLayer dawn;
    dawn.layer_uniforms = capture::allocate(64);
    dawn.fx_uniforms = capture::allocate(16);
    check_layer(
        dawn, engine,
        [&](double dt) {
            upload_dawn_sprite_layer(nullptr, nullptr, engine, {0}, dawn, 640, 480, dt);
        },
        [] {});

    Resource atlas, noise, mask;
    const std::vector<SDL_GPUTextureSamplerBinding> textures{
        {&atlas, nullptr}, {&noise, nullptr}, {&mask, nullptr}};
    sdl.bound_textures = select_sprite_fragment_textures({{"maskTex", "atlasTex"}}, textures,
                                                         {"noise", "mask"}, "fixture");
    capture::reset();
    record_sprite_layer_gpu(nullptr, nullptr, engine.sprite_layers[0], sdl, 640, 480);
    assert((capture::textures == std::vector<Resource*>{&mask, &atlas}));
    assert(select_sprite_fragment_textures({{}}, textures, {"noise", "mask"}, "fixture").empty());
    for (const auto& slots : std::vector<PinnedStageSlots>{{{"missingTex"}}, {{"atlasTex"}}}) {
        try {
            select_sprite_fragment_textures(slots, textures, {"noise"}, "fixture");
            assert(false);
        } catch (const std::runtime_error&) {
        }
    }
    try {
        select_sprite_fragment_textures({{"missingTex"}}, textures, {"noise", "mask"}, "fixture");
        assert(false);
    } catch (const std::runtime_error&) {
    }

    engine.sprite_layers.resize(5);
    SceneSpritePass scene_sdl;
    DawnSceneSpritePass scene_dawn;
    for (Uint32 index = 0; index < 5; ++index) {
        auto& layer = engine.sprite_layers[index];
        layer.count = 1;
        layer.visible = true;
        layer.depth_mode = Sprite2DDepthMode::test_write;
        layer.order = 100.0f - static_cast<float>(index);
        scene_sdl.handles.push_back({index});
        scene_dawn.handles.push_back({index});
        scene_sdl.layers.emplace_back();
        scene_dawn.layers.emplace_back();
        auto* buffer = capture::allocate(4);
        scene_sdl.layers.back().instances = buffer;
        scene_dawn.layers.back().instances = buffer;
    }
    engine.sprite_layers[1].visible = false;
    engine.sprite_layers[2].count = 0;
    engine.sprite_layers[3].depth_mode = Sprite2DDepthMode::test;
    const std::vector<Buffer*> wanted{scene_sdl.layers[0].instances, scene_sdl.layers[4].instances};
    capture::reset();
    record_scene_sprite_pass(nullptr, nullptr, engine, scene_sdl, Sprite2DDepthMode::test_write,
                             640, 480);
    assert(capture::draws == wanted);
    capture::reset();
    record_dawn_scene_sprite_pass(nullptr, engine, scene_dawn, Sprite2DDepthMode::test_write);
    assert(capture::draws == wanted);
    capture::reset();
    record_dawn_scene_sprite_pass(nullptr, engine, scene_dawn, Sprite2DDepthMode::test);
    assert(capture::draws == std::vector<Buffer*>{scene_dawn.layers[3].instances});

    Scene scene;
    engine.billboard_systems.resize(1);
    auto& system = engine.billboard_systems[0];
    system.count = 1;
    system.visible = true;
    system.instance_version = 1;
    system.instance_data = {1, 2, 3, 4};
    system.custom_shader = 1;
    BillboardPass billboard;
    billboard.system = {0};
    billboard.instances = capture::allocate(16);
    billboard.fragment_slots.uniforms = {"billboards", "fx"};
    billboard.elapsed_ms = 4294967296.0;
    billboard.bound_textures = sdl.bound_textures;
    DawnBillboardPass dawn_billboard;
    dawn_billboard.system = {0};
    dawn_billboard.instances = capture::allocate(16);
    dawn_billboard.frame_scene.uniforms = capture::allocate(sizeof(bbl::upstream::SceneUniforms));
    dawn_billboard.system_uniforms = capture::allocate(16);
    dawn_billboard.fx_uniforms = capture::allocate(16);
    dawn_billboard.elapsed_ms = 4294967296.0;
    const std::array<float, 16> view{};
    const bbl::upstream::SceneUniforms scene_block{};
    for (unsigned frame = 1; frame <= 4; ++frame) {
        capture::reset();
        upload_billboard_pass(nullptr, scene, engine, billboard, view, .25);
        record_billboard_pass(nullptr, nullptr, engine, billboard, scene_block);
        assert(billboard.elapsed_ms == 4294967296.0 + frame * .25);
        assert(capture::fx_seconds == static_cast<float>(billboard.elapsed_ms / 1000.0));
        assert(capture::writes.size() == (frame == 1 ? 1u : 0u));
        assert((capture::textures == std::vector<Resource*>{&mask, &atlas}));
        capture::reset();
        upload_dawn_billboard_pass(nullptr, nullptr, scene, engine, dawn_billboard, scene_block,
                                   .25);
        assert(dawn_billboard.elapsed_ms == billboard.elapsed_ms);
        assert(capture::fx_seconds == static_cast<float>(dawn_billboard.elapsed_ms / 1000.0));
        assert(capture::writes.size() == (frame == 1 ? 4u : 3u));
    }

    // ensureBillboardInstanceBuffer: a system grown past the buffer's capacity
    // uploads every row into a new buffer sized for its capacity.
    system.capacity = 2;
    system.count = 2;
    system.instance_data.assign(2u * system.instance_floats_per_sprite, 1.0f);
    billboard.instance_capacity = 1;
    dawn_billboard.instance_capacity = 1;
    const auto* sdl_before = billboard.instances;
    const auto* dawn_before = dawn_billboard.instances;
    capture::reset();
    upload_billboard_pass(nullptr, scene, engine, billboard, view, .25);
    assert(billboard.instances != sdl_before && billboard.instance_capacity == 2u);
    assert(capture::writes.size() == 1u);
    capture::reset();
    upload_dawn_billboard_pass(nullptr, nullptr, scene, engine, dawn_billboard, scene_block, .25);
    assert(dawn_billboard.instances != dawn_before && dawn_billboard.instance_capacity == 2u);
    assert(capture::writes.size() == 4u);
    // The one growth rule on both backends: a buffer that cannot grow stays
    // the pass's own, at its capacity, with its upload stamp.
    system.capacity = 4;
    system.count = 4;
    system.instance_data.assign(4u * system.instance_floats_per_sprite, 1.0f);
    const auto* sdl_grown = billboard.instances;
    const auto* dawn_grown = dawn_billboard.instances;
    capture::fail_allocate = true;
    capture::reset();
    for (const auto& grow : std::vector<std::function<void()>>{
             [&] { upload_billboard_pass(nullptr, scene, engine, billboard, view, .25); },
             [&] {
                 upload_dawn_billboard_pass(nullptr, nullptr, scene, engine, dawn_billboard,
                                            scene_block, .25);
             }}) {
        try {
            grow();
            assert(false);
        } catch (const std::runtime_error&) {
        }
    }
    capture::fail_allocate = false;
    assert(billboard.instances == sdl_grown && billboard.instance_capacity == 2u &&
           billboard.upload_stamp.uploaded);
    assert(dawn_billboard.instances == dawn_grown && dawn_billboard.instance_capacity == 2u &&
           dawn_billboard.upload_stamp.uploaded && capture::released.empty());

    check_billboard_membership();
}
