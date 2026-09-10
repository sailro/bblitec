import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfWeightedAnimationPasses} from "../src/lowering/gltf/weighted-animation-passes.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/animation/weighted-gltf-mixer.ts";
const groups = [
    {id: 0, key: 1, weight: 1, additive: false, stopped: false},
    {id: 1, key: 1, weight: 0.5, additive: false, stopped: false},
    {id: 2, key: 1, weight: 0.25, additive: true, stopped: false},
    {id: 3, key: 2, weight: 1, additive: false, stopped: false},
    {id: 4, key: null, weight: 0.5, additive: false, stopped: false},
    {id: 5, key: 3, weight: 0.5, additive: false, stopped: true},
    {id: 6, key: 3, weight: 0, additive: true, stopped: false},
    {id: 7, key: 4, weight: 0.25, additive: false, stopped: false},
];
interface Target {key: number; active: boolean; value: number}
interface Group {id: number; _gltfMixer: object[] | undefined; weight: number; _additive: object | undefined; _stopped: boolean}

function sourceResult(context: LoweringContext): unknown[] {
    const keys = new Map<number, object>();
    for (const group of groups) if (group.key !== null && !keys.has(group.key)) keys.set(group.key, {});
    const groupValues: Group[] = groups.map(group => ({id: group.id, weight: group.weight, _stopped: group.stopped,
        _gltfMixer: group.key === null ? undefined : [{}, keys.get(group.key)!, []], _additive: group.additive ? {} : undefined}));
    const scratch = {keys: new Set<object>(), targets: new Map<object, Target>()};
    let events: unknown[] = [];
    const reset = (target: Target) => { events.push(["reset", target.key]); target.active = false; target.value = 0; };
    const getTarget = (_scratch: unknown, mixer: object[]) => {
        const key = mixer[1]!; let target = scratch.targets.get(key);
        if (!target) {
            target = {key: [...keys].find(entry => entry[1] === key)![0], active: false, value: 0};
            scratch.targets.set(key, target); reset(target);
        }
        return target;
    };
    const body = context.functionDeclaration(module, "updateWeightedGltfAnimations").declaration.getText();
    const update = new Function("getScratch", "getAnimationGroups", "resetWeightedGltfTarget", "getTarget", "advanceGroupTime", "accumulateGroup", "tickAnimationCore", "accumulateAdditiveGroup", "uploadTarget", "GLTF_NODES",
        transpileCommonJs(body, module) + "\nreturn updateWeightedGltfAnimations;")(
        () => scratch, () => groupValues, reset, getTarget,
        (group: Group, _mixer: object[], delta: number) => { events.push(["advance", group.id, delta]); return 0; },
        (_manager: unknown, _scratch: unknown, group: Group, mixer: object[], delta: number) => {
            events.push(["base", group.id, delta]); const target = getTarget(scratch, mixer); target.active = true; target.value += group.weight;
        }, (group: Group, delta: number, engine: object) => { assert.ok(engine); events.push(["tick", group.id, delta]); },
        (_scratch: unknown, group: Group, mixer: object[]) => { events.push(["add", group.id]); getTarget(scratch, mixer).value += group.weight * 10; },
        (_manager: unknown, target: Target) => events.push(["upload", target.key, target.value]), 1) as (manager: object, delta: number) => boolean;
    const run = () => ({handled: update({engine: {}}, 20), events: events.splice(0), targets: [...scratch.targets.values()].map(target => ({...target}))});
    const first = run();
    for (const group of groupValues) { group.weight = 1; group._additive = undefined; }
    const second = run();
    groupValues[1]!.weight = 0.25;
    const third = run();
    groupValues[1]!._stopped = true;
    return [first, second, third, run()];
}

function contexts(): LoweringContext[] {
    const base = new LoweringContext();
    const {file, declaration} = base.functionDeclaration(module, "updateWeightedGltfAnimations");
    const body = declaration.body!.statements;
    const upload = body[body.length - 2]!, additive = body[body.length - 3]!;
    assert.ok(ts.isForStatement(additive));
    const start = additive.getStart(file), end = upload.end;
    const reordered = file.text.slice(0, start) + upload.getText(file) + "\n" + additive.getText(file) + file.text.slice(end);
    return [base,
        doctoredContext(module, "group.weight === 1 && !group._additive", "group.weight === 0.5 && !group._additive"),
        doctoredContext(module, file.text, reordered),
    ];
}

test("weighted source traversal preserves shared-node keys, empty passes and publication order", () => {
    const variants = contexts(), outputs = variants.map(sourceResult);
    for (const output of outputs.slice(1)) assert.notDeepEqual(output, outputs[0]);
    for (const context of variants) assert.ok(lowerGltfWeightedAnimationPasses(context));
    assert.throws(() => lowerGltfWeightedAnimationPasses(doctoredContext(module,
        "tickAnimationCore(group, deltaMs, manager.engine)", "tickAnimationCore(group, deltaMs, undefined)")), /changed|identity/);
});

test("native weighted orchestration follows the actual source and mutated pass order", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const variants = contexts(), expected = variants.map(sourceResult);
    const directory = resolve("artifacts/test-gltf-weighted-animation-passes"); mkdirSync(directory, {recursive: true});
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify({groups, expected}));
    writeFileSync(file, `#include <nlohmann/json.hpp>
#include <cstdint>
#include <fstream>
#include <memory>
#include <set>
#include <stdexcept>
#include <vector>
using Json = nlohmann::json;
struct Target { int key; bool active = false; double value = 0; };
struct Group { int id, key; double weight; bool additive, stopped; };
struct Transport {
    std::vector<Group> groups;
    std::set<int> keys;
    std::vector<std::pair<int, Target>> targets;
    Json events = Json::array();
    bool stopped(const Group& group) const { return group.stopped; }
    bool additive(const Group& group) const { return group.additive; }
    double weight(const Group& group) const { return group.weight; }
    const Group* mixer(const Group& group) const { return group.key < 0 ? nullptr : &group; }
    int nodes_key(const Group* mixer) const { return mixer->key; }
    void reset_target(Target& target) { events.push_back({"reset", target.key}); target.active = false; target.value = 0; }
    Target& get_target(const Group* mixer) {
        for (auto& [key, target] : targets) if (key == mixer->key) return target;
        auto& target = targets.emplace_back(mixer->key, Target{mixer->key}).second; reset_target(target); return target;
    }
    void advance_group_time(const Group& group, const Group*, double delta) { events.push_back({"advance", group.id, delta}); }
    void accumulate_group(const Group& group, const Group* mixer, double delta) {
        events.push_back({"base", group.id, delta}); auto& target = get_target(mixer); target.active = true; target.value += group.weight;
    }
    void tick_animation_core(const Group& group, double delta) { events.push_back({"tick", group.id, delta}); }
    void accumulate_additive_group(const Group& group, const Group* mixer) { events.push_back({"add", group.id}); get_target(mixer).value += group.weight * 10; }
    void upload_target(const Target& target) { events.push_back({"upload", target.key, target.value}); }
};
${variants.map((context, index) => `namespace variant_${index} {
${lowerGltfWeightedAnimationPasses(context)}
Json run(const Json& input) {
    Transport transport;
    for (const auto& group : input) transport.groups.push_back({group.at("id"), group.at("key").is_null() ? -1 : group.at("key").get<int>(), group.at("weight"), group.at("additive"), group.at("stopped")});
    const auto tick = [&] {
        const bool handled = gltf_update_weighted_animation_passes(transport, 20);
        Json targets = Json::array();
        for (const auto& [key, target] : transport.targets) targets.push_back({{"key", key}, {"active", target.active}, {"value", target.value}});
        Json result{{"handled", handled}, {"events", transport.events}, {"targets", targets}}; transport.events.clear(); return result;
    };
    Json result = Json::array(); result.push_back(tick());
    for (auto& group : transport.groups) { group.weight = 1; group.additive = false; }
    result.push_back(tick()); transport.groups.at(1).weight = 0.25;
    result.push_back(tick()); transport.groups.at(1).stopped = true; result.push_back(tick()); return result;
}
}`).join("\n")}
int main() { Json cases; std::ifstream("cases.json") >> cases;
${variants.map((_, index) => `    if (variant_${index}::run(cases.at("groups")) != cases.at("expected").at(${index})) return ${index + 1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
