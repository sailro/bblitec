import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { analyzeUpstreamGraph } from "../src/upstream-graph.js";
import { LoweringContext } from "../src/lowering/context.js";
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
import type {
    GeometryOutputTaskManifest,
    ShaderMaterialVariantName,
} from "../src/compiler.js";

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
    assert.match(adapter.source, /std::swap\(geometry\.indices\[index \+ 1\]/);
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
        /gltf-ibl-brdf-lut\.png/,
    );
    assert.match(
        adapter.source,
        /EXT_mesh_gpu_instancing/,
    );
    assert.match(
        adapter.source,
        /record\.instance_matrices/,
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
    assert.match(adapter.source, /apply_animation_time\(0\.0f\)/);
    assert.match(
        adapter.source,
        /for \(const RotationTrack& track[\s\S]*?std::clamp\(/,
    );
    assert.match(
        adapter.source,
        /for \(const TranslationTrack& track[\s\S]*?std::clamp\(/,
    );
    assert.match(
        adapter.source,
        /weight_tracks\.rbegin\(\)[\s\S]*?const WeightTrack& track[\s\S]*?std::clamp\(/,
    );
    assert.match(adapter.source, /if \(dot > 0\.9995f\)/);
    assert.match(adapter.source, /const float theta = std::acos\(dot\)/);
    assert.match(
        adapter.source,
        /std::sin\(\(1\.0f - amount\) \* theta\)/,
    );
    assert.match(adapter.source, /geometry\.morph_positions\.size\(\) <= 2/);
    assert.match(adapter.source, /\.joints\.size\(\) <= 64/);
    assert.match(adapter.source, /mesh_record\.gpu_deformation/);
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
    assert.match(material.source, /material\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/);
    assert.match(material.source, /material\.standard_material = true/);
    assert.match(grid.source, /material\.grid_material = true/);
    assert.match(grid.source, /std::round\(options\.major_unit_frequency\)/);
    assert.match(grid.source, /options\.opacity < 1\.0f/);
    assert.match(grid.source, /material\.grid_use_max_line/);
    assert.match(shader.source, /ShaderMaterialVariant::circular_cutout/);
    assert.match(shader.source, /material\.alpha_mode = MaterialAlphaMode::blend/);
    assert.match(shader.source, /material\.shader_depth_write = false/);
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
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
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
    assert.match(arc.source, /camera\.fov = 0\.8f/);
    assert.match(arc.source, /camera\.angular_sensibility = 1000\.0f/);
    assert.match(arc.source, /sine_beta = 0\.0001f/);
    assert.match(arc.header, /arc_rotate_eye_position/);
    assert.match(framing.source, /radius = diagonal \* 1\.5f/);
    assert.match(framing.source, /record\.near_plane = radius \* 0\.01f/);
    assert.match(framing.source, /record\.far_plane = radius \* 1000\.0f/);
    assert.match(free.source, /camera\.kind = CameraKind::free/);
    assert.match(free.source, /camera\.angular_sensibility = 2000\.0f/);
    assert.match(controls.source, /rotation_epsilon = 0\.001f/);
    assert.match(controls.source, /camera\.inertial_alpha_offset \*= camera\.inertia/);
    assert.match(
        controls.source,
        /if \(has_movement \|\| has_rotation\) \{\s*camera\.target = Vec3/,
    );
});

test("lowers the reachable upstream light matrix implementation", () => {
    const lowered = new LightLowerer(new LoweringContext()).lowerMatrix();
    assert.equal(lowered.modulePath, "src/light/light-matrix.ts");
    assert.match(lowered.source, /std::sqrt/);
    assert.match(lowered.source, /m\[15\] = 1\.0f/);
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
});

test("generates the render plan from upstream frame-graph binding semantics", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const lowered = lowerer.lowerRenderPlan({ transmission: true });
    const specialized = lowerer.lowerRenderPlan({
        transmission: true,
        gpuInstancing: true,
        multiLight: true,
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
    assert.match(
        specialized.header,
        /extra_light_positions/,
    );
    assert.match(lowered.source, /build_render_plan/);
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
    assert.match(lowered.source, /shader_uniform_buffer_count/);
    assert.match(
        lowered.source,
        /ShaderMaterialVariant::circular_cutout:[\s\S]*fragment_stage \? 0u : 1u/,
    );
    assert.match(lowered.source, /features\.grid_material/);
    assert.match(lowered.source, /features\.no_color_material/);
    assert.match(lowered.source, /std::stable_sort/);
    assert.match(lowered.source, /bind_render_item/);
    assert.match(lowered.source, /sort_transparent_draws/);
    assert.match(
        lowered.source,
        /material\.use_thickness_as_depth && material\.thickness > 0\.0f/,
    );
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
    assert.match(lowered.source, /build_skybox_plan/);
    assert.match(lowered.source, /build_skybox_view_projection/);
    assert.match(lowered.source, /preferred_sample_count\(\).*return 4u/s);
    assert.match(lowered.header, /struct PbrUniforms/);
    assert.match(lowered.source, /mesh\.geometry >= engine\.geometries\.size\(\)/);
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("pbr.frag.native.wgsl"),
        ),
    );
    assert.ok(
        shaders.every((shader) => /\.(?:hlsl|msl|wgsl)$/.test(shader.output)),
    );
    const fragment = shaders.find((shader) =>
        shader.output.endsWith("pbr.frag.native.wgsl"),
    );
    assert.equal(typeof fragment?.data, "string");
    assert.match(String(fragment?.data), /@builtin\(front_facing\)/);
    assert.match(String(fragment?.data), /@location\(6u\) v_118/);
    assert.match(String(fragment?.data), /textureNumLevels/);
    assert.match(
        String(fragment?.data),
        /select\([\s\S]*FragmentUniforms\.normalOptions\.y > 0\.5f/,
    );
    assert.match(String(fragment?.data), /3\.141592741/);
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
    const diagnosticC = shaders.find((shader) =>
        shader.output.endsWith("pbr-diagnostics-c.frag.native.wgsl"),
    );
    assert.match(String(diagnosticC?.data), /baseColor/);
    assert.match(String(diagnosticC?.data), /preToneHdr/);
    assert.match(String(fragment?.data), /1\.590579/);
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

test("lowers glTF material extensions into typed uniforms and shader layers", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const plan = lowerer.lowerRenderPlan({
        transmission: true,
        clearcoat: true,
        sheen: true,
        iridescence: true,
        dispersion: true,
    });
    assert.match(plan.header, /std::array<float, 4> clearcoat_params\{\};/);
    assert.match(
        plan.header,
        /std::array<float, 4> clearcoat_refraction_params\{\};/,
    );
    assert.match(plan.header, /std::array<float, 4> sheen_params2\{\};/);
    assert.match(plan.header, /std::array<float, 4> iridescence_params\{\};/);
    assert.match(
        plan.header,
        /iridescence_params\{\};\s*\r?\n\s*std::array<std::array<float, 4>, 9> spherical_harmonics/,
    );
    assert.match(
        plan.source,
        /material\.clearcoat_normal_texture\.bytes\.empty\(\)/,
    );
    assert.match(
        plan.source,
        /const float clearcoat_a =\s*\r?\n?\s*1\.0f - material\.clearcoat_index_of_refraction;/,
    );
    assert.match(plan.source, /material\.sheen_color\.r/);
    assert.match(
        plan.source,
        /material\.iridescence_minimum_thickness/,
    );
    assert.match(plan.source, /material\.dispersion,/);

    const baseline = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({ transmission: true });
    assert.doesNotMatch(baseline.header, /clearcoat_params/);
    assert.doesNotMatch(baseline.header, /sheen_params/);
    assert.doesNotMatch(baseline.header, /iridescence_params/);
    assert.doesNotMatch(baseline.source, /material\.dispersion/);
});

test("generates upstream clearcoat, sheen, iridescence, and dispersion WGSL", () => {
    const options = {
        ground: false,
        skybox: false,
        shaderVariants: [] as ShaderMaterialVariantName[],
        standardMaterial: false,
        idDiagnostics: false,
        pbrDiagnostics: false,
        geometryOutputTasks: [] as GeometryOutputTaskManifest[],
    };
    const fragmentOf = (shaders: ReturnType<
        RendererLowerer["lowerShaders"]
    >): string =>
        String(
            shaders.find((shader) =>
                shader.output.endsWith("pbr.frag.native.wgsl"),
            )?.data,
        );
    const clearcoat = fragmentOf(
        new RendererLowerer(new LoweringContext()).lowerShaders({
            ...options,
            transmission: false,
            clearcoat: true,
        }),
    );
    assert.match(
        clearcoat,
        /@group\(2u\) @binding\(12u\) var clearcoatTexture : texture_2d<f32>;/,
    );
    assert.match(
        clearcoat,
        /@group\(2u\) @binding\(17u\) var clearcoatNormalSampler : sampler;/,
    );
    assert.match(clearcoat, /  clearcoatParams : vec4<f32>,/);
    assert.match(clearcoat, /fn bblVisibilityKelemen/);
    assert.match(clearcoat, /return 0\.25f \/ \(VdotH_kl \* VdotH_kl \+ 0\.0000001f\);/);
    assert.match(
        clearcoat,
        /let ccDirectAttenuation = 1\.0f - ccFresnel_dl \* ccIntensity;/,
    );
    assert.match(
        clearcoat,
        /let ccConservation_ibl = 1\.0f - ccFresnelIBL \* ccIntensity;/,
    );
    assert.match(clearcoat, /bblBaseIrradiance \* ccConservation_ibl/);
    assert.match(clearcoat, /v_102 \* ccDirectAttenuation/);
    assert.match(clearcoat, /select\(\(bblLayeredColor\), v_31/);

    const sheen = fragmentOf(
        new RendererLowerer(new LoweringContext()).lowerShaders({
            ...options,
            transmission: false,
            sheen: true,
        }),
    );
    assert.match(sheen, /fn bblCharlieSheenDistribution/);
    assert.match(sheen, /fn bblVisibilityAshikhmin/);
    assert.match(
        sheen,
        /let sheenAlbedoScaling = 1\.0f - shMax \* shBrdf\.b;/,
    );
    assert.match(sheen, /\)\ \* sheenAlbedoScaling \+/);
    assert.match(
        sheen,
        /@group\(2u\) @binding\(12u\) var sheenColorTexture : texture_2d<f32>;/,
    );

    const iridescence = fragmentOf(
        new RendererLowerer(new LoweringContext()).lowerShaders({
            ...options,
            transmission: true,
            iridescence: true,
        }),
    );
    assert.match(iridescence, /fn bblIridescenceEval\(/);
    assert.match(
        iridescence,
        /let opd = 2\.0f \* iridescenceIor \* thickness \* cosTheta2;/,
    );
    assert.match(
        iridescence,
        /let v_75 = mix\(bblBaseColorF0, iriF0, vec3<f32>\(iriIntensity\)\);/,
    );
    assert.match(
        iridescence,
        /@group\(2u\) @binding\(18u\) var iridescenceTexture : texture_2d<f32>;/,
    );

    const dispersion = fragmentOf(
        new RendererLowerer(new LoweringContext()).lowerShaders({
            ...options,
            transmission: true,
            dispersion: true,
        }),
    );
    assert.match(
        dispersion,
        /let spread = 0\.04f \* FragmentUniforms\.volumeParams\.w \* \(realIOR - 1\.0f\);/,
    );
    assert.match(dispersion, /let etaR = 1\.0f \/ \(realIOR - spread\);/);
    assert.match(dispersion, /let etaB = 1\.0f \/ \(realIOR \+ spread\);/);
    assert.doesNotMatch(dispersion, /let refractedDirection = refract\(/);

    const baseline = fragmentOf(
        new RendererLowerer(new LoweringContext()).lowerShaders({
            ...options,
            transmission: true,
        }),
    );
    assert.doesNotMatch(baseline, /clearcoat|sheen|iridescence|bblLayeredColor/);
    assert.match(baseline, /let refractedDirection = refract\(/);

    const fidelity = new RendererLowerer(
        new LoweringContext(),
    ).fidelityManifest();
    for (const id of [
        "clearcoat-layer",
        "sheen-layer",
        "iridescence-thin-film",
        "dispersion-chromatic-refraction",
    ]) {
        assert.ok(
            fidelity.invariants.some(
                (invariant) => invariant.id === id,
            ),
            `missing renderer fidelity invariant ${id}`,
        );
    }
});

test("rejects unlowered punctual multi-light and layered material composition", () => {
    assert.throws(
        () =>
            new RendererLowerer(new LoweringContext()).lowerShaders({
                ground: false,
                skybox: false,
                transmission: false,
                shaderVariants: [],
                standardMaterial: false,
                idDiagnostics: false,
                pbrDiagnostics: false,
                geometryOutputTasks: [],
                multiLight: true,
                clearcoat: true,
            }),
        /multi-light and clearcoat\/sheen/,
    );
});

test("keeps renderer templates backend-language free", () => {
    const templates = readdirSync("src/lowering/templates/renderer");
    assert.deepEqual(
        templates.filter((name) => /\.(?:hlsl|msl)$/.test(name)),
        [],
    );
});

test("emits only reached WGSL composition modules", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const shaders = lowerer.lowerShaders({
        ground: false,
        skybox: false,
        shaderVariants: [],
        standardMaterial: false,
        gridMaterial: true,
        idDiagnostics: false,
        pbrDiagnostics: false,
        geometryOutputTasks: [],
    });
    const modules = shaders
        .filter(({ output }) => output.endsWith(".wgsl"))
        .map(({ output }) => output);
    assert.ok(modules.includes("upstream/shaders/pbr.vert.native.wgsl"));
    assert.ok(modules.includes("upstream/shaders/pbr.frag.native.wgsl"));
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
        shaderVariants: [],
        standardMaterial: false,
        gridMaterial: true,
        idDiagnostics: false,
        pbrDiagnostics: false,
        geometryOutputTasks: [],
    });
    const wgsl = shaders.find((shader) =>
        shader.output.endsWith("grid.frag.native.wgsl"),
    );
    assert.match(String(wgsl?.data), /gridDynamicVisibility/);
    assert.match(
        String(wgsl?.data),
        /Generated from @babylonjs\/lite@1\.18\.0/,
    );
    assert.match(String(wgsl?.data), /cos\(fraction \* PI\)/);
    assert.match(String(wgsl?.data), /SQRT2 \/ 4\.0/);
    assert.match(String(wgsl?.data), /max\(max\(x, y\), z\)/);
    assert.match(String(wgsl?.data), /dpdx\(position\)/);
    assert.match(String(wgsl?.data), /uniforms\.gridControl\.w \* grid/);
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
        shaderVariants: [],
        standardMaterial: false,
        idDiagnostics: false,
        pbrDiagnostics: false,
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
    assert.match(tasks.header, /struct PixelViewport/);
    assert.match(tasks.source, /std::floor/);
    assert.match(
        tasks.source,
        /pixel\(viewport\.x \+ viewport\.width, target_width\)/,
    );
    assert.match(
        tasks.source,
        /static_cast<std::int32_t>\(target_height\) -\s*y_top -\s*viewport_height/,
    );
    const geometry = shaders.find((shader) =>
        shader.output.endsWith("pbr-geometry-0.frag.native.wgsl"),
    );
    assert.match(String(geometry?.data), /@location\(7\) color/);
    assert.match(
        String(geometry?.data),
        /bblDirectDiffuse \+ bblFinalIrradiance/,
    );
    assert.match(String(geometry?.data), /bblOutput\.f1 = vec4<f32>\(v_1/);
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

test("generates standard-material geometry output shaders", () => {
    const shaders = new RendererLowerer(
        new LoweringContext(),
    ).lowerShaders({
        ground: false,
        skybox: false,
        shaderVariants: [],
        standardMaterial: true,
        idDiagnostics: false,
        pbrDiagnostics: false,
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
    const geometry = shaders.find((shader) =>
        shader.output.endsWith("standard-geometry-0.frag.native.wgsl"),
    );
    assert.match(String(geometry?.data), /vec4<f32>\(0\.0, 0\.0, 0\.0/);
    assert.match(
        String(geometry?.data),
        /1\.0 - input\.position\.z/,
    );
    assert.match(String(geometry?.data), /pow\(specularSample\.rgb/);
    assert.match(String(geometry?.data), /reflectionTexture/);
    assert.match(String(geometry?.data), /output\.color = color/);
    assert.ok(
        !shaders.some(
            (shader) =>
                shader.output.includes("standard") &&
                /\.(?:hlsl|msl)$/.test(shader.output),
        ),
    );
});

test("emits only reached custom shader variants", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const alphaCard = lowerer.lowerShaders({
        ground: false,
        skybox: false,
        shaderVariants: ["alpha-card"],
        standardMaterial: false,
        idDiagnostics: false,
        pbrDiagnostics: false,
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
        shaderVariants: ["circular-cutout"],
        standardMaterial: false,
        idDiagnostics: false,
        pbrDiagnostics: false,
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
