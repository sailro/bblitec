import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAssetSceneSetup, gltfAssetSceneSetupOrder} from "../src/lowering/gltf/asset-scene-setup.js";
import {javascriptModuleUrl} from "../src/data-url.js";
import {pinnedModuleTextUrl} from "../src/pinned-shader-composer.js";
import {transpileCommonJs, transpileForBrowser} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/loader-gltf/load-gltf.ts", registryModule = "src/loader-gltf/gltf-feature-registry.ts";
const featureModules = ["./gltf-feature-gaussian-splatting.js", "./gltf-ext-lights-image-based.js", "./gltf-feature-interactivity.js"];
const callbackNames = ["gaussian_splat_setup", "ibl_scene_setup", "interactivity_scene_setup"];
type Setup = (scene: {events: number[]}, target: object) => void;
interface Container {entities: object[]; _sceneSetup?: Setup}
interface Scenario {mask: number; existing: boolean; failure: number; repeatComposition: boolean}
type Fold = (container: Container, fragments: Array<{_sceneSetup: Setup | undefined}>) => void;

/** Execute the registry itself; only the three feature resource factories are stand-ins. */
async function sourceOrder(context: LoweringContext): Promise<number[]> {
    const redirects = new Map(featureModules.map((path, id) => [path, javascriptModuleUrl(`export default {id:${id}};`)]));
    const imported = await import(pinnedModuleTextUrl("loader-gltf/gltf-feature-registry.js",
        transpileForBrowser(context.sourceFile(registryModule).text, registryModule), [], redirects)) as {
        loadGltfFeatures(document: object): Promise<Array<{id: number}>>;
    };
    return (await imported.loadGltfFeatures({extensionsUsed: ["KHR_gaussian_splatting", "EXT_lights_image_based"],
        extensions: {KHR_interactivity: {graphs: []}}})).map(feature => feature.id);
}

function sourceFold(context: LoweringContext): Fold {
    const declaration = context.functionDeclaration(module, "loadGltf").declaration;
    const loop = declaration.body!.statements.find(statement => ts.isForOfStatement(statement) && statement.expression.getText() === "assetFragments");
    assert.ok(loop);
    return new Function("container", "assetFragments", transpileCommonJs(loop.getText(), module)) as Fold;
}

function sourceResult(fold: Fold, order: number[], input: Scenario): object {
    const scene = {events: [] as number[]}, container: Container = {entities: []};
    const hook = (id: number): Setup => {
        let count = 0;
        return (suppliedScene, suppliedTarget) => {
            assert.equal(suppliedScene, scene); assert.equal(suppliedTarget, container);
            scene.events.push(id * 100 + ++count);
            if (input.failure === id) throw new Error("setup");
        };
    };
    if (input.existing) container._sceneSetup = hook(3);
    const hooks = [0, 1, 2].map(id => input.mask & (1 << id) ? hook(id) : undefined);
    const fragments = order.map(id => ({_sceneSetup: hooks[id]}));
    fold(container, fragments);
    if (input.repeatComposition) fold(container, fragments);
    const present = !!container._sceneSetup;
    let failures = 0;
    for (let i = 0; i < 3; i++) {
        try { container._sceneSetup?.(scene, container); }
        catch (error) { if (!(error instanceof Error) || error.message !== "setup") throw error; failures++; }
    }
    return {events: scene.events, present, failures};
}

test("native feature composition matches source order, guards, exceptions and shared callback captures", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const base = new LoweringContext();
    const registry = base.sourceFile(registryModule).text;
    const reversed = registry.replace(featureModules[0]!, "__swap__").replace(featureModules[1]!, featureModules[0]!).replace("__swap__", featureModules[1]!);
    const contexts = [base, doctoredContext(registryModule, registry, reversed),
        doctoredContext(module, "prev?.(scene, target);\n                _sceneSetup(scene, target);",
            "_sceneSetup(scene, target);\n                prev?.(scene, target);"),
        doctoredContext(module, "if (_sceneSetup)", "if (false && _sceneSetup)")];
    const scenarios: Scenario[] = Array.from({length: 16}, (_, index) => ({mask: index % 8, existing: index >= 8, failure: -1, repeatComposition: true}));
    for (const failure of [0, 1, 2, 3]) scenarios.push({mask: 7, existing: true, failure, repeatComposition: false});
    const cases: Array<{variant: number; input: Scenario; expected: object}> = [];
    for (const [variant, context] of contexts.entries()) {
        const order = await sourceOrder(context);
        const fold = sourceFold(context);
        assert.deepEqual(gltfAssetSceneSetupOrder(context, true, true), order.map(id => callbackNames[id]));
        assert.deepEqual(gltfAssetSceneSetupOrder(context, false, false), ["ibl_scene_setup"]);
        cases.push(...scenarios.map(input => ({variant, input, expected: sourceResult(fold, order, input)})));
    }
    const directory = resolve("artifacts/test-gltf-asset-scene-setup"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
namespace bbl {
${contexts.map((context, index) => lowerGltfAssetSceneSetup(context).replace("compose_gltf_scene_setup(", `compose_${index}(`)).join("\n")}
void check(const nlohmann::json& row) {
    const auto& input = row.at("input");
    const int mask = input.at("mask"), failure = input.at("failure");
    Scene scene; AssetRecord container; std::vector<int> events;
    const auto hook = [&](int id) -> js::Callback<void(Scene&)> {
        return [&, id, count = 0](Scene& supplied) mutable {
            assert(&supplied == &scene); events.push_back(id * 100 + ++count);
            if (failure == id) throw std::runtime_error("setup");
        };
    };
    if (input.at("existing").get<bool>()) container.scene_setup = hook(3);
    const js::Callback<void(Scene&)> gaussian_splat_setup = mask & 1 ? hook(0) : nullptr;
    const js::Callback<void(Scene&)> ibl_scene_setup = mask & 2 ? hook(1) : nullptr;
    const js::Callback<void(Scene&)> interactivity_scene_setup = mask & 4 ? hook(2) : nullptr;
    const auto compose = [&] {
        switch (row.at("variant").get<int>()) {
${contexts.map((context, index) => `        case ${index}: compose_${index}(container, {${gltfAssetSceneSetupOrder(context, true, true).join(", ")}}); break;`).join("\n")}
        default: throw std::runtime_error("variant");
        }
    };
    compose(); if (input.at("repeatComposition").get<bool>()) compose();
    const bool present = static_cast<bool>(container.scene_setup); int failures = 0;
    for (int i = 0; i < 3; ++i) {
        try { if (container.scene_setup) container.scene_setup(scene); }
        catch (const std::runtime_error& error) { assert(std::string(error.what()) == "setup"); ++failures; }
    }
    const nlohmann::json actual{{"events", events}, {"present", present}, {"failures", failures}};
    assert(actual == row.at("expected"));
}
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases; for (const auto& row : cases) bbl::check(row); }
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("feature composition refuses unrepresented resource, target and registry sequencing changes", () => {
    for (const [before, after] of [
        ["_sceneSetup(scene, target);", "_sceneSetup(scene, {});"],
        ["void _ignored;", "container.extra = _ignored;"],
        ["Object.assign(container, rest);", "Object.assign(container, frag);"],
        ["const prev = container._sceneSetup;", "const prev = container.other;"],
        ["return container;", "container._sceneSetup = undefined; return container;"],
    ]) assert.throws(() => lowerGltfAssetSceneSetup(doctoredContext(module, before!, after!)), /Unrepresented|Unsupported|Expected|Cannot|supported|changed|lower|projection/);
    assert.throws(() => gltfAssetSceneSetupOrder(doctoredContext(registryModule,
        "return mods.map((m) => m.default);", "return mods.reverse().map((m) => m.default);"), true, true), /changed|shape|body/);
});
