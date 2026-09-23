#include <cassert>
#include <bblite/js_realm_state.hpp>

namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    if (path == "missing")
        throw std::runtime_error("missing fixture LUT");
    return {static_cast<std::uint8_t>(path == "corrupt" ? 0 : 1)};
}
DecodedImage decode_image(const js::ArrayBuffer& bytes) {
    if (!bytes.byte_length() || bytes.data()[0] != 1)
        throw std::runtime_error("corrupt fixture LUT");
    return {1, 1, {128, 128, 128, 255}};
}
} // namespace bbl::pal
using namespace bbl;
using namespace bbl::pal;
struct Counters {
    int images = 0, buffers = 0, dispatches = 0;
    std::vector<std::array<std::uint32_t, 3>> mips;
    std::vector<std::uint32_t> commands;
};
struct Image final : ComputeTextureAllocation {
    Counters* counters;
    bool alive = true;
    explicit Image(Counters* value) : counters(value) { ++counters->images; }
    ~Image() override { destroy(); }
    void destroy() override {
        if (alive) {
            alive = false;
            --counters->images;
        }
    }
};
struct Buffer final : StorageBufferAllocation {
    Counters* counters;
    bool alive = true;
    std::vector<std::uint8_t> bytes;
    Buffer(Counters* value, std::size_t size) : counters(value), bytes(size) {
        ++counters->buffers;
    }
    ~Buffer() override { destroy(); }
    void destroy() override {
        if (alive) {
            alive = false;
            --counters->buffers;
        }
    }
    void write(std::size_t offset, std::span<const std::uint8_t> value) override {
        assert(alive && offset + value.size() <= bytes.size());
        std::copy(value.begin(), value.end(), bytes.begin() + static_cast<std::ptrdiff_t>(offset));
    }
};
struct GroupLayout final : ComputeGroupLayout {};
struct PipelineLayout final : ComputePipelineLayout {};
struct Module final : ComputeShaderModule {};
struct Pipeline final : ComputePipeline {};
struct Group final : ComputeBindGroup {};
struct MipmapPipeline final : ComputeMipmapPipeline {};
struct Mipmap final : ComputeMipmapLevel {
    Counters* counters;
    std::uint32_t value;
    void submit(std::uint32_t vertices) override {
        assert(vertices == 3);
        counters->commands.push_back(value);
    }
};
struct Device final : OffscreenDevice {
    Counters counters;
    bool fail_pipeline = false;
    std::function<void()> allocated;
    void create_compute_texture(const ComputeTextureDescriptor& descriptor,
                                ComputeTextureCreated done) override {
        assert((descriptor.extent == std::array<std::uint32_t, 3>{128, 128, 6}) &&
               descriptor.mip_levels == 8);
        assert(descriptor.storage_view_dimension == "2d-array" &&
               descriptor.sampled_view_dimension == "cube");
        done(std::make_shared<Image>(&counters), {});
        if (allocated)
            allocated();
    }
    std::shared_ptr<StorageBufferAllocation>
    create_storage_buffer(const StorageBufferDescriptor& descriptor,
                          std::optional<std::span<const std::uint8_t>>) override {
        assert(descriptor.byte_length == 32);
        return std::make_shared<Buffer>(&counters, descriptor.byte_length);
    }
    std::shared_ptr<ComputeGroupLayout>
    create_compute_group_layout(const ComputeGroupLayoutDescriptor& descriptor) override {
        assert(descriptor.entries.size() == 2);
        return std::make_shared<GroupLayout>();
    }
    std::shared_ptr<ComputePipelineLayout>
    create_compute_pipeline_layout(const ComputePipelineLayoutDescriptor&) override {
        return std::make_shared<PipelineLayout>();
    }
    std::shared_ptr<ComputeShaderModule>
    create_compute_shader_module(const ComputeShaderModuleDescriptor& descriptor,
                                 const std::string& artifact) override {
        assert(descriptor.source.find("texture_storage_2d_array") != std::string::npos &&
               artifact == "procedural-sky.comp");
        return std::make_shared<Module>();
    }
    std::shared_ptr<ComputePipeline>
    create_compute_pipeline(const ComputePipelineDescriptor&) override {
        if (fail_pipeline)
            throw std::runtime_error("pipeline fixture failure");
        return std::make_shared<Pipeline>();
    }
    std::shared_ptr<ComputeBindGroup>
    create_compute_bind_group(const ComputeBindGroupDescriptor& descriptor) override {
        assert(descriptor.entries.size() == 2);
        return std::make_shared<Group>();
    }
    void dispatch_compute(const bbl::pal::ComputeDispatch& dispatch) override {
        assert((dispatch.workgroups == std::array<std::uint32_t, 3>{16, 16, 6}));
        ++counters.dispatches;
        counters.commands.push_back(0);
    }
    std::shared_ptr<ComputeMipmapPipeline>
    prepare_compute_mipmap_pipeline(const std::string& format, const std::string&) override {
        assert(format == "rgba16float");
        return std::make_shared<MipmapPipeline>();
    }
    std::shared_ptr<ComputeMipmapLevel>
    prepare_compute_mipmap_level(const std::shared_ptr<ComputeMipmapPipeline>&,
                                 const std::shared_ptr<ComputeTextureAllocation>&,
                                 const ComputeTextureDescriptor&, std::uint32_t from,
                                 std::uint32_t to, std::uint32_t face) override {
        counters.mips.push_back({from, to, face});
        auto result = std::make_shared<Mipmap>();
        result->counters = &counters;
        result->value = 1 + face * 7 + from;
        return result;
    }
};
template <class F> void rejects(F callback, const std::string& text) {
    bool rejected = false;
    try {
        callback();
    } catch (const std::exception& error) {
        rejected = std::string(error.what()).find(text) != std::string::npos;
    }
    assert(rejected);
}
struct World {
    std::shared_ptr<Engine> engine = std::make_shared<Engine>();
    std::shared_ptr<Device> device = std::make_shared<Device>();
    Scene scene;
    World() {
        engine->realm_owner = engine;
        engine->offscreen_run =
            std::make_shared<OffscreenRun>(std::make_shared<OffscreenSurface>(1, 1), device);
        scene.engine = engine.get();
    }
    void dispose() {
        scene.disposed = true;
        for (const auto& callback : scene.disposables)
            callback();
        scene.disposables.clear();
    }
};
const ProceduralSkyOptions options{{0.2, 0.8, -0.3}, 1, 10, 2, 0.005, 0.8};
int main() {
    js::RealmScope realm;
    {
        World world;
        EventLoop loop;
        std::shared_ptr<ProceduralSkyEnvironment> environment;
        loop.run([&] {
            load_procedural_sky_environment(world.scene, options, "valid")
                .then([&](const auto& value) {
                    environment = value;
                    loop.close();
                });
        });
        assert(environment && procedural_sky_environment_active(environment));
        assert(world.scene.environment.specular_gpu == environment->gpu->texture);
        assert(world.device->counters.images == 1 && world.device->counters.buffers == 1 &&
               world.device->counters.dispatches == 1);
        assert(world.device->counters.mips.size() == 42 &&
               world.device->counters.commands.size() == 43);
        for (std::size_t i = 0; i < 43; ++i)
            assert(world.device->counters.commands[i] == i);
        const auto identity = world.scene.state->environment_identity;
        const auto image = environment->gpu->texture;
        const auto previous = environment->irradiance;
        EventLoop updates;
        std::optional<bool> first, second;
        auto next = options;
        next.sunDirection = {0.8, 0.3, 0.1};
        updates.run([&] {
            auto a = update_procedural_sky_environment(environment, options);
            auto b = update_procedural_sky_environment(environment, next);
            js::promise_all_tuple(std::tuple{a, b}).then([&](const auto& result) {
                first = std::get<0>(result);
                second = std::get<1>(result);
                updates.close();
            });
        });
        assert(first == false && second == true && environment->irradiance != previous);
        assert(world.scene.state->environment_identity == identity &&
               environment->gpu->texture == image && world.device->counters.dispatches == 2);
        environment->yield = [&] {
            world.dispose();
            return js::Promise<js::PromiseVoid>::resolved({});
        };
        EventLoop disposal;
        bool disposed_update = false;
        disposal.run([&] {
            update_procedural_sky_environment(environment, options)
                .then(
                    [&](bool) {
                        assert(false);
                        disposal.close();
                    },
                    [&](std::exception_ptr error) {
                        try {
                            std::rethrow_exception(error);
                        } catch (const std::exception& value) {
                            disposed_update = std::string(value.what()) == "#134";
                        }
                        disposal.close();
                    });
        });
        environment->yield = {};
        assert(disposed_update && environment->disposed &&
               !world.scene.state->environment_identity && !world.scene.environment.specular_gpu);
        assert(world.device->counters.images == 0 && world.device->counters.buffers == 0 &&
               !procedural_sky_generation(world.scene));
        rejects([&] { assert_procedural_sky_environment_active(environment); }, "#134");
    }
    for (const std::string path : {"corrupt", "missing"}) {
        World world;
        EventLoop loop;
        bool rejected = false;
        loop.run([&] {
            load_procedural_sky_environment(world.scene, options, path)
                .then(
                    [&](const auto&) {
                        assert(false);
                        loop.close();
                    },
                    [&](std::exception_ptr error) {
                        try {
                            std::rethrow_exception(error);
                        } catch (const std::exception& value) {
                            rejected = std::string(value.what()).find(path) != std::string::npos;
                        }
                        loop.close();
                    });
        });
        assert(rejected && world.scene.disposables.empty() &&
               !procedural_sky_generation(world.scene) && world.device->counters.images == 0);
    }
    {
        World world;
        world.device->fail_pipeline = true;
        EventLoop loop;
        bool failed = false;
        loop.run([&] {
            load_procedural_sky_environment(world.scene, options, "valid")
                .then(
                    [&](const auto&) {
                        assert(false);
                        loop.close();
                    },
                    [&](std::exception_ptr) {
                        failed = true;
                        loop.close();
                    });
        });
        assert(failed && world.scene.disposables.empty() &&
               !procedural_sky_generation(world.scene));
        assert(world.device->counters.images == 0 && world.device->counters.buffers == 0);
    }
    {
        World world;
        EventLoop loop;
        bool cancelled = false;
        world.device->allocated = [&] { world.dispose(); };
        loop.run([&] {
            load_procedural_sky_environment(world.scene, options, "valid")
                .then(
                    [&](const auto&) {
                        assert(false);
                        loop.close();
                    },
                    [&](std::exception_ptr error) {
                        try {
                            std::rethrow_exception(error);
                        } catch (const std::exception& value) {
                            cancelled = std::string(value.what()) == "#140";
                        }
                        loop.close();
                    });
        });
        world.device->allocated = {};
        assert(cancelled && world.scene.disposables.empty() &&
               !procedural_sky_generation(world.scene));
        assert(world.device->counters.images == 0 && world.device->counters.buffers == 0 &&
               world.device->counters.dispatches == 0);
    }
    {
        World world;
        EventLoop loop;
        bool duplicate = false, cancelled = false;
        loop.run([&] {
            load_procedural_sky_environment(world.scene, options, "valid")
                .then(
                    [&](const auto&) {
                        assert(false);
                        loop.close();
                    },
                    [&](std::exception_ptr error) {
                        try {
                            std::rethrow_exception(error);
                        } catch (const std::exception& value) {
                            cancelled = std::string(value.what()) == "#140";
                        }
                        loop.close();
                    });
            load_procedural_sky_environment(world.scene, options, "valid")
                .then([&](const auto&) { assert(false); },
                      [&](std::exception_ptr error) {
                          try {
                              std::rethrow_exception(error);
                          } catch (const std::exception& value) {
                              duplicate = std::string(value.what()) == "#139";
                          }
                      });
            loop.post([&] { world.dispose(); });
        });
        assert(duplicate && cancelled && !procedural_sky_generation(world.scene) &&
               world.device->counters.images == 0);
    }
}
