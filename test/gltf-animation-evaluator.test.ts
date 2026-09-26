import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGltfAnimationEvaluator } from "../src/lowering/gltf/animation-evaluator.js";
import {
    transpileCommonJs,
    createJavaScriptFunction,
} from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const modulePath = "src/animation/evaluate.ts";
const contexts = (family: "gltf" | "property") =>
    family === "property"
        ? [
              new LoweringContext(),
              doctoredContext(
                  modulePath,
                  "const sampleTime = Math.fround(t);",
                  "const sampleTime = t;",
              ),
              doctoredContext(
                  modulePath,
                  "startWeight = 1 - t;",
                  "startWeight = 1 - 2 * t;",
              ),
          ]
        : [
              new LoweringContext(),
              doctoredContext(
                  modulePath,
                  "const h10 = f3 - 2 * f2 + f;",
                  "const h10 = f3 - 3 * f2 + f;",
              ),
              doctoredContext(
                  modulePath,
                  "const srcOff = (t >= t1 ? idx + 1 : idx) * stride;",
                  "const srcOff = idx * stride;",
              ),
          ];
function cases(context: LoweringContext, family: "gltf" | "property") {
    const file = context.sourceFile(modulePath),
        printer = ts.createPrinter();
    const source = file.statements
        .filter((statement) => !ts.isImportDeclaration(statement))
        .map((statement) =>
            printer
                .printNode(ts.EmitHint.Unspecified, statement, file)
                .replace(/^export /gm, ""),
        )
        .join("\n");
    const types = context.sourceFile("src/animation/types.ts");
    const constants = ["INTERP_STEP", "INTERP_CUBICSPLINE"].map((name) =>
        context.numericValue(context.moduleScopeConstant(types, name)!, types),
    );
    const evaluate = createJavaScriptFunction(
        "F32",
        "INTERP_STEP",
        "INTERP_CUBICSPLINE",
        transpileCommonJs(source, modulePath) +
            (family === "gltf"
                ? "\nreturn evaluateSampler;"
                : "\nreturn (sampler,t,stride,quaternion,out,offset)=>evaluatePropertySampler(sampler,t,stride,quaternion,undefined,out,offset);"),
    )(Float32Array, ...constants) as (
        sampler: object,
        t: number,
        stride: number,
        quaternion: boolean,
        out: Float32Array,
        offset: number,
    ) => void;
    return (family === "property" ? [0, 1] : [0, 1, 2]).flatMap(
        (interpolation) =>
            [0, 1, 3].flatMap((count) =>
                [1, 3, 4, 20].flatMap((stride) =>
                    [-1, 0, 1 / 60, 0.01, 0.25, 0.5, 0.75, 1.5, 3].map(
                        (time) => {
                            const input = new Float32Array(
                                (family === "property"
                                    ? [0, 1 / 60, 1.5]
                                    : [0, 0.5, 1.5]
                                ).slice(0, count),
                            );
                            const values: number[] = [];
                            for (let key = 0; key < count; key++)
                                for (
                                    let part = 0;
                                    part <
                                    (interpolation === constants[1] ? 3 : 1);
                                    part++
                                )
                                    for (
                                        let component = 0;
                                        component < stride;
                                        component++
                                    ) {
                                        const tangent =
                                            interpolation === constants[1] &&
                                            part !== 1;
                                        values.push(
                                            stride === 4
                                                ? tangent
                                                    ? component === 1
                                                        ? 0.1
                                                        : 0
                                                    : [
                                                          [0, 0, 0, 1],
                                                          family === "property"
                                                              ? [
                                                                    0, 0.0001,
                                                                    0, 1,
                                                                ]
                                                              : [
                                                                    0, 0.6, 0,
                                                                    0.8,
                                                                ],
                                                          [0, 0, 0, -1],
                                                      ][key]![component]!
                                                : tangent
                                                  ? 0.123456789
                                                  : (key + 1) * 0.37 +
                                                    component / 7,
                                        );
                                    }
                            const output = new Float32Array(values),
                                result = new Float32Array(stride + 4).fill(77);
                            evaluate(
                                { input, output, interpolation },
                                time,
                                stride,
                                stride === 4,
                                result,
                                2,
                            );
                            return {
                                input: [...input],
                                output: [...output],
                                interpolation,
                                time,
                                stride,
                                quaternion: stride === 4,
                                expected: [...new Uint32Array(result.buffer)],
                            };
                        },
                    ),
                ),
            ),
    );
}
for (const family of ["gltf", "property"] as const) {
    test(`${family} sampler lowering responds to source branch and numeric mutations`, () => {
        const variants = contexts(family).map((context) => {
            assert.ok(lowerGltfAnimationEvaluator(context, family));
            return cases(context, family);
        });
        for (const variant of variants.slice(1))
            assert.notDeepEqual(variant, variants[0]);
    });
    test(`${family} native sampler matches source empty, singleton, Float32 boundaries, STEP and quaternion samples`, (t) => {
        const native = optionalNativeFixtureTools();
        if (!native) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        const variants = contexts(family),
            directory = resolve(`artifacts/test-${family}-animation-evaluator`);
        mkdirSync(directory, { recursive: true });
        const file = resolve(directory, "check.cpp"),
            exe = resolve(directory, "check.exe");
        writeFileSync(
            resolve(directory, "cases.json"),
            JSON.stringify(variants.map((context) => cases(context, family))),
        );
        writeFileSync(
            file,
            `#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <array>
#include <bit>
#include <cmath>
#include <fstream>
using Json=nlohmann::json;
struct Sampler{std::vector<float> input,output;double interpolation;};
${variants.map((context, index) => `namespace variant_${index}{${lowerGltfAnimationEvaluator(context, family)}}`).join("\n")}
int main(){Json variants;std::ifstream("cases.json")>>variants;
${variants
    .map(
        (
            _context,
            index,
        ) => `for(const auto& row:variants.at(${index})){Sampler sampler{row.at("input").get<std::vector<float>>(),row.at("output").get<std::vector<float>>(),row.at("interpolation")};const auto stride=row.at("stride").get<std::size_t>();std::vector<float> result(stride+4,77);
variant_${index}::${family}_evaluate_animation_sampler(sampler,row.at("time").get<double>(),static_cast<double>(stride),row.at("quaternion").get<bool>(),result,2.0);
for(std::size_t lane=0;lane<result.size();++lane)if(std::bit_cast<std::uint32_t>(result[lane])!=row.at("expected").at(lane).get<std::uint32_t>()){std::ofstream("failure.json")<<Json{{"row",row},{"lane",lane},{"actual",std::bit_cast<std::uint32_t>(result[lane])}}.dump(2);return ${index + 1};}}`,
    )
    .join("\n")}}
`,
        );
        runNativeFixtureCompiler(native, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            "/O2",
            `/Fo:${directory}/`,
            `/Fe:${exe}`,
            "/I",
            "native/include",
            "/I",
            resolve(nativeFixtureVcpkgRoot, "include"),
            file,
        ]);
        assert.equal(
            execFileSync(exe, { cwd: directory, encoding: "utf8" }),
            "",
        );
    });
}
