import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { lowerGltfAnimationNodeRest } from "../src/lowering/gltf/animation-node-rest.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const module = "src/loader-gltf/gltf-animation.ts";
type NodeRest = { parentIdx: number; _matrix?: number[]; tx: number; ty: number; tz: number; rx: number; ry: number; rz: number; rw: number; sx: number; sy: number; sz: number };

test("native animation rest nodes follow the complete pinned parser and changed source", async t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(module, "n.scale ?? [1, 1, 1]", "n.scale ?? [2, 3, 4]"),
        doctoredContext(module, "tx: t[0],", "tx: t[0] + 0.125,"),
        doctoredContext(module, "parentIdx: findParent(parentMap, i)", "parentIdx: findParent(parentMap, i + 1)"),
        doctoredContext(module, "const n = json.nodes[i];", "const n = json.nodes[nodeCount - i - 1];"),
        doctoredContext(module, "n.scale ?? [1, 1, 1]", "n.scale ?? [findParent(parentMap, i), 1, 1]"),
    ];
    const inputNodes = [
        {},
        { translation: [0.1234567890123, -2, 4], rotation: [0.1, -0.2, 0.3, 0.4], scale: [2, 3, 4] },
        { translation: null, rotation: null, scale: null },
        { matrix: [1,0,0,0, 0,2,0,0, 0,0,3,0, 4,5,6,1] },
    ];
    const parents = [-1, 0, 0, 2];
    const constants = await importPinnedModule<Record<string, number>>("animation/types.js");
    const expected = contexts.map(context => {
        const file = context.sourceFile(module);
        const source = ["INTERP_MAP", "PATH_MAP"].map(name => `const ${name} = ${context.moduleScopeConstant(file, name)!.getText()};`).join("\n") +
            ["toSamplerFloat32", "hasWritableNodeChannel", "parseAnimationData"].map(name => context.functionDeclaration(module, name).declaration.getText()).join("\n");
        const reads: number[] = [];
        const parse = new Function("exports", "F32", "_convertSampler", "_parsePointerChannel", "resolveAccessor", "findParent", ...Object.keys(constants),
            transpileCommonJs(source, module) + "\nreturn parseAnimationData;")({}, Float32Array, null, null,
                (_json: object, _bin: object, index: number) => ({ _data: new Float32Array(index ? [0, 0, 0] : [0]), _count: 1, _componentCount: index ? 3 : 1 }),
                (_map: object, index: number) => { reads.push(index); return parents[index] ?? -1; }, ...Object.values(constants)) as
                (json: object, bin: object, meshes: object[], parentMap: object, worldCache: object, nodes: object[]) => { nodes: NodeRest[] } | null;
        const result = parse({ nodes: inputNodes, accessors: [{}, {}], animations: [{ samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }] },
            {}, [], {}, {}, inputNodes.map(() => ({})));
        assert.ok(result);
        return { nodes: result.nodes, reads };
    });
    const output = resolve("artifacts/gltf-animation-node-rest"); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "cases.json"), JSON.stringify({ input: { nodes: inputNodes }, parents, expected }));
    const loader = new GltfLowerer(contexts[0]!).lowerLoaderAdapter().source;
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#include <bblite/ts_runtime.hpp>
        #include <cassert>
        #include <fstream>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object; using JsonArray = ts::JsonValue::Array;
            ${["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::vector<double> double_array("].map(signature => cppFunction(loader, signature)).join("\n")}
            ${lowerGltfParserJson(contexts[0]!)}
            ${contexts.map((context, index) => `namespace variant${index} { ${lowerGltfAnimationNodeRest(context)} }`).join("\n")}
        }
        int main() {
            using namespace bbl;
            nlohmann::json cases; std::ifstream("cases.json") >> cases;
            const auto document = ts::JsonValue::from_native(cases.at("input"));
            ${contexts.map((_context, variant) => `{
                std::vector<double> reads;
                const auto result = variant${variant}::gltf_animation_node_rest(document.as_object(), [&](double index) {
                    reads.push_back(index); return index < cases.at("parents").size() ? cases.at("parents")[static_cast<std::size_t>(index)].get<double>() : -1.0;
                });
                auto actual = nlohmann::json::array();
                for (const auto& rest : result) {
                    nlohmann::json row;
                    ${["parentIdx", "tx", "ty", "tz", "rx", "ry", "rz", "rw", "sx", "sy", "sz"].map(key => `row[${JSON.stringify(key)}] = rest.${key};`).join("\n")}
                    if (rest.matrix) row["_matrix"] = double_array(rest.matrix);
                    actual.push_back(row);
                }
                assert(actual == cases.at("expected")[${variant}].at("nodes"));
                assert(nlohmann::json(reads) == cases.at("expected")[${variant}].at("reads"));
            }`).join("\n")}
            for (const auto& input : {nlohmann::json::object(), nlohmann::json{{"nodes", nullptr}}, nlohmann::json{{"nodes", nlohmann::json::array()}}}) {
                const auto empty = ts::JsonValue::from_native(input);
                assert(variant0::gltf_animation_node_rest(empty.as_object(), [](double) { assert(false); return -1.0; }).empty());
            }
            const auto short_trs = ts::JsonValue::from_native(nlohmann::json{{"nodes", {{{"translation", {1, 2}}}}}});
            bool refused = false;
            try { variant0::gltf_animation_node_rest(short_trs.as_object(), [](double) { return -1.0; }); }
            catch (const std::out_of_range&) { refused = true; }
            assert(refused);
        }`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, { cwd: output, encoding: "utf8" }), "");
});

test("unrepresented animation rest storage and parent ownership refuse", () => {
    assert.throws(() => lowerGltfAnimationNodeRest(doctoredContext(module, "sx: s[0],", "sx: s[0], extra: 2,")), /Unsupported node-rest field/);
    assert.throws(() => lowerGltfAnimationNodeRest(doctoredContext(module, "parentIdx: findParent(parentMap, i)", "parentIdx: findParent(otherMap, i)")), /Animation parent map/);
});
