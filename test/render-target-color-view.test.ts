import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { EffectLowerer } from "../src/lowering/effect-lowerer.js";
import { pinnedEffectVariantsHeader } from "../src/pinned-effect-cpp.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * A `Texture2D` record over a render target's live `_colorView` (a `view`
 * getter read through a cast, a sampler, `_sampleType`), bound to an effect
 * and stored; and a mesh as a `WeakMap<object, ...>` key.
 */
const program = (
    texture: string,
    use = "setEffectTexture(copy, 1, texture);",
): string => `
import { addTask, createEffectRenderTask, createEffectWrapper, createEngine, createRenderTarget, createRenderTargetTexture, createSceneContext, getOrCreateSampler, registerScene, setEffectTexture, startEngine, type Texture2D } from "@babylonjs/lite";
interface RenderTargetInternals { _colorView: GPUTextureView | null; _depthView: GPUTextureView | null; _colorTexture: GPUTexture | null }
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
const source = createRenderTarget({ lbl: "source", format: "rgba8unorm", samples: 1, size: engine });
const other = createRenderTarget({ lbl: "other", format: "rgba8unorm", samples: 1, size: engine });
const multisampled = createRenderTarget({ lbl: "multisampled", format: "rgba8unorm", samples: 4, size: engine });
const output = createRenderTarget({ lbl: "output", format: "rgba8unorm", samples: 1, size: engine });
const fill = createEffectWrapper(engine, { name: "fill", fragmentWGSL: "@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(input.uv,0.0,1.0);}" });
addTask(scene, createEffectRenderTask({ name: "fill", effect: fill, target: source }, engine, scene));
const copy = createEffectWrapper(engine, { name: "copy", fragmentWGSL: "@group(0) @binding(0) var s:sampler;@group(0) @binding(1) var a:texture_2d<f32>;@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return textureSample(a,s,input.uv);}",
    bindings: [{ binding: 0, kind: "sampler", samplerType: "filtering", textureBinding: 1 }, { binding: 1, kind: "texture", textureSampleType: "float" }] });
const sampler = getOrCreateSampler(engine, { magFilter: "nearest", minFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
const internals = source as unknown as RenderTargetInternals;
const otherInternals = other as unknown as RenderTargetInternals;
const multisampledInternals = multisampled as unknown as RenderTargetInternals;
void otherInternals; void multisampledInternals;
const live = (rt: ReturnType<typeof createRenderTarget>, liveSampler: GPUSampler): Texture2D => {
    const target = rt as unknown as RenderTargetInternals;
    return { get view(): GPUTextureView { return target._colorView!; }, sampler: liveSampler, _sampleType: "float" } as unknown as Texture2D;
};
void live;
const texture = ${texture};
${use}
addTask(scene, createEffectRenderTask({ name: "copy", effect: copy, target: output }, engine, scene));
await registerScene(scene);
await startEngine(engine);
`;

const INLINE =
    '{ get view(): GPUTextureView { return internals._colorView!; }, sampler, _sampleType: "float" } as unknown as Texture2D';

test("a Texture2D record over a render target's colour view binds that target through its own sampler", () => {
    // A literal in place: its `_sampleType` is known at generation.
    assert.match(
        compileSource(program(INLINE)).cpp,
        /bbl::set_effect_texture\(v_engine, v_copy, bbl::EffectBindingKey\{static_cast<double>\(1\.0\)\}, bbl::render_target_color_view\(v_engine, v_internals, v_sampler\)\);/,
    );
    // Returned by a helper, as a factory hands it out: the escaping record
    // holds `_sampleType` as a run-time string the constructor checks.
    assert.match(
        compileSource(program("live(source, sampler)")).cpp,
        /bbl::set_effect_texture\(v_engine, v_copy, bbl::EffectBindingKey\{static_cast<double>\(1\.0\)\}, bbl::render_target_color_view\(v_engine, v_\w+, v_\w+, \(\*v_\w+_sampleType\w*\)\)\);/,
    );
    // A `texture` getter over the same target's colour texture is the same record.
    assert.match(
        compileSource(
            program(
                "{ get texture(): GPUTexture { return internals._colorTexture!; }, get view(): GPUTextureView { return internals._colorView!; }, sampler } as unknown as Texture2D",
            ),
        ).cpp,
        /bbl::render_target_color_view\(v_engine, v_internals, v_sampler\)/,
    );
});

test("a stored record over a render target's colour view keeps its own facade", () => {
    // A stored record's fields are run-time storage, `_sampleType` included.
    assert.match(
        compileSource(
            program(
                INLINE,
                "const textures: Texture2D[] = [texture]; setEffectTexture(copy, 1, textures[Math.floor(Math.random() * textures.length)]!);",
            ),
        ).cpp,
        /bbl::StoredTexture\{bbl::retained_render_texture\(v_engine, bbl::render_target_color_view\(v_engine, v_internals, v_sampler, \(\*v_\w+_sampleType\w*\)\)\)\}/,
    );
    // A conditional between two of them, or one and a render target's own
    // texture, selects the stored textures each arm converts to.
    const selected = compileSource(
        program(
            INLINE,
            "const pick = Math.random() > 0.5; const otherView = { get view(): GPUTextureView { return otherInternals._colorView!; }, sampler, _sampleType: 'float' } as unknown as Texture2D; const facade = createRenderTargetTexture(engine, { lbl: 'facade', format: 'rgba8unorm', samples: 1, size: { width: 4, height: 4 } }); const chosen = pick ? texture : otherView; const mixed = pick ? facade.texture : texture; setEffectTexture(copy, 1, chosen); setEffectTexture(copy, 1, mixed);",
        ),
    ).cpp;
    assert.match(
        selected,
        /v_chosen = \(v_pick \? bbl::StoredTexture\{bbl::retained_render_texture\(v_engine, bbl::render_target_color_view\(v_engine, v_internals, v_sampler[^;]*\)\)\} : bbl::StoredTexture\{bbl::retained_render_texture\(v_engine, bbl::render_target_color_view\(v_engine, v_otherInternals, v_sampler[^;]*\)\)\}\);/,
    );
    assert.match(
        selected,
        /v_mixed = \(v_pick \? bbl::StoredTexture\{bbl::retained_render_texture\(v_engine, v_facade\.texture\)\} : bbl::StoredTexture\{bbl::retained_render_texture\(v_engine, bbl::render_target_color_view\(v_engine, v_internals, v_sampler[^;]*\)\)\}\);/,
    );
    // Its sampler reads back off the stored texture, as mesh blending
    // copies an input's sampler to its output.
    assert.match(
        compileSource(
            program(
                INLINE,
                "const textures: Texture2D[] = [texture]; const stored = textures[Math.floor(Math.random() * textures.length)]!; const blended = createRenderTargetTexture(engine, { lbl: 'blended', format: 'rgba8unorm', samples: 1, size: { width: 4, height: 4 } }); blended.texture.sampler = stored.sampler; setEffectTexture(copy, 1, blended.texture);",
            ),
        ).cpp,
        /bbl::set_render_texture_sampler\(v_engine, v_blended\.texture, bbl::stored_texture_gpu_sampler\(v_engine, v_stored\)\);/,
    );
});

test("a Texture2D record over a colour view refuses what the pin's read would not give", () => {
    const refusals: readonly [string, RegExp][] = [
        [
            '{ get view(): GPUTextureView { return internals._colorView!; }, sampler, _sampleType: "float", width: 4 } as unknown as Texture2D',
            /states getters `view` \(its `_colorView`\) and optionally `texture` \(the same target's `_colorTexture`\), a `sampler` and at most `_sampleType: "float"`; this one states view, sampler, _sampleType, width\./,
        ],
        [
            "{ get texture(): GPUTexture { return otherInternals._colorTexture!; }, get view(): GPUTextureView { return internals._colorView!; }, sampler } as unknown as Texture2D",
            /this one states texture, view, sampler\./,
        ],
        [
            '{ get view(): GPUTextureView { return internals._colorView!; }, sampler, _sampleType: "depth" } as unknown as Texture2D',
            /A render target's colour view samples as float; this record states another `_sampleType`\./,
        ],
        [
            "{ get view(): GPUTextureView { return internals._colorView!; } } as unknown as Texture2D",
            /binds through its own GPU sampler\./,
        ],
        [
            "{ get view(): GPUTextureView { return multisampledInternals._colorView!; }, sampler } as unknown as Texture2D",
            /binds a render target's colour view only when the target has single-sample colour/,
        ],
        // A getter over another member is no colour view.
        [
            "{ get view(): GPUTextureView { return internals._depthView!; }, sampler } as unknown as Texture2D",
            /Expected texture, received record\./,
        ],
    ];
    for (const [texture, message] of refusals)
        assert.throws(() => compileSource(program(texture)), message);
});

test("a mesh keys a WeakMap of objects by its own identity", () => {
    const compiled = compileSource(`
import { addToScene, createBox, createEngine, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
const box = createBox(engine, { size: 1 });
addToScene(scene, box);
const ranges = new WeakMap<object, number>();
const rangeOf = (mesh: object): number => { const old = ranges.get(mesh); if (old !== undefined) return old; ranges.set(mesh, 4); return 4; };
console.log(rangeOf(box), rangeOf(box));
await registerScene(scene);
await startEngine(engine);
`);
    assert.match(compiled.cpp, /bbl::mesh_weak_identity\(v_engine, v_\w+\)/);
});

test("a colour-view record binds, stores and samples as the pin reads it, and a mesh key keeps its identity", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const variants = pinnedEffectVariantsHeader("fixture", [
        {
            family: "effect",
            name: "copy",
            fragment: "",
            bindings: [
                {
                    name: "",
                    binding: 0,
                    kind: "sampler",
                    uniformBytes: 0,
                    texture: 0,
                },
                {
                    name: "a",
                    binding: 1,
                    kind: "texture",
                    uniformBytes: 0,
                    texture: -1,
                },
            ],
        },
    ]);
    const directory = resolve("artifacts/render-target-color-view");
    mkdirSync(join(directory, "include/bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "include/bblite/upstream/effect_variants.hpp"),
        variants.header,
    );
    const pixels = readFileSync("native/src/pal_effect_pixels.hpp", "utf8");
    const shared = readFileSync("native/src/pal_gpu_shared.cpp", "utf8");
    runGeneratedProgram(
        tools,
        "render-target-color-view",
        `#include <bblite/upstream/effect_variants.hpp>
${variants.definitions}
${new EffectLowerer(new LoweringContext()).lowerFactory().source}
#include "pal_texture_upload_cache.hpp"
#include <cassert>
#include <iostream>
using namespace bbl;
namespace bbl::pal {
${cppFunction(shared, "const EffectTextureSlot& effect_texture_slot(const EffectWrapperRecord& wrapper,")}
${cppFunction(pixels, "inline TextureSamplerState effect_slot_sampler(")}
${cppRecord(pixels, "template <typename Image> class EffectTextureImages {")}
} // namespace bbl::pal
template <class F> bool refused(F function) {
    try { function(); } catch (const std::runtime_error&) { return true; }
    return false;
}
RenderTargetHandle target(Engine& engine, bool color, std::uint32_t samples) {
    RenderTargetRecord record;
    record.has_color = color;
    record.has_depth = !color;
    record.samples = samples;
    engine.render_targets.push_back(record);
    return RenderTargetHandle{static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}
struct Image {};
int main() {
    Engine engine;
    const RenderTargetHandle color = target(engine, true, 1), msaa = target(engine, true, 4),
                             depth = target(engine, false, 1);
    const TextureSamplerState nearest{TextureFilter::nearest, TextureFilter::nearest,
                                      TextureMipmapMode::nearest, TextureAddressMode::clamp,
                                      TextureAddressMode::clamp, 1.0f, 32.0f};
    const GpuSampler sampler{gpu_device_identity(engine), nearest};
    // The record: the target's colour through the record's sampler.
    const RenderTextureRef record = render_target_color_view(engine, color, sampler);
    assert(record.source == RenderTextureSource::render_target && record.target == color &&
           !record.depth_only && record.record_sampler == nearest);
    std::cout << refused([&] { (void)render_target_color_view(engine, msaa, sampler); })
              << refused([&] { (void)render_target_color_view(engine, depth, sampler); })
              << refused([&] { (void)render_target_color_view(engine, color, sampler, "depth"); })
              << refused([&] { (void)render_target_color_view(engine, color, sampler, "float"); });
    // The target's own facade samples through the target's sampler.
    RenderTextureRef facade;
    facade.target = color;
    std::cout << " " << (render_texture_sampler(engine, facade) == nullptr)
              << (*render_texture_sampler(engine, record) == nearest);
    // Stored: a facade of its own, sampled without the facade's invertY.
    const FileTexture stored = retained_render_texture(engine, record);
    const FileTexture own = retained_render_texture(engine, facade);
    std::cout << " " << (stored.identity != own.identity)
              << (retained_render_texture(engine, record).identity == stored.identity)
              << stored.data.uv_invert_y << own.data.uv_invert_y
              << (stored.data.render_source->reference.record_sampler == nearest)
              << (stored_texture_gpu_sampler(engine, StoredTexture{stored}) == sampler)
              << refused([&] { (void)stored_texture_gpu_sampler(engine, StoredTexture{own}); });
    // Bound to an effect: the slot samples through the bound texture's sampler,
    // and the pass rebinds when the next bind names another.
    const EffectWrapperHandle effect = create_effect_wrapper(engine, 0);
    set_effect_texture(engine, effect, EffectBindingKey{1.0}, StoredTexture{stored});
    const EffectWrapperRecord& wrapper = engine.effect_wrappers[effect.value];
    const EffectTextureSlot& slot = wrapper.textures.at(0);
    pal::EffectTextureImages<Image> images;
    std::vector<TextureSamplerState> rebinds;
    const auto upload = [](const EffectTextureSlot&) { return Image{}; };
    const auto rebind = [&](std::size_t, const EffectTextureSlot& current, const std::shared_ptr<Image>&) {
        rebinds.push_back(pal::effect_slot_sampler(engine, current));
    };
    (void)images.add(engine, slot, 0, upload);
    std::cout << " " << (pal::effect_slot_sampler(engine, slot) == nearest);
    images.refresh(engine, wrapper, upload, rebind);
    set_effect_texture(engine, effect, EffectBindingKey{1.0}, facade);
    images.refresh(engine, wrapper, upload, rebind);
    set_render_texture_sampler(engine, facade, sampler);
    images.refresh(engine, wrapper, upload, rebind);
    std::cout << " " << rebinds.size() << (rebinds.at(0) == effect_texture_sampler())
              << (rebinds.at(1) == nearest);
    // A mesh key: one identity per mesh, the same for every read of it.
    const auto first = mesh_weak_identity(engine, MeshHandle{0, 0});
    const auto again = mesh_weak_identity(engine, MeshHandle{0, 0});
    const auto reused = mesh_weak_identity(engine, MeshHandle{0, 1});
    const auto second = mesh_weak_identity(engine, MeshHandle{1, 0});
    const auto same = [](const std::weak_ptr<const void>& left, const std::weak_ptr<const void>& right) {
        return !left.owner_before(right) && !right.owner_before(left);
    };
    const ObjectIdentityTokens copied = engine.mesh_identities;
    std::cout << " " << same(first, again) << same(first, reused) << same(first, second)
              << !first.expired() << copied.empty();
}
`,
        {
            flags: ["/I", "native/src", `/I${join(directory, "include")}`],
            timeoutMs: 20000,
            expectedOutput: "1110 11 1101111 1 211 10011",
        },
    );
});
