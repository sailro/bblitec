import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerPbrMaterialGroups} from "../src/lowering/pbr-material-groups.js";
import {lowerPbrTransmissionTransaction} from "../src/lowering/pbr-transmission-transaction.js";
import {materialGroupIdentity} from "../src/lowering/material-group-identity.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const sceneModule = "src/scene/scene-core.ts";
const pbrModule = "src/material/pbr/pbr-renderable.ts";
type Operation = ["add" | "remove" | "thin", number] | ["swap", number, number] | ["build" | "drain" | "rebuild"];
interface Scenario {materials: number[]; operations: Operation[]}
const scenarios: Scenario[] = [
    {materials: [0, 0], operations: [["add", 0], ["add", 1], ["build"]]},
    {materials: [0, 0], operations: [["build"], ["add", 0], ["add", 1], ["drain"]]},
    {materials: [0, 0], operations: [["add", 0], ["build"], ["add", 1], ["drain"]]},
    {materials: [0, 1], operations: [["add", 0], ["build"], ["add", 1], ["drain"]]},
    {materials: [1, 0], operations: [["add", 0], ["build"], ["add", 1], ["drain"]]},
    {materials: [0], operations: [["add", 0], ["swap", 0, 1], ["build"]]},
    {materials: [0], operations: [["add", 0], ["swap", 0, 1], ["drain"], ["build"]]},
    {materials: [0, 0], operations: [["add", 0], ["build"], ["thin", 1], ["add", 1], ["drain"]]},
    {materials: [0], operations: [["thin", 0], ["add", 0], ["build"], ["swap", 0, 1], ["drain"]]},
    {materials: [-1, -1], operations: [["add", 0], ["add", 1], ["build"], ["thin", 1], ["swap", 0, 0], ["swap", 1, 0], ["drain"]]},
    {materials: [0], operations: [["add", 0], ["build"], ["swap", 0, 1], ["drain"]]},
    {materials: [0], operations: [["add", 0], ["build"], ["swap", 0, 1], ["swap", 0, 0], ["drain"]]},
    {materials: [0], operations: [["add", 0], ["add", 0], ["build"], ["add", 0], ["add", 0], ["drain"]]},
    {materials: [-1, -1], operations: [["add", 0], ["add", 1], ["build"], ["swap", 0, 0], ["swap", 1, 0], ["drain"]]},
    {materials: [0, 0], operations: [["add", 0], ["add", 1], ["build"], ["remove", 0], ["rebuild"]]},
    {materials: [0], operations: [["add", 0], ["build"], ["remove", 0], ["rebuild"]]},
    {materials: [0, 0], operations: [["add", 0], ["build"], ["remove", 0], ["rebuild"], ["add", 1], ["build"]]},
    {materials: [0], operations: [["add", 0], ["build"], ["remove", 0], ["rebuild"], ["build"]]},
    {materials: [0], operations: [["add", 0], ["rebuild"], ["build"]]},
    {materials: [0], operations: [["add", 0], ["swap", 0, -1], ["build"]]},
    {materials: [0], operations: [["add", 0], ["build"], ["swap", 0, -1], ["drain"], ["rebuild"]]},
    {materials: [0], operations: [["add", 0], ["build"], ["swap", 0, 2], ["drain"], ["swap", 0, 1], ["drain"], ["rebuild"]]},
    {materials: [0, 2], operations: [["add", 0], ["add", 1], ["build"], ["swap", 0, 2], ["drain"], ["swap", 0, 1], ["drain"]]},
    {materials: [2, 3], operations: [["add", 0], ["add", 1], ["build"], ["swap", 0, 0], ["swap", 1, 0], ["drain"], ["rebuild"]]},
    {materials: [4, 5, 6], operations: [["add", 0], ["add", 1], ["add", 2], ["build"], ["swap", 0, 0], ["drain"], ["rebuild"]]},
    {materials: [0, 0], operations: [["add", 0], ["add", 0], ["add", 1], ["build"], ["swap", 0, 4], ["drain"], ["rebuild"]]},
];

/** Execute the pin's queue, runtime dispatch and complete rebuild core with inert GPU objects. */
function sourceOracle(context: LoweringContext): (input: Scenario) => Promise<unknown> {
    const declaration = (module: string, name: string) => context.functionDeclaration(module, name).declaration.getText().replace(/^export /, "");
    const add = context.functionDeclaration(sceneModule, "addToScene").declaration;
    const build = context.variableInitializer(add, "build").parent.parent.parent;
    assert.ok(ts.isVariableStatement(build) && ts.isBlock(build.parent));
    const attachment = build.parent.statements.slice(build.parent.statements.indexOf(build)).map(node => node.getText()).join("\n");
    const pbr = context.functionDeclaration(pbrModule, "buildPbrRenderables").declaration;
    const gamma = context.variableInitializer(pbr, "hasGammaAlbedo").parent.parent.parent.getText();
    const scan = pbr.body!.statements.find(node => ts.isForStatement(node) && node.getText().includes("hasGammaAlbedo"));
    assert.ok(scan && ts.isForStatement(scan) && ts.isBlock(scan.statement));
    const gammaStatements = scan.statement.statements.filter(node => ts.isVariableStatement(node) || node.getText().startsWith("hasGammaAlbedo"));
    const gammaScan = ts.createPrinter().printNode(ts.EmitHint.Unspecified,
        ts.factory.updateForStatement(scan, scan.initializer, scan.condition, scan.incrementor,
            ts.factory.updateBlock(scan.statement, gammaStatements)), pbr.getSourceFile());
    const group = context.variableInitializer(pbr, "group").parent.parent.parent.getText();
    const invalidator = pbr.body!.statements.find(node => ts.isIfStatement(node) && node.getText().includes("group._w"))!.getText();
    const rebuildFile = context.sourceFile("src/scene/scene-rebuild.ts");
    const rebuildSource = rebuildFile.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText().replace(/^export /, "")).join("\n");
    const runtimeModule = "src/scene/scene-runtime-mesh-build.ts";
    const code = transpileCommonJs(`
        const require = () => ({A, C, X, rebuildScenePbrPipelines});
        const _lateCleanup = undefined;
        const retireGpuResources = (_engine, callback) => callback();
        ${declaration("src/scene/mesh-scene-registry.ts", "enqueueMaterialSwap")}
        ${declaration("src/scene/scene-material-swap.ts", "processMaterialSwaps")}
        ${["A", "B", "C", "X", "moveRuntimeMeshToGroup"].map(name => declaration(runtimeModule, name)).join("\n")}
        ${declaration("src/mesh/thin-instance.ts", "buildRuntimeThinMesh")}
        ${declaration(sceneModule, "buildScene")}
        ${rebuildSource}
        function installRuntimeBuilds(scene) {
            return scene._runtimeBuilds = {
                track: promise => promise, all: async () => {}, wait: async () => {},
                _e() {}, _x(error) {scene.error = error;}, _d: () => false,
                base: (_builder, rebuild) => rebuild, reset() {}, dropBase() {},
                holdPendingDisposers() {}, releasePendingDisposers() {},
                exclusive: (_builder, work) => work(),
                queue: async (builder, mesh) => {
                    const result = await builder(scene, [mesh]);
                    scene._groups.get(builder).r = result.rebuildSingle;
                }
            };
        }
        return async function(input) {
            const events = [], failures = [];
            const scene = {meshes: [], _groups: new Map(), _materialSwapQueue: [], _deferredBuilders: [],
                _renderables: [], _uniformUpdaters: [], _disposables: [], _meshDisposables: new Map(),
                _frameGraph: {build() {}}, surface: {engine: {}}, _built: false};
            const builder = Object.assign(async (scene, meshes) => {
                ${gamma}
                ${gammaScan}
                ${group}
                ${invalidator}
                events.push(meshes.map(mesh => mesh.id));
                return {renderables: [], rebuildSingle: (_scene, mesh) => ({mesh, order: 0}), _G: hasGammaAlbedo};
            }, {_materialFamily: "pbr", key: 1});
            const materials = [false, true].map(_gammaAlbedo => ({_buildGroup: builder, _gammaAlbedo}));
            for (const [key, family] of [[2, "standard"], [3, "shader"], [4, "node"], [5, "node"]]) {
                materials.push({_buildGroup: Object.assign(async () => ({renderables: [], rebuildSingle: (_scene, mesh) => ({mesh, order: 0})}), {_materialFamily: family, key})});
            }
            materials.push({...materials[4]});
            const meshes = input.materials.map((index, id) => ({id, material: materials[index] ?? null}));
            function add(ctx, mesh) { ctx.meshes.push(mesh); ${attachment} }
            for (const [op, index, value] of input.operations) {
                try {
                    const mesh = meshes[index];
                    if (op === "add") add(scene, mesh);
                    if (op === "remove") scene.meshes.splice(scene.meshes.indexOf(mesh), 1);
                    if (op === "thin") mesh._runtimeThinBuild = buildRuntimeThinMesh;
                    if (op === "swap") {
                        const material = materials[value] ?? null;
                        if (mesh.material !== material) {
                            mesh.material = material;
                            if (scene.meshes.includes(mesh)) enqueueMaterialSwap(scene, mesh);
                        }
                    }
                    if (op === "build") await buildScene(scene);
                    if (op === "drain") await processMaterialSwaps(scene);
                    if (op === "rebuild") await rebuildSceneRenderables(scene);
                    if (scene.error) throw scene.error;
                    failures.push(false);
                } catch (error) {
                    if (!(error instanceof TypeError) || !error.message.includes("Cannot read properties of null")) throw error;
                    failures.push(true);
                }
            }
            const group = scene._groups.get(builder);
            return {events, failures, members: (group ?? []).map(mesh => mesh.id), ready: !!group?.r,
                invalidates: !!group?._w, queue: scene._materialSwapQueue.map(mesh => mesh.id), built: scene._built,
                groups: [...scene._groups].map(([key, meshes]) => [key.key, meshes.map(mesh => mesh.id), !!meshes.r])};
        };`, sceneModule);
    return new Function(code)() as (input: Scenario) => Promise<unknown>;
}

test("PBR material group timing, later additions and rebuild inputs agree with source execution", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) {t.skip("Native fixture compiler unavailable."); return;}
    const contexts = [new LoweringContext(),
        doctoredContext(sceneModule, "ctx._built || group.r", "ctx._built && group.r"),
        doctoredContext(pbrModule, "hasGammaAlbedo ||= !!mat._gammaAlbedo", "hasGammaAlbedo &&= !!mat._gammaAlbedo")];
    const rows = [];
    for (const [variant, context] of contexts.entries()) {
        const oracle = sourceOracle(context);
        for (const input of scenarios) rows.push({variant, input, expected: await oracle(input)});
    }
    const directory = resolve("artifacts/test-pbr-material-groups"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(rows));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
namespace bbl {
std::vector<std::vector<std::uint32_t>> group_events;
void enable_scene_transmission(Scene& scene) {scene.transmission_enabled = true;}
${lowerPbrTransmissionTransaction(contexts[0]!)}
std::optional<bool> run_pbr_rebuild_transaction(Scene& scene, const std::vector<MeshHandle>& meshes,
    bool (*builder)(Scene&, const std::vector<MeshHandle>&)) {return run_pbr_rebuild_transaction_impl(scene, meshes, builder);}
void (*fixture_rebuild)(Scene&, bool, bool) = nullptr;
void rebuild_scene_renderables(Scene& scene) {fixture_rebuild(scene, false, true);}
void run_pbr_scene_hooks(Scene&, const std::vector<MeshHandle>& meshes) {
    std::vector<std::uint32_t> ids; for (auto mesh : meshes) ids.push_back(mesh.value);
    group_events.push_back(std::move(ids));
}
${contexts.map((context, index) => `namespace variant_${index} { ${lowerPbrMaterialGroups(context)} }`).join("\n")}
void check(const nlohmann::json& row) {
    Engine engine;
    engine.materials.resize(7);
    engine.materials[0].source_pbr_group_builder = true;
    engine.materials[1].source_pbr_group_builder = true;
    engine.materials[1].source_gamma_albedo = true;
    for (std::size_t i = 2; i < 6; ++i) engine.materials[i].source_group_builder = static_cast<std::uint64_t>(i);
    engine.materials[6] = engine.materials[4];
    const auto& input = row.at("input");
    for (const auto& value : input.at("materials")) engine.meshes.emplace_back().material = MaterialHandle{static_cast<std::uint32_t>(value.get<int>())};
    Scene scene; scene.engine = &engine; group_events.clear();
    const std::array queue{${contexts.map((_, index) => `variant_${index}::queue_pbr_material_group`).join(", ")}};
    const std::array prepare{${contexts.map((_, index) => `variant_${index}::prepare_pbr_scene_build`).join(", ")}};
    const std::array finish{${contexts.map((_, index) => `variant_${index}::finish_pbr_scene_build`).join(", ")}};
    const std::array drain{${contexts.map((_, index) => `variant_${index}::process_pbr_material_swaps`).join(", ")}};
    const std::array rebuild{${contexts.map((_, index) => `variant_${index}::rebuild_pbr_material_group`).join(", ")}};
    const auto variant = row.at("variant").get<std::size_t>();
    fixture_rebuild = rebuild[variant];
    std::vector<bool> failures;
    std::vector<std::uint64_t> scheduled_nodes;
    for (const auto& operation : input.at("operations")) {
        try {
            const auto op = operation.at(0).get<std::string>();
            const MeshHandle mesh{operation.size() > 1 ? operation.at(1).get<std::uint32_t>() : 0};
            if (op == "add") {
                scene.meshes.push_back(mesh); queue[variant](scene, mesh);
                const auto material = engine.meshes.at(mesh.value).material;
                const auto key = material.value < engine.materials.size() ? engine.materials[material.value].source_group_builder : 0;
                if (key >= 4 && !scene.state->material_groups_built && std::find(scheduled_nodes.begin(), scheduled_nodes.end(), key) == scheduled_nodes.end()) {
                    scheduled_nodes.push_back(key);
                    scene.deferred_builders.emplace_back([&scene, material] {scene.state->complete_material_group(scene, material);});
                }
            }
            if (op == "thin") engine.meshes.at(mesh.value).source_runtime_thin_builder = true;
            if (op == "remove") {
                auto found = std::find_if(scene.meshes.begin(), scene.meshes.end(), [mesh](auto item) {return item.value == mesh.value;});
                if (found != scene.meshes.end()) scene.meshes.erase(found);
            }
            if (op == "swap") {
                const MaterialHandle material{static_cast<std::uint32_t>(operation.at(2).get<int>())};
                if (engine.meshes.at(mesh.value).material.value != material.value) {
                    engine.meshes.at(mesh.value).material = material;
                    if (scene.state->enqueue_material_group) scene.state->enqueue_material_group(scene, mesh);
                }
            }
            if (op == "build") {
                prepare[variant](scene);
                while (!scene.deferred_builders.empty()) {
                    auto builders = std::move(scene.deferred_builders); scene.deferred_builders.clear();
                    for (const auto& builder : builders) builder();
                }
                finish[variant](scene);
            }
            if (op == "drain") {
                drain[variant](scene);
                if (engine.drain_material_jobs) engine.drain_material_jobs(engine);
            }
            if (op == "rebuild") rebuild[variant](scene, false, true);
            failures.push_back(false);
        } catch (const std::exception&) { failures.push_back(true); }
    }
    const auto& group = scene.state->pbr_material_group;
    std::vector<std::uint32_t> members, queued;
    if (group) for (auto mesh : group->meshes) members.push_back(mesh.value);
    for (auto mesh : scene.state->pbr_material_swap_queue) queued.push_back(mesh.value);
    nlohmann::json groups = nlohmann::json::array();
    if (scene.state->source_material_groups) for (const auto& [key, value] : *scene.state->source_material_groups) {
        std::vector<std::uint32_t> ids; for (auto mesh : value->meshes) ids.push_back(mesh.value);
        groups.push_back(nlohmann::json::array({key, ids, value->rebuild_ready}));
    }
    const nlohmann::json actual{{"events", group_events}, {"failures", failures}, {"members", members},
        {"ready", group && group->rebuild_ready}, {"invalidates", group && group->gamma_invalidates},
        {"queue", queued}, {"built", scene.state->material_groups_built}, {"groups", groups}};
    if (actual != row.at("expected")) throw std::runtime_error(row.dump() + "\\nactual=" + actual.dump());
}
}
int main() {try {nlohmann::json rows; std::ifstream("cases.json") >> rows; for (const auto& row : rows) bbl::check(row);}
    catch (const std::exception& error) {std::cerr << error.what(); return 1;}}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("PBR group lowering refuses unrepresented membership and dispatch changes", () => {
    const context = new LoweringContext();
    assert.equal(materialGroupIdentity(context, "standard"), "2");
    assert.equal(materialGroupIdentity(context, "shader"), "3");
    assert.match(materialGroupIdentity(context, "node"), /engine.materials.size/);
    assert.throws(() => materialGroupIdentity(doctoredContext("src/material/standard/standard-group-builder.ts",
        "return (_standardGroupBuilder = builder)", "return builder"), "standard"), /singleton lifetime|changed/);
    assert.throws(() => lowerPbrMaterialGroups(doctoredContext(sceneModule,
        "group.push(mesh)", "group.unshift(mesh)")), /Unsupported|Expected/);
    assert.throws(() => lowerPbrMaterialGroups(doctoredContext("src/scene/scene-runtime-mesh-build.ts",
        "chain = A(scene, pair ? entry[1] : mesh.material, mesh, chain)",
        "chain = A(scene, pair ? entry[1] : mesh.material, otherMesh, chain)")), /dispatch order|changed/);
});
