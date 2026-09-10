import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { lowerGltfInverseBindMatrices } from "../src/lowering/gltf/skin-data.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const module = "src/loader-gltf/gltf-animation.ts";

test("inverse bind selection, count and initialization execute the pinned source", t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(module, "out[o + 15] = 1;", "out[o + 15] = 0.25;"),
        doctoredContext(module, "jointCount * 16);", "jointCount * 8);"),
        doctoredContext(module, "if (skin.inverseBindMatrices !== undefined)", "if (skin.inverseBindMatrices !== undefined) if (jointCount > 1)"),
    ];
    const inputs = [0, 1, 3].flatMap(count => [
        { joints: Array.from({ length: count }, (_, index) => index) },
        { joints: Array.from({ length: count }, (_, index) => index), inverseBindMatrices: 2 },
    ]);
    const backing = Float32Array.from({ length: 64 }, (_, index) => index / 8);
    const expected = contexts.map(context => {
        const factory = new Function("F32", "resolveAccessor",
            transpileCommonJs(context.functionDeclaration(module, "resolveIBMs").declaration.getText(), module) + "\nreturn resolveIBMs;");
        return inputs.map(skin => {
            const reads: number[] = [];
            const execute = factory(
                Float32Array, (_json: object, _binary: object, index: number) => {
                    reads.push(index); return { _data: new Float32Array(backing.buffer, 16, 48) };
                }) as (json: object, binary: object, skin: object) => Float32Array;
            return { values: [...execute({}, {}, skin)], reads };
        });
    });
    const output = resolve("artifacts/gltf-skin-data"); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "cases.json"), JSON.stringify({ inputs, expected }));
    const loader = new GltfLowerer(contexts[0]!).lowerLoaderAdapter().source;
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#include <bblite/ts_runtime.hpp>
        #include <cassert>
        #include <fstream>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object; using JsonArray = ts::JsonValue::Array;
            ${["const ts::JsonValue& required(", "const ts::JsonValue* optional("].map(signature => cppFunction(loader, signature)).join("\n")}
            ${lowerGltfParserJson(contexts[0]!)}
            ${contexts.map((context, index) => `namespace variant${index} { ${lowerGltfInverseBindMatrices(context)} }`).join("\n")}
        }
        int main() {
            using namespace bbl;
            nlohmann::json cases; std::ifstream("cases.json") >> cases;
            ${contexts.map((_context, variant) => `{
                for (std::size_t row = 0; row < cases.at("inputs").size(); ++row) {
                    const auto skin = ts::JsonValue::from_native(cases.at("inputs")[row]);
                    std::vector<double> reads; std::size_t views = 0;
                    const auto result = variant${variant}::gltf_inverse_bind_matrices(skin.as_object(),
                        [&](double index) { reads.push_back(index); return std::size_t{4}; },
                        [&](std::size_t offset, double count) {
                            ++views; std::vector<float> values(static_cast<std::size_t>(count));
                            for (std::size_t i = 0; i < values.size(); ++i) values[i] = static_cast<float>(offset + i) / 8.0f;
                            return values;
                        });
                    const auto& expected = cases.at("expected")[${variant}][row];
                    assert(nlohmann::json(result) == expected.at("values"));
                    assert(nlohmann::json(reads) == expected.at("reads"));
                    assert(views == reads.size());
                }
            }`).join("\n")}
        }`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, { cwd: output, encoding: "utf8" }), "");
});

test("unsupported skin accessor ownership refuses at the source", () => {
    assert.throws(() => lowerGltfInverseBindMatrices(doctoredContext(module, "ibmData._data.byteOffset", "0")), /Skin view offset/);
    assert.throws(() => lowerGltfInverseBindMatrices(doctoredContext(module, "resolveAccessor(json, binChunk, skin.inverseBindMatrices)",
        "resolveAccessor(json, otherBuffer, skin.inverseBindMatrices)")), /Skin accessor binary/);
});
