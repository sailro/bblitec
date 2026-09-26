#include "pal_sdl_gpu_text_resources.hpp"
#include <cassert>

using namespace bbl;
using namespace bbl::pal;

// The WebGPU half of the SDL text device, without its pipeline cache.
struct Device final : SdlTextGpuResources {
    using SdlTextGpuResources::SdlTextGpuResources;
};

int main() {
    // Uniform buffers are the SDL CPU/push transport; no native device is needed.
    auto device = std::make_shared<Device>(nullptr, false);
    const auto uniform = [](Device& owner) {
        return owner.create_buffer(GpuBufferDescriptor{std::string("text-renderable-ubo"), 96,
                                                       text_buffer_usage_uniform | 0x08});
    };
    auto layout = std::make_shared<SdlTextGpuLayout>();
    layout->bindings = {{0u, TextBindingRole::uniform}};
    const auto group_of = [&](const GpuHandle& buffer) {
        GpuBindGroupDescriptor descriptor;
        descriptor.layout = layout;
        descriptor.entries = {GpuBindGroupEntry{0, GpuBufferBinding{buffer, {}, {}}}};
        return sdl_text_object<SdlTextGpuGroup>(device->create_bind_group(descriptor));
    };
    const auto write = [](Device& owner, const GpuHandle& buffer, double offset,
                          const std::array<std::uint8_t, 4>& bytes) {
        owner.write_buffer(buffer, offset,
                           js::ArrayBuffer(std::vector<std::uint8_t>(bytes.begin(), bytes.end())),
                           0, 4);
    };
    auto first = uniform(*device), second = uniform(*device);
    auto group = group_of(first);
    const std::array<std::uint8_t, 4> front{11, 12, 13, 14}, rear{21, 22, 23, 24};
    write(*device, first, 80, front);
    write(*device, second, 80, rear);
    assert(group->uniform->bytes[80] == 11 && group->uniform->bytes[84] == 0);
    // The source destroys the renderable's buffer while its group still holds it.
    const auto old = group->uniform;
    first->destroy();
    first = uniform(*device);
    write(*device, first, 80, rear);
    assert(group->uniform == old && group->uniform->bytes[80] == 11);
    bool destroyed = false;
    try {
        group->uniform->check();
    } catch (const std::runtime_error&) {
        destroyed = true;
    }
    assert(destroyed);
    auto replacement = group_of(first);
    assert(replacement->uniform != old && replacement->uniform->bytes[80] == 21);
    bool range = false;
    try {
        write(*device, first, 94, front);
    } catch (const std::runtime_error&) {
        range = true;
    }
    assert(range && replacement->uniform->bytes[94] == 0);
    device->owner->retire();
    assert(replacement->uniform->destroyed && group->uniform->destroyed);
    assert(device->owner->resources.tracked_resource_count() == 0);

    auto captured = std::make_shared<Device>(nullptr, true);
    const auto buffer = uniform(*captured);
    write(*captured, buffer, 80, front);
    const auto& receipt = captured->owner->capture.resources().at(0);
    assert(receipt.role == "uniform-shadow");
    assert(receipt.written_ranges.at(0).offset == 80 && receipt.written_ranges.at(0).bytes == 4);
    assert(receipt.uploaded_bytes.at(80) == 11);
    captured->owner->retire();
}
