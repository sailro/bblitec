#include "pal_dawn_text_resources.hpp"
#include <cassert>
#include <cstring>
#include <string>

// This API recorder executes the production resource adapter without a GPU.
struct Resource { unsigned destroyed = 0, released = 0; virtual ~Resource() = default; };
struct WGPUBufferImpl : Resource { std::vector<std::uint8_t> bytes; WGPUBufferUsage usage = 0; };
struct WGPUTextureImpl : Resource { WGPUTextureDescriptor descriptor{}; std::vector<std::uint8_t> bytes; };
struct WGPUTextureViewImpl : Resource { WGPUTexture texture = nullptr; };
struct WGPUBindGroupImpl : Resource { std::vector<WGPUBindGroupEntry> entries; };
struct WGPUBindGroupLayoutImpl : Resource {};
struct WGPURenderPipelineImpl : Resource {};
static std::vector<std::unique_ptr<Resource>> resources;
static std::vector<std::string> draws;
template<class R> R* make_resource() {
    auto value = std::make_unique<R>();
    auto* result = value.get(); resources.push_back(std::move(value)); return result;
}
extern "C" {
WGPUBuffer wgpuDeviceCreateBuffer(WGPUDevice, const WGPUBufferDescriptor* descriptor) {
    auto value = make_resource<WGPUBufferImpl>();
    value->bytes.resize(descriptor->size); value->usage = descriptor->usage; return value;
}
WGPUTexture wgpuDeviceCreateTexture(WGPUDevice, const WGPUTextureDescriptor* descriptor) {
    auto value = make_resource<WGPUTextureImpl>(); value->descriptor = *descriptor; return value;
}
WGPUTextureView wgpuTextureCreateView(WGPUTexture texture, const WGPUTextureViewDescriptor*) {
    auto value = make_resource<WGPUTextureViewImpl>(); value->texture = texture; return value;
}
WGPUBindGroup wgpuDeviceCreateBindGroup(WGPUDevice, const WGPUBindGroupDescriptor* descriptor) {
    auto value = make_resource<WGPUBindGroupImpl>();
    value->entries.assign(descriptor->entries, descriptor->entries + descriptor->entryCount); return value;
}
void wgpuBufferDestroy(WGPUBuffer value) { ++value->destroyed; }
void wgpuTextureDestroy(WGPUTexture value) { ++value->destroyed; }
void wgpuBufferRelease(WGPUBuffer value) { ++value->released; }
void wgpuTextureRelease(WGPUTexture value) { ++value->released; }
void wgpuTextureViewRelease(WGPUTextureView value) { ++value->released; }
void wgpuBindGroupRelease(WGPUBindGroup value) { ++value->released; }
void wgpuBindGroupLayoutRelease(WGPUBindGroupLayout value) { ++value->released; }
void wgpuRenderPipelineRelease(WGPURenderPipeline value) { ++value->released; }
void wgpuQueueWriteBuffer(WGPUQueue, WGPUBuffer value, std::uint64_t offset, const void* data, std::size_t size) {
    assert(value->destroyed == 0 && value->released == 0 && offset + size <= value->bytes.size());
    std::memcpy(value->bytes.data() + offset, data, size);
}
void wgpuQueueWriteTexture(WGPUQueue, const WGPUTexelCopyTextureInfo* destination, const void* data,
    std::size_t size, const WGPUTexelCopyBufferLayout* layout, const WGPUExtent3D* extent) {
    assert(layout->bytesPerRow == extent->width * 16 && layout->rowsPerImage == extent->height);
    assert(destination->texture->destroyed == 0 && size == layout->bytesPerRow * extent->height);
    const auto bytes = static_cast<const std::uint8_t*>(data);
    destination->texture->bytes.assign(bytes, bytes + size);
}
void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, std::uint32_t slot, WGPUBuffer, std::uint64_t offset, std::uint64_t size) {
    assert(offset == 0 && size == WGPU_WHOLE_SIZE); draws.push_back("vertex" + std::to_string(slot));
}
void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) { draws.push_back("pipeline"); }
void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, std::uint32_t group, WGPUBindGroup, std::size_t count, const std::uint32_t*) {
    assert(group == 0 && count == 0); draws.push_back("group");
}
void wgpuRenderPassEncoderDraw(WGPURenderPassEncoder, std::uint32_t vertices, std::uint32_t instances,
    std::uint32_t first_vertex, std::uint32_t first_instance) {
    assert(vertices == 6 && instances == 3 && first_vertex == 0 && first_instance == 7); draws.push_back("draw");
}
}

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    auto owner = std::make_shared<DawnTextDevice>();
    owner->device = reinterpret_cast<WGPUDevice>(1);
    owner->queue = reinterpret_cast<WGPUQueue>(2);
    DawnTextResourceOps ops{owner};
    TextGpuState first, second;
    TextAtlasGpuState atlas;
    for (auto* gpu : {&first, &second}) {
        ops.create_renderable_buffer(*gpu, TextBufferKind::uniform, 96);
        ops.create_renderable_buffer(*gpu, TextBufferKind::instances, 96);
        ops.create_renderable_buffer(*gpu, TextBufferKind::styles, 32);
    }
    ops.create_atlas_texture(atlas, TextAtlasTextureKind::curves, 4, 2);
    ops.create_atlas_texture(atlas, TextAtlasTextureKind::bands, 4, 1);
    ops.create_atlas_metadata(atlas, 64);
    auto layout = std::make_shared<DawnTextLayout>();
    layout->layout = retain_dawn_text_resource<DawnTextLayoutLease>(owner, make_resource<WGPUBindGroupLayoutImpl>());
    layout->bindings = {{3, DawnTextBindingRole::metadata}, {4, DawnTextBindingRole::styles},
        {0, DawnTextBindingRole::uniform}, {1, DawnTextBindingRole::curves}, {2, DawnTextBindingRole::bands}};
    auto captured = std::static_pointer_cast<DawnTextGroup>(ops.create_bind_group(first, atlas, layout));
    const auto first_resources = std::static_pointer_cast<DawnTextRenderableResources>(first.backend);
    const auto second_resources = std::static_pointer_cast<DawnTextRenderableResources>(second.backend);
    assert(captured->uniform.lease == first_resources->uniform.lease);
    assert(captured->uniform.lease != second_resources->uniform.lease);
    assert(captured->group->get()->entries[2].buffer == first_resources->uniform.lease->get());
    assert(captured->group->get()->entries[0].size == 64);
    assert(captured->curves.texture->get()->descriptor.format == WGPUTextureFormat_RGBA32Float);
    assert(captured->curves.texture->get()->descriptor.usage & WGPUTextureUsage_CopySrc);
    const std::array<std::uint8_t, 4> words{1, 2, 3, 4};
    ops.write_renderable_buffer(first, TextBufferKind::uniform, 80, words);
    assert(captured->uniform.lease->get()->bytes[80] == 1 && captured->uniform.lease->get()->bytes[84] == 0);
    const std::array<std::uint8_t, 128> curve_bytes{};
    ops.write_atlas_texture(atlas, TextAtlasTextureKind::curves, curve_bytes, 64, 4, 2);
    ops.write_atlas_metadata(atlas, words);
    auto pipeline = retain_dawn_text_resource<DawnTextPipelineLease>(owner, make_resource<WGPURenderPipelineImpl>());
    auto quad = std::make_shared<DawnTextBuffer>(ops.create_buffer(WGPUBufferUsage_Vertex, 48));
    ops.set_quad_vertex_buffer(quad); ops.set_instance_vertex_buffer(first);
    ops.set_pipeline(pipeline); ops.set_bind_group(captured); ops.draw(6, 3, 0, 7);
    assert((draws == std::vector<std::string>{"vertex0", "vertex1", "pipeline", "group", "draw"}));

    // Source disposal destroys the buffer even while a data-owned group retains it.
    auto* original = captured->styles.lease->get();
    first.destroy_styles(); first.destroy_styles();
    assert(original->destroyed == 1 && original->released == 0);
    ops.create_renderable_buffer(first, TextBufferKind::styles, 64);
    assert(captured->styles.lease != first_resources->styles.lease);
    auto replacement = std::static_pointer_cast<DawnTextGroup>(ops.create_bind_group(first, atlas, layout));
    assert(replacement->styles.bytes == 64 && captured->styles.bytes == 32);
    bool refused = false;
    try { captured->styles.lease->get(); } catch (const std::runtime_error&) { refused = true; }
    assert(refused);

    // The renderer ends while source GPU records and data groups are still alive.
    owner->retire();
    assert(owner->device == nullptr && owner->queue == nullptr);
    for (const auto& resource : resources) assert(resource->released == 1);
    first.destroy_uniform(); first.destroy_instances(); first.destroy_styles();
    atlas.destroy_curves(); atlas.destroy_bands(); atlas.destroy_metadata();
    owner->retire();
    for (const auto& resource : resources) assert(resource->released == 1 && resource->destroyed <= 1);
}
