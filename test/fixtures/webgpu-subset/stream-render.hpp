#pragma once

// The pinned splat-stream renderable (splat-stream-material.ts
// buildSplatStreamGpuRenderable, in the lowered library) drawn through the
// scene renderers' external-renderable protocol (pal_external_renderables.hpp):
// bind per target signature, prepare (batch reset, the update's projection
// from the camera, the flush recording the gather, projection and sort into
// the frame encoder), then the draw in the pass.

#include "stream-checks.hpp"

#include "pal_external_renderables.hpp"

#include <functional>

namespace bbl::upstream {
// The scene camera's matrices (renderer_plan.cpp, which the fixture does not
// link): the fixture camera's own, test_projection's view and projection.
double effective_aspect_ratio(const CameraRecord&, double target_width, double target_height) {
    return target_width / target_height;
}
js::F32Array get_camera_view_matrix(const CameraRecord&) {
    return stream_check::floats(stream_check::test_projection(0).worldView.data(), 16);
}
js::F32Array get_camera_projection_matrix(const CameraRecord&, double) {
    return stream_check::floats(stream_check::test_projection(0).projection.data(), 16);
}
} // namespace bbl::upstream

namespace stream_check {

/** A backend's offscreen scene pass: its signature and one frame. */
struct RenderTarget {
    bbl::GpuRenderTargetSignature signature;
    std::uint32_t width = 0, height = 0;
    virtual ~RenderTarget() = default;
    /** (Re)creates the attachments at `samples` and sets the signature's sample count. */
    virtual void configure(std::uint32_t samples) = 0;
    /** Records `prepare` into the frame encoder, then `draw` inside the pass; returns RGBA8 rows. */
    virtual std::vector<std::uint8_t>
    frame(const std::function<void(const bbl::GpuCommandEncoderHandle&)>& prepare,
          const std::function<void(const bbl::GpuEncoderHandle&)>& draw) = 0;
};

/**
 * Two frames of the source's splats through the protocol, the second
 * reusing the sort, then a four-sampled signature's own binding.
 */
inline js::Promise<js::PromiseVoid> check_render(Library& library,
                                                 std::shared_ptr<bbl::SplatStreamSourceGpu> source,
                                                 RenderTarget& target) {
    auto& engine = library.engine;
    bbl::bind_engine_scene_group(engine);
    const auto state = bbl::create_splat_stream_gpu_state(library.stored(), 64, MAX_GPU_BYTES);
    bbl::set_splat_stream_gpu_intervals(state, source_intervals(source), 1);
    std::vector<std::shared_ptr<bbl::library::DrawBinding>> bindings;
    js::Nullable<js::Promise<bool>> nonempty;
    const std::array<float, 16> identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const auto renderable = bbl::build_splat_stream_gpu_renderable(
        state, [identity] { return bbl::pinned::NumberArrayLike(floats(identity.data(), 16)); }, {},
        [&nonempty](js::Nullable<js::Promise<bool>> signal) { nonempty = std::move(signal); });
    // Each binding the renderable's bind returns, as the scene pass holds it.
    const auto bind = renderable->bind_callback;
    renderable->bind_callback = [bind, &bindings](bbl::StoredEngine owner,
                                                  bbl::LibraryTargetSignature signature) {
        auto binding = bind(owner, signature);
        bindings.push_back(binding);
        return binding;
    };
    renderable->bound_engine = library.stored();
    auto scene = bbl::Scene::from_state(std::make_shared<bbl::SceneState>());
    scene.state->external_renderables.push_back(renderable);
    scene.state->renderable_version = 1;
    // The camera the pass draws with: a perspective one at the projection's near plane.
    bbl::CameraRecord camera;
    camera.kind = bbl::CameraKind::free;
    camera.fov = 0.8;
    camera.near_plane = 0.5;
    camera.far_plane = 200;
    engine.cameras.push_back(camera);
    const bbl::GpuDrawUpdateContext context{
        static_cast<double>(target.width), static_cast<double>(target.height),
        bbl::CameraHandle{static_cast<std::uint32_t>(engine.cameras.size() - 1)}};
    bbl::pal::ExternalRenderablePass pass;
    target.configure(1);
    pass.follow(engine, scene, target.signature);
    require(pass.size() == 1 && bindings.size() == 1, "one binding per signature");
    const auto frame = [&] {
        auto image = target.frame(
            [&](const bbl::GpuCommandEncoderHandle& encoder) {
                pass.prepare(engine, context, encoder);
                require(engine.current_encoder == nullptr,
                        "the frame encoder is current while flushing only");
            },
            [&](const bbl::GpuEncoderHandle& render) {
                require(pass.draw(render, engine, 0) == 1, "one draw");
            });
        run_retirements();
        return image;
    };
    const auto batch_of = [&](std::size_t index) {
        return std::static_pointer_cast<bbl::splat_stream::DrawBatch>(
            (*bindings.at(index)->update_batch_list)[0]);
    };
    std::vector<std::uint8_t> images[2];
    images[0] = frame();
    const auto first = batch_of(0);
    const auto key = first->pass_gpu->last_key;
    const auto group = first->pass_gpu->bind_group;
    require(!key.empty() && group, "the first frame records its projection and draws it");
    images[1] = frame();
    require(first->pass_gpu->last_key == key && first->pass_gpu->bind_group == group,
            "an unchanged projection key keeps its sort");
    require(images[0] == images[1], "the second frame draws the retained sort");
    require(nonempty.has_value(), "the first draw hands out the bootstrap signal");
    require(co_await *nonempty, "the bootstrap readback sees the drawn splats");
    // An unchanged version and signature keep the binding.
    pass.follow(engine, scene, target.signature);
    require(bindings.size() == 1, "an unchanged pass keeps its binding");
    const auto coverage = [](const std::vector<std::uint8_t>& image) {
        std::size_t covered = 0;
        for (std::size_t pixel = 0; pixel < image.size() / 4; ++pixel)
            if (image[pixel * 4 + 3] != 255 || image[pixel * 4] != 0)
                ++covered;
        return covered;
    };
    const auto covered = coverage(images[0]);
    require(covered > 50, "splats cover the target");
    // The engine's default four samples: a new signature, a new binding; the
    // batch it replaces retires behind the GPU.
    target.configure(4);
    pass.follow(engine, scene, target.signature);
    require(bindings.size() == 2, "a new signature rebinds");
    require(first->retired_flag, "a dropped batch retires");
    run_retirements();
    require(first->pass_gpu->destroyed, "a retired batch is destroyed behind the GPU");
    const auto multisampled = frame();
    const auto replacement = batch_of(1);
    require(!replacement->pass_gpu->last_key.empty(), "the new binding records its own projection");
    const auto covered4 = coverage(multisampled);
    require(covered4 > 50, "multisampled splats cover the target");
    pass.release(engine);
    run_retirements();
    require(replacement->retired_flag && replacement->pass_gpu->destroyed,
            "a released batch retires and is destroyed");
    bbl::retire_splat_stream_gpu_state(state);
    run_retirements();
    const auto print = [](const char* name, const std::vector<std::uint8_t>& image) {
        std::vector<std::uint32_t> words(image.size() / 4);
        std::memcpy(words.data(), image.data(), image.size());
        std::printf("%s %s\n", name, hex_words(words).c_str());
    };
    std::printf("render covered=%zu covered4=%zu\n", covered, covered4);
    print("image", images[0]);
    print("image4", multisampled);
    co_return js::PromiseVoid{};
}

} // namespace stream_check
