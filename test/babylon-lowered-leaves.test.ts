import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const BAKE_MODULE = "src/loader-babylon/bake-local-matrix.ts";

test("native Babylon pivot baking matches pinned positions, normals and degenerate thresholds", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const context = new LoweringContext();
    const changed = doctoredContext(BAKE_MODULE, "if (len > 1e-10) {", "if (len > 1e-7) {");
    const matrices = [
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        [2, .2, 0, 0, 0, -3, .4, 0, .1, 0, .5, 0, 4, 5, 6, 1],
        [1e-8, 0, 0, 0, 0, 1e-8, 0, 0, 0, 0, 1e-8, 0, 0, 0, 0, 1],
        Array(16).fill(0) as number[],
    ];
    const inputs = { positions: [0, 1, 2, -2, -3, 4, 16777217, 1, -5], normals: [1, 2, 3, 0, 0, 0, -.3, .5, 1], matrices };
    const expected = [context, changed].map(source => {
        const { file } = source.functionDeclaration(BAKE_MODULE, "bakeLocalMatrix");
        const exports = {} as { bakeLocalMatrix(positions: Float32Array, normals: Float32Array, matrix: number[]): void };
        new Function("exports", transpileCommonJs(file.text, BAKE_MODULE))(exports);
        return matrices.map(matrix => {
            const positions = new Float32Array(inputs.positions), normals = new Float32Array(inputs.normals);
            exports.bakeLocalMatrix(positions, normals, matrix);
            return { positions: [...positions], normals: [...normals] };
        });
    });
    assert.notDeepEqual(expected[0]![2]!.normals, expected[1]![2]!.normals);
    const loader = new BabylonLowerer(context).lowerLoaderAdapter().source;
    const directory = resolve("artifacts/test-babylon-pivot");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "inputs.json"), JSON.stringify(inputs));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cassert>
#include <fstream>
using Json=nlohmann::json;
${cppFunction(loader, "void bake_local_matrix(")}
${cppFunction(loader, "std::array<double, 16> babylon_local_matrix(")}
${cppFunction(new BabylonLowerer(changed).lowerLoaderAdapter().source, "void bake_local_matrix(").replace("bake_local_matrix(", "changed_bake(")}
int main() {
    Json inputs,expected;
    std::ifstream("inputs.json")>>inputs;
    std::ifstream("expected.json")>>expected;
    for(std::size_t version=0;version<2;++version) for(std::size_t row=0;row<inputs.at("matrices").size();++row) {
        auto positions=inputs.at("positions").get<std::vector<float>>(),normals=inputs.at("normals").get<std::vector<float>>();
        const auto matrix=babylon_local_matrix(inputs.at("matrices")[row]);
        (version==0?bake_local_matrix:changed_bake)(positions,normals,matrix);
        assert(positions==expected[version][row].at("positions").get<std::vector<float>>());
        const auto wanted=expected[version][row].at("normals").get<std::vector<float>>();
        for(std::size_t lane=0;lane<normals.size();++lane) assert(std::abs(normals[lane]-wanted[lane])<1e-7f);
    }
    for(const auto& invalid:Json::array({nullptr,Json::array({1,2}),Json::array({"bad"})})) {
        bool refused=false;
        try { (void)babylon_local_matrix(invalid); } catch(const std::runtime_error&) { refused=true; }
        assert(refused);
    }
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("an unrepresented camera undefined comparison refuses generation", () => {
    assert.throws(() => new BabylonLowerer(doctoredContext("src/loader-babylon/parse-camera.ts",
        "if (cd.fov != null) {", "if (cd.fov !== undefined) {")).lowerLoaderAdapter(),
    /parse-camera.ts.*Unsupported pinned identifier: undefined/);
});
