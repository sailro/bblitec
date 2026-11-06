import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { lowerPipelineFrontFaces } from "../src/lowering/pipeline-front-face.js";
import { probeValue, rightHandedProbes } from "./right-handed-process.js";
import {
    RendererLowerer,
    lowerOpaqueOrderStamp,
} from "../src/lowering/renderer-lowerer.js";
import {
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
            fog.includes(`let ${name}=scene.vFogInfos.${component};`),
            `pinned WGSL_FOG no longer reads ${name} from .${component}`,
        );
    }
    // The fog lowering asserts the same order before it emits.
    assert.doesNotThrow(() =>
        new RendererLowerer(new LoweringContext()).lowerRenderPlan({
            fog: true,
        }),
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
    const baseline = new RendererLowerer(new LoweringContext()).lowerRenderPlan(
        {},
    );
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
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
    // The eye reads and the transpose index pairs flow from the pinned
    // stores; these are the derived bytes, not hand-typed ones.
    assert.match(
        plan.source,
        /const double cx = static_cast<double>\(world\[12\]\);/,
    );
    // The Float32Array store converts explicitly: a floating-origin world
    // is double (GC-20).
    assert.match(plan.source, /view\[0\] = static_cast<float>\(world\[0\]\);/);
    assert.match(plan.source, /view\[6\] = static_cast<float>\(world\[9\]\);/);
    assert.match(plan.source, /view\[11\] = 0\.0f;/);
    assert.match(
        plan.source,
        /view\[12\] = static_cast<float>\(\s*\r?\n\s*-\(static_cast<double>\(world\[0\]\) \* cx \+\s*\r?\n\s*static_cast<double>\(world\[1\]\) \* cy \+\s*\r?\n\s*static_cast<double>\(world\[2\]\) \* cz\)\);/,
    );
    assert.match(plan.source, /view\[15\] = 1\.0f;/);
});

test("derives the thin-instance TRS terms from the pinned writers", () => {
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({
        gpuInstancing: true,
    });
    // The composition lives once, in the always-emitted world-transform
    // header; the render plan's mesh, transform-node, thin-instance and
    // eye-relative worlds all call it there.
    assert.match(
        plan.source,
        /std::array<float, 16> mesh_local_matrix\(const MeshRecord& mesh\) \{\n {4}return trs_matrix\(mesh\);/,
    );
    assert.match(plan.source, /transform_node_world_view\(engine, node\)/);
    assert.match(
        plan.source,
        /const std::array<double, 16> local = trs_local_matrix\(mesh\);/,
    );
    assert.doesNotMatch(plan.source, /const double cx = std::cos/);
    const header = pinnedWorldTransformHeader(new LoweringContext());
    // eulerXYZToQuatTuple's four products, printed from the pinned tuple through
    // the shared translator (double operands, explicit parenthesization).
    assert.match(
        header,
        /qx = \(\(\(sx \* cy\) \* cz\) \+ \(\(cx \* sy\) \* sz\)\);/,
    );
    assert.match(
        header,
        /qy = \(\(\(cx \* sy\) \* cz\) - \(\(sx \* cy\) \* sz\)\);/,
    );
    assert.match(
        header,
        /qz = \(\(\(cx \* cy\) \* sz\) \+ \(\(sx \* sy\) \* cz\)\);/,
    );
    assert.match(
        header,
        /qw = \(\(\(cx \* cy\) \* cz\) - \(\(sx \* sy\) \* sz\)\);/,
    );
    // composeMat4IntoBuffer's quaternion basis, printed from the pinned stores.
    assert.match(header, /const double xx = \(qx \* qx\);/);
    assert.match(header, /const double wz = \(qw \* qz\);/);
    assert.match(
        header,
        /local\[0\] = \(\(1\.0 - \(2\.0 \* \(yy \+ zz\)\)\) \* scale_x\);/,
    );
    assert.match(
        header,
        /local\[6\] = \(\(2\.0 \* \(yz \+ wx\)\) \* scale_y\);/,
    );
    assert.match(
        header,
        /local\[9\] = \(\(2\.0 \* \(yz - wx\)\) \* scale_z\);/,
    );
    assert.match(header, /local\[12\] = mesh\.position\.x;/);
    assert.match(header, /local\[15\] = 1\.0;/);
});

test("translates the pinned multiply writer whole", () => {
    // Pinned drift now flows into different emitted bytes rather than
    // throwing at a per-term anchor, so the regexes below pin the emission.
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
    // The multiply is the pinned writer translated whole — the unrolled
    // accumulation in the pin's own order, templated on both operands'
    // storage; the projection writers' emitted rows are pinned
    // by the upstream test that owns them ("translates the pinned
    // perspective writer whole").
    assert.match(plan.source, /#include <bblite\/upstream\/pinned_matrix.hpp>/);
    const matrixHeader = pinnedMatrixHeader(new LoweringContext());
    assert.match(
        matrixHeader,
        /template <typename MatA, typename MatB>\nvoid mat4_multiply_into\(/,
    );
    assert.match(
        matrixHeader,
        /\(\(\(\(a0 \* b0\) \+ \(a4 \* b1\)\) \+ \(a8 \* b2\)\) \+ \(a12 \* b3\)\)/,
    );
});

test("caches opaque visibility at build and retains transparent bindings", () => {
    // The lists are the pin's cached opaque render bundles: `visible` is
    // read when a bundle is RECORDED, so the filter sits at list build and
    // a visibility change lands by re-running the build. setMeshVisible
    // bumps the visibility epoch to force that re-run the same frame; a
    // bare field write bumps nothing and defers to the next rebuild -- the
    // deferral the regression-mesh-flags gate measures. Moving this test
    // per draw would break that gate; dropping it while the epoch rebuild
    // exists would freeze every toggle (the quake weapon-switch defect).
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
    const appendDraw = plan.source.slice(
        plan.source.indexOf("void append_draw("),
        plan.source.indexOf("void order_draw_lists("),
    );
    assert.ok(
        appendDraw.length > 0,
        "append_draw not found before order_draw_lists",
    );
    assert.match(
        appendDraw,
        /if \(!mesh_draws\(bbl::handle_at\(engine\.meshes, item\.mesh\)\)\) \{\s*\r?\n\s*return;/,
    );
    assert.ok(
        appendDraw.indexOf("list.visibility_candidates.push_back(command)") <
            appendDraw.indexOf("if (!mesh_draws("),
    );
});

test("anchors the draw-list rules to the pinned bucket fork", () => {
    // The pinned fork the anchors inside lowerRenderPlan pair with: a
    // failed pairing throws there, so this test both re-states the pin's
    // side and checks the emitted rules still carry the transcription.
    const renderTask = sharedStore.getSource(
        "src/frame-graph/render-task-base.ts",
    );
    assert.ok(
        renderTask.includes(
            "if (renderable.isTransparent || renderable._transmissive) {",
        ),
    );
    assert.ok(renderTask.includes("} else if (renderable._direct) {"));
    assert.ok(renderTask.includes("opaque.sort(compareBindingOrder);"));
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
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
    // The winding is the kind's own axis beside its arm, lowered from each
    // family's folded descriptor: a left-handed PBR pipeline spreads the
    // mesh's primitive state, so the watcher-resolved mark winds it in
    // either cull mode; the other families state "ccw".
    assert.doesNotMatch(plan.header, /_clockwise,/);
    assert.match(
        plan.header,
        /struct RenderPipelineKind \{\s*RenderPipelineArm arm = RenderPipelineArm::pbr_opaque_back;\s*bool clockwise_front_face = false;/,
    );
    assert.match(
        plan.header,
        /case RenderMaterialKind::pbr:\s*return reverse_winding;\s*case RenderMaterialKind::standard:\s*return false;\s*case RenderMaterialKind::shader:\s*return false;\s*case RenderMaterialKind::node:\s*return false;/,
    );
    assert.match(
        plan.source,
        /render_pipeline_clockwise\(item\.material_kind, item\.reverse_winding\)/,
    );
});

test("each family's front face follows its folded pipeline descriptor", () => {
    const context = new LoweringContext();
    // Left-handed, only PBR spreads the mesh's primitive state; the
    // mirrored opt-in installs the Standard resolver that winds by the mark.
    assert.deepEqual(lowerPipelineFrontFaces(context, false), {
        pbr: ["ccw", "cw"],
        standard: ["ccw", "ccw"],
        shader: ["ccw", "ccw"],
        node: ["ccw", "ccw"],
    });
    assert.deepEqual(lowerPipelineFrontFaces(context, true).standard, [
        "ccw",
        "cw",
    ]);
    // Right-handed, every family reverses: procedural meshes "cw", marked
    // (glTF-wound or mirrored) ones "ccw", with or without the opt-in.
    const reversed = ["cw", "ccw"];
    for (const outcome of rightHandedProbes([
        { probe: "pipelineFrontFaces", argument: false },
        { probe: "pipelineFrontFaces", argument: true },
    ]))
        assert.deepEqual(probeValue(outcome), {
            pbr: reversed,
            standard: reversed,
            shader: reversed,
            node: reversed,
        });
});

test("adopts pinned defaults and transports explicit render order", () => {
    // Every reachable renderable module stamps the same non-transparent
    // default. Explicit mesh order still participates in the pinned
    // buildBindings stable sort.
    assert.equal(
        lowerOpaqueOrderStamp(
            orderStampModules.map((modulePath) =>
                sharedStore.getSourceFile(modulePath),
            ),
        ),
        "100",
    );
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
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
            [
                "needsTaskRefraction ? 150 : 100",
                "needsTaskRefraction ? 150 : 90",
            ],
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
            ["transparent ? 200 : 100", "transparent ? 200 : 90"],
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
                    [
                        [
                            "order: mesh.renderOrder ?? (isTransparent ? 200 : 100),",
                            "order: mesh.drawRank ?? (isTransparent ? 200 : 100),",
                        ],
                    ],
                ),
            ]),
        /no longer substitutes mesh\.renderOrder/,
    );
});

test("a merged stamp that leaves the shared opaque order refuses", () => {
    assert.throws(
        () =>
            lowerOpaqueOrderStamp([
                doctoredSourceFile("src/material/shader/shader-renderable.ts", [
                    ["renderOrder ?? 100", "renderOrder ?? 200"],
                ]),
            ]),
        /no longer stamp one shared opaque order/,
    );
});

test("adopts the pinned transparent sort center: the draw world's translation", () => {
    // The pinned families store sortCenter = worldMatrix[12..14], which is
    // the record's mesh_world_matrix translation. The pinned lines are
    // anchored inside lowerRenderPlan, so drift throws there.
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
    // sortTransparentBindings sorts by that center's depth in the pinned
    // view matrix (anchored by `assertPinnedTransparentSort`).
    assert.ok(
        sharedStore
            .getSource("src/frame-graph/render-task-base.ts")
            .includes(
                "b._sortDistance = wc ? wc[0]! * v[2]! + wc[1]! * v[6]! + wc[2]! * v[10]! + v[14]! : 0;",
            ),
        "pinned sortTransparentBindings no longer sorts by view-space depth",
    );
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
    assert.match(plan.source, /pin-adopted\(sort-center\)/);
    assert.match(
        plan.source,
        /const std::array<float, 16> view = build_camera_view_matrix\(\*camera\);/,
    );
    assert.match(
        plan.source,
        /const std::array<float, 16> world = mesh_world_matrix\(engine, mesh\);[\s\S]*?command\.sort_distance = static_cast<float>\(\s*static_cast<double>\(world\[12\]\) \* view\[2\] \+\s*static_cast<double>\(world\[13\]\) \* view\[6\] \+\s*static_cast<double>\(world\[14\]\) \* view\[10\] \+ view\[14\]\);/,
    );
    assert.match(
        plan.source,
        /#include <bblite\/upstream\/pinned_world_transform\.hpp>/,
    );
    // The bounds-center derivation and its euler helper are gone.
    assert.ok(!plan.source.includes("rotate_euler"));
    assert.ok(!plan.source.includes("bounds_min"));
});

test("anchors the light-slot packing to the pinned lights-ubo module", () => {
    const lightsUbo =
        sharedStore.getSource("src/render/scene-lights-ubo.ts") +
        sharedStore.getSource("src/render/mesh-light-selection.ts");
    // The pinned loops the PALs walk against the emitted
    // light_affects_mesh: both advance their slot cursor only for
    // _writeLightUbo lights, which keeps a mesh's packed indices aligned
    // with the UBO slots.
    assert.ok(
        lightsUbo.includes("u32[MSH_LIGHT_INDEX_WORD_OFFSET + count] = pi;"),
    );
    assert.ok(lightsUbo.includes("u32[16] = count;"));
    assert.ok(
        lightsUbo.includes(
            "light._writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS);",
        ),
    );
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
    // The emitted affectsMesh transcription: included list wins when
    // non-empty, exclusion filters otherwise.
    assert.match(
        plan.source,
        /if \(light\.included_meshes\.empty\(\)\) \{\s*\r?\n\s*return std::find\(\s*\r?\n\s*light\.excluded_meshes\.begin\(\),\s*\r?\n\s*light\.excluded_meshes\.end\(\),\s*\r?\n\s*mesh\) == light\.excluded_meshes\.end\(\);/,
    );
    assert.match(
        plan.source,
        /return std::find\(\s*\r?\n\s*light\.included_meshes\.begin\(\),\s*\r?\n\s*light\.included_meshes\.end\(\),\s*\r?\n\s*mesh\) != light\.included_meshes\.end\(\);/,
    );
});

test("re-lowering emits byte-identical renderer text", () => {
    const options = {
        fog: true,
        environmentRotation: true,
        gpuInstancing: true,
        punctualLights: true,
        nodeVisibility: true,
    };
    const first = new RendererLowerer(new LoweringContext()).lowerRenderPlan(
        options,
    );
    const second = new RendererLowerer(new LoweringContext()).lowerRenderPlan(
        options,
    );
    assert.equal(first.header, second.header);
    assert.equal(first.source, second.source);
    const shaderOptions = {
        fog: true,
        transmission: false,
        shaderPrograms: [],
        gridMaterial: false,
        idDiagnostics: false,
        geometryOutputTasks: [],
    };
    assert.deepEqual(
        new RendererLowerer(new LoweringContext()).lowerShaders(shaderOptions),
        new RendererLowerer(new LoweringContext()).lowerShaders(shaderOptions),
    );
});

test("reads the linear pass's tone-mapping flag off the pin", () => {
    const plan = new RendererLowerer(new LoweringContext()).lowerRenderPlan({});
    // Every image-processing tail upstream is gated on the scene block's
    // `vImageInfos.w >= 0.0`, and executeRenderTaskLinear writes a
    // negative there for the retargeted linear pass. The value is read
    // off the pin rather than spelled here: what is asserted is its
    // shape, one negative constant the PALs' scene block writes.
    assert.match(
        plan.header,
        /inline constexpr float pinned_linear_tone_mapping = -[0-9.]+f;/,
    );
});
