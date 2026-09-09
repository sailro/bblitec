import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGltfHierarchy } from "../src/lowering/gltf/hierarchy.js";
import { lowerLocalMatrixCpp } from "../src/lowering/gltf/local-matrix.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { doctoredContext } from "./doctored-store.js";

const parserModule = "src/loader-gltf/gltf-parser.ts", composeModule = "src/math/mat4-compose-into.ts";
type PinnedParser = {
    buildParentMap(json: object): Map<number, number>;
    computeNodeWorldMatrix(json: object, index: number, parents: Map<number, number>, cache: Map<number, Float32Array>): Float32Array;
    getTextureImageIndex(json: object): number;
};

/** Run the selected source declarations with their shared matrix scratch. */
function executeParser(context: LoweringContext): PinnedParser {
    const root = context.moduleScopeConstant(context.sourceFile(parserModule), "RH_TO_LH_ROOT")!;
    const declarations = ["buildParentMap", "findParent", "computeNodeWorldMatrix", "getTextureImageIndex"]
        .map(symbol => context.functionDeclaration(parserModule, symbol).declaration.getText());
    declarations.push(context.functionDeclaration(composeModule, "mat4ComposeInto").declaration.getText(),
        context.functionDeclaration("src/math/mat4-multiply-into.ts", "mat4MultiplyInto").declaration.getText());
    const code = transpileCommonJs(`const F32 = Float32Array;
const RH_TO_LH_ROOT = ${root.getText()};
const scratch = new F32(16);
const getLoaderTmpLocal = () => scratch;
${declarations.join("\n")}`, parserModule);
    return new Function("exports", `${code}\nreturn {buildParentMap,computeNodeWorldMatrix,getTextureImageIndex};`)({}) as PinnedParser;
}

test("glTF hierarchy, transform branches and texture sources follow the pin", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const context = new LoweringContext();
    const original = await importPinnedModule<PinnedParser>("loader-gltf/gltf-parser.js");
    const contexts = [context,
        doctoredContext(parserModule, "node.rotation ?? [0, 0, 0, 1]", "node.rotation ?? [0, 0, 0, 2]"),
        doctoredContext(parserModule, "t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]", "t[0], t[1], t[2], r[1], r[0], r[2], r[3], s[0], s[1], s[2]"),
        doctoredContext(composeModule, "dst[off + 1] = 2 * (xy + wz) * sx;", "dst[off + 1] = 2 * (xy - wz) * sx;"),
    ];
    const inputs = [
        { nodes: [{}] },
        { nodes: [{ translation: [16777217, .123456789, -7], children: [1] },
            { rotation: [.17, .31, -.2, .91], scale: [2, -1, .25], children: [2] }, { translation: [2, 7, 9] }] },
        { nodes: [{ translation: [7, 0, 0] }, { children: [0], scale: [.5, 2, 3] }, { children: [1], translation: [-4, 8, 2] }] },
        { nodes: [{ children: [2], translation: [2, 0, 0] }, { children: [2], translation: [4, 0, 0] }, { scale: [2, 2, 2] }] },
        { nodes: [{ matrix: [1, .3, 0, 0, 2, 1, 0, 0, 0, 0, -1, 0, .1, .2, .3, 1], children: [1] }, { translation: [.5, .1, .2] }] },
        { nodes: [{ matrix: null, translation: null, rotation: null, scale: null, children: null }, { children: false }, { children: [] }] },
        { nodes: [{ translation: [7], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] },
    ];
    const outputs = contexts.map(ctx => {
        const pin = executeParser(ctx);
        return inputs.map(input => {
            const parents = pin.buildParentMap(input), cache = new Map<number, Float32Array>();
            const worlds = input.nodes.map((_node, index) => [...pin.computeNodeWorldMatrix(input, index, parents, cache)]);
            return { parents: input.nodes.map((_node, index) => parents.get(index) ?? -1), worlds };
        });
    });
    for (let row = 0; row < inputs.length; ++row) {
        const input = inputs[row]!, parents = original.buildParentMap(input), cache = new Map<number, Float32Array>();
        assert.deepEqual(input.nodes.map((_node, index) => [...original.computeNodeWorldMatrix(input, index, parents, cache)]), outputs[0]![row]!.worlds);
    }
    const mapContext = doctoredContext(parserModule, "if (children) {", "if (children && i > 0) {");
    const changedMap = executeParser(mapContext);
    const changedParents = inputs.map(input => {
        const parents = changedMap.buildParentMap(input);
        return input.nodes.map((_node, index) => parents.get(index) ?? -1);
    });
    const textureContext = doctoredContext(parserModule, "tex.extensions?.EXT_texture_webp?.source", "tex.extensions?.EXT_alternate?.source");
    const changedTexture = executeParser(textureContext);
    const textures = [{ source: 2 }, { source: 2, extensions: null }, { source: 2, extensions: { EXT_texture_webp: null } },
        { source: 2, extensions: { EXT_texture_webp: { source: null } } },
        { source: 2, extensions: { EXT_texture_webp: { source: 0 }, EXT_alternate: { source: 7 } } },
        { source: 5, extensions: { EXT_texture_webp: {} } }];
    const textureOutputs = textures.map(texture => [original.getTextureImageIndex(texture), changedTexture.getTextureImageIndex(texture)]);
    const directory = resolve("artifacts/test-gltf-hierarchy");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(join(directory, "cases.json"), JSON.stringify({ inputs, outputs, changedParents, textures, textureOutputs }));
    const loader = new GltfLowerer(context).lowerLoaderAdapter().source;
    const localFunctions = contexts.map((ctx, index) => {
        const local = lowerLocalMatrixCpp(ctx.sourceFile(parserModule), ctx.sourceFile(composeModule));
        return [cppFunction(local, "void gltf_compose_into("), cppFunction(local, "Matrix local_matrix("),
            cppFunction(lowerGltfHierarchy(ctx), "Matrix compute_gltf_node_world(")].join("\n")
            .replaceAll("gltf_compose_into(", `compose_${index}(`).replaceAll("local_matrix(", `local_${index}(`)
            .replaceAll("compute_gltf_node_world(", `world_${index}(`);
    });
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/ts_runtime.hpp>
#include "matrix.hpp"
#include <cassert>
#include <fstream>
namespace bbl {
using JsonObject=ts::JsonValue::Object;
using JsonArray=ts::JsonValue::Array;
using Matrix=std::array<float,16>;
${cppFunction(loader, "const ts::JsonValue* optional(")}
${lowerGltfParserJson(context)}
${lowerLocalMatrixCpp(context.sourceFile(parserModule), context.sourceFile(composeModule))}
${lowerGltfHierarchy(context)}
${localFunctions.join("\n")}
${cppFunction(lowerGltfHierarchy(mapContext), "std::vector<int> build_gltf_parents(").replace("build_gltf_parents(", "changed_parents(")}
${cppFunction(lowerGltfParserJson(textureContext), "std::size_t texture_image_index(").replace("texture_image_index(", "changed_texture(")}
}
int main() {
    using namespace bbl;
    nlohmann::json cases; std::ifstream("cases.json") >> cases;
    const auto reject=[](auto operation) { bool rejected=false; try { operation(); } catch(const std::exception&) { rejected=true; } assert(rejected); };
    const auto equal=[](const Matrix& actual, const nlohmann::json& wanted) {
        for(std::size_t lane=0;lane<16;++lane) {
            if(wanted[lane].is_null()) assert(std::isnan(actual[lane]));
            else assert(actual[lane]==wanted[lane].get<float>());
        }
    };
    using World=Matrix(*)(const JsonObject&,std::size_t,const std::vector<int>&,GltfWorldCache&);
    const World readers[]={world_0,world_1,world_2,world_3};
    for(std::size_t row=0;row<cases.at("inputs").size();++row) {
        const auto input=ts::JsonValue::from_native(cases.at("inputs")[row]);
        const auto& json=input.as_object();
        const auto parents=build_gltf_parents(json);
        validate_gltf_parents(parents);
        assert(parents==cases.at("outputs")[0][row].at("parents").get<std::vector<int>>());
        assert(changed_parents(json)==cases.at("changedParents")[row].get<std::vector<int>>());
        for(std::size_t reader=0;reader<4;++reader) {
            GltfWorldCache cache(parents.size());
            for(std::size_t node=parents.size();node-->0;) {
                const auto actual=readers[reader](json,node,parents,cache);
                equal(actual,cases.at("outputs")[reader][row].at("worlds")[node]);
                const auto converted=gltf_document_world(actual);
                for(std::size_t lane=0;lane<16;++lane) if(std::isfinite(actual[lane]))
                    assert(converted[lane]==(lane%4==0?-actual[lane]:actual[lane]));
            }
            auto changed=cases.at("inputs")[row]; changed["nodes"][0]["translation"]={999,999,999};
            const auto other=ts::JsonValue::from_native(changed);
            equal(readers[reader](other.as_object(),0,parents,cache),cases.at("outputs")[reader][row].at("worlds")[0]);
        }
    }
    for(std::size_t row=0;row<cases.at("textures").size();++row) {
        const auto texture=ts::JsonValue::from_native(cases.at("textures")[row]);
        assert(texture_image_index(texture.as_object())==cases.at("textureOutputs")[row][0].get<std::size_t>());
        assert(changed_texture(texture.as_object())==cases.at("textureOutputs")[row][1].get<std::size_t>());
    }
    assert(build_gltf_parents(JsonObject{}).empty());
    const auto nullNodes=ts::json_parse(R"({"nodes":null})");
    assert(build_gltf_parents(nullNodes.as_object()).empty());
    const auto cycle=ts::json_parse(R"({"nodes":[{"children":[1]},{"children":[0]}]})");
    const auto parents=build_gltf_parents(cycle.as_object());
    reject([&]{validate_gltf_parents(parents);});
    GltfWorldCache cache(2);
    reject([&]{compute_gltf_node_world(cycle.as_object(),0,parents,cache);});
    assert(cache.states==std::vector<std::uint8_t>({0,0}));
    const auto invalid=ts::json_parse(R"({"nodes":[{"children":[2]}]})");
    reject([&]{build_gltf_parents(invalid.as_object());});
    const auto malformed=ts::json_parse(R"({"matrix":[1,2,3]})");
    reject([&]{local_matrix(malformed.as_object());});
    reject([&]{texture_image_index(JsonObject{});});
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("glTF authored matrices refuse an unrepresented typed-array constructor", () => {
    const changed = doctoredContext(parserModule, "new F32(node.matrix)", "new F64(node.matrix)");
    assert.throws(() => lowerLocalMatrixCpp(changed.sourceFile(parserModule), changed.sourceFile(composeModule)), /new expression|F64|constructor/);
});
