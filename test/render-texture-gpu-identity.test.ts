import assert from "node:assert/strict";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    sceneBackendSource,
} from "./native-fixture.js";

test("a render texture's GPUTexture is a new object per reallocation the pin makes", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    // Each backend writes the ordinal of the allocation it made, as its
    // resize does: the first is the texture's own, a native rebuild of a
    // fixed target is none of the pin's, a surface resize and a new depth
    // extent replace the object, and a lost device replaces every one.
    runGeneratedProgram(
        tools,
        "render-texture-gpu-identity",
        `#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
int main() {
    using namespace bbl;
    Engine engine;
    RenderTargetRecord fixed;
    fixed.allocation = TargetAllocation::fixed;
    RenderTargetRecord surface;
    surface.allocation = TargetAllocation::surface;
    RenderTargetRecord graph;
    RenderTargetRecord depth_only;
    depth_only.allocation = TargetAllocation::fixed;
    depth_only.has_color = false;
    engine.render_targets = {fixed, surface, graph, depth_only};
    const auto texture = [&](std::uint32_t target) {
        RenderTextureRef reference;
        reference.target = RenderTargetHandle{target};
        return render_texture_gpu_texture(engine, reference);
    };
    const auto fixed_texture = texture(0);
    assert(fixed_texture.object != 0);
    engine.render_targets[0].attachment_allocation = 1;
    assert(texture(0) == fixed_texture);
    engine.render_targets[0].attachment_allocation = 9;
    assert(texture(0) == fixed_texture);

    const auto created = texture(1);
    engine.render_targets[1].attachment_allocation = 2;
    assert(texture(1) == created);
    engine.render_targets[1].attachment_allocation = 5;
    const auto resized = texture(1);
    assert(!(resized == created));
    assert(texture(1) == resized);

    engine.render_targets[2].color_view = true;
    engine.render_targets[2].color_texture = publish_gpu_texture_identity(engine);
    assert(texture(2) == engine.render_targets[2].color_texture);
    bool refused = false;
    try { texture(3); } catch (const std::runtime_error&) { refused = true; }
    assert(refused);

    engine.frame_tasks.resize(1);
    RenderTextureRef depth;
    depth.source = RenderTextureSource::transmission_depth;
    depth.task = TaskHandle{0};
    const auto grabbed = render_texture_gpu_texture(engine, depth);
    engine.frame_tasks[0].transmission_depth_allocation = 3;
    assert(render_texture_gpu_texture(engine, depth) == grabbed);
    engine.frame_tasks[0].transmission_depth_allocation = 4;
    const auto regrabbed = render_texture_gpu_texture(engine, depth);
    assert(!(regrabbed == grabbed));

    ++engine.device_generation;
    assert(!(texture(0) == fixed_texture));
    assert(!(texture(1) == resized));
    assert(!(render_texture_gpu_texture(engine, depth) == regrabbed));
    return 0;
}
`,
    );
});

test("both backends write the allocation a render texture's GPUTexture names", () => {
    // The ordinals are written where each backend (re)allocates: an eager
    // target's attachments and a transmission grab's depth snapshot.
    for (const backend of ["sdl", "dawn"] as const) {
        const source = sceneBackendSource(backend);
        assert.match(
            source,
            /target\.allocation = \+\+state\.render_target_allocations;\s*\/\/[^\n]*\n\s*engine\.render_targets\[index\]\.attachment_allocation = target\.allocation;/,
            backend,
        );
        assert.match(
            source,
            /record\.transmission_depth_allocation = depth \? \+\+state\.render_target_allocations : 0;/,
            backend,
        );
    }
});
