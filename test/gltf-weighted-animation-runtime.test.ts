import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerPinnedBody} from "../src/lowering/pinned-body-lowerer.js";
import type {PinnedBinding} from "../src/lowering/pinned-numeric-lowerer.js";
import {pinnedNumericMathCalls} from "../src/lowering/pinned-operators.js";
import {lowerGltfAnimationPlayback} from "../src/lowering/gltf/animation-playback.js";
import {lowerGltfAnimationEvaluator} from "../src/lowering/gltf/animation-evaluator.js";
import {lowerGltfAnimationBoneOverrides} from "../src/lowering/gltf/animation-bone-overrides.js";
import {lowerGltfWeightedAnimationRuntime} from "../src/lowering/gltf/weighted-animation-runtime.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/animation/weighted-gltf-mixer.ts";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const inputs = {
    nodes: [
        {parentIdx: -1, tx: 1, ty: 2, tz: 3, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1},
        {parentIdx: 0, tx: 0, ty: 1, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1},
        {parentIdx: 0, tx: 9, ty: 8, tz: 7, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1, _matrix: [...identity.slice(0, 12), 5, 6, 7, 1]},
    ],
    samples: [
        {input: [0, 2], output: [2, 0, -1, 5, 2, 1], interpolation: 0},
        {input: [0, 2], output: [0, 0, 0, 1, 0, 0, 0.6, 0.8], interpolation: 0},
        {input: [0, 2], output: [1, 1, 1, 2, 3, 4], interpolation: 0},
        {input: [0, 2], output: [0, 0.6, 0, 0.8, 0, -0.6, 0, 0.8], interpolation: 0},
    ],
    channels: [
        {nodeIdx: 0, samplerIdx: 0, path: 0}, {nodeIdx: 0, samplerIdx: 1, path: 1}, {nodeIdx: 0, samplerIdx: 2, path: 2},
        {nodeIdx: 1, samplerIdx: 3, path: 1}, {nodeIdx: 1, samplerIdx: 2, path: 2}, {nodeIdx: 2, samplerIdx: 0, path: 0},
    ],
    names: ["hip", "hip", "hip", "child", "child", null],
};
type Target = {trs: Float32Array; localMat: Float32Array; worldMat: Float32Array; tWeight: Float32Array; rWeight: Float32Array; sWeight: Float32Array; baseRot?: Float32Array};
type Group = {currentTime: number; isPlaying: boolean; loopAnimation: boolean; speedRatio: number; weight: number; _additive?: {referenceTime: number};
    mask?: {names: string[]; mode: number; disabled: boolean}; targetedAnimations: Array<{targetName?: string}>};
const bits = (values: Float32Array) => [...new Uint32Array(values.buffer, values.byteOffset, values.length)];

function sourceResult(context: LoweringContext, overrides: boolean): unknown {
    const printer = ts.createPrinter();
    const text = (path: string) => {
        const file = context.sourceFile(path);
        return file.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement =>
            printer.printNode(ts.EmitHint.Unspecified, statement, file).replace(/^export /gm, "")).join("\n");
    };
    const events: unknown[] = [], palettes: number[][] = [];
    const types = context.sourceFile("src/animation/types.ts");
    const constantNames = ["PATH_TRANSLATION", "PATH_ROTATION", "PATH_SCALE", "INTERP_STEP", "INTERP_CUBICSPLINE"];
    const constants = constantNames.map(name => context.numericValue(ts.factory.createIdentifier(name), types));
    const body = text("src/animation/evaluate.ts") + "\n" + text(module) + "\n" +
        context.functionDeclaration("src/math/mat4-compose-into.ts", "mat4ComposeInto").declaration.getText().replace(/^export /, "") + "\n" +
        context.functionDeclaration("src/math/mat4-multiply-into.ts", "mat4MultiplyInto").declaration.getText().replace(/^export /, "") + "\n" +
        context.functionDeclaration("src/skeleton/bone-control.ts", "applyOverridesToTRS").declaration.getText() + `
const _boneApplier = (overrides, trs, count, hiddenOnly) => {
    events.push(["bones", !!hiddenOnly]); applyOverridesToTRS(overrides, trs, count, hiddenOnly);
};`;
    const runtime = new Function("F32", "I32", "U8", ...constantNames, "events",
        transpileCommonJs(body, module) + "\nreturn {getScratch, getTarget, resetWeightedGltfTarget, accumulateGroup, accumulateAdditiveGroup, advanceGroupTime, uploadTarget};")(
        Float32Array, Int32Array, Uint8Array, ...constants, events) as {
            getScratch(manager: object): unknown; getTarget(scratch: unknown, mixer: unknown[]): Target;
            resetWeightedGltfTarget(target: Target): void;
            accumulateGroup(manager: object, scratch: unknown, group: Group, mixer: unknown[], delta: number): void;
            advanceGroupTime(group: Group, mixer: unknown[], delta: number): number;
            accumulateAdditiveGroup(scratch: unknown, group: Group, mixer: unknown[]): void;
            uploadTarget(manager: object, target: Target): void;
        };
    const overrideMap = overrides ? new Map([[0, {mask: 2, rx: 0.6, ry: 0, rz: 0, rw: 0.8}], [1, {mask: 8}]]) : undefined;
    const skeletons = [false, true].map(disposed => ({boneCount: 3, jointNodes: [0, 1, 2], invMeshWorld: new Float32Array(identity),
        inverseBindMatrices: new Float32Array([...identity, ...identity, ...identity]), boneMatrices: new Float32Array(48),
        runtimeSkeleton: {_overrides: overrideMap, _disposed: disposed}, boneTexture: {}}));
    const nodes = inputs.nodes.map(node => ({...node, ...(node._matrix ? {_matrix: new Float32Array(node._matrix)} : {})}));
    const clip = {duration: 2, channels: inputs.channels, samplers: inputs.samples.map(sample => ({...sample, input: new Float32Array(sample.input), output: new Float32Array(sample.output)}))};
    const mixer = [clip, nodes, skeletons];
    const group = (weight: number): Group => ({currentTime: 0.25, isPlaying: true, loopAnimation: true, speedRatio: 1, weight,
        targetedAnimations: inputs.names.map(name => name === null ? {} : {targetName: name})});
    const groups = [group(0.35), group(0.45), group(0.2)];
    groups[0]!.mask = {names: ["hip", "child"], mode: 0, disabled: false};
    groups[1]!.mask = {names: ["child"], mode: 1, disabled: false};
    groups[2]!._additive = {referenceTime: 0.125}; groups[2]!.speedRatio = -0.5;
    groups[2]!.mask = {names: ["child"], mode: 0, disabled: false};
    const manager = {engine: {_device: {queue: {writeTexture: (_destination: unknown, buffer: ArrayBuffer) => palettes.push(bits(new Float32Array(buffer)))}}}};
    const scratch = runtime.getScratch(manager), target = runtime.getTarget(scratch, mixer);
    const snapshots = [];
    for (let frame = 0; frame < 2; frame++) {
        if (frame > 0) { runtime.resetWeightedGltfTarget(target); groups[0]!.mask!.disabled = true; groups[2]!.mask!.disabled = true; }
        runtime.accumulateGroup(manager, scratch, groups[0]!, mixer, 250);
        runtime.accumulateGroup(manager, scratch, groups[1]!, mixer, 250);
        runtime.advanceGroupTime(groups[2]!, mixer, 250); runtime.accumulateAdditiveGroup(scratch, groups[2]!, mixer);
        runtime.uploadTarget(manager, target);
        snapshots.push({trs: bits(target.trs), local: bits(target.localMat), world: bits(target.worldMat),
            weights: [bits(target.tWeight), bits(target.rWeight), bits(target.sWeight)], base: target.baseRot ? bits(target.baseRot) : null,
            times: groups.map(group => group.currentTime), events: events.splice(0), palettes: palettes.splice(0)});
    }
    const errors: string[] = [];
    for (const action of [() => runtime.accumulateGroup({}, scratch, groups[0]!, mixer, 1), () => runtime.uploadTarget({}, target)])
        try { action(); } catch (error) { errors.push((error as Error).message); }
    return {snapshots, errors};
}

/** Fixture matrix callbacks use the shared numeric body lowerer. */
function numericCallbacks(context: LoweringContext): string {
    const functions = [
        ["src/math/mat4-compose-into.ts", "mat4ComposeInto", [0]], ["src/math/mat4-multiply-into.ts", "mat4MultiplyInto", [0, 2, 4]],
    ] as const;
    return functions.map(([path, name, arrays]) => {
        const {file, declaration} = context.functionDeclaration(path, name), bindings = new Map<string, PinnedBinding>();
        const params = declaration.parameters.map((parameter, index) => {
            assert.ok(ts.isIdentifier(parameter.name)); const cpp = parameter.name.text;
            const array = (arrays as readonly number[]).includes(index);
            bindings.set(cpp, {cpp, type: array ? "f32" : "scalar"});
            return `${array ? "std::vector<float>&" : "double"} ${cpp}`;
        });
        return `void ${name}(${params.join(", ")}) {
${lowerPinnedBody(file, declaration.body!.statements, {bindings, calls: new Map([...pinnedNumericMathCalls(),
            ...functions.map(([, name]) => [name, (args: readonly string[]) => `${name}(${args.join(", ")})`] as const)]),
            booleanAnd: true, booleanOr: true,
        })}
}`;
    }).join("\n");
}

function contexts(): LoweringContext[] {
    return [new LoweringContext(),
        doctoredContext(module, "scratch.sample[0]! * weight", "(scratch.sample[0]! + 1) * weight"),
        doctoredContext(module, "(scratch.sample[0]! - scratch.reference[0]!) * weight", "(scratch.sample[0]! + scratch.reference[0]!) * weight"),
        doctoredContext(module, "mask.mode === 0", "mask.mode === 1"),
        doctoredContext(module, "trs, nodes.length, true)", "trs, nodes.length, false)"),
    ];
}

test("weighted runtime source mutations change TRS, masks and post-animation bone visibility", () => {
    const variants = contexts(), expected = variants.map(context => [sourceResult(context, false), sourceResult(context, true)]);
    for (const value of expected.slice(1)) assert.notDeepEqual(value, expected[0]);
    for (const context of variants) { assert.ok(lowerGltfWeightedAnimationRuntime(context)); assert.ok(numericCallbacks(context)); assert.ok(lowerGltfAnimationBoneOverrides(context)); }
    const visible = lowerGltfAnimationBoneOverrides(variants[0]!, {visibilityOnly: true});
    assert.doesNotMatch(visible, /o\.(?:tx|ty|tz|rx|ry|rz|rw|sx|sy|sz)\b/);
    assert.throws(() => lowerGltfAnimationBoneOverrides(doctoredContext("src/skeleton/bone-control.ts", "mask: 0, tx: 0", "mask: 1, tx: 0"), {visibilityOnly: true}), /changed|specialization/);
});

test("native weighted source bodies match Float32 stores, masks, bone overrides and palette publication", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const variants = contexts(), expected = variants.map(context => [sourceResult(context, false), sourceResult(context, true)]);
    const directory = resolve("artifacts/test-gltf-weighted-animation-runtime"); mkdirSync(directory, {recursive: true});
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify({inputs, expected}));
    writeFileSync(file, `#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
using Json = nlohmann::json;
struct Sampler { std::vector<float> input, output; double interpolation = 0; };
struct Channel { double nodeIdx, samplerIdx, path; };
struct Node { double parentIdx, tx, ty, tz, rx, ry, rz, rw, sx, sy, sz; std::optional<std::vector<float>> matrix; };
struct Skeleton { std::vector<double> jointNodes; std::vector<float> invMeshWorld, inverseBindMatrices; std::shared_ptr<std::vector<float>> boneMatrices; double boneCount; bool disposed; };
struct Override { double mask = 0, tx = 0, ty = 0, tz = 0, rx = 0, ry = 0, rz = 0, rw = 1, sx = 1, sy = 1, sz = 1; };
struct Mask { std::vector<std::string> names; double mode = 0; bool disabled = false; };
struct Target { bool active = false, has_bone_overrides = false; double bone_override_count = 0;
    std::vector<Node> nodes; std::vector<Skeleton> skeletons;
    std::vector<float> currentTRS, localMat, worldMat, tWeight, rWeight, sWeight, _boneTmp = std::vector<float>(16);
    std::vector<float> RH_TO_LH{-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    std::optional<std::vector<float>> baseRot; std::vector<double> topo_order{0,1,2}; };
struct Scratch { std::vector<float> sample = std::vector<float>(16), reference = std::vector<float>(16), delta = std::vector<float>(16); };
struct Clip { std::vector<Channel> channels; std::vector<Sampler> samplers; };
struct Group { double time = 0.25, duration = 2, speed_ratio = 1, weight = 1, additive_reference_time = 0.125;
    bool playing = true, loop = true, additive = false; Mask* mask = nullptr; std::vector<std::optional<std::string>> target_names; };
Json bits(const std::vector<float>& values) { Json result = Json::array(); for (float value : values) result.push_back(std::bit_cast<std::uint32_t>(value)); return result; }
${variants.map((context, index) => `namespace variant_${index} {
${numericCallbacks(context)}
${lowerGltfAnimationEvaluator(context)}
${lowerGltfAnimationBoneOverrides(context)}
${lowerGltfAnimationPlayback(context, true)}
${lowerGltfWeightedAnimationRuntime(context)}
Json run(const Json& input, bool has_overrides) {
    Target target; target.has_bone_overrides = has_overrides; target.bone_override_count = has_overrides ? 2 : 0;
    for (const auto& node : input.at("nodes")) target.nodes.push_back({node.at("parentIdx"), node.at("tx"), node.at("ty"), node.at("tz"), node.at("rx"), node.at("ry"), node.at("rz"), node.at("rw"), node.at("sx"), node.at("sy"), node.at("sz"), node.contains("_matrix") ? std::make_optional(node.at("_matrix").get<std::vector<float>>()) : std::nullopt});
    target.currentTRS.resize(36); target.localMat.resize(48); target.worldMat.resize(48);
    target.tWeight.resize(3); target.rWeight.resize(3); target.sWeight.resize(3); if (has_overrides) target.baseRot.emplace(12);
    const std::vector<float> identity{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    for (bool disposed : {false, true}) { Skeleton skel{{0,1,2}, identity, {}, std::make_shared<std::vector<float>>(48), 3, disposed};
        for (int joint = 0; joint < 3; joint++) skel.inverseBindMatrices.insert(skel.inverseBindMatrices.end(), identity.begin(), identity.end()); target.skeletons.push_back(skel); }
    Clip clip; for (const auto& ch : input.at("channels")) clip.channels.push_back({ch.at("nodeIdx"), ch.at("samplerIdx"), ch.at("path")});
    for (const auto& sample : input.at("samples")) clip.samplers.push_back({sample.at("input"), sample.at("output"), sample.at("interpolation")});
    Mask first_mask{{"hip", "child"}, 0, false}, second_mask{{"child"}, 1, false}, additive_mask{{"child"}, 0, false};
    std::vector<Group> groups(3); groups[0].weight = 0.35; groups[0].mask = &first_mask;
    groups[1].weight = 0.45; groups[1].mask = &second_mask; groups[2].weight = 0.2; groups[2].additive = true; groups[2].speed_ratio = -0.5; groups[2].mask = &additive_mask;
    for (auto& group : groups) for (const auto& name : input.at("names")) group.target_names.push_back(name.is_null() ? std::nullopt : std::make_optional(name.get<std::string>()));
    Override rotation; rotation.mask = 2; rotation.rx = 0.6; rotation.rw = 0.8; Override hidden; hidden.mask = 8;
    std::vector<std::pair<double, Override>> overrides{{0, rotation}, {1, hidden}};
    Json events = Json::array(), palettes = Json::array(), snapshots = Json::array();
    const auto apply = [&](std::vector<float>& trs, double count, bool hidden_only) { events.push_back({"bones", hidden_only}); gltf_apply_animation_bone_overrides(overrides, trs, count, hidden_only); };
    const auto upload = [&](const Skeleton&, const std::vector<float>& data, double) { palettes.push_back(bits(data)); };
    const auto evaluate = [](const Sampler& sampler, double time, double stride, bool quaternion, std::vector<float>& output, double offset) {
        gltf_evaluate_animation_sampler(sampler, time, stride, quaternion, output, offset);
    };
    const auto get_target = [&]() -> Target& { return target; }; Scratch scratch;
    gltf_reset_weighted_target(target, apply);
    for (int frame = 0; frame < 2; frame++) {
        if (frame > 0) { gltf_reset_weighted_target(target, apply); first_mask.disabled = true; additive_mask.disabled = true; }
        gltf_accumulate_weighted_group(scratch, groups[0], clip, 250, groups[0].speed_ratio, true, get_target, evaluate);
        gltf_accumulate_weighted_group(scratch, groups[1], clip, 250, groups[1].speed_ratio, true, get_target, evaluate);
        gltf_advance_weighted_animation(groups[2], 250, groups[2].speed_ratio);
        gltf_accumulate_additive_group(scratch, groups[2], clip, get_target, evaluate);
        gltf_upload_weighted_target(target, true, apply, mat4ComposeInto, mat4MultiplyInto, upload);
        snapshots.push_back({{"trs", bits(target.currentTRS)}, {"local", bits(target.localMat)}, {"world", bits(target.worldMat)},
            {"weights", {bits(target.tWeight), bits(target.rWeight), bits(target.sWeight)}}, {"base", target.baseRot ? bits(*target.baseRot) : Json(nullptr)},
            {"times", {groups[0].time, groups[1].time, groups[2].time}}, {"events", events}, {"palettes", palettes}});
        events.clear(); palettes.clear();
    }
    Json errors = Json::array();
    try { gltf_accumulate_weighted_group(scratch, groups[0], clip, 1, groups[0].speed_ratio, false, get_target, evaluate); }
    catch (const std::exception& error) { errors.push_back(error.what()); }
    try { gltf_upload_weighted_target(target, false, apply, mat4ComposeInto, mat4MultiplyInto, upload); }
    catch (const std::exception& error) { errors.push_back(error.what()); }
    return {{"snapshots", snapshots}, {"errors", errors}};
}
}`).join("\n")}
namespace visibility_only {
${lowerGltfAnimationBoneOverrides(variants[0]!, {visibilityOnly: true})}
struct VisibleOverride { std::uint32_t mask; };
bool check() {
    const std::vector<std::pair<double, VisibleOverride>> visible{{0, {8}}, {2, {0}}, {-1, {8}}, {4, {8}}};
    std::vector<std::pair<double, Override>> full;
    for (const auto& [index, value] : visible) { Override entry; entry.mask = value.mask; full.emplace_back(index, entry); }
    for (bool hidden_only : {false, true}) {
        std::vector<float> first(36, 1), second(36, 1);
        gltf_apply_animation_bone_overrides(visible, first, 3, hidden_only);
        variant_0::gltf_apply_animation_bone_overrides(full, second, 3, hidden_only);
        if (bits(first) != bits(second)) return false;
    }
    return true;
}
}
int main() { Json cases; std::ifstream("cases.json") >> cases; Json actual = Json::array();
${variants.map((_, index) => `    actual.push_back({variant_${index}::run(cases.at("inputs"), false), variant_${index}::run(cases.at("inputs"), true)});`).join("\n")}
    std::ofstream("actual.json") << actual.dump(); if (actual != cases.at("expected") || !visibility_only::check()) return 1;
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
