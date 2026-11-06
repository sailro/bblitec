import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerMeshOpacity,
    meshOpacityFeatureBit,
    pinnedPbrRenderableFeatures,
    registerPinnedMeshOpacity,
} from "../src/lowering/mesh-opacity.js";
import { transparentDrawSkipCpp } from "../src/lowering/render-task-pass.js";
import { lowerRenderBucket } from "../src/lowering/render-bucket.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { composePinnedStandardVariant } from "../src/pinned-standard-variants.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";
import { demotableUniformBlocks } from "../src/shader-bindings.js";

const imports = `import { addToScene, createEngine, createPbrMaterial, createPlane, createSceneContext, createStandardMaterial, createTexture2DFromPixels, getMeshOpacity, registerScene, setAlphaToCoverage, setMeshOpacity, setPbrAlphaCutoff, startEngine } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas, { msaaSamples: 4 });
const scene = createSceneContext(engine);
`;

test("scene code reaches the lowered opacity setter and getter", () => {
    const result = compileSource(`${imports}
const mesh = createPlane(engine, { width: 1, height: 1 });
mesh.material = createStandardMaterial();
setMeshOpacity(mesh, 0.5);
addToScene(scene, mesh);
await registerScene(scene);
await startEngine(engine);
console.log(getMeshOpacity(mesh));
`);
    assert.ok(result.manifest.features.includes("mesh:opacity"));
    assert.match(result.cpp, /bbl::set_mesh_opacity\([^;]*, 0\.5\)/);
    assert.match(result.cpp, /bbl::get_mesh_opacity\(/);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/mesh_opacity.cpp",
        ),
    );
});

test("a target other than a Mesh refuses with the pin's MeshLoD wording", () => {
    assert.throws(
        () =>
            compileSource(`${imports}
setMeshOpacity(createStandardMaterial() as never, 0.5);
`),
        /setMeshOpacity: the target is not a Lite Mesh \(for example a MeshLoD instance\)/,
    );
});

test("the setter lowers the pin's guard, clamp, validation, flag and crossing", () => {
    const { source, header } = lowerMeshOpacity(new LoweringContext());
    // `typeof opacity !== "number"` cannot hold for a native double.
    assert.match(
        source,
        /if \(!std::isfinite\(opacity\)\) \{\n\s+throw bbl::js::NamedError\("RangeError", std::string\("setMeshOpacity: opacity must be a finite number, got "\) \+ bbl::js::number_to_string\(opacity\)\);/,
    );
    assert.match(source, /if \(record\.retired\) \{/);
    assert.match(
        source,
        /const double value = bbl::js::math_extreme<false>\(\{1\.0, bbl::js::math_extreme<true>\(\{0\.0, opacity\}\)\}\);/,
    );
    assert.match(
        source,
        /validate_mesh_opacity_material\(engine, mesh, record\.material, value\);/,
    );
    assert.match(source, /record\.skip_color_draw = \(value == 0\.0\);/);
    assert.match(
        source,
        /if \(\(previous == 1\.0\) != \(value == 1\.0\)\) \{\n\s+mark_mesh_renderable_dirty\(engine, mesh\);\n\s+rebuild_mesh_render_plans\(engine, mesh\);/,
    );
    // The validator reads the family `material_family_name` decodes.
    assert.match(
        source,
        /\(\(family != std::string\("standard"\)\) && \(family != std::string\("pbr"\)\)\)/,
    );
    // The encoder, the Standard mesh-phase bits and the PBR word.
    const bit = meshOpacityFeatureBit();
    assert.equal(bit, 1 << 22);
    assert.match(
        header,
        /pinned_mesh_feature_extra\(const MeshRecord& mesh\) \{\n\s+return bbl::js::to_uint32\(\(mesh\.opacity < 1\.0 \? bbl::js::shift_left\(1\.0, 22\.0\) : 0\.0\)\);/,
    );
    assert.match(
        header,
        /inline std::uint32_t standard_mesh_opacity_features\(/,
    );
    assert.match(header, /inline std::uint32_t pbr_renderable_features\(/);
    assert.match(
        header,
        /inline double pbr_mesh_opacity_policy\(std::uint32_t material_features\) \{\n\s+return !\(bbl::js::number_truthy/,
    );
    assert.match(header, /float value = 1\.0f;\n\s+float policy = 0\.0f;/);
});

test("the material setter and registration run the opacity validator once reached", () => {
    const context = new LoweringContext();
    const reached = lowerMeshMaterialSetter(context, true);
    assert.match(
        reached,
        /void set_mesh_material\([^]*validate_mesh_opacity_material\(engine, mesh, material, get_mesh_opacity\(engine, mesh\)\);/,
    );
    assert.match(
        reached,
        /void register_mesh_material_scene\([^]*validate_mesh_opacity_material\(engine, mesh, bbl::handle_at\(engine\.meshes, mesh\)\.material, get_mesh_opacity\(engine, mesh\)\);/,
    );
    assert.doesNotMatch(
        lowerMeshMaterialSetter(context),
        /validate_mesh_opacity_material/,
    );
});

test("the transparent refresh and the buckets read opacity only where it is reached", () => {
    const context = new LoweringContext();
    assert.equal(
        transparentDrawSkipCpp(context, "record"),
        "!mesh_draws(record) || record.skip_color_draw",
    );
    const reached = lowerRenderBucket(context, { meshOpacity: true });
    assert.match(
        reached,
        /const std::uint32_t mesh_extra = item\.mesh_feature_extra;/,
    );
    assert.match(reached, /standard_mesh_opacity_features\(/);
    assert.match(
        reached,
        /pbr_renderable_features\(features, features2, mesh_extra\)/,
    );
    assert.doesNotMatch(lowerRenderBucket(context, {}), /mesh_extra|opacity/);
});

test("the extensions compose for the opacity bit alone, never in a caster view", async () => {
    await registerPinnedMeshOpacity();
    const bit = meshOpacityFeatureBit();
    const flags = await importPinnedModule<{
        NO_COLOR_OUTPUT: number;
        MATERIAL_ALPHA_BLEND: number;
    }>("material/standard/standard-flags.js");
    const plain = await composePinnedStandardVariant({});
    assert.doesNotMatch(plain.fragmentWgsl, /meshOpacity/);
    const faded = await composePinnedStandardVariant({}, { meshFeatures: bit });
    assert.match(faded.fragmentWgsl, /color\.a\*meshOpacity\.value/);
    assert.notEqual(faded.features & flags.MATERIAL_ALPHA_BLEND, 0);
    const caster = await composePinnedStandardVariant(
        {},
        { meshFeatures: bit, passFeatures: flags.NO_COLOR_OUTPUT },
    );
    assert.doesNotMatch(caster.fragmentWgsl, /meshOpacity/);
    // PBR without an alpha policy of its own takes the BLEND arm the
    // renderable's word selects, and the opacity after the alpha fold.
    const pbr = await composePinnedPbrVariant(
        { alpha: 1 },
        { meshFeatures: bit, lightMode: 0 },
    );
    assert.match(
        pbr.fragmentWgsl,
        /if\(meshOpacity\.policy>0\.5\)\{alpha=1\.0;\}/,
    );
    assert.match(
        pbr.fragmentWgsl,
        /finalAlpha=finalAlpha\*meshOpacity\.value;/,
    );
    const blend = (
        await importPinnedModule<{ PBR_HAS_ALPHA_BLEND: number }>(
            "material/pbr/pbr-flags.js",
        )
    ).PBR_HAS_ALPHA_BLEND;
    const features = await pinnedPbrRenderableFeatures();
    assert.equal(features(0, 0, bit) & blend, blend);
    assert.equal(features(0, 0, 0), 0);
    const noColor = (
        await importPinnedModule<{ PBR2_NO_COLOR_OUTPUT: number }>(
            "material/pbr/pbr-flags.js",
        )
    ).PBR2_NO_COLOR_OUTPUT;
    assert.equal(features(0, noColor, bit), 0);
    // SDL_GPU demotes the block past the four uniform slots.
    assert.deepEqual(
        demotableUniformBlocks(
            "var<uniform> meshOpacity: meshOpacityUniforms;",
        ),
        ["meshOpacity"],
    );
});

test("PBR alpha cutoff, a pixels base colour and Standard coverage compile", () => {
    const result = compileSource(`${imports}
const mask = createTexture2DFromPixels(engine, new Uint8Array(4 * 4), 2, 2);
const color = [0.1, 0.2, 0.3] as const;
const pbr = createPbrMaterial({ baseColorFactor: [...color, 1], baseColorTexture: mask, alphaBlend: false });
setPbrAlphaCutoff(pbr, 0.5);
const standard = createStandardMaterial();
setAlphaToCoverage(standard, true);
const plane = createPlane(engine, { width: 1, height: 1 });
plane.material = pbr;
addToScene(scene, plane);
await registerScene(scene);
await startEngine(engine);
`);
    assert.ok(result.manifest.features.includes("material:pbr-alpha-cutoff"));
    assert.ok(
        result.manifest.features.includes("material:pbr-base-color-pixels"),
    );
    assert.equal(result.manifest.scenePbrMaterials[0]?.alphaCutOff, 0.5);
    // The spread's lanes reach both the factor and its retained array.
    assert.equal(
        result.manifest.scenePbrMaterials[0]?.baseColorFactorRuntime,
        true,
    );
    assert.match(
        result.cpp,
        /\.base_color_factor = bbl::Color4\{static_cast<float>\(v_bblite_spread_lane_0\)/,
    );
    assert.match(result.cpp, /bbl::set_pbr_alpha_cutoff\([^;]*, 0\.5\)/);
    assert.match(result.cpp, /bbl::set_material_base_color_pixels\(/);
    assert.match(result.cpp, /\.alpha_to_coverage = true/);
    assert.throws(
        () =>
            compileSource(`${imports}
const pbr = createPbrMaterial({ alphaBlend: true });
setPbrAlphaCutoff(pbr, 0.5);
`),
        /setPbrAlphaCutoff on an alphaBlend material is not supported/,
    );
});

test("explicit render-task entries resolve the binding their task records", () => {
    const result = compileSource(`${imports}
import { addMeshToTask, createRenderTask, createRenderTargetTexture, enableRenderTaskMeshRefresh } from "@babylonjs/lite";
const mesh = createPlane(engine, { width: 1, height: 1 });
mesh.material = createStandardMaterial();
setMeshOpacity(mesh, 0.5);
const { rt } = createRenderTargetTexture(engine, { lbl: "rt", format: engine.format, dFormat: "depth24plus-stencil8", samples: 1, size: { width: 64, height: 64 } });
const task = createRenderTask({ name: "task", rt, autoMirror: false }, engine, scene);
enableRenderTaskMeshRefresh(task);
addMeshToTask(task, mesh);
`);
    assert.ok(result.manifest.features.includes("mesh:opacity"));
    assert.match(result.cpp, /bbl::add_render_task_mesh\(/);
    // An entry that follows its mesh reads the bits live; any other keeps
    // the ones its task resolved.
    assert.match(
        lowerMeshOpacity(new LoweringContext()).source,
        /void resolve_render_task_mesh_extras\(const Engine& engine, const FrameTaskRecord& task\) \{\n\s+for \(const RenderTaskMesh& entry : task\.render_meshes\) \{\n\s+if \(entry\.follows_material \|\| entry\.mesh_feature_extra\) continue;/,
    );
});
