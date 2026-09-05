import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    pinnedShadowHeader,
    shadowFactorySource,
} from "../src/lowering/shadow-lowerer.js";

/**
 * The pinned render gate: `renderEsmShadowMap`, `renderPcfShadowMap` and
 * `renderCsmShadowMap` each return before the matrix fit, the caster pass
 * and (ESM) both blur passes when neither the casters' version sum nor the
 * light's version moved. These tests hold the emitted mirror to that rule:
 * the gate's terms, its first-frame render, the CSM camera-key swap, and
 * `forceRefreshEveryFrame` now genuinely forcing instead of being the
 * accepted no-op it was while native refreshed every frame anyway.
 */

const header = pinnedShadowHeader(new LoweringContext());

test("emits the pinned caster version sum over transform and thin-instance versions", () => {
    assert.match(
        header,
        /inline std::uint64_t shadow_caster_version_sum\([\s\S]{0,400}sum \+= mesh\.transform_version \+ mesh\.instance_version;/,
    );
});

test("emits the render gate on the pin's own version rule", () => {
    // The disable flag short-circuits at the top — the pin evaluates it
    // first in its own && chain, so this is its order, not a new one —
    // then the first-frame sentinel leads the test, then the three shared
    // terms: casters, caster-list identity, light.
    assert.match(
        header,
        /inline bool shadow_refresh_due\([\s\S]{0,600}if \(generator\.force_refresh_every_frame\) return true;[\s\S]{0,900}gate\.rendered &&\s*caster_version == gate\.last_caster_version &&\s*generator\.caster_list_version == gate\.last_caster_list_version &&\s*light\.position\.x == gate\.last_light_position\.x &&[\s\S]{0,300}light\.direction\.z == gate\.last_light_direction\.z &&\s*camera_unchanged\)/,
    );
    // A fresh gate cannot skip: the pin's -1 sentinels.
    assert.match(
        header,
        /struct ShadowRefreshGate \{[\s\S]{0,600}bool rendered = false;/,
    );
    // The lanes update only on a render, as the pin's do after its fit.
    assert.match(
        header,
        /return false;\s*\}\s*gate\.rendered = true;\s*gate\.last_caster_version = caster_version;/,
    );
});

test("swaps the floating-origin term for the camera key on the CSM arm", () => {
    // Single-map generators compare the floating-origin offset the fit
    // subtracts; the CSM generator compares the camera its cascade is
    // fitted to, and no floating-origin term -- its pinned gate has none.
    assert.match(
        header,
        /const bool camera_unchanged = csm_camera == nullptr\s*\? eye\.x == gate\.last_fo_offset\.x &&/,
    );
    assert.match(
        header,
        /: csm_camera->view_projection ==\s*gate\.last_camera_view_projection &&\s*csm_camera->near_plane == gate\.last_camera_near &&\s*csm_camera->far_plane == gate\.last_camera_far;/,
    );
    assert.match(header, /struct CsmCameraKey \{/);
});

test("carries forceRefreshEveryFrame into the ESM and CSM records", () => {
    const esm = shadowFactorySource(
        new LoweringContext(),
        ["shadow:esm"],
    ).source;
    assert.match(
        esm,
        /create_esm_directional_shadow_generator\([\s\S]{0,1200}generator\.force_refresh_every_frame = options\.force_refresh_every_frame;/,
    );
    const csm = shadowFactorySource(
        new LoweringContext(),
        ["shadow:csm"],
    ).source;
    assert.match(
        csm,
        /create_csm_directional_shadow_generator\([\s\S]{0,1200}generator\.force_refresh_every_frame = options\.force_refresh_every_frame;/,
    );
});

test("bumps the caster-list identity on every re-registration", () => {
    // The pin rebuilds its task state when handed a new caster array, and
    // the fresh state's -1 sentinels force the next render; the counter is
    // that identity change for the gate.
    const source = shadowFactorySource(
        new LoweringContext(),
        ["shadow:pcf"],
    ).source;
    assert.match(
        source,
        /void set_shadow_task_caster_meshes\([\s\S]{0,900}\+\+engine\.shadow_generators\[generator\.value\]\.caster_list_version;/,
    );
});

test("gates each family's fit and publishes the verdict to the task loops", () => {
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    // ONE gate ask per generator, and the verdict lands on the gate the
    // task loops read.
    assert.match(
        shared,
        /const bool due = upstream::shadow_refresh_due\(\s*engine,\s*generator,\s*light_record,\s*eye,\s*csm_fit \? &camera_key : nullptr,\s*gate\);\s*gate\.due = due;/,
    );
    // Every fit runs only on a due frame; the caster fold is hoisted once
    // ahead of the family switch, and the spot arm alone skips it.
    assert.match(
        shared,
        /if \(due\) \{\s*if \(generator\.filter == ShadowFilter::pcf_spot\) \{\s*upstream::update_pcf_spot_shadow\(/,
    );
    assert.match(
        shared,
        /fitted_shadow_casters\(\s*engine, generator, refresh\.casters\);[\s\S]{0,700}upstream::update_esm_directional_shadow[\s\S]{0,700}upstream::update_csm_cascades[\s\S]{0,500}upstream::update_pcf_directional_shadow/,
    );
    assert.match(
        shared,
        /apply_mesh_bound_overrides\(record, minimum, maximum\);/,
    );
    // A gated frame whose block is already uploaded skips the pack, the
    // compare and the visitor: the fit did not run, so the bytes are
    // provably the uploaded ones.
    assert.match(
        shared,
        /\} else if \(refresh\.uploaded\[handle\.value\]\) \{[\s\S]{0,300}return;\s*\}/,
    );
    // Both backends' shadow arms skip their pass on a gated frame, and a
    // frame-graph texture recreation clears the rendered sentinels.
    for (const backend of [
        readFileSync("native/src/pal_sdl_gpu.cpp", "utf8"),
        readFileSync("native/src/pal_dawn.cpp", "utf8"),
    ]) {
        assert.match(
            backend,
            /if \(!state\.shadow_refresh\.gates\[\s*task\.render\.shadow_generator\.value\]\s*\.due\) \{\s*continue;\s*\}/,
        );
        assert.match(
            backend,
            /release_frame_graph_textures\((?:state)?\);[\s\S]{0,400}shadow_refresh\.invalidate_rendered_maps\(\);/,
        );
    }
});

test("fits CSM casters to every active non-degenerate thin instance", () => {
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    assert.match(
        shared,
        /const std::size_t active_instances =\s*thin_instance_active_count\(record\);/,
    );
    assert.match(
        shared,
        /generator\.filter == ShadowFilter::csm_directional &&\s*record\.thin_instanced && active_instances > 0/,
    );
    assert.match(shared, /if \(linear_magnitude < 1e-9\) continue;/);
    assert.match(shared, /caster\.instance = instance;\s*caster\.has_instance = true;\s*casters\.push_back\(caster\);/);
    assert.doesNotMatch(shared, /A thin-instanced mesh is a caster/);

    const header = pinnedShadowHeader(new LoweringContext());
    assert.match(header, /std::array<float, 16> instance\{\};\s*bool has_instance = false;/);
    assert.match(
        header,
        /const double instance_x = caster\.has_instance[\s\S]{0,900}caster\.world\[0\] \* instance_x/,
    );
});

test("builds vertex-only custom shader pipelines for shadow targets", () => {
    const sdl = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    assert.match(
        sdl,
        /std::vector<SDL_GPUGraphicsPipeline\*> shader_shadow_pipelines;/,
    );
    assert.match(
        sdl,
        /if \(render_features\.shader_shadow_variants\[variant\]\) \{[\s\S]{0,700}shadow_pipeline_info\.fragment_shader =\s*depth_only_fragment_shader\.get\(\);[\s\S]{0,700}pass_depth_compare\(true\)[\s\S]{0,700}SDL_GPU_TEXTUREFORMAT_D32_FLOAT[\s\S]{0,700}shader_shadow_pipelines\[variant\]/,
    );
    assert.match(
        sdl,
        /shadow_pipeline_info[\s\S]{0,1800}if \(!variant_fragment_shader\) continue;\s*state\.shader_pipelines\[variant\]/,
    );
    assert.match(
        sdl,
        /draw_scene\(\s*graph_scene, graph_meshes,\s*shadow_pass,[\s\S]{0,300}state\.shader_shadow_pipelines,\s*state\.shader_shadow_pipelines/,
    );

    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    assert.match(dawn, /DawnPipeline>\s+shader_shadow_pipelines;/);
    assert.match(
        dawn,
        /auto& pipeline_map = shadow_pass\s*\? state\.shader_shadow_pipelines/,
    );
    assert.match(
        dawn,
        /depth_stencil\.format = shadow_pass\s*\? WGPUTextureFormat_Depth32Float/,
    );
    assert.match(
        dawn,
        /descriptor\.fragment = shadow_pass &&\s*shader_info\s*\? nullptr/,
    );
    assert.match(dawn, /if \(!shadow_pass && !state\.shader_fragment_modules\[shader_variant\]\) \{/);
    // Reflection describes uniform blocks, not whether a fragment stage
    // exists. A color shader without a fragment UBO is not a shadow caster.
    const renderer = readFileSync("src/lowering/renderer-lowerer.ts", "utf8");
    assert.match(renderer, /shader_shadow_variants\.at\(material\.shader_variant\) = true;/);
    assert.match(renderer, /task\.render\.shadow_generator\.value != invalid_handle/);
    assert.doesNotMatch(sdl, /if \(!info\.fragment\.present\)/);
    // A custom caster keeps the same reflected groups as its colour
    // sibling. In particular, group 0 is the caller's vertex storage -- it
    // is not the optional morph-storage group from the ordinary mesh
    // layout -- and every task supplies its own light-space uniform block.
    assert.match(
        dawn,
        /WGPUPipelineLayout shader_pipeline_layout_for\([\s\S]{0,3200}WGPUBufferBindingType_ReadOnlyStorage/,
    );
    assert.match(dawn, /return WGPUTextureViewDimension_2DArray;/);
    assert.match(
        dawn,
        /descriptor\.layout = shader_info\s*\? shader_pipeline_layout_for\(state, shader_variant\)\s*: mesh_pipeline_layout_for\(state\)/,
    );
    assert.match(
        dawn,
        /esm_shadow_index,\s*render_task\.view_projection\);/,
    );
    assert.match(
        dawn,
        /sync_shader_storage_buffers\(state, engine\);/,
    );
});

test("resolves forceRefreshEveryFrame into the emitted options", () => {
    const compile = (option: string): string =>
        compileSource(`
        import {
            addToScene,
            createDirectionalLight,
            createEngine,
            createEsmDirectionalShadowGenerator,
            createSceneContext,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            createEsmDirectionalShadowGenerator(engine, light, {
                mapSize: 512,${option}
            });
        }

        void main();
    `).cpp;

    // The flag sits between orthoMaxZ's slot and the ESM ordinal, which is
    // the position the record and options struct give it.
    assert.match(
        compile("\n                forceRefreshEveryFrame: true,"),
        /EsmDirectionalShadowOptions\{[^}]*true, 0u\}/,
    );
    assert.match(
        compile(""),
        /EsmDirectionalShadowOptions\{[^}]*false, 0u\}/,
    );
});

test("carries forceRefreshEveryFrame on the PCF directional factory", () => {
    // Scene 140 reaches it, so the DIRECTIONAL factory carries it into the
    // record the way the ESM and CSM factories already did -- the gate the
    // emitted render loop reads is the same one for all three.
    const emitted = compileSource(`
        import {
            addToScene,
            createDirectionalLight,
            createEngine,
            createPcfDirectionalShadowGenerator,
            createSceneContext,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            createPcfDirectionalShadowGenerator(engine, light, {
                forceRefreshEveryFrame: true,
            });
        }

        void main();
    `).cpp;
    assert.match(
        emitted,
        /PcfDirectionalShadowOptions\{[^}]*true\}/,
    );
});

test("still refuses forceRefreshEveryFrame on the PCF SPOT factory", () => {
    // Deliberately asymmetric with the directional arm above: no corpus
    // scene reaches it here, and the convention is to reach a capability
    // where the pin's own callers reach it. Generation still anchors this
    // factory's `?? false` default, so a pin that changed what it carries
    // fails rather than drifting past this refusal.
    assert.throws(
        () =>
            compileSource(`
        import {
            addToScene,
            createEngine,
            createPcfSpotlightShadowGenerator,
            createSceneContext,
            createSpotLight,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createSpotLight([0, 5, 0], [0, -1, 0], 1.0, 2, 1);
            addToScene(scene, light);
            createPcfSpotlightShadowGenerator(engine, light, {
                forceRefreshEveryFrame: true,
            });
        }

        void main();
    `),
        (error: unknown) =>
            error instanceof CompileError &&
            // validateObjectProperties refuses with the factory's own
            // options label; the offending name is in the source span.
            /A PCF spotlight shadow generator options/.test(error.message),
    );
});
