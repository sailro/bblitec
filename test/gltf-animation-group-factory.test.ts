import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAnimationGroupFactory} from "../src/lowering/gltf/animation-group-factory.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/animation/animation-group.ts";
const contexts = () => [new LoweringContext(),
    doctoredContext(module, "const started = clipIndex === 0", "const started = clipIndex !== 0"),
    doctoredContext(module, "`animation_${clipIndex}`", "`clip_${clipIndex}_fallback`"),
    doctoredContext(module, "const DEFAULT_FRAME_RATE = 60", "const DEFAULT_FRAME_RATE = 24"),
    doctoredContext(module, "weight: 1,", "weight: 0.25,"),
];

test("glTF group initialization follows actual factory values and source mutations", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const variants = contexts();
    const clips = [undefined, 0, 24, NaN, -12].flatMap(frameRate => ["", "walk"].map(name => ({name, frameRate, duration: 2.5, channels: []})));
    const cases = variants.map(context => {
        const body = context.functionDeclaration(module, "createAnimationGroups").declaration.getText().replace(/^export /, "");
        const frameRate = context.moduleScopeConstant(context.sourceFile(module), "DEFAULT_FRAME_RATE")!.getText();
        const run = new Function(transpileCommonJs(`
            const DEFAULT_FRAME_RATE = ${frameRate};
            const _installTickAnimation = () => {};
            const createAnimationController = () => ({});
            ${body}
            return createAnimationGroups;
        `, module))() as (data: object) => Array<Record<string, unknown>>;
        return run({clips, nodes: [], skeletons: [], nodeTargets: [], nodeNames: []}).map((group, index) => ({
            input: {name: clips[index]!.name, duration: clips[index]!.duration, frame_rate: clips[index]!.frameRate ?? null, index},
            expected: {name: group.name, duration: group.duration, frame_rate: group.frameRate,
                playing: group.isPlaying, time: group.currentTime, speed_ratio: group.speedRatio,
                loop: group.loopAnimation, weight: group.weight, stopped: group._stopped},
        }));
    });
    const directory = resolve("artifacts/test-gltf-animation-group-factory"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
using Json = nlohmann::json;
struct Group { std::string name; double duration=0,frame_rate=0,time=0,speed_ratio=0,weight=0; bool playing=false,loop=false,stopped=false; };
${variants.map((context, index) => `namespace variant_${index} { ${lowerGltfAnimationGroupFactory(context)} }`).join("\n")}
template<class Initialize> void check(const Json& row, Initialize initialize) {
    const auto& input = row.at("input"); Group group;
    initialize(group, input.at("name").get<std::string>(), input.at("duration").get<double>(),
        input.at("frame_rate").is_null() ? std::numeric_limits<double>::quiet_NaN() : input.at("frame_rate").get<double>(), input.at("index").get<double>());
    const Json actual = {{"name",group.name},{"duration",group.duration},{"frame_rate",group.frame_rate},
        {"time",group.time},{"playing",group.playing},{"loop",group.loop},{"stopped",group.stopped},
        {"speed_ratio",group.speed_ratio},{"weight",group.weight}};
    if (actual != row.at("expected")) throw std::runtime_error(actual.dump());
}
int main() { Json cases; std::ifstream("cases.json") >> cases;
${variants.map((_context,index) => `for (const auto& row : cases.at(${index})) check(row, [](auto&&... args) { variant_${index}::gltf_initialize_animation_group(args...); });`).join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("new group state cannot silently bypass the factory lowering", () => {
    assert.throws(() => lowerGltfAnimationGroupFactory(doctoredContext(module, "weight: 1,", "weight: 1, extraState: 2,")), /Unbound animation group factory field/);
});
