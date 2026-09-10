import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerPbrSceneHookRegistry} from "../src/lowering/pbr-scene-hooks.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const rebuildModule = "src/scene/scene-rebuild.ts", transmissionModule = "src/frame-graph/transmission.ts";
interface Scenario {mode: "direct" | "success" | "throw" | "dispose"; selected: boolean; enabled: boolean}

/** Execute the complete rebuild core, with inert GPU resources and recorded task activation. */
function sourceOracle(context: LoweringContext): (input: Scenario) => Promise<unknown> {
    const declaration = (module: string, name: string) =>
        context.functionDeclaration(module, name).declaration.getText().replace(/^export /, "");
    const rebuild = context.sourceFile(rebuildModule).statements.filter(node => !ts.isImportDeclaration(node))
        .map(node => node.getText().replace(/^export /, "")).join("\n");
    const source = transpileCommonJs(`
        const _lateCleanup = undefined;
        const require = () => ({X});
        ${declaration("src/scene/scene-runtime-mesh-build.ts", "X")}
        function installRuntimeBuilds(scene) {
            return scene._runtimeBuilds = {exclusive: (_builder, work) => work(), wait: async () => {},
                base: (_builder, rebuild) => rebuild, reset() {}, dropBase() {},
                holdPendingDisposers() {}, releasePendingDisposers() {}, _d: () => false};
        }
        const retireGpuResources = (_engine, callback) => callback();
        const _registerPbrExt = () => {}, makeRefractionRttExt = () => ({}), _dispersionSampleWgsl = undefined;
        ${rebuild}
        ${["_t", "markPbrMaterialsLinear", "enableSceneTransmission"].map(name => declaration(transmissionModule, name)).join("\n")}
        ${declaration("src/material/pbr/pbr-transmission-ext.ts", "registerPbrTransmission")}
        function enableSceneTransmissionTasks(scene) {
            scene.events.push("enable:" + !!scene._p);
            scene.enabled = true;
        }
        return async input => {
            const scene = {meshes: [], _groups: new Map(), _renderables: [], _uniformUpdaters: [],
                _disposables: [], _meshDisposables: new Map(), _frameGraph: {build() {}}, surface: {engine: {}},
                _built: true, events: [], enabled: input.enabled};
            const builder = Object.assign(async (scene, meshes) => {
                scene.events.push("begin:" + !!scene._p);
                registerPbrTransmission(scene, scene.surface.engine, meshes);
                scene.events.push("body:" + scene.enabled);
                if (input.mode === "throw") throw new Error("builder failure");
                if (input.mode === "dispose") scene._z = true;
                return {renderables: [], rebuildSingle: () => ({}), _G: false};
            }, {_materialFamily: "pbr"});
            const material = {_buildGroup: builder, _transmissive: input.selected, _subsurface: {refraction: {intensity: 1}}};
            const mesh = {material}; scene.meshes.push(mesh); scene._groups.set(builder, [mesh]);
            let failed = false;
            try {
                if (input.mode === "direct") await builder(scene, scene.meshes);
                else await rebuildSceneGroups(scene, "pbr", true);
            } catch (error) { if (error.message !== "builder failure") throw error; failed = true; }
            return {events: scene.events, enabled: scene.enabled, receiver: !!scene._p, failed};
        };`, rebuildModule);
    return new Function(source)() as (input: Scenario) => Promise<unknown>;
}

test("transmission transactions match source rebuild success, failure, disposal and receiver fallback", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) {t.skip("Native fixture compiler unavailable."); return;}
    const original = new LoweringContext();
    const receiver = original.findNodes(original.sourceFile(rebuildModule), (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) && original.expressionMatchesShape(node.left, "ctx._p"))[0]!;
    const returned = original.functionDeclaration(transmissionModule, "_t").declaration.body!.statements.at(-1)!;
    assert.ok(ts.isReturnStatement(returned) && returned.expression && ts.isArrayLiteralExpression(returned.expression));
    const tuple = returned.expression;
    const contexts = [original,
        doctoredContext(rebuildModule, receiver.right.getText(), receiver.right.getText().replace("return true", "return false")),
        doctoredContext(transmissionModule, tuple.getText(), `[${tuple.elements.map(node => node.getText()).reverse().join(",")} ]`)];
    const inputs: Scenario[] = [];
    for (const mode of ["direct", "success", "throw", "dispose"] as const)
        for (const selected of [false, true]) for (const enabled of [false, true]) inputs.push({mode, selected, enabled});
    const cases = [];
    for (const [variant, context] of contexts.entries()) {
        const oracle = sourceOracle(context);
        for (const input of inputs) cases.push({variant, input, expected: await oracle(input)});
    }
    assert.notDeepEqual(cases.slice(0, inputs.length).map(row => row.expected), cases.slice(inputs.length, inputs.length * 2).map(row => row.expected));
    assert.notDeepEqual(cases.slice(0, inputs.length).map(row => row.expected), cases.slice(inputs.length * 2).map(row => row.expected));
    const directory = resolve("artifacts/test-pbr-transmission-transaction"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <iostream>
namespace bbl {
std::vector<std::string> events;
std::string mode;
std::string flag(bool value) { return value ? "true" : "false"; }
void enable_scene_transmission(Scene& scene) {
    events.push_back("enable:" + flag(bool(scene.state->pbr_transmission_transaction)));
    scene.transmission_enabled = true;
}
${contexts.map((context, index) => `namespace variant_${index} {
${lowerPbrSceneHookRegistry(context)}
bool build(Scene& scene, const std::vector<MeshHandle>& meshes) {
    events.push_back("begin:" + flag(bool(scene.state->pbr_transmission_transaction)));
    register_pbr_transmission(scene, *scene.engine, meshes);
    events.push_back("body:" + flag(scene.transmission_enabled));
    if (mode == "throw") throw std::runtime_error("builder failure");
    if (mode == "dispose") scene.disposed = true;
    return false;
}
void run(Scene& scene) {
    if (mode == "direct") build(scene, scene.meshes);
    else run_pbr_rebuild_transaction_impl(scene, scene.meshes, build);
}
}`).join("\n")}
void check(const nlohmann::json& row) {
    events.clear(); const auto& input = row.at("input"); mode = input.at("mode").get<std::string>();
    Engine engine; Scene scene; scene.engine = &engine; scene.transmission_enabled = input.at("enabled").get<bool>();
    auto& material = engine.materials.emplace_back();
    material.source_transmissive = input.at("selected").get<bool>(); material.source_refraction_intensity = 1.0;
    engine.meshes.emplace_back().material = MaterialHandle{0}; scene.meshes.push_back(MeshHandle{0});
    bool failed = false;
    const std::array run{${contexts.map((_, index) => `variant_${index}::run`).join(", ")}};
    try { run.at(row.at("variant").get<std::size_t>())(scene); }
    catch (const std::runtime_error& error) { assert(std::string(error.what()) == "builder failure"); failed = true; }
    const nlohmann::json actual{{"events", events}, {"enabled", scene.transmission_enabled},
        {"receiver", bool(scene.state->pbr_transmission_transaction)}, {"failed", failed}};
    if (actual != row.at("expected")) std::cerr << row.dump() << " actual=" << actual.dump() << '\\n';
    assert(actual == row.at("expected"));
}
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases; for (const auto& row : cases) bbl::check(row); }
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("transmission specialization refuses runtime state outside the precomposed material cache", () => {
    for (const context of [
        doctoredContext(transmissionModule, "mat._renderFeatures = features;", "mat.alpha = features;"),
        doctoredContext(transmissionModule, "() => enableSceneTransmissionTasks(scene, engine)", "() => enableSceneTransmissionTasks(otherScene, engine)"),
    ]) assert.throws(() => lowerPbrSceneHookRegistry(context), /specialization|rollback|commit|Expected/);
});
