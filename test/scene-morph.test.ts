import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { emitAssetSpecializations } from "../src/asset-specializer.js";
import { compileSource } from "../src/compiler.js";
import { composeScenePipeline } from "../src/compose-pipeline.js";
import { GeneratedTree } from "../src/generated-tree.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { pinnedSceneMeshFeatures } from "../src/pinned-mesh-features.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const prefix = `
    import { createEngine, createSceneContext, createMeshFromData, createBox,
        createPbrMaterial, createMorphTargets, createSkeleton, setMorphTargetWeights,
        onBeforeRender, addToScene, registerScene, startEngine } from "@babylonjs/lite";
    const engine = await createEngine({});
    const scene = createSceneContext(engine);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    const mesh = createMeshFromData(engine, "morph", positions, normals, indices);
    mesh.material = createPbrMaterial({});
    const morph = createMorphTargets(engine, [{ positions, normals: null }], 3, [0.75]);
`;
const attach = "mesh.morphTargets = morph;";

test("scene morph attachment records its exact PBR row and keeps weight updates live", async () => {
    const result = compileSource(`${prefix}${attach}
        const plain = createBox(engine, 1);
        plain.material = mesh.material;
        addToScene(scene, mesh); addToScene(scene, plain);
        onBeforeRender(scene, () => { setMorphTargetWeights(engine, morph, new Float32Array([Math.random()])); });
        await registerScene(scene);
    `);
    assert.equal(result.manifest.sceneMeshes[0]?.morphTargets, true);
    assert.equal(result.manifest.sceneMeshes[1]?.morphTargets, undefined);
    assert.match(result.cpp.slice(result.cpp.indexOf("bbl::on_before_render")), /bbl::set_morph_target_weights/);
    const outputPath = resolve("artifacts/scene-morph-composition");
    const composed = await composeScenePipeline({
        result, outputPath, tree: new GeneratedTree(outputPath),
        specializationFeatures: emitAssetSpecializations(outputPath, []),
        emittedArms: { clearcoat: false, clearcoatF0Remap: false, sheen: false,
            sheenAlbedoScaling: false, iridescence: false, occlusionUv2: false,
            transmission: false, dispersion: false },
    });
    const pin = await importPinnedModule<{ MSH_HAS_MORPH_TARGETS: number }>("material/mesh-features.js");
    assert.deepEqual(composed.renderableMeshFeatures, [pin.MSH_HAS_MORPH_TARGETS, 0]);
    const morphVariants = composed.pinnedVariants.filter(variant => variant.fragmentKey.split("|").includes("morph"));
    assert.ok(morphVariants.length > 0, "the actual pipeline must compose the morph stage");
    for (const variant of morphVariants) {
        const source = variant.vertexWgsl;
        assert.match(source, /var<storage,\s*read>\s+morphDeltas/);
        assert.match(source, /var<storage,\s*read>\s+morph\s*:/);
    }
});

test("procedural and data meshes carry independent pinned skeleton and morph bits", async () => {
    const pin = await importPinnedModule<{ MSH_HAS_SKELETON: number; MSH_HAS_MORPH_TARGETS: number }>("material/mesh-features.js");
    for (const kind of ["from-data", "box", "sphere"]) {
        assert.equal(await pinnedSceneMeshFeatures({ kind, gltfAssetsBefore: 0 }), 0);
        assert.equal(await pinnedSceneMeshFeatures({ kind, gltfAssetsBefore: 0, skinned: true }), pin.MSH_HAS_SKELETON);
        assert.equal(await pinnedSceneMeshFeatures({ kind, gltfAssetsBefore: 0, morphTargets: true }), pin.MSH_HAS_MORPH_TARGETS);
        assert.equal(await pinnedSceneMeshFeatures({ kind, gltfAssetsBefore: 0, skinned: true, morphTargets: true }), pin.MSH_HAS_SKELETON | pin.MSH_HAS_MORPH_TARGETS);
    }
    await assert.rejects(pinnedSceneMeshFeatures({ kind: "box", gltfAssetsBefore: 0,
        morphTargets: true, thinInstances: "possible" }), /native-coordinate instance stream/);
});

test("deformation attachment refuses uncertain or already-running composition", () => {
    for (const statement of [
        `if (Math.random() > 0.5) { ${attach} }`,
        `onBeforeRender(scene, () => { ${attach} });`,
        `await startEngine(engine); ${attach}`,
    ]) assert.throws(() => compileSource(prefix + statement), /attachment must be definite and precede startEngine/);
    assert.throws(() => compileSource(`${prefix}
        const joints = new Uint16Array(12); const weights = new Float32Array(12);
        const skeleton = createSkeleton(engine, joints, weights, 1, new Float32Array(16));
        if (Math.random() > 0.5) { mesh.skeleton = skeleton; }
    `), /attachment must be definite and precede startEngine/);
});

/** Compile the production helper bodies, with no copied transport equations. */
function cppDefinition(source: string, signature: string, terminator = "\n}\n"): string {
    const normalized = source.replaceAll("\r\n", "\n");
    const start = normalized.indexOf(signature);
    assert.ok(start >= 0, signature);
    const end = normalized.indexOf(terminator, start);
    assert.ok(end > start, signature);
    return normalized.slice(start, end + terminator.length);
}

interface PinBuffer { data: ArrayBuffer; getMappedRange(): ArrayBuffer; unmap(): void }
interface PinMorph { deltasBuffer: PinBuffer; weightsBuffer: PinBuffer; count: number; weights: Float32Array }

const tools = optionalNativeFixtureTools(false);
test("native direct morph storage matches pin bytes and keeps deformation before live world", { skip: !tools }, async () => {
    const pin = await importPinnedModule<{
        createMorphTargets(engine: unknown, targets: { positions: Float32Array; normals: Float32Array | null }[], count: number, weights: number[]): PinMorph;
        setMorphTargetWeights(engine: unknown, morph: PinMorph, weights: number[]): void;
    }>("morph/create-morph-targets.js");
    const engine = { _device: {
        createBuffer({ size }: { size: number }): PinBuffer {
            const data = new ArrayBuffer(size);
            return { data, getMappedRange: () => data, unmap() {} };
        },
        queue: { writeBuffer(buffer: PinBuffer, offset: number, values: Float32Array) {
            new Uint8Array(buffer.data, offset, values.byteLength).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
        } },
    } };
    const checks: string[] = [];
    const positionDeltas = new Float32Array([1.35, -0, 2.3, -4.1, 0.125, -1e-20]);
    const normalDeltas = new Float32Array([-0, 0.3, -0.2, 0.7, -0.8, 0.9]);
    const cppFloats = (values: Float32Array): string => [...new Uint32Array(values.buffer)]
        .map(bits => `std::bit_cast<float>(${bits}u)`).join(", ");
    for (const normal of [null, normalDeltas]) {
        const morph = pin.createMorphTargets(engine, [{ positions: positionDeltas, normals: normal }], 2, [0.75]);
        checks.push(`{
            bbl::attach_morph_target(engine, mesh, {${cppFloats(positionDeltas)}}, {${normal ? cppFloats(normal) : ""}}, 2.0, 0.75f);
            assert(engine.meshes[0].scene_morph_targets);
            same(bbl::pal::pack_morph_deltas(engine.geometries[0]), {${[...new Uint32Array(morph.deltasBuffer.data)].map(bits => `${bits}u`).join(", ")}});
            assert((bbl::pal::pack_morph_weights(engine.geometries[0], engine.meshes[0]) == std::vector<std::uint8_t>{${[...new Uint8Array(morph.weightsBuffer.data)].join(", ")}}));
        `);
        for (const weights of [[-0.35], [], [0.5, 0.75]]) {
            pin.setMorphTargetWeights(engine, morph, weights);
            checks.push(`bbl::set_morph_target_weights(engine, mesh, {${cppFloats(Float32Array.from(weights))}});
                assert((bbl::pal::pack_morph_weights(engine.geometries[0], engine.meshes[0]) == std::vector<std::uint8_t>{${[...new Uint8Array(morph.weightsBuffer.data)].join(", ")}}));`);
        }
        checks.push("}");
    }
    const context = new LoweringContext();
    const factories = new FactoryLowerer(context).lowerMeshFactories([]).source;
    const renderPlan = new RendererLowerer(context).lowerRenderPlan({}).source;
    const pal = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    const output = resolve("artifacts/scene-morph-native-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "pinned_matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(join(output, "pinned_world_transform.hpp"), pinnedWorldTransformHeader(context));
    const source = join(output, "check.cpp");
    writeFileSync(source, `#define BBLITE_GPU_DEFORMATION 1
#define BBLITE_HAS_PBR_RENDERER 1
#define BBLITE_GPU_INSTANCING 0
#define BBLITE_FLOATING_ORIGIN 0
#define BBLITE_PBR_VARIANTS 1
#include <bblite/runtime.hpp>
#include "pinned_matrix.hpp"
#include "pinned_world_transform.hpp"
#include <bit>
#include <cassert>
#include <cstring>
namespace bbl::upstream {
${["mesh_local_matrix(const MeshRecord&", "transform_node_local_matrix(", "transform_node_world(", "mesh_world_matrix("].map(name =>
    cppDefinition(renderPlan, `std::array<float, 16> ${name}`)).join("\n")}
}
namespace bbl {
${cppDefinition(factories, "void attach_morph_target(")}
${cppDefinition(factories, "void set_morph_target_weights(")}
}
namespace bbl::pal {
${cppDefinition(pal, "struct GpuVertex {", "\n};\n")}
${cppDefinition(pal, "struct PinnedDrawConventions {", "\n};\n")}
// Stand-ins for generated variant metadata; execute the shared selection body.
bool pinned_variant_skeleton(std::size_t variant) { return variant == 1; }
bool pinned_variant_vat(std::size_t) { return false; }
${cppDefinition(pal, "inline PinnedDrawConventions pinned_draw_conventions(")}
${["std::array<float, 16> outer_draw_world(", "std::array<float, 16> draw_world(",
    "std::array<float, 16> scene_deformation_draw_world(", "std::vector<GpuVertex> transformed_vertices(",
    "std::array<float, 16> pinned_mesh_world(", "std::array<float, 16> pinned_identity_world(",
    "std::array<float, 16> pinned_x_mirrored_world(", "std::array<float, 16> pinned_draw_world(",
    "std::array<float, 16> standard_draw_world(", "std::vector<float> pack_morph_deltas(",
    "std::vector<float> morph_weight_values(", "std::vector<std::uint8_t> pack_morph_weights("].map(name =>
        cppDefinition(pal, `inline ${name}`)).join("\n")}
}
void same(const std::vector<float>& actual, const std::vector<std::uint32_t>& expected) {
    assert(actual.size() == expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) assert(std::bit_cast<std::uint32_t>(actual[i]) == expected[i]);
}
int main() {
    bbl::Engine engine; engine.meshes.emplace_back(); engine.geometries.emplace_back();
    const bbl::MeshHandle mesh{0}; engine.meshes[0].geometry = 0;
    engine.geometries[0].vertices.resize(2);
${checks.join("\n")}
    auto& record = engine.meshes[0];
    record.position = {-1.65f, 0.42f, 0.0f}; record.scaling = {2.0f, 3.0f, 4.0f};
    record.rotation = {0.2f, -0.3f, 0.4f};
    record.gpu_world_transform = true;
    auto& vertex = engine.geometries[0].vertices[0];
    vertex.position = {-0.55f, 0.46f, 0.125f}; vertex.normal = {0.0f, 0.0f, 1.0f};
    bbl::Scene scene;
    for (const bool skinned : {false, true}) {
        record.scene_skeleton = skinned;
        const auto conventions = bbl::pal::pinned_draw_conventions(skinned ? 1u : 0u, record);
        assert(conventions.mirrored_vertices && conventions.skeleton_draw == skinned);
        const auto packed = bbl::pal::transformed_vertices(engine, engine.geometries[0], record);
        assert(packed[0].position[0] == vertex.position.x && packed[0].position[1] == vertex.position.y && packed[0].position[2] == vertex.position.z);
        const auto expected = bbl::upstream::mesh_world_matrix(engine, record);
        assert(bbl::pal::pinned_draw_world(skinned, false, false, record, scene, engine) == expected);
        assert(bbl::pal::standard_draw_world(record, false, scene, engine) == expected);
        record.position.x += 0.25f;
    }
    record.scene_skeleton = false; record.scene_morph_targets = false; record.gpu_world_transform = false;
    const auto plain = bbl::pal::transformed_vertices(engine, engine.geometries[0], record);
    assert(!bbl::pal::pinned_draw_conventions(0, record).mirrored_vertices);
    assert(plain[0].position[0] != vertex.position.x);
    assert(bbl::pal::pinned_draw_world(false, false, false, record, scene, engine) == bbl::pal::pinned_mesh_world());
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", output, source]);
    execFileSync(executable);
});
