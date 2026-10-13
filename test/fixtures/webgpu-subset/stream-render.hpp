#pragma once

// The pinned splat-stream renderable (splat-stream-material.ts) drawn through
// the scene renderers' external-renderable protocol (pal_external_renderables.hpp):
// bind per target signature, prepare (batch reset, update, flush recording the
// projection and sort into the frame encoder), then the draw in the pass.

#include "stream-checks.hpp"

#include "pal_external_renderables.hpp"

#include <bblite/gpu_renderable.hpp>

#include <functional>

namespace stream_check {

/** getPipeline(engine, signature): the render pipeline and its group-1 layout. */
struct RenderEntry {
    GpuHandle pipeline, layout;
};
inline RenderEntry render_pipeline(bbl::GpuDevice& device, const GpuHandle& module,
                                   const GpuHandle& scene_layout,
                                   const bbl::GpuRenderTargetSignature& signature) {
    RenderEntry entry;
    entry.layout = layout(device, {buffer_entry(0, SS::VERTEX, "read-only-storage"),
                                   buffer_entry(1, SS::VERTEX, "read-only-storage")});
    bbl::GpuPipelineLayoutDescriptor pipeline_layout;
    pipeline_layout.bind_group_layouts.push_back(scene_layout);
    pipeline_layout.bind_group_layouts.push_back(entry.layout);
    bbl::GpuRenderPipelineDescriptor descriptor;
    descriptor.layout = device.create_pipeline_layout(pipeline_layout);
    descriptor.vertex = {module, std::string("vs")};
    bbl::GpuFragmentState fragment;
    fragment.module = module;
    fragment.entry_point = std::string("fs");
    bbl::GpuColorTargetState target;
    target.format = signature.color_format;
    target.blend = bbl::GpuBlendState{
        {std::string("add"), std::string("src-alpha"), std::string("one-minus-src-alpha")},
        {std::string("add"), std::string("one"), std::string("one-minus-src-alpha")}};
    target.write_mask = 0xF;
    fragment.targets.push_back(target);
    descriptor.fragment = fragment;
    descriptor.primitive =
        bbl::GpuPrimitiveState{std::string("triangle-list"), std::string("none")};
    if (signature.depth_stencil_format)
        descriptor.depth_stencil = bbl::GpuDepthStencilState{
            *signature.depth_stencil_format, false,
            signature.depth_compare.value_or(std::string("greater-equal"))};
    descriptor.multisample = bbl::GpuMultisampleState{signature.sample_count};
    entry.pipeline = device.create_render_pipeline(descriptor);
    return entry;
}

/** createSplatStreamDrawBatch: pending projection, recorded at flush when its key moved. */
struct StreamBatch final : bbl::GpuDrawUpdateBatch {
    bbl::Engine& engine;
    bbl::GpuDevice& device;
    const Pipelines& pipelines;
    GpuHandle canonical;
    PassGpu pass;
    std::optional<Projection> pending;
    std::string last_key;
    bool retired_ = false, destroyed = false;
    int recorded = 0;
    StreamBatch(bbl::Engine& owner, bbl::GpuDevice& gpu, const Pipelines& shared, GpuHandle records,
                double capacity)
        : engine(owner), device(gpu), pipelines(shared), canonical(std::move(records)),
          pass(create_pass_gpu(gpu, capacity)) {}
    bool retired() const override { return retired_; }
    void mark_retired() override { retired_ = true; }
    void reset() override { pending.reset(); }
    void flush() override {
        if (!pending || retired_)
            return;
        std::string key = std::to_string(pending->width) + "/" + std::to_string(pending->height);
        for (int i = 0; i < 16; ++i)
            key += "/" + std::to_string(pending->worldView[i]) + "/" +
                   std::to_string(pending->projection[i]);
        if (key == last_key)
            return;
        require(engine.current_encoder != nullptr, "flush records into the frame encoder");
        record_projection(device, pipelines, canonical, pass, *pending, *engine.current_encoder);
        record_compact_and_sort(device, pipelines, pass, pending->count, *engine.current_encoder);
        last_key = std::move(key);
        ++recorded;
    }
    void destroy() override { destroyed = true; }
};

/** The binding `bind` returns: update queues the pass's projection, draw is indirect. */
struct StreamBinding final : bbl::GpuDrawBinding {
    RenderEntry entry;
    std::shared_ptr<StreamBatch> batch;
    bbl::GpuDevice& device;
    Projection base;
    GpuHandle group;
    StreamBinding(RenderEntry value, std::shared_ptr<StreamBatch> stream, bbl::GpuDevice& gpu,
                  Projection projection)
        : entry(std::move(value)), batch(std::move(stream)), device(gpu),
          base(std::move(projection)) {}
    GpuHandle pipeline() const override { return entry.pipeline; }
    void update(const bbl::GpuDrawUpdateContext& context) override {
        auto projection = base;
        projection.width = context.target_width;
        projection.height = context.target_height;
        batch->pending = projection;
    }
    double draw(const bbl::GpuEncoderHandle& pass) override {
        if (!group)
            group = stream_check::group(
                device, entry.layout,
                {buffer_binding(0, batch->pass.projected), buffer_binding(1, batch->pass.sorted)});
        pass->set_bind_group(1, group);
        pass->draw_indirect(batch->pass.indirect, 0);
        return 1;
    }
    std::vector<bbl::GpuDrawUpdateBatchHandle> update_batches() const override { return {batch}; }
};

/** buildSplatStreamGpuRenderable: order 200, transparent. */
struct StreamRenderable final : bbl::GpuExternalRenderable {
    bbl::Engine& engine;
    bbl::GpuDevice& device;
    const Pipelines& pipelines;
    GpuHandle module, canonical;
    double capacity;
    Projection projection;
    std::vector<std::shared_ptr<StreamBinding>> bindings;
    StreamRenderable(bbl::Engine& owner, bbl::GpuDevice& gpu, const Pipelines& shared,
                     GpuHandle render_module, GpuHandle records, double count, Projection base)
        : engine(owner), device(gpu), pipelines(shared), module(std::move(render_module)),
          canonical(std::move(records)), capacity(count), projection(std::move(base)) {}
    /** `getSceneBindGroupLayout(engine)`: the target's group-0 layout. */
    GpuHandle scene_layout;
    double order() const override { return 200; }
    bool transparent() const override { return true; }
    std::optional<std::array<double, 3>> world_center() const override { return std::nullopt; }
    bbl::GpuDrawBindingHandle bind(const bbl::GpuRenderTargetSignature& signature) override {
        auto binding = std::make_shared<StreamBinding>(
            render_pipeline(device, module, scene_layout, signature),
            std::make_shared<StreamBatch>(engine, device, pipelines, canonical, capacity), device,
            projection);
        bindings.push_back(binding);
        return binding;
    }
};

/** A backend's offscreen scene pass: its signature, group 0, and one frame. */
struct RenderTarget {
    bbl::GpuRenderTargetSignature signature;
    GpuHandle scene_layout, scene_group;
    std::uint32_t width = 0, height = 0;
    virtual ~RenderTarget() = default;
    /** (Re)creates the attachments at `samples` and sets the signature's sample count. */
    virtual void configure(std::uint32_t samples) = 0;
    /** Records `prepare` into the frame encoder, then `draw` inside the pass; returns RGBA8 rows. */
    virtual std::vector<std::uint8_t>
    frame(const std::function<void(const bbl::GpuCommandEncoderHandle&)>& prepare,
          const std::function<void(const bbl::GpuEncoderHandle&)>& draw) = 0;
};

/** Two frames of projected, sorted splats through the protocol: the second reuses the sort. */
inline void check_render(bbl::GpuDevice& device, const Pipelines& p, const Shaders& shaders,
                         RenderTarget& target) {
    constexpr double count = 40;
    const auto splats = test_splats(static_cast<std::size_t>(count), 0x5eed1234u);
    const auto canonical =
        buffer(device, count * RECORD_BYTES, BU::STORAGE | BU::COPY_SRC | BU::COPY_DST, false,
               "splat stream canonical");
    device.write_buffer(canonical, 0, canonical_bytes(splats, count));
    bbl::Engine engine;
    auto scene = bbl::Scene::from_state(std::make_shared<bbl::SceneState>());
    const auto module =
        device.create_shader_module({std::string("splat stream render"), shaders.render});
    auto renderable = std::make_shared<StreamRenderable>(engine, device, p, module, canonical,
                                                         count, test_projection(count));
    renderable->scene_layout = target.scene_layout;
    scene.state->external_renderables.push_back(renderable);
    scene.state->renderable_version = 1;
    bbl::pal::ExternalRenderablePass pass;
    target.configure(1);
    pass.follow(engine, scene, target.signature);
    require(!pass.empty() && renderable->bindings.size() == 1, "one binding per signature");
    const bbl::GpuDrawUpdateContext context{static_cast<double>(target.width),
                                            static_cast<double>(target.height), std::nullopt};
    const auto frame = [&] {
        return target.frame(
            [&](const bbl::GpuCommandEncoderHandle& encoder) {
                pass.prepare(engine, context, encoder);
                require(engine.current_encoder == nullptr,
                        "the frame encoder is current while flushing only");
            },
            [&](const bbl::GpuEncoderHandle& render) {
                require(pass.size() == 1 && pass.draw(render, target.scene_group, 0) == 1,
                        "one draw");
            });
    };
    std::vector<std::uint8_t> images[2];
    for (auto& image : images)
        image = frame();
    const auto& batch = *renderable->bindings[0]->batch;
    require(batch.recorded == 1, "an unchanged projection key records once");
    require(images[0] == images[1], "the second frame draws the retained sort");
    // An unchanged version and signature keep the binding.
    pass.follow(engine, scene, target.signature);
    require(renderable->bindings.size() == 1, "an unchanged pass keeps its binding");
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
    // binding it replaces retires its batch behind the GPU.
    target.configure(4);
    pass.follow(engine, scene, target.signature);
    require(renderable->bindings.size() == 2, "a new signature rebinds");
    require(batch.retired_ && batch.destroyed, "a dropped batch retires and is destroyed");
    const auto multisampled = frame();
    const auto& replacement = *renderable->bindings[1]->batch;
    require(replacement.recorded == 1, "the new binding records its own projection");
    const auto covered4 = coverage(multisampled);
    require(covered4 > 50, "multisampled splats cover the target");
    pass.release(engine);
    require(replacement.retired_ && replacement.destroyed,
            "a released batch retires and is destroyed");
    const auto print = [](const char* name, const std::vector<std::uint8_t>& image) {
        std::vector<std::uint32_t> words(image.size() / 4);
        std::memcpy(words.data(), image.data(), image.size());
        std::printf("%s %s\n", name, hex_words(words).c_str());
    };
    std::printf("render covered=%zu covered4=%zu\n", covered, covered4);
    print("image", images[0]);
    print("image4", multisampled);
}

} // namespace stream_check
