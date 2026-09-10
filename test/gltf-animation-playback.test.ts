import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAnimationPlayback} from "../src/lowering/gltf/animation-playback.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const groupModule = "src/animation/animation-group.ts";
const controllerModule = "src/skeleton/skeleton-updater.ts";
const mixerModule = "src/animation/weighted-gltf-mixer.ts";
interface Controller {
    time: number; playing: boolean; speedRatio: number; loop: boolean;
    tick(delta: number, engine?: object): void; _setMask(mask: unknown): void;
}
interface Group {
    currentTime: number; isPlaying: boolean; _stopped: boolean; speedRatio: number;
    loopAnimation: boolean; frameRate: number; _ctrl: Controller; _gltfMixer: unknown;
    _animationManager?: object;
}
interface Operation {op: string; value?: number; engine?: boolean; playing?: boolean; stopped?: boolean; loop?: boolean; managed?: boolean}
const scenarios: Array<{duration: number; requiresEngine: boolean; ops: Operation[]}> = [
    {duration: 4, requiresEngine: true, ops: [
        {op: "tick", value: 250}, {op: "tick", value: 250, engine: true},
        {op: "time", value: 3.75}, {op: "tick", value: 250},
        {op: "speed", value: -2}, {op: "time", value: 0.25}, {op: "tick", value: 500},
        {op: "time", value: 4.75, playing: false}, {op: "tick", value: 0},
        {op: "time", value: 1.25, stopped: true}, {op: "tick", value: 700, engine: true},
        {op: "seek", value: 540}, {op: "seek", value: 540, engine: true},
        {op: "time", value: 1, stopped: false, playing: true, managed: true},
        {op: "tick", value: 250}, {op: "core", value: 250},
        {op: "frameRate", value: 24}, {op: "seek", value: 60, engine: true},
        {op: "frameRate", value: 0}, {op: "seek", value: 60, engine: true},
    ]},
    {duration: 0, requiresEngine: true, ops: [
        {op: "time", value: 3}, {op: "speed", value: 2}, {op: "tick", value: 500},
        {op: "weighted", value: 500}, {op: "seek", value: 180, engine: true},
    ]},
    {duration: 4, requiresEngine: false, ops: [
        {op: "time", value: 4.75, playing: false}, {op: "weighted", value: 0},
        {op: "time", value: 4.75}, {op: "tick", value: 0},
        {op: "time", value: 0.25, playing: true}, {op: "speed", value: -2}, {op: "weighted", value: 500},
        {op: "time", value: -2, loop: false}, {op: "core", value: 0},
        {op: "time", value: 6, playing: false}, {op: "core", value: 0},
    ]},
];

function sourceResult(context: LoweringContext): unknown[] {
    const printer = ts.createPrinter();
    const text = (module: string) => {
        const file = context.sourceFile(module);
        return file.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement =>
            printer.printNode(ts.EmitHint.Unspecified, statement, file).replace(/^export /gm, "")).join("\n");
    };
    const names = ["PATH_TRANSLATION", "PATH_ROTATION", "PATH_SCALE", "PATH_WEIGHTS", "PATH_POINTER"];
    const types = context.sourceFile("src/animation/types.ts");
    const constants = names.map(name => context.numericValue(context.moduleScopeConstant(types, name)!, types));
    let current: Group | undefined;
    let events: unknown[] = [];
    const body = text(controllerModule) + "\n" + text(groupModule) + "\n" +
        context.functionDeclaration(mixerModule, "advanceGroupTime").declaration.getText();
    const runtime = new Function("F32", "I32", "U8", ...names, "mat4ComposeInto", "mat4MultiplyInto", "evaluateSampler", "_boneApplier", "_setTickAnimationImpl", "GLTF_CLIP",
        transpileCommonJs(body, groupModule) + "\nreturn {createAnimationGroups, tickAnimationImpl, tickAnimationCore, goToFrame, advanceGroupTime};")(
        Float32Array, Int32Array, Uint8Array, ...constants,
        () => events.push(["pose", current!._ctrl.time]), () => {}, () => { throw new Error("No sampler is reached by this playback fixture."); },
        undefined, () => {}, 0) as {
            createAnimationGroups(data: object): Group[];
            tickAnimationImpl(group: Group, delta: number, engine?: object): void;
            tickAnimationCore(group: Group, delta: number, engine?: object): void;
            goToFrame(group: Group, frame: number, engine?: object): void;
            advanceGroupTime(group: Group, mixer: unknown, delta: number): number;
        };
    return scenarios.map(scenario => {
        const node = {parentIdx: -1, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1};
        const clip = {name: "clock", duration: scenario.duration, samplers: [], channels: []};
        const group = runtime.createAnimationGroups({clips: [clip], nodes: [node], skeletons: [],
            morphBindings: scenario.requiresEngine ? [{nodeIdx: 0}] : [], nodeTargets: [], nodeNames: []})[0]!;
        current = group; events = [];
        const mask = group._ctrl._setMask;
        group._ctrl._setMask = value => { events.push(["mask"]); mask(value); };
        return scenario.ops.map(operation => {
            if (operation.playing !== undefined) group.isPlaying = operation.playing;
            if (operation.stopped !== undefined) group._stopped = operation.stopped;
            if (operation.loop !== undefined) group.loopAnimation = operation.loop;
            if (operation.managed === true) group._animationManager = {};
            else if (operation.managed === false) delete group._animationManager;
            const engine = operation.engine ? {_device: {}} : undefined;
            let result: number | null = null, error: string | null = null;
            try {
                switch (operation.op) {
                    case "time": group.currentTime = operation.value!; break;
                    case "speed": group.speedRatio = operation.value!; break;
                    case "frameRate": group.frameRate = operation.value!; break;
                    case "tick": runtime.tickAnimationImpl(group, operation.value!, engine); break;
                    case "core": runtime.tickAnimationCore(group, operation.value!, engine); break;
                    case "seek": runtime.goToFrame(group, operation.value!, engine); break;
                    case "weighted": result = runtime.advanceGroupTime(group, group._gltfMixer, operation.value!); break;
                    default: throw new Error("Unknown playback fixture operation.");
                }
            } catch (caught) { error = (caught as Error).message; }
            return {time: group.currentTime, playing: group.isPlaying, stopped: group._stopped,
                controller: [group._ctrl.time, group._ctrl.playing, group._ctrl.speedRatio, group._ctrl.loop],
                result, error, events: events.splice(0)};
        });
    });
}

function contexts(): LoweringContext[] {
    return [new LoweringContext(),
        doctoredContext(controllerModule, "ctrl.time += (deltaMs / 1000) * ctrl.speedRatio", "ctrl.time += (deltaMs / 500) * ctrl.speedRatio"),
        doctoredContext(groupModule, "ctrl.speedRatio = group.speedRatio", "ctrl.speedRatio = -group.speedRatio"),
        doctoredContext(mixerModule, "group.currentTime += (deltaMs / 1000) * group.speedRatio", "group.currentTime += (deltaMs / 2000) * group.speedRatio"),
        doctoredContext(groupModule, "if (group._animationManager)", "if (!group._animationManager)"),
        doctoredContext(controllerModule,
            'throw new Error("AnimationController.tick requires an EngineContext for skeleton or morph animation")',
            'throw new Error("changed engine gate")'),
    ];
}

test("playback clocks and source mutation cases exercise different controller and weighted rules", () => {
    const sources = contexts().map(sourceResult);
    for (const mutated of sources.slice(1)) assert.notDeepEqual(mutated, sources[0]);
    for (const context of contexts()) assert.ok(lowerGltfAnimationPlayback(context, true));
    assert.throws(() => lowerGltfAnimationPlayback(doctoredContext(groupModule,
        "ctrl._setMask?.(group.mask ?? null)", "ctrl._setMask?.(null)")), /boundary|changed/);
    assert.throws(() => lowerGltfAnimationPlayback(doctoredContext(groupModule,
        "syncControllerFromGroup(group, group._ctrl)", "syncControllerFromGroup(group, group)")), /identity|changed/);
    assert.throws(() => lowerGltfAnimationPlayback(doctoredContext(mixerModule,
        "const GLTF_CLIP = 0;", "const GLTF_CLIP = 1;"), true), /identity changed/);
});

test("generated playback matches actual source across control, engine-cache and numeric mutations", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const variants = contexts(), expected = variants.map(sourceResult);
    const directory = resolve("artifacts/test-gltf-animation-playback"); mkdirSync(directory, {recursive: true});
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify({scenarios, expected}));
    writeFileSync(file, `#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cmath>
#include <fstream>
#include <stdexcept>
using Json = nlohmann::json;
${variants.map((context, index) => `namespace variant_${index} {
${lowerGltfAnimationPlayback(context, true)}
struct Group { double time = 0, duration = 0; bool playing = true, stopped = false, loop = true; GltfAnimationControllerPlayback controller; };
Json run(const Json& scenarios) {
    Json result = Json::array();
    for (const auto& scenario : scenarios) {
        Group group; group.duration = scenario.at("duration");
        double speed_ratio = 1, frame_rate = 60; bool managed = false;
        const bool requires_engine = scenario.at("requiresEngine");
        Json events = Json::array(), observations = Json::array();
        const auto mask = [&] { events.push_back(Json::array({"mask"})); };
        const auto pose = [&](double time, bool) { events.push_back(Json::array({"pose", time})); };
        for (const auto& operation : scenario.at("ops")) {
            if (operation.contains("playing")) group.playing = operation.at("playing");
            if (operation.contains("stopped")) group.stopped = operation.at("stopped");
            if (operation.contains("loop")) group.loop = operation.at("loop");
            if (operation.contains("managed")) managed = operation.at("managed");
            const bool engine = operation.value("engine", false);
            const auto op = operation.at("op").get<std::string>(); const double value = operation.value("value", 0.0);
            Json returned = nullptr, error = nullptr;
            try {
                if (op == "time") group.time = value;
                else if (op == "speed") speed_ratio = value;
                else if (op == "frameRate") frame_rate = value;
                else if (op == "tick") gltf_tick_animation(group, value, speed_ratio, managed, engine, requires_engine, true, mask, pose);
                else if (op == "core") gltf_tick_animation_core(group, value, speed_ratio, engine, requires_engine, true, mask, pose);
                else if (op == "seek") gltf_animation_go_to_frame(group, value, frame_rate, speed_ratio, engine, requires_engine, true, mask, pose);
                else if (op == "weighted") returned = gltf_advance_weighted_animation(group, value, speed_ratio);
                else throw std::runtime_error("Unknown playback fixture operation.");
            } catch (const std::exception& caught) { error = caught.what(); }
            observations.push_back({{"time", group.time}, {"playing", group.playing}, {"stopped", group.stopped},
                {"controller", {group.controller.time, group.controller.playing, group.controller.speed_ratio, group.controller.loop}},
                {"result", returned}, {"error", error}, {"events", events}});
            events.clear();
        }
        result.push_back(observations);
    }
    return result;
}
}`).join("\n")}
int main() { Json cases; std::ifstream("cases.json") >> cases;
${variants.map((_, index) => `    if (variant_${index}::run(cases.at("scenarios")) != cases.at("expected").at(${index})) return ${index + 1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
