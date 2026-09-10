import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { GLTF_MESH_PLAN, GLTF_MESH_WALKS, glbJsonText } from "../src/gltf-document.js";
import { gltfMeshWalks, packageMeshWalks, type CompiledMeshWalk } from "../src/gltf-mesh-walks.js";
import { packageGltf } from "../src/gltf-packager.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { withMeshPlan } from "./gltf-mesh-fixture.js";

// Preserve the actual authored worklist. The graph below distinguishes its
// order from both source preorder and reversing the native node-array table.
const corpus = ts.createSourceFile("scene149.ts", readFileSync("corpus/babylon-lite/lab/lite/src/lite/scene149.ts", "utf8"), ts.ScriptTarget.Latest, true);
const declaration = corpus.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "collectMeshes") as ts.FunctionDeclaration;
const stack: CompiledMeshWalk = { kind: "source", parameter: "container", body: declaration.body!.getText(corpus) };
const preorder: CompiledMeshWalk = { kind: "preorder" };
const hierarchy = {
    asset: {version: "2.0"}, scene: 0, scenes: [{nodes: [1, 0, 2]}],
    nodes: [
        {mesh: 0, children: [3]}, {mesh: 1, children: [4]},
        {mesh: 2}, {mesh: 1}, {mesh: 1},
    ],
    meshes: [{primitives: [{}, {}]}, {primitives: [{}]}, {primitives: [{}, {}]}],
};
const stackOrder = [4, 3, 1, 0, 5, 2, 6];
const preorderOrder = [6, 2, 5, 0, 1, 3, 4];
const recursiveCorpus = ts.createSourceFile("scene41.ts", readFileSync("corpus/babylon-lite/lab/lite/src/lite/scene41.ts", "utf8"), ts.ScriptTarget.Latest, true);
const recursiveVisitor = recursiveCorpus.statements.filter(statement => ts.isFunctionDeclaration(statement) &&
    ["isMeshNode", "hasChildren", "collectMeshes"].includes(statement.name?.text ?? ""))
    .map(statement => statement.getText(recursiveCorpus).replaceAll("collectMeshes", "visitMeshes")).join("\n");

test("source collectors observe the pinned multi-level, multi-primitive hierarchy", async () => {
    assert.deepEqual(await gltfMeshWalks(hierarchy, [stack, preorder]), [stackOrder, preorderOrder]);
    assert.notDeepEqual(stackOrder, [6, 5, 4, 3, 2, 1, 0]);
});

test("packaging retains only demanded collectors and refuses unrepresented mesh sets", async () => {
    const directory = resolve("artifacts/test-gltf-mesh-walks");
    mkdirSync(directory, {recursive: true});
    const source = join(directory, "hierarchy.gltf");
    writeFileSync(source, JSON.stringify(hierarchy));
    const plain = JSON.parse(glbJsonText(Buffer.from(await packageGltf(source, directory)))!);
    assert.equal(plain[GLTF_MESH_WALKS], undefined);
    const packed = JSON.parse(glbJsonText(Buffer.from(await packageGltf(source, directory, false, [stack, undefined, preorder])))!);
    assert.deepEqual(packed[GLTF_MESH_WALKS], [stackOrder, [], preorderOrder]);
    const inline = "data:model/gltf+json;base64," + Buffer.from(JSON.stringify(hierarchy)).toString("base64");
    const inlinePacked = JSON.parse(glbJsonText(Buffer.from(await packageGltf(inline, directory, false, [stack])))!);
    assert.deepEqual(inlinePacked[GLTF_MESH_WALKS], [stackOrder]);
    await assert.rejects(packageMeshWalks(packed, [stack]), /already carries/);
    for (const document of [
        {...hierarchy, scenes: [{nodes: [0]}]},
        {...hierarchy, scenes: [{nodes: [0, 0, 1, 2]}]},
        {...hierarchy, nodes: [{...hierarchy.nodes[0], children: [0]}, ...hierarchy.nodes.slice(1)]},
        {...hierarchy, extensionsUsed: ["EXT_mesh_gpu_instancing"]},
        {...hierarchy, nodes: [{...hierarchy.nodes[0], extensions: {EXT_mesh_gpu_instancing: {}}}, ...hierarchy.nodes.slice(1)]},
    ]) await assert.rejects(packageMeshWalks(document, [stack]), /mesh walks/);
});

const closure = `function recursive(container: AssetContainer): Mesh[] {
    const meshes: Mesh[] = [];
    const visit = (node: unknown): void => {
        if (node && typeof node === "object") {
            if ("_gpu" in node && "material" in node) meshes.push(node as unknown as Mesh);
            const children = (node as {children?: readonly unknown[]}).children;
            if (children) { for (const child of children) visit(child); }
        }
    };
    for (const entity of container.entities) visit(entity);
    return meshes;
}`;

function compiledWalks() {
    return compileSource(`import {createEngine, loadGltf, getContainerMeshes, type AssetContainer, type Mesh, type Material, type SceneNode} from "@babylonjs/lite";
        ${declaration.getText(corpus)}
        ${closure}
        ${recursiveVisitor}
        const engine = await createEngine({});
        const asset = await loadGltf(engine, "hierarchy.gltf");
        const other = await loadGltf(engine, "unrelated.gltf");
        const flat = getContainerMeshes(asset);
        const ignored = getContainerMeshes(other);
        if (ignored.length !== 7) throw new Error("flat table changed");
        const ordered = new Map<Material, Mesh[]>();
        for (const mesh of collectMeshes(asset)) {
            const material = mesh.material!;
            const group = ordered.get(material);
            if (group) group.push(mesh); else ordered.set(material, [mesh]);
        }
        const groups: Mesh[] = [];
        for (const [, meshes] of ordered) groups.push(meshes[0]!);
        if (groups[0] !== flat[4] || groups[1] !== flat[3] || groups[2] !== flat[0] || groups[3] !== flat[5]) throw new Error("Map owner order changed");
        const recursiveOrder = new Map<Mesh, number>();
        for (const mesh of recursive(asset)) recursiveOrder.set(mesh, recursiveOrder.size);
        const expected = [${preorderOrder.join(",")}];
        let cursor = 0;
        for (const [mesh] of recursiveOrder) {
            if (mesh !== flat[expected[cursor]!]!) throw new Error("recursive order changed");
            cursor++;
        }
        const walked: Mesh[] = [];
        for (const entity of asset.entities) visitMeshes(entity, walked);
        const retained: {meshes: Mesh[]} = {meshes: walked};
        const view: {meshes: readonly Mesh[]} = {meshes: walked};
        for (let i=0; i<expected.length; i++) {
            if (retained.meshes[i] !== flat[expected[i]!] || view.meshes[i] !== flat[expected[i]!]) {
                throw new Error("escaped traversal did not retain its source order");
            }
        }
    `);
}

test("compiler demand is per asset and keeps distinct source collector orders", async () => {
    const result = compiledWalks();
    assert.deepEqual(result.manifest.assets.map(asset => asset.meshWalks), [[0, 1, 2], undefined]);
    assert.equal(result.manifest.meshWalks?.length, 3);
    assert.match(result.cpp, /bbl::asset_mesh_walk\([^\n]+, 0\)/);
    assert.match(result.cpp, /bbl::asset_mesh_walk\([^\n]+, 1\)/);
    assert.match(result.cpp, /\.assets\[[^\]]+\]\.meshes/);
    assert.deepEqual(await gltfMeshWalks(hierarchy, result.manifest.meshWalks!), [stackOrder, preorderOrder, preorderOrder]);
    const lowerer = new GltfLowerer(new LoweringContext());
    assert(!lowerer.lowerLoaderAdapter().source.includes("load_source_mesh_walks"));
    assert(lowerer.lowerLoaderAdapter({sourceMeshWalks: true}).source.includes("load_source_mesh_walks(asset, document)"));
});

const tools = optionalNativeFixtureTools();
test("native source loops observe Map insertion order and retained per-asset permutations", {skip: !tools}, async () => {
    const result = compiledWalks();
    const document = structuredClone(hierarchy);
    await withMeshPlan(document);
    await packageMeshWalks(document, result.manifest.meshWalks!);
    const source = new GltfLowerer(new LoweringContext()).lowerLoaderAdapter({sourceMeshWalks: true}).source;
    const helpers = ["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value(", "std::vector<double> double_array(", "void load_source_mesh_walks("]
        .map(signature => cppFunction(source, signature)).join("\n");
    assert.match(source, /install_asset_scene_meshes\(asset, double_array\(&required\(mesh_plan, "sceneMeshes"\)\)\)/);
    const scene = new SceneLowerer(new LoweringContext()).lowerCore().source;
    const cloneHelpers = ["void require_scene_engine(", "AssetRecord& asset_record(", "AssetHandle clone_asset_root(",
        "void add_asset_meshes(", "void add_to_scene(Scene& scene, AssetHandle asset)", "void add_asset_entities("]
        .map(signature => cppFunction(scene, signature)).join("\n");
    const directory = resolve("artifacts/test-gltf-mesh-walks");
    mkdirSync(directory, {recursive: true});
    const file = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <cassert>
namespace bbl {
using JsonObject = ts::JsonValue::Object;
${helpers}
void add_to_scene(Scene& scene, MeshHandle mesh) { scene.meshes.push_back(mesh); }
void add_to_scene(Scene& scene, LightHandle light) { scene.lights.push_back(light); }
${cloneHelpers}
Engine create_engine(EngineOptions) { return Engine{}; }
std::string asset_path(const std::string& path) { return path; }
AssetHandle load_gltf(Engine& engine, const std::string&) {
    AssetRecord asset;
    constexpr std::uint32_t materials[] = {0,1,0,2,1,3,2};
    for (const auto material : materials) {
        asset.meshes.push_back(MeshHandle{static_cast<std::uint32_t>(engine.meshes.size())});
        MeshRecord mesh; mesh.material = MaterialHandle{material}; engine.meshes.push_back(mesh);
    }
    const auto document = ts::json_parse(R"(${JSON.stringify(document)})").as_object();
    const auto& mesh_plan = required(document, "${GLTF_MESH_PLAN}").as_object();
    install_asset_scene_meshes(asset, double_array(&required(mesh_plan, "sceneMeshes")));
    load_source_mesh_walks(asset, document);
    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}
}
${result.cpp.replace("int main()", "int compiled_source()")}
int main() {
    assert(compiled_source() == 0);
    bbl::Engine engine;
    auto first = bbl::load_gltf(engine, "");
    auto clone = bbl::clone_asset_root(engine, first);
    assert(engine.assets[clone.value].source_mesh_walks == engine.assets[first.value].source_mesh_walks);
    const auto original = bbl::asset_mesh_walk(engine, first, 0);
    const auto copy = bbl::asset_mesh_walk(engine, clone, 0);
    for (std::size_t i = 0; i < copy.size(); ++i) assert(copy[i].value == original[i].value + 7);
    const auto check_registration = [&](bbl::AssetHandle handle, const std::vector<std::uint32_t>& expected) {
        bbl::Scene container; container.engine = &engine;
        bbl::Scene entities; entities.engine = &engine;
        bbl::add_to_scene(container, handle);
        bbl::add_asset_entities(entities, handle);
        assert(container.meshes.size() == expected.size() && entities.meshes.size() == expected.size());
        for (std::size_t i = 0; i < expected.size(); ++i) {
            assert(container.meshes[i].value == expected[i] && entities.meshes[i].value == expected[i]);
        }
    };
    check_registration(first, {${preorderOrder.join(",")}});
    check_registration(clone, {${preorderOrder.map(index => index + 7).join(",")}});
    auto& asset = engine.assets[first.value];
    const auto retained = asset.source_mesh_walks;
    for (const char* bad : {"[[0]]", "[[0,1,2,3,4,5,5]]", "[[0,1,2,3,4,5,7]]", "[[0,1,2,3,4,5,-1]]", "[[0,1,2,3,4,5,0.5]]"}) {
        bool rejected = false;
        try { bbl::load_source_mesh_walks(asset, bbl::ts::json_parse(std::string("{\\\"${GLTF_MESH_WALKS}\\\":") + bad + "}").as_object()); }
        catch (const std::runtime_error&) { rejected = true; }
        assert(rejected && asset.source_mesh_walks == retained);
    }
    for (const auto bad : {-1.0, 7.0, 0.5, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
        bool rejected = false;
        try { bbl::install_asset_scene_meshes(asset, {bad}); }
        catch (const std::runtime_error&) { rejected = true; }
        assert(rejected && asset.source_mesh_walks == retained);
    }
    bbl::install_asset_scene_meshes(asset, {2,2,0});
    check_registration(first, {2,2,0});
    assert(bbl::asset_mesh_walk(engine, first, 0)[0].value == 4);
    assert(engine.assets[clone.value].source_mesh_walks == retained);
    bbl::install_asset_scene_meshes(asset, {});
    check_registration(first, {});
    asset.source_mesh_walks.reset();
    check_registration(first, {0,1,2,3,4,5,6});
    engine.assets.clear();
    assert(original[0].value == 4 && copy[0].value == 11);
    std::puts("gltf-mesh-walks: ok");
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}\\`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), file]);
    assert.match(execFileSync(executable, {encoding: "utf8"}), /gltf-mesh-walks: ok/);
});
