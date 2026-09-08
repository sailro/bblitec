import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { float32Literal } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPhysicsMesh } from "../src/lowering/physics-mesh-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const store = new UpstreamSourceStore();
const module = "src/physics/havok.ts";
test("physics mesh source contracts reject traversal, defaults, buffer and index drift", () => {
    const source = store.getSource(module);
    for (const [before, after] of [
        ["this._collectIndices = collectIndices;", "this._collectIndices = true;"],
        ["private readonly _vertices: number[] = [];", "private readonly _vertices: number[] = [1];"],
        ["mat4Invert(root.worldMatrix as Mat4)", "mat4Invert(root.localMatrix as Mat4)"],
        ["mat4Multiply(rootScale, invRoot)", "mat4Multiply(invRoot, rootScale)"],
        ["if (includeChildren)", "if (!includeChildren)"],
        ["this._addNodeMesh(node, rootToBody);", "this._addNodeMesh(node, rootToBody); this._vertices.push(1);"],
        ["mat4Multiply(rootToBody, node.worldMatrix as Mat4)", "mat4Multiply(rootToBody, node.localMatrix as Mat4)"],
        ["this._vertices.length / 3", "this._vertices.length / 2"],
        ["this._indices.push(c, b, a)", "this._indices.push(a, b, c)"],
        ["new Float32Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._vertices)", "new Float64Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._vertices)"],
        ["new Int32Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._indices)", "new Int16Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._indices)"],
        ["hknp._free(buffer.offset);", "hknp._free(buffer.numObjects);"],
    ]) {
        assert(source.includes(before!));
        class Changed extends LoweringContext {
            override sourceFile(path: string): ts.SourceFile {
                return path === module ? ts.createSourceFile(path, source.replace(before!, after!), ts.ScriptTarget.Latest, true) : super.sourceFile(path);
            }
        }
        assert.throws(() => lowerPhysicsMesh(new Changed(store)), /changed|exactly|Expected/);
    }
});

const tools = optionalNativeFixtureTools(false);
test("physics mesh PAL arrays match pinned mixed hierarchy, traversal order and float32 boundaries", { skip: !tools }, async () => {
    const imports = Object.assign({}, ...await Promise.all([
        "math/mat4-invert.js", "math/mat4-multiply.js", "math/mat4-scale.js",
    ].map(path => importPinnedModule<object>(path))));
    const exports: any = {};
    new Function("exports", "require", ts.transpileModule(store.getSource(module) + "\nexport { MeshAccumulator };", {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText)(exports, () => imports);
    const matrix = (sx: number, sy: number, sz: number, angle: number, x: number, y: number, z: number) => new Float32Array([
        Math.cos(angle) * sx, Math.sin(angle) * sx, 0, 0, -Math.sin(angle) * sy, Math.cos(angle) * sy, 0, 0,
        0, 0, sz, 0, x, y, z, 1,
    ]);
    const worlds = [matrix(2, -3, 4, .43, 12.13, -7.27, 4.29), matrix(1, 2, 3, -.37, 8.17, 6.21, -3.33),
        matrix(-1, 1, 2, .91, -9.11, .71, 2.17), matrix(2, .5, -3, -.19, 5.31, -2.73, 9.97)];
    const vertices = new Float32Array([.17, .29, .43, 1.13, .59, -.61, .79, 1.83, .97]);
    const indices = new Uint32Array([0, 1, 2]);
    const root: any = { worldMatrix: worlds[0], scaling: { x: 2, y: -3, z: 4 }, children: [] };
    const meshes = worlds.slice(1).map(worldMatrix => ({ _gpu: {}, _cpuPositions: vertices, _cpuIndices: indices, worldMatrix, children: [] as any[], scaling: { x: 1, y: 1, z: 1 } }));
    // Traversal membership deliberately differs from transform ancestry.
    const branch = { worldMatrix: matrix(1, 1, 1, 0, 100, 200, 300), scaling: { x: 1, y: 1, z: 1 }, children: [meshes[1]] };
    root.children = [meshes[0], branch]; meshes[0]!.children.push(meshes[2]);
    const expected: { positions: number[]; indices: number[] }[] = [];
    for (const [node, children, collect] of [[root, true, true], [root, true, false], [meshes[0], false, true], [meshes[0], true, true]] as const) {
        const accumulator = new exports.MeshAccumulator(collect);
        accumulator.addNodeMeshes(node, children);
        const HEAPU8 = new Uint8Array(4096); let cursor = 0;
        const hknp = { HEAPU8, _malloc(bytes: number) { const offset = cursor; cursor += bytes; return offset; } };
        const p = accumulator.getVertices(hknp), i = accumulator.getTriangles(hknp);
        expected.push({ positions: [...new Float32Array(HEAPU8.buffer, p.offset, p.numObjects)], indices: [...new Int32Array(HEAPU8.buffer, i.offset, i.numObjects)] });
    }
    const output = resolve("artifacts/physics-mesh-accumulator"); mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world"]);
    const lowered = lowerPhysicsMesh(new LoweringContext());
    const cppArray = (values: Iterable<number>) => `{${[...values].map(float32Literal).join(",")}}`;
    const path = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(path, `#include <bblite/upstream/physics.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <cassert>
#include <iostream>
#include <iomanip>
namespace bbl::pal {
std::vector<std::array<double, 3>> captured_positions; std::vector<std::uint32_t> captured_indices;
PhysicsShapeHandle physics_shape_create_mesh(const std::vector<std::array<double,3>>& p, const std::vector<std::uint32_t>& i) {captured_positions=p; captured_indices=i;return {};}
PhysicsShapeHandle physics_shape_create_convex_hull(const std::vector<std::array<double,3>>& p) {captured_positions=p;captured_indices.clear();return {};}
}
namespace bbl::upstream {
std::array<std::array<float,16>,4> worlds{{${worlds.map(cppArray).join(",")}}};
PhysicsWorld fixture_world;
PhysicsWorld::~PhysicsWorld() = default;
PhysicsWorld& physics_world_record(PhysicsWorldHandle) { return fixture_world; }
std::array<float,16> mesh_world_matrix(const Engine&,const MeshRecord& mesh) {return worlds.at(mesh.geometry+1);}
std::array<float,16> transform_node_world(const Engine&,TransformNodeHandle) {return worlds[0];}
${lowered.helpers}
${lowered.source}
}
int main() {
    using namespace bbl; using namespace bbl::upstream;
    Engine engine; fixture_world.engine=&engine;engine.meshes.resize(3);engine.geometries.resize(3);engine.transform_nodes.resize(2);
    const std::array<float,9> values${cppArray(vertices)};
    for(std::uint32_t i=0;i<3;++i) {
        engine.meshes[i].geometry=i;auto& g=engine.geometries[i];
        for(std::size_t j=0;j<values.size();j+=3) {ModelVertex v;v.position={values[j],values[j+1],values[j+2]};v.local_position=v.position;g.vertices.push_back(v);}
        g.indices={0,1,2};
    }
    engine.meshes[0].children={MeshHandle{2}};
    engine.meshes[1].detached_imported_mesh=true;engine.geometries[1].vertex_space=VertexSpace::world;
    engine.geometries[1].indices={0,2,1};engine.geometries[1].source_indices_reversed=true;
    for(auto& v:engine.geometries[1].vertices)v.position={100,200,300};
    engine.transform_nodes[0].scaling={2,-3,4};engine.transform_nodes[0].children={MeshHandle{0},TransformNodeHandle{1}};
    engine.transform_nodes[1].children={MeshHandle{1}};
    const auto run=[&](PhysicsNodeRef node,bool children,bool collect) {
        create_physics_mesh_shape({},collect?PhysicsShapeType::MESH:PhysicsShapeType::CONVEX_HULL,node,children);
        std::cout << std::setprecision(17) << "{\\"positions\\":["; bool first=true;
        for(const auto& p:pal::captured_positions)for(double lane:p){if(!first)std::cout << ',';first=false;std::cout << lane;}
        std::cout << "],\\"indices\\":[";first=true;for(auto i:pal::captured_indices){if(!first)std::cout << ',';first=false;std::cout << i;}std::cout << "]}\\n";
    };
    run(physics_node(TransformNodeHandle{0}),true,true);run(physics_node(TransformNodeHandle{0}),true,false);
    run(physics_node(MeshHandle{0}),false,true);run(physics_node(MeshHandle{0}),true,true);
    const auto refuse=[&](auto operation,const char* text){bool refused=false;try{operation();}catch(const std::runtime_error& e){refused=std::string(e.what()).find(text)!=std::string::npos;}assert(refused);};
    refuse([&]{run(physics_node(TransformNodeHandle{0}),false,true);},"without vertex");
    worlds[0].fill(0);refuse([&]{run(physics_node(TransformNodeHandle{0}),true,true);},"singular root");
    engine.geometries[0].indices.clear();refuse([&]{run(physics_node(MeshHandle{0}),false,true);},"without triangle");
    engine.geometries[0].vertex_space=VertexSpace::world;refuse([&]{run(physics_node(MeshHandle{0}),false,false);},"source-local geometry");
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${output}\\`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(output, "upstream/include"), path]);
    const actual = execFileSync(executable, { encoding: "utf8" }).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(actual, expected);
    writeFileSync(join(output, "report.json"), JSON.stringify({ cases: expected.length, maximumError: 0, expected, actual }, null, 2));
});
