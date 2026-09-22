#pragma once

#include <bblite/pal_async_engine.hpp>
#include <bblite/js_data.hpp>
#include <unordered_set>

namespace bbl {

struct ComputeStorageTexture;
struct ComputeTextureResource {
    FileTexture texture;
    std::weak_ptr<Engine> engine;
    std::shared_ptr<pal::ComputeTextureAllocation> handle;
    std::string sample_type;
    std::string view_dimension;
    bool multisampled = false;
    bool destroyed = false;
};
struct ComputeSamplerResource {
    std::weak_ptr<Engine> engine;
    std::shared_ptr<pal::OffscreenRun> run;
    std::shared_ptr<pal::ComputeTextureAllocation> allocation;
    std::string type;
};
struct ComputeStorageTextureRegistry {
    std::weak_ptr<Engine> engine;
    std::unordered_set<std::shared_ptr<ComputeStorageTexture>> resources;
};
struct ComputeStorageTextureOptions {
    double width = 0;
    std::optional<double> height;
    std::optional<double> depth;
    bool mip_maps = false;
    bool invert_y = true;
    std::optional<bool> sampled;
    bool access_supplied = false;
    pal::ComputeTextureDescriptor descriptor;
};
struct ComputeStorageTexture {
    std::weak_ptr<ComputeStorageTextureRegistry> registry;
    // Leases the device until every facade and pending GPU validation is gone.
    std::shared_ptr<pal::OffscreenRun> run;
    std::shared_ptr<pal::ComputeTextureAllocation> allocation;
    pal::ComputeTextureDescriptor descriptor;
    bool invert_y = true;
    bool destroyed = false;
    std::optional<FileTexture> sampled_texture;
    std::shared_ptr<ComputeTextureResource> compute_texture;
    std::shared_ptr<ComputeSamplerResource> compute_sampler;
};

void validate_compute_texture_resource(const std::shared_ptr<ComputeTextureResource>& resource);
bool is_compute_texture_sample_type_compatible(const std::string& actual,
                                               const std::string& declared);
void invalidate_compute_texture_resource(const std::shared_ptr<ComputeTextureResource>& resource);

js::Promise<std::shared_ptr<ComputeStorageTexture>>
create_compute_storage_texture(std::shared_ptr<Engine> engine,
                               ComputeStorageTextureOptions options);
void dispose_compute_storage_texture(const std::shared_ptr<ComputeStorageTexture>& resource);
void dispose_compute_storage_textures(
    const std::shared_ptr<ComputeStorageTextureRegistry>& registry);
inline double
compute_storage_texture_width(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->descriptor.extent[0];
}
inline double
compute_storage_texture_height(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->descriptor.extent[1];
}
inline double
compute_storage_texture_depthOrArrayLayers(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->descriptor.extent[2];
}
inline bool
compute_storage_texture_destroyed(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->destroyed;
}
inline FileTexture
compute_storage_texture_sampled_texture(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->sampled_texture.value_or(FileTexture{});
}
inline std::shared_ptr<ComputeTextureResource>
compute_storage_texture_compute_texture(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->compute_texture;
}
inline std::shared_ptr<ComputeSamplerResource>
compute_storage_texture_compute_sampler(const std::shared_ptr<ComputeStorageTexture>& resource) {
    return resource->compute_sampler;
}

namespace pal {
inline std::uint16_t compute_sampler_anisotropy(double value) {
    if (!std::isfinite(value) || std::floor(value) != value || value < 1 || value > 16)
        throw std::runtime_error("Compute sampler anisotropy must be an integer in [1,16].");
    return static_cast<std::uint16_t>(value);
}

inline js::Promise<ComputeTextureCreation>
allocate_compute_texture(const std::shared_ptr<OffscreenRun>& run,
                         const ComputeTextureDescriptor& descriptor) {
    struct Completion final : CompletionEvent {
        std::shared_ptr<OffscreenRun> run;
        std::shared_ptr<ComputeTextureAllocation> allocation;
        std::exception_ptr error;
        Completion(std::uint64_t id, std::shared_ptr<OffscreenRun> owner,
                   std::shared_ptr<ComputeTextureAllocation> image, std::exception_ptr failure)
            : CompletionEvent(id), run(std::move(owner)), allocation(std::move(image)),
              error(failure) {}
    };
    js::Promise<ComputeTextureCreation> result;
    auto& loop = EventLoop::current();
    const auto id = loop.register_completion([result, run](std::unique_ptr<ExternalEvent> event) {
        auto* completion = dynamic_cast<Completion*>(event.get());
        if (!completion)
            throw std::logic_error("Incorrect compute texture completion payload.");
        ComputeTextureCreation creation{std::move(completion->allocation), completion->error, {}};
        if (creation.creation_error) {
            try {
                std::rethrow_exception(creation.creation_error);
            } catch (const ComputeTextureValidationError& error) {
                creation.validation_error = error.what();
                creation.creation_error = {};
            } catch (...) {
            }
        }
        result.resolve(std::move(creation));
    });
    try {
        if (!run)
            throw InvalidCanvasState("Engine has no GPU device.");
        run->device().create_compute_texture(
            descriptor,
            [inbox = loop.inbox(), id, run](std::shared_ptr<ComputeTextureAllocation> image,
                                            std::exception_ptr error) {
                inbox->post(
                    std::make_unique<Completion>(id, run, std::move(image), std::move(error)));
            });
    } catch (...) {
        loop.cancel_completion(id);
        result.resolve({nullptr, std::current_exception(), {}});
    }
    return result;
}

// Texture-pool storage representation. The generated disposer chooses the count.
inline void release_compute_texture_owner(const std::shared_ptr<ComputeStorageTexture>& resource) {
    auto& image = *resource->sampled_texture->data.gpu_source;
    image.release(image);
}
inline void
remove_compute_registry(const std::shared_ptr<ComputeStorageTextureRegistry>& registry) {
    if (auto engine = registry->engine.lock()) {
        engine->compute_storage_textures.reset();
        std::erase(engine->native_resource_owners, registry);
    }
}

} // namespace pal
} // namespace bbl
