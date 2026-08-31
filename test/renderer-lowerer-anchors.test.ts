import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import {
    RendererLowerer,
    lowerOpaqueOrderStamp,
} from "../src/lowering/renderer-lowerer.js";
import {
    extractPackagedStringLiteral,
    extractPackagedTemplateLiteral,
    readPinnedLibraryModule,
} from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const sharedStore = new UpstreamSourceStore();

/** A doctored pin: the module's source with exact edits applied. */
function doctoredSourceFile(
    modulePath: string,
    edits: readonly [needle: string, replacement: string][],
): ts.SourceFile {
    let source = sharedStore.getSource(modulePath);
    for (const [needle, replacement] of edits) {
        assert.ok(
            source.includes(needle),
            `the pinned source no longer contains '${needle}'`,
        );
        source = source.replaceAll(needle, replacement);
    }
    return ts.createSourceFile(
        modulePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

const orderStampModules = [
    "src/material/pbr/pbr-renderable.ts",
    "src/material/pbr/pbr-geometry-renderable.ts",
    "src/material/standard/standard-renderable.ts",
    "src/material/standard/standard-geometry-renderable.ts",
    "src/material/shader/shader-renderable.ts",
    "src/material/shader/shader-thin-instance.ts",
] as const;

/**
 * RD-3 anchors: the renderer lowerer's math emissions are paired with their
 * pinned writers (view transpose, perspective stores, TRS composition), the
 * fogInfos packing order is the pinned WGSL_FOG contract, the monolithic
 * PbrUniforms extension lanes are pruned to the fixed capture-only base
 * block, the cubemap-skybox stages are lifted from the packaged pin, the
 * draw-list bucket/sort/pipeline-kind rules and the light-slot packing are
 * anchored to their pinned modules, and the background geometry tables flow
 * from the pinned builders.
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
        fog: true,
        punctualLights: true,
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
    // eulerToQuat's four products, printed from the pinned tuple through
    // the shared translator (double operands, explicit parenthesization).
    assert.match(
        plan.source,
        /qx = \(\(\(sx \* cy\) \* cz\) \+ \(\(cx \* sy\) \* sz\)\);/,
    );
    assert.match(
        plan.source,
        /qy = \(\(\(cx \* sy\) \* cz\) - \(\(sx \* cy\) \* sz\)\);/,
    );
    assert.match(
        plan.source,
        /qz = \(\(\(cx \* cy\) \* sz\) \+ \(\(sx \* sy\) \* cz\)\);/,
    );
    assert.match(
        plan.source,
        /qw = \(\(\(cx \* cy\) \* cz\) - \(\(sx \* sy\) \* sz\)\);/,
    );
    // mat4ComposeInto's quaternion basis, printed from the pinned stores.
    assert.match(plan.source, /const double xx = \(qx \* qx\);/);
    assert.match(plan.source, /const double wz = \(qw \* qz\);/);
    assert.match(
        plan.source,
        /local\[0\] = \(\(1\.0 - \(2\.0 \* \(yy \+ zz\)\)\) \* scale_x\);/,
    );
    assert.match(
        plan.source,
        /local\[6\] = \(\(2\.0 \* \(yz \+ wx\)\) \* scale_y\);/,
    );
    assert.match(
        plan.source,
        /local\[9\] = \(\(2\.0 \* \(yz - wx\)\) \* scale_z\);/,
    );
    assert.match(plan.source, /local\[12\] = mesh\.position\.x;/);
    assert.match(plan.source, /local\[15\] = 1\.0;/);
});

test("translates the pinned multiply writer whole", () => {
    // Pinned drift now flows into different emitted bytes rather than
    // throwing at a per-term anchor, so the regexes below pin the emission.
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    // The multiply is the pinned writer translated whole — the unrolled
    // accumulation in the pin's own order, templated on the right
    // operand's storage; the projection writers' emitted rows are pinned
    // by the upstream test that owns them ("translates the pinned
    // perspective writer whole").
    assert.match(plan.source, /template <typename MatB>\nvoid mat4_multiply_into\(/);
    assert.match(
        plan.source,
        /\(\(\(\(a0 \* b0\) \+ \(a4 \* b1\)\) \+ \(a8 \* b2\)\) \+ \(a12 \* b3\)\)/,
    );
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

test("anchors the draw-list rules to the pinned bucket fork", () => {
    // The pinned fork the anchors inside lowerRenderPlan pair with: a
    // failed pairing throws there, so this test both re-states the pin's
    // side and checks the emitted rules still carry the transcription.
    const renderTask = sharedStore.getSource(
        "src/frame-graph/render-task.ts",
    );
    assert.ok(
        renderTask.includes("if (r.isTransparent || r._transmissive) {"),
    );
    assert.ok(renderTask.includes("} else if (r._direct) {"));
    assert.ok(
        renderTask.includes(
            "opaque.sort((a, b) => a.renderable.order - b.renderable.order);",
        ),
    );
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    // append_draw transcribes the pinned transparent predicate.
    assert.match(
        plan.source,
        /item\.bucket == RenderBucket::alpha_blend \|\|\s*\r?\n\s*item\.transmissive\s*\r?\n\s*\? result\.transparent\s*\r?\n\s*: result\.opaque;/,
    );
    // The record rule behind item.transmissive is the pinned
    // needsTransmission predicate (factor > 0 or a declared texture).
    assert.match(
        plan.source,
        /item\.transmissive = material\.transmission_factor > 0\.0f \|\|\s*\r?\n\s*!material\.transmission_texture\.bytes\.empty\(\);/,
    );
    // The transparent comparator keeps the pinned direction and tie-break.
    assert.match(
        plan.source,
        /return left\.sort_distance > right\.sort_distance \|\|\s*\r?\n\s*\(left\.sort_distance == right\.sort_distance &&\s*\r?\n\s*left\.item\.order < right\.item\.order\);/,
    );
    // The loader-authored baseline prevents glTF single-sided primitives
    // from flipping twice, while a procedural PBR mesh can still cross the
    // determinant sign boundary at runtime. Both cull modes therefore carry
    // the watcher-resolved clockwise state into the pipeline key.
    assert.match(plan.header, /pbr_opaque_back_clockwise/);
    assert.match(plan.header, /pbr_transparent_back_clockwise/);
    assert.match(
        plan.source,
        /if \(!double_sided\) \{\s*return item\.clockwise_front_face\s*\? RenderPipelineKind::pbr_transparent_back_clockwise\s*: RenderPipelineKind::pbr_transparent_back;/,
    );
    assert.match(
        plan.source,
        /if \(!double_sided\) \{\s*return item\.clockwise_front_face\s*\? RenderPipelineKind::pbr_opaque_back_clockwise\s*: RenderPipelineKind::pbr_opaque_back;/,
    );
    assert.match(plan.header, /pbr_opaque_none_clockwise/);
});

test("adopts pinned defaults and transports explicit render order", () => {
    // Every reachable renderable module stamps the same non-transparent
    // default. Explicit mesh order still participates in the pinned
    // buildBindings stable sort.
    assert.equal(
        lowerOpaqueOrderStamp(
            orderStampModules.map((modulePath) =>
                sharedStore.getSourceFile(modulePath)
            ),
        ),
        "100",
    );
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    // The invented pipeline grouping is gone. The generated plan carries
    // the source's default, optional override, and stable ordering rule.
    assert.ok(!plan.source.includes("pipeline_order("));
    assert.match(plan.source, /pin-adopted\(opaque-order\)/);
    assert.match(
        plan.source,
        /bound\.order = mesh\.has_render_order\s*\? mesh\.render_order\s*:\s*default_render_order\(bound\)/,
    );
    assert.match(
        plan.source,
        /std::stable_sort\([\s\S]*left\.item\.order < right\.item\.order/,
    );
});

test("a moved shared opaque stamp flows out of the lowering", () => {
    const stamp = lowerOpaqueOrderStamp([
        doctoredSourceFile("src/material/pbr/pbr-renderable.ts", [
            ["needsTaskRefraction ? 150 : 100", "needsTaskRefraction ? 150 : 90"],
        ]),
        doctoredSourceFile("src/material/pbr/pbr-geometry-renderable.ts", [
            ["isAlphaBlend ? 200 : 100", "isAlphaBlend ? 200 : 90"],
        ]),
        doctoredSourceFile("src/material/standard/standard-renderable.ts", [
            ["isTransparent ? 200 : 100", "isTransparent ? 200 : 90"],
        ]),
        doctoredSourceFile(
            "src/material/standard/standard-geometry-renderable.ts",
            [["isAlphaBlend ? 200 : 100", "isAlphaBlend ? 200 : 90"]],
        ),
        doctoredSourceFile("src/material/shader/shader-renderable.ts", [
            ["renderOrder ?? 100", "renderOrder ?? 90"],
        ]),
        doctoredSourceFile("src/material/shader/shader-thin-instance.ts", [
            ["isTransparent ? 200 : 100", "isTransparent ? 200 : 90"],
        ]),
    ]);
    assert.equal(stamp, "90");
});

test("opaque stamps that split across families refuse generation", () => {
    assert.throws(
        () =>
            lowerOpaqueOrderStamp([
                doctoredSourceFile("src/material/pbr/pbr-renderable.ts", [
                    [
                        "needsTaskRefraction ? 150 : 100",
                        "needsTaskRefraction ? 150 : 90",
                    ],
                ]),
                sharedStore.getSourceFile(
                    "src/material/standard/standard-renderable.ts",
                ),
            ]),
        /no longer stamp one shared opaque order/,
    );
});

test("an order stamp that stops substituting renderOrder refuses", () => {
    assert.throws(
        () =>
            lowerOpaqueOrderStamp([
                doctoredSourceFile(
                    "src/material/standard/standard-renderable.ts",
                    [[
                        "order: mesh.renderOrder ?? (isTransparent ? 200 : 100),",
                        "order: mesh.drawRank ?? (isTransparent ? 200 : 100),",
                    ]],
                ),
            ]),
        /no longer substitutes mesh\.renderOrder/,
    );
});

test("a plain stamp with no literal transparency to classify it refuses", () => {
    assert.throws(
        () =>
            lowerOpaqueOrderStamp([
                doctoredSourceFile(
                    "src/material/shader/shader-renderable.ts",
                    [["isTransparent: false,", "isTransparent: opaqueFlag,"]],
                ),
            ]),
        /no literal isTransparent sibling/,
    );
});

test("adopts the pinned transparent sort center: the draw world's translation", () => {
    // The pinned families store sortCenter = worldMatrix[12..14]; the
    // record carries that world as instance_parent_matrix composed with
    // the live TRS position and, for imported root clones, the outer
    // post-deformation translation. The pinned lines are anchored inside
    // lowerRenderPlan, so drift throws there.
    for (const [modulePath, marker] of [
        [
            "src/material/pbr/pbr-renderable.ts",
            "const sortCenter = isTransparent || needsTaskRefraction ? ([mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number]) : null;",
        ],
        [
            "src/material/standard/standard-renderable.ts",
            "const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];",
        ],
    ] as const) {
        assert.ok(
            sharedStore.getSource(modulePath).includes(marker),
            `pinned ${modulePath} no longer stores the world-translation sort center`,
        );
    }
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    assert.match(plan.source, /pin-adopted\(sort-center\)/);
    assert.match(
        plan.source,
        /const std::array<float, 16>& parent = mesh\.instance_parent_matrix;/,
    );
    assert.match(
        plan.source,
        // The row accumulates in double -- `mesh.position` is the record's
        // own width -- and narrows once before the imported root's outer
        // rotation and translation are applied.
        /parent\[0\] \* mesh\.position\.x \+ parent\[4\] \* mesh\.position\.y \+\s*\r?\n\s*parent\[8\] \* mesh\.position\.z \+ parent\[12\]\),/,
    );
    assert.match(
        plan.source,
        /rotate_outer_point\(\s*local_center, mesh\.outer_rotation\)/,
    );
    assert.match(plan.source, /rotated_center\.x \+ mesh\.outer_position\.x/);
    assert.match(plan.source, /rotated_center\.y \+ mesh\.outer_position\.y/);
    assert.match(plan.source, /rotated_center\.z \+ mesh\.outer_position\.z/);
    // The bounds-center derivation and its euler helper are gone; the
    // anchored comparator and view-forward distance stay.
    assert.ok(!plan.source.includes("rotate_euler"));
    assert.ok(!plan.source.includes("bounds_min"));
    assert.match(plan.source, /command\.sort_distance = dot\(delta, forward\);/);
});

test("anchors the light-slot packing to the pinned lights-ubo module", () => {
    const lightsUbo = sharedStore.getSource("src/render/lights-ubo.ts");
    // The pinned loops the PALs walk against the emitted
    // light_affects_mesh: both advance their slot cursor only for
    // _writeLightUbo lights, which keeps a mesh's packed indices aligned
    // with the UBO slots.
    assert.ok(
        lightsUbo.includes(
            "u32[MSH_LIGHT_INDEX_WORD_OFFSET + count] = pi;",
        ),
    );
    assert.ok(lightsUbo.includes("u32[16] = count;"));
    assert.ok(
        lightsUbo.includes(
            "light._writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS);",
        ),
    );
    const plan = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({});
    // The emitted affectsMesh transcription: included list wins when
    // non-empty, exclusion filters otherwise.
    assert.match(
        plan.source,
        /if \(light\.included_meshes\.empty\(\)\) \{\s*\r?\n\s*return std::find\(\s*\r?\n\s*light\.excluded_meshes\.begin\(\),\s*\r?\n\s*light\.excluded_meshes\.end\(\),\s*\r?\n\s*mesh_index\) == light\.excluded_meshes\.end\(\);/,
    );
    assert.match(
        plan.source,
        /return std::find\(\s*\r?\n\s*light\.included_meshes\.begin\(\),\s*\r?\n\s*light\.included_meshes\.end\(\),\s*\r?\n\s*mesh_index\) != light\.included_meshes\.end\(\);/,
    );
});

test("derives the background geometry from the pinned builders", () => {
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan(
        { imageSkybox: true, solidSkybox: true },
    );
    // The ground quad: pinned XY corners composed with the pinned
    // XY-to-XZ world, BACKSIDE winding and UVs flowing unchanged.
    assert.ok(
        plan.source.includes(
            "ModelVertex{Vec3{center.x - half, center.y, center.z + half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 0.0f}},",
        ),
    );
    assert.ok(
        plan.source.includes(
            "ModelVertex{Vec3{center.x + half, center.y, center.z - half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 1.0f}},",
        ),
    );
    assert.ok(plan.source.includes("result.indices = {0, 2, 1, 0, 3, 2};"));
    // The pinned ground alpha rides the uniforms block.
    assert.match(plan.source, /0\.9f,/);
    // The skybox cube: the shared pinned corner order and winding, in the
    // DDS/HDR plan, the solid plan and the borrowed image-skybox table.
    const cornerRow = "        {-half, -half, -half},";
    const windingRow = "        6, 4, 5, 7, 6, 5,";
    assert.ok(plan.source.includes("vertex(-half, -half, -half),"));
    assert.equal(
        plan.source.split(cornerRow).length,
        3,
        "solid and image skybox plans share the pinned corner table",
    );
    assert.equal(
        plan.source.split(windingRow).length,
        4,
        "all three cube plans share the pinned winding",
    );
});

test("re-lowering emits byte-identical renderer text", () => {
    const options = {
        fog: true,
        imageSkybox: true,
        solidSkybox: true,
        environmentRotation: true,
        gpuInstancing: true,
        punctualLights: true,
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
