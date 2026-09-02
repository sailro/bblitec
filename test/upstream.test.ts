import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUpstreamGraph } from "../src/upstream-graph.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lightVectorSetter } from "../src/compiler/assignments.js";
import type { LightKind } from "../src/compiler/types.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { EngineLowerer } from "../src/lowering/engine-lowerer.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { pinnedSurfaceHeader } from "../src/lowering/pinned-surface.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { pinnedDepthStateHeader } from "../src/lowering/pinned-depth-state.js";
import { pinnedInverseImageProcessingHeader } from "../src/lowering/pinned-inverse-image-processing.js";
import {
    readUpstreamPin,
    UpstreamSourceStore,
} from "../src/upstream-source.js";
import type { CompiledShaderProgram } from "../src/compiler.js";
import {
    predeclaredShaderProgram,
    shaderMaterialPrograms,
} from "../src/shader-material-programs.js";
import {
    dawnUtilityShaders,
    spriteCoreAdditionalProvenance,
    spriteVertexPermutations,
} from "../src/upstream-lower.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { composeBillboardPickingShader } from "../src/pinned-picking-shaders.js";
import { shadowFactorySource } from "../src/lowering/shadow-lowerer.js";
import {
    bakeCsgMesh,
    csgGeometryDeclarations,
    type CsgSolidPlan,
    type CsgSourceMesh,
} from "../src/pinned-csg.js";
import { float32Literal } from "../src/cpp-literals.js";
import { resolveGeometryExtensions } from "../src/compressed-geometry.js";
import { buildGlb, readGlbFixture } from "./glb-fixture.js";
import { receiverShadowLightSlots } from "../src/compose-pipeline.js";

/** The provenance banner every generated source carries, derived from the
 *  pin so a version bump does not churn these assertions. */
function pinnedProvenance(): RegExp {
    const pin = readUpstreamPin();
    const literal = `Generated from ${pin.package}@${pin.version}`;
    return new RegExp(
        literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
}

function reachedPrograms(
    names: string[],
): CompiledShaderProgram[] {
    return names.map((name) => {
        const program = shaderMaterialPrograms.find(
            (candidate) => candidate.name === name,
        );
        if (!program) {
            throw new Error(`Unknown predeclared shader program '${name}'.`);
        }
        return predeclaredShaderProgram(program);
    });
}

test("loads pinned Babylon Lite TypeScript from published source maps", () => {
    const store = new UpstreamSourceStore();
    assert.deepEqual(store.pin, readUpstreamPin());
    assert.match(store.getSource("src/light/light-matrix.ts"), /function localMatrixFromDirection/);
    assert.equal(store.resolvePublicExport("createHemisphericLight").modulePath, "src/light/hemispheric.ts");
});

test("generates the Babylon environment parser from upstream constants", () => {
    const lowerer = new EnvironmentLowerer(new LoweringContext());
    const lowered = lowerer.lowerParser();
    const adapter = lowerer.lowerLoaderAdapter();
    const hdrAdapter = lowerer.lowerHdrLoaderAdapter();
    assert.match(lowered.source, /0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36/);
    assert.match(lowered.source, /constexpr float c1 = 1\.4999984284682104f/);
    assert.match(lowered.source, /face\.bytes\.assign/);
    assert.match(adapter.source, /scene\.environment\.exposure = 0\.8f/);
    assert.match(adapter.source, /scene\.environment\.contrast = 1\.2f/);
    assert.doesNotMatch(adapter.source, /scene\.clear_color/);
    assert.match(adapter.source, /scene\.environment\.ground_texture/);
    assert.match(adapter.source, /scene\.environment\.ground_size/);
    assert.match(adapter.source, /scene\.environment\.skybox_width/);
    assert.match(adapter.source, /0x20534444u/);
    assert.match(hdrAdapter.source, /0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31/);
    assert.match(hdrAdapter.source, /scene\.environment\.specular_rgba16f = true/);
    assert.match(
        hdrAdapter.source,
        /scene\.environment\.lod_generation_scale =\s*0\.8f/,
    );
    assert.match(hdrAdapter.source, /scene\.environment\.tone_mapping_enabled = false/);
    assert.match(hdrAdapter.source, /scene\.environment\.skybox_uses_environment/);
});

test("generates scene defaults, routing, and idempotent registration", () => {
    const lowered = new SceneLowerer(new LoweringContext()).lowerCore();
    assert.match(lowered.source, /scene\.clear_color = Color4\{\s*0\.2f,\s*0\.2f,\s*0\.3f,\s*1\.0f/s);
    assert.match(lowered.source, /for \(const MeshHandle mesh : record\.meshes\)/);
    assert.match(lowered.source, /scene\.render_topology_version/);
    assert.match(lowered.source, /scene\.material_family_mask/);
    assert.match(lowered.source, /void on_before_render/);
    assert.match(
        lowered.source,
        /void on_scene_dispose\([\s\S]*scene\.disposables\.push_back\(std::move\(callback\)\);/,
    );
    assert.match(lowered.source, /registered_scenes\.end\(\)/);
    // Runtime removal drops the mesh and marks the topology; the
    // material-family mask stays monotonic so built pipelines survive.
    assert.match(
        lowered.source,
        /void remove_from_scene\(Scene& scene, MeshHandle mesh\)/,
    );
    assert.match(
        lowered.source,
        /scene\.meshes\.erase\(found\);\s*\r?\n\s*\+\+scene\.render_topology_version;/,
    );
    assert.match(
        lowered.source,
        /void remove_from_scene\(Scene& scene, LightHandle light\)/,
    );
    assert.match(
        lowered.source,
        /pending_shadow_retirements\.push_back\(generator\);[\s\S]{0,120}scene\.lights\.erase\(found\);[\s\S]{0,120}scene\.topology_rebuild_pending = true;[\s\S]{0,120}\+\+scene\.render_topology_version;/,
    );
    assert.match(
        lowered.source,
        /void unregister_scene\(Scene& scene\)[\s\S]{0,400}registered_scenes\.erase/,
    );
    assert.match(
        lowered.source,
        /void rebuild_scene_renderables\(Scene& scene\)[\s\S]{0,2200}pending_shadow_retirements\.clear\(\);[\s\S]{0,120}topology_rebuild_pending = false;[\s\S]{0,100}\+\+scene\.render_topology_version;/,
    );
    assert.match(
        lowered.source,
        /AssetHandle clone_asset_root\(Engine& engine, AssetHandle asset\)/,
    );
    assert.match(
        lowered.source,
        /record\.feature_source_mesh =/,
    );
    assert.match(
        lowered.source,
        /component_ref\(record\.outer_position\) \+= delta;/,
    );
    assert.doesNotMatch(lowered.source, /&root\.root_position\.x/);
    assert.match(
        lowered.source,
        /!source\.lights\.empty\(\) \|\| source\.has_camera/,
    );
    assert.match(
        lowered.source,
        /clone\.clone_mesh_animation = clone_animation;/,
    );
});

test("bumps the visibility epoch only when setMeshVisible changes a flag", () => {
    // The pin's two-writer rule (src/scene/visibility.ts): setMeshVisible
    // is the sole epoch bumper, and only when the cascade actually moved a
    // flag -- a per-frame re-assertion of the same value stays a true
    // no-op, and a bare `visible` field write defers to the next rebuild
    // (the regression-mesh-flags gate measures that deferral). The epoch
    // is what makes a hide or show land the same frame; without the bump,
    // a weapon picked up after the lists were built could never draw.
    const lowered = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ visibility: true });

    assert.match(
        lowered.source,
        /bool changed = record\.visible != visible;/,
    );
    assert.match(
        lowered.source,
        /if \(set_mesh_visible_cascade\(engine, mesh, visible\)\) \{[\s\S]*?\+\+engine\.visibility_epoch;/,
    );
    // The bump is conditional: no unguarded increment exists.
    const bumps = lowered.source.match(/\+\+engine\.visibility_epoch;/g);
    assert.equal(bumps?.length, 1);
});

test("preserves full pinned TRS when setParent relinks a mesh", () => {
    const lowered = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ parenting: true });

    assert.match(
        lowered.source,
        /#include <bblite\/upstream\/renderer_plan\.hpp>/,
    );
    assert.match(
        lowered.source,
        /const std::array<float, 16> child_world =\s*parenting_world_matrix\(engine, child_record\);[\s\S]{0,500}child_record\.parent = parent;/,
    );
    assert.match(
        lowered.source,
        /const bool link_changed =[\s\S]{0,180}if \(link_changed\) \{[\s\S]{0,2100}child_record\.parent = parent;/,
    );
    assert.match(
        lowered.source,
        /void unlink_child_links\([\s\S]{0,500}children\.erase\([\s\S]{0,220}registered\.erase\(/,
    );
    assert.match(
        lowered.source,
        /mat4_invert\(\*parent_world\)[\s\S]{0,950}mat4_multiply_into\(local, 0, \*inverse_parent, 0, child_world, 0\);[\s\S]{0,180}pinned_parent_mat4_decompose\(local\)/,
    );
    assert.match(
        lowered.source,
        /pinned_parent_mat4_determinant3\(m\) < 0\.0\) \? \(-syAbs\) : syAbs/,
    );
    assert.match(
        lowered.source,
        /record\.rotation_quaternion = Vec4\{[\s\S]{0,320}record\.has_rotation_quaternion = true;[\s\S]{0,220}local\.scale\.y/,
    );
    assert.match(
        lowered.source,
        /if \(!inverse_parent\) \{[\s\S]{0,420}child_record\.position = Vec3d\{\s*child_world\[12\], child_world\[13\], child_world\[14\]\};[\s\S]{0,120}mark_mesh_dirty\(engine, child\);\s*return;/,
    );
    assert.match(
        lowered.source,
        /for \(const MeshHandle child : record\.parented_meshes\) \{\s*mark_mesh_dirty\(engine, child\);/,
    );
});

test("compares transform-node parent handles by their stored ids", () => {
    const lowered = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ transformNodes: true });
    assert.match(
        lowered.source,
        /record\.transform_parent\.value == parent\.value/,
    );
});

test("omits the ESM selector local from a PCF-only caster view", () => {
    const pcf = shadowFactorySource(
        new LoweringContext(),
        ["shadow:pcf"],
    ).source;
    const casterView = pcf.slice(
        pcf.indexOf("MaterialHandle shadow_caster_view"),
        pcf.indexOf("void refresh_shadow_task_meshes"),
    );
    assert.doesNotMatch(casterView, /const bool esm/);

    const esm = shadowFactorySource(
        new LoweringContext(),
        ["shadow:esm"],
    ).source;
    assert.match(
        esm.slice(
            esm.indexOf("MaterialHandle shadow_caster_view"),
            esm.indexOf("void refresh_shadow_task_meshes"),
        ),
        /const bool esm =\s*generator\.filter == ShadowFilter::esm_directional/,
    );
});

test("clears an armed topology rebuild after replacement shadow tasks exist", () => {
    const source = shadowFactorySource(
        new LoweringContext(),
        ["shadow:pcf"],
    ).source;

    assert.match(
        source,
        /void register_scene_with_shadow_support\(Scene& scene\)[\s\S]{0,1000}build_shadow_task\(scene, generator\);[\s\S]{0,160}register_scene\(scene\);\s*rebuild_scene_renderables\(scene\);/,
    );
});

test("reuses one receiver binding for same-filter shadow replacements", () => {
    assert.deepEqual(
        receiverShadowLightSlots([
            { kind: "pcf-spot", lightIndex: 0 },
            { kind: "pcf-spot", lightIndex: 0 },
        ]),
        [{ lightIndex: 0, shadowType: "pcf" }],
    );
    assert.deepEqual(
        receiverShadowLightSlots([
            // The reached CSM adaptation remains manifest-truthful as the
            // single-map directional PCF receiver contract.
            { kind: "pcf-directional", lightIndex: 1 },
        ]),
        [{ lightIndex: 1, shadowType: "pcf" }],
    );
    assert.throws(
        () =>
            receiverShadowLightSlots([
                { kind: "pcf-spot", lightIndex: 0 },
                { kind: "esm-directional", lightIndex: 0 },
            ]),
        /dynamic shadow-filter variants are not lowered/,
    );
});

test("generates property animation evaluation and seeking", () => {
    const lowered = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation();
    assert.match(lowered.source, /slerp_quaternion/);
    assert.match(
        lowered.source,
        /PropertyAnimationInterpolation::step/,
    );
    assert.match(lowered.source, /scene\.animation_seekers/);
    assert.match(lowered.source, /mesh\.scaling = Vec3/);
    assert.match(
        lowered.source,
        /mesh\.has_rotation_quaternion = true/,
    );
    assert.match(
        lowered.source,
        /mark_mesh_runtime_transform\(engine, MeshHandle\{target\.index\}\);/,
    );
});

test("generates the pinned glTF animation-group seek", () => {
    const lowered = new AnimationLowerer(
        new LoweringContext(),
    ).lowerGroupOperations();
    assert.match(
        lowered.source,
        /frame \/ 60\.0f/,
    );
    assert.match(
        lowered.source,
        /asset\.apply_clip_pose\(record\.clip, with_engine\)/,
    );
});

test("emits the weighted property mixer only when blending is reached", () => {
    const plain = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation();
    assert.doesNotMatch(
        plain.source,
        /update_weighted_property_animations/,
    );
    assert.doesNotMatch(plain.source, /set_animation_weight/);

    const blended = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation({ blending: true });
    // The mixer's shape: buckets keyed per (mesh, path), the pinned
    // weighted sum, the hemisphere sign, the final normalize, and the
    // category-handler early-out that hands an uncontested tick back to
    // the ordinary per-group path.
    assert.match(blended.source, /PropertyAnimationBucket& track_bucket/);
    assert.match(blended.source, /if \(!contested\) return false;/);
    // The two opt-ins share one handler slot, the way the pin's own
    // setAnimationTaskCategoryHandler does.
    assert.match(
        blended.source,
        /AnimationCategoryHandler::property_mixer;/,
    );
    assert.match(
        blended.source,
        /sign = dot < 0\.0 \? -1\.0 : 1\.0;/,
    );
    assert.match(
        blended.source,
        /normalize_blended_quaternion\(bucket\.values\);/,
    );
    // The bucket width comes from the same path table the clip lowerer
    // validates key values against.
    assert.match(
        blended.source,
        /case PropertyAnimationPath::rotation_quaternion:\s*\r?\n\s*return 4;/,
    );
});

test("emits mixer-neutral weight fades in the manager pre-update phase", () => {
    const plain = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation();
    assert.doesNotMatch(plain.source, /update_animation_weight_fades/);
    assert.doesNotMatch(plain.source, /cross_fade_animation_groups/);

    const faded = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation({ weightFades: true });
    assert.match(faded.source, /update_animation_weight_fades/);
    assert.match(faded.source, /cross_fade_animation_groups/);
    assert.match(
        faded.source,
        /same_animation_weight_fade_target\(\s*owner\.weight_fades\[fade_index\]\.target,\s*target\)/,
    );
    assert.match(
        faded.source,
        /target\.gltf_group\.value/,
    );
    assert.match(
        faded.source,
        /float& animation_weight_fade_target_weight/,
    );
    // Scheduling alone must not pull in or enable either category mixer.
    assert.doesNotMatch(
        faded.source,
        /update_weighted_property_animations/,
    );
    assert.doesNotMatch(
        faded.source,
        /AnimationCategoryHandler::property_mixer;/,
    );
    assert.doesNotMatch(
        faded.source,
        /AnimationCategoryHandler::gltf_mixer;/,
    );

    // The emitted interpolation is the pin's elapsed/duration lerp. At
    // 250ms of a 1000ms cross-fade it yields 0.75/0.25 and a +1 mixed
    // pose for the pin's constant +2/-2 property-animation fixture.
    assert.match(
        faded.source,
        /fade\.elapsed_ms = std::min\(\s*fade\.duration_ms,\s*fade\.elapsed_ms \+ std::max\(0\.0f, delta_ms\)\);/,
    );
    assert.match(
        faded.source,
        /fade\.from \+ \(fade\.to - fade\.from\) \* amount/,
    );
    // Elapsed time is clamped to the duration, so the interpolation writes
    // the exact destination before the completed job is removed. Replacement
    // removes every prior job for the same target before the new one is pushed.
    assert.match(
        faded.source,
        /if \(fade\.elapsed_ms >= fade\.duration_ms\) \{[\s\S]*?manager\.weight_fades\.erase/,
    );
    const replacement = faded.source.indexOf(
        "same_animation_weight_fade_target(",
        faded.source.indexOf("schedule_animation_weight_fade("),
    );
    const replacementErase = faded.source.indexOf(
        "owner.weight_fades.erase(",
        replacement,
    );
    const replacementPush = faded.source.indexOf(
        "owner.weight_fades.push_back(",
        replacement,
    );
    assert.ok(replacement >= 0);
    assert.ok(replacementErase > replacement);
    assert.ok(replacementPush > replacementErase);

    assert.match(
        faded.source,
        /!std::isfinite\(duration_ms\) \|\| !\(duration_ms > 0\.0f\)/,
    );
    assert.match(
        faded.source,
        /!std::isfinite\(weight\)[\s\S]*?weight < 0\.0f[\s\S]*?weight > 1\.0f/,
    );

    // Installation is stable (function-target comparison, no wrapper),
    // while the preserved hook executes before the fade updater.
    assert.match(
        faded.source,
        /manager\.pre_update\.target<PreUpdateFunction>\(\)/,
    );
    const priorHook = faded.source.indexOf(
        "manager.prior_weight_fade_pre_update(",
    );
    const fadeUpdate = faded.source.indexOf(
        "update_animation_weight_fades(engine, manager, delta_ms);",
        priorHook,
    );
    assert.ok(priorHook >= 0);
    assert.ok(fadeUpdate > priorHook);

    const blended = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation({
        blending: true,
        weightFades: true,
    });
    const fadeTick = blended.source.indexOf(
        "manager.pre_update(engine, manager, delta_ms);",
    );
    const mixerTick = blended.source.indexOf(
        "manager.category_handler ==",
        fadeTick,
    );
    assert.ok(fadeTick >= 0);
    assert.ok(mixerTick > fadeTick);

    const managed = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation({
        managedGroups: true,
        weightFades: true,
    });
    assert.match(
        managed.source,
        /create_property_animation_group\([\s\S]*?bind_manager_engine\(manager, engine\)/,
    );
    assert.match(
        managed.source,
        /void add_animation_groups\([\s\S]*?bind_manager_engine\(manager, engine\)/,
    );
    assert.match(
        managed.source,
        /void update_animation_manager\([\s\S]*?bind_manager_engine\(manager, engine\)/,
    );
    assert.match(
        managed.source,
        /void start_animation_manager\([\s\S]*?bind_manager_engine\(manager, \*engine\)/,
    );
});

test("flows the pinned animation constants into the emission", () => {
    const lowered = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation();
    // The near-parallel slerp threshold is extracted from the pinned
    // quatSlerp (src/animation/evaluate.ts), and the ms->s advance
    // factor is the reciprocal of the pinned tick's divisor
    // (src/animation/property-animation.ts createPointerAnimationGroup).
    assert.match(lowered.source, /if \(dot > 0\.9995f\) \{/);
    assert.match(
        lowered.source,
        /delta_ms \* 0\.001f \* group->speed_ratio/,
    );
    // The STEP tie-break direction the lowerer shape-asserts: an exact
    // key-time query takes the LATER key's value.
    assert.match(
        lowered.source,
        /time >= track\.keys\[right\]\.time\s*\? track\.keys\[right\]\.value/,
    );
    // The loop wrap and its negative-wrap correction, shape-asserted
    // against the pinned tick.
    assert.match(
        lowered.source,
        /std::fmod\(\s*group->current_time - group->from_time,\s*duration\)/,
    );
    assert.match(
        lowered.source,
        /if \(group->current_time < group->from_time\) \{\s*group->current_time \+= duration;/,
    );
});

test("flows the pinned camera inertia constants into the controls", () => {
    const controls = new CameraLowerer(
        new LoweringContext(),
    ).lowerControls();
    // ArcRotate applyInertia: the beta pole margin (`eps`), the radius
    // floor, and the radius-proportional pan scale all come from
    // src/camera/arc-rotate-controls.ts.
    assert.match(
        controls.source,
        /constexpr double epsilon = 0\.01;/,
    );
    assert.match(
        controls.source,
        /camera\.radius = std::max\(0\.01, camera\.radius\);/,
    );
    assert.match(
        controls.source,
        /const double pan_scale = camera\.radius \* 0\.001;/,
    );
    // FreeCamera update: the pitch ceiling terms and the shared
    // speed-proportional stop threshold come from
    // src/camera/free-camera-controls.ts.
    assert.match(
        controls.source,
        /constexpr double max_pitch = pi_double \/ 2\.0 - 0\.01;/,
    );
    assert.match(
        controls.source,
        /const double epsilon = camera\.speed \* 0\.001;/,
    );
    // The event accumulators the platform layer calls instead of
    // re-typing: the wheel-precision scale flows from onWheel, and the
    // pan/orbit divisions mirror onPointerMove.
    assert.match(
        controls.source,
        /\(delta_y \* camera\.radius\) \/\s*\(camera\.wheel_precision \* 1000\.0\)/,
    );
    assert.match(
        controls.source,
        /camera\.inertial_panning_x \+= -dx \/ camera\.panning_sensibility;/,
    );
    assert.match(
        controls.source,
        /camera\.inertial_alpha_offset -= dx \/ camera\.angular_sensibility;/,
    );
    // The free-look accumulator folds the pinned `_pitch -= crX` sign
    // into the apply-additive record offset.
    assert.match(
        controls.source,
        /camera\.inertial_pitch_offset -= dy \/ camera\.angular_sensibility;/,
    );
    // The per-frame move scale is the pinned formula, never a
    // hand-evaluated constant: moveSpeed = speed * sqrt(dt*dt / 1e5)
    // with dt floored at 1 ms, both numbers read from
    // free-camera-controls.ts. The platform loop hands in its own frame
    // step at call time.
    assert.match(
        controls.source,
        /const double dt = std::max\(delta_ms, 1\.0\);/,
    );
    assert.match(
        controls.source,
        /return camera\.speed \*\s*std::sqrt\(\(dt \* dt\) \/ 100000\.0\);/,
    );
    assert.match(
        controls.header,
        /double free_camera_move_speed\(const CameraRecord& camera, double delta_ms\);/,
    );
});

// One store load serves both light tests: the LoweringContext constructor
// parses every pinned source map, which dwarfs the lowering itself.
const lightLowerer = new LightLowerer(new LoweringContext());

test("flows the pinned light matrices and spot cone into the factories", () => {
    const lowerer = lightLowerer;
    // The spot half-angle factor flows from the pinned _cosHalfAngle
    // initializer (src/light/spot-light.ts), and stays a double until the
    // one store assigns the result to its float UBO field. That store is
    // emitted once, beside the local-matrix refresh and for the same
    // reason: the factory and the angle setter both perform it, and a pin
    // that retuned the factor must reach both.
    const spot = lowerer.lowerSpotFactory();
    assert.match(
        spot.source,
        /void refresh_spot_light_cone\(LightRecord& light, double angle\) \{\s*light\.angle = angle;\s*light\.cos_half_angle = static_cast<float>\(std::cos\(\s*angle \* 0\.5\)\);/,
    );
    assert.equal(
        spot.source.split("light.cos_half_angle").length - 1,
        1,
        "The pinned cone store belongs to one emitted helper.",
    );
    assert.match(spot.source, /double angle,[\s\S]*refresh_spot_light_cone\(light, angle\);/);
    assert.match(
        spot.source,
        /void set_spot_light_angle\([\s\S]*refresh_spot_light_cone\(\s*engine\.lights\[light\.value\], angle\);/,
    );
    // The point-light identity diagonal and translation column flow
    // from the pinned factory's own m[...] stores
    // (src/light/point-light.ts).
    const point = lowerer.lowerPointFactory();
    assert.match(
        point.source,
        /light\.local_matrix\[0\] = 1\.0f;/,
    );
    assert.match(
        point.source,
        /light\.local_matrix\[10\] = 1\.0f;/,
    );
    assert.match(
        point.source,
        /light\.local_matrix\[12\] = light\.position\.x;/,
    );
    assert.match(point.source, /refresh_point_light_matrix\(light\);/);
    assert.match(
        point.source,
        /light\.local_matrix\[15\] = 1\.0f;/,
    );
    // The directional zeros are the pinned default position, which the
    // factory now stores on the record so the rebuild an ObservableVec3
    // write triggers reads the same field the setter moved.
    const directional = lowerer.lowerDirectionalFactory();
    assert.match(
        directional.source,
        /light\.position = Vec3\{\s*0\.0f,\s*0\.0f,\s*0\.0f\};/,
    );
    // The hemispheric zeros stay the pinned literal origin arguments: that
    // kind carries no position to move.
    assert.match(
        lowerer.lowerFactory().source,
        /0\.0f,\s*0\.0f,\s*0\.0f,\s*light\.local_matrix\);/,
    );
});

test("every light vector setter rebuilds its own kind's local matrix", () => {
    // An ObservableVec3 write marks the light's local matrix dirty and the
    // next read rebuilds it, so a setter that only moved the field would
    // leave `local_matrix`'s readers on the old pose — including the CPU
    // raster path, which the image gate does not run. This is what holds
    // the setters to the rebuild.
    const sources: Readonly<Record<LightKind, string>> = {
        hemispheric: lightLowerer.lowerFactory().source,
        directional: lightLowerer.lowerDirectionalFactory().source,
        point: lightLowerer.lowerPointFactory().source,
        spot: lightLowerer.lowerSpotFactory().source,
    };
    let emitted = 0;
    for (const kind of Object.keys(sources) as LightKind[]) {
        for (const vector of ["position", "direction"]) {
            const setter = lightVectorSetter(
                { kind: "light", cpp: "", lightKind: kind },
                vector,
            );
            if (!setter) continue;
            emitted++;
            assert.ok(
                sources[kind].includes(
                    `    LightRecord& record = engine.lights[light.value];\n` +
                        `    record.${vector} = ${vector};\n` +
                        `    refresh_${kind}_light_matrix(record);\n}`,
                ),
                `the ${kind} light's ${vector} setter no longer rebuilds its matrix`,
            );
        }
        // A kind the compiler refuses every vector for emits no setter at
        // all, so its factory stays the pin's plain one.
        if (
            !["position", "direction"].some((vector) =>
                lightVectorSetter(
                    { kind: "light", cpp: "", lightKind: kind },
                    vector,
                )
            )
        ) {
            assert.ok(!sources[kind].includes(`void set_${kind}_light_`));
        }
    }
    assert.equal(emitted, 4);
});

test("generates scene fog storage for the pinned fog UBO field set", () => {
    const lowered = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ fog: true });
    // set_scene_fog stores exactly the fields the pinned writeFogUbo
    // consumes; the writer's browser-UBO offsets are not asserted
    // because nothing in the generated tree uses them.
    assert.match(lowered.source, /void set_scene_fog\(/);
    for (const store of [
        /scene\.fog_mode = mode;/,
        /scene\.fog_density = density;/,
        /scene\.fog_start = start;/,
        /scene\.fog_end = end;/,
        /scene\.fog_color = color;/,
    ]) {
        assert.match(lowered.source, store);
    }
});

test("generates GLB framing validation from upstream constants", () => {
    const lowerer = new GltfLowerer(new LoweringContext());
    const lowered = lowerer.lowerGlbParser();
    const adapter = lowerer.lowerLoaderAdapter();
    assert.match(lowered.source, /0x46546c67/);
    assert.match(lowered.source, /0x4e4f534a/);
    assert.match(lowered.source, /0x4e4942/);
    assert.match(adapter.source, /ts::await\(pal::fetch_array_buffer/);
    assert.match(adapter.source, /read_component/);
    assert.match(
        adapter.source,
        /if \(selected\.stopped && !with_engine\) return;\s*apply_animation_state\(clip, with_engine\);/,
    );
    assert.match(
        adapter.source,
        /glTF accessor exceeds its bufferView/,
    );
    assert.match(
        adapter.source,
        /glTF accessor is sparse/,
    );
    assert.match(
        adapter.source,
        /glTF node hierarchy contains a cycle/,
    );
    assert.match(
        adapter.source,
        /glTF animated node hierarchy contains a cycle/,
    );
    assert.match(
        adapter.source,
        /glTF primitive index exceeds its vertex count/,
    );
    // The mirrored-basis predicate reads the SHARED pinned fold — the same
    // emission the run-time watcher calls — never a loader-local expansion.
    assert.match(
        adapter.source,
        /const double determinant =\s*upstream::pinned_mat4_determinant3\(matrix\);/,
    );
    assert.doesNotMatch(adapter.source, /linear_determinant/);
    // The raw world multiplies come from the shared emitted pair; only the
    // RH->LH negating wrappers stay loader-local.
    assert.match(adapter.source, /upstream::transform_position\(/);
    assert.doesNotMatch(adapter.source, /transform_point_raw/);
    assert.match(
        adapter.source,
        /record\.clockwise_front_face/,
    );
    assert.match(
        adapter.source,
        /determinant < 0\.0 &&\s*!clockwise_front_face/,
    );
    assert.match(adapter.source, /geometry\.flat_normals = true/);
    assert.match(adapter.source, /vertex\.local_position = local_position/);
    assert.match(adapter.source, /geometry\.has_tangents = tangents != nullptr/);
    assert.match(adapter.source, /optional\(attributes, "COLOR_0"\)/);
    assert.match(
        adapter.source,
        /KHR_materials_emissive_strength/,
    );
    assert.match(
        adapter.source,
        /KHR_texture_transform/,
    );
    assert.match(
        adapter.source,
        /EXT_lights_image_based/,
    );
    assert.match(
        adapter.source,
        /KHR_lights_punctual/,
    );
    assert.match(
        adapter.source,
        /gltf-ibl-brdf-lut\.rgba16f/,
    );
    assert.match(adapter.source, /brdf_lut_rgba16f = true/);
    assert.match(
        adapter.source,
        /EXT_mesh_gpu_instancing/,
    );
    assert.match(
        adapter.source,
        /record\.instance_matrices/,
    );
    assert.match(
        adapter.source,
        /record\.instance_parent_matrix/,
    );
    assert.match(adapter.source, /vertex\.color = Vec4/);
    assert.match(adapter.source, /result\.sampler\.max_anisotropy/);
    assert.match(adapter.source, /result\.sampler\.max_lod = no_mip/);
    assert.match(adapter.source, /MaterialAlphaMode::blend/);
    assert.match(adapter.source, /alpha_cutoff/);
    assert.match(adapter.source, /normal_texture_scale/);
    assert.match(adapter.source, /record\.baked_world_scale/);
    assert.match(adapter.source, /material\.specular_aa = true/);
    assert.match(adapter.source, /KHR_materials_transmission/);
    assert.match(adapter.source, /KHR_materials_ior/);
    assert.match(adapter.source, /KHR_materials_volume/);
    assert.match(adapter.source, /material\.transmission_texture/);
    assert.doesNotMatch(
        adapter.source,
        /material\.transmission_factor > 0\.0f[\s\S]*?material\.alpha_mode = MaterialAlphaMode::blend/,
    );
    assert.match(adapter.source, /material\.thickness_texture/);
    assert.match(adapter.source, /material\.use_thickness_as_depth = true/);
    assert.match(adapter.source, /KHR_materials_clearcoat/);
    assert.match(adapter.source, /KHR_materials_sheen/);
    assert.match(adapter.source, /KHR_materials_iridescence/);
    assert.match(adapter.source, /KHR_materials_dispersion/);
    assert.match(
        adapter.source,
        /material\.dispersion = 20\.0f \/ dispersion;/,
    );
    assert.match(
        adapter.source,
        /clearcoat_texture \? 1\.0f : 0\.0f/,
    );
    assert.match(
        adapter.source,
        /clearcoat_roughness_texture \? 1\.0f : 0\.0f/,
    );
    assert.match(
        adapter.source,
        /material\.clearcoat_normal_scale/,
    );
    assert.match(adapter.source, /const bool same_as_color =/);
    assert.match(adapter.source, /texture_transform_value\(/);
    assert.match(
        adapter.source,
        /"iridescenceThicknessMaximum",\s*\r?\n\s*400\.0f\);/,
    );
    assert.match(adapter.source, /JOINTS_0/);
    assert.match(adapter.source, /WEIGHTS_0/);
    assert.match(adapter.source, /inverseBindMatrices/);
    assert.match(adapter.source, /RotationTrack/);
    assert.match(adapter.source, /animation_tick/);
    // The load-time pose is the pose pass alone, over the node TRS the file
    // authored: upstream seeds each skin's bone texture from that rest
    // hierarchy and evaluates no channel until a tick, so a scene that never
    // ticks holds the rest pose (docs/fidelity.md).
    assert.match(
        adapter.source,
        /apply_animation_pose\(\);\s*\/\/ cloneTransformNode/,
    );
    // Every transform and morph channel reads its keyframe pair through
    // the one sampler pair, which carries the pinned clamp.
    assert.match(
        adapter.source,
        /for \(const RotationTrack& track[\s\S]*?sample_rotation_track\(/,
    );
    assert.match(
        adapter.source,
        /for \(const TranslationTrack& track[\s\S]*?sample_vec3_track\(/,
    );
    assert.match(
        adapter.source,
        /weight_tracks\.rbegin\(\)[\s\S]*?const WeightTrack& track[\s\S]*?track_amount_at\(/,
    );
    assert.match(adapter.source, /double track_amount_at\([\s\S]*?std::clamp\(/);
    assert.match(adapter.source, /if \(dot > 0\.9995\)/);
    assert.match(adapter.source, /const double theta = std::acos\(dot\)/);
    assert.match(
        adapter.source,
        /std::sin\(\(1\.0 - amount\) \* theta\)/,
    );
    // Deformation runs on the GPU or not at all. The transcribed
    // palette's 64-matrix cap is the transport's limit, so a larger skin
    // is refused at load rather than deformed CPU-side; a composed
    // skeleton variant lifts the cap by carrying the pin's own per-bone
    // texture, and emits no refusal at all.
    assert.match(adapter.source, /\.joints\.size\(\) > 64/);
    assert.match(
        adapter.source,
        /Skin exceeds the 64-matrix vertex-stage bone/,
    );
    assert.match(adapter.source, /\.gpu_deformation = true;/);
    assert.match(
        adapter.source,
        /asset\.clone_mesh_animation =/,
    );
    assert.match(
        adapter.source,
        /found->skin ==\s*std::numeric_limits<std::size_t>::max\(\)/,
    );
    assert.match(
        adapter.source,
        /AnimatedMeshBinding binding = \*found;/,
    );
    assert.doesNotMatch(adapter.source, /pal::load_glb/);
});

test("generated animated world bounds do not shadow the node-world cache", () => {
    const source = new GltfLowerer(new LoweringContext())
        .lowerLoaderAdapter({ animatedWorldBounds: true })
        .source;
    assert.match(source, /std::vector<Matrix> world\(node_json\.size\(\)\)/);
    assert.match(source, /const Vec3 world_corner = transform_point\(/);
    assert.doesNotMatch(source, /const Vec3 world = transform_point\(/);
});

test("emits the opt-in bone-control chunk only when it is reached", () => {
    const plain = new GltfLowerer(new LoweringContext())
        .lowerLoaderAdapter().source;
    assert.doesNotMatch(plain, /bake_skeletons/);
    assert.doesNotMatch(plain, /get_bone_by_name/);
    assert.doesNotMatch(plain, /rest_translation/);

    const source = new GltfLowerer(new LoweringContext())
        .lowerLoaderAdapter({ boneControl: true }).source;
    // One skeleton per node carrying both a skin and mesh primitives, and
    // the asset-wide override slot per node the bake reads.
    assert.match(source, /skin_groups\.emplace_back\(binding\.node, binding\.skin\)/);
    assert.match(
        source,
        /asset\.bone_overrides\.assign\(\s*animation_runtime->nodes\.size\(\), BoneOverride\{\}\)/,
    );
    // The bake resets to the authored rest pose, applies the one override
    // phase this slice reaches, then composes the palettes. The hidden bit
    // comes from the pin's own guard, so it is asserted as the value that
    // module declares rather than as a literal typed here — and the three
    // transform bits are absent, because no lowered setter can set one.
    assert.match(
        source,
        /translation\[index\] = node\.rest_translation;/,
    );
    assert.doesNotMatch(source, /mask &\s*(1|2|4)u/);
    assert.match(
        source,
        /mask &\s*8u\) != 0u\) \{\s*scaling\[index\] = Vec3\{0\.0f, 0\.0f, 0\.0f\};/,
    );
    assert.match(
        source,
        /native_matrix\(\s*multiply_matrix\(\s*bake_world\(skin\.joints\[joint\]\),/,
    );
    // The two entry points, and the show arm's own rules: clear the bit,
    // drop an override the clear emptied, re-bake only when there was one.
    assert.match(source, /BoneHandle get_bone_by_name\(/);
    assert.match(source, /if \(\(entry\.mask & 8u\) == 0u\) return;/);
    assert.match(
        source,
        /entry\.mask &= ~static_cast<std::uint32_t>\(8u\);/,
    );
    // A skinned file with no animations carries no skin runtime here, so
    // that pairing is refused by name rather than silently empty.
    assert.match(source, /if \(!animated && !skin_json\.empty\(\)\)/);
});

test("generates the Babylon loader adapter from pinned scene semantics", () => {
    const lowered = new BabylonLowerer(
        new LoweringContext(),
    ).lowerLoaderAdapter();
    assert.match(lowered.source, /AssetHandle load_babylon/);
    assert.match(lowered.source, /material\.standard_material = true/);
    assert.match(lowered.source, /material\.alpha_cutoff = 0\.4f/);
    assert.match(lowered.source, /result\.sampler\.max_anisotropy = 4\.0f/);
    assert.match(lowered.source, /engine\.reflection_cubes/);
    assert.match(lowered.source, /PrimitiveKind::babylon/);
    assert.match(lowered.source, /create_free_camera/);
    // The pivot bake applies the world basis through the shared emitted
    // pair, not a loader-local copy of the multiply.
    assert.match(
        lowered.source,
        /upstream::transform_position\(\n\s*local_matrix, source_position\)/,
    );
    assert.doesNotMatch(
        lowered.source,
        /Vec3 transform_point\(/,
    );
});

test("generates engine API wrappers over the PAL", () => {
    const lowered = new EngineLowerer(new LoweringContext()).lowerCore();
    assert.match(lowered.source, /return pal::create_engine/);
    assert.match(lowered.source, /pal::run_engine\(engine\)/);
    assert.match(lowered.source, /BBLITE_ASSET_DIR/);
    assert.match(lowered.source, /environment_variable\("BBLITE_ASSET_DIR"\)/);
    assert.match(lowered.source, /pal::executable_directory\(\)/);
});

test("lowers the torus knot through its own closure and one rounding", () => {
    // The fifth grown-array builder, and the first whose local closure
    // RETURNS a value: `getPos(angle)` hands back the curve point as a
    // `[number, number, number]` the body binds whole and then indexes.
    // Each assertion below is a fact the PIN states, so a pin that moves the
    // curve, the frame or the rounding boundary fails here rather than at a
    // parity number.
    const lowered = new FactoryLowerer(new LoweringContext())
        .lowerMeshFactories(["mesh:torus-knot"]);

    // The closure lands as a function of its own, taking the three builder
    // locals it closes over -- and only those three.
    assert.match(
        lowered.source,
        /static std::array<double, 3> pinned_torus_knot_pos\(\s*double angle,\s*double radius,\s*double p,\s*double q\)/,
    );
    // Its whole chain is the pin's JavaScript-number width; nothing in the
    // curve or the frame narrows.
    const helperStart = lowered.source.indexOf(
        "static std::array<double, 3> pinned_torus_knot_pos",
    );
    const helper = lowered.source.slice(
        helperStart,
        lowered.source.indexOf("\n}", helperStart),
    );
    assert.ok(helperStart >= 0);
    assert.doesNotMatch(helper, /static_cast<float>/);

    // The builder binds each returned point whole rather than recomputing it.
    assert.match(
        lowered.source,
        /const std::array<double, 3> p1 = pinned_torus_knot_pos\(u, radius, p, q\);/,
    );
    assert.match(
        lowered.source,
        /const std::array<double, 3> p2 = pinned_torus_knot_pos\(\(u \+ 0\.01\), radius, p, q\);/,
    );

    // The curve's `(q / p) * angle` and the tube's `-tube * cos(v)`, from
    // the pin rather than restated.
    assert.match(lowered.source, /const double quOverP = \(\(q \/ p\) \* angle\);/);
    assert.match(lowered.source, /const double cx = \(\(-tube\) \* std::cos\(v\)\);/);

    // The wraps are JavaScript `%` on numbers, which is `fmod` and not `%`.
    assert.match(lowered.source, /std::fmod\(i, radialSegments\)/);
    assert.match(lowered.source, /std::fmod\(\(j \+ 1\.0\), tubularSegments\)/);

    // Normals come from the SHARED accumulator, not a copy of its body.
    assert.match(
        lowered.source,
        /std::vector<double> normals = pinned_compute_normals\(positions, indices\);/,
    );
    assert.equal(
        lowered.source.match(
            /static std::vector<double> pinned_compute_normals/g,
        )?.length,
        1,
    );

    // One rounding boundary, and it is the pin's own typed-array store --
    // spelled `new Float32Array(...)` here where the disc spells `new F32`.
    const builderStart = lowered.source.indexOf(
        "static PinnedMeshData pinned_create_torus_knot_data",
    );
    const builder = lowered.source.slice(
        builderStart,
        lowered.source.indexOf("\n}", builderStart),
    );
    assert.ok(builderStart >= 0);
    assert.doesNotMatch(builder, /static_cast<float>/);
    assert.match(builder, /bbl::js::f32_array_from\(positions\)/);
    assert.match(builder, /bbl::js::u32_array_from\(indices\)/);

    // The mesh finishes through the shared `create_mesh_from_data` under the
    // pinned factory's own name, and the conversion helper it needs arrives
    // with it.
    assert.match(lowered.source, /#include <bblite\/js_data\.hpp>/);
    assert.match(
        lowered.source,
        /MeshHandle create_torus_knot\(Engine& engine, TorusKnotOptions options\)/,
    );
    assert.match(lowered.source, /"torusKnot"/);
});

test("emits the torus knot only where a scene reached it", () => {
    // The family rule: a builder costs nothing to a scene that never calls
    // it, and the shared accumulator follows whoever needs it.
    const bare = new FactoryLowerer(new LoweringContext())
        .lowerMeshFactories([]);
    assert.doesNotMatch(bare.source, /pinned_create_torus_knot_data/);
    assert.doesNotMatch(bare.source, /pinned_torus_knot_pos/);
    assert.doesNotMatch(bare.source, /pinned_compute_normals/);
    assert.doesNotMatch(bare.source, /#include <bblite\/js_data\.hpp>/);
});

test("generates mesh and standard-material factories from upstream defaults", () => {
    const lowerer = new FactoryLowerer(new LoweringContext());
    const mesh = lowerer.lowerMeshFactories();
    const material = lowerer.lowerStandardMaterialFactory();
    const grid = lowerer.lowerGridMaterialFactory();
    const shader = lowerer.lowerShaderMaterialFactory();
    assert.match(mesh.source, /create_box\(Engine& engine, BoxOptions options\)/);
    assert.match(mesh.source, /mesh\.dimensions = Vec3\{width, height, depth\}/);
    assert.match(mesh.source, /geometry\.vertices\.insert/);
    assert.match(mesh.source, /vertex\.local_position = vertex\.position/);
    assert.match(mesh.source, /const double subdivisions = options\.subdivisions/);
    assert.match(mesh.source, /pinned_create_flat_ground_data/);
    assert.match(mesh.source, /static_cast<std::uint32_t>\(bottomRight\)/);
    // The translated pin builds the position from the unrounded normal, not
    // from the float it just stored, so the product names the double local.
    assert.match(
        mesh.source,
        /static_cast<float>\(\(rx \* nx\)\)/,
    );
    assert.match(mesh.source, /pinned_create_torus_data/);
    assert.match(mesh.source, /options\.diameter_y/);
    assert.match(mesh.source, /mesh\.geometry =/);
    assert.match(mesh.source, /create_plane\(Engine& engine, PlaneOptions options\)/);
    assert.match(mesh.source, /create_torus\(Engine& engine, TorusOptions options\)/);
    assert.match(mesh.source, /Vec2\{1\.0f, 1\.0f\}/);
    // The dynamic thin-instance path: the pool adopts the caller's named
    // array, and the per-frame helpers copy the pinned [0, count) dirty
    // range and bump the version the PAL sync gates on.
    assert.match(
        mesh.source,
        /record\.instance_source = &matrices/,
    );
    assert.match(
        mesh.source,
        /void set_thin_instance_count\(/,
    );
    assert.match(
        mesh.source,
        /void flush_thin_instances\(/,
    );
    assert.match(
        mesh.source,
        /record\.instance_version \+= 1/,
    );
    assert.match(material.source, /material\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/);
    assert.match(material.source, /material\.standard_material = true/);
    // `MaterialRecord::alpha_cutoff` defaults to the glTF MASK cutoff the
    // loader wants; the pin's factory ships `alphaCutOff: 0`, so a
    // scene-created Standard material alpha-tests nothing. Folded from the
    // same declaration as the six defaults beside it rather than left to
    // the record's own initializer.
    assert.match(material.source, /material\.alpha_cutoff = 0\.0f/);
    assert.match(grid.source, /material\.grid_material = true/);
    assert.match(grid.source, /std::round\(options\.major_unit_frequency\)/);
    assert.match(grid.source, /options\.opacity < 1\.0f/);
    assert.match(grid.source, /material\.grid_use_max_line/);
    assert.match(
        shader.source,
        /upstream::shader_variant_info\(variant\)/,
    );
    assert.match(
        shader.source,
        /material\.double_sided = !info\.back_face_culling/,
    );
    assert.match(
        shader.source,
        /material\.shader_uniform_values = info\.defaults/,
    );
    assert.match(
        shader.source,
        /void set_shader_uniform_values\(/,
    );
    assert.match(shader.source, /set_alpha_to_coverage/);
});

test("generates reached PBR material scalar fields", () => {
    const material = new FactoryLowerer(
        new LoweringContext(),
    ).lowerPbrMaterialFactory();
    assert.match(material.source, /material\.metallic_factor/);
    assert.match(material.source, /material\.roughness_factor/);
    assert.match(material.source, /material\.direct_intensity/);
    assert.match(material.source, /material\.environment_intensity/);
    assert.match(material.source, /material\.reflectance/);
    assert.match(
        material.source,
        /material\.specular_aa = options\.specular_aa/,
    );
    assert.match(material.source, /material\.has_ior = false/);
    assert.match(
        material.source,
        /material\.use_thickness_as_depth = options\.use_thickness_as_depth/,
    );
    assert.match(material.source, /material\.has_volume = options\.has_volume/);
    assert.match(material.source, /void set_pbr_subsurface\(/);
    assert.match(material.source, /record\.has_subsurface = true/);
    assert.match(
        material.source,
        /record\.subsurface_diffusion_distance = diffusion_distance/,
    );
    assert.match(
        material.source,
        /record\.thickness_texture = std::move\(thickness_texture\.data\)/,
    );
    // The alpha-mode rule lives in one native helper shared with the
    // write-site re-derivation, so the factory calls it rather than
    // restating the predicate.
    assert.match(
        material.source,
        /derive_material_alpha_mode\(material\);/,
    );
});

test("generates no-color material views from pinned view flags", () => {
    const lowered = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNoColorMaterialViews();
    assert.match(lowered.source, /create_standard_no_color_material_view/);
    assert.match(lowered.source, /create_pbr_no_color_material_view/);
    assert.match(lowered.source, /view\.no_color = true/);
    assert.match(lowered.source, /mark_material_ubo_dirty/);
});

test("generates the public hemispheric light factory from upstream defaults", () => {
    const lowerer = new LightLowerer(new LoweringContext());
    const lowered = lowerer.lowerFactory();
    const point = lowerer.lowerPointFactory();
    const directional = lowerer.lowerDirectionalFactory();
    assert.match(lowered.source, pinnedProvenance());
    assert.match(lowered.source, /light\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/);
    assert.match(lowered.source, /light\.ground_color = Color3\{0\.0f, 0\.0f, 0\.0f\}/);
    assert.match(point.source, /light\.kind = LightKind::point/);
    assert.match(point.source, /light\.position = position/);
    assert.match(point.source, /light\.range = std::numeric_limits<float>::max\(\)/);
    assert.match(point.source, /void set_point_light_position\(/);
    assert.match(
        directional.source,
        /light\.kind = LightKind::directional/,
    );
    assert.match(
        directional.source,
        /local_matrix_from_direction/,
    );
});

test("default camera framing consumes scene mesh bound overrides", () => {
    const lowered = new CameraLowerer(
        new LoweringContext(),
    ).lowerDefaultFactory();
    assert.match(
        lowered.source,
        /if \(mesh\.has_bounds_min_override\) local_min = mesh\.bounds_min_override;/,
    );
    assert.match(
        lowered.source,
        /if \(mesh\.has_bounds_max_override\) local_max = mesh\.bounds_max_override;/,
    );
});

test("keeps generated light colors available to typed entry assignments", () => {
    const directional = new LightLowerer(
        new LoweringContext(),
    ).lowerDirectionalFactory();
    assert.match(
        directional.source,
        /light\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/,
    );
    assert.match(
        directional.source,
        /light\.specular_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/,
    );
});

test("generates ArcRotate and default camera factories from upstream constants", () => {
    const lowerer = new CameraLowerer(new LoweringContext());
    const arc = lowerer.lowerArcRotateFactory();
    const framing = lowerer.lowerDefaultFactory();
    const free = lowerer.lowerFreeFactory();
    const controls = lowerer.lowerControls();
    assert.match(arc.source, /camera\.fov = 0\.8;/);
    assert.match(arc.source, /camera\.angular_sensibility = 1000\.0;/);
    assert.match(arc.source, /sine_beta = 0\.0001;/);
    assert.match(arc.header, /arc_rotate_eye_position/);
    assert.match(arc.header, /camera_world_matrix/);
    assert.match(framing.source, /radius = diagonal \* 1\.5f/);
    assert.match(framing.source, /record\.near_plane = radius \* 0\.01;/);
    assert.match(framing.source, /record\.far_plane = radius \* 1000\.0;/);
    assert.match(free.source, /camera\.kind = CameraKind::free/);
    assert.match(free.source, /camera\.angular_sensibility = 2000\.0;/);
    assert.match(controls.source, /rotation_epsilon = 0\.001;/);
    assert.match(controls.source, /camera\.inertial_alpha_offset \*= camera\.inertia/);
    assert.match(
        controls.source,
        /if \(has_movement \|\| has_rotation\) \{\s*camera\.target = Vec3d/,
    );
    const ortho = lowerer.lowerOrthographic();
    assert.equal(ortho.modulePath, "src/camera/orthographic.ts");
    assert.match(ortho.source, /record\.orthographic = true/);
    assert.match(
        ortho.source,
        /record\.ortho_half_height = half_height/,
    );
    // The bounds object the pinned entry point returns stays reachable
    // as the camera it was enabled on.
    assert.match(ortho.source, /return camera;/);
});

test("lowers the reverse-Z orthographic projection from its pinned writer", () => {
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({ orthographicCamera: true });
    // src/math/mat4-ortho-lh-to-ref.ts translated whole — all sixteen
    // stores from the pinned declaration's own AST, double locals, one
    // f32 rounding per store — with the planes src/camera/orthographic.ts
    // derives from the half-extent folded at the call site.
    assert.match(plan.source, /if \(camera\.orthographic\) \{/);
    assert.match(
        plan.source,
        /const double half_width =\s*half_height \* static_cast<double>\(aspect\);/,
    );
    assert.match(
        plan.source,
        /void mat4_ortho_off_center_lh_to_ref\(\n    std::array<float, 16>& out,\n    double left,\n    double right,\n    double bottom,\n    double top,\n    double near_plane,\n    double far_plane\)/,
    );
    assert.match(
        plan.source,
        /out\[static_cast<std::size_t>\(0\.0\)\] = static_cast<float>\(\(2\.0 \/ \(right - left\)\)\);/,
    );
    assert.match(
        plan.source,
        /out\[static_cast<std::size_t>\(12\.0\)\] = static_cast<float>\(\(\(left \+ right\) \/ \(left - right\)\)\);/,
    );
    assert.match(
        plan.source,
        /out\[static_cast<std::size_t>\(10\.0\)\] = static_cast<float>\(\(\(-1\.0\) \/ range\)\);/,
    );
    assert.match(
        plan.source,
        /out\[static_cast<std::size_t>\(14\.0\)\] = static_cast<float>\(\(far_plane \/ range\)\);/,
    );
    assert.match(
        plan.source,
        /mat4_ortho_off_center_lh_to_ref\(\n\s*projection,\n\s*-half_width,/,
    );
    // A perspective-only scene keeps the branch and the writer out of its
    // plan.
    const perspective = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan();
    assert.doesNotMatch(
        perspective.source,
        /camera\.orthographic/,
    );
    assert.doesNotMatch(perspective.source, /mat4_ortho/);
});

test("translates the pinned perspective writer whole for every plan", () => {
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan();
    // src/math/mat4-perspective-lh-to-ref.ts: the five lanes from the
    // pinned AST, `Math.tan` as std::tan over doubles, near/far spelled
    // around the Windows macro names.
    assert.match(
        plan.source,
        /void mat4_perspective_lh_to_ref\(\n    std::array<float, 16>& out,\n    double fov,\n    double aspect,\n    double near_plane,\n    double far_plane\)/,
    );
    assert.match(
        plan.source,
        /const double tan = \(1\.0 \/ std::tan\(\(fov \* 0\.5\)\)\);/,
    );
    assert.match(
        plan.source,
        /out\[static_cast<std::size_t>\(10\.0\)\] = static_cast<float>\(\(\(-near_plane\) \/ range\)\);/,
    );
    assert.match(
        plan.source,
        /out\[static_cast<std::size_t>\(14\.0\)\] = static_cast<float>\(\(\(far_plane \* near_plane\) \/ range\)\);/,
    );
    assert.match(
        plan.source,
        /mat4_perspective_lh_to_ref\(\n\s*projection,\n\s*camera\.fov,/,
    );
    // The hand-typed transcription is gone.
    assert.doesNotMatch(plan.source, /const double focal/);
});

test("lowers the reachable upstream light matrix implementation", () => {
    const lowered = new LightLowerer(new LoweringContext()).lowerMatrix();
    assert.equal(lowered.modulePath, "src/light/light-matrix.ts");
    assert.match(lowered.source, /std::sqrt/);
    // The pinned body computes in JavaScript numbers: double locals, the
    // NaN-aware value-selecting `||`, and a single rounding cast at each
    // Float32Array store.
    assert.match(lowered.source, /const double flen = bbl::js::or_number\(/);
    assert.match(lowered.source, /const double dx = static_cast<double>\(dx_f32\)/);
    assert.match(
        lowered.source,
        /out\[static_cast<std::size_t>\(15\.0\)\] = static_cast<float>\(1\.0\)/,
    );
    assert.doesNotMatch(lowered.source, /nonzero_or/);
    assert.doesNotMatch(lowered.source, /const float/);
    assert.match(lowered.source, pinnedProvenance());
});

test("emits the pinned surface sample count for every scene shape", () => {
    const header = pinnedSurfaceHeader(new LoweringContext(), 4);
    assert.match(
        header,
        /inline std::uint32_t preferred_sample_count\(\) \{\s*return 4u;/,
    );
    assert.match(header, pinnedProvenance());

    const singleSampleHeader = pinnedSurfaceHeader(
        new LoweringContext(),
        1,
    );
    assert.match(
        singleSampleHeader,
        /inline std::uint32_t preferred_sample_count\(\) \{\s*return 1u;/,
    );
    assert.match(singleSampleHeader, pinnedProvenance());
});

test("emits the world-basis pair and pinned determinant once for every scene shape", () => {
    const header = pinnedWorldTransformHeader(new LoweringContext());
    // The float pair, term for term the pinned vertex stage's multiply:
    // rows read down a column-major basis column, translation only on the
    // position arm. Inline, because the PAL and both loaders include this
    // from separate translation units.
    assert.match(
        header,
        /inline Vec3 transform_position\(\n    const std::array<float, 16>& world,\n    Vec3 value\)/,
    );
    assert.match(
        header,
        /world\[0\] \* value\.x \+ world\[4\] \* value\.y \+ world\[8\] \* value\.z \+\n            world\[12\]/,
    );
    assert.match(
        header,
        /inline Vec3 transform_direction\(\n    const std::array<float, 16>& world,\n    Vec3 value\)/,
    );
    assert.match(
        header,
        /world\[2\] \* value\.x \+ world\[6\] \* value\.y \+ world\[10\] \* value\.z,\n    \};/,
    );
    // The determinant is the pin's own fold — double, expanded along the
    // first basis COLUMN (m[0], m[1], m[2] cofactors joined by +), which is
    // what makes the load-time and run-time mirror answers round alike.
    assert.match(
        header,
        /inline double pinned_mat4_determinant3\(\n    const std::array<float, 16>& m\)/,
    );
    assert.match(
        header,
        /m\[static_cast<std::size_t>\(5\.0\)\]\) \* static_cast<double>\(m\[static_cast<std::size_t>\(10\.0\)\]\)/,
    );
    assert.match(header, pinnedProvenance());
    assert.match(header, /namespace bbl::upstream \{/);
});

test("emits the pinned depth convention and anchors both projection writers", () => {
    // The header derives compare and clear from the pin, and generation
    // refuses if either pinned projection writer stops mapping
    // near -> 1 / far -> 0 -- the convention this header's consumers
    // (dither seeds, near-plane handling) key to a far plane of 0.
    const header = pinnedDepthStateHeader(new LoweringContext());
    assert.match(
        header,
        /pinned_depth_compare =\s*DepthCompare::greater_equal;/,
    );
    assert.match(header, /pinned_depth_clear = 0\.0f;/);
    assert.match(header, pinnedProvenance());
});

test("lowers the pinned inverse image processing whole", () => {
    const header = pinnedInverseImageProcessingHeader(new LoweringContext());
    // The whole chain, from the pinned declaration's own AST: the clamp
    // helper, the contrast bisection loop, the `**` gamma as std::pow, the
    // tone-mapping division by the pin's own literal, and the exposure
    // conditional -- every intermediate at the f64 width the pin computes at.
    assert.match(header, /inline double clamp01\(/);
    assert.match(
        header,
        /inline double inverse_image_processed_channel\(\n    double value,\n    double exposure,\n    double contrast,\n    bool tone_mapping\)/,
    );
    assert.match(header, /double c = clamp01\(value\);/);
    assert.match(header, /for \(std::int64_t i = /);
    assert.match(header, /c = std::pow\(c, 2\.2\)/);
    assert.match(header, /\/ 1\.5905790328979492\)/);
    assert.match(
        header,
        /\(\(exposure > 0\.0\) \? \(c \/ exposure\) : c\)/,
    );
    assert.doesNotMatch(header, /float/);
    assert.match(header, pinnedProvenance());
});

test("generates the render plan from upstream frame-graph binding semantics", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const lowered = lowerer.lowerRenderPlan({
        shaderPrograms: reachedPrograms([
            "alpha-card",
            "circular-cutout",
        ]),
    });
    const specialized = lowerer.lowerRenderPlan({
        gpuInstancing: true,
        punctualLights: true,
    });
    const shaders = lowerer.lowerShaders();
    const fidelity = lowerer.fidelityManifest();
    assert.equal(lowered.modulePath, "src/frame-graph/render-task.ts");
    assert.match(lowered.header, /struct RenderItem/);
    assert.match(lowered.header, /enum class RenderMaterialKind/);
    assert.match(lowered.header, /enum class RenderBucket/);
    assert.match(lowered.header, /enum class RenderCullMode/);
    assert.match(lowered.header, /enum class RenderStage/);
    assert.match(
        lowered.header,
        /RenderStage::skybox,[\s\S]*RenderStage::opaque,[\s\S]*RenderStage::transparent,[\s\S]*RenderStage::ground/,
    );
    assert.match(lowered.header, /enum class RenderPipelineKind/);
    assert.match(lowered.header, /struct RenderDrawCommand/);
    assert.match(lowered.header, /struct RenderDrawLists/);
    assert.match(lowered.header, /struct RenderFeatures/);
    // The punctual-light extras lanes left PbrUniforms with the RD-3
    // prune; the pinned variant blocks carry the analytic lights now.
    assert.doesNotMatch(
        specialized.header,
        /extra_light_positions/,
    );
    assert.match(lowered.source, /build_render_plan/);
    assert.match(
        lowered.source,
        /void initialize_composition_feature_rows\(Engine& engine\)/,
    );
    assert.match(
        lowered.source,
        /mesh\.composition_feature_row = next_row\+\+;/,
    );
    assert.match(
        lowered.source,
        /engine\.meshes\[mesh\.feature_source_mesh\][\s\S]*?\.composition_feature_row;/,
    );
    assert.match(
        lowered.source,
        /item\.bucket == RenderBucket::alpha_blend \|\|\s*item\.transmissive/,
    );
    assert.match(lowered.source, /build_render_draw_lists/);
    assert.match(lowered.source, /build_render_task_draw_lists/);
    assert.match(
        lowered.source,
        /task\.kind == FrameTaskKind::geometry/,
    );
    assert.match(
        lowered.source,
        /item\.material_kind != RenderMaterialKind::pbr &&\s*item\.material_kind != RenderMaterialKind::standard/,
    );
    assert.match(lowered.source, /build_render_features/);
    // Variant ids index the generated table in reach order; the cutout
    // reflects a vertex-only system block and declares no samplers.
    assert.match(
        lowered.source,
        /"circular-cutout",[\s\S]*?ShaderVariantStageBlock\{true, \{ShaderSystemMatrix::world_view_projection\}, 16u, \{\}\},\s*\r?\n\s*ShaderVariantStageBlock\{false, \{\}, 0u, \{\}\},\s*\r?\n\s*\{\},/,
    );
    // The alpha-card entry carries the historical native defaults
    // (depth 0.5, opacity 1.0) at their declaration-order value offsets
    // and gathers both stage blocks from the flat storage.
    assert.match(
        lowered.source,
        /"alpha-card"[\s\S]*?\{0\.0f, 0\.0f, 0\.0f, 0\.5f, 0\.0f, 0\.0f, 0\.0f, 1\.0f\}/,
    );
    assert.match(
        lowered.source,
        /const ShaderVariantInfo& shader_variant_info\(std::uint32_t variant\)/,
    );
    assert.match(lowered.source, /features\.grid_material/);
    assert.match(lowered.source, /features\.no_color_material/);
    assert.match(lowered.source, /std::stable_sort/);
    assert.match(lowered.source, /bind_render_item/);
    assert.match(lowered.source, /sort_transparent_draws/);
    assert.match(
        lowered.source,
        /left\.sort_distance > right\.sort_distance/,
    );
    assert.match(lowered.source, /left\.item\.order < right\.item\.order/);
    assert.match(
        lowered.source,
        /material\.alpha_mode == MaterialAlphaMode::blend/,
    );
    assert.match(lowered.source, /material\.standard_material/);
    assert.match(lowered.source, /material\.grid_material/);
    assert.match(
        lowered.source,
        /RenderPipelineKind::grid_transparent_none/,
    );
    assert.match(
        lowered.source,
        /RenderPipelineKind::pbr_opaque_none_clockwise/,
    );
    assert.match(lowered.source, /build_pbr_uniforms/);
    assert.doesNotMatch(
        lowered.source,
        /result\.light_color = \{1\.0f, 1\.0f, 1\.0f, 1\.0f\};/,
    );
    assert.match(
        lowered.source,
        /result\.material_options\[3\] = material\.double_sided \? 1\.0f : 0\.0f/,
    );
    assert.match(lowered.source, /result\.normal_options\[0\] = 1\.0f/);
    assert.match(lowered.source, /result\.normal_options\[1\]/);
    assert.match(lowered.source, /build_background_plan/);
    assert.match(
        lowered.source,
        /result\.background_center = \{\s*0\.0f,\s*0\.0f,\s*0\.0f,/,
    );
    assert.match(lowered.source, /build_skybox_plan/);
    assert.match(
        lowered.source,
        /const Vec3 center = environment\.skybox_uses_environment/,
    );
    assert.match(
        lowered.source,
        /: environment\.skybox_position;/,
    );
    assert.match(lowered.source, /build_skybox_view_projection/);
    // preferred_sample_count moved to the always-emitted pinned_surface.hpp
    // so effect-only scenes carry it too; the plan defines it nowhere.
    assert.doesNotMatch(lowered.source, /preferred_sample_count/);
    assert.match(lowered.header, /struct PbrUniforms/);
    assert.match(lowered.source, /mesh\.geometry >= engine\.geometries\.size\(\)/);
    assert.match(lowered.source, pinnedProvenance());
    // The transcribed PBR fragment is retired: PBR draws run the pin's own
    // composed variants, so the emitted set carries the shared material
    // vertex and no pbr.frag.
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("pbr.vert.native.wgsl"),
        ),
    );
    assert.ok(
        !shaders.some((shader) =>
            shader.output.endsWith("pbr.frag.native.wgsl"),
        ),
    );
    assert.ok(
        shaders.every((shader) => /\.(?:hlsl|msl|wgsl)$/.test(shader.output)),
    );
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("alpha-card.vert.native.wgsl"),
        ),
    );
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("circular-cutout.frag.native.wgsl"),
        ),
    );
    assert.equal(fidelity.sourceLanguage, "WGSL");
    assert.deepEqual(fidelity.compiledArtifacts, ["DXIL", "SPIR-V"]);
    assert.ok(fidelity.invariants.some(({ id }) => id === "rgbd-cubemap-y-flip"));
    assert.ok(fidelity.invariants.some(({ id }) => id === "surface-msaa"));
    assert.ok(fidelity.invariants.some(({ id }) => id === "pbr-skybox-mode"));
    assert.ok(
        fidelity.invariants.some(
            ({ id }) => id === "scene-color-transmission",
        ),
    );
    assert.ok(fidelity.invariants.some(({ id }) => id === "ior-fresnel"));
    assert.ok(
        fidelity.invariants.some(({ id }) => id === "volume-beer-lambert"),
    );
    assert.ok(
        fidelity.invariants.some(
            ({ id }) => id === "ibl-horizon-occlusion",
        ),
    );
    assert.ok(
        fidelity.invariants.some(
            ({ id }) => id === "ibl-specular-occlusion",
        ),
    );
    assert.ok(
        fidelity.invariants.some(
            ({ id }) => id === "brdf-lut-coordinates",
        ),
    );
    assert.ok(
        fidelity.invariants.some(
            ({ id }) => id === "environment-cubemap-orientation",
        ),
    );
});

test("composes the thin-instance parent world from the pinned TRS formulas", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const plan = lowerer.lowerRenderPlan({ gpuInstancing: true });
    assert.match(
        plan.header,
        /build_instance_parent_world\(\s*const MeshRecord& mesh\)/,
    );
    // mat4ComposeInto's quaternion basis, eulerToQuat's half-angle terms
    // and products, and the whole-translated mat4_multiply_into all flow
    // from the pinned ASTs (through the shared PinnedNumericLowerer, whose
    // parenthesization is explicit); the record's own transform never
    // reaches the helper for non-thin-instanced meshes.
    assert.match(
        plan.source,
        /\(\(1\.0 - \(2\.0 \* \(yy \+ zz\)\)\) \* scale_x\)/,
    );
    assert.match(
        plan.source,
        /qx = \(\(\(sx \* cy\) \* cz\) \+ \(\(cx \* sy\) \* sz\)\);/,
    );
    assert.match(
        plan.source,
        /if \(!mesh\.thin_instanced\) \{\s*\r?\n\s*return mesh\.instance_parent_matrix;/,
    );
    // Both analytic slots fold material.directIntensity like the pinned
    // single-light and extra-light terms.
    assert.match(
        plan.source,
        /result\.light_color\[3\] \*= material\.direct_intensity;/,
    );
    assert.match(
        plan.source,
        /result\.light_color_2\[3\] \*= material\.direct_intensity;/,
    );
    const withoutInstancing = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    assert.doesNotMatch(
        withoutInstancing.header,
        /build_instance_parent_world/,
    );
});

test("emits only reached WGSL composition modules", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const shaders = lowerer.lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: [],
        gridMaterial: true,
        idDiagnostics: false,
        geometryOutputTasks: [],
    });
    const modules = shaders
        .filter(({ output }) => output.endsWith(".wgsl"))
        .map(({ output }) => output);
    assert.ok(modules.includes("upstream/shaders/pbr.vert.native.wgsl"));
    assert.ok(modules.includes("upstream/shaders/grid.vert.native.wgsl"));
    assert.ok(modules.includes("upstream/shaders/grid.frag.native.wgsl"));
    assert.ok(!modules.some((output) => output.includes("standard")));
    assert.ok(!modules.some((output) => output.includes("background")));
});

test("generates portable GridMaterial shaders from pinned formulas", () => {
    const shaders = new RendererLowerer(
        new LoweringContext(),
    ).lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: [],
        gridMaterial: true,
        idDiagnostics: false,
        geometryOutputTasks: [],
    });
    const wgsl = shaders.find((shader) =>
        shader.output.endsWith("grid.frag.native.wgsl"),
    );
    assert.match(String(wgsl?.data), /gridDynamicVisibility/);
    assert.match(
        String(wgsl?.data),
        pinnedProvenance(),
    );
    // The pin's own built statements, spelled as the template emits them.
    assert.match(String(wgsl?.data), /cos\(fr\*PI\)/);
    assert.match(String(wgsl?.data), /SQRT2\/4\.0/);
    assert.match(String(wgsl?.data), /max\(max\(x,y\),z\)/);
    assert.match(String(wgsl?.data), /dpdx\(position\)/);
    assert.match(String(wgsl?.data), /shaderUniforms\.gridControl\.w\*grid/);
    assert.ok(
        !shaders.some(
            (shader) =>
                shader.output.includes("grid.") &&
                /\.(?:hlsl|msl)$/.test(shader.output),
        ),
    );
});

test("generates typed geometry task records and PBR MRT shaders", () => {
    const tasks = new GeometryOutputLowerer(
        new LoweringContext(),
    ).lowerTaskRecords();
    const targets = new RenderTargetLowerer(
        new LoweringContext(),
    ).lower();
    const shaders = new RendererLowerer(new LoweringContext()).lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: [],
        idDiagnostics: false,
        geometryOutputTasks: [
            {
                shaderIndex: 0,
                attachments: [
                    "IRRADIANCE",
                    "WORLD_POSITION",
                    "NORMALIZED_VIEW_DEPTH",
                    "VIEW_NORMAL",
                    "WORLD_NORMAL",
                    "REFLECTIVITY",
                    "ALBEDO",
                ],
                emitColor: true,
            },
        ],
    });
    assert.match(tasks.source, /create_geometry_renderer_task/);
    assert.match(tasks.source, /create_copy_to_texture_task/);
    assert.match(targets.source, /create_render_target_texture/);
    assert.match(targets.source, /swapchain_render_target/);
    assert.doesNotMatch(tasks.source, /create_render_target_texture/);
    assert.match(tasks.source, /add_render_task_mesh/);
    assert.match(tasks.source, /scene\.tasks\.insert/);
    // The rectangle itself is the runtime's, beside NormalizedViewport; what
    // this header owns is the copy task's own rounding of one.
    assert.match(
        tasks.header,
        /PixelViewport resolve_copy_viewport\(/,
    );
    assert.doesNotMatch(tasks.header, /struct PixelViewport/);
    assert.match(tasks.source, /std::floor/);
    assert.match(
        tasks.source,
        /pixel\(viewport\.x \+ viewport\.width, target_width\)/,
    );
    assert.match(
        tasks.source,
        /static_cast<std::int32_t>\(target_height\) -\s*y_top -\s*viewport_height/,
    );
    // The PBR geometry-task fragments are retired with the transcription;
    // a PBR draw in a geometry task errors at dispatch until the pin's
    // geometry view composes an arm for it.
    assert.ok(
        !shaders.some((shader) =>
            shader.output.endsWith("pbr-geometry-0.frag.native.wgsl"),
        ),
    );
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("blit.frag.native.wgsl"),
        ),
    );
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("depth-only.frag.native.wgsl"),
        ),
    );
});

test("emits no transcribed standard fragments", () => {
    // The Standard family draws through the pin's own composed variants
    // (standard_variants.hpp + variant-std-* stages); the transcribed
    // standard.frag and per-task standard-geometry-*.frag are retired.
    const shaders = new RendererLowerer(
        new LoweringContext(),
    ).lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: [],
        idDiagnostics: false,
        geometryOutputTasks: [
            {
                shaderIndex: 0,
                attachments: [
                    "IRRADIANCE",
                    "WORLD_POSITION",
                    "SCREENSPACE_DEPTH",
                    "REFLECTIVITY",
                    "ALBEDO",
                ],
                emitColor: true,
            },
        ],
    });
    assert.ok(
        !shaders.some((shader) => shader.output.includes("standard")),
    );
    // The shared material vertex stage stays: the diagnostics, depth-only
    // and background pipelines still enter it at mainVertex.
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("pbr.vert.native.wgsl"),
        ),
    );
});

test("anchors the deformation and instancing vertex arms to their pinned fragments", () => {
    // The transcribed vertex stage's skinning and thin-instance bodies are
    // marker-anchored like its storage-morph arm: running lowerShaders with
    // the arms on exercises assertPinnedShaderFormulas against the pinned
    // skeleton-fragment, thin-instance-fragment and pbr-template /*VW*/
    // application lines, so a retuned pin refuses generation here.
    const shaders = new RendererLowerer(new LoweringContext()).lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: [],
        idDiagnostics: false,
        geometryOutputTasks: [],
        gpuDeformation: true,
        morphStorage: true,
        gpuInstancing: true,
    });
    const vertex = shaders.find((shader) =>
        shader.output.endsWith("pbr.vert.native.wgsl"),
    );
    // The anchored formulas' transcribed counterparts: the sum runs to
    // exactly four influences, the normal transforms at w=0 after a
    // normalize, and the parent world composes on the left of the
    // per-instance matrix before the upper-left 3x3 carries the normal.
    assert.match(
        String(vertex?.data),
        /deformation\.boneMatrices\[u32\(input\.joints\.w\)\] \* input\.weights\.w;/,
    );
    assert.doesNotMatch(String(vertex?.data), /joints1|weights1/);
    assert.match(
        String(vertex?.data),
        /worldNormal =\s*\(skin \* vec4<f32>\(normalize\(worldNormal\), 0\.0\)\)\.xyz;/,
    );
    assert.match(
        String(vertex?.data),
        /instanceUniforms\.parentWorld \* localInstanceMatrix;/,
    );
    assert.match(
        String(vertex?.data),
        /worldNormal = instanceNormal \* worldNormal;/,
    );
});

test("emits only reached custom shader variants", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const alphaCard = lowerer.lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: reachedPrograms(["alpha-card"]),
        idDiagnostics: false,
        geometryOutputTasks: [],
    });
    assert.ok(
        alphaCard.some((shader) =>
            shader.output.endsWith("alpha-card.frag.native.wgsl"),
        ),
    );
    assert.ok(
        alphaCard.some((shader) =>
            shader.output.endsWith("alpha-card.frag.wgsl"),
        ),
    );
    assert.ok(
        !alphaCard.some((shader) =>
            shader.output.includes("circular-cutout"),
        ),
    );

    const circularCutout = lowerer.lowerShaders({
        ground: false,
        skybox: false,
        shaderPrograms: reachedPrograms(["circular-cutout"]),
        idDiagnostics: false,
        geometryOutputTasks: [],
    });
    const fragment = circularCutout.find((shader) =>
        shader.output.endsWith("circular-cutout.frag.native.wgsl"),
    );
    assert.match(String(fragment?.data), /distance\(input\.uv/);
    assert.match(String(fragment?.data), /discard/);
    assert.ok(
        !circularCutout.some((shader) => shader.output.includes("alpha-card")),
    );
    assert.ok(
        !circularCutout.some(
            (shader) =>
                shader.output.includes("circular-cutout") &&
                /\.(?:hlsl|msl)$/.test(shader.output),
        ),
    );
});

test("builds a conservative reachable module graph", () => {
    const graph = analyzeUpstreamGraph(new UpstreamSourceStore(), [
        "createHemisphericLight",
        "createDefaultCamera",
    ]);
    assert.ok(graph.summary.moduleCount > 5);
    assert.ok(graph.modules.some((module) => module.path === "src/light/light-matrix.ts"));
    assert.ok(graph.summary.diagnostics.closures > 0);
    assert.equal(graph.capabilities.explicitAnyAllowed, false);
    assert.equal(graph.capabilities.asyncAwait, "synchronous-aot");
});

test("lifts the Dawn utility WGSL from the pinned literals", () => {
    const shaders = dawnUtilityShaders(true);
    // The mip generator's blit (generate-mipmaps.ts BLIT_SHADER), split
    // per stage: the vertex file carries no bindings — the compile
    // script cross-checks declared bindings against Tint's reflection —
    // and both stages take the native entry-point names.
    assert.match(shaders.mipBlitVertex, /@vertex fn mainVertex\(/);
    assert.match(shaders.mipBlitVertex, /p\*vec2f\(\.5,-\.5\)\+\.5/);
    assert.doesNotMatch(shaders.mipBlitVertex, /@group/);
    assert.match(
        shaders.mipBlitFragment,
        /@fragment fn mainFragment\(v:V\)->@location\(0\)vec4f\{return textureSample\(t,s,v\.u\);\}/,
    );
    // The transmission grab: the MSAA arm is the pin's BLIT_MSAA_SHADER
    // text, the single-sample arm substitutes the plain binding and load
    // around the same manual-bilinear body.
    assert.match(shaders.grabFragment, /var t:texture_multisampled_2d<f32>;/);
    assert.match(shaders.grabFragment, /textureNumSamples\(t\)/);
    assert.match(shaders.grabFragmentSingle, /var t:texture_2d<f32>;/);
    assert.match(
        shaders.grabFragmentSingle,
        /fn l\(p:vec2i\)->vec4f\{return textureLoad\(t,p,0\);\}/,
    );
    for (const arm of [shaders.grabFragment, shaders.grabFragmentSingle]) {
        assert.match(arm, /mix\(mix\(l\(p\),l\(vec2i\(p1\.x,p\.y\)\),f\.x\)/);
    }
    // Per-sample image processing: the pin's ip() with its tone-mapping
    // calibration, and the pin's own two fragment arms.
    assert.match(shaders.imageProcessingFragment, /1\.590579/);
    assert.match(shaders.imageProcessingFragment, /textureNumSamples\(s\)/);
    assert.match(shaders.imageProcessingFragmentSingle, /1\.590579/);
    assert.match(
        shaders.imageProcessingFragmentSingle,
        /return ip\(textureLoad\(s,clamp\(vec2i\(q\.xy\),vec2i\(0\),vec2i\(d\)-1\),0\)\);/,
    );
    assert.match(shaders.imageProcessingVertex, /@vertex fn mainVertex\(/);
    assert.doesNotMatch(shaders.imageProcessingVertex, /@group/);
    // A scene without transmission ships only the mip blit.
    const mipOnly = dawnUtilityShaders(false);
    assert.notEqual(mipOnly.mipBlitFragment, "");
    assert.equal(mipOnly.grabFragment, "");
    assert.equal(mipOnly.imageProcessingFragment, "");
});

test("generates the sprite instance layout table from the pinned pipeline", () => {
    const core = new SpriteLowerer(new LoweringContext()).lowerCore();
    const header = String(core.header);
    // The pure-2D rows at the pin's own byte offsets
    // (sprite-pipeline.ts SPRITE_*_OFFSET_BYTES), and the stride
    // sprite-2d.ts derives from PURE_2D_INSTANCE_FLOATS_PER_SPRITE.
    assert.match(header, /struct SpriteInstanceAttribute/);
    assert.match(
        header,
        /\{0u, 0u, 2u\},\n\s*\{1u, 8u, 2u\},\n\s*\{2u, 16u, 2u\},\n\s*\{3u, 24u, 2u\},\n\s*\{4u, 32u, 1u\},\n\s*\{5u, 36u, 4u\},/,
    );
    assert.match(
        header,
        /sprite_instance_stride_bytes =\n\s*52u;/,
    );
    assert.match(
        header,
        /sprite_depth_attribute\{\n\s*6u, 52u, 1u\};/,
    );
    assert.match(
        header,
        /sprite_depth_instance_stride_bytes =\n\s*56u;/,
    );
});

test("gates pure and depth-hosted sprite vertex permutations independently", () => {
    assert.deepEqual(
        spriteVertexPermutations({
            pure: false,
            depthHosted: true,
            uvScroll: true,
        }),
        [
            {
                output: "sprite_depth.vert.native.wgsl",
                uvScroll: false,
                depthHosted: true,
            },
            {
                output: "sprite_depth_uvscroll.vert.native.wgsl",
                uvScroll: true,
                depthHosted: true,
            },
        ],
    );
    assert.deepEqual(
        spriteVertexPermutations({
            pure: true,
            depthHosted: false,
            uvScroll: true,
        }).map(({ output }) => output),
        [
            "sprite.vert.native.wgsl",
            "sprite_uvscroll.vert.native.wgsl",
        ],
    );
});

test("pins the complete synchronous Sprite2D pick-result contract", () => {
    const source = new UpstreamSourceStore().getSource(
        "src/sprite/picking/pick-sprite-2d.ts",
    );

    assert.match(
        source,
        /export interface SpritePickInfo\s*\{[\s\S]*?layer: Sprite2DLayer;[\s\S]*?spriteIndex: number;[\s\S]*?u: number;[\s\S]*?v: number;[\s\S]*?\}/,
    );
    assert.match(
        source,
        /export function pickSprite2D\([\s\S]*?\): SpritePickInfo \| null \{/,
    );
    assert.match(
        source,
        /for \(let li = layers\.length - 1; li >= 0; li--\)/,
    );
    assert.match(
        source,
        /return \{ layer, spriteIndex: i, u, v \};[\s\S]*?return null;/,
    );
});

test("pins the billboard pick contributor's whole contract", () => {
    const store = new UpstreamSourceStore();
    const wrapper = store.getSource("src/sprite/picking/pick-billboard.ts");

    // The wrapper IS the feature: one pick through the shared pass, and
    // the `_spritePick` payload the contributor hung on the info.
    assert.match(
        wrapper,
        /export async function pickBillboardSprite\(scene: SceneContext, x: number, y: number, picker\?: GpuPicker\): Promise<BillboardPickInfo \| null>/,
    );
    assert.match(wrapper, /const owned = picker \?\? createGpuPicker\(scene\);/);
    assert.match(wrapper, /return info\._spritePick \?\? null;/);
    assert.match(wrapper, /disposePicker\(owned\);/);

    const pipeline = store.getSource(
        "src/picking/billboard-pick-pipeline.ts",
    );
    // The four members the compiled call site fills, in the pin's order.
    assert.match(
        pipeline,
        /export interface BillboardPickInfo\s*\{[\s\S]*?system: BillboardSpriteSystem;[\s\S]*?spriteIndex: number;[\s\S]*?pickedPoint: \[number, number, number\] \| null;[\s\S]*?distance: number;[\s\S]*?\}/,
    );
    // One system owns `count` consecutive ids -- the fact `PickRange`
    // carries a count for, and the reason a hidden system still consumes
    // its range.
    assert.match(
        pipeline,
        /if \(!system\.visible \|\| count === 0\) \{\s*return baseId \+ count;/,
    );
    assert.match(
        pipeline,
        /info\._spritePick = \{ system, spriteIndex: localId, pickedPoint: info\.pickedPoint, distance: info\.distance \};/,
    );
    // The instance rows go up in LOGICAL order, which is what makes
    // `pickId - baseId` the sprite's own slot.
    assert.match(
        pipeline,
        /device\.queue\.writeBuffer\(res\.instanceBuffer, 0, data\.buffer, data\.byteOffset, count \* BILLBOARD_INSTANCE_STRIDE_BYTES\);/,
    );
    // The 48-byte block `build_billboard_pick_uniforms` mirrors: the
    // camera basis lifted out of the column-major view matrix.
    assert.match(
        pipeline,
        /const BILLBOARD_PICK_UBO_BYTES = 48;/,
    );
    assert.match(
        pipeline,
        /f32\[0\] = view\[0\]!;[\s\S]*?f32\[1\] = view\[4\]!;[\s\S]*?f32\[2\] = view\[8\]!;[\s\S]*?u32\[3\] = baseId;[\s\S]*?f32\[4\] = view\[1\]!;[\s\S]*?f32\[5\] = view\[5\]!;[\s\S]*?f32\[6\] = view\[9\]!;/,
    );
    // The mesh picker's depth state, not the visible billboard pass's.
    assert.match(
        pipeline,
        /depthStencil: \{ format: "depth24plus", depthCompare: "greater", depthWriteEnabled: true \}/,
    );
});

test("composes the billboard pick module by running the pin's own builder", async () => {
    const facing = await composeBillboardPickingShader("facing");
    const locked = await composeBillboardPickingShader("axis-locked");

    // Both stages travel in one module, which is why the emitter writes
    // the same text under a `.vert` and a `.frag` stem.
    for (const composed of [facing, locked]) {
        assert.match(composed, /@vertex\nfn vs\(in: I\) -> O \{/);
        assert.match(composed, /@fragment\nfn fs\(in: O\) -> FsOut \{/);
        // The non-detailed arm: two attachments, no `rgba32uint` detail.
        assert.match(
            composed,
            /struct FsOut \{ @location\(0\) color: vec4f, @location\(1\) depth: f32 \};/,
        );
        // The plain arm: no atlas, so no cutout discard either.
        assert.doesNotMatch(composed, /atlasTex/);
        assert.doesNotMatch(composed, /bb\.cutoff/);
        // The six instance attributes the native pick layout binds.
        for (const location of [0, 1, 2, 3, 4, 5]) {
            assert.match(
                composed,
                new RegExp(`@location\\(${location}\\) [a-z]: `),
            );
        }
    }
    // The basis is the only arm the reached slice forks on.
    assert.match(facing, /let u = normalize\(bb\.camUp\);\nreturn B\(r, -u\);/);
    assert.match(locked, /let a = normalize\(bb\.axis\);/);
    assert.notEqual(facing, locked);
});

test("records every pinned origin consolidated into sprite_2d.cpp", () => {
    assert.deepEqual(spriteCoreAdditionalProvenance, [
        {
            modulePath: "src/sprite/sprite-scene.ts",
            symbolName: "addDepthHostedSpriteLayer",
        },
        {
            modulePath: "src/sprite/sprite-renderable.ts",
            symbolName: "buildSpriteRenderable",
        },
        {
            modulePath: "src/render/alpha-to-coverage.ts",
            symbolName: "setAlphaToCoverage",
        },
    ]);
});

/**
 * The PBR lightmap composed through the pin, and the walk fold that decides
 * which materials reach it.
 *
 * Every arm of `createLightmapFragment` is selected by `detect` from the
 * material's own props, so what these check is that this port's stamp
 * reaches those props: the blend, the UV set, the gamma decode and the
 * V flip each move the composed text, and the fragment is the pin's own.
 */
test("composes the pinned lightmap arms the setter's props select", async () => {
    const { composePinnedPbrVariant } = await import(
        "../src/pinned-pbr-variants.js"
    );
    const { importPinnedModule } = await import(
        "../src/pinned-shader-composer.js"
    );
    const { setPbrLightmap } = await importPinnedModule<{
        setPbrLightmap: (
            material: Record<string, unknown>,
            texture: Record<string, unknown>,
            options: Record<string, unknown>,
        ) => void;
    }>("material/pbr/enable-pbr-lightmap.js");
    const { pinnedMeshFeaturesFromPrimitive } = await import(
        "../src/pinned-mesh-features.js"
    );
    const meshFeatures = await pinnedMeshFeaturesFromPrimitive({
        attributes: { POSITION: 0, NORMAL: 0, TEXCOORD_0: 0, TEXCOORD_1: 0 },
    });
    const compose = async (
        texture: Record<string, unknown>,
        options: Record<string, unknown>,
    ) => {
        const input: Record<string, unknown> = {};
        setPbrLightmap(input, texture, options);
        return composePinnedPbrVariant(input, { meshFeatures });
    };

    // Scene 167's own two arms: the glTF level multiplies a gamma-decoded
    // UV2 sample and flips V; the boxes add a gamma-decoded UV1 one.
    const shadowmap = await compose(
        { uAng: Math.PI },
        { coordIndex: 1, useAsShadowmap: true, gamma: true },
    );
    assert.match(shadowmap.fragmentKey, /(^|\|)lightmap(\||$)/);
    assert.match(
        shadowmap.fragmentWgsl,
        /color=\(color-emissive\)\*\(pow\(textureSample\(lmTexture,lmSampler,vec2<f32>\(input\.uv2\.x,1\.0-input\.uv2\.y\)\)\.rgb,vec3<f32>\(2\.2\)\)\*material\.lmLvl\)\+emissive;/,
    );
    assert.match(shadowmap.fragmentWgsl, /var lmTexture:texture_2d<f32>/);
    assert.match(shadowmap.fragmentWgsl, /lmLvl: f32,/);

    const additive = await compose(
        { uAng: Math.PI },
        { coordIndex: 0, gamma: true },
    );
    assert.match(
        additive.fragmentWgsl,
        /color\+=pow\(textureSample\(lmTexture,lmSampler,vec2<f32>\(input\.uv\.x,1\.0-input\.uv\.y\)\)\.rgb,vec3<f32>\(2\.2\)\)\*material\.lmLvl;/,
    );

    // The V flip is `!!invertY !== (uAng === Math.PI)`, so an unrotated
    // texture samples the raw UV and a rotated-and-inverted one does too.
    const plain = await compose({}, { coordIndex: 0 });
    assert.match(
        plain.fragmentWgsl,
        /color\+=textureSample\(lmTexture,lmSampler,input\.uv\)\.rgb\*material\.lmLvl;/,
    );
    const bothFlips = await compose(
        { invertY: true, uAng: Math.PI },
        { coordIndex: 0 },
    );
    assert.match(
        bothFlips.fragmentWgsl,
        /color\+=textureSample\(lmTexture,lmSampler,input\.uv\)\.rgb\*material\.lmLvl;/,
    );

    // A material nothing stamps composes no lightmap at all, which is what
    // makes registering the extension unconditionally inert.
    const none = await composePinnedPbrVariant({}, { meshFeatures });
    assert.doesNotMatch(none.fragmentWgsl, /lmTexture/);
    assert.doesNotMatch(none.fragmentKey, /lightmap/);
});

test("selects the lightmap's materials from the document's own mesh names", async () => {
    const { gltfLightmapMaterials, meshNameSelected } = await import(
        "../src/pinned-material-arms.js"
    );
    // Scene 167's filter: `name !== "level" && !name.startsWith("level_p")`
    // guards a `continue`, so the body runs for its negation.
    const predicate = {
        kind: "not" as const,
        operand: {
            kind: "and" as const,
            operands: [
                {
                    kind: "not" as const,
                    operand: { kind: "equals" as const, value: "level" },
                },
                {
                    kind: "not" as const,
                    operand: {
                        kind: "startsWith" as const,
                        value: "level_p",
                    },
                },
            ],
        },
    };
    assert.equal(meshNameSelected(predicate, "level"), true);
    assert.equal(meshNameSelected(predicate, "level_primitive1"), true);
    assert.equal(meshNameSelected(predicate, "Cube.001"), false);
    assert.equal(meshNameSelected({ kind: "always" }, "Cube.001"), true);

    // Scene 167's own document shape: the `level` mesh's three primitives
    // carry materials 0, 0 and 1, and every `Cube*` node draws material 2.
    // The renderable walk is node-major, primitive-minor -- the loader's own
    // order -- and each renderable takes its glTF MESH's name.
    const document = {
        nodes: [
            { name: "level", mesh: 0 },
            { name: "Cube", mesh: 1 },
            { name: "jointSpaceA" },
        ],
        meshes: [
            {
                name: "level",
                primitives: [
                    { material: 0 },
                    { material: 0 },
                    { material: 1 },
                ],
            },
            { name: "Cube.001", primitives: [{ material: 2 }] },
        ],
        materials: [{}, {}, {}],
    };
    assert.deepEqual(
        [...(await gltfLightmapMaterials(document, predicate))].sort(),
        [0, 1],
    );
    // An unnamed mesh takes the pin's own fallback name, which is what the
    // generated loader writes into the record the walk compares against.
    assert.deepEqual(
        [
            ...(await gltfLightmapMaterials(
                {
                    nodes: [{ mesh: 0 }],
                    meshes: [{ primitives: [{ material: 7 }] }],
                    materials: [],
                },
                { kind: "startsWith", value: "gltf_mesh_" },
            )),
        ],
        [7],
    );
});

/**
 * A minimal GLB carrying one `KHR_gaussian_splatting` primitive: two splats,
 * every attribute the extension defines, tightly packed FLOAT accessors.
 *
 * The values are chosen so the pin's own conversion lands on constants a
 * reader can check without restating its formula: an SH DC term of zero is
 * mid grey, a unit opacity is 255, and an identity quaternion encodes as
 * (255, 128, 128, 128) in the pin's wxyz byte order.
 */
function gaussianSplatGlb(
    options: { draco?: boolean; keepReader?: boolean } = {},
): Uint8Array {
    const positions = Float32Array.from([1, 2, 3, -1, -2, -3]);
    const scales = Float32Array.from([0.5, 0.25, 0.125, 1, 2, 4]);
    const rotations = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1]);
    const opacities = Float32Array.from([1, 0]);
    const shDegree0 = Float32Array.from([0, 0, 0, 0, 0, 0]);
    const parts = [positions, scales, rotations, opacities, shDegree0];
    const binary = Buffer.concat(
        parts.map((part) => Buffer.from(part.buffer.slice(0))),
    );
    let offset = 0;
    const bufferViews = parts.map((part) => {
        const view = {
            buffer: 0,
            byteOffset: offset,
            byteLength: part.byteLength,
        };
        offset += part.byteLength;
        return view;
    });
    const accessor = (index: number, type: string) => ({
        bufferView: index,
        byteOffset: 0,
        componentType: 5126,
        count: 2,
        type,
    });
    return buildGlb(
        {
            asset: { version: "2.0" },
            extensionsUsed: ["KHR_gaussian_splatting"],
            extensionsRequired: ["KHR_gaussian_splatting"],
            buffers: [{ byteLength: binary.length }],
            bufferViews,
            accessors: [
                accessor(0, "VEC3"),
                accessor(1, "VEC3"),
                accessor(2, "VEC4"),
                accessor(3, "SCALAR"),
                accessor(4, "VEC3"),
            ],
            meshes: [
                {
                    name: "cloud",
                    primitives: [
                        // A second, ordinary primitive keeps the document
                        // reading its chunk, which is what decides whether
                        // the consumed attribute views may be dropped.
                        ...(options.keepReader
                            ? [{ mode: 0, attributes: { POSITION: 0 } }]
                            : []),
                        {
                            mode: 0,
                            attributes: {
                                POSITION: 0,
                                "KHR_gaussian_splatting:SCALE": 1,
                                "KHR_gaussian_splatting:ROTATION": 2,
                                "KHR_gaussian_splatting:OPACITY": 3,
                                "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 4,
                            },
                            extensions: {
                                KHR_gaussian_splatting: { kernel: "ellipse" },
                                ...(options.draco
                                    ? {
                                          KHR_draco_mesh_compression: {
                                              bufferView: 0,
                                              attributes: { POSITION: 0 },
                                          },
                                      }
                                    : {}),
                            },
                        },
                    ],
                },
            ],
            nodes: [{ mesh: 0 }],
            scenes: [{ nodes: [0] }],
        },
        binary,
    );
}

test("converts KHR_gaussian_splatting through the pinned feature", async () => {
    const { document, binary } = readGlbFixture(
        await resolveGeometryExtensions(gaussianSplatGlb(), "splat.glb"),
    );
    // The pin's preParse consumes every GS primitive, so the core mesh
    // pipeline never sees POINTS geometry it has no topology for.
    const meshes = document.meshes as Array<Record<string, unknown>>;
    assert.deepEqual(meshes[0]!.primitives, []);
    // Its own scratch key does not survive into the packaged document.
    assert.equal(document.__gsSplats, undefined);
    // The document no longer carries the extension, because it no longer
    // carries anything the extension describes.
    assert.deepEqual(document.extensionsUsed, []);
    assert.equal(document.extensionsRequired, undefined);

    const splats = document[
        "__bblitecGaussianSplats"
    ] as Array<Record<string, unknown>>;
    assert.equal(splats.length, 1);
    // `${mesh.name ?? "splat"}_${meshIndex}_${primitiveIndex}`, the pin's.
    assert.equal(splats[0]!.name, "cloud_0_0");
    // The half turn about Z the pin's own scene wiring writes on the cloud
    // it attaches: the glTF splat convention and the .ply one differ by it.
    assert.deepEqual(splats[0]!.rotation, [0, 0, Math.PI]);

    // The GS primitives were the whole file, so the ellipsoid attributes
    // they were converted from reach nothing any more: the rows become the
    // entire binary chunk, and the accessors that described those attributes
    // go with the bytes rather than dangling into a chunk without them.
    const views = document.bufferViews as Array<Record<string, unknown>>;
    assert.equal(views.length, 1);
    assert.deepEqual(document.accessors, []);
    const view = views[splats[0]!.bufferView as number]!;
    // 32 bytes per splat, which is the row layout `buildSplatGeometry` reads
    // and the layout a `.splat` asset already packages to.
    assert.equal(view.byteLength, 64);
    const rows = binary.subarray(
        view.byteOffset as number,
        (view.byteOffset as number) + 64,
    );
    // Position and linear scale pass straight through as float32 lanes.
    assert.deepEqual(
        [0, 4, 8, 12, 16, 20].map((at) => rows.readFloatLE(at)),
        [1, 2, 3, 0.5, 0.25, 0.125],
    );
    assert.deepEqual(
        [32, 36, 40].map((at) => rows.readFloatLE(at)),
        [-1, -2, -3],
    );
    // A zero SH DC term reconstructs mid grey; opacity and the identity
    // quaternion encode as the pin's byte forms (wxyz, q * 127.5 + 127.5).
    assert.deepEqual([...rows.subarray(24, 32)], [
        128, 128, 128, 255, 255, 128, 128, 128,
    ]);
    assert.equal(rows[27 + 32], 0);
});

test("keeps the source views when the document still reads them", async () => {
    // The same asset with one ordinary primitive left behind. Its accessor
    // still names a bufferView, so the pass appends the rows rather than
    // replacing the chunk — the shape every other packaged asset takes.
    const { document } = readGlbFixture(
        await resolveGeometryExtensions(
            gaussianSplatGlb({ keepReader: true }),
            "splat-mixed.glb",
        ),
    );
    const views = document.bufferViews as Array<Record<string, unknown>>;
    assert.equal(views.length, 6);
    assert.equal((document.accessors as unknown[]).length, 5);
    const splats = document[
        "__bblitecGaussianSplats"
    ] as Array<Record<string, unknown>>;
    assert.equal(splats.length, 1);
    assert.equal(splats[0]!.bufferView, 5);
    assert.deepEqual(
        (document.meshes as Array<Record<string, unknown>>)[0]!.primitives,
        [{ mode: 0, attributes: { POSITION: 0 } }],
    );
});

test("refuses a Gaussian-splat primitive that is also Draco-compressed", async () => {
    await assert.rejects(
        () =>
            resolveGeometryExtensions(
                gaussianSplatGlb({ draco: true }),
                "splat-draco.glb",
            ),
        /also declares KHR_draco_mesh_compression/,
    );
});

test("anchors the pinned CSG contracts the executed solid depends on", () => {
    // There is no CSG page under the pinned clone's `docs/lite/architecture`,
    // so `src/mesh/csg.ts` is the whole specification and these are the
    // facts `executed-csg-solid` cites as its reason for executing rather
    // than folding. Each one moving is a reason to re-decide, so each fails
    // here rather than quietly changing what the bake replays.
    const source = new UpstreamSourceStore().getSource("src/mesh/csg.ts");
    // The five entry points the intrinsics name, by their exported spelling.
    for (const symbol of [
        "createCsgFromMesh",
        "csgUnion",
        "csgSubtract",
        "csgIntersect",
        "createMeshFromCsg",
        "createMeshesFromCsg",
    ]) {
        assert.match(
            source,
            new RegExp(`export function ${symbol}\\(`),
            `csg.ts no longer exports ${symbol}`,
        );
    }
    // The epsilon the BSP classifies against: the reason a reassociated dot
    // product would change the polygon COUNT rather than a coordinate.
    assert.match(source, /const EPSILON = 1e-5;/);
    assert.match(
        source,
        /const type = t < -EPSILON \? BACK : t > EPSILON \? FRONT : COPLANAR;/,
    );
    // Every plane and every interpolated normal is normalized through the
    // pin's own helper, whose length is `Math.hypot` -- which the
    // specification leaves implementation-approximated.
    assert.match(source, /import \{ normalizeVec3 \} from "\.\.\/math\/normalize-vec3\.js";/);
    assert.match(
        new UpstreamSourceStore().getSource("src/math/normalize-vec3.ts"),
        /const len = Math\.hypot\(x, y, z\);/,
    );
    // The one place a solid becomes geometry, which is what the bake reads
    // back and the emitted `create_mesh_from_data` reproduces.
    assert.match(
        source,
        /return createMeshFromData\(engine as EngineContext, name, new F32\(positions\), new F32\(normals\), new U32\(indices\), new F32\(uvs\)\);/,
    );
    // The world matrix the solid bakes in, which is why the intrinsic
    // proves the mesh has not been moved yet.
    assert.match(source, /const world = mesh\.worldMatrix;/);
});

test("executes the pinned CSG solid and bakes the geometry it produced", () => {
    // The replay is the port's only CSG implementation, so this is the
    // contract test for it: the plan scene 90 builds, run through the pin's
    // own modules, yields the mesh the browser builds at load.
    const solid = (
        source: CsgSourceMesh,
    ): CsgSolidPlan => ({ op: "from-mesh", source, materialSlot: 0 });
    const subtract = bakeCsgMesh(
        {
            op: "csgSubtract",
            left: solid({ factory: "createBox", options: 2 }),
            right: solid({
                factory: "createSphere",
                options: { diameter: 2.5, segments: 32 },
            }),
        },
        "csg-subtract",
    );
    // Three streams per vertex and one index triple per triangle, which is
    // what `createMeshFromPolygons` fans a polygon out into.
    const vertices = subtract.positions.length / 3;
    assert.equal(subtract.normals.length, vertices * 3);
    assert.equal(subtract.uvs.length, vertices * 2);
    assert.equal(subtract.indices.length % 3, 0);
    assert.ok(vertices > 0);
    assert.ok(
        Math.max(...subtract.indices) < vertices,
        "every index addresses a vertex the bake emitted",
    );
    // A subtraction is bounded by the box it started from. (Byte-stability
    // across compilations is not asserted here -- a repeat call answers
    // from the plan memo, so it would compare an array with itself; what
    // proves it is the generated-tree digest the neutrality ladder takes
    // over two `compile all` runs.)
    for (const value of subtract.positions) {
        assert.ok(Math.abs(value) <= 1.0000001, `${value} is outside the box`);
    }
    // The union is the same two solids the other way round: it keeps the
    // sphere's cap, so it reaches past the box.
    const union = bakeCsgMesh(
        {
            op: "csgUnion",
            left: solid({ factory: "createBox", options: 2 }),
            right: solid({
                factory: "createSphere",
                options: { diameter: 2.5, segments: 32 },
            }),
        },
        "csg-union",
    );
    assert.ok(
        Math.max(...union.positions) > 1.0000001,
        "a union of a 2-box and a 2.5-sphere reaches past the box",
    );
});

test("spells a baked CSG float at float32 round-trip width", () => {
    // The values come out of a `Float32Array`, so the shortest decimal that
    // round-trips through `Math.fround` names the identical float in about
    // half the characters of the double spelling -- and a boolean solid
    // emits hundreds of thousands of them.
    assert.equal(float32Literal(Math.fround(0.3)), "0.3f");
    assert.equal(float32Literal(2), "2.0f");
    assert.equal(float32Literal(-0), "-0.0f");
    assert.equal(float32Literal(0), "0.0f");
    assert.equal(
        Math.fround(Number(float32Literal(Math.fround(1 / 3)).slice(0, -1))),
        Math.fround(1 / 3),
    );
    assert.throws(
        () => float32Literal(Number.POSITIVE_INFINITY),
        /needs a finite value/,
    );
    // MSVC counts a `std::initializer_list` element as an object-file
    // section (C1128 at 140k floats), so the geometry lands in a plain
    // array and the vector is built from its bounds.
    const declarations = csgGeometryDeclarations("v_csg", {
        positions: new Float32Array([1, 2, 3]),
        normals: new Float32Array([0, 1, 0]),
        uvs: new Float32Array([0, 0]),
        indices: new Uint32Array([0]),
    });
    assert.match(
        declarations.lines.join("\n"),
        /static const float v_csg_positions\[\] = \{\n\s+1\.0f, 2\.0f, 3\.0f,\n\};/,
    );
    assert.equal(
        declarations.positions,
        "std::vector<float>(v_csg_positions, v_csg_positions + 3)",
    );
    assert.equal(
        declarations.indices,
        "std::vector<std::uint32_t>(v_csg_indices, v_csg_indices + 1)",
    );
    // An empty stream has no array to bound: a zero-length C array is not
    // C++, so the expression is the empty vector itself.
    const empty = csgGeometryDeclarations("v_csg", {
        positions: new Float32Array(),
        normals: new Float32Array(),
        uvs: new Float32Array(),
        indices: new Uint32Array(),
    });
    assert.deepEqual(empty.lines, []);
    assert.equal(empty.positions, "std::vector<float>{}");
});
