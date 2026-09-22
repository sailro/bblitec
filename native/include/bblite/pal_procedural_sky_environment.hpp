#pragma once

#include <bblite/pal_compute_texture_mipmaps.hpp>
#include <bblite/js_realm_state.hpp>
#include <bblite/upstream/procedural_sky_atmosphere.hpp>
#include <bblite/pal_procedural_sky.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/pal_packaged_fetch.hpp>
#include <bblite/js_promise_all.hpp>

namespace bbl {
struct ProceduralSkyGpu;
struct ProceduralSkyEnvironment {
    Scene scene;
    std::shared_ptr<Engine> engine;
    std::shared_ptr<ProceduralSkyGpu> gpu;
    std::vector<PreparedComputeMipmaps> mipmaps;
    std::vector<float> irradiance;
    std::uint64_t texture_identity = 0;
    bool disposed = false;
    double revision = 0;
    std::function<js::Promise<js::PromiseVoid>()> yield;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(scene); }
};

struct ProceduralSkyGeneration {
    std::shared_ptr<ProceduralSkyEnvironment> current;
    bool disposed = false;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(current); }
};
struct ProceduralSkyRegistry {
    js::WeakMap<std::shared_ptr<ProceduralSkyGeneration>> scenes;
};

/** ImageBitmap and texture facade storage, owned independently of publication. */
struct ProceduralSkyImage {
    TextureData encoded;
    pal::DecodedImage pixels;
    void close() {
        encoded.bytes = std::vector<std::uint8_t>{};
        pixels = {};
    }
};

/** The encoded LUT stays CPU-backed until the renderer creates its binding. */
struct ProceduralSkyBrdfAllocation final : pal::ComputeTextureAllocation {
    std::shared_ptr<TextureData> data;
    explicit ProceduralSkyBrdfAllocation(std::shared_ptr<TextureData> value)
        : data(std::move(value)) {}
    void destroy() override { data->bytes = std::vector<std::uint8_t>{}; }
};
inline std::shared_ptr<GpuTextureSource>
procedural_sky_texture_source(const std::shared_ptr<pal::OffscreenRun>& run,
                              std::shared_ptr<pal::ComputeTextureAllocation> allocation,
                              void (*acquire)(GpuTextureSource&),
                              bool (*release)(GpuTextureSource&)) {
    auto source = std::make_shared<GpuTextureSource>();
    source->run = run;
    source->allocation = std::move(allocation);
    source->acquire = acquire;
    source->release = release;
    return source;
}
struct ProceduralSkyTextureFacade {
    EnvironmentState value;
    std::vector<float> irradiance;
    std::uint64_t identity = next_scene_uniform_object_identity();
};
struct ProceduralSkyLoadState {
    Scene scene;
    std::shared_ptr<Engine> engine;
    std::shared_ptr<ProceduralSkyGeneration> generation;
    std::shared_ptr<ProceduralSkyImage> image;
    std::shared_ptr<TextureData> brdf;
    std::shared_ptr<ProceduralSkyGpu> gpu;
    std::shared_ptr<pal::ComputeTextureAllocation> texture;
    std::shared_ptr<pal::StorageBufferAllocation> parameter_buffer;
    std::shared_ptr<GpuTextureSource> texture_source, brdf_source;
    std::shared_ptr<GpuTextureLease> texture_lease, brdf_lease;
    bool texture_retained = false, brdf_retained = false;
    js::Callback<void()> close_image, assert_pending, dispose;
    js::Callback<bool()> is_pending;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(scene);
        visitor(generation);
        visitor(close_image);
        visitor(assert_pending);
        visitor(dispose);
        visitor(is_pending);
    }
};

inline std::shared_ptr<ProceduralSkyGeneration> procedural_sky_generation(const Scene& scene) {
    auto found = js::realm_scratch<ProceduralSkyRegistry>().scenes.get(scene.state);
    return found ? *found : nullptr;
}
inline std::shared_ptr<ProceduralSkyImage> procedural_sky_decode_image(js::ArrayBuffer bytes) {
    auto image = std::make_shared<ProceduralSkyImage>();
    image->pixels = pal::decode_image(bytes);
    image->encoded.bytes = bytes.bytes();
    return image;
}
inline std::shared_ptr<ProceduralSkyTextureFacade> procedural_sky_texture_facade(
    const std::shared_ptr<ProceduralSkyGpu>& gpu, const std::shared_ptr<TextureData>& brdf,
    const std::vector<float>& irradiance, double lod, const std::vector<float>& harmonics) {
    auto result = std::make_shared<ProceduralSkyTextureFacade>();
    result->irradiance = irradiance;
    auto& value = result->value;
    value.has_irradiance = true;
    value.specular_gpu = gpu->texture;
    value.specular_width = gpu->texture_descriptor.extent[0];
    value.specular_mip_count = gpu->texture_descriptor.mip_levels;
    value.specular_rgba16f = true;
    value.brdf_lut = *brdf;
    value.lod_generation_scale = static_cast<float>(lod);
    if (harmonics.size() != value.spherical_harmonics.size() * 4)
        throw std::runtime_error("Invalid procedural sky harmonic storage.");
    for (std::size_t index = 0; index < value.spherical_harmonics.size(); ++index)
        value.spherical_harmonics[index] = {harmonics[index * 4], harmonics[index * 4 + 1],
                                            harmonics[index * 4 + 2]};
    return result;
}

js::Promise<std::shared_ptr<ProceduralSkyEnvironment>>
load_procedural_sky_environment(Scene scene, ProceduralSkyOptions options, std::string brdf_path);
js::Promise<bool>
update_procedural_sky_environment(std::shared_ptr<ProceduralSkyEnvironment> environment,
                                  ProceduralSkyOptions options);
void submit_procedural_sky_cube(const std::shared_ptr<ProceduralSkyEnvironment>& environment,
                                const ProceduralSkyOptions& options);
bool procedural_sky_environment_active(
    const std::shared_ptr<ProceduralSkyEnvironment>& environment);
void assert_procedural_sky_environment_active(
    const std::shared_ptr<ProceduralSkyEnvironment>& environment);

namespace pal {
/** A queued realm task is the platform transport of scheduler.yield/MessageChannel. */
inline js::Promise<js::PromiseVoid> procedural_sky_yield() {
    js::Promise<js::PromiseVoid> result;
    EventLoop::current().set_timeout([result] { result.resolve(js::PromiseVoid{}); }, 0);
    return result;
}
} // namespace pal
} // namespace bbl
