import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import {
    extractPackagedStringLiteral,
    extractPackagedTemplateLiteral,
    readPinnedLibraryModule,
} from "../src/pinned-shader-composer.js";

/**
 * RD-3 anchors: the renderer lowerer's math emissions are paired with their
 * pinned writers (view transpose, perspective stores, TRS composition), the
 * fogInfos packing order is the pinned WGSL_FOG contract, the monolithic
 * PbrUniforms extension lanes are pruned to the fixed capture-only base
 * block, and the cubemap-skybox stages are lifted from the packaged pin.
 */

const prunedLaneNames = [
    "fog_infos",
    "fog_color",
    "refraction_params",
    "volume_params",
    "transmission_options",
    "extra_light_positions",
    "extra_light_colors",
    "extra_light_directions",
    "reflectance_factors",
    "metallic_reflectance_color",
    "_uv_m",
    "_uv_t",
    "clearcoat_params",
    "clearcoat_refraction_params",
    "sheen_params",
    "iridescence_params",
    "iridescence_options",
    "occlusion_params",
];

function pbrUniformsStruct(header: string): string {
    const start = header.indexOf("struct PbrUniforms {");
    assert.ok(start >= 0, "expected a PbrUniforms declaration");
    // Fields end in `{};` too, so the struct closes at the first brace
    // that sits at column zero.
    const end = header.indexOf("\n};", start);
    assert.ok(end > start, "expected a terminated PbrUniforms declaration");
    return header.slice(start, end + 3);
}

test("anchors the fogInfos packing order to the pinned WGSL_FOG reads", () => {
    const fog = extractPackagedTemplateLiteral(
        readPinnedLibraryModule("shader/wgsl-fog.js"),
        "WGSL_FOG",
    );
    // The pin names its own inputs, one per component; the emission below
    // packs the same order, derived from the same table.
    for (const [component, name] of [
        ["x", "fogMode"],
        ["y", "fogStart"],
        ["z", "fogEnd"],
        ["w", "fogDensity"],
    ] as const) {
        assert.ok(
            fog.includes(`let ${name} = scene.vFogInfos.${component};`),
            `pinned WGSL_FOG no longer reads ${name} from .${component}`,
        );
    }
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({ imageSkybox: true });
    assert.match(
        plan.source,
        /result\.fog_infos = \{\s*\r?\n\s*scene\.fog_mode,\s*\r?\n\s*scene\.fog_start,\s*\r?\n\s*scene\.fog_end,\s*\r?\n\s*scene\.fog_density,\s*\r?\n\s*\};/,
    );
});

test("prunes the PbrUniforms extension lanes to the fixed base block", () => {
    const lowerer = new RendererLowerer(new LoweringContext());
    const specialized = lowerer.lowerRenderPlan({
        transmission: true,
        fog: true,
        textureTransform: true,
        materialSpecular: true,
        occlusionUv2: true,
        punctualLights: true,
        clearcoat: true,
        sheen: true,
        sheenAlbedoScaling: true,
        iridescence: true,
        dispersion: true,
    });
    const struct = pbrUniformsStruct(specialized.header);
    for (const lane of prunedLaneNames) {
        assert.ok(
            !struct.includes(lane),
            `PbrUniforms still carries the pruned lane ${lane}`,
        );
    }
    assert.match(struct, /spherical_harmonics/);
    // Every option class emits the same fixed block.
    const baseline = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    assert.equal(struct, pbrUniformsStruct(baseline.header));
    // The base fills survive; the extension fills are gone with their
    // fields — those values live in the pinned material blocks.
    assert.match(specialized.source, /build_pbr_uniforms/);
    assert.match(
        specialized.source,
        /result\.light_color_2\[3\] \*= material\.direct_intensity;/,
    );
    for (const fill of [
        "result.fog_infos",
        "result.refraction_params",
        "result.clearcoat_params",
        "result.sheen_params",
        "result.iridescence_params",
        "result.occlusion_params",
        "result.reflectance_factors",
        "extra_light_positions",
        "_uv_m",
    ]) {
        assert.ok(
            !specialized.source.includes(fill),
            `build_pbr_uniforms still fills the pruned lane ${fill}`,
        );
    }
});

test("derives the view transpose from the pinned getViewMatrix store map", () => {
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    // The eye reads and the transpose index pairs flow from the pinned
    // stores; these are the derived bytes, not hand-typed ones.
    assert.match(
        plan.source,
        /const double cx = static_cast<double>\(world\[12\]\);/,
    );
    assert.match(plan.source, /view\[0\] = world\[0\];/);
    assert.match(plan.source, /view\[6\] = world\[9\];/);
    assert.match(plan.source, /view\[11\] = 0\.0f;/);
    assert.match(
        plan.source,
        /view\[12\] = static_cast<float>\(\s*\r?\n\s*-\(static_cast<double>\(world\[0\]\) \* cx \+\s*\r?\n\s*static_cast<double>\(world\[1\]\) \* cy \+\s*\r?\n\s*static_cast<double>\(world\[2\]\) \* cz\)\);/,
    );
    assert.match(plan.source, /view\[15\] = 1\.0f;/);
});

test("derives the thin-instance TRS terms from the pinned writers", () => {
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({ gpuInstancing: true });
    // eulerToQuat's four products, printed from the pinned tuple.
    assert.match(plan.source, /qx = sx \* cy \* cz \+ cx \* sy \* sz;/);
    assert.match(plan.source, /qy = cx \* sy \* cz - sx \* cy \* sz;/);
    assert.match(plan.source, /qz = cx \* cy \* sz \+ sx \* sy \* cz;/);
    assert.match(plan.source, /qw = cx \* cy \* cz - sx \* sy \* sz;/);
    // mat4ComposeInto's quaternion basis, printed from the pinned stores.
    assert.match(plan.source, /const double xx = qx \* qx;/);
    assert.match(plan.source, /const double wz = qw \* qz;/);
    assert.match(
        plan.source,
        /local\[0\] = \(1\.0 - 2\.0 \* \(yy \+ zz\)\) \* scale_x;/,
    );
    assert.match(plan.source, /local\[6\] = 2\.0 \* \(yz \+ wx\) \* scale_y;/);
    assert.match(plan.source, /local\[9\] = 2\.0 \* \(yz - wx\) \* scale_z;/);
    assert.match(plan.source, /local\[12\] = mesh\.position\.x;/);
    assert.match(plan.source, /local\[15\] = 1\.0;/);
});

test("the perspective and multiply anchors accept the pinned writers", () => {
    // Both anchors run inside lowerRenderPlan, so pinned drift throws here.
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    // The reverse-Z arms the anchors pair with stay in the emission, and
    // the multiply keeps the pinned accumulation shape.
    assert.match(plan.source, /reverse_depth \? -camera\.near_plane \/ range/);
    assert.match(
        plan.source,
        /\(camera\.far_plane \* camera\.near_plane\) \/ range/,
    );
    assert.match(plan.source, /static_cast<double>\(a\[row\]\) \* b0 \+/);
});

test("lifts the cubemap-skybox stages from the packaged pin", () => {
    // The packaged literals the lift reads.
    const module = readPinnedLibraryModule(
        "material/standard/skybox-cubemap.js",
    );
    const fragmentLiteral = extractPackagedStringLiteral(
        module,
        "skyFragSrc",
    );
    assert.ok(
        fragmentLiteral.includes("let e=normalize(b.vPositionLocal);"),
    );
    const shaders = new RendererLowerer(new LoweringContext()).lowerShaders({
        ground: false,
        skybox: false,
        imageSkybox: true,
        fog: true,
        transmission: false,
        normalTextureScale: false,
        shaderPrograms: [],
        gridMaterial: false,
        idDiagnostics: false,
        geometryOutputTasks: [],
    });
    const vertex = String(
        shaders.find((shader) =>
            shader.output.endsWith("skybox-cubemap.vert.native.wgsl"),
        )?.data,
    );
    const fragment = String(
        shaders.find((shader) =>
            shader.output.endsWith("skybox-cubemap.frag.native.wgsl"),
        )?.data,
    );
    // The pin's own statements, re-homed onto the native bindings.
    assert.match(vertex, /var a: VertexOutput;/);
    assert.match(vertex, /let b=vec4<f32>\(c,1\.0\);/);
    assert.match(vertex, /a\.vPositionW=b\.xyz;/);
    assert.match(vertex, /a\.clipPos=uniforms\.viewProjection\*b;/);
    assert.match(fragment, /let e=normalize\(b\.vPositionLocal\);/);
    assert.match(fragment, /var a=textureSample\(c,d,e\);/);
    assert.match(
        fragment,
        /let vFogDistance=\(uniforms\.view\*vec4<f32>\(b\.vPositionW,1\.0\)\)\.xyz;/,
    );
    assert.match(fragment, /bblCalcFogFactor\(vFogDistance\)/);
    assert.match(fragment, /mix\(uniforms\.fogColor\.rgb,a\.rgb,f\)/);
    // No pinned browser-frame reference survives the re-homing.
    assert.ok(!vertex.includes("scene.") && !vertex.includes("mesh."));
    assert.ok(!fragment.includes("scene."));
    // The native binding contract and entry points are preserved.
    assert.match(
        vertex,
        /@group\(1\) @binding\(0\) var<uniform> uniforms: VertexUniforms;/,
    );
    assert.match(vertex, /fn mainVertex\(@location\(0\) c: vec3<f32>\)/);
    assert.match(fragment, /@group\(2\) @binding\(0\) var c: texture_cube<f32>;/);
    assert.match(fragment, /@group\(2\) @binding\(1\) var d: sampler;/);
    assert.match(
        fragment,
        /@group\(3\) @binding\(0\) var<uniform> uniforms: FragmentUniforms;/,
    );
    assert.match(fragment, /fn mainFragment\(b: FragmentInput\)/);
    // The generated block matches the lifted fragment's uniform struct.
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({ imageSkybox: true });
    assert.match(
        plan.header,
        /struct ImageSkyboxUniforms \{\s*\r?\n\s*std::array<float, 16> view\{\};\s*\r?\n\s*std::array<float, 4> fog_infos\{\};\s*\r?\n\s*std::array<float, 4> fog_color\{\};\s*\r?\n\};/,
    );
    assert.match(
        plan.source,
        /result\.view = build_view_matrix\(camera_world_matrix\(camera\)\);/,
    );
});

test("re-lowering emits byte-identical renderer text", () => {
    const options = {
        transmission: true,
        fog: true,
        imageSkybox: true,
        solidSkybox: true,
        textureTransform: true,
        materialSpecular: true,
        occlusionUv2: true,
        environmentRotation: true,
        gpuInstancing: true,
        punctualLights: true,
        clearcoat: true,
        sheen: true,
        sheenAlbedoScaling: true,
        iridescence: true,
        dispersion: true,
        nodeVisibility: true,
    };
    const first = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan(options);
    const second = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan(options);
    assert.equal(first.header, second.header);
    assert.equal(first.source, second.source);
    const shaderOptions = {
        ground: false,
        skybox: false,
        imageSkybox: true,
        fog: true,
        transmission: false,
        normalTextureScale: false,
        shaderPrograms: [],
        gridMaterial: false,
        idDiagnostics: false,
        geometryOutputTasks: [],
    };
    assert.deepEqual(
        new RendererLowerer(new LoweringContext()).lowerShaders(
            shaderOptions,
        ),
        new RendererLowerer(new LoweringContext()).lowerShaders(
            shaderOptions,
        ),
    );
});
