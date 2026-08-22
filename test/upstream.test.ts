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
import {
    readUpstreamPin,
    UpstreamSourceStore,
} from "../src/upstream-source.js";
import type { CompiledShaderProgram } from "../src/compiler.js";
import {
    predeclaredShaderProgram,
    shaderMaterialPrograms,
} from "../src/shader-material-programs.js";
import { dawnUtilityShaders } from "../src/upstream-lower.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";

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
        /scene\.environment\.lod_generation_scale =\s*1\.0f/,
    );
    assert.match(hdrAdapter.source, /scene\.environment\.tone_mapping_enabled = false/);
    assert.match(hdrAdapter.source, /scene\.environment\.skybox_uses_environment/);
});

test("generates scene defaults, routing, and idempotent registration", () => {
    const lowered = new SceneLowerer(new LoweringContext()).lowerCore();
    assert.match(lowered.source, /scene\.clear_color = Color4\{\s*0\.2f,\s*0\.2f,\s*0\.3f,\s*1\.0f/s);
    assert.match(lowered.source, /for \(const MeshHandle mesh : record\.meshes\)/);
    assert.match(lowered.source, /scene\.mesh_membership_version/);
    assert.match(lowered.source, /scene\.material_family_mask/);
    assert.match(lowered.source, /void on_before_render/);
    assert.match(lowered.source, /registered_scenes\.end\(\)/);
    // Runtime removal drops the mesh and marks the topology; the
    // material-family mask stays monotonic so built pipelines survive.
    assert.match(
        lowered.source,
        /void remove_from_scene\(Scene& scene, MeshHandle mesh\)/,
    );
    assert.match(
        lowered.source,
        /scene\.meshes\.erase\(found\);\s*\r?\n\s*\+\+scene\.mesh_membership_version;/,
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
});

// One store load serves both light tests: the LoweringContext constructor
// parses every pinned source map, which dwarfs the lowering itself.
const lightLowerer = new LightLowerer(new LoweringContext());

test("flows the pinned light matrices and spot cone into the factories", () => {
    const lowerer = lightLowerer;
    // The spot half-angle factor flows from the pinned _cosHalfAngle
    // initializer (src/light/spot-light.ts); the precision semantics
    // stay the emission's own (the TODO.md spot-cone ULP entry).
    const spot = lowerer.lowerSpotFactory();
    assert.match(
        spot.source,
        /light\.cos_half_angle = std::cos\(angle \* 0\.5f\);/,
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
        /light\.local_matrix\[12\] = position\.x;/,
    );
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
    assert.equal(emitted, 3);
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
        /glTF accessor exceeds its bufferView/,
    );
    assert.match(
        adapter.source,
        /Sparse glTF accessors are not supported/,
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
    assert.match(adapter.source, /linear_determinant/);
    assert.match(
        adapter.source,
        /record\.clockwise_front_face/,
    );
    assert.match(
        adapter.source,
        /determinant < 0\.0f &&\s*!clockwise_front_face/,
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
    // The load-time pose is applied as a tick, not a seek: a seek places every
    // clip that is not stopped, which is not what loading does.
    assert.match(
        adapter.source,
        /apply_animation_time\(0\.0f, false\)/,
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
    assert.doesNotMatch(adapter.source, /pal::load_glb/);
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
});

test("generates engine API wrappers over the PAL", () => {
    const lowered = new EngineLowerer(new LoweringContext()).lowerCore();
    assert.match(lowered.source, /return pal::create_engine/);
    assert.match(lowered.source, /pal::run_engine\(engine\)/);
    assert.match(lowered.source, /BBLITE_ASSET_DIR/);
    assert.match(lowered.source, /environment_variable\("BBLITE_ASSET_DIR"\)/);
    assert.match(lowered.source, /pal::executable_directory\(\)/);
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
    assert.match(mesh.source, /const std::uint32_t subdivisions/);
    assert.match(mesh.source, /normalized_column \* options\.uv_scale\.x/);
    assert.match(mesh.source, /bottom_right,\s*top_right,\s*top_left/s);
    assert.match(mesh.source, /radius\.x \* normal\.x/);
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
    assert.match(material.source, /material\.has_ior = false/);
    assert.match(
        material.source,
        /material\.use_thickness_as_depth = options\.use_thickness_as_depth/,
    );
    assert.match(material.source, /material\.has_volume = options\.has_volume/);
    assert.match(material.source, /options\.alpha < 1\.0f/);
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
    assert.match(
        directional.source,
        /light\.kind = LightKind::directional/,
    );
    assert.match(
        directional.source,
        /local_matrix_from_direction/,
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
    // src/math/mat4-ortho-lh-to-ref.ts term by term, with the planes
    // src/camera/orthographic.ts derives from the half-extent.
    assert.match(plan.source, /if \(camera\.orthographic\) \{/);
    assert.match(
        plan.source,
        /const double half_width =\s*half_height \* static_cast<double>\(aspect\);/,
    );
    assert.match(
        plan.source,
        /projection\[0\] = static_cast<float>\(2\.0 \/ \(right - left\)\);/,
    );
    assert.match(
        plan.source,
        /projection\[12\] =\s*static_cast<float>\(\(left \+ right\) \/ \(left - right\)\);/,
    );
    assert.match(
        plan.source,
        /projection\[10\] = static_cast<float>\(-1\.0 \/ range\);/,
    );
    assert.match(
        plan.source,
        /projection\[14\] = static_cast<float>\(far_plane \/ range\);/,
    );
    // A perspective-only scene keeps the branch out of its plan.
    const perspective = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan();
    assert.doesNotMatch(
        perspective.source,
        /camera\.orthographic/,
    );
});

test("lowers the reachable upstream light matrix implementation", () => {
    const lowered = new LightLowerer(new LoweringContext()).lowerMatrix();
    assert.equal(lowered.modulePath, "src/light/light-matrix.ts");
    assert.match(lowered.source, /std::sqrt/);
    assert.match(lowered.source, /m\[15\] = 1\.0f/);
    assert.match(lowered.source, pinnedProvenance());
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
    assert.match(lowered.source, /preferred_sample_count\(\).*return 4u/s);
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
    // mat4ComposeInto's quaternion basis, eulerToQuat's half-angle
    // products, and the mat4MultiplyInto column loop all transcribe into
    // the emitted helper; the record's own transform never reaches it
    // for non-thin-instanced meshes.
    assert.match(plan.source, /\(1\.0 - 2\.0 \* \(yy \+ zz\)\) \* scale_x/);
    assert.match(plan.source, /qx = sx \* cy \* cz \+ cx \* sy \* sz;/);
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
    assert.match(tasks.source, /create_render_target_texture/);
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
});
