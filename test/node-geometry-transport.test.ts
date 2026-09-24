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
import { reflectWgslStruct } from "../src/shader-ir.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
const floats = (values: ArrayLike<number>): string =>
    [...new Uint32Array(Float32Array.from(values).buffer)]
        .map((word) => `std::bit_cast<float>(${word}u)`)
        .join(", ");

interface PinMesh {
    parent: PinMesh | null;
    worldMatrix: Float32Array;
}

test(
    "node geometry binds raw lanes and the pin world through the one mesh block",
    { skip: !tools },
    async () => {
        const parser = await importPinnedModule<{
            computeNodeWorldMatrix(
                this: void,
                json: object,
                index: number,
                parents: Map<number, number>,
                cache: Map<number, Float32Array>,
            ): Float32Array;
        }>("loader-gltf/gltf-parser.js");
        const matrix = await importPinnedModule<{
            composeMat4IntoBuffer(
                this: void,
                out: Float32Array,
                offset: number,
                ...values: number[]
            ): void;
        }>("math/compose-mat4-into-buffer.js");
        const meshModule = await importPinnedModule<{
            initMeshTransform(
                this: void,
                partial: object,
                ...trs: number[]
            ): PinMesh;
        }>("mesh/mesh.js");
        const nodePipeline = await importPinnedModuleWithExports<{
            buildMeshStruct(this: void): string;
        }>("material/node/node-pipeline.js", ["buildMeshStruct"]);
        const meshBody = reflectWgslStruct(
            nodePipeline.buildMeshStruct(),
            "MeshU",
        )?.members;
        assert.ok(meshBody);
        const { MAX_LIGHTS } = await importPinnedModule<{ MAX_LIGHTS: number }>(
            "light/types.js",
        );
        const checks: string[] = [];
        // A loaded record carries the pin's node world as its parent world
        // under an identity TRS; the block's world is that matrix, exactly.
        for (const sign of [1, -1]) {
            const parent = new Float32Array(16),
                child = new Float32Array(16);
            matrix.composeMat4IntoBuffer(
                parent,
                0,
                3.2,
                -4.3,
                2.1,
                0.1,
                -0.2,
                0.3,
                0.9273618495495703,
                sign * 2.0,
                0.5,
                1.7,
            );
            matrix.composeMat4IntoBuffer(
                child,
                0,
                -1.1,
                2.3,
                0.7,
                -0.15,
                0.25,
                0.05,
                0.95524865872714,
                0.6,
                1.2,
                2.4,
            );
            const expected = parser.computeNodeWorldMatrix(
                {
                    nodes: [
                        { matrix: [...parent], children: [1] },
                        { matrix: [...child] },
                    ],
                },
                1,
                new Map([[1, 0]]),
                new Map(),
            );
            checks.push(`{
            record.parent_world = Matrix{${floats(expected)}};
            const auto block = node_mesh_block(scene, engine, MeshHandle{0});
            same_matrix(block.world, Matrix{${floats(expected)}});
            NodeMeshBlockCache cache;
            same_matrix(node_mesh_block_for(cache, scene, engine, MeshHandle{0}).world, block.world);
            Scene next_scene;
            (*record.parent_world)[12] += 3.0f;
            const auto changed = node_mesh_block(scene, engine, MeshHandle{0}).world;
            assert(changed != block.world);
            // The cache is per scene pass: the same scene keeps its block,
            // the next one composes the moved world.
            same_matrix(node_mesh_block_for(cache, scene, engine, MeshHandle{0}).world, block.world);
            same_matrix(node_mesh_block_for(cache, next_scene, engine, MeshHandle{0}).world, changed);
        }`);
        }
        const parentTrs = [1.2, -2.3, 0.4, 0.15, -0.25, 0.35, 2, 0.5, 1.7].map(
            Math.fround,
        );
        const childTrs = [-1.1, 0.3, 2.4, -0.2, 0.4, -0.1, 0.8, 1.3, 1.1].map(
            Math.fround,
        );
        const parentMesh = meshModule.initMeshTransform({}, ...parentTrs);
        const childMesh = meshModule.initMeshTransform({}, ...childTrs);
        childMesh.parent = parentMesh;
        const localExpected = childMesh.worldMatrix;
        const geometryModule = await importPinnedModule<{
            buildNodeGeometryRenderable(
                this: void,
                scene: object,
                mesh: object,
                view: object,
                resources: object,
            ): {
                bind(
                    engine: object,
                    signature: object,
                ): { update(): void; draw(pass: object): number };
            };
        }>("material/node/node-geometry-renderable.js");
        const uploaded = new Map<object, Uint8Array>();
        const gpu = {
            positionBuffer: {},
            normalBuffer: {},
            uvBuffer: {},
            indexBuffer: {},
            indexFormat: "uint32",
            indexCount: 3,
        };
        Object.assign(childMesh, { _gpu: gpu });
        const recordingEngine = {
            _device: {
                createBuffer: () => ({}),
                createBindGroup: () => ({}),
                queue: {
                    writeBuffer(
                        buffer: object,
                        _offset: number,
                        values: Float32Array,
                    ) {
                        uploaded.set(
                            buffer,
                            new Uint8Array(
                                values.buffer,
                                values.byteOffset,
                                values.byteLength,
                            ).slice(),
                        );
                    },
                },
            },
        };
        const source = { _textureSlots: new Map() };
        const vertexBindings: object[] = [];
        // Execute the actual renderable adapter around an already composed view.
        // It must bind original buffers and upload the actual source mesh world.
        const renderable = geometryModule.buildNodeGeometryRenderable(
            {
                surface: { engine: recordingEngine },
                lights: [],
            },
            childMesh,
            {
                source,
                _geometry: {
                    _attrNames: ["position", "normal", "uv"],
                    _nodeUBOReady: true,
                    _nodeUBO: null,
                    _compileBySig: {
                        get: () => ({
                            _nodeUboBinding: null,
                            _nodeUboSize: 0,
                            _textureBindings: [],
                            _geometryGpBinding: null,
                            _usesMeshAttributeFlags: false,
                            _meshUboFloats: 20,
                            _pipelineForMesh: () => ({}),
                        }),
                    },
                },
            },
            { _lifetimeDisposers: [], _owners: 0 },
        );
        const bound = renderable.bind(recordingEngine, {});
        bound.update();
        assert.equal(
            bound.draw({
                setVertexBuffer: (_index: number, buffer: object) =>
                    vertexBindings.push(buffer),
                setIndexBuffer: (buffer: object) =>
                    assert.equal(buffer, gpu.indexBuffer),
                setBindGroup() {},
                drawIndexed: (count: number) => assert.equal(count, 3),
            }),
            1,
        );
        assert.deepEqual(vertexBindings, [
            gpu.positionBuffer,
            gpu.normalBuffer,
            gpu.uvBuffer,
        ]);
        assert.equal(uploaded.size, 1);
        const uploadedWorld = [...uploaded.values()][0]!.subarray(0, 64);
        assert.deepEqual(
            uploadedWorld,
            new Uint8Array(localExpected.buffer, localExpected.byteOffset, 64),
        );
        const setTrs = (name: string, values: number[]): string =>
            `${name}.position = {${floats(values.slice(0, 3))}}; ${name}.rotation = {${floats(values.slice(3, 6))}}; ${name}.scaling = {${floats(values.slice(6))}};`;
        const context = new LoweringContext();
        const render = new RendererLowerer(context).lowerRenderPlan({}).source;
        const loader = new GltfLowerer(context).lowerLoaderAdapter().source;
        const pal = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
        const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
        const output = resolve("artifacts/node-geometry-transport-check");
        mkdirSync(output, { recursive: true });
        writeFileSync(
            join(output, "pinned_matrix.hpp"),
            pinnedMatrixHeader(context),
        );
        writeFileSync(
            join(output, "pinned_world_transform.hpp"),
            pinnedWorldTransformHeader(context),
        );
        const fixture = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            fixture,
            `#define BBLITE_GPU_DEFORMATION 0
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
${[
    "std::array<float, 16> mesh_local_matrix(const MeshRecord&",
    "std::array<float, 16> transform_node_local_matrix(",
    "std::array<float, 16> transform_node_world(",
    "std::optional<std::array<float, 16>> mesh_root_world(",
    "std::array<float, 16> mesh_world_matrix(",
]
    .map((name) => cppFunction(render, name))
    .join("\n")}
}
namespace bbl::pal {
${[
    "struct GpuVertex",
    "enum class VertexInputStream",
    "enum class VertexInputLane",
    "struct PinnedVertexInput",
]
    .map((name) => cppFunction(pal, name) + ";")
    .join("\n")}
${[
    "std::array<float, 16> mesh_block_world(",
    "std::vector<GpuVertex> mesh_gpu_vertices(",
    "PinnedVertexInput pinned_vertex_input(",
]
    .map((name) => cppFunction(pal, `inline ${name}`))
    .join("\n")}
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
void same_matrix(const Matrix& actual, const Matrix& expected) {
    for (std::size_t i = 0; i < 16; ++i) assert(std::bit_cast<std::uint32_t>(actual[i]) == std::bit_cast<std::uint32_t>(expected[i]));
}
int main() {
    Engine engine; Scene scene;
    engine.meshes.resize(2); engine.geometries.emplace_back();
    auto& record = engine.meshes[0]; record.geometry = 0;
    auto& geometry = engine.geometries[0];
    geometry.vertices.resize(1);
    auto& vertex = geometry.vertices[0];
    // The pin uploads the file's lanes untouched, signed zero included.
    vertex.position = {-1.25f, 2.75f, 0.6f}; vertex.normal = {-0.0f, 0.3f, 2.75f};
    const auto packed = mesh_gpu_vertices(geometry, record);
    for (const auto name : {"position", "normal"}) {
        const auto input = pinned_vertex_input(name);
        const void* expected = std::string_view(name) == "position"
            ? static_cast<const void*>(&vertex.position) : &vertex.normal;
        assert(input.mapped && input.stream == VertexInputStream::vertex);
        assert(std::memcmp(reinterpret_cast<const std::uint8_t*>(&packed[0]) + input.offset, expected, 12) == 0);
    }
    for (const bool source_clockwise : {false, true}) for (const bool clockwise_front_face : {false, true}) {
        const std::vector<std::uint32_t> original{0, 1, 2, 0, 2, 3};
        geometry.indices = original; geometry.source_indices_reversed = false;
        ${cppFunction(loader, "if (\n                geometry.topology == MeshTopology::triangles &&\n                source_clockwise")}
        const auto adapted = geometry.indices;
        assert(geometry.source_indices_reversed == (source_clockwise && !clockwise_front_face));
        std::vector<std::uint32_t> scratch;
        const auto source = node_source_indices(geometry, scratch);
        assert(std::equal(source.begin(), source.end(), original.begin(), original.end()));
        assert(geometry.indices == adapted);
        assert(geometry.source_indices_reversed || (source.data() == geometry.indices.data() && scratch.empty()));
    }
    ${checks.join("\n")}
    // A factory mesh under a mesh parent: the block is the pin's parent walk.
    record.parent_world.reset();
    record.parent = MeshHandle{1};
    ${setTrs("engine.meshes[1]", parentTrs)}
    ${setTrs("record", childTrs)}
    same_matrix(node_mesh_block(scene, engine, MeshHandle{0}).world, Matrix{${floats(localExpected)}});
    record.scene_morph_targets = true;
    same_matrix(node_mesh_block(scene, engine, MeshHandle{0}).world, Matrix{${floats(localExpected)}});
    std::cout << "node geometry transport: ok\\n";
}
`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/DBBLITE_HAS_PBR_RENDERER=1",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/I",
            "native/include",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            fixture,
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /node geometry transport: ok/,
        );
    },
);
