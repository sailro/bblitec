import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUpstreamGraph } from "../src/upstream-graph.js";
import { LoweringContext } from "../src/lowering/context.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { EngineLowerer } from "../src/lowering/engine-lowerer.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

test("loads pinned Babylon Lite TypeScript from published source maps", () => {
    const store = new UpstreamSourceStore();
    assert.equal(store.pin.version, "1.18.0");
    assert.equal(store.pin.sourceVersion, "7184feda683072980735f9a180e6f567ee5717ba");
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

test("generates GLB framing validation from upstream constants", () => {
    const lowerer = new GltfLowerer(new LoweringContext());
    const lowered = lowerer.lowerGlbParser();
    const adapter = lowerer.lowerLoaderAdapter();
    assert.match(lowered.source, /0x46546c67/);
    assert.match(lowered.source, /0x4e4f534a/);
    assert.match(lowered.source, /0x4e4942/);
    assert.match(adapter.source, /ts::await\(pal::fetch_array_buffer/);
    assert.match(adapter.source, /read_component/);
    assert.match(adapter.source, /linear_determinant/);
    assert.match(adapter.source, /std::swap\(geometry\.indices\[index \+ 1\]/);
    assert.match(adapter.source, /vertex\.normal = normalize\(vertex\.normal\)/);
    assert.match(adapter.source, /vertex\.local_position = local_position/);
    assert.match(adapter.source, /geometry\.has_tangents = tangents != nullptr/);
    assert.match(adapter.source, /optional\(attributes, "COLOR_0"\)/);
    assert.match(adapter.source, /vertex\.color = Vec4/);
    assert.match(adapter.source, /result\.sampler\.max_anisotropy/);
    assert.match(adapter.source, /result\.sampler\.max_lod = no_mip/);
    assert.match(adapter.source, /MaterialAlphaMode::blend/);
    assert.match(adapter.source, /alpha_cutoff/);
    assert.doesNotMatch(adapter.source, /pal::load_glb/);
});

test("generates the Babylon loader adapter from pinned scene semantics", () => {
    const lowered = new BabylonLowerer(
        new LoweringContext(),
    ).lowerLoaderAdapter();
    assert.match(lowered.source, /AssetHandle load_babylon/);
    assert.match(lowered.source, /material\.standard_material = true/);
    assert.match(lowered.source, /material\.alpha_cutoff = 0\.4f/);
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
    assert.match(mesh.source, /mesh\.dimensions = Vec3\{resolved_size, resolved_size, resolved_size\}/);
    assert.match(mesh.source, /geometry\.vertices\.insert/);
    assert.match(mesh.source, /vertex\.local_position = vertex\.position/);
    assert.match(mesh.source, /geometry\.indices = \{3, 1, 0, 2, 3, 0\}/);
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
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
    assert.match(lowered.source, /light\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/);
    assert.match(lowered.source, /light\.ground_color = Color3\{0\.0f, 0\.0f, 0\.0f\}/);
    assert.match(point.source, /light\.kind = LightKind::point/);
    assert.match(point.source, /light\.position = position/);
    assert.match(point.source, /light\.range = std::numeric_limits<float>::max\(\)/);
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
    const lowered = lowerer.lowerRenderPlan();
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
    assert.match(lowered.source, /build_render_plan/);
    assert.match(lowered.source, /build_render_draw_lists/);
    assert.match(lowered.source, /build_render_task_draw_lists/);
    assert.match(lowered.source, /build_render_features/);
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
    assert.ok(shaders.some((shader) => shader.output.endsWith("pbr.frag.hlsl")));
    assert.ok(shaders.every((shader) => /\.(?:hlsl|msl)$/.test(shader.output)));
    const fragment = shaders.find((shader) => shader.output.endsWith("pbr.frag.hlsl"));
    assert.equal(typeof fragment?.data, "string");
    assert.match(String(fragment?.data), /geometrySmithGGX/);
    assert.match(String(fragment?.data), /SV_IsFrontFace/);
    assert.match(String(fragment?.data), /normalOptions\.x > 0\.5/);
    assert.match(String(fragment?.data), /input\.color\.rgb/);
    assert.match(String(fragment?.data), /input\.color\.a/);
    assert.match(String(fragment?.data), /dielectricF0 = normalOptions\.z/);
    assert.match(
        String(fragment?.data),
        /evaluateIrradiance\(normal\) \* materialFactors\.w/,
    );
    assert.match(String(fragment?.data), /luminanceOverAlpha/);
    assert.ok(shaders.some((shader) => shader.output.endsWith("alpha-card.vert.hlsl")));
    assert.ok(
        shaders.some((shader) =>
            shader.output.endsWith("circular-cutout.frag.hlsl"),
        ),
    );
    const diagnosticC = shaders.find((shader) =>
        shader.output.endsWith("pbr-diagnostics-c.frag.hlsl"),
    );
    assert.match(String(diagnosticC?.data), /baseColor/);
    assert.match(String(diagnosticC?.data), /preToneHdr/);
    assert.match(String(fragment?.data), /1\.590579/);
    assert.equal(fidelity.sourceLanguage, "WGSL");
    assert.deepEqual(fidelity.compiledArtifacts, ["DXIL", "SPIR-V"]);
    assert.ok(fidelity.invariants.some(({ id }) => id === "rgbd-cubemap-y-flip"));
    assert.ok(fidelity.invariants.some(({ id }) => id === "surface-msaa"));
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
    const hlsl = shaders.find((shader) =>
        shader.output.endsWith("grid.frag.hlsl"),
    );
    const msl = shaders.find((shader) =>
        shader.output.endsWith("grid.frag.msl"),
    );
    assert.match(String(hlsl?.data), /gridDynamicVisibility/);
    assert.match(
        String(hlsl?.data),
        /Generated from @babylonjs\/lite@1\.18\.0/,
    );
    assert.match(String(hlsl?.data), /cos\(fraction \* PI\)/);
    assert.match(String(hlsl?.data), /SQRT2 \/ 4\.0/);
    assert.match(String(hlsl?.data), /max\(max\(x, y\), z\)/);
    assert.match(String(msl?.data), /dfdx\(position\)/);
    assert.match(String(msl?.data), /uniforms\.gridControl\.w \* grid/);
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
    const geometry = shaders.find((shader) =>
        shader.output.endsWith("pbr-geometry-0.frag.hlsl"),
    );
    assert.match(String(geometry?.data), /SV_Target7/);
    assert.match(
        String(geometry?.data),
        /directDiffuse \+ finalIrradiance/,
    );
    assert.match(String(geometry?.data), /input\.worldPosition/);
    assert.ok(
        shaders.some((shader) => shader.output.endsWith("blit.frag.hlsl")),
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
                    "REFLECTIVITY",
                    "ALBEDO",
                ],
                emitColor: true,
            },
        ],
    });
    const geometry = shaders.find((shader) =>
        shader.output.endsWith("standard-geometry-0.frag.hlsl"),
    );
    assert.match(String(geometry?.data), /float4\(0\.0, 0\.0, 0\.0/);
    assert.match(String(geometry?.data), /pow\(specularSample\.rgb/);
    assert.match(String(geometry?.data), /reflectionTexture/);
    assert.match(String(geometry?.data), /output\.color = color/);
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
            shader.output.endsWith("alpha-card.frag.hlsl"),
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
        shader.output.endsWith("circular-cutout.frag.hlsl"),
    );
    assert.match(String(fragment?.data), /distance\(input\.uv/);
    assert.match(String(fragment?.data), /discard/);
    assert.ok(
        !circularCutout.some((shader) => shader.output.includes("alpha-card")),
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
