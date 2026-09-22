#include <cassert>
#include <bblite/js_realm_state.hpp>
struct Image final : bbl::pal::ComputeTextureAllocation {
    void destroy() override {}
};
struct Pipeline final : bbl::pal::ComputeMipmapPipeline {};
struct Level final : bbl::pal::ComputeMipmapLevel {
    std::vector<std::uint32_t>* executed;
    std::uint32_t mip;
    void submit(std::uint32_t vertices) override {
        assert(vertices == 3);
        executed->push_back(mip);
    }
};
struct Device final : bbl::pal::OffscreenDevice {
    std::vector<std::uint32_t> executed;
    std::vector<std::array<std::uint32_t, 3>> prepared;
    bbl::pal::ComputeTextureCapabilities compute_texture_capabilities() const override {
        return {};
    }
    std::shared_ptr<bbl::pal::ComputeMipmapPipeline>
    prepare_compute_mipmap_pipeline(const std::string& format, const std::string& code) override {
        assert(format == "rgba8unorm" && code.find("textureSample") != std::string::npos);
        return std::make_shared<Pipeline>();
    }
    std::shared_ptr<bbl::pal::ComputeMipmapLevel>
    prepare_compute_mipmap_level(const std::shared_ptr<bbl::pal::ComputeMipmapPipeline>&,
                                 const std::shared_ptr<bbl::pal::ComputeTextureAllocation>&,
                                 const bbl::pal::ComputeTextureDescriptor&, std::uint32_t source,
                                 std::uint32_t target, std::uint32_t face) override {
        prepared.push_back({source, target, face});
        auto result = std::make_shared<Level>();
        result->executed = &executed;
        result->mip = target;
        return result;
    }
};
template <class F> void rejects(F callback, const std::string& message) {
    bool rejected = false;
    try {
        callback();
    } catch (const std::exception& error) {
        rejected = error.what() == message;
    }
    assert(rejected);
}
int main() {
    bbl::js::RealmScope realm;
    auto engine = std::make_shared<bbl::Engine>();
    auto device = std::make_shared<Device>();
    engine->offscreen_run = std::make_shared<bbl::pal::OffscreenRun>(
        std::make_shared<bbl::pal::OffscreenSurface>(1, 1), device);
    auto registry = std::make_shared<bbl::ComputeStorageTextureRegistry>();
    registry->engine = engine;
    auto texture = std::make_shared<bbl::ComputeStorageTexture>();
    texture->registry = registry;
    texture->allocation = std::make_shared<Image>();
    texture->descriptor.mip_levels = 4;
    texture->descriptor.format = "rgba8unorm";
    texture->sampled_texture.emplace();
    texture->compute_texture = std::make_shared<bbl::ComputeTextureResource>();
    rejects([] { bbl::create_compute_storage_texture_mipmaps_task("empty", {}); }, "#771");
    texture->destroyed = true;
    rejects([&] { bbl::create_compute_storage_texture_mipmaps_task("destroyed", {texture}); },
            "#772");
    texture->destroyed = false;
    texture->compute_texture.reset();
    rejects([&] { bbl::create_compute_storage_texture_mipmaps_task("missing facade", {texture}); },
            "#772");
    texture->compute_texture = std::make_shared<bbl::ComputeTextureResource>();
    std::vector resources{texture};
    auto task = bbl::create_compute_storage_texture_mipmaps_task("mipmaps", resources);
    resources.clear();
    assert(device->prepared.size() == 3);
    for (std::uint32_t i = 0; i < 3; ++i)
        assert((device->prepared[i] == std::array<std::uint32_t, 3>{i, i + 1, 0}));
    task->record();
    auto run = [&] {
        engine->current_compute_encoder = std::make_shared<bbl::pal::ComputeCommandEncoder>(device);
        const auto count = bbl::execute_compute_frame_tasks({task});
        engine->current_compute_encoder->finish();
        engine->current_compute_encoder->submit();
        return count;
    };
    assert(run() == 3 && (device->executed == std::vector<std::uint32_t>{1, 2, 3}));
    assert(run() == 3 && device->prepared.size() == 3 && device->executed.size() == 6);
    task->execution_enabled = false;
    assert(run() == 0 && device->executed.size() == 6);
    task->execution_enabled = true;
    texture->destroyed = true;
    rejects(run, "#773");
    texture->destroyed = false;
    task->dispose();
    assert(run() == 3 && device->executed.size() == 6 && !texture->destroyed);
    const auto face =
        bbl::prepare_compute_mipmaps(engine, texture->allocation, texture->descriptor, 5);
    assert(face.size() == 3 && device->prepared.back()[2] == 5);
}
