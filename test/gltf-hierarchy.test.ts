import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfHierarchy} from "../src/lowering/gltf/hierarchy.js";
import {gltfMatrixReaderCpp} from "../src/lowering/gltf/local-matrix.js";
import {lowerGltfParserJson} from "../src/lowering/gltf/parser-json.js";
import {GltfLowerer} from "../src/lowering/gltf-lowerer.js";
import {importPinnedModule} from "../src/pinned-shader-composer.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";
import {doctoredContext} from "./doctored-store.js";

const parserModule = "src/loader-gltf/gltf-parser.ts";
interface PinnedParser {
    buildParentMap(json: object): Map<number, number>;
    getTextureImageIndex(json: object): number;
}
function executeParser(context: LoweringContext): PinnedParser {
    const declarations = ["buildParentMap", "getTextureImageIndex"]
        .map(symbol => context.functionDeclaration(parserModule, symbol).declaration.getText());
    const code = transpileCommonJs(declarations.join("\n"), parserModule);
    return new Function("exports", `${code}\nreturn {buildParentMap,getTextureImageIndex};`)({}) as PinnedParser;
}

test("glTF parent publication and texture sources follow the pin; matrix storage validates its boundary", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const context = new LoweringContext();
    const original = await importPinnedModule<PinnedParser>("loader-gltf/gltf-parser.js");
    const inputs = [{nodes: [{}]}, {nodes: [{children: [1]}, {children: [2]}, {}]},
        {nodes: [{}, {children: [0]}, {children: [1]}]}, {nodes: [{children: [2]}, {children: [2]}, {}]},
        {nodes: [{children: null}, {children: false}, {children: []}]}];
    const mapContext = doctoredContext(parserModule, "if (children) {", "if (children && i > 0) {");
    const changedMap = executeParser(mapContext);
    const parents = (pin: PinnedParser) => inputs.map(input => {
        const map = pin.buildParentMap(input);
        return input.nodes.map((_node, index) => map.get(index) ?? -1);
    });
    const textureContext = doctoredContext(parserModule, "tex.extensions?.EXT_texture_webp?.source", "tex.extensions?.EXT_alternate?.source");
    const changedTexture = executeParser(textureContext);
    const textures = [{source: 2}, {source: 2, extensions: null}, {source: 2, extensions: {EXT_texture_webp: null}},
        {source: 2, extensions: {EXT_texture_webp: {source: null}}},
        {source: 2, extensions: {EXT_texture_webp: {source: 0}, EXT_alternate: {source: 7}}},
        {source: 5, extensions: {EXT_texture_webp: {}}}];
    const textureOutputs = textures.map(texture => [original.getTextureImageIndex(texture), changedTexture.getTextureImageIndex(texture)]);
    const directory = resolve("artifacts/test-gltf-hierarchy"); mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, "cases.json"), JSON.stringify({inputs, parents: parents(original), changedParents: parents(changedMap), textures, textureOutputs}));
    const loader = new GltfLowerer(context).lowerLoaderAdapter().source;
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/ts_runtime.hpp>
#include <cassert>
#include <fstream>
namespace bbl {
using JsonObject=ts::JsonValue::Object;
using JsonArray=ts::JsonValue::Array;
using Matrix=std::array<float,16>;
${cppFunction(loader, "const ts::JsonValue* optional(")}
${lowerGltfParserJson(context)}
${gltfMatrixReaderCpp()}
${lowerGltfHierarchy(context)}
${cppFunction(lowerGltfHierarchy(mapContext), "std::vector<int> build_gltf_parents(").replace("build_gltf_parents(", "changed_parents(")}
${cppFunction(lowerGltfParserJson(textureContext), "std::size_t texture_image_index(").replace("texture_image_index(", "changed_texture(")}
}
int main() {
    using namespace bbl;
    nlohmann::json cases; std::ifstream("cases.json") >> cases;
    const auto reject=[](auto operation) { bool rejected=false; try { operation(); } catch(const std::exception&) { rejected=true; } assert(rejected); };
    for(std::size_t row=0;row<cases.at("inputs").size();++row) {
        const auto input=ts::JsonValue::from_native(cases.at("inputs")[row]);
        const auto& json=input.as_object();
        const auto parents=build_gltf_parents(json);
        validate_gltf_parents(parents);
        assert(parents==cases.at("parents")[row].get<std::vector<int>>());
        assert(changed_parents(json)==cases.at("changedParents")[row].get<std::vector<int>>());
        for (std::size_t child=0;child<parents.size();++child) assert(find_gltf_parent(parents, double(child)) == parents[child]);
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
    reject([&]{validate_gltf_parents(build_gltf_parents(cycle.as_object()));});
    const auto invalid=ts::json_parse(R"({"nodes":[{"children":[2]}]})");
    reject([&]{build_gltf_parents(invalid.as_object());});
    const auto malformed=ts::json_parse("[1,2,3]");
    reject([&]{gltf_matrix_from_json(&malformed);});
    reject([&]{gltf_matrix_from_json(nullptr);});
    const auto matrix=ts::json_parse("[1,0,0,0,0,1,0,0,0,0,1,0,16777217,0.2,0.3,1]");
    assert(gltf_matrix_from_json(&matrix)[12] == 16777216.0f);
    reject([&]{texture_image_index(JsonObject{});});
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
