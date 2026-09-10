import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerPbrSceneHookRegistry, lowerPbrTransmissionSelection} from "../src/lowering/pbr-scene-hooks.js";
import {lowerGltfMaterialObjectFunction} from "../src/lowering/gltf/material-object-lowerer.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const transmissionModule = "src/material/pbr/pbr-transmission-ext.ts";
const flagsModule = "src/material/pbr/pbr-flags.ts";
interface Material {transmissive: boolean; intensity?: number}
interface Scenario {materials: (Material | null)[]; meshes: number[]}
const scenarios: Scenario[] = [
    {materials: [], meshes: []},
    {materials: [null], meshes: [0]},
    {materials: [{transmissive: true}], meshes: [0]},
    {materials: [{transmissive: false, intensity: 1}], meshes: [0]},
    ...[-1, 0, 0.25, 1, 1e-100].map(intensity => ({materials: [{transmissive: true, intensity}], meshes: [0]})),
    {materials: [{transmissive: true, intensity: 1}, {transmissive: false}], meshes: [1]},
    {materials: [{transmissive: false}, {transmissive: true, intensity: 1}], meshes: [0, 1]},
    {materials: [{transmissive: true, intensity: 1}], meshes: [0, -1]},
    {materials: [{transmissive: true, intensity: 1}], meshes: [-1, 0]},
];

function selectionOracle(context: LoweringContext): (input: Scenario) => object {
    const declaration = context.functionDeclaration(transmissionModule, "registerPbrTransmission").declaration;
    const code = transpileCommonJs(declaration.getText().replace("export ", "") + "\nreturn registerPbrTransmission;", transmissionModule);
    return input => {
        let selected = false, failed = false;
        const execute = new Function("enableSceneTransmission", "_registerPbrExt", "makeRefractionRttExt", "_dispersionSampleWgsl", code)(
            () => { selected = true; }, () => {}, () => ({}), undefined) as (scene: object, engine: object, meshes: unknown[]) => void;
        const materials = input.materials.map(material => material && ({_transmissive: material.transmissive,
            _subsurface: {refraction: {intensity: material.intensity}}}));
        const meshes = input.meshes.map(index => index < 0 ? undefined : {material: materials[index]});
        try { execute({}, {}, meshes); } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            failed = true;
        }
        return {selected, failed};
    };
}

async function registryOracle(context: LoweringContext, fail: boolean): Promise<object> {
    const registry = ["_registerPbrSceneHook", "_getPbrSceneHooks"].map(name =>
        context.functionDeclaration(flagsModule, name).declaration.getText().replace("export ", "")).join("\n");
    const builder = context.functionDeclaration("src/material/pbr/pbr-renderable.ts", "buildPbrRenderables").declaration;
    const loop = builder.body!.statements.find(statement => ts.isForOfStatement(statement) &&
        context.expressionMatchesShape(statement.expression, "_getPbrSceneHooks()"))!;
    const code = transpileCommonJs(`let _pbrSceneHooks = null;\n${registry}
        async function run(scene, engine, meshes) { ${loop.getText()} }
        return {register: _registerPbrSceneHook, get: _getPbrSceneHooks, run};`, flagsModule);
    type Hook = () => void;
    const executed = new Function(code)() as {register(hook: Hook): void; get(): Iterable<Hook>; run(...args: object[]): Promise<void>};
    const empty = executed.get(), events: string[] = [];
    const c = () => { events.push("c"); };
    const a = () => { events.push("a"); executed.register(c); };
    const b = () => { events.push("b"); if (fail) throw new Error("hook"); };
    executed.register(a); const live = executed.get();
    executed.register(a); executed.register(b);
    const failures: boolean[] = [];
    for (let i = 0; i < 2; i++) {
        try { await executed.run({}, {}, []); failures.push(false); }
        catch (error) { if (!(error instanceof Error) || error.message !== "hook") throw error; failures.push(true); }
    }
    return {events, failures, empty: [...empty].length, live: [...live].length};
}

test("native PBR hook registry and transmission selection agree with source execution", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(transmissionModule, "?? 0) > 0", "?? 0.5) >= 0.5"),
        doctoredContext(transmissionModule, "let i = 0;", "let i = 1;"),
        doctoredContext(transmissionModule, "!!mat?._transmissive", "!mat?._transmissive")];
    const cases = contexts.flatMap((context, variant) => {
        const oracle = selectionOracle(context);
        return scenarios.map(input => ({variant, input, expected: oracle(input)}));
    });
    const registryCases = await Promise.all([false, true].map(async fail => ({fail, expected: await registryOracle(contexts[0]!, fail)})));
    const directory = resolve("artifacts/test-pbr-scene-hooks"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify({selection: cases, registry: registryCases}));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <iostream>
namespace bbl {
void enable_scene_transmission(Scene& scene) { scene.transmission_enabled = true; }
${lowerPbrSceneHookRegistry(contexts[0]!)}
${contexts.map((context, index) => `namespace variant_${index} { ${lowerPbrTransmissionSelection(context)} }`).join("\n")}
void selection_check(const nlohmann::json& row) {
    Engine engine; const auto& input = row.at("input");
    for (const auto& value : input.at("materials")) {
        auto& record = engine.materials.emplace_back();
        if (!value.is_null()) {
            record.source_transmissive = value.at("transmissive").get<bool>();
            if (value.contains("intensity")) record.source_refraction_intensity = value.at("intensity").get<double>();
        }
        engine.meshes.emplace_back().material = value.is_null() ? MaterialHandle{} : MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
    }
    std::vector<MeshHandle> meshes;
    for (const auto& index : input.at("meshes")) meshes.push_back(MeshHandle{static_cast<std::uint32_t>(index.get<int>())});
    const std::array select{${contexts.map((_, index) => `variant_${index}::pbr_group_has_transmission`).join(", ")}};
    bool selected = false, failed = false;
    try { selected = select.at(row.at("variant").get<std::size_t>())(engine, meshes); }
    catch (const std::out_of_range&) { failed = true; }
    catch (const std::runtime_error& error) { assert(std::string(error.what()) == "Cannot read refraction from a null material."); failed = true; }
    const nlohmann::json actual{{"selected", selected}, {"failed", failed}};
    if (actual != row.at("expected")) std::cerr << row.dump() << " actual=" << actual.dump() << '\\n';
    assert(actual == row.at("expected"));
}
std::vector<std::string> events;
bool fail_hook = false;
void c(Scene&, Engine&, const std::vector<MeshHandle>&) { events.push_back("c"); }
void a(Scene&, Engine&, const std::vector<MeshHandle>&) { events.push_back("a"); register_pbr_scene_hook(c); }
void b(Scene&, Engine&, const std::vector<MeshHandle>&) { events.push_back("b"); if (fail_hook) throw std::runtime_error("hook"); }
void registry_check(const nlohmann::json& row) {
    pbr_scene_hooks.reset(); events.clear(); fail_hook = row.at("fail").get<bool>();
    Engine engine; Scene scene; scene.engine = &engine;
    const auto empty = get_pbr_scene_hooks();
    register_pbr_scene_hook(a); const auto live = get_pbr_scene_hooks();
    register_pbr_scene_hook(a); register_pbr_scene_hook(b);
    std::vector<bool> failures;
    for (int i = 0; i < 2; ++i) {
        try { run_pbr_scene_hooks_impl(scene, {}); failures.push_back(false); }
        catch (const std::runtime_error& error) { assert(std::string(error.what()) == "hook"); failures.push_back(true); }
    }
    const nlohmann::json actual{{"events", events}, {"failures", failures}, {"empty", empty.size()}, {"live", live.size()}};
    assert(actual == row.at("expected"));
    pbr_scene_hooks.reset(); register_pbr_scene_hook(register_pbr_transmission);
    engine.materials.emplace_back().source_transmissive = true; engine.materials[0].source_refraction_intensity = 1e-100;
    engine.meshes.emplace_back().material = MaterialHandle{0};
    run_pbr_scene_hooks_impl(scene, {}); assert(!scene.transmission_enabled);
    run_pbr_scene_hooks_impl(scene, {MeshHandle{0}}); assert(scene.transmission_enabled);
}
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases;
    for (const auto& row : cases.at("selection")) bbl::selection_check(row);
    for (const auto& row : cases.at("registry")) bbl::registry_check(row);
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("PBR hook lowering refuses unrepresented activation, material reads and registrations", () => {
    for (const [before, after] of [
        ["enableSceneTransmission(scene, engine)", "enableSceneTransmission(scene, otherEngine)"],
        ["mat?._transmissive", "mat?._unrepresented"],
        ["_registerPbrExt(makeRefractionRttExt(_dispersionSampleWgsl));", ""],
    ]) assert.throws(() => lowerPbrTransmissionSelection(doctoredContext(transmissionModule, before!, after!)), /adapter|Unsupported|Expected|changed/);
    const module = "src/material/pbr/set-transmission.ts", name = "setPbrTransmission";
    const context = doctoredContext(module, "_registerPbrSceneHook(registerPbrTransmission)", "_registerPbrSceneHook(unknownHook)");
    assert.throws(() => lowerGltfMaterialObjectFunction(context,
        {module, name, cpp: name, declaration: context.functionDeclaration(module, name).declaration}, () => undefined), /registration/);
});
