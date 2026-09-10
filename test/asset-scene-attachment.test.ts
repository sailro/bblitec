import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {SceneLowerer} from "../src/lowering/scene-lowerer.js";
import {lowerAssetSceneAttachment} from "../src/lowering/asset-scene-attachment.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/scene/scene-core.ts";
interface Scenario {camera: boolean; color: boolean; existingCamera: boolean; groups: number[]; repeat: number; failSetup?: boolean; failMesh?: boolean}
const scenarios: Scenario[] = [
    {camera: true, color: true, existingCamera: true, groups: [2, 0], repeat: 2},
    {camera: true, color: true, existingCamera: false, groups: [1], repeat: 1},
    {camera: false, color: false, existingCamera: true, groups: [], repeat: 1},
    {camera: true, color: true, existingCamera: false, groups: [], repeat: 1, failSetup: true},
    {camera: true, color: true, existingCamera: false, groups: [0], repeat: 1, failMesh: true},
];

function sourceResult(context: LoweringContext, input: Scenario): object {
    const declaration = context.functionDeclaration(module, "addToScene").declaration;
    const code = transpileCommonJs(declaration.getText().replace("export ", "") + "\nreturn addToScene;", module);
    const attach = new Function("registerMeshScene", "tickAnimation", code)(() => {
        if (input.failMesh) throw new Error("mesh");
    }, () => {}) as (scene: object, container: object) => void;
    const scene = {surface: {engine: {}}, meshes: [] as object[], lights: [] as object[],
        camera: input.existingCamera ? {id: 8} : undefined, clearColor: {r: 7},
        animationGroups: [] as number[], _beforeRender: [() => {}]};
    const events: object[] = [];
    const snapshot = () => ({camera: scene.camera?.id ?? -1, color: scene.clearColor.r,
        meshes: scene.meshes.length, lights: scene.lights.length, groups: [...scene.animationGroups], callbacks: scene._beforeRender.length});
    const container: {entities: object[]; camera?: object; clearColor?: object; animationGroups?: number[];
        _beforeRenderHook?: () => void; _sceneSetup: (scene: object, container: object) => void} = {
        entities: [{_gpu: {}, material: undefined}, {lightType: "point"}],
        ...(input.camera ? {camera: {id: 3}} : {}), ...(input.color ? {clearColor: {r: 4}} : {}),
        animationGroups: input.groups,
        _sceneSetup(target, supplied) {
            assert.equal(target, scene); assert.equal(supplied, container);
            events.push(snapshot());
            scene.clearColor = {r: 9};
            if (input.failSetup) throw new Error("setup");
        },
    };
    let failed = false, previous: (() => void) | undefined;
    for (let i = 0; i < input.repeat; i++) {
        const callbacks = scene._beforeRender.length;
        try { attach(scene, container); } catch (error) {
            if (!(error instanceof Error) || !["mesh", "setup"].includes(error.message)) throw error;
            failed = true;
        }
        if (scene._beforeRender.length > callbacks) {
            assert.equal(container._beforeRenderHook, scene._beforeRender.at(-1));
            assert.notEqual(container._beforeRenderHook, previous);
            previous = container._beforeRenderHook;
        }
    }
    return {events, final: snapshot(), failed};
}

test("native container attachment follows source guards, order, repeated hooks and partial failure state", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const base = new LoweringContext();
    const source = base.functionDeclaration(module, "addToScene").declaration.getText();
    const moved = source.replace("        result._sceneSetup?.(ctx, result);", "")
        .replace("        if (result.clearColor)", "        result._sceneSetup?.(ctx, result);\n        if (result.clearColor)");
    const contexts = [base, doctoredContext(module, source, moved),
        doctoredContext(module, "result.camera && !ctx.camera", "result.camera"),
        doctoredContext(module, "if (result.animationGroups?.length)", "if (false && result.animationGroups?.length)")];
    const directory = resolve("artifacts/test-asset-scene-attachment"); mkdirSync(directory, {recursive: true});
    const cases = contexts.flatMap((context, variant) => scenarios.map(input => ({variant, input, expected: sourceResult(context, input)})));
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const sceneSource = new SceneLowerer(base).lowerCore().source;
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
namespace bbl {
bool fail_mesh = false;
void add_to_scene(Scene& scene, MeshHandle mesh) { if (fail_mesh) throw std::runtime_error("mesh"); scene.meshes.push_back(mesh); }
void add_to_scene(Scene& scene, LightHandle light) { scene.lights.push_back(light); }
${["void require_scene_engine(", "AssetRecord& asset_record(", "void add_asset_meshes("].map(signature => cppFunction(sceneSource, signature)).join("\n")}
${contexts.map((context, variant) => {
        const emitted = cppFunction(new SceneLowerer(context).lowerCore().source, "void add_to_scene(Scene& scene, AssetHandle asset)");
        return emitted.replace("void add_to_scene(", `void attach_${variant}(`);
    }).join("\n")}
nlohmann::json snapshot(const Scene& scene) {
    std::vector<std::uint32_t> groups;
    for (const auto group : scene.animation_groups) groups.push_back(group.value);
    return {{"camera", scene.camera.value == invalid_handle ? -1 : static_cast<int>(scene.camera.value)},
        {"color", scene.clear_color.r}, {"meshes", scene.meshes.size()}, {"lights", scene.lights.size()},
        {"groups", groups}, {"callbacks", scene.before_render.size()}};
}
void check(const nlohmann::json& test_case) {
    const auto& input = test_case.at("input"); const auto variant = test_case.at("variant").get<std::size_t>();
    Engine engine; Scene scene; scene.engine = &engine;
    if (input.at("existingCamera").get<bool>()) scene.camera = CameraHandle{8};
    scene.clear_color.r = 7; scene.before_render.push_back([](float) {});
    engine.assets.emplace_back(); auto& record = engine.assets.back();
    record.meshes = {MeshHandle{0}}; record.lights = {LightHandle{0}};
    record.has_camera = input.at("camera").get<bool>(); record.camera = CameraHandle{3};
    record.has_clear_color = input.at("color").get<bool>(); record.clear_color.r = 4;
    for (const auto& group : input.at("groups")) record.animation_groups.push_back(AnimationGroupHandle{group.get<std::uint32_t>()});
    record.animation_tick = [](float) {};
    record.animation_seek = [](float) {};
    nlohmann::json events = nlohmann::json::array();
    record.scene_setup = [&](Scene& target) {
        assert(&target == &scene); events.push_back(snapshot(target)); target.clear_color.r = 9;
        if (input.value("failSetup", false)) throw std::runtime_error("setup");
    };
    fail_mesh = input.value("failMesh", false);
    bool failed = false; std::size_t previous = 0;
    const std::array attach{attach_0, attach_1, attach_2, attach_3};
    for (std::size_t i = 0; i < input.at("repeat").get<std::size_t>(); ++i) {
        const auto callbacks = scene.before_render.size();
        try { attach.at(variant)(scene, AssetHandle{0}); }
        catch (const std::runtime_error& error) {
            assert(std::string(error.what()) == "mesh" || std::string(error.what()) == "setup"); failed = true;
        }
        if (scene.before_render.size() > callbacks) {
            assert(record.before_render_hook.identity() == scene.before_render[scene.before_render.size() - 1].identity());
            assert(record.before_render_hook.identity() != previous); previous = record.before_render_hook.identity();
        }
    }
    assert(scene.animation_seekers.size() == (failed ? 0 : input.at("repeat").get<std::size_t>()));
    const nlohmann::json actual{{"events", events}, {"final", snapshot(scene)}, {"failed", failed}};
    assert(actual == test_case.at("expected"));
}
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases; for (const auto& value : cases) bbl::check(value); }
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("container attachment refuses unrepresented fields and changes inside the remaining playback adapter", () => {
    for (const [before, after] of [
        ["tickAnimation(g, deltaMs, engine);", "tickAnimation(g, deltaMs * 2, engine);"],
        ["ctx.clearColor = result.clearColor;", "ctx.unknown = result.clearColor;"],
        ["result._sceneSetup?.(ctx, result);", "result._sceneSetup?.(ctx, {});"],
    ]) assert.throws(() => lowerAssetSceneAttachment(doctoredContext(module, before!, after!)), /Unrepresented|Unsupported|Expected|Cannot|supported|changed/);
});
