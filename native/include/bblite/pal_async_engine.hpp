#pragma once

#include <bblite/js_promise.hpp>
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_canvas.hpp>
#include <bblite/pal_source_gpu.hpp>
#include <bblite/pal_native_job.hpp>
#include <bblite/pal_texture_texels.hpp>

namespace bbl {

/** A realm `loadTexture2D` still decoding: the pin's memoized promise for its key. */
struct FileTextureLoad {
    std::string key;
    js::Promise<StoredTexture> result;
};

} // namespace bbl

namespace bbl::pal {

// A DOM canvas can route Window input to its owning engine. OffscreenCanvas
// has no DOM event target; worker input must arrive through source messages.
void bind_canvas_engine(const std::shared_ptr<CanvasElement>& canvas,
                        const std::shared_ptr<Engine>& engine);
inline void bind_canvas_engine(const std::shared_ptr<OffscreenCanvas>&,
                               const std::shared_ptr<Engine>&) {}

/** Optional graphics ownership layered on the renderer-independent realm loop. */
template <typename Canvas>
std::shared_ptr<Engine> create_realm_engine(EngineOptions options,
                                            const std::shared_ptr<Canvas>& canvas) {
    if (!canvas)
        throw InvalidCanvasState("Cannot create an engine on a null canvas.");
    auto context = canvas->rendering_context();
    const auto extent = context->extent();
    options.width = extent.width;
    options.height = extent.height;
    auto engine = std::make_shared<Engine>(bbl::create_engine(std::move(options)));
    engine->realm_owner = engine;
    engine->offscreen_run = std::move(context);
    engine->source_gpu_device =
        std::shared_ptr<OffscreenDevice>(engine->offscreen_run, &engine->offscreen_run->device());
    bind_canvas_engine(canvas, engine);
    EventLoop::current().defer_cleanup([engine] {
        if (engine->dispose_storage_buffers)
            engine->dispose_storage_buffers(*engine);
        if (engine->dispose_compute_textures)
            engine->dispose_compute_textures();
        if (engine->dispose_gpu_retirements)
            engine->dispose_gpu_retirements();
        // Renderer activations have retired first. Drop source callbacks and
        // native resource owners before the last external engine reference.
        *engine = Engine{};
    });
    return engine;
}

js::Promise<js::PromiseVoid> start_realm_engine(std::shared_ptr<Engine> engine);

/**
 * `loadGltf` in a realm. A native job reads, parses and decodes the file
 * (`read_gltf`, `prepare_gltf`), which writes no engine record, while the
 * realm services its tasks; the realm then applies it to the retained
 * engine's records (`load_gltf`) as the load settles (`run_native_job`).
 */
template <bool Cameras = false>
js::Promise<AssetHandle> load_realm_gltf(Engine& engine, std::string path) {
    const auto owner = engine.realm_owner.lock();
    if (!owner)
        throw std::logic_error("An asynchronous asset load requires an owned engine.");
    // The file's own failure settles after the disposal check, which preceded the read.
    struct Read {
        std::shared_ptr<GltfSource> file;
        std::exception_ptr error;
    };
    return run_native_job<AssetHandle>(
        [path = std::move(path)] {
            try {
                auto file = read_gltf(path);
                prepare_gltf(*file);
                return Read{std::move(file), nullptr};
            } catch (...) {
                return Read{nullptr, std::current_exception()};
            }
        },
        [owner](Read read) {
            if (owner->device_disposed)
                throw std::runtime_error("Cannot load an asset into a disposed engine.");
            if (read.error)
                std::rethrow_exception(read.error);
            if constexpr (Cameras)
                return load_gltf(*owner, *read.file, true);
            else
                return load_gltf(*owner, *read.file);
        });
}

/**
 * `loadTexture2D` in a realm. The pin fetches and decodes before it settles,
 * so a native job reads and decodes the image (`decode_file_texture`) while
 * the realm services its tasks (`run_native_job`). As the pin memoizes by URL
 * and options, a finished or pending load of the same key returns its
 * texture or promise, and a failed one is forgotten.
 */
inline js::Promise<StoredTexture> load_realm_file_texture(Engine& engine, std::string path,
                                                          TextureSamplerState sampler,
                                                          bool invert_y, bool srgb,
                                                          bool premultiply_alpha) {
    const auto owner = engine.realm_owner.lock();
    if (!owner)
        throw std::logic_error("An asynchronous asset load requires an owned engine.");
    std::string key = file_texture_cache_key(path, sampler, invert_y, srgb, premultiply_alpha);
    if (const auto found = engine.file_texture_cache.find(key);
        found != engine.file_texture_cache.end())
        return js::Promise<StoredTexture>::resolved(StoredTexture{found->second});
    for (const auto& pending : engine.file_texture_loads)
        if (pending->key == key)
            return pending->result;
    // texture-2d.ts: `p.catch(() => map.delete(key))` forgets a failed load.
    const auto forget = [weak = std::weak_ptr<Engine>(owner), key] {
        if (const auto engine = weak.lock())
            std::erase_if(engine->file_texture_loads,
                          [&](const auto& pending) { return pending->key == key; });
    };
    auto load = std::make_shared<FileTextureLoad>();
    load->key = key;
    FileTexture texture = file_texture_record(engine, sampler, invert_y, srgb, premultiply_alpha);
    load->result = run_native_job<StoredTexture>(
        [path = std::move(path), texture = std::move(texture)]() mutable {
            return decode_file_texture(std::move(texture), read_binary_file(path));
        },
        [owner, key = std::move(key)](FileTexture texture) {
            return StoredTexture{cache_file_texture(*owner, key, std::move(texture))};
        });
    // Either outcome ends the pending load; a success is in the cache first.
    load->result.observe([forget](const StoredTexture&) { forget(); },
                         [forget](std::exception_ptr) { forget(); });
    engine.file_texture_loads.push_back(load);
    return load->result;
}

inline void resize_realm_surface(Engine& engine, std::uint32_t width, std::uint32_t height) {
    if (!engine.offscreen_run)
        throw InvalidCanvasState("Engine has no realm canvas.");
    engine.offscreen_run->resize(width, height);
    engine.options.width = static_cast<int>(width);
    engine.options.height = static_cast<int>(height);
    // GPU attachments are resized by the renderer when its next task starts.
}

} // namespace bbl::pal

namespace bbl {
void set_engine_size(Engine& engine, double width, double height);
}
