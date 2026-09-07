import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { mirroredStructFromWgsl } from "../src/pinned-pbr-variant-cpp.js";
import { importPinnedModule, importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
const floats = (values: ArrayLike<number>): string => [...new Uint32Array(Float32Array.from(values).buffer)]
    .map(word => `std::bit_cast<float>(${word}u)`).join(", ");

interface PinMesh { parent: PinMesh | null; worldMatrix: Float32Array }

test("node geometry binds raw lanes and the pin world independently of ordinary draw caches", { skip: !tools }, async () => {
    const parser = await importPinnedModule<{
        computeNodeWorldMatrix(json: object, index: number, parents: Map<number, number>, cache: Map<number, Float32Array>): Float32Array;
    }>("loader-gltf/gltf-parser.js");
    const matrix = await importPinnedModule<{
        mat4ComposeInto(out: Float32Array, offset: number, ...values: number[]): void;
    }>("math/mat4-compose-into.js");
    const meshModule = await importPinnedModule<{
        initMeshTransform(partial: object, ...trs: number[]): PinMesh;
    }>("mesh/mesh.js");
    const nodePipeline = await importPinnedModuleWithExports<{ buildMeshStruct(): string }>(
        "material/node/node-pipeline.js", ["buildMeshStruct"]);
    const meshBody = /struct MeshU\{([^}]*)\}/.exec(nodePipeline.buildMeshStruct())?.[1];
    assert.ok(meshBody);
    const { MAX_LIGHTS } = await importPinnedModule<{ MAX_LIGHTS: number }>("light/types.js");
    const checks: string[] = [];
    // Use the pin's actual parent walk, with nonuniform and negative scales.
    // The native loader's matrix_product/native_matrix adapter is executed below.
    for (const sign of [1, -1]) {
        const parent = new Float32Array(16), child = new Float32Array(16);
        matrix.mat4ComposeInto(parent, 0, 3.2, -4.3, 2.1, 0.1, -0.2, 0.3, 0.9273618495495703, sign * 2.0, 0.5, 1.7);
        matrix.mat4ComposeInto(child, 0, -1.1, 2.3, 0.7, -0.15, 0.25, 0.05, 0.95524865872714, 0.6, 1.2, 2.4);
        const expected = parser.computeNodeWorldMatrix({ nodes: [
            { matrix: [...parent], children: [1] }, { matrix: [...child] },
        ] }, 1, new Map([[1, 0]]), new Map());
        checks.push(`{
            const Matrix parent{${floats(parent)}}, child{${floats(child)}};
            record.instance_parent_matrix = native_matrix(upstream::matrix_product(parent, child));
            const auto block = node_mesh_block(scene, engine, 0, true);
            same_matrix(block.world, Matrix{${floats(expected)}});
            assert(node_mesh_block(scene, engine, 0).world == pinned_identity_world());
            NodeMeshBlockCache cache;
            const auto ordinary = node_mesh_block_for(cache, scene, engine, 0, false).world;
            same_matrix(node_mesh_block_for(cache, scene, engine, 0, true).world, block.world);
            assert(node_mesh_block_for(cache, scene, engine, 0, false).world == ordinary);
            Scene next_scene;
            record.instance_parent_matrix[12] += 3.0f;
            const auto changed = node_mesh_block(scene, engine, 0, true).world;
            assert(changed != block.world);
            same_matrix(node_mesh_block_for(cache, next_scene, engine, 0, true).world, changed);
            assert(node_mesh_block_for(cache, next_scene, engine, 0, false).world == ordinary);
        }`);
    }
    const parentTrs = [1.2, -2.3, 0.4, 0.15, -0.25, 0.35, 2, 0.5, 1.7].map(Math.fround);
    const childTrs = [-1.1, 0.3, 2.4, -0.2, 0.4, -0.1, 0.8, 1.3, 1.1].map(Math.fround);
    const parentMesh = meshModule.initMeshTransform({}, ...parentTrs);
    const childMesh = meshModule.initMeshTransform({}, ...childTrs);
    childMesh.parent = parentMesh;
    const localExpected = childMesh.worldMatrix;
    const geometryModule = await importPinnedModule<{
        buildNodeGeometryRenderable(scene: object, mesh: object, view: object): {
            bind(engine: object, signature: object): { update(): void; draw(pass: object): number };
        };
    }>("material/node/node-geometry-renderable.js");
    const uploaded = new Map<object, Uint8Array>();
    const gpu = { positionBuffer: {}, normalBuffer: {}, uvBuffer: {}, indexBuffer: {}, indexFormat: "uint32", indexCount: 3 };
    Object.assign(childMesh, { _gpu: gpu });
    const recordingEngine = { _device: {
        createBuffer: () => ({}), createBindGroup: () => ({}),
        queue: { writeBuffer(buffer: object, _offset: number, values: Float32Array) {
            uploaded.set(buffer, new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice());
        } },
    } };
    const source = { _textureSlots: new Map() };
    const vertexBindings: object[] = [];
    // Execute the actual renderable adapter around an already composed view.
    // It must bind original buffers and upload the actual source mesh world.
    const renderable = geometryModule.buildNodeGeometryRenderable({
        surface: { engine: recordingEngine }, lights: [], _meshAuxDisposables: new Map(),
    }, childMesh, { source, _geometry: {
        _attrNames: ["position", "normal", "uv"], _nodeUBOReady: true, _nodeUBO: null,
        _compileBySig: { get: () => ({ _nodeUboBinding: null, _nodeUboSize: 0,
            _textureBindings: [], _geometryGpBinding: null, _usesMeshAttributeFlags: false }) },
    } });
    const bound = renderable.bind(recordingEngine, {});
    bound.update();
    assert.equal(bound.draw({
        setVertexBuffer: (_index: number, buffer: object) => vertexBindings.push(buffer),
        setIndexBuffer: (buffer: object) => assert.equal(buffer, gpu.indexBuffer),
        setBindGroup() {}, drawIndexed: (count: number) => assert.equal(count, 3),
    }), 1);
    assert.deepEqual(vertexBindings, [gpu.positionBuffer, gpu.normalBuffer, gpu.uvBuffer]);
    assert.equal(uploaded.size, 1);
    const uploadedWorld = [...uploaded.values()][0]!.subarray(0, 64);
    assert.deepEqual(uploadedWorld, new Uint8Array(localExpected.buffer, localExpected.byteOffset, 64));
    const setTrs = (name: string, values: number[]): string =>
        `${name}.position = {${floats(values.slice(0, 3))}}; ${name}.rotation = {${floats(values.slice(3, 6))}}; ${name}.scaling = {${floats(values.slice(6))}};`;
    const context = new LoweringContext();
    const render = new RendererLowerer(context).lowerRenderPlan({}).source;
    const loader = new GltfLowerer(context).lowerLoaderAdapter({ retainLocalNormals: true }).source;
    const pal = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    const output = resolve("artifacts/node-geometry-transport-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "pinned_matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(join(output, "pinned_world_transform.hpp"), pinnedWorldTransformHeader(context));
    const fixture = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(fixture, `#define BBLITE_HAS_PBR_RENDERER 1
#define BBLITE_GPU_DEFORMATION 0
#define BBLITE_GPU_INSTANCING 0
#define BBLITE_FLOATING_ORIGIN 0
#define BBLITE_PBR_VARIANTS 0
#include <bblite/runtime.hpp>
#include "pinned_matrix.hpp"
#include "pinned_world_transform.hpp"
#include <bit>
#include <cassert>
#include <cstring>
#include <iostream>
namespace bbl::upstream {
${mirroredStructFromWgsl("NodeMeshUniforms", meshBody, "pin node-pipeline buildMeshStruct")}
inline constexpr std::size_t pinned_max_lights = ${MAX_LIGHTS}u;
${cppFunction(render, "bool light_affects_mesh(")}
${["mesh_local_matrix(const MeshRecord&", "transform_node_local_matrix(", "transform_node_world(", "mesh_world_matrix("]
    .map(name => cppFunction(render, `std::array<float, 16> ${name}`)).join("\n")}
}
namespace bbl::pal {
${["struct GpuVertex", "enum class VertexInputStream", "enum class VertexInputLane", "struct PinnedVertexInput"]
    .map(name => cppFunction(pal, name) + ";").join("\n")}
${["std::array<float, 16> outer_draw_world(", "std::array<float, 16> draw_world(",
    "std::array<float, 16> scene_deformation_draw_world(", "std::vector<GpuVertex> transformed_vertices(",
    "std::array<float, 16> pinned_identity_world(", "std::array<float, 16> pinned_x_mirrored_world(",
    "PinnedVertexInput pinned_vertex_input("].map(name => cppFunction(pal, `inline ${name}`)).join("\n")}
template <typename Block>
${cppFunction(pal, "inline void pinned_mesh_light_selection(")}
${cppFunction(pal, "inline upstream::NodeMeshUniforms node_mesh_block(")}
${cppFunction(pal, "inline std::span<const std::uint32_t> node_source_indices(")}
${cppFunction(dawn, "struct NodeMeshBlockCache")} ;
${cppFunction(dawn, "const upstream::NodeMeshUniforms& node_mesh_block_for(")}
}
using namespace bbl;
using namespace bbl::pal;
using Matrix = std::array<float, 16>;
${cppFunction(loader, "Matrix native_matrix(")}
void same_matrix(const Matrix& actual, const Matrix& expected) {
    // Exact f32 values; zero sign can differ across the root convention bridge.
    for (std::size_t i = 0; i < 16; ++i) assert(actual[i] == expected[i]);
}
int main() {
    Engine engine; Scene scene;
    engine.meshes.resize(2); engine.geometries.emplace_back();
    auto& record = engine.meshes[0]; record.geometry = 0;
    auto& geometry = engine.geometries[0]; geometry.vertex_space = VertexSpace::world;
    geometry.vertices.resize(1); geometry.local_normals = {{-0.0f, 0.3f, 2.75f}};
    auto& vertex = geometry.vertices[0];
    vertex.local_position = {-1.25f, 2.75f, 0.6f};
    vertex.position = {11.0f, 12.0f, 13.0f}; vertex.normal = {0.5f, 0.7f, 0.2f};
    const auto packed = transformed_vertices(engine, geometry, record);
    for (const auto name : {"position", "normal"}) {
        const auto input = pinned_vertex_input(name, true, true);
        const void* expected = std::string_view(name) == "position"
            ? static_cast<const void*>(&vertex.local_position) : &geometry.local_normals[0];
        assert(input.mapped && input.stream == VertexInputStream::vertex);
        assert(std::memcmp(reinterpret_cast<const std::uint8_t*>(&packed[0]) + input.offset, expected, 12) == 0);
    }
    assert(pinned_vertex_input("position", false).offset == offsetof(GpuVertex, position));
    assert(pinned_vertex_input("normal", true).offset == offsetof(GpuVertex, normal));
    for (const double determinant : {1.0, -1.0}) for (const bool clockwise_front_face : {false, true}) {
        const std::vector<std::uint32_t> original{0, 1, 2, 0, 2, 3};
        geometry.indices = original; geometry.source_indices_reversed = false;
        ${cppFunction(loader, "if (\n                geometry.topology == MeshTopology::triangles &&\n                determinant < 0.0")}
        const auto adapted = geometry.indices;
        assert(geometry.source_indices_reversed == (determinant < 0 && !clockwise_front_face));
        std::vector<std::uint32_t> scratch;
        const auto source = node_source_indices(geometry, scratch);
        assert(std::equal(source.begin(), source.end(), original.begin(), original.end()));
        assert(geometry.indices == adapted);
        assert(geometry.source_indices_reversed || (source.data() == geometry.indices.data() && scratch.empty()));
    }
    ${checks.join("\n")}
    const auto rejects = [&] {
        try { (void)node_mesh_block(scene, engine, 0, true); } catch (const std::runtime_error&) { return true; }
        return false;
    };
    geometry.local_normals.clear(); assert(rejects());
    geometry.local_normals.resize(1); record.position.x = 0.1; assert(rejects()); record.position.x = 0;
    record.live_imported_transform = true; assert(rejects()); record.live_imported_transform = false;
    geometry.vertex_space = VertexSpace::mirrored_local; assert(rejects());
    geometry.vertex_space = VertexSpace::local; geometry.local_normals.clear();
    record.parent = MeshHandle{1};
    ${setTrs("engine.meshes[1]", parentTrs)}
    ${setTrs("record", childTrs)}
    for (bool gpu_world : {false, true}) {
        record.gpu_world_transform = gpu_world;
        same_matrix(node_mesh_block(scene, engine, 0, true).world, Matrix{${floats(localExpected)}});
        record.scene_morph_targets = true;
        same_matrix(node_mesh_block(scene, engine, 0).world, Matrix{${floats(localExpected)}});
        record.scene_morph_targets = false;
        const auto local_packed = transformed_vertices(engine, geometry, record);
        assert(std::memcmp(local_packed[0].local_normal, &vertex.normal, 12) == 0);
    }
    std::cout << "node geometry transport: ok\\n";
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${output}\\`, `/Fe:${executable}`, fixture]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /node geometry transport: ok/);
});
