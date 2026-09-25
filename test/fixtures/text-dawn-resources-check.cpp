#include "pal_dawn_text_resources.hpp"
#include <cassert>
#include <cstring>
#include <string>

// This API recorder executes the production resource adapter without a GPU.
struct Resource {
    unsigned destroyed = 0, released = 0;
    virtual ~Resource() = default;
};
struct WGPUBufferImpl : Resource {
    std::vector<std::uint8_t> bytes;
    WGPUBufferUsage usage = 0;
};
struct WGPUTextureImpl : Resource {
    WGPUTextureDescriptor descriptor{};
    std::vector<std::uint8_t> bytes;
};
struct WGPUTextureViewImpl : Resource {
    WGPUTexture texture = nullptr;
};
struct WGPUBindGroupImpl : Resource {
    std::vector<WGPUBindGroupEntry> entries;
};
struct WGPUBindGroupLayoutImpl : Resource {};
struct WGPURenderPipelineImpl : Resource {};
static std::vector<std::unique_ptr<Resource>> resources;
static std::vector<std::string> draws;
template <class R> R* make_resource() {
    auto value = std::make_unique<R>();
    auto* result = value.get();
    resources.push_back(std::move(value));
    return result;
}
extern "C" {
WGPUBuffer wgpuDeviceCreateBuffer(WGPUDevice, const WGPUBufferDescriptor* descriptor) {
    auto value = make_resource<WGPUBufferImpl>();
    value->bytes.resize(descriptor->size);
    value->usage = descriptor->usage;
    return value;
}
WGPUTexture wgpuDeviceCreateTexture(WGPUDevice, const WGPUTextureDescriptor* descriptor) {
    auto value = make_resource<WGPUTextureImpl>();
    value->descriptor = *descriptor;
    return value;
}
WGPUTextureView wgpuTextureCreateView(WGPUTexture texture, const WGPUTextureViewDescriptor*) {
    auto value = make_resource<WGPUTextureViewImpl>();
    value->texture = texture;
    return value;
}
WGPUBindGroup wgpuDeviceCreateBindGroup(WGPUDevice, const WGPUBindGroupDescriptor* descriptor) {
    auto value = make_resource<WGPUBindGroupImpl>();
    value->entries.assign(descriptor->entries, descriptor->entries + descriptor->entryCount);
    return value;
}
void wgpuBufferDestroy(WGPUBuffer value) { ++value->destroyed; }
void wgpuTextureDestroy(WGPUTexture value) { ++value->destroyed; }
void wgpuBufferRelease(WGPUBuffer value) { ++value->released; }
void wgpuTextureRelease(WGPUTexture value) { ++value->released; }
void wgpuTextureViewRelease(WGPUTextureView value) { ++value->released; }
void wgpuBindGroupRelease(WGPUBindGroup value) { ++value->released; }
void wgpuBindGroupLayoutRelease(WGPUBindGroupLayout value) { ++value->released; }
void wgpuRenderPipelineRelease(WGPURenderPipeline value) { ++value->released; }
void wgpuQueueWriteBuffer(WGPUQueue, WGPUBuffer value, std::uint64_t offset, const void* data,
                          std::size_t size) {
    assert(value->destroyed == 0 && value->released == 0 && offset + size <= value->bytes.size());
    std::memcpy(value->bytes.data() + offset, data, size);
}
void wgpuQueueWriteTexture(WGPUQueue, const WGPUTexelCopyTextureInfo* destination, const void* data,
                           std::size_t size, const WGPUTexelCopyBufferLayout* layout,
                           const WGPUExtent3D* extent) {
    assert(layout->bytesPerRow == extent->width * 16 && layout->rowsPerImage == extent->height);
    assert(destination->texture->destroyed == 0 && size == layout->bytesPerRow * extent->height);
    const auto bytes = static_cast<const std::uint8_t*>(data);
    destination->texture->bytes.assign(bytes, bytes + size);
}
void wgpuRenderPassEncoderSetVertexBuffer(WGPURenderPassEncoder, std::uint32_t slot, WGPUBuffer,
                                          std::uint64_t offset, std::uint64_t size) {
    assert(offset == 0 && size == WGPU_WHOLE_SIZE);
    draws.push_back("vertex" + std::to_string(slot));
}
void wgpuRenderPassEncoderSetPipeline(WGPURenderPassEncoder, WGPURenderPipeline) {
    draws.push_back("pipeline");
}
void wgpuRenderPassEncoderSetBindGroup(WGPURenderPassEncoder, std::uint32_t group, WGPUBindGroup,
                                       std::size_t count, const std::uint32_t*) {
    assert(group == 0 && count == 0);
    draws.push_back("group");
}
void wgpuRenderPassEncoderDraw(WGPURenderPassEncoder, std::uint32_t vertices,
                               std::uint32_t instances, std::uint32_t first_vertex,
                               std::uint32_t first_instance) {
    assert(vertices == 6 && instances == 3 && first_vertex == 0 && first_instance == 7);
    draws.push_back("draw");
}
void wgpuRenderPassEncoderEnd(WGPURenderPassEncoder) { draws.push_back("end"); }
void wgpuRenderPassEncoderRelease(WGPURenderPassEncoder) {}
WGPURenderPassEncoder wgpuCommandEncoderBeginRenderPass(WGPUCommandEncoder,
                                                        const WGPURenderPassDescriptor*) {
    return nullptr;
}
}

using namespace bbl;
using namespace bbl::pal;

// The WebGPU half of the Dawn text device, without its pipeline cache.
struct Device final : DawnTextGpuResources {
    using DawnTextGpuResources::DawnTextGpuResources;
    TextPipelineSet text_pipeline(const std::string&, double, const bbl::js::Nullable<std::string>&,
                                  bool, const std::shared_ptr<const void>&,
                                  const std::string&) override {
        throw std::logic_error("no pipelines");
    }
    TextPipelineDeviceCacheHandle text_pipeline_cache() override {
        throw std::logic_error("no pipelines");
    }
};

js::ArrayBuffer bytes_of(std::size_t size, std::uint8_t first = 0) {
    std::vector<std::uint8_t> bytes(size);
    for (std::size_t i = 0; i < size; ++i)
        bytes[i] = static_cast<std::uint8_t>(first + i);
    return js::ArrayBuffer(std::move(bytes));
}

int main() {
    auto device = std::make_shared<Device>(reinterpret_cast<WGPUDevice>(1),
                                           reinterpret_cast<WGPUQueue>(2), true);
    const auto owner = device->owner;
    const auto buffer = [&](const char* label, double size, std::uint32_t usage) {
        return device->create_buffer(
            TextBufferDescriptor{std::string(label), size, static_cast<double>(usage | 0x08u)});
    };
    struct Renderable {
        TextGpuHandle uniform, instances, styles;
    };
    Renderable first, second;
    for (auto* gpu : {&first, &second}) {
        gpu->uniform = buffer("text-renderable-ubo", 96, text_buffer_usage_uniform);
        gpu->instances = buffer("text-instance", 96, text_buffer_usage_vertex);
        gpu->styles = buffer("text-styles", 32, text_buffer_usage_storage);
    }
    const auto texture = [&](const char* label, double rows) {
        return device->create_texture(TextTextureDescriptor{
            std::string(label), "rgba32float", {4, rows, 1}, 0x04 | 0x02 | 0x01});
    };
    const auto curves = texture("text-slug-curves", 2), bands = texture("text-slug-bands", 1);
    const auto metadata = buffer("text-glyph-metadata", 64, text_buffer_usage_storage);
    auto layout = std::make_shared<DawnTextGpuLayout>();
    layout->layout = retain_dawn_text_resource<DawnTextLayoutLease>(
        owner, make_resource<WGPUBindGroupLayoutImpl>());
    layout->bindings = {{0, TextBindingRole::uniform},
                        {1, TextBindingRole::curves},
                        {2, TextBindingRole::bands},
                        {3, TextBindingRole::metadata},
                        {4, TextBindingRole::styles}};
    // The pin's bind group: its own entries, in its own order.
    const auto group_of = [&](const Renderable& gpu) {
        TextBindGroupDescriptor descriptor;
        descriptor.layout = layout;
        descriptor.entries = {
            TextBindGroupEntry{0, TextBufferBinding{gpu.uniform, {}, {}}},
            TextBindGroupEntry{1, curves->create_view()},
            TextBindGroupEntry{2, bands->create_view()},
            TextBindGroupEntry{3, TextBufferBinding{metadata, {}, {}}},
            TextBindGroupEntry{4, TextBufferBinding{gpu.styles, {}, {}}},
        };
        return dawn_text_object<DawnTextGpuGroup>(device->create_bind_group(descriptor));
    };
    const auto lease = [](const TextGpuHandle& handle) {
        return dawn_text_object<DawnTextGpuBuffer>(handle)->lease;
    };
    auto captured = group_of(first);
    assert(captured->group->get()->entries[0].buffer == lease(first.uniform)->get());
    assert(captured->group->get()->entries[0].buffer != lease(second.uniform)->get());
    assert(captured->group->get()->entries[3].size == WGPU_WHOLE_SIZE);
    const auto curve_texture = dawn_text_object<DawnTextGpuTexture>(curves)->lease->get();
    assert(curve_texture->descriptor.format == WGPUTextureFormat_RGBA32Float);
    assert(curve_texture->descriptor.usage & WGPUTextureUsage_CopySrc);
    assert(captured->group->get()->entries[1].textureView !=
           captured->group->get()->entries[2].textureView);
    device->write_buffer(first.uniform, 80, bytes_of(4, 1), 0, 4);
    assert(lease(first.uniform)->get()->bytes[80] == 1 &&
           lease(first.uniform)->get()->bytes[84] == 0);
    device->write_texture(TextTexelCopyTextureInfo{curves}, bytes_of(128), {0.0, 64.0, 2.0},
                          TextExtent3D{4, 2, 1});
    device->write_buffer(metadata, 0, bytes_of(4, 1), 0, 4);

    auto pipeline = std::make_shared<DawnTextGpuPipeline>();
    pipeline->pipeline = retain_dawn_text_resource<DawnTextPipelineLease>(
        owner, make_resource<WGPURenderPipelineImpl>(), "pipeline");
    pipeline->capture.samples = 4;
    const auto quad = buffer("text-instance", 48, text_buffer_usage_vertex);
    auto pass = std::make_shared<DawnTextPassEncoder>();
    pass->owner = owner;
    pass->set_vertex_buffer(0, quad);
    pass->set_vertex_buffer(1, first.instances);
    pass->set_pipeline(pipeline);
    pass->set_bind_group(0, captured);
    pass->draw(6, 3, 0, 7);
    assert((draws == std::vector<std::string>{"vertex0", "vertex1", "pipeline", "group", "draw"}));
    const auto& receipt = owner->capture.draws().at(0);
    assert(receipt.samples == 4 && receipt.pipeline == pipeline->pipeline->capture_id);
    assert(receipt.bindings.at(0).resource == lease(first.uniform)->capture_id);
    assert(receipt.bindings.at(1).view != 0 &&
           receipt.bindings.at(1).view != receipt.bindings.at(2).view);
    const auto& uniform_receipt =
        owner->capture.resources().at(lease(first.uniform)->capture_id - 1);
    assert(uniform_receipt.role == "uniform" && uniform_receipt.writes.size() == 1);
    assert(uniform_receipt.written_ranges.at(0).offset == 80 &&
           uniform_receipt.written_ranges.at(0).bytes == 4 &&
           uniform_receipt.uploaded_bytes.at(80) == 1);

    // Source disposal destroys the buffer even while a data-owned group retains it.
    auto* original = lease(first.styles)->get();
    first.styles->destroy();
    first.styles->destroy();
    assert(original->destroyed == 1 && original->released == 0);
    const auto retained_styles = lease(first.styles);
    first.styles = buffer("text-styles", 64, text_buffer_usage_storage);
    auto replacement = group_of(first);
    assert(replacement->group->get()->entries[4].buffer == lease(first.styles)->get());
    bool refused = false;
    try {
        retained_styles->get();
    } catch (const std::runtime_error&) {
        refused = true;
    }
    assert(refused);

    const auto retained_count = owner->resources.tracked_resource_count();
    for (unsigned i = 0; i < 200; ++i) {
        auto temporary = buffer("text-instance", 48, text_buffer_usage_vertex);
        assert(owner->resources.tracked_resource_count() == retained_count + 1);
    }

    // The renderer ends while source GPU records and data groups are still alive.
    owner->retire();
    assert(owner->device == nullptr && owner->queue == nullptr);
    for (const auto& resource : resources)
        assert(resource->released == 1);
    for (const auto& handle :
         {first.uniform, first.instances, first.styles, curves, bands, metadata})
        handle->destroy();
    owner->retire();
    for (const auto& resource : resources)
        assert(resource->released == 1 && resource->destroyed <= 1);
}
