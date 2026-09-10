import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerFlowGraphDisposal, lowerFlowGraphMembership, lowerGltfFlowGraphLifecycle} from "../src/lowering/gltf/flow-graph-lifecycle.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const sceneModule = "src/flow-graph/scene-flow-graph.ts";
const cleanupModule = "src/loader-gltf/gltf-scene-cleanup.ts";
const featureModule = "src/loader-gltf/gltf-feature-interactivity.ts";
interface Runtime {id: number}
interface Scene {
    _flowGraphs?: Runtime[]; _flowGraphTick?: () => void; _flowGraphDispose?: () => void;
    _beforeRender: Array<() => void>; _disposables: Array<() => void>;
    _flowGraphPointerRefresh: () => void;
}
interface Container {flowGraphRuntimes?: Promise<Runtime[]>; _sceneCleanups?: WeakMap<Scene, () => void>}

async function sourceResult(context: LoweringContext): Promise<object> {
    const events: string[] = []; let next = 0;
    const text = [
        ...["attachFlowGraph", "detachFlowGraph", "removeFlowGraphCoordinator", "runFlowGraphs"].map(name =>
            context.functionDeclaration(sceneModule, name).declaration.getText().replace(/^export /, "")),
        context.functionDeclaration(cleanupModule, "_registerAssetContainerSceneCleanup").declaration.getText().replace(/^export /, ""),
    ].join("\n");
    const functions = new Function("createFgRuntime", "sceneAnimationCaps", "flowGraphBus", "ensureFlowGraphCoordinator", "disposeFlowGraph",
        transpileCommonJs(text, sceneModule) + "\nreturn {runFlowGraphs, detachFlowGraph, _registerAssetContainerSceneCleanup};")(
        async (graph: {fail?: boolean}) => {
            if (graph.fail) throw new Error("construct");
            const runtime = {id: next++}; events.push(`c${runtime.id}`); return runtime;
        }, () => ({}), () => ({}), (scene: Scene) => {
            if (scene._flowGraphTick) return;
            scene._beforeRender.unshift(scene._flowGraphTick = () => {});
            scene._disposables.push(scene._flowGraphDispose = () => {});
        }, (runtime: Runtime) => events.push(`d${runtime.id}`)) as {
            runFlowGraphs(scene: Scene, loaded: object[]): Promise<Runtime[]>;
            detachFlowGraph(scene: Scene, runtime: Runtime): void;
            _registerAssetContainerSceneCleanup(container: Container, scene: Scene, cleanup: () => void): void;
        };
    const apply = context.methodDeclaration(featureModule, "feature.applyAsset");
    const setup = context.findNodes(apply.declaration, (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) && context.propertyName(node.name) === "_sceneSetup")[0]!;
    const callback = new Function("runFlowGraphs", "detachFlowGraph", "_registerAssetContainerSceneCleanup", "flowGraphs",
        transpileCommonJs(`const value = {${setup.getText()}};`, featureModule) + "\nreturn value._sceneSetup;")(
        functions.runFlowGraphs, functions.detachFlowGraph, functions._registerAssetContainerSceneCleanup,
        [{graph: {}, accessors: {}}]) as (scene: Scene, container: Container) => void;
    const scene = (): Scene => {
        const result: Scene = {_beforeRender: [], _disposables: [], _flowGraphPointerRefresh: () => events.push(`p${result._flowGraphs?.length ?? 0}`)};
        return result;
    };
    const first = scene(), second = scene(), container: Container = {};
    for (const target of [first, first, second]) { callback(target, container); await container.flowGraphRuntimes; }
    const slots = [first._disposables.length, second._disposables.length];
    container._sceneCleanups!.get(first)!();
    container._sceneCleanups!.get(second)!();
    const remaining = [first._flowGraphs!.length, second._flowGraphs!.length, first._beforeRender.length, second._beforeRender.length];
    const published = (await container.flowGraphRuntimes)!.map(runtime => runtime.id);
    await assert.rejects(functions.runFlowGraphs(first, [{graph: {}, accessors: {}}, {graph: {}, accessors: {}}, {graph: {fail: true}, accessors: {}}]), /construct/);
    return {events, slots, remaining, published, rollback: first._flowGraphs!.length};
}

test("source lifecycle matches native publication, repeated attachment, scene cleanup and reverse rollback", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext()];
    const baseline = contexts[0]!;
    const cleanup = baseline.sourceFile(cleanupModule).text;
    contexts[1] = doctoredContext(cleanupModule, cleanup, cleanup.replace(/previous\(\);(\s*)cleanup\(\);/, "cleanup();$1previous();"));
    const cases = await Promise.all(contexts.map(sourceResult));
    assert.notDeepEqual(cases[0], cases[1]);
    const directory = resolve("artifacts/test-gltf-flow-graph-lifecycle"); mkdirSync(directory, {recursive: true});
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    writeFileSync(file, `#include <bblite/js_callback.hpp>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
namespace js = bbl::js;
std::vector<std::string> events;
int next_id = 0;
struct FlowGraphRuntime { int id; void dispose() { events.push_back("d" + std::to_string(id)); } };
struct Engine;
struct AssetHandle { std::size_t value = 0; };
struct SceneState {
    Engine* engine;
    std::vector<std::shared_ptr<FlowGraphRuntime>> flow_graphs;
    js::Callback<void(float)> flow_graph_tick;
    js::Callback<void()> flow_graph_dispose;
    bool flow_graph_pointer_refresh = true;
    std::vector<js::Callback<void(float)>> before_render;
    std::vector<js::Callback<void()>> disposables;
};
struct AssetRecord {
    std::map<std::weak_ptr<SceneState>, js::Callback<void()>, std::owner_less<std::weak_ptr<SceneState>>> scene_cleanups;
    std::vector<std::shared_ptr<FlowGraphRuntime>> flow_graph_runtimes;
};
struct Engine { std::vector<AssetRecord> assets{1}; };
struct Scene {
    std::shared_ptr<SceneState> state; Engine* engine;
    std::vector<js::Callback<void(float)>>& before_render;
    std::vector<js::Callback<void()>>& disposables;
    explicit Scene(std::shared_ptr<SceneState> shared) : state(shared), engine(shared->engine), before_render(shared->before_render), disposables(shared->disposables) {}
    static Scene from_state(std::shared_ptr<SceneState> shared) { return Scene(shared); }
};
std::shared_ptr<FlowGraphRuntime> make_runtime(Engine&, AssetHandle) {
    const auto runtime = std::make_shared<FlowGraphRuntime>(FlowGraphRuntime{next_id++});
    events.push_back("c" + std::to_string(runtime->id)); return runtime;
}
std::shared_ptr<FlowGraphRuntime> fail_runtime(Engine&, AssetHandle) { throw std::runtime_error("construct"); }
${contexts.map((context, index) => `namespace variant_${index} {
${lowerFlowGraphMembership(context)}
${lowerGltfFlowGraphLifecycle(context)}
void ensure_flow_graph_coordinator(Scene& scene) {
    if (scene.state->flow_graph_tick) return;
    scene.state->flow_graph_tick = [](float) {};
    scene.state->flow_graph_dispose = [] {};
    scene.before_render.insert(scene.before_render.begin(), scene.state->flow_graph_tick);
    scene.disposables.push_back(scene.state->flow_graph_dispose);
}
void refresh_flow_graph_pointer_picking(Scene& scene) { events.push_back("p" + std::to_string(scene.state->flow_graphs.size())); }
nlohmann::json check() {
    events.clear(); next_id = 0; Engine engine;
    const auto create_scene = [&] { auto state = std::make_shared<SceneState>(); state->engine = &engine; return Scene(state); };
    auto first = create_scene(), second = create_scene();
    for (Scene* scene : {&first, &first, &second}) setup_flow_graphs(*scene, {}, {make_runtime});
    const nlohmann::json slots{first.disposables.size(), second.disposables.size()};
    const auto first_cleanup = engine.assets[0].scene_cleanups.at(first.state); first_cleanup();
    const auto second_cleanup = engine.assets[0].scene_cleanups.at(second.state); second_cleanup();
    const nlohmann::json remaining{first.state->flow_graphs.size(), second.state->flow_graphs.size(), first.before_render.size(), second.before_render.size()};
    std::vector<int> published; for (const auto& runtime : engine.assets[0].flow_graph_runtimes) published.push_back(runtime->id);
    try { run_flow_graphs(first, {}, {make_runtime, make_runtime, fail_runtime}); assert(false); }
    catch (const std::runtime_error& error) { assert(std::string(error.what()) == "construct"); }
    return {{"events", events}, {"slots", slots}, {"remaining", remaining}, {"published", published}, {"rollback", first.state->flow_graphs.size()}};
}
}`).join("\n")}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases;
${contexts.map((_, index) => `    assert(variant_${index}::check() == cases.at(${index}));`).join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("source disposal clears transport slots without resetting authored variables", () => {
    const context = new LoweringContext();
    const output = lowerFlowGraphDisposal(context, ["slot_a", "slot_b"]);
    assert.match(output, /state\.slot_a = \{\};[\s\S]*state\.slot_b = \{\};[\s\S]*started = false/);
    assert.throws(() => lowerGltfFlowGraphLifecycle(doctoredContext(featureModule,
        "runFlowGraphs(scene, flowGraphs, container.animationGroups)", "runFlowGraphs(scene, flowGraphs, [])")), /shape|boundary|changed/);
});
