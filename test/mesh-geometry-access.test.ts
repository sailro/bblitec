import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshGeometryAccess } from "../src/lowering/mesh-geometry-access.js";
import { lowerMeshAttributeFeatures } from "../src/lowering/mesh-attribute-features.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("geometry access returns nullable typed records through ordinary data sinks", () => {
    const compiled = compileSource(
        `import {createEngine, createSceneContext, createBox, getMeshGeometry, getMeshTriangles, createMeshFromData, enableGltfCpuTangents} from "babylon-lite";
        async function main(){const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);createSceneContext(engine);enableGltfCpuTangents();const mesh=createBox(engine,1);const geometry=getMeshGeometry(mesh);if(geometry){geometry.positions[0]=2;createMeshFromData(engine,"copy",geometry.positions,geometry.normals,geometry.indices,geometry.uvs,geometry.uvs2,geometry.tangents,geometry.colors);}const triangles=getMeshTriangles(mesh);if(triangles)triangles.indices[0]=0;}main();`,
        { fileName: "mesh-geometry-access.ts" },
    );
    assert(compiled.manifest.features.includes("mesh:geometry-access"));
    assert(compiled.manifest.features.includes("loader:gltf-cpu-tangents"));
    assert.match(compiled.cpp, /get_mesh_geometry/);
    assert.match(compiled.cpp, /get_mesh_triangles/);
});

test("mesh CPU aliases survive GPU-only writes, clones and geometry replacement", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const context = new LoweringContext();
    const factories = new FactoryLowerer(context).lowerMeshFactories([
        "mesh:from-data",
        "mesh:resize-geometry",
        "mesh:update-attributes",
    ]).source;
    const scene = new SceneLowerer(context).lowerCore({
        geometryAccess: true,
    }).source;
    const readers = [
        "MeshHandle clone_mesh_node(",
        "std::vector<float> mesh_cpu_positions(",
        "std::vector<float> mesh_cpu_normals(",
        "std::vector<float> mesh_cpu_uvs(",
        "std::vector<std::uint32_t> mesh_cpu_indices(",
    ].map((signature) => cppFunction(scene, signature)).join("\n");
    const compiled = compileSource(`
        import {createEngine, createMeshFromData, getMeshGeometry, updateMeshPositions, resizeMeshGeometry, type Mesh} from "babylon-lite";
        const engine = await createEngine({});
        const order: number[] = [];
        let positions = new Float32Array([0,0,0,1,0,0,0,1,0]);
        const original = positions;
        const normals = new Float32Array([0,1,0,0,1,0,0,1,0]);
        const indices = new Uint32Array([0,1,2]);
        function name(): string { order.push(1); return "ordered"; }
        function normalData(): Float32Array { order.push(2); positions = new Float32Array(9); original[0] = 7; return normals; }
        function indexData(): Uint32Array { order.push(3); return indices; }
        function uvData(): Float32Array { order.push(4); return new Float32Array(0); }
        const mesh = createMeshFromData(engine, name(), positions, normalData(), indexData(), uvData());
        if (order.join(",") !== "1,2,3,4" || getMeshGeometry(mesh)!.positions[0] !== 7) throw new Error("factory argument order");
        function selected(): Mesh { order.push(5); return mesh; }
        function vertexOffset(): number { order.push(6); original[0] = 8; return 0; }
        function vertexCount(): number { order.push(7); return 1; }
        updateMeshPositions(engine, selected(), original, vertexOffset(), vertexCount());
        if (order.join(",") !== "1,2,3,4,5,6,7" || getMeshGeometry(mesh)!.positions[0] !== 8) throw new Error("upload argument order");
        resizeMeshGeometry(engine, selected(), positions, normalData(), indexData(), uvData());
        if (order.join(",") !== "1,2,3,4,5,6,7,5,2,3,4" || getMeshGeometry(mesh)!.positions[0] !== 0) throw new Error("resize argument order");
    `);
    const directory = resolve("artifacts/mesh-cpu-streams-check");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, "check.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(file, `${factories}
#include <cassert>
namespace bbl {
${lowerMeshGeometryAccess(context)}
${readers}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) { ++handle_at(engine.meshes, mesh).transform_version; }
Engine create_engine(EngineOptions options) { Engine engine; engine.options = options; return engine; }
}
#define main generated_scene_main
${compiled.cpp}
#undef main
int main() {
    using namespace bbl;
    assert(generated_scene_main() == 0);
    Engine engine;
    js::F32Array positions{0,0,0,1,0,0,0,1,0}, normals{0,1,0,0,1,0,0,1,0}, uvs{0,0,1,0,0,1};
    js::U32Array indices{0,1,2};
    const auto mesh = create_retained_mesh_from_data(engine, "owned", positions, normals, indices, uvs, {}, {}, {});
    const auto snapshot = get_mesh_geometry(engine, mesh);
    assert(snapshot && snapshot->positions[0] == 0);
    positions[0] = 2; normals[0] = 3; uvs[0] = 0.5f; indices[0] = 2;
    assert(mesh_cpu_positions(engine, mesh)[0] == 2 && mesh_cpu_normals(engine, mesh)[0] == 3);
    assert(mesh_cpu_uvs(engine, mesh)[0] == 0.5f && mesh_cpu_indices(engine, mesh)[0] == 2);
    assert(get_mesh_geometry(engine, mesh)->positions[0] == 2 && snapshot->positions[0] == 0);
    assert(engine.geometries[0].vertices[0].position.x == 0 && engine.geometries[0].indices[0] == 0);
    update_mesh_positions(engine, mesh, {9,8,7}, 0, 1, 0);
    update_mesh_uvs(engine, mesh, {0.75f,0.25f}, 0, 1, 0);
    assert(mesh_cpu_positions(engine, mesh)[0] == 2 && mesh_cpu_uvs(engine, mesh)[0] == 0.5f);
    assert(engine.geometries[0].render_vertices_override->at(0).position.x == 9);
    assert(engine.geometries[0].render_vertices_override->at(0).uv.x == 0.75f);
    const auto clone = clone_mesh_node(engine, mesh);
    const auto omitted = clone_mesh_node(engine, mesh);
    positions[0] = 4;
    assert(get_mesh_triangles(engine, clone)->positions[0] == 4);
    js::F32Array replacement{0,0,0,5,0,0,0,5,0}, replacementNormals(9), empty;
    js::U32Array replacementIndices{0,1,2};
    const std::array<MeshHandle,2> family{mesh,clone};
    resize_shared_retained_mesh_geometry(engine, family, replacement, replacementNormals, replacementIndices, empty, {}, {}, {});
    replacement[0] = 6; positions[0] = 7;
    assert(get_mesh_triangles(engine, mesh)->positions[0] == 6 && get_mesh_triangles(engine, clone)->positions[0] == 6);
    assert(get_mesh_triangles(engine, omitted)->positions[0] == 7);
    assert(!get_mesh_geometry(engine, mesh)->uvs && !engine.geometries[handle_at(engine.meshes, mesh).geometry].render_vertices_override);
    resize_retained_mesh_geometry(engine, clone, positions, normals, indices, uvs, {}, {}, {});
    positions[0] = 8; replacement[0] = 9;
    assert(mesh_cpu_positions(engine, clone)[0] == 8 && mesh_cpu_positions(engine, mesh)[0] == 9);
    const auto without = create_retained_mesh_from_data(engine, "absent", empty, empty, js::U32Array{}, {}, {}, {}, {});
    const auto withEmpty = create_retained_mesh_from_data(engine, "empty", empty, empty, js::U32Array{}, empty, empty, empty, empty);
    assert(get_mesh_geometry(engine, without) && !get_mesh_geometry(engine, without)->uvs);
    const auto optional = get_mesh_geometry(engine, withEmpty);
    assert(optional && optional->uvs && optional->uvs->empty() && !optional->uvs2 && !optional->tangents && !optional->colors);
}
`);
    runNativeFixtureCompiler(native, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/Gy",
        `/I${resolve("native/include")}`, file, `/Fo${directory}/`, `/Fe${executable}`,
        "/link", "/OPT:REF",
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 10000 });
});

test("geometry snapshots preserve optional streams, caller ownership and source winding", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-mesh-geometry-access");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    const source = lowerMeshGeometryAccess(new LoweringContext());
    const featureContext = new LoweringContext();
    const featureBits = [
        "MSH_HAS_TANGENTS",
        "MSH_HAS_VERTEX_COLOR",
        "MSH_HAS_UV2",
    ].map((name) =>
        featureContext.pinnedNumber("src/material/mesh-features.ts", name),
    );
    const changed = lowerMeshGeometryAccess(
        doctoredContext(
            "src/mesh/get-mesh-geometry.ts",
            "tangents?.length ?",
            "tangents?.length > 4 ?",
        ),
    );
    writeFileSync(
        file,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <stdexcept>
using namespace bbl;
namespace original {${source}}
namespace changed {${changed}}
namespace original_features {${lowerMeshAttributeFeatures(featureContext)}}
namespace changed_features {${lowerMeshAttributeFeatures(doctoredContext("src/material/mesh-features.ts", "if (gpu.tangentBuffer)", "if (!gpu.tangentBuffer)"))}}
int main(){Engine engine;engine.geometries.emplace_back();engine.meshes.emplace_back().geometry=0;
for(unsigned index=0;index<8;++index){const bool tangent=(index&1)!=0,color=(index&2)!=0,uv2=(index&4)!=0;const auto expected=(tangent?${featureBits[0]}u:0u)|(color?${featureBits[1]}u:0u)|(uv2?${featureBits[2]}u:0u);
if(original_features::pinned_mesh_attribute_features(tangent,color,uv2)!=expected||changed_features::pinned_mesh_attribute_features(tangent,color,uv2)!=(expected^${featureBits[0]}u))throw std::runtime_error("Source attribute features");}
auto& geometry=engine.geometries[0];geometry.vertices.resize(1);geometry.vertices[0].position={1,2,3};geometry.vertices[0].normal={0,1,0};geometry.vertices[0].uv={0.25f,0.75f};geometry.vertices[0].uv2={0.5f,1};geometry.vertices[0].tangent={1,0,0,-1};geometry.vertices[0].color={0.1f,0.2f,0.3f,1};geometry.indices={0,2,1};geometry.source_indices_reversed=true;
auto absent=original::get_mesh_geometry(engine,MeshHandle{0});if(!absent||absent->tangents.has_value()||absent->uvs2.has_value()||absent->colors.has_value()||!absent->uvs.has_value())throw std::runtime_error("optional streams");
geometry.cpu_tangents=true;geometry.cpu_uv2s=true;geometry.cpu_colors=true;
auto first=original::get_mesh_geometry(engine,MeshHandle{0});auto second=original::get_mesh_geometry(engine,MeshHandle{0});
if(!first||!second||!first->tangents.has_value()||!first->uvs2.has_value()||!first->colors.has_value()||first->indices[1]!=1||first->indices[2]!=2)throw std::runtime_error("retained lanes and winding");
first->positions[0]=42;first->tangents.value()[0]=8;first->indices[0]=7;
if(second->positions[0]!=1||second->tangents.value()[0]!=1||geometry.vertices[0].position.x!=1||geometry.indices[0]!=0)throw std::runtime_error("caller ownership");
auto modified=changed::get_mesh_geometry(engine,MeshHandle{0});if(!modified||modified->tangents.has_value())throw std::runtime_error("source optional predicate");
auto triangles=original::get_mesh_triangles(engine,MeshHandle{0});if(!triangles||triangles->positions[2]!=3||triangles->indices[1]!=1)throw std::runtime_error("triangle snapshot");
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        resolve(nativeFixtureVcpkgRoot, "include"),
        file,
    ]);
    assert.equal(
        execFileSync(executable, { cwd: directory, encoding: "utf8" }),
        "",
    );
});
